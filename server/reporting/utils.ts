import { createHash, randomUUID } from "node:crypto";

export function newReportingId(): string { return randomUUID(); }

export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
  return value;
}

export function stableJson(value: unknown): string { return JSON.stringify(stableValue(value)); }

export function sha256(value: unknown): string { return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex"); }

export function deepClone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export function encodeCursor(value: unknown): string { return Buffer.from(stableJson(value), "utf8").toString("base64url"); }
export function decodeCursor<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T; } catch { return null; }
}

export function isoNow(now: () => Date = () => new Date()): string { return now().toISOString(); }

export function compareValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
}

