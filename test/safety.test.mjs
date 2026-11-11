import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { collectSafetyEvidence } from "../dist/safety.js";

const official = (await readFile(new URL("../sim/week-a.jsonl", import.meta.url), "utf8"))
  .trim().split("\n").map(JSON.parse);
const { config } = official[0];
const now = Date.parse("2026-11-10T14:00:00Z");
const midnight = (day) => Date.parse(`2026-11-${day}T05:00:00Z`);
const facts = (body) => collectSafetyEvidence({ from: "test@example.com", subject: "Operations update", body }, "TANDREL", config, now);

test("a shipping grant does not swallow a contrasting state exclusion", () => {
  assert.deepEqual(
    facts("We can ship to California but not New York.").map(({ change }) => change.rule),
    [
      { kind: "shipping", state: "CA", allowed: true },
      { kind: "shipping", state: "NY", allowed: false },
    ],
  );
});
const evidence = (body) => facts(body).map(({ change, uncertain }) => ({
  from: change.from, until: change.until, rule: change.rule, ...(uncertain ? { uncertain } : {}),
}));
const stock = (medication, dose, available) => ({ kind: "stock", medication, dose, available });

test("keeps indefinite closure and confirmed shipping bans when a separate statement is unclear", () => {
  const body = "We are closed until further notice due to a water leak. Separately, we can no longer ship to New York or CA. We might have restocked 25mg.";
  assert.deepEqual(evidence(body), [
    { from: now, until: null, rule: { kind: "open", value: false } },
    { from: now, until: null, rule: { kind: "shipping", state: "NY", allowed: false } },
    { from: now, until: null, rule: { kind: "shipping", state: "CA", allowed: false } },
  ]);
  assert.deepEqual(evidence("We can ship to California, not Nevada."), [
    { from: now, until: null, rule: { kind: "shipping", state: "CA", allowed: true } },
    { from: now, until: null, rule: { kind: "shipping", state: "NV", allowed: false } },
  ]);
  for (const reopening of ["We reopened for fulfillment.", "We're now open."]) {
    assert.deepEqual(evidence(reopening), [{ from: now, until: null, rule: { kind: "open", value: true } }]);
  }
  assert.deepEqual(evidence("We will be open tomorrow."), [
    { from: midnight(11), until: midnight(12), rule: { kind: "open", value: true } },
  ]);
});

test("holds only the exact disputed stock and preserves other clearly known doses", () => {
  const body = "Tirzepatide 5mg is in stock. Tirzepatide 5mg is also reported out of stock. We have not confirmed which report is correct. Semaglutide 1mg is in stock.";
  assert.deepEqual(evidence(body), [
    { from: now, until: null, rule: stock("tirzepatide", "5mg", false), uncertain: true },
    { from: now, until: null, rule: stock("semaglutide", "1mg", true) },
  ]);
  assert.deepEqual(evidence("Tirzepatide 5mg is reported both in stock and out of stock."), [
    { from: now, until: null, rule: stock("tirzepatide", "5mg", false), uncertain: true },
  ]);
});

test("keeps distinct stock statements separate, including a scheduled restoration", () => {
  const body = "Tirzepatide 5mg is in stock and tirzepatide 7.5mg is out of stock. The 7.5mg is back on Wednesday.";
  assert.deepEqual(evidence(body), [
    { from: now, until: null, rule: stock("tirzepatide", "5mg", true) },
    { from: now, until: midnight(11), rule: stock("tirzepatide", "7.5mg", false) },
    { from: midnight(11), until: null, rule: stock("tirzepatide", "7.5mg", true) },
  ]);
  assert.deepEqual(evidence("We're out of tirzepatide 5mg and have semaglutide 1mg in stock."), [
    { from: now, until: null, rule: stock("tirzepatide", "5mg", false) },
    { from: now, until: null, rule: stock("semaglutide", "1mg", true) },
  ]);
  assert.deepEqual(evidence("Tirzepatide 5mg is not currently in stock."), [
    { from: now, until: null, rule: stock("tirzepatide", "5mg", false) },
  ]);
});

test("extracts exact capacity limits against their respective clauses and dates", () => {
  assert.deepEqual(evidence("Starting now our daily capacity is zero until tomorrow. Starting tomorrow our daily capacity is five."), [
    { from: now, until: midnight(11), rule: { kind: "capacity", value: 0 } },
    { from: midnight(11), until: null, rule: { kind: "capacity", value: 5 } },
  ]);
});

test("retains dated and timed weekday closures without inferring uncertain or partial scope", () => {
  assert.deepEqual(evidence("Hi Sam, quick one: we're closed on Friday for a stock count."), [
    { from: midnight(13), until: midnight(14), rule: { kind: "open", value: false } },
  ]);
  assert.deepEqual(evidence("We will be closed from midnight to 2 a.m. EST on Friday."), [
    { from: midnight(13), until: Date.parse("2026-11-13T07:00:00Z"), rule: { kind: "open", value: false } },
  ]);
  assert.deepEqual(evidence("We're closed until 2 p.m. Eastern today."), [
    { from: now, until: Date.parse("2026-11-10T19:00:00Z"), rule: { kind: "open", value: false } },
  ]);
  for (const body of [
    "If the storm is severe:\nClosed tomorrow.",
    "We're closed tomorrow for pickup only.",
    "We're closed until 2 p.m. Pacific today.",
    "We will be open tomorrow morning.",
    "We are not closed tomorrow.",
    "We're open to questions.",
    "We might run out of tirzepatide 5mg.",
    "We used to ship to Texas.",
    "Heads up.\n> We cannot ship to Texas.\nOn Friday, Ash wrote:\nTirzepatide 5mg is out of stock.",
  ]) assert.deepEqual(evidence(body), [], body);
});

test("retains the official Week A shortage correction and shipping restrictions", () => {
  const event = (id) => official.find(({ event_id }) => event_id === id);
  const evidenceFor = (id) => {
    const e = event(id);
    return collectSafetyEvidence(e.email, "TANDREL", config, Date.parse(e.occurred_at)).map(({ change }) => change);
  };
  assert.deepEqual(evidenceFor("evt_001").map(({ rule }) => rule), [stock("tirzepatide", "5mg", false)]);
  assert.deepEqual(evidenceFor("evt_002").map(({ rule }) => rule), [{ kind: "shipping", state: "FL", allowed: false }]);
  assert.deepEqual(evidenceFor("evt_017").map(({ rule, until }) => [rule, until]), [
    [stock("tirzepatide", "7.5mg", false), midnight(11)],
    [stock("tirzepatide", "7.5mg", true), null],
    [stock("tirzepatide", "5mg", true), null],
  ]);
  assert.deepEqual(evidenceFor("evt_020").map(({ rule, until }) => [rule, until]), [
    [{ kind: "capacity", value: 2 }, midnight(16)],
  ]);
  assert.deepEqual(evidenceFor("evt_022").map(({ rule }) => rule), [{ kind: "shipping", state: "TX", allowed: false }]);
});
