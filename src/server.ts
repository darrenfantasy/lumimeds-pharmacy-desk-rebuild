import "dotenv/config";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeEvent, type Change, type Config, type DeskEvent, type EmailEvent, type OrderEvent, type StartEvent } from "./contract.js";
import { DispatchPlanner } from "./dispatch.js";
import { interpretEmail, type EmailDecision, type Extractor } from "./email.js";
import { claudeExtractor } from "./llm.js";

interface Reservation {
  pharmacy: string;
  reason: string;
  at: number;
  confirmed: boolean;
}

interface PendingEmail {
  event: EmailEvent;
  pharmacyId: string | null;
  receiptOrder: number;
  retryAfter: number;
}

interface ReviewEntry {
  event_id: string;
  from: string;
  subject: string;
  occurred_at: string;
  reason: string;
  restrictions?: Change[];
}

interface Run {
  config: Config;
  planner: DispatchPlanner;
  dispatchUrl: URL;
  now: number;
  completed: Set<string>;
  emailReceipts: Map<string, number>;
  pending: Map<string, PendingEmail>;
  reviews: Map<string, ReviewEntry>;
  orders: Map<string, Reservation>;
}

class Desk {
  private run: Run | undefined;
  private readonly starts = new Set<string>();

  constructor(private readonly extract: Extractor, private readonly reviewPath: string) {}

  private async start(event: StartEvent): Promise<void> {
    const fingerprint = JSON.stringify(event);
    if (this.starts.has(fingerprint)) return;
    const run: Run = {
      config: event.config,
      planner: new DispatchPlanner(event.config),
      dispatchUrl: new URL("/pharmacy-orders", event.pharmacyApi),
      now: Date.parse(event.occurred_at),
      completed: new Set([event.event_id]),
      emailReceipts: new Map(),
      pending: new Map(),
      reviews: new Map(),
      orders: new Map(),
    };
    await mkdir(dirname(this.reviewPath), { recursive: true });
    await writeFile(this.reviewPath, "");
    this.run = run;
    this.starts.add(fingerprint);
  }

  async handle(event: DeskEvent): Promise<void> {
    if (event.type === "simulation.started") {
      await this.start(event);
      return;
    }
    const run = this.run;
    if (!run) throw new Error("Start the simulation first.");
    if (run.completed.has(event.event_id)) {
      const pending = run.pending.get(event.event_id);
      if (pending) await this.processEmail(run, pending.event, pending.receiptOrder);
      return;
    }
    run.now = Math.max(run.now, Date.parse(event.occurred_at));

    if (event.type === "email") {
      const receiptOrder = run.emailReceipts.get(event.event_id) ?? run.emailReceipts.size + 1;
      run.emailReceipts.set(event.event_id, receiptOrder);
      await this.processEmail(run, event, receiptOrder);
    } else {
      await this.dispatch(event, run);
    }
    run.completed.add(event.event_id);
  }

  private async saveReview(run: Run, event: EmailEvent, decision?: Exclude<EmailDecision, { status: "apply" }>): Promise<void> {
    const reviews = new Map(run.reviews);
    if (decision) {
      reviews.set(event.event_id, {
        event_id: event.event_id,
        from: event.email.from,
        subject: event.email.subject,
        occurred_at: event.occurred_at,
        reason: decision.reason,
        ...(decision.restrictions.length ? { restrictions: decision.restrictions } : {}),
      });
    } else if (!reviews.delete(event.event_id)) {
      return;
    }
    const staged = this.reviewPath + ".tmp";
    await writeFile(staged, [...reviews.values()].map((entry) => JSON.stringify(entry) + "\n").join(""));
    await rename(staged, this.reviewPath);
    run.reviews = reviews;
  }

  private async processEmail(run: Run, event: EmailEvent, receiptOrder: number): Promise<void> {
    const pending = run.pending.get(event.event_id);
    const result = await interpretEmail(event, run.config, this.extract);
    if (pending && result.status === "unavailable") {
      pending.retryAfter = run.now + 60_000;
      if (!run.reviews.has(event.event_id)) await this.saveReview(run, event, result);
      return;
    }
    const changes = result.status === "apply" ? result.changes : result.restrictions;
    const receivedAt = Date.parse(event.occurred_at);
    if (!pending && result.status !== "apply") {
      // Keep safety restrictions in effect even if the review log cannot be written.
      run.planner.add(changes, receivedAt, receiptOrder);
      if (result.status === "unavailable") {
        run.pending.set(event.event_id, { event, pharmacyId: result.pharmacyId, receiptOrder, retryAfter: run.now });
      }
      await this.saveReview(run, event, result);
      return;
    }
    await this.saveReview(run, event, result.status === "apply" ? undefined : result);
    run.planner.add(changes, receivedAt, receiptOrder);
    run.pending.delete(event.event_id);
  }

  private async dispatch(event: OrderEvent, run: Run): Promise<void> {
    const { order_id } = event.order;
    const previous = run.orders.get(order_id);
    if (previous?.confirmed) return;
    // One recovery attempt leaves time for the pharmacy call within the webhook deadline.
    const retry = [...run.pending.values()].sort((a, b) => a.retryAfter - b.retryAfter)[0];
    if (retry && retry.retryAfter <= run.now) {
      try {
        await this.processEmail(run, retry.event, retry.receiptOrder);
        run.completed.add(retry.event.event_id);
      } catch (error) {
        retry.retryAfter = run.now + 60_000;
        console.error(retry.event.event_id, error instanceof Error ? error.message : "Email recovery failed");
      }
    }

    const held = new Set<string>();
    for (const { pharmacyId } of run.pending.values()) {
      if (pharmacyId === null) {
        for (const { id } of run.config.pharmacies) held.add(id);
        break;
      }
      held.add(pharmacyId);
    }
    if (previous && !run.planner.canRetry(event.order, previous.pharmacy, run.now, previous.at, held)) {
      throw new Error(`Cannot retry ${order_id} without reconciling its prior delivery.`);
    }
    const at = run.now;
    let reservation = previous;
    if (!reservation) {
      reservation = { ...run.planner.select(event.order, at, held), at, confirmed: false };
      run.planner.reserve(reservation.pharmacy, at);
      run.orders.set(order_id, reservation);
    }
    const response = await fetch(run.dispatchUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order_id, pharmacy: reservation.pharmacy, reason: reservation.reason }),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 201 || (previous && response.status === 409)) {
      reservation.confirmed = true;
      return;
    }
    if (response.status === 400 || response.status === 404) {
      run.planner.release(reservation.pharmacy, reservation.at);
      run.orders.delete(order_id);
    }
    throw new Error(`Pharmacy API rejected ${order_id} with HTTP ${response.status}.`);
  }
}

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const buffers: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_048_576) throw new Error("Event too large");
    buffers.push(buffer);
  }
  return JSON.parse(Buffer.concat(buffers).toString("utf8"));
}

export function createDeskServer(
  extract: Extractor = claudeExtractor(),
  reviewPath = process.env.PHARMACY_REVIEW_LOG ?? "out/review-queue.jsonl",
): Server {
  const desk = new Desk(extract, reviewPath);
  let queue = Promise.resolve();
  return createServer(async (request, response) => {
    if (request.url !== "/webhooks") {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const event = decodeEvent(await bodyOf(request).catch(() => null));
    if (!event) {
      response.writeHead(400).end("Invalid event");
      return;
    }
    const handled = queue.then(() => desk.handle(event));
    queue = handled.catch(() => undefined);
    try {
      await handled;
      response.writeHead(204).end();
    } catch (error) {
      console.error(event.event_id, error instanceof Error ? error.message : "Event handling failed");
      response.writeHead(500).end("Event handling failed");
    }
  });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  try {
    const port = Number(process.env.PORT ?? "3000");
    createDeskServer().listen(port, "localhost", () => {
      console.log(`Pharmacy Desk listening at http://localhost:${port}/webhooks`);
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
