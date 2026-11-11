import { authoredClauses, readClauseBounds, resolveMailWindows } from "./clock.js";
import { normalizeDose, normalizeMedication, normalizeState, type Change, type Config, type EmailEvent, type Rule } from "./contract.js";

type StockRule = Extract<Rule, { kind: "stock" }>;
type StockFact = SafetyFact & { change: Change & { rule: StockRule } };
type Bounds = Pick<Change, "from" | "until">;

export interface SafetyFact {
  change: Change;
  clause: string;
  uncertain?: true;
}

const vague = /\b(?:if|unless|might|maybe|probably|possibly|hypothetical|draft|previously|yesterday|last week|in case|subject to|we expect|may (?:be|close|stop|have|restock))\b|\?\s*$/i;
const partialClosure = /\b(?:pickup|walk-ins?|in.person|front desk|lunch|closed to (?:the public|customers))\b/i;
const closed = /(?:^|:\s+)(?:(?:we(?:['’]re|['’]ll be| are| will be)|(?:our|the) pharmacy (?:is|will be))\s+(?:(?:currently|already)\s+)?)?closed\b/i;
const notOpen = /(?:^|:\s+)(?:we|(?:our|the) pharmacy)\s+(?:(?:will|are|is)\s+not|won['’]t|aren['’]t|isn['’]t)\s+(?:be\s+)?open\b/i;
const reopened = /(?:^|:\s+)(?:we\s+(?:have\s+)?reopened\b|(?:(?:we(?:['’]re| are| will be)|(?:our|the) pharmacy (?:is|has|will be))\s+(?:(?:now|already)\s+)?(?:reopened\b|back open\b|open\b(?=\s*(?:now|again|today|tomorrow|for (?:business|fulfillment|orders)|from|[,.!?;]|$)))))/i;
const dosePattern = /(?:\d+(?:\.\d+)?|\.\d+)\s*mg\b/gi;
const unavailable = /\b(?:out of stock|unavailable|no stock|sold out|on backorder|we(?:['’]re| are) out of)\b|\b(?:out of|(?:don['’]t|do not|no longer) have)\s+(?:the\s+)?(?:[a-z][\w-]*\s+)?(?=\d|\.\d)/i;
const available = /\b(?:restocked|in stock|is fine|available|(?:is|are|will be) back)\b/i;
const negatedAvailability = /\b(?:not|no longer)\s+(?:(?:currently|presently|yet)\s+)?(?:in stock|available|restocked|back)\b/i;
const negatedShortage = /\b(?:not|no longer)\s+(?:(?:currently|presently|yet)\s+)?(?:out of stock|unavailable|on backorder)\b/i;
const restoration = /\bback(?: in stock)?(?: on)?\s+(today|tomorrow|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/i;
const calendarWords = "today|tomorrow|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday";
const dayOnly = new RegExp(`\\b(${calendarWords})\\b(?=\\s*(?:[,.!?;]|$))`, "i");
const calendarCue = new RegExp(`\\b(?:${calendarWords}|next week|this weekend|\\d{4}-\\d{2}-\\d{2})\\b`, "i");
const startCue = new RegExp(`\\b(?:from|starting|effective|beginning)\\s+(?:on\\s+)?(?:${calendarWords}|next|later|on|this|\\d{1,4})\\b`, "i");
const bareClockWithDay = new RegExp(`\\bat\\s+\\d{1,2}\\s+(?:on\\s+)?(?:${calendarWords})\\b`, "i");
const stockTarget = String.raw`(?:the\s+)?(?:[\w-]+\s+)?(?:\d+(?:\.\d+)?|\.\d+)\s*mg\b`;
const stockPredicate = String.raw`\s*(?:is|are|we|will|remains?|in stock|out of stock|unavailable|available|restocked)\b`;
const stockAction = String.raw`(?:(?:we\s+)?(?:still\s+)?(?:have|restocked|are out of|will be out of)\s+)`;
const stockSeparator = new RegExp(
  String.raw`(?:,\s+|\s+(?:but|and)\s+)(?=(?:but\s+)?not\s+)`
  + String.raw`|(?:,\s+(?:and\s+)?|\s+(?:and|but|while)\s+)(?=(?:${stockTarget}${stockPredicate}|${stockAction}${stockTarget}))`,
  "i",
);

function literal(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function medicationPattern(name: string): string {
  const medication = normalizeMedication(name);
  const aliases = medication === "semaglutide" ? "|sema" : medication === "tirzepatide" ? "|tirz" : "";
  return `\\b(?:${literal(medication)}${aliases})\\b`;
}

function stockRules(clause: string, catalogue: Config["catalogue"]): StockRule[] {
  const out = (unavailable.test(clause) || negatedAvailability.test(clause)) && !negatedShortage.test(clause);
  const inStock = available.test(clause) && !negatedAvailability.test(clause);
  if (!out && !inStock) return [];

  const drugs = Object.entries(catalogue).map(([medication, doses]) => ({
    medication: normalizeMedication(medication), doses, pattern: medicationPattern(medication),
  }));
  const named = drugs.filter(({ pattern }) => new RegExp(pattern, "i").test(clause));
  const rules: StockRule[] = [];
  const seen = new Set<string>();
  for (const mention of clause.matchAll(dosePattern)) {
    const dose = normalizeDose(mention[0]);
    if (!dose) continue;
    const beforeDose = clause.slice(0, mention.index);
    const afterDose = clause.slice(mention.index + mention[0].length);
    const candidates = named.length > 1 ? named.filter(({ pattern }) =>
      new RegExp(`${pattern}\\s*$`, "i").test(beforeDose)
      || new RegExp(`^\\s*(?:of\\s+)?${pattern}`, "i").test(afterDose)) : named.length === 1 ? named : drugs;
    const matches = candidates.filter(({ doses }) => doses.some((entry) => normalizeDose(entry) === dose));
    if (matches.length !== 1 || !matches[0]) continue;
    const { medication } = matches[0];
    const key = JSON.stringify([medication, dose]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (out) rules.push({ kind: "stock", medication, dose, available: false });
    if (inStock) rules.push({ kind: "stock", medication, dose, available: true });
  }
  return rules;
}

function statePrefix(text: string): { state: string; length: number } | null {
  const dc = /^Washington(?:,\s*|\s+)D\.?C\.?\b/i.exec(text);
  if (dc) return { state: "DC", length: dc[0].length };
  const words = /^[A-Za-z]+(?:\s+[A-Za-z]+){0,3}/.exec(text)?.[0];
  if (!words) return null;
  const parts = [...words.matchAll(/[A-Za-z]+/g)];
  for (const part of parts.reverse()) {
    const length = part.index + part[0].length;
    const phrase = words.slice(0, length);
    if (phrase.length === 2 && phrase !== phrase.toUpperCase()) continue;
    const state = normalizeState(phrase);
    if (state) return { state, length };
  }
  return null;
}

function shippingRules(clause: string): Rule[] {
  const blocked = /\b(?:can(?:not|['’]t)|(?:will|can|do|does)\s+(?:not|no longer)|(?:won|don|doesn)['’]t|no longer|stop(?:ped|ping)?|paus(?:e|ed|ing)|suspend(?:ed|ing)?)\s+(?:ship(?:ping)?|deliver(?:ing)?|send(?:ing)?|serv(?:e|ing)|do)\s+(?:to\s+)?/i.exec(clause);
  const allowed = /\b(?:can|will|now|(?:have\s+)?resum(?:e|ed|ing))\s+(?:now\s+)?(?:ship(?:ping)?|deliver(?:ing)?|serv(?:e|ing))\s+(?:again\s+)?(?:to\s+)?/i.exec(clause);
  const action = blocked ?? allowed;
  if (!action || /\b(?:except|outside|excluding|only if)\b/i.test(clause)) return [];
  const rules: Rule[] = [];
  let locations = clause.slice(action.index + action[0].length);
  let match = statePrefix(locations);
  while (match) {
    rules.push({ kind: "shipping", state: match.state, allowed: !blocked });
    const tail = locations.slice(match.length);
    const separator = /^(?:\s*,\s*(?:and\s+|but\s+(?=not\b))?|\s+(?:and|or)\s+|\s+but\s+(?=not\b)|\s*&\s*)/i.exec(tail);
    if (!separator) break;
    locations = tail.slice(separator[0].length);
    const negation = /^not\s+/i.exec(locations);
    if (negation && !blocked) {
      const excluded = statePrefix(locations.slice(negation[0].length));
      if (excluded) rules.push({ kind: "shipping", state: excluded.state, allowed: false });
      break;
    }
    match = statePrefix(locations);
  }
  return rules;
}

const numbers = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];
const quantity = `(\\d+|${numbers.join("|")})`;
const capacityPatterns = [
  new RegExp(`\\b(?:daily capacity|daily cap|capacity per day)\\s+(?:is|will be|to|of|at)\\s+(?:now |down to )?${quantity}\\b(?!\\.\\d)`, "i"),
  new RegExp(`\\b(?:only (?:take|accept|handle|fill)|up to|no more than|maximum of|(?:limited|capped) (?:to|at))\\s+${quantity}\\s+orders?\\b`, "i"),
  new RegExp(`\\b(?:can|will) (?:now )?(?:take|accept|handle|fill)\\s+${quantity}\\s+orders?\\s+(?:a day|per day|daily|today|tomorrow)\\b`, "i"),
];

function capacityRule(clause: string): Rule | null {
  if (/\b(?:no orders|(?:can(?:not|['’]t)|(?:will|do) not|won['’]t)\s+(?:take|accept|handle|fill)\s+(?:any\s+)?orders)\s+(?:today|tomorrow|until|at all)\b/i.test(clause)) {
    return { kind: "capacity", value: 0 };
  }
  for (const pattern of capacityPatterns) {
    const raw = pattern.exec(clause)?.[1]?.toLowerCase();
    if (!raw) continue;
    const value = /^\d+$/.test(raw) ? Number(raw) : numbers.indexOf(raw);
    if (Number.isSafeInteger(value) && value >= 0) return { kind: "capacity", value };
  }
  return null;
}

function closureRule(clause: string): Rule | null {
  if (partialClosure.test(clause)) return null;
  if (closed.test(clause) || notOpen.test(clause)) return { kind: "open", value: false };
  return reopened.test(clause) ? { kind: "open", value: true } : null;
}

function readBounds(clause: string, now: number, window?: Bounds, restock = false): Bounds | null {
  if (window) return { from: Math.max(window.from, now), until: window.until };
  if (/\b(?:midnight|noon|tonight|this (?:morning|afternoon|evening)|later today)\b|\d\s*(?::[0-5]\d\s*)?[ap]\.?\s*m\b|\b\d{1,2}:[0-5]\d\b/i.test(clause)
    || bareClockWithDay.test(clause) || /\b(?:every|each)\s+(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/i.test(clause)) return null;
  const returns = restoration.exec(clause);
  const timing = returns && !restock ? clause.slice(0, returns.index) : clause;
  let stated = readClauseBounds(timing, now);
  if (stated.from === undefined && stated.until === undefined) {
    const day = dayOnly.exec(timing)?.[1];
    if (day) stated = readClauseBounds(`closed ${day}`, now);
    else if (calendarCue.test(timing) || /\b(?:we will be open|we['’]ll be open)\b/i.test(timing)) return null;
  }
  const from = stated.from;
  const until = stated.until ?? null;
  if (from === undefined && startCue.test(timing)) return null;
  if (stated.until === undefined && /\b(?:until|through)\b/i.test(clause)) return null;
  const start = Math.max(from ?? now, now);
  return until === null || until > start ? { from: start, until } : null;
}

function mergeStock(facts: StockFact[]): SafetyFact[] {
  const scoped = new Map<string, StockFact[]>();
  for (const fact of facts) {
    const { medication, dose } = fact.change.rule;
    const key = JSON.stringify([medication, dose]);
    const sameDose = scoped.get(key) ?? [];
    sameDose.push(fact);
    scoped.set(key, sameDose);
  }
  const merged: SafetyFact[] = [];
  for (const sameDose of scoped.values()) {
    sameDose.sort((a, b) => a.change.from - b.change.from);
    const positives = sameDose.filter(({ change }) => change.rule.available);
    const negatives = sameDose.filter(({ change }) => !change.rule.available);
    const disputed = new Set<StockFact>();
    for (const shortage of negatives) {
      for (const supply of positives) {
        const out = shortage.change;
        const stocked = supply.change;
        if (out.until === null && stocked.from > out.from) out.until = stocked.from;
        if (stocked.until === null && out.from > stocked.from) stocked.until = out.from;
        const start = Math.max(out.from, stocked.from);
        const end = Math.min(out.until ?? Infinity, stocked.until ?? Infinity);
        if (start >= end) continue;
        disputed.add(shortage);
        disputed.add(supply);
        merged.push({
          clause: `${shortage.clause}\n${supply.clause}`,
          change: { ...out, from: start, until: Number.isFinite(end) ? end : null },
          uncertain: true,
        });
      }
    }
    for (const fact of sameDose) {
      if (!disputed.has(fact)) merged.push(fact);
      else if (!fact.change.rule.available) {
        // Preserve the shortage outside of any uncertain overlap too.
        const overlap = merged.filter(({ uncertain, change }) => uncertain
          && change.rule.kind === "stock" && change.rule.medication === fact.change.rule.medication
          && change.rule.dose === fact.change.rule.dose);
        if (overlap.some(({ change }) => change.from > fact.change.from || (change.until ?? Infinity) < (fact.change.until ?? Infinity))) {
          merged.push(fact);
        }
      }
    }
  }
  return merged;
}

export function collectSafetyEvidence(email: EmailEvent["email"], pharmacyId: string, config: Config, now: number): SafetyFact[] {
  const clauses = authoredClauses(email.body);
  const windows = resolveMailWindows(email.subject, email.body, now);
  const facts: SafetyFact[] = [];
  const stock: StockFact[] = [];
  for (const [index, clause] of clauses.entries()) {
    const preceding = clauses[index - 1] ?? "";
    if (vague.test(clause) || (/[:,]\s*$/.test(preceding) && vague.test(preceding))) continue;
    const window = windows.find(({ phrase }) => phrase === clause);
    const bounds = readBounds(clause, now, window);
    if (bounds) {
      const rules = [...shippingRules(clause), capacityRule(clause), closureRule(clause)];
      for (const rule of rules) {
        if (rule) facts.push({ clause, change: { pharmacyId, ...bounds, rule } });
      }
    }
    const stockClauses = clause.split(stockSeparator);
    for (const statement of stockClauses) {
      if (/^(?:but\s+)?not\b/i.test(statement)) continue;
      for (const rule of stockRules(statement, config.catalogue)) {
        const stockBounds = readBounds(statement, now, stockClauses.length === 1 ? window : undefined, rule.available);
        if (stockBounds) stock.push({ clause: statement, change: { pharmacyId, ...stockBounds, rule } });
      }
    }
  }
  return [...facts, ...mergeStock(stock)];
}
