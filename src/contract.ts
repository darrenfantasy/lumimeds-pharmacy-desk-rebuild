import { readInstant } from "./clock.js";

export interface Pharmacy {
  id: string;
  name: string;
  contacts: string[];
  open: boolean;
  shipsInDays: number;
  dailyCapacity: number;
  price: Record<string, number>;
  blockedStates: string[];
  stock: Record<string, string[]>;
}

export interface Config {
  catalogue: Record<string, string[]>;
  lumimedsOps: string[];
  pharmacies: Pharmacy[];
}

export interface Order {
  order_id: string;
  state: string;
  medication: string;
  dose: string;
}

interface EventFields {
  event_id: string;
  occurred_at: string;
}

export interface StartEvent extends EventFields {
  type: "simulation.started";
  pharmacyApi: string;
  config: Config;
}

export interface EmailEvent extends EventFields {
  type: "email";
  email: { from: string; subject: string; body: string };
}

export interface OrderEvent extends EventFields {
  type: "order";
  order: Order;
}

export type DeskEvent = StartEvent | EmailEvent | OrderEvent;

export interface Scope {
  state?: string;
  medication?: string;
  dose?: string;
}

export type Rule =
  | { kind: "open"; value: boolean }
  | { kind: "stock"; medication: string; dose: string; available: boolean }
  | { kind: "shipping"; state: string; allowed: boolean }
  | { kind: "capacity" | "speed"; value: number }
  | { kind: "price"; medication: string; value: number }
  | { kind: "routing"; action: "prefer" | "block" | "clear-prefer" | "clear-block"; scope: Scope };

export interface Change {
  pharmacyId: string;
  from: number;
  until: number | null;
  rule: Rule;
  restriction?: "uncertain-stock" | "capacity-ceiling";
}

const states = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
  AS: "American Samoa",
  GU: "Guam",
  MP: "Northern Mariana Islands",
  PR: "Puerto Rico",
  VI: "U.S. Virgin Islands",
};

const stateLookup = new Map<string, string>();
for (const [code, name] of Object.entries(states)) {
  stateLookup.set(code.toLowerCase(), code);
  stateLookup.set(name.toLowerCase(), code);
}

export function normalizeState(value: string): string | null {
  return stateLookup.get(value.trim().toLowerCase().replace(/\s+/g, " ")) ?? null;
}

export function normalizeMedication(value: string): string {
  switch (value.trim().toLowerCase()) {
    case "sema": return "semaglutide";
    case "tirz": return "tirzepatide";
    default: return value.trim().toLowerCase();
  }
}

export function normalizeDose(value: string): string | null {
  const match = /^(\d*)(?:\.(\d+))?\s*mg$/i.exec(value.trim());
  if (!match) return null;
  const whole = (match[1] ?? "").replace(/^0+/, "") || "0";
  const fractional = (match[2] ?? "").replace(/0+$/, "");
  if (whole === "0" && !fractional) return null;
  return fractional ? `${whole}.${fractional}mg` : `${whole}mg`;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(hasText);
}

function doseTable(value: unknown): value is Record<string, string[]> {
  return isObject(value) && Object.values(value).every(strings);
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPharmacy(value: unknown): value is Pharmacy {
  return isObject(value)
    && hasText(value.id) && value.id.toUpperCase() !== "MANUAL" && hasText(value.name)
    && strings(value.contacts) && typeof value.open === "boolean"
    && nonnegative(value.shipsInDays)
    && nonnegative(value.dailyCapacity) && Number.isSafeInteger(value.dailyCapacity)
    && isObject(value.price) && Object.values(value.price).every(nonnegative)
    && strings(value.blockedStates) && doseTable(value.stock);
}

function isConfig(value: unknown): value is Config {
  if (!isObject(value) || !doseTable(value.catalogue) || !strings(value.lumimedsOps)
    || !Array.isArray(value.pharmacies) || !value.pharmacies.every(isPharmacy)) return false;
  const ids = value.pharmacies.map(({ id }) => id.trim().toUpperCase());
  return new Set(ids).size === ids.length && !ids.includes("MANUAL");
}

function httpUrl(value: unknown): value is string {
  if (!hasText(value)) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function decodeEvent(value: unknown): DeskEvent | null {
  if (!isObject(value) || !hasText(value.event_id) || !hasText(value.occurred_at)
    || readInstant(value.occurred_at) === null) return null;
  const { type, event_id, occurred_at } = value;
  const fields = { event_id, occurred_at };

  if (type === "simulation.started" && isConfig(value.config) && httpUrl(value.pharmacyApi)) {
    return { ...fields, type, config: value.config, pharmacyApi: value.pharmacyApi };
  }
  if (type === "email" && isObject(value.email)) {
    const { from, subject, body } = value.email;
    if (hasText(from) && typeof subject === "string" && typeof body === "string") {
      return { ...fields, type, email: { from, subject, body } };
    }
  }
  if (type === "order" && isObject(value.order)) {
    const { order_id, state, medication, dose } = value.order;
    if (hasText(order_id) && hasText(state) && hasText(medication) && hasText(dose)) {
      return { ...fields, type, order: { order_id, state, medication, dose } };
    }
  }
  return null;
}
