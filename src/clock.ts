const DAY = 86_400_000;
const HOUR = 3_600_000;
const EASTERN = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?)(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function calendarDay(date: string): number | null {
  if (!DATE.test(date)) return null;
  const stamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === date ? stamp : null;
}

export function readInstant(value: string): number | null {
  const match = INSTANT.exec(value);
  if (!match?.[1] || calendarDay(match[1]) === null) return null;
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) ? stamp : null;
}

function easternParts(at: number): { date: string; clock: string } {
  const parts = Object.fromEntries(EASTERN.formatToParts(at).map(({ type, value }) => [type, value]));
  return {
    date: `${parts.year?.padStart(4, "0")}-${parts.month}-${parts.day}`,
    clock: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

export function easternDate(at: number): string {
  return easternParts(at).date;
}

export function dateAfter(date: string, days: number): string {
  const start = calendarDay(date);
  if (start === null) throw new RangeError("Invalid calendar day");
  return new Date(start + days * DAY).toISOString().slice(0, 10);
}

function easternWallSecond(at: number): number {
  const local = easternParts(at);
  return Date.parse(`${local.date}T${local.clock}Z`);
}

function easternCandidates(date: string, clock: string): number[] {
  if (calendarDay(date) === null) return [];
  const wall = Date.parse(`${date}T${clock}Z`);
  if (!Number.isFinite(wall)) return [];

  const wallSecond = Math.floor(wall / 1_000) * 1_000;
  // Sample both sides of an offset transition. Round-trip to distinguish
  // a repeated local hour from a skipped local hour.
  const offsets = new Set([-12, 0, 12].map((hours) => {
    const sample = wallSecond + hours * HOUR;
    return easternWallSecond(sample) - sample;
  }));
  return [...offsets].map((offset) => wall - offset)
    .filter((at) => easternWallSecond(at) === wallSecond);
}

export function easternMidnight(date: string): number | null {
  const candidates = easternCandidates(date, "00:00:00");
  return candidates.length === 1 ? candidates[0] ?? null : null;
}

export function readModelTime(value: string): number | null {
  if (DATE.test(value)) return easternMidnight(value);
  const instant = readInstant(value);
  const match = INSTANT.exec(value);
  if (instant === null || !match?.[1] || !match[2]) return null;
  if (match[3] !== "-04:00" && match[3] !== "-05:00") return instant;

  // A model writing an Eastern clock time can carry the prior day's offset
  // across DST. Keep an explicit offset that disambiguates a repeated hour.
  const candidates = easternCandidates(match[1], match[2]);
  if (candidates.includes(instant)) return instant;
  return candidates.length === 1 ? candidates[0] ?? null : null;
}

export function authoredLines(body: string): string[] {
  const lines: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(?:On .+ wrote:|[- ]*(?:Original|Forwarded) Message[- :]*|Begin forwarded message:)$/i.test(line)) break;
    if (line && !line.startsWith(">")) lines.push(line);
  }
  return lines;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_WORD = ["today", "tomorrow", ...WEEKDAYS].join("|");
const MONTH_NAME = String.raw`Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?`;
const ABSOLUTE_DAY = String.raw`(?:\d{4}-\d{2}-\d{2}|(?:${MONTH_NAME})\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)`;
const WRITTEN_DAY = String.raw`(?:(?:(?:${WEEKDAYS.join("|")}),?\s+)?${ABSOLUTE_DAY}|${DAY_WORD})`;
const MONTH = new RegExp(String.raw`\b(${MONTH_NAME})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b`, "gi");
const NON_EASTERN = /\b(?:PT|PST|PDT|CST|CDT|MST|MDT|UTC|GMT|Pacific|Central|Mountain)\b|\b(?:midnight|[ap]\.?\s*m\.?|time(?:s)?(?:\s+(?:are|in|are in))?)\s+\(?(?:CT|MT)\b/i;
const NON_NOTICE = /\b(?:draft|hypothetical|if|unless|might|previously|cancelled|canceled)\b|\b(?:not|no longer)\s+(?:closed|closing)\b/i;
const OTHER_DATE = /\b(?:yesterday|(?:next|last) (?:week|sunday|monday|tuesday|wednesday|thursday|friday|saturday))\b/i;
const IN_EFFECT = /\b(?:currently|already|in effect|since midnight|this morning|today)\b/i;
const CLOCK = String.raw`(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*([ap])\.?\s*m\.?(?![a-z])`;
const ZONE = String.raw`(?:\s+\(?(eastern(?:\s+(?:standard|daylight))?(?:\s+time)?|ET|EST|EDT)\b\)?)?`;
const TO = String.raw`\s+(?:to|until)\s+`;
const TONIGHT_WINDOWS = [
  new RegExp(String.raw`\b${CLOCK}${ZONE}\s+tonight${TO}midnight\b${ZONE}`, "gi"),
  new RegExp(String.raw`\btonight(?:\s+(?:at|from))?\s+${CLOCK}${ZONE}${TO}midnight\b${ZONE}`, "gi"),
];
const MORNING_WINDOWS = new RegExp(String.raw`\bmidnight\b${ZONE}${TO}${CLOCK}${ZONE}`, "gi");
const CLOCK_RANGES = new RegExp(String.raw`\bfrom\s+${CLOCK}${ZONE}${TO}${CLOCK}${ZONE}`, "gi");
const CLOSED_UNTIL_CLOCK = new RegExp(String.raw`\bclosed\s+until\s+${CLOCK}${ZONE}`, "gi");
const TIME_CONTINUATION = new RegExp(String.raw`^\s+\(?(?:\d|(?:eastern|ET|EST|EDT|PT|PST|PDT|CT|CST|CDT|MT|MST|MDT|UTC|GMT|Pacific|Central|Mountain|tonight|on|to|until|${DAY_WORD})\b)`, "i");

export function authoredClauses(body: string): string[] {
  const clauses: string[] = [];
  for (const line of authoredLines(body)) {
    let start = 0;
    for (let index = 0; index < line.length; index++) {
      const character = line[index];
      if (character !== ";" && character !== "." && character !== "?" && character !== "!") continue;
      const rest = line.slice(index + 1);
      if (character !== ";" && /^\S/.test(rest)) continue;
      if (character === "." && /\b(?:[ap]\.\s*m|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)$/i.test(line.slice(start, index))
        && TIME_CONTINUATION.test(rest)) continue;
      const clause = line.slice(start, index + (character === ";" ? 0 : 1)).trim();
      if (clause) clauses.push(clause);
      start = index + 1;
    }
    const tail = line.slice(start).trim();
    if (tail) clauses.push(tail);
  }
  return clauses;
}

function explicitDates(text: string, receiptDate: string): string[] {
  const dates = [...text.matchAll(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g)].map(([date]) => date);
  for (const [, month, day, writtenYear] of text.matchAll(MONTH)) {
    const index = MONTHS.indexOf(month?.slice(0, 3).toLowerCase() ?? "");
    if (index < 0 || !day) continue;
    const year = writtenYear ?? receiptDate.slice(0, 4);
    dates.push(`${year}-${String(index + 1).padStart(2, "0")}-${day.padStart(2, "0")}`);
  }
  return dates;
}

function dayOfWeek(date: string): number {
  return new Date(calendarDay(date) ?? NaN).getUTCDay();
}

function dayNamed(day: string, receiptDate: string, futureOnSameWeekday = false): string | undefined {
  const word = day.toLowerCase();
  if (word === "today") return receiptDate;
  if (word === "tomorrow") return dateAfter(receiptDate, 1);
  const weekday = WEEKDAYS.indexOf(word);
  if (weekday === -1) {
    const [date] = explicitDates(day, receiptDate);
    if (!date || calendarDay(date) === null) return undefined;
    const statedWeekday = WEEKDAYS.indexOf(word.split(/[,\s]+/)[0] ?? "");
    return statedWeekday === -1 || statedWeekday === dayOfWeek(date) ? date : undefined;
  }
  const offset = (weekday - dayOfWeek(receiptDate) + 7) % 7;
  return dateAfter(receiptDate, offset || (futureOnSameWeekday ? 7 : 0));
}

type ClauseBounds = { from?: number; until?: number | null };
const START_DAY = new RegExp(String.raw`\b(?:from|starting(?:\s+on)?|effective(?:\s+on)?|beginning(?:\s+on)?|(?:back(?:\s+in\s+stock)?|reopens?)(?:\s+on)?)\s+(${WRITTEN_DAY})\b(?!\s+(?:at|morning|afternoon|evening|night)\b)`, "gi");
const END_DAY = new RegExp(String.raw`\b(until|through)\s+(${WRITTEN_DAY})\b(?!\s+(?:at|morning|afternoon|evening|night)\b)`, "gi");
const CLOSED_DAY = new RegExp(String.raw`\b(?:closed|(?:not|won['’]t)\s+(?:be\s+)?open)\s+(?:on\s+)?(${WRITTEN_DAY})\b(?=\s*(?:for\b|[,.!?;]|$))(?!\s*,?\s*(?:from|through|until|after|before|only)\b)`, "i");
const DAILY_RESTRICTION = /\b(?:cannot|can['’]t|no (?:more )?orders|out of stock|unavailable)\b.*\b(today|tomorrow)\b(?=\s*(?:for\b|[,.!?;]|$))(?!\s*,?\s*(?:from|through|until|after|before|only)\b)/i;
const CLOSED_TODAY_AND_TOMORROW = /\b(?:closed|(?:not|won['’]t)\s+(?:be\s+)?open)\s+today\s+(?:and|through|&)\s+tomorrow\b(?=\s*(?:for\b|[,.!?;]|$))/i;

export function readClauseBounds(clause: string, now: number): ClauseBounds {
  if (!Number.isFinite(now)) return {};
  const receiptDate = easternDate(now);
  const starts = new Set<number>();
  const ends = new Set<number | null>();
  const midnight = (date: string | undefined, days = 0) => date ? easternMidnight(dateAfter(date, days)) : null;

  if (/\b(?:effective\s+immediately|starting\s+now|from\s+now\s+on)\b/i.test(clause)) starts.add(now);
  for (const [, word] of clause.matchAll(START_DAY)) {
    const start = midnight(dayNamed(word!, receiptDate));
    if (start !== null) starts.add(Math.max(start, now));
  }
  for (const [, boundary, word] of clause.matchAll(END_DAY)) {
    const inclusive = boundary?.toLowerCase() === "through";
    const end = midnight(dayNamed(word!, receiptDate, !inclusive), inclusive ? 1 : 0);
    if (end !== null) ends.add(end);
  }
  if (/\buntil\s+further\s+notice\b/i.test(clause)) ends.add(null);
  if (/\b(?:for\s+)?(?:the\s+)?rest\s+of\s+(?:the\s+|this\s+)?week\b/i.test(clause)) {
    const end = midnight(dayNamed("monday", receiptDate, true));
    if (end !== null) ends.add(end);
  }

  if (CLOSED_TODAY_AND_TOMORROW.test(clause)) {
    const end = midnight(receiptDate, 2);
    if (end !== null) return { from: now, until: end };
  }
  const wholeDay = CLOSED_DAY.exec(clause)?.[1] ?? DAILY_RESTRICTION.exec(clause)?.[1];
  if (wholeDay && starts.size === 0 && ends.size === 0) {
    const date = dayNamed(wholeDay, receiptDate);
    const start = midnight(date);
    const end = midnight(date, 1);
    if (start !== null && end !== null && now < end) {
      starts.add(Math.max(now, start));
      ends.add(end);
    }
  }
  return {
    ...(starts.size === 1 ? { from: [...starts][0]! } : {}),
    ...(ends.size === 1 ? { until: [...ends][0]! } : {}),
  };
}

function hintedDay(subject: string, clauses: string[], index: number, receiptDate: string): string | null | undefined {
  const clause = clauses[index] ?? "";
  const prior = clauses[index - 1] ?? "";
  const heading = prior.length <= 90 && /:$/.test(prior) ? prior : "";
  const context = `${subject}\n${heading}\n${clause}`;
  const nearby = new Set(explicitDates(context, receiptDate));
  if (nearby.size > 1) return null;
  const [day] = nearby;
  const names = [...context.matchAll(new RegExp(String.raw`\b(${DAY_WORD})\b`, "gi"))].map((match) => match[1]!.toLowerCase());
  if (OTHER_DATE.test(context)) return null;
  if (day) {
    if (calendarDay(day) === null) return null;
    const contradictory = names.some((word) => word === "today" || word === "tomorrow"
      ? dayNamed(word, receiptDate) !== day
      : WEEKDAYS.indexOf(word) !== dayOfWeek(day));
    return contradictory ? null : day;
  }
  const days = new Set(names.map((name) => dayNamed(name, receiptDate)));
  if (days.size > 1) return null;
  if (days.size === 1) return [...days][0];

  // A date in another section cannot safely qualify this clock phrase.
  if (explicitDates(clauses.join("\n"), receiptDate).length > 0) return null;
  return undefined;
}

function offsetOf(zone?: string): number | undefined {
  if (zone && /\b(?:EST|eastern\s+standard)\b/i.test(zone)) return -5 * HOUR;
  if (zone && /\b(?:EDT|eastern\s+daylight)\b/i.test(zone)) return -4 * HOUR;
  return undefined;
}

function clockOn(date: string, hourText: string, minute = "00", half = "a", offset?: number): number | null {
  const hour = Number(hourText) % 12 + (half.toLowerCase() === "p" ? 12 : 0);
  const candidates = easternCandidates(date, `${String(hour).padStart(2, "0")}:${minute}:00`)
    .filter((instant) => offset === undefined || easternWallSecond(instant) - instant === offset);
  return candidates.length === 1 ? candidates[0] ?? null : null;
}

export type MailWindow = { id: string; phrase: string; from: number; until: number };

export function resolveMailWindows(subject: string, body: string, receivedAt: number): MailWindow[] {
  const clauses = authoredClauses(body);
  const timeNotes = [subject, ...clauses.filter((clause) => /\b(?:all\s+times?|times?\s+(?:are|in))\b/i.test(clause) && !/\bmidnight\b/i.test(clause))];
  if (!Number.isFinite(receivedAt) || timeNotes.some((note) => NON_EASTERN.test(note))) return [];
  const offsets = new Set(timeNotes.map(offsetOf).filter((offset) => offset !== undefined));
  if (offsets.size > 1) return [];
  const [globalZone] = offsets;

  const receiptDate = easternDate(receivedAt);
  const nextDate = dateAfter(receiptDate, 1);
  const windows: MailWindow[] = [];
  for (const [index, clause] of clauses.entries()) {
    const previous = clauses[index - 1] ?? "";
    if (NON_NOTICE.test(clause) || NON_EASTERN.test(clause) || (/:$/.test(previous) && NON_EASTERN.test(previous))) continue;
    const day = hintedDay(subject, clauses, index, receiptDate);
    if (day === null) continue;

    const evening = TONIGHT_WINDOWS.flatMap((pattern) => [...clause.matchAll(pattern)]);
    const morning = [...clause.matchAll(MORNING_WINDOWS)];
    const daytime = [...clause.matchAll(CLOCK_RANGES)];
    const closedUntil = [...clause.matchAll(CLOSED_UNTIL_CLOCK)];
    // One authored clause should describe one interval.
    if (evening.length + morning.length + daytime.length + closedUntil.length !== 1) continue;

    let from: number | null;
    let until: number | null;
    if (evening[0]) {
      const [, hour, minute, half, startZone, endZone] = evening[0];
      if (!hour || half?.toLowerCase() !== "p" || (day && day !== receiptDate)) continue;
      from = clockOn(receiptDate, hour, minute, half, offsetOf(startZone) ?? globalZone);
      until = clockOn(nextDate, "0", "00", "a", offsetOf(endZone) ?? globalZone);
    } else if (morning[0]) {
      const [, startZone, hour, minute, half, endZone] = morning[0];
      if (!hour || !half) continue;
      const isCurrent = IN_EFFECT.test(clause) || easternMidnight(receiptDate) === receivedAt;
      const midnightDate = day ?? (isCurrent ? receiptDate : nextDate);
      from = clockOn(midnightDate, "0", "00", "a", offsetOf(startZone) ?? globalZone);
      until = clockOn(midnightDate, hour, minute, half, offsetOf(endZone) ?? globalZone);
    } else if (daytime[0]) {
      const [, startHour, startMinute, startHalf, startZone, endHour, endMinute, endHalf, endZone] = daytime[0];
      if (!startHour || !startHalf || !endHour || !endHalf) continue;
      const date = day ?? receiptDate;
      from = clockOn(date, startHour, startMinute, startHalf, offsetOf(startZone) ?? globalZone);
      until = clockOn(date, endHour, endMinute, endHalf, offsetOf(endZone) ?? globalZone);
    } else if (closedUntil[0]) {
      const [, hour, minute, half, zone] = closedUntil[0];
      if (!hour || !half) continue;
      from = receivedAt;
      until = clockOn(day ?? receiptDate, hour, minute, half, offsetOf(zone) ?? globalZone);
    } else {
      continue;
    }

    if (from !== null && until !== null && until > from && until > receivedAt) {
      windows.push({ id: `window-${windows.length + 1}`, phrase: clause, from, until });
    }
  }
  return windows;
}
