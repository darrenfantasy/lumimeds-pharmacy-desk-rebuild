import { easternDate } from "./clock.js";
import {
  normalizeDose, normalizeMedication, normalizeState,
  type Change, type Config, type Order, type Pharmacy, type Rule, type Scope,
} from "./contract.js";

interface Prescription {
  state: string;
  medication: string;
  dose: string;
}

interface Fulfillment {
  open: boolean;
  inStock: boolean;
  shipsToState: boolean;
  capacity: number;
  days: number;
  cost: number;
}

interface Preference {
  pharmacy: string;
  specificity: number;
  revision: number;
}

function rankValue(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : Infinity;
}

function baseline(pharmacy: Pharmacy, request: Prescription): Fulfillment {
  return {
    open: pharmacy.open,
    inStock: Object.entries(pharmacy.stock).some(([medication, doses]) =>
      normalizeMedication(medication) === request.medication
      && doses.some((dose) => normalizeDose(dose) === request.dose)),
    shipsToState: pharmacy.blockedStates.every((name) => {
      const state = normalizeState(name);
      return state !== null && state !== request.state;
    }),
    capacity: pharmacy.dailyCapacity,
    days: rankValue(pharmacy.shipsInDays),
    cost: rankValue(Object.entries(pharmacy.price).find(([medication]) =>
      normalizeMedication(medication) === request.medication)?.[1]),
  };
}

function applyFact(facts: Fulfillment, rule: Exclude<Rule, { kind: "routing" }>, request: Prescription): void {
  switch (rule.kind) {
    case "open":
      facts.open = rule.value;
      break;
    case "stock":
      if (normalizeMedication(rule.medication) === request.medication && normalizeDose(rule.dose) === request.dose) {
        facts.inStock = rule.available;
      }
      break;
    case "shipping":
      if (normalizeState(rule.state) === request.state) facts.shipsToState = rule.allowed;
      break;
    case "capacity":
      facts.capacity = rule.value;
      break;
    case "speed":
      facts.days = rankValue(rule.value);
      break;
    case "price":
      if (normalizeMedication(rule.medication) === request.medication) facts.cost = rankValue(rule.value);
      break;
  }
}

function matchingScope(scope: Scope, request: Prescription): string[] | null {
  const qualifiers = [];
  if (scope.state !== undefined) {
    if (normalizeState(scope.state) !== request.state) return null;
    qualifiers.push("state");
  }
  if (scope.medication !== undefined) {
    if (normalizeMedication(scope.medication) !== request.medication) return null;
    qualifiers.push("medication");
  }
  if (scope.dose !== undefined) {
    if (normalizeDose(scope.dose) !== request.dose) return null;
    qualifiers.push("dose");
  }
  return qualifiers;
}

export class DispatchPlanner {
  private readonly changes: Change[] = [];
  private readonly dailyReservations = new Map<string, Map<string, number>>();

  constructor(private readonly config: Config) {}

  add(changes: readonly Change[]): void {
    this.changes.push(...changes);
  }

  select(order: Order, at: number, held?: ReadonlySet<string>): { pharmacy: string; reason: string } {
    const state = normalizeState(order.state);
    const medication = normalizeMedication(order.medication);
    const dose = normalizeDose(order.dose);
    const knownDose = Object.entries(this.config.catalogue).some(([key, doses]) =>
      normalizeMedication(key) === medication && doses.some((entry) => normalizeDose(entry) === dose));
    if (!state || !dose || !knownDose) {
      return { pharmacy: "MANUAL", reason: "Unknown destination or catalogue dose" };
    }

    const request = { state, medication, dose };
    const facts = new Map(this.config.pharmacies
      .filter((pharmacy) => !held?.has(pharmacy.id))
      .map((pharmacy) => [pharmacy.id, baseline(pharmacy, request)]));
    const blocks = new Map<string, Set<string>>();
    const preferences = new Map<string, Map<string, Preference>>();

    // Active overlays are applied in receipt order so corrections override
    // earlier facts. Temporary overlays expire at their exclusive end time.
    for (const [revision, { pharmacyId, from, until, rule }] of this.changes.entries()) {
      if (from > at || (until !== null && at >= until)) continue;
      if (rule.kind !== "routing") {
        const pharmacy = facts.get(pharmacyId);
        if (pharmacy) applyFact(pharmacy, rule, request);
        continue;
      }
      const qualifiers = matchingScope(rule.scope, request);
      if (!qualifiers) continue;
      // Every matching qualifier has the value on this order. The names
      // therefore identify an exact scope for this particular decision.
      const key = qualifiers.join(",");
      switch (rule.action) {
        case "prefer": {
          const scoped = preferences.get(key) ?? new Map<string, Preference>();
          scoped.set(pharmacyId, { pharmacy: pharmacyId, specificity: qualifiers.length, revision });
          preferences.set(key, scoped);
          break;
        }
        case "clear-prefer":
          preferences.get(key)?.delete(pharmacyId);
          break;
        case "block": {
          const scoped = blocks.get(pharmacyId) ?? new Set<string>();
          scoped.add(key);
          blocks.set(pharmacyId, scoped);
          break;
        }
        case "clear-block":
          blocks.get(pharmacyId)?.delete(key);
          break;
      }
    }

    const used = this.dailyReservations.get(easternDate(at));
    const eligible = [...facts].filter(([id, fact]) =>
      fact.open && fact.inStock && fact.shipsToState
      && Number.isSafeInteger(fact.capacity) && (used?.get(id) ?? 0) < fact.capacity
      && !blocks.get(id)?.size);
    const eligibleIds = new Set(eligible.map(([id]) => id));

    const activePreferences = [...preferences.values()].flatMap((scope) => {
      const latest = [...scope.values()].sort((a, b) => b.revision - a.revision)[0];
      return latest && eligibleIds.has(latest.pharmacy) ? [latest] : [];
    });
    const preferred = activePreferences.sort((a, b) =>
      b.specificity - a.specificity || b.revision - a.revision)[0];
    if (preferred) return { pharmacy: preferred.pharmacy, reason: "Eligible and preferred by Ops" };

    const best = eligible.sort(([idA, a], [idB, b]) =>
      a.days - b.days || a.cost - b.cost || idA.localeCompare(idB))[0];
    return best
      ? { pharmacy: best[0], reason: "Eligible with the best delivery time and price" }
      : { pharmacy: "MANUAL", reason: "No open, permitted pharmacy can ship the exact dose within today's capacity" };
  }

  reserve(pharmacy: string, at: number): void {
    if (pharmacy === "MANUAL") return;
    const date = easternDate(at);
    const reservations = this.dailyReservations.get(date) ?? new Map<string, number>();
    reservations.set(pharmacy, (reservations.get(pharmacy) ?? 0) + 1);
    this.dailyReservations.set(date, reservations);
  }

  release(pharmacy: string, at: number): void {
    const reservations = this.dailyReservations.get(easternDate(at));
    const count = reservations?.get(pharmacy) ?? 0;
    if (count <= 1) reservations?.delete(pharmacy);
    else reservations?.set(pharmacy, count - 1);
  }
}
