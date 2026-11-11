import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDeskServer } from "../dist/server.js";

const tuesday = "2026-11-10T09:00:00-05:00";
const friday = "2026-11-13T01:00:00-05:00";
const pharmacy = (id, shipsInDays) => ({
  id, name: id, contacts: [`team@${id.toLowerCase()}.example`], open: true, shipsInDays,
  dailyCapacity: 10, price: { semaglutide: 100, tirzepatide: 100 }, blockedStates: [],
  stock: { semaglutide: ["1mg"], tirzepatide: ["5mg"] },
});
const config = {
  catalogue: { semaglutide: ["1mg"], tirzepatide: ["5mg"] }, lumimedsOps: ["desk@ops.example"],
  pharmacies: [pharmacy("ASTER", 1), pharmacy("BIRCH", 2)],
};
const proposal = (rule, from = null, until = null) => ({ pharmacyId: "ASTER", from, until, rule });
const apply = (...changes) => ({ status: "apply", changes });
const scenarios = [
  {
    name: "a closure for today and tomorrow starts today",
    body: "We are closed today and tomorrow.",
    model: apply(proposal({ kind: "open", value: false }, null, "2026-11-12")),
    expectedReview: false,
  },
  {
    name: "a pharmacy that will not be open on Friday is excluded",
    body: "We will not be open on Friday.",
    model: apply(proposal({ kind: "open", value: false }, "2026-11-13", "2026-11-14")),
    orderTime: friday,
    expectedReview: false,
  },
  {
    name: "an explicitly dated EST closure applies",
    body: "We are closed from midnight to 2 a.m. EST tomorrow.",
    model: apply(proposal({ kind: "open", value: false }, "2026-11-11", "2026-11-11T02:00:00-05:00")),
    orderTime: "2026-11-11T01:00:00-05:00",
    expectedReview: false,
  },
  {
    name: "an Ops exclusion keeps its original window when the model swaps two IDs",
    sender: "desk@ops.example",
    body: "Exclude ASTER for semaglutide orders from 11 p.m. tonight to midnight; Prefer ASTER for semaglutide orders from midnight to 2 a.m. Eastern.",
    model: apply(
      { pharmacyId: "ASTER", windowId: "window-2", rule: { kind: "routing", action: "block", scope: { medication: "semaglutide" } } },
      { pharmacyId: "ASTER", windowId: "window-1", rule: { kind: "routing", action: "prefer", scope: { medication: "semaglutide" } } },
    ),
    orderTime: "2026-11-10T23:30:00-05:00",
    medication: "semaglutide",
    dose: "1mg",
    expectedReview: true,
  },
  {
    name: "an open-ended closure survives an ambiguous restock in the same email",
    body: "We are closed until further notice due to a water leak. Separately, our 25mg restock is still unconfirmed.",
    model: { status: "review", reason: "Unrecognized dose needs review." },
    expectedReview: true,
  },
  {
    name: "an exact dose with conflicting inventory is held for review",
    body: "Tirzepatide 5mg is in stock. Tirzepatide 5mg is also reported out of stock. We have not confirmed which report is correct.",
    model: { status: "review", reason: "Stock status conflicts." },
    expectedReview: true,
  },
  {
    name: "a confirmed shipping ban survives an ambiguous dose in the same email",
    body: "Starting now, we can no longer ship to New York. Separately, we restocked 25mg, but please confirm the dose.",
    model: { status: "review", reason: "Unrecognized dose needs review." },
    expectedReview: true,
  },
  {
    name: "a reversed shipping prohibition is rejected",
    body: "Effective immediately, we cannot ship to New York.",
    model: apply(proposal({ kind: "shipping", state: "NY", allowed: true })),
    expectedReview: true,
  },
  {
    name: "an omitted exact-dose shortage is still applied",
    body: "Tirzepatide 5mg is out of stock. Semaglutide 1mg is out of stock.",
    model: apply(proposal({ kind: "stock", medication: "semaglutide", dose: "1mg", available: false })),
    expectedReview: true,
  },
  {
    name: "a Friday midnight closure applies on Friday",
    body: "We will be closed from midnight to 2 a.m. Eastern on Friday.",
    model: apply(proposal({ kind: "open", value: false }, "2026-11-13", "2026-11-13T02:00:00-05:00")),
    orderTime: friday,
    expectedReview: false,
  },
  {
    name: "an incorrect Saturday proposal cannot override a Friday closure",
    body: "Hi Sam, quick one: we're closed on Friday for a stock count.",
    model: apply(proposal({ kind: "open", value: false }, "2026-11-14", "2026-11-15")),
    orderTime: friday,
    expectedReview: true,
  },
  {
    name: "the immediate capacity limit uses its own clause instead of tomorrow's",
    body: "Starting now our daily capacity is zero until tomorrow. Starting tomorrow our daily capacity is five.",
    model: apply(proposal({ kind: "capacity", value: 0 }, null, "2026-11-11"),
      proposal({ kind: "capacity", value: 5 }, "2026-11-11")),
    expectedReview: false,
  },
];

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return "http://127.0.0.1:" + server.address().port;
}
async function close(server) {
  const closed = once(server, "close");
  server.close();
  server.closeAllConnections();
  await closed;
}
async function replay(scenario) {
  const dir = await mkdtemp(join(tmpdir(), "pharmacy-review-"));
  const orders = [];
  const api = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    orders.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(201).end();
  });
  const review = join(dir, "reviews.jsonl");
  const desk = createDeskServer(async () => scenario.model, review);
  try {
    const pharmacyApi = await listen(api);
    const address = await listen(desk);
    async function send(type, event_id, occurred_at, fields) {
      const response = await fetch(address + "/webhooks", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, event_id, occurred_at, ...fields }),
      });
      assert.equal(response.status, 204);
      await response.text();
    }
    await send("simulation.started", "start", tuesday, { pharmacyApi, config });
    await send("email", "email", tuesday, {
      email: { from: scenario.sender ?? "team@aster.example", subject: "Update", body: scenario.body },
    });
    await send("order", "order", scenario.orderTime ?? "2026-11-10T10:00:00-05:00", {
      order: { order_id: "ORD-REVIEW", state: "NY", medication: scenario.medication ?? "tirzepatide", dose: scenario.dose ?? "5mg" },
    });
    assert.equal(orders.length, 1);
    const reviews = (await readFile(review, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
    return { actual: orders[0].pharmacy, reviews };
  } finally {
    await Promise.all([close(desk), close(api)]);
    await rm(dir, { recursive: true, force: true });
  }
}
for (const scenario of scenarios) {
  test(scenario.name, async () => {
    const { actual, reviews } = await replay(scenario);
    assert.equal(actual, "BIRCH");
    assert.equal(reviews.length > 0, scenario.expectedReview);
  });
}
