/** Display helpers for exact cents strings; money never passes through floating point. */
import { workspaceToday } from "../rent-ops/workspace/workspace-date";
import { formatLongDate, formatTimestamp } from "../../lib/rent-ops-formatters";

const SYMBOLS: Readonly<Record<string, string>> = { USD: "$", CAD: "CA$", EUR: "€", GBP: "£" };

export function formatCents(value: string | null | undefined, currency = "USD"): string {
  if (value === null || value === undefined) return "Unknown";
  if (!/^-?\d+$/.test(value)) return "Unknown";
  const amount = BigInt(value);
  const negative = amount < BigInt(0);
  const digits = (negative ? -amount : amount).toString().padStart(3, "0");
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  return `${negative ? "−" : ""}${symbol}${whole}.${digits.slice(-2)}`;
}

export function isPositiveCents(value: string | null | undefined): boolean {
  return typeof value === "string" && /^\d+$/.test(value) && BigInt(value) > BigInt(0);
}

export function sumCents(values: readonly (string | null | undefined)[]): string | null {
  let total = BigInt(0);
  for (const value of values) {
    if (value === null || value === undefined || !/^-?\d+$/.test(value)) return null;
    total += BigInt(value);
  }
  return total.toString();
}

export function dateLabel(value: string | null | undefined): string {
  if (!value) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return formatLongDate(value) ?? value;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: /^\d{4}-\d{2}-\d{2}$/.test(value) ? "UTC" : undefined }).format(date);
}

/** Shared manager timestamp: "11:29 AM" today, otherwise "Sep 23, 2026, 11:29 AM"; never seconds. */
export function dateTimeLabel(value: string | null | undefined, now = new Date()): string {
  if (!value) return "—";
  return formatTimestamp(value, now) ?? value;
}

/** "4 min ago", "3 h ago", "2 days ago" from a lag in seconds. */
export function ageLabel(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "Never";
  if (seconds < 90) return "Just now";
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} days ago`;
}

/** Calendar month containing `reference` shifted by `offset` months, as ISO dates. */
export function monthPeriod(reference: Date, offset = 0): { readonly periodStart: string; readonly periodEnd: string } {
  const start = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + offset, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  return { periodStart: start.toISOString().slice(0, 10), periodEnd: end.toISOString().slice(0, 10) };
}

/** The month before the current operating (New York) month: the period awaiting close. */
export function previousOperatingMonth(now = new Date()): { readonly periodStart: string; readonly periodEnd: string } {
  return monthPeriod(new Date(`${workspaceToday(now).slice(0, 7)}-15T12:00:00Z`), -1);
}

export function monthLabel(periodStart: string): string {
  const date = new Date(`${periodStart}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? periodStart : new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

export function newOperationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
