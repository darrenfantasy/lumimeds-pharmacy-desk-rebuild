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
const MONTH = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/gi;
const NON_EASTERN = /\b(?:PT|PST|PDT|CT|CST|CDT|MT|MST|MDT|UTC|GMT|EST|EDT|Pacific|Central|Mountain)\b/i;
const NON_NOTICE = /\b(?:draft|hypothetical|if|unless|might|previously|cancelled|canceled|no longer|not)\b/i;
const OTHER_DATE = /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|yesterday|next week|last week)\b/i;
const IN_EFFECT = /\b(?:currently|already|in effect|since midnight|this morning|today)\b/i;
const CLOCK = String.raw`(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*([ap])\.?\s*m\.?(?![a-z])`;
const ET = String.raw`(?:\s+(?:eastern(?:\s+time)?|ET)\b)?`;
const TO = String.raw`\s+(?:to|until)\s+`;
const TONIGHT_WINDOWS = [
  new RegExp(String.raw`\b${CLOCK}${ET}\s+tonight${TO}midnight\b`, "gi"),
  new RegExp(String.raw`\btonight(?:\s+(?:at|from))?\s+${CLOCK}${ET}${TO}midnight\b`, "gi"),
];
const MORNING_WINDOWS = new RegExp(String.raw`\bmidnight${ET}${TO}${CLOCK}`, "gi");

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

function hintedDay(subject: string, clauses: string[], index: number, receiptDate: string): string | null | undefined {
  const clause = clauses[index] ?? "";
  const prior = clauses[index - 1] ?? "";
  const heading = prior.length <= 90 && !/[.!?]$/.test(prior) ? prior : "";
  const nearby = new Set(explicitDates(`${subject}\n${heading}\n${clause}`, receiptDate));
  if (nearby.size > 1) return null;
  const [day] = nearby;
  if (day) return calendarDay(day) === null ? null : day;

  // A date in another section cannot safely qualify this clock phrase.
  if (explicitDates(clauses.join("\n"), receiptDate).length > 0) return null;
  return undefined;
}

function matchedClock(match: RegExpMatchArray, date: string): number | null {
  const hour = Number(match[1]) % 12 + (match[3]?.toLowerCase() === "p" ? 12 : 0);
  const minute = match[2] ?? "00";
  const candidates = easternCandidates(date, `${String(hour).padStart(2, "0")}:${minute}:00`);
  return candidates.length === 1 ? candidates[0] ?? null : null;
}

export type MailWindow = { id: string; phrase: string; from: number; until: number };

export function resolveMailWindows(subject: string, body: string, receivedAt: number): MailWindow[] {
  const clauses = authoredLines(body).flatMap((line) => line.split(/;\s*/)).filter(Boolean);
  if (!Number.isFinite(receivedAt) || NON_EASTERN.test([subject, ...clauses].join("\n"))) return [];

  const receiptDate = easternDate(receivedAt);
  const nextDate = dateAfter(receiptDate, 1);
  const windows: MailWindow[] = [];
  for (const [index, clause] of clauses.entries()) {
    if (NON_NOTICE.test(clause)) continue;
    const day = hintedDay(subject, clauses, index, receiptDate);
    if (day === null || (day === undefined && OTHER_DATE.test(`${subject} ${clause}`))) continue;

    const evening = TONIGHT_WINDOWS.flatMap((pattern) => [...clause.matchAll(pattern)]);
    const morning = [...clause.matchAll(MORNING_WINDOWS)];
    // One authored clause should describe one interval.
    if (evening.length + morning.length !== 1) continue;

    let from: number | null;
    let until: number | null;
    if (evening[0]) {
      if (evening[0][3]?.toLowerCase() !== "p" || (day && day !== receiptDate)) continue;
      from = matchedClock(evening[0], receiptDate);
      until = easternMidnight(nextDate);
    } else if (morning[0]) {
      if (morning[0][3]?.toLowerCase() !== "a") continue;
      const isCurrent = IN_EFFECT.test(clause) || easternMidnight(receiptDate) === receivedAt;
      const midnightDate = day ?? (isCurrent ? receiptDate : nextDate);
      from = easternMidnight(midnightDate);
      until = matchedClock(morning[0], midnightDate);
    } else {
      continue;
    }

    if (from !== null && until !== null && until > from && until > receivedAt) {
      windows.push({ id: `window-${windows.length + 1}`, phrase: clause, from, until });
    }
  }
  return windows;
}
