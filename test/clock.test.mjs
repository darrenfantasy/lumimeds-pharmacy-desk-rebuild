import assert from "node:assert/strict";
import test from "node:test";
import {
  authoredLines,
  dateAfter,
  easternDate,
  easternMidnight,
  readInstant,
  readModelTime,
  resolveMailWindows,
} from "../dist/clock.js";

const instant = (value) => Date.parse(value);
const ranges = (windows) => windows.map(({ from, until }) => [from, until]);

test("events use their stated offset and reject malformed or rolled-over dates", () => {
  assert.equal(readInstant("2026-11-09T06:00:00-05:00"), instant("2026-11-09T11:00:00Z"));
  assert.equal(readInstant("2026-11-09T06:00:00.123456-05:00"), instant("2026-11-09T11:00:00.123Z"));
  assert.equal(readInstant("2026-11-09"), null);
  assert.equal(readInstant("2026-11-09T06:00:00"), null);
  assert.equal(readInstant("2026-02-30T06:00:00Z"), null);
  assert.equal(readInstant("2026-11-09T24:00:00Z"), null);
});

test("Eastern dates and midnights follow the calendar and the offset on that date", () => {
  assert.equal(easternDate(instant("2026-11-09T04:59:59Z")), "2026-11-08");
  assert.equal(easternDate(instant("2026-11-09T05:00:00Z")), "2026-11-09");
  assert.equal(dateAfter("2026-12-31", 1), "2027-01-01");
  assert.equal(easternMidnight("2026-03-08"), instant("2026-03-08T05:00:00Z"));
  assert.equal(easternMidnight("2026-03-09"), instant("2026-03-09T04:00:00Z"));
  assert.equal(easternMidnight("2026-02-29"), null);
});

test("model time corrects a stale Eastern offset and keeps an explicit repeated hour", () => {
  assert.equal(readModelTime("2026-11-02"), instant("2026-11-02T05:00:00Z"));
  assert.equal(readModelTime("2026-11-02T10:00:00-04:00"), instant("2026-11-02T15:00:00Z"));
  assert.equal(readModelTime("2026-11-02T10:00:00Z"), instant("2026-11-02T10:00:00Z"));
  assert.equal(readModelTime("2026-11-01T01:30:00-04:00"), instant("2026-11-01T05:30:00Z"));
  assert.equal(readModelTime("2026-11-01T01:30:00-05:00"), instant("2026-11-01T06:30:00Z"));
  assert.equal(readModelTime("2026-03-08T02:30:00-05:00"), null);
});

test("tonight and upcoming midnight anchor to the Eastern receipt date", () => {
  const at = instant("2026-03-09T00:03:00Z");
  const closure = "Closed from 11 p.m. Eastern tonight until midnight.";
  const preference = "Prefer Cedar for semaglutide from midnight to 12:02 a.m. Eastern.";

  assert.deepEqual(resolveMailWindows("Hours", closure, at), [{
    id: "window-1",
    phrase: closure,
    from: instant("2026-03-09T03:00:00Z"),
    until: instant("2026-03-09T04:00:00Z"),
  }]);
  assert.deepEqual(ranges(resolveMailWindows("Routing", preference, at)), [[
    instant("2026-03-09T04:00:00Z"),
    instant("2026-03-09T04:02:00Z"),
  ]]);
  assert.deepEqual(ranges(resolveMailWindows("Routing", preference, instant("2026-03-09T04:00:00Z"))), [[
    instant("2026-03-09T04:00:00Z"),
    instant("2026-03-09T04:02:00Z"),
  ]]);
});

test("explicit dates and an ongoing closure take precedence over the default next midnight", () => {
  const at = instant("2026-03-09T04:05:00Z");
  const active = "We are currently closed from midnight to 2 a.m. Eastern.";
  const scheduled = "Closed from midnight to 1 a.m. Eastern.";
  assert.deepEqual(ranges(resolveMailWindows("Hours", active, at)), [[
    instant("2026-03-09T04:00:00Z"),
    instant("2026-03-09T06:00:00Z"),
  ]]);
  for (const [subject, body] of [
    ["Hours", `2026-03-12 maintenance:\n${scheduled}`],
    ["March 12 maintenance", scheduled],
    ["Hours", `On March 12, ${scheduled}`],
  ]) {
    assert.deepEqual(ranges(resolveMailWindows(subject, body, at)), [[
      instant("2026-03-12T04:00:00Z"),
      instant("2026-03-12T05:00:00Z"),
    ]]);
  }
  assert.deepEqual(resolveMailWindows("March 12", `On March 13, ${scheduled}`, at), []);
});

test("quoted, conditional, non-Eastern, and ambiguous DST windows are left for review", () => {
  const at = instant("2026-03-07T20:00:00Z");
  const closure = "Closed from midnight to 1 a.m. Eastern.";
  assert.deepEqual(authoredLines(` Hello!\n> ${closure}\nOn Friday, Sam wrote:\n${closure}`), ["Hello!"]);
  assert.deepEqual(resolveMailWindows("Hours", `> ${closure}`, at), []);
  assert.deepEqual(resolveMailWindows("Hours", `If the count takes longer, ${closure}`, at), []);
  assert.deepEqual(resolveMailWindows("Hours", "All times are Pacific.\nClosed from midnight to 1 a.m.", at), []);
  assert.deepEqual(resolveMailWindows("Hours", "Closed from midnight to 2:30 a.m. Eastern.", at), []);
  assert.deepEqual(resolveMailWindows("Hours", "Closed from midnight to 1:30 a.m. Eastern.", instant("2026-10-31T20:00:00Z")), []);
});
