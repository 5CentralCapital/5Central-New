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

const DECIMAL_TEXT = /^-?\d+(?:\.\d+)?$/;

/** Exact order of two signed decimal strings (cents, "12.50", "-3"). */
function compareDecimalText(left: string, right: string): number {
  const scale = (value: string) => value.split(".")[1]?.length ?? 0;
  const digits = Math.max(scale(left), scale(right));
  const scaled = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return BigInt(`${whole}${fraction.padEnd(digits, "0")}`);
  };
  const a = scaled(left);
  const b = scaled(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  // Money is stored as signed cents text; a locale "numeric" compare treats
  // the minus sign as punctuation and orders -100 after -5.
  if (typeof left === "string" && typeof right === "string" && DECIMAL_TEXT.test(left) && DECIMAL_TEXT.test(right)) return compareDecimalText(left, right);
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
}

