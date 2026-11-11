import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { interpretEmail } from "../dist/email.js";

const events = (await readFile(new URL("../sim/week-a.jsonl", import.meta.url), "utf8"))
  .trim().split("\n").map((line) => JSON.parse(line));
const { config } = events[0];
const email = (id) => events.find((event) => event.event_id === id);
const stock = (medication, dose, available) => ({ kind: "stock", medication, dose, available });
const routing = (action, scope) => ({ kind: "routing", action, scope });
const open = (value) => ({ kind: "open", value });
const proposal = (pharmacyId, rule, from = null, until = null) => ({ pharmacyId, from, until, rule });
const proposals = (...changes) => async () => ({ status: "apply", changes });

function custom(body, from = "hello@wrenfold.example", subject = "Desk update", occurred_at = "2026-11-10T02:00:00Z") {
  return { event_id: "custom", type: "email", occurred_at, email: { from, subject, body } };
}

test("applies an exact catalogue dose and uses Eastern midnight for an exclusive end date", async () => {
  const event = email("evt_001");
  const result = await interpretEmail(event, config, proposals(
    proposal("TANDREL", stock("tirz", "5.00 MG", false), null, "2026-11-11"),
  ));
  assert.deepEqual(result, {
    status: "apply",
    changes: [{
      pharmacyId: "TANDREL",
      from: Date.parse(event.occurred_at),
      until: Date.parse("2026-11-11T05:00:00Z"),
      rule: stock("tirzepatide", "5mg", false),
    }],
  });
});

test("does not extract unrecognized senders or an instruction to override extraction rules", async () => {
  let calls = 0;
  const extractor = async () => { calls++; return { status: "apply", changes: [] }; };
  const unknown = custom("Closed tomorrow.", "hello@wrenfold.example.untrusted.test");
  for (const event of [unknown, email("evt_003")]) {
    const result = await interpretEmail(event, config, extractor);
    assert.equal(result.status, "review");
    assert.deepEqual(result.restrictions, []);
  }
  assert.equal(calls, 0);
});

test("rejects proposed changes with an unauthorized target, route, or unsupported dose", async () => {
  const event = email("evt_004");
  for (const change of [
    proposal("ISHBY", stock("tirz", "25mg", true)),
    proposal("VELMORA", stock("tirz", "5mg", true)),
    proposal("ISHBY", routing("prefer", { medication: "tirzepatide" })),
    proposal("ISHBY", { kind: "capacity", value: -1 }),
  ]) {
    const result = await interpretEmail(event, config, proposals(change));
    assert.equal(result.status, "review");
  }
});

test("rejects conflicting stock for the same canonical dose while preserving corrected doses", async () => {
  const event = email("evt_017");
  const out = proposal("TANDREL", stock("tirzepatide", "7.5mg", false), null, "2026-11-11");
  const conflicting = proposal("TANDREL", stock("tirz", "7.50 MG", true));
  const correct = proposal("TANDREL", stock("tirz", "5mg", true));
  assert.equal((await interpretEmail(event, config, proposals(out, conflicting))).status, "review");
  assert.equal((await interpretEmail(event, config, proposals(out, correct))).status, "apply");
});

test("keeps an independently confirmed full-day closure when another part needs review", async () => {
  const event = email("evt_014");
  const decision = await interpretEmail(event, config, proposals(
    proposal("WRENFOLD", open(false), "2026-11-10", "2026-11-11"),
    proposal("WRENFOLD", stock("tirz", "25mg", true)),
  ));
  assert.equal(decision.status, "review");
  assert.deepEqual(decision.restrictions, [{
    pharmacyId: "WRENFOLD",
    from: Date.parse("2026-11-10T05:00:00Z"),
    until: Date.parse("2026-11-11T05:00:00Z"),
    rule: open(false),
  }]);
});

test("does not preserve conditional, partial, negated, or quoted closures", async () => {
  for (const body of [
    "If staff cannot make it: we're closed tomorrow.",
    "We're closed tomorrow for pickup only.",
    "We aren't closed tomorrow.",
    "Thanks for checking.\n> We're closed tomorrow.",
    "We are open tomorrow.\nOn Friday, Alex wrote:\nClosed tomorrow.",
  ]) {
    const decision = await interpretEmail(custom(body), config, async () => ({ status: "review" }));
    assert.deepEqual(decision.restrictions, [], body);
  }
});

test("binds a closure to its received-date midnight window and preserves it on a bad model date", async () => {
  const event = custom("We're closed from 10 pm tonight to midnight. The loading dock is under maintenance.");
  const window = { ...proposal("WRENFOLD", open(false)), windowId: "window-1" };
  const good = await interpretEmail(event, config, proposals(window));
  const bad = await interpretEmail(event, config, proposals({ ...window, until: "2026-11-11" }));
  const closure = {
    pharmacyId: "WRENFOLD",
    from: Date.parse("2026-11-10T03:00:00Z"),
    until: Date.parse("2026-11-10T05:00:00Z"),
    rule: open(false),
  };
  assert.deepEqual(good, { status: "apply", changes: [closure] });
  assert.equal(bad.status, "review");
  assert.deepEqual(bad.restrictions, [closure]);
});

test("requires exactly the stated scope to lift an exclusion", async () => {
  const event = custom(
    "Lift the exclusion for Velmora on New York semaglutide 1mg orders.",
    "sam@lumimeds.example",
  );
  for (const scope of [{}, { state: "NY" }, { state: "NJ", medication: "sema", dose: "1mg" }]) {
    assert.equal((await interpretEmail(event, config, proposals(
      proposal("VELMORA", routing("clear-block", scope)),
    ))).status, "review");
  }
  const exact = await interpretEmail(event, config, proposals(
    proposal("VELMORA", routing("clear-block", { state: "NY", medication: "sema", dose: "1mg" })),
  ));
  assert.equal(exact.status, "apply");
});

test("Ops can direct routing with explicit scope and cannot override pharmacy facts", async () => {
  const event = email("evt_027");
  const prefer = (scope) => proposal("VELMORA", routing("prefer", scope), "2026-11-11", "2026-11-16");
  for (const change of [
    prefer({}),
    prefer({ medication: "sema", state: "NY" }),
    proposal("VELMORA", routing("prefer", { medication: "sema" }), null, "2026-11-16"),
    proposal("VELMORA", routing("prefer", { medication: "sema" }), "2026-11-11", "2026-11-15"),
    proposal("VELMORA", { kind: "shipping", state: "CA", allowed: true }),
    proposal("VELMORA", open(true)),
  ]) {
    assert.equal((await interpretEmail(event, config, proposals(change))).status, "review");
  }
  assert.equal((await interpretEmail(event, config, proposals(prefer({ medication: "sema" })))).status, "apply");
});

test("a scoped do-not-send instruction blocks only the stated orders", async () => {
  const event = custom("Do not send NY semaglutide orders to Velmora.", "sam@lumimeds.example");
  const rule = routing("block", { state: "NY", medication: "sema" });
  assert.equal((await interpretEmail(event, config, proposals(proposal("VELMORA", rule)))).status, "apply");
  for (const incorrect of [
    routing("block", { state: "NY" }),
    routing("block", { state: "NY", medication: "sema", dose: "1mg" }),
    routing("prefer", { state: "NY", medication: "sema" }),
  ]) {
    assert.equal((await interpretEmail(event, config, proposals(proposal("VELMORA", incorrect)))).status, "review");
  }
  const ambiguous = custom("Prefer Velmora for NY orders. Prefer Tandrel for Texas orders.", "sam@lumimeds.example");
  assert.equal((await interpretEmail(ambiguous, config, proposals(
    proposal("VELMORA", routing("prefer", { state: "NY" })),
  ))).status, "review");
});

test("stock polarity and explicit weekday bounds must agree with the source", async () => {
  const event = email("evt_001");
  for (const change of [
    proposal("TANDREL", stock("tirz", "5mg", true), null, "2026-11-11"),
    proposal("TANDREL", stock("tirz", "5mg", false), null, "2026-11-10"),
    proposal("TANDREL", stock("tirz", "5mg", false), "2026-11-10", "2026-11-11"),
    proposal("TANDREL", stock("tirz", "7.5mg", false), null, "2026-11-11"),
  ]) {
    assert.equal((await interpretEmail(event, config, proposals(change))).status, "review");
  }
});

test("an explicitly stated weekday closure is retained when the email needs review", async () => {
  const event = custom("Closed Friday for maintenance. The 25mg dose is probably back.");
  const decision = await interpretEmail(event, config, async () => ({ status: "review" }));
  assert.deepEqual(decision.restrictions, [{
    pharmacyId: "WRENFOLD",
    from: Date.parse("2026-11-13T05:00:00Z"),
    until: Date.parse("2026-11-14T05:00:00Z"),
    rule: open(false),
  }]);
});

test("an indefinite closure cannot be interpreted as an opening", async () => {
  const event = custom("We're closed until further notice.");
  assert.equal((await interpretEmail(event, config, proposals(proposal("WRENFOLD", open(true))))).status, "review");
  assert.equal((await interpretEmail(event, config, proposals(proposal("WRENFOLD", open(false))))).status, "apply");
});
