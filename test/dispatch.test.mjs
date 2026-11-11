import assert from "node:assert/strict";
import test from "node:test";
import { DispatchPlanner } from "../dist/dispatch.js";

const morning = Date.parse("2026-11-09T09:00:00-05:00");
const order = { order_id: "demo", state: "TX", medication: "tirzepatide", dose: "5mg" };

function pharmacy(id, overrides = {}) {
  return {
    id,
    name: id,
    contacts: [],
    open: true,
    shipsInDays: 1,
    dailyCapacity: 4,
    price: { tirzepatide: 150 },
    blockedStates: [],
    stock: { tirzepatide: ["5mg", "7.5mg"] },
    ...overrides,
  };
}

function planner(...pharmacies) {
  return new DispatchPlanner({
    catalogue: { tirzepatide: ["5mg", "7.5mg"] },
    lumimedsOps: [],
    pharmacies,
  });
}

function rule(pharmacyId, action, scope, from = morning, until = null) {
  return { pharmacyId, from, until, rule: { kind: "routing", action, scope } };
}

test("physical eligibility beats Ops preference and price breaks a tie in shipping time", () => {
  const desk = planner(
    pharmacy("no-shipping", { blockedStates: ["Texas"], price: { tirzepatide: 1 } }),
    pharmacy("closed", { open: false, price: { tirzepatide: 1 } }),
    pharmacy("wrong-dose", { stock: { tirzepatide: ["7.5mg"] }, price: { tirzepatide: 1 } }),
    pharmacy("full", { dailyCapacity: 0, price: { tirzepatide: 1 } }),
    pharmacy("fast-expensive", { price: { tirzepatide: 175 } }),
    pharmacy("fast-cheaper", { price: { tirzepatide: 100 } }),
    pharmacy("slow-cheapest", { shipsInDays: 3, price: { tirzepatide: 1 } }),
  );
  desk.add([rule("no-shipping", "prefer", { state: "TX" })]);

  assert.equal(desk.select(order, morning).pharmacy, "fast-cheaper");
  assert.equal(desk.select(order, morning, new Set(["fast-cheaper"])).pharmacy, "fast-expensive");
  assert.equal(desk.select({ ...order, dose: "5.1mg" }, morning).pharmacy, "MANUAL");
});

test("reservations use the Eastern calendar day and releases cannot make capacity negative", () => {
  const desk = planner(pharmacy("only", { dailyCapacity: 1 }));
  const beforeMidnight = Date.parse("2026-11-10T04:59:59Z");
  const afterMidnight = Date.parse("2026-11-10T05:00:00Z");

  desk.reserve("only", beforeMidnight);
  assert.equal(desk.select(order, beforeMidnight).pharmacy, "MANUAL");
  assert.equal(desk.select(order, afterMidnight).pharmacy, "only");
  desk.release("only", beforeMidnight);
  desk.release("only", beforeMidnight);
  desk.reserve("only", beforeMidnight);
  assert.equal(desk.select(order, beforeMidnight).pharmacy, "MANUAL");
});

test("a later stock correction changes the exact dose until its exclusive end time", () => {
  const desk = planner(pharmacy("primary"), pharmacy("backup", { shipsInDays: 3 }));
  const correction = Date.parse("2026-11-09T16:00:00-05:00");
  const restock = Date.parse("2026-11-11T00:00:00-05:00");
  desk.add([{
    pharmacyId: "primary", from: morning, until: restock,
    rule: { kind: "stock", medication: "tirzepatide", dose: "5mg", available: false },
  }]);
  assert.equal(desk.select(order, morning).pharmacy, "backup");
  desk.add([
    {
      pharmacyId: "primary", from: correction, until: null,
      rule: { kind: "stock", medication: "tirzepatide", dose: "5mg", available: true },
    },
    {
      pharmacyId: "primary", from: correction, until: restock,
      rule: { kind: "stock", medication: "tirzepatide", dose: "7.5mg", available: false },
    },
  ]);

  assert.equal(desk.select(order, correction).pharmacy, "primary");
  assert.equal(desk.select({ ...order, dose: "7.5mg" }, restock - 1).pharmacy, "backup");
  assert.equal(desk.select({ ...order, dose: "7.5mg" }, restock).pharmacy, "primary");
});

test("exact-scope clears preserve other active rules and restore prior preferences", () => {
  const desk = planner(
    pharmacy("fastest"),
    pharmacy("general", { shipsInDays: 2 }),
    pharmacy("temporary", { shipsInDays: 3 }),
  );
  const scope = { state: "TX" };
  const temporaryEnd = morning + 3_600_000;
  desk.add([
    rule("general", "prefer", scope),
    rule("temporary", "prefer", scope, morning, temporaryEnd),
  ]);
  assert.equal(desk.select(order, morning).pharmacy, "temporary");
  assert.equal(desk.select(order, temporaryEnd).pharmacy, "general");

  desk.add([
    rule("temporary", "block", scope),
    rule("temporary", "clear-block", { ...scope, dose: "5mg" }),
  ]);
  assert.equal(desk.select(order, morning).pharmacy, "fastest");
  desk.add([rule("temporary", "clear-block", scope)]);
  assert.equal(desk.select(order, morning).pharmacy, "temporary");
  desk.add([rule("temporary", "clear-prefer", scope)]);
  assert.equal(desk.select(order, morning).pharmacy, "general");
});

test("an older change redelivered late cannot override a newer correction", () => {
  const desk = planner(pharmacy("primary"), pharmacy("backup", { shipsInDays: 3 }));
  const correction = morning + 3_600_000;
  const change = (from, value) => ({
    pharmacyId: "primary", from, until: null, rule: { kind: "open", value },
  });
  desk.add([change(correction, false)], correction);
  desk.add([change(morning, true)], morning);

  assert.equal(desk.select(order, morning).pharmacy, "primary");
  assert.equal(desk.select(order, correction).pharmacy, "backup");
});
