#!/usr/bin/env node
// LumiMeds pharmacy-desk simulator. Plain Node 18+, no dependencies. Works with an app in any language.
//
// Replays a week of events as POSTs to ONE webhook URL (the event type is in the body), one at a time:
// the next event goes out when your app replies, or after --timeout. Some events are delivered more
// than once (same event_id). It also plays the pharmacy API that your app sends orders to.
//
//   node sim/sim.mjs --target http://localhost:3000/webhooks
//     [--week sim/week-a.jsonl] [--log out/run-log.jsonl] [--deliveries out/deliveries.jsonl]
//     [--pharmacy-port 4000] [--timeout 30000] [--wait 15] [--drain 60] [--quiet] [--ping]
//
//   --ping   send only simulation.started, the first email and the first order (checks your wiring)
//   --wait   seconds to keep retrying an event while your app can't be reached (starting, restarting)
//   --drain  seconds to wait at the end for orders that haven't been sent yet
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const flag = (name) => argv.includes(`--${name}`);
const target = arg("target", "http://localhost:3000/webhooks");
const logPath = arg("log", "out/run-log.jsonl");
const deliveriesPath = arg("deliveries", logPath.replace(/[^/]*$/, "deliveries.jsonl"));
const pharmacyPort = Number(arg("pharmacy-port", "4000"));
const timeoutMs = Number(arg("timeout", "30000"));
const waitSec = Number(arg("wait", "15"));
const drainSec = Number(arg("drain", "60"));
const quiet = flag("quiet");

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
let events;
try {
  events = readFileSync(arg("week", "sim/week-a.jsonl"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
} catch (err) { fail(`can't read the week file: ${err.message}`); }

// Fail fast on a broken week file (we write these by hand).
if (events[0]?.type !== "simulation.started") fail("week file must start with a simulation.started event");
// A repeated event_id is a redelivery and must be an exact copy. Only first deliveries must be in time order.
const firstOf = new Map();
let lastFirst = null;
for (const e of events) {
  if (Number.isNaN(Date.parse(e.occurred_at))) fail(`${e.event_id} has no valid occurred_at`);
  if (firstOf.has(e.event_id)) {
    if (JSON.stringify(firstOf.get(e.event_id)) !== JSON.stringify(e)) fail(`${e.event_id} appears twice with different contents`);
    continue;
  }
  if (lastFirst && Date.parse(e.occurred_at) < Date.parse(lastFirst.occurred_at)) fail(`${e.event_id} is earlier than the event before it`);
  firstOf.set(e.event_id, e); lastFirst = e;
}
if (flag("ping")) events = [events[0], events.find((e) => e.type === "email"), events.find((e) => e.type === "order")].filter(Boolean);

let current = events[0];
const replied = new Set();
const sent = new Map();
const log = [];
const deliveries = [];
const problems = [];
const orderEventOf = new Map();
for (const e of events) if (e.type === "order" && !orderEventOf.has(e.order.order_id)) orderEventOf.set(e.order.order_id, e);

// The pharmacy API. Sending an order is final: a second send for the same order is refused.
const reply = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.method !== "POST" || req.url.split("?")[0] !== "/pharmacy-orders") return reply(res, 404, { error: "not found: use POST /pharmacy-orders" });
    let body;
    try { body = JSON.parse(raw); } catch { return reply(res, 400, { error: "body must be JSON" }); }
    if (typeof body?.order_id !== "string" || typeof body?.pharmacy !== "string")
      return reply(res, 400, { error: 'expected { "order_id": string, "pharmacy": string (an id or "MANUAL"), "reason"?: string }' });
    if (!orderEventOf.has(body.order_id)) return reply(res, 404, { error: `unknown order ${body.order_id}` });
    if (sent.has(body.order_id)) {
      problems.push(`${body.order_id} was sent to the pharmacy API more than once`);
      return reply(res, 409, { error: "already sent" });
    }
    // "late" = sent after your app had already replied to that order's event.
    const ev = orderEventOf.get(body.order_id);
    const late = ev.event_id !== current.event_id || replied.has(ev.event_id);
    const entry = { order_id: body.order_id, pharmacy: body.pharmacy, reason: body.reason ?? null, sim_time: ev.occurred_at, during_event: current.event_id, late };
    sent.set(body.order_id, entry);
    log.push(entry);
    reply(res, 201, { ok: true });
  });
});
await new Promise((ok, ko) => { server.once("error", ko); server.listen(pharmacyPort, ok); })
  .catch((err) => fail(`can't start the pharmacy API on port ${pharmacyPort}: ${err.code ?? err.message}`));
const pharmacyApi = `http://localhost:${pharmacyPort}`;
const stop = () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); });

const when = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const what = (e) =>
  e.type === "email" ? `${e.email.from} "${e.email.subject}"` :
  e.type === "order" ? `${e.order.order_id} ${e.order.state} ${e.order.medication} ${e.order.dose}` : "starting config";

// If your app can't be reached (starting up, restarting, crashed mid-request), keep retrying the same
// event for up to --wait seconds before giving up.
const UNREACHABLE = new Set(["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET", "EPIPE"]);
async function deliver(e) {
  const body = e.type === "simulation.started" ? { ...e, pharmacyApi } : e;
  const deadline = Date.now() + waitSec * 1000;
  let told = false;
  for (;;) {
    try {
      return await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json", "x-sim-time": e.occurred_at, "x-event-id": e.event_id },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (UNREACHABLE.has(err?.cause?.code ?? err?.code) && Date.now() < deadline) {
        if (!told && !quiet && e !== events[0]) { console.log(`  can't reach your app; retrying ${e.event_id} for up to ${waitSec}s…`); told = true; }
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      throw err;
    }
  }
}

const delivered = new Set();
for (const e of events) {
  current = e;
  const again = delivered.has(e.event_id);
  delivered.add(e.event_id);
  const before = log.length;
  const t0 = performance.now();
  let status = null, error = null;
  try {
    const res = await deliver(e);
    status = res.status;
    await res.arrayBuffer(); // drain the reply
    if (!res.ok) error = `your app replied HTTP ${res.status}`;
  } catch (err) {
    if (err?.name !== "TimeoutError") {
      await stop();
      fail(`can't reach your app at ${target} (${err?.cause?.code ?? err?.code ?? err?.message}). Is it running, and is that the right URL?`);
    }
    error = `no reply within ${timeoutMs} ms, moved on`;
  }
  replied.add(e.event_id);
  const ms = Math.round(performance.now() - t0);
  const ordersSent = log.slice(before).filter((x) => !x.late).map((x) => `${x.order_id}→${x.pharmacy}`);
  if (error) problems.push(`${e.event_id} ${e.type}: ${error}`);
  deliveries.push({ event_id: e.event_id, type: e.type, occurred_at: e.occurred_at, redelivery: again, status, ms, orders_sent: ordersSent, error });
  if (!quiet) console.log(`[${when(e.occurred_at)}] ${e.event_id} ${(e.type + (again ? " (again)" : "")).padEnd(18)} ${what(e).padEnd(42)} → ${status ?? "—"} in ${ms} ms` +
    (ordersSent.length ? ` · sent ${ordersSent.join(", ")}` : "") + (error ? `  ✗ ${error}` : ""));
}

// Wait for orders that haven't been sent yet (up to --drain).
const orderEvents = [...orderEventOf.values()];
const outstanding = () => orderEvents.filter((e) => !sent.has(e.order.order_id)).length;
if (outstanding() > 0 && drainSec > 0) {
  if (!quiet) console.log(`waiting up to ${drainSec}s for ${outstanding()} order(s) not sent yet…`);
  const deadline = Date.now() + drainSec * 1000;
  while (outstanding() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
}
await new Promise((r) => setTimeout(r, 100)); // let any request in flight finish
for (const e of orderEvents)
  if (!sent.has(e.order.order_id)) problems.push(`${e.event_id} order: ${e.order.order_id} was never sent to a pharmacy (or MANUAL)`);

for (const p of [logPath, deliveriesPath]) mkdirSync(dirname(p), { recursive: true });
writeFileSync(logPath, log.map((x) => JSON.stringify(x)).join("\n") + (log.length ? "\n" : ""));
writeFileSync(deliveriesPath, deliveries.map((x) => JSON.stringify(x)).join("\n") + "\n");
const late = log.filter((x) => x.late).length;
for (const p of [...new Set(problems)]) console.error(`✗ ${p}`);
console.log(`delivered ${deliveries.filter((d) => d.status && d.status < 300).length} of ${events.length} events; ` +
  `${log.length} of ${orderEvents.length} orders sent to a pharmacy or MANUAL` +
  (problems.length ? `; ${new Set(problems).size} problem(s)` : "; no problems") +
  (late ? `\n  ${late} order(s) were sent after your app had replied to them` : "") +
  `\n→ ${logPath}, ${deliveriesPath}`);
await stop();
process.exit(problems.length ? 1 : 0);
