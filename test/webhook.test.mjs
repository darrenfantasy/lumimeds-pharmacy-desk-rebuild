import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDeskServer } from "../dist/server.js";

async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    return closed;
  });
  return "http://127.0.0.1:" + server.address().port;
}

const occurred_at = "2026-11-09T10:00:00-05:00";
const medication = "tirzepatide";
const dose = "2.5mg";
const order = (id, time = occurred_at) => ({
  event_id: id, type: "order", occurred_at: time,
  order: { order_id: id, state: "CA", medication, dose },
});
const close = {
  event_id: "closed",
  type: "email",
  occurred_at: "2026-11-09T11:00:00-05:00",
  email: { from: "orders@a.example", subject: "Closure", body: "We're closed starting now until further notice." },
};

async function setup(t, dispatch, extract) {
  const dir = await mkdtemp(join(tmpdir(), "desk-webhook-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  const pharmacyApi = await listen(t, createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    calls.push([payload.order_id, payload.pharmacy]);
    response.writeHead(dispatch(calls.length)).end();
  }));
  const address = await listen(t, createDeskServer(extract, join(dir, "review.jsonl")));
  const post = async (payload) => {
    const response = await fetch(address + "/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    await response.text();
    return response.status;
  };
  const config = {
    catalogue: { [medication]: [dose] },
    lumimedsOps: [],
    pharmacies: [{
      id: "A", name: "A", contacts: ["orders@a.example"], open: true, shipsInDays: 1,
      dailyCapacity: 1, price: { [medication]: 100 }, blockedStates: [], stock: { [medication]: [dose] },
    }],
  };
  const start = { event_id: "start", type: "simulation.started", occurred_at, pharmacyApi, config };
  assert.equal(await post(start), 204);
  return { post, start, calls, reviewPath: join(dir, "review.jsonl") };
}

test("redelivers an uncertain safe order to the same destination without consuming capacity twice", async (t) => {
  const { post, start, calls } = await setup(t, (call) => [503, 409, 201][call - 1], async () => null);
  const first = order("first");
  assert.equal(await post(first), 500);
  assert.equal(await post(first), 204);
  assert.equal(await post(start), 204);
  assert.equal(await post(first), 204);
  assert.equal(await post(order("second")), 204);
  assert.deepEqual(calls, [["first", "A"], ["first", "A"], ["second", "MANUAL"]]);
});

test("does not resend an uncertain dispatch after a pharmacy closes", async (t) => {
  const extract = async () => ({
    status: "apply",
    changes: [{ pharmacyId: "A", from: null, until: null, rule: { kind: "open", value: false } }],
  });
  const { post, calls } = await setup(t, (call) => call === 1 ? 503 : 201, extract);
  const first = order("first");
  assert.equal(await post(first), 500);
  assert.equal(await post(close), 204);
  assert.equal(await post(first), 500);
  assert.equal(await post(order("second", close.occurred_at)), 204);
  assert.deepEqual(calls, [["first", "A"], ["second", "MANUAL"]]);
});

test("holds the sender's pharmacy and keeps a review entry if the model is unavailable", async (t) => {
  const extract = async () => { throw new Error("provider unavailable"); };
  const { post, calls, reviewPath } = await setup(t, () => 201, extract);
  assert.equal(await post(close), 204);
  assert.equal(await post(close), 204);
  assert.equal(await post(order("first", close.occurred_at)), 204);
  assert.deepEqual(calls, [["first", "MANUAL"]]);
  const entries = (await readFile(reviewPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(entries.length, 1);
  assert.match(entries[0].reason, /extraction unavailable/i);
});

test("an Eastern midnight closure stays in force even when the model moves it to the next day", async (t) => {
  const extract = async () => ({
    status: "apply",
    changes: [{
      pharmacyId: "A", from: "2026-11-10T23:30:00-05:00", until: "2026-11-11",
      rule: { kind: "open", value: false },
    }],
  });
  const { post, calls, reviewPath } = await setup(t, () => 201, extract);
  const overnight = {
    ...close,
    occurred_at: "2026-11-09T23:00:00-05:00",
    email: { ...close.email, body: "We're closed from 11:30 p.m. tonight to midnight." },
  };
  assert.equal(await post(overnight), 204);
  assert.equal(await post(order("before-midnight", "2026-11-10T04:59:59Z")), 204);
  assert.equal(await post(order("after-midnight", "2026-11-10T05:00:00Z")), 204);
  assert.deepEqual(calls, [["before-midnight", "MANUAL"], ["after-midnight", "A"]]);
  assert.equal(JSON.parse((await readFile(reviewPath, "utf8")).trim()).event_id, overnight.event_id);
});
