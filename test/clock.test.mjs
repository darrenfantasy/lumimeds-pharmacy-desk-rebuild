import assert from "node:assert/strict";
import test from "node:test";
import {
  authoredClauses,
  authoredLines,
  dateAfter,
  easternDate,
  easternMidnight,
  readClauseBounds,
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
  assert.deepEqual(resolveMailWindows("Hours", "Closed from midnight to 1 a.m. (PST) tomorrow.", at), []);
  assert.deepEqual(resolveMailWindows("Hours", "Closed from midnight to 1 a.m. CT tomorrow.", at), []);
  assert.deepEqual(resolveMailWindows("Hours", "Closed from midnight to 2:30 a.m. Eastern.", at), []);
  assert.deepEqual(resolveMailWindows("Hours", "Closed from midnight to 1:30 a.m. Eastern.", instant("2026-10-31T20:00:00Z")), []);
});

test("weekday and tomorrow labels bind midnight windows to the stated Eastern date", () => {
  const receipt = instant("2026-11-10T09:00:00-05:00");
  const cases = [
    ["We will be closed from midnight to 2 a.m. Eastern on Friday.", "2026-11-13"],
    ["Closed from midnight to 2 a.m. Friday.", "2026-11-13"],
    ["We are closed from midnight to 2 a.m. EST tomorrow.", "2026-11-11"],
    ["Closed from midnight to 2 a.m. Eastern today.", "2026-11-10"],
  ];
  for (const [body, date] of cases) {
    const receivedAt = body.endsWith(" today.") ? instant("2026-11-10T00:30:00-05:00") : receipt;
    assert.deepEqual(ranges(resolveMailWindows("Hours", body, receivedAt)), [[
      instant(date + "T00:00:00-05:00"),
      instant(date + "T02:00:00-05:00"),
    ]], body);
  }
});

test("same-day clock restrictions use the stated Eastern hours and receipt when already closed", () => {
  const receipt = instant("2026-11-10T09:00:00-05:00");
  const closed = "We're closed until 2 p.m. Eastern today.";
  const planned = "We're closed from 2 p.m. to 4 p.m. Eastern today.";
  assert.deepEqual(ranges(resolveMailWindows("Hours", closed, receipt)),
    [[receipt, instant("2026-11-10T14:00:00-05:00")]]);
  assert.deepEqual(ranges(resolveMailWindows("Hours", planned, receipt)),
    [[instant("2026-11-10T14:00:00-05:00"), instant("2026-11-10T16:00:00-05:00")]]);
  assert.deepEqual(ranges(resolveMailWindows("Hours", "Closed from 2 p.m. until 4 p.m. EST on Friday.", receipt)),
    [[instant("2026-11-13T14:00:00-05:00"), instant("2026-11-13T16:00:00-05:00")]]);
  assert.deepEqual(resolveMailWindows("Hours", closed, instant("2026-11-10T15:00:00-05:00")), []);
});

test("EST and EDT agree with the actual Eastern offset, including the repeated hour", () => {
  const receipt = instant("2026-10-31T21:00:00-04:00");
  const from = instant("2026-11-01T00:00:00-04:00");
  assert.deepEqual(ranges(resolveMailWindows("Hours", "Closed from midnight to 1:30 a.m. EST tomorrow.", receipt)),
    [[from, instant("2026-11-01T01:30:00-05:00")]]);
  assert.deepEqual(ranges(resolveMailWindows("Hours", "Closed from midnight to 1:30 a.m. EDT tomorrow.", receipt)),
    [[from, instant("2026-11-01T01:30:00-04:00")]]);
  assert.deepEqual(ranges(resolveMailWindows("Hours", "All times are EST.\nClosed from midnight EDT to 1:30 a.m. tomorrow.", receipt)),
    [[from, instant("2026-11-01T01:30:00-05:00")]]);
  assert.deepEqual(resolveMailWindows("Hours", "Closed from midnight to 2 a.m. EST tomorrow.",
    instant("2026-07-01T16:00:00Z")), []);
});

test("authored clauses keep timed Ops directives distinct, including CT state scope", () => {
  const receipt = instant("2026-11-10T09:00:00-05:00");
  const body = "Do not send CT semaglutide 0.25mg to ASTER from 11 p.m. tonight to midnight; "
    + "Prefer ASTER for CT semaglutide 0.25mg from midnight to 2 a.m. Eastern. Ask Sam to confirm.";
  const clauses = authoredClauses(body);
  assert.equal(clauses.length, 3);
  const windows = resolveMailWindows("Routing", body, receipt);
  assert.deepEqual(windows.map(({ id, phrase }) => [id, phrase]), [
    ["window-1", clauses[0]], ["window-2", clauses[1]],
  ]);
  assert.deepEqual(ranges(windows), [
    [instant("2026-11-10T23:00:00-05:00"), instant("2026-11-11T00:00:00-05:00")],
    [instant("2026-11-11T00:00:00-05:00"), instant("2026-11-11T02:00:00-05:00")],
  ]);
});

test("ordinary business bounds are clause-local and use exclusive Eastern end dates", () => {
  const receipt = instant("2026-11-10T09:00:00-05:00");
  const tomorrow = instant("2026-11-11T00:00:00-05:00");
  const friday = instant("2026-11-13T00:00:00-05:00");
  const saturday = instant("2026-11-14T00:00:00-05:00");
  const body = "Starting now our capacity is zero until tomorrow. Starting tomorrow we can take five orders.";
  assert.deepEqual(authoredClauses(body).map((clause) => readClauseBounds(clause, receipt)),
    [{ from: receipt, until: tomorrow }, { from: tomorrow }]);
  assert.deepEqual(readClauseBounds("We're closed on Friday for a stock count.", receipt), { from: friday, until: saturday });
  assert.deepEqual(readClauseBounds("We are closed on Friday, Nov. 20.", receipt),
    { from: instant("2026-11-20T00:00:00-05:00"), until: instant("2026-11-21T00:00:00-05:00") });
  assert.deepEqual(readClauseBounds("We are closed Friday afternoon.", receipt), {});
  assert.deepEqual(readClauseBounds("We cannot accept orders today.", receipt), { from: receipt, until: tomorrow });
  assert.deepEqual(readClauseBounds("We are closed until further notice.", receipt), { until: null });
  assert.deepEqual(readClauseBounds("We're out of tirzepatide 5mg until Wednesday.", receipt), { until: tomorrow });
  assert.deepEqual(readClauseBounds("We're out of tirzepatide 5mg through Friday.", receipt), { until: saturday });
  assert.deepEqual(readClauseBounds("Tirzepatide 5mg is back on Wednesday.", receipt), { from: tomorrow });
  assert.deepEqual(readClauseBounds("Prefer Cedar for the rest of the week.", receipt),
    { until: instant("2026-11-16T00:00:00-05:00") });
});
