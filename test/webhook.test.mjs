import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
const reopen = {
  ...close,
  event_id: "reopened",
  email: { ...close.email, subject: "Reopening", body: "We're back open now." },
};
const availability = (open) => ({
  status: "apply",
  changes: [{ pharmacyId: "A", from: null, until: null, rule: { kind: "open", value: open } }],
});

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
  const extract = async () => availability(false);
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

test("retries the original unavailable email after recovery and preserves receipt order at equal timestamps", async (t) => {
  const extractions = [];
  const extract = async (_system, input) => {
    const subject = JSON.parse(input).email.subject;
    extractions.push(subject);
    if (extractions.length === 1) throw new Error("provider temporarily unavailable");
    return availability(subject === "Reopening");
  };
  const { post, calls, reviewPath } = await setup(t, () => 201, extract);
  assert.equal(await post(close), 204);
  assert.equal(await post(reopen), 204);
  assert.equal(await post(order("after-recovery", close.occurred_at)), 204);
  assert.deepEqual(extractions, ["Closure", "Reopening", "Closure"]);
  assert.deepEqual(calls, [["after-recovery", "A"]]);
  assert.equal(await readFile(reviewPath, "utf8"), "");
});

test("a reopening notice does not release an outage hold when the original email is still unavailable", async (t) => {
  const subjects = [];
  const extract = async (_system, input) => {
    const subject = JSON.parse(input).email.subject;
    subjects.push(subject);
    if (subject === "Closure") throw new Error("original email extraction is unavailable");
    return availability(true);
  };
  const { post, calls, reviewPath } = await setup(t, () => 201, extract);
  assert.equal(await post(close), 204);
  assert.equal(await post(reopen), 204);
  assert.equal(await post(order("held", close.occurred_at)), 204);
  assert.equal(await post(order("within-retry-delay", close.occurred_at)), 204);
  assert.deepEqual(subjects, ["Closure", "Reopening", "Closure"]);
  assert.deepEqual(calls, [["held", "MANUAL"], ["within-retry-delay", "MANUAL"]]);
  const review = JSON.parse((await readFile(reviewPath, "utf8")).trim());
  assert.equal(review.event_id, close.event_id);
});

test("an unavailable email can recover on redelivery without releasing a separate pending hold", async (t) => {
  let reopeningAttempts = 0;
  const extract = async (_system, input) => {
    const subject = JSON.parse(input).email.subject;
    if (subject === "Closure" || ++reopeningAttempts === 1) throw new Error("provider unavailable");
    return availability(true);
  };
  const { post, calls, reviewPath } = await setup(t, () => 201, extract);
  assert.equal(await post(reopen), 204);
  const laterClosure = { ...close, occurred_at: "2026-11-09T11:01:00-05:00" };
  assert.equal(await post(laterClosure), 204);
  assert.equal(await post(reopen), 204);
  assert.equal(await post(order("still-held", laterClosure.occurred_at)), 204);
  assert.equal(reopeningAttempts, 2);
  assert.deepEqual(calls, [["still-held", "MANUAL"]]);
  const review = JSON.parse((await readFile(reviewPath, "utf8")).trim());
  assert.equal(review.event_id, close.event_id);
});

test("recovery preserves a confirmed closure and replaces the outage review with the remaining issue", async (t) => {
  let attempts = 0;
  const extract = async () => {
    if (++attempts === 1) throw new Error("provider temporarily unavailable");
    return { status: "review", reason: "Dose is not in the catalogue." };
  };
  const { post, calls, reviewPath } = await setup(t, () => 201, extract);
  const closureWithBadDose = {
    ...close,
    email: { ...close.email, body: "We're closed today for maintenance. We also think we restocked tirzepatide 25mg." },
  };
  assert.equal(await post(closureWithBadDose), 204);
  assert.equal(await post(order("during-closure", close.occurred_at)), 204);
  assert.equal(await post(order("after-closure", "2026-11-10T00:00:00-05:00")), 204);
  assert.equal(attempts, 2);
  assert.deepEqual(calls, [["during-closure", "MANUAL"], ["after-closure", "A"]]);
  const review = JSON.parse((await readFile(reviewPath, "utf8")).trim());
  assert.equal(review.reason, "Dose is not in the catalogue.");
  assert.deepEqual(review.restrictions.map(({ rule }) => rule), [{ kind: "open", value: false }]);
});

test("a failed review-log write cannot make a confirmed closure disappear", async (t) => {
  const extract = async () => ({ status: "review", reason: "Please confirm the restock." });
  const { post, calls, reviewPath } = await setup(t, () => 201, extract);
  const stagedReview = reviewPath + ".tmp";
  await mkdir(stagedReview);
  assert.equal(await post(close), 500);
  assert.equal(await post(order("still-closed", close.occurred_at)), 204);
  assert.deepEqual(calls, [["still-closed", "MANUAL"]]);
  await rm(stagedReview, { recursive: true });
  assert.equal(await post(close), 204);
  const review = JSON.parse((await readFile(reviewPath, "utf8")).trim());
  assert.equal(review.event_id, close.event_id);
});

test("an order can still dispatch safely when recovery cannot update the review log", async (t) => {
  let attempts = 0;
  const extract = async () => {
    if (++attempts === 1) throw new Error("provider temporarily unavailable");
    return availability(true);
  };
  const { post, calls, reviewPath } = await setup(t, () => 201, extract);
  assert.equal(await post(reopen), 204);
  const stagedReview = reviewPath + ".tmp";
  await mkdir(stagedReview);
  assert.equal(await post(order("while-unresolved", reopen.occurred_at)), 204);
  assert.deepEqual(calls, [["while-unresolved", "MANUAL"]]);
  await rm(stagedReview, { recursive: true });
  assert.equal(await post(order("after-recovery", "2026-11-09T11:01:00-05:00")), 204);
  assert.deepEqual(calls, [["while-unresolved", "MANUAL"], ["after-recovery", "A"]]);
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
