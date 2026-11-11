import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the supplied simulator fixture starts with configuration and has valid event timestamps", async () => {
  const fixture = await readFile(new URL("../sim/week-a.jsonl", import.meta.url), "utf8");
  const events = fixture.trim().split("\n").map(JSON.parse);

  assert.equal(events[0].type, "simulation.started");
  assert.ok(events[0].config.pharmacies.length > 0);
  assert.ok(events.some(({ type }) => type === "email"));
  assert.ok(events.some(({ type }) => type === "order"));
  assert.ok(events.every(({ event_id, occurred_at }) =>
    typeof event_id === "string" && Number.isFinite(Date.parse(occurred_at))));
});
