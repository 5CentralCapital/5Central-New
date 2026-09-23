import { ValidationCommandError } from "../company/commands/errors";
import { nowIsoDate } from "../rent-ops/domain/dates";
import {
  centsFromBigInt,
  centsSchema,
  isoDateSchema,
  isoTimestampSchema,
  parseDecimalParts,
  revisionSchema,
  type MoneyCents,
  type Revision,
} from "../../shared/company";

export function dbString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new ValidationCommandError(`Investor storage returned an invalid ${key}`, { reason: "invalid_storage_row", field: key });
  return value;
}

export function dbNullableString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new ValidationCommandError(`Investor storage returned an invalid ${key}`, { reason: "invalid_storage_row", field: key });
  return value;
}

export function dbDate(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  const parsed = isoDateSchema.safeParse(value instanceof Date ? value.toISOString().slice(0, 10) : typeof value === "string" ? value.slice(0, 10) : value);
  if (!parsed.success) throw new ValidationCommandError(`Investor storage returned an invalid ${key}`, { reason: "invalid_storage_row", field: key });
  return parsed.data;
}

export function dbNullableDate(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return dbDate(row, key);
}

export function dbTimestamp(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  const text = value instanceof Date ? value.toISOString() : value;
  const parsed = isoTimestampSchema.safeParse(text);
  if (!parsed.success) throw new ValidationCommandError(`Investor storage returned an invalid ${key}`, { reason: "invalid_storage_row", field: key });
  return parsed.data;
}

export function dbRevision(value: unknown): Revision {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return revisionSchema.parse(number);
}

export function dbCents(value: unknown, field: string): MoneyCents {
  if (typeof value === "bigint") return centsFromBigInt(value);
  if (typeof value === "string") return centsSchema.parse(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return centsFromBigInt(BigInt(value));
  throw new ValidationCommandError(`Investor storage returned an invalid ${field}`, { reason: "invalid_storage_row", field });
}

export function dbDecimal(value: unknown, field: string): string {
  if (typeof value !== "string" && typeof value !== "number") throw new ValidationCommandError(`Investor storage returned an invalid ${field}`, { reason: "invalid_storage_row", field });
  try { return parseDecimalParts(String(value)).canonical; } catch { throw new ValidationCommandError(`Investor storage returned an invalid ${field}`, { reason: "invalid_storage_row", field }); }
}

export function parseJson(value: unknown, field: string): Record<string, unknown> {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown; } catch { return undefined; } })() : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ValidationCommandError(`Investor storage returned invalid ${field}`, { reason: "invalid_storage_json", field });
  return parsed as Record<string, unknown>;
}

export function encodeCursor(value: { updatedAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor(value: string | undefined): { updatedAt: string; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.updatedAt !== "string" || typeof parsed.id !== "string") throw new Error("invalid");
    return parsed as { updatedAt: string; id: string };
  } catch {
    throw new ValidationCommandError("Investor cursor is invalid", { reason: "invalid_investor_cursor" });
  }
}

/** Defaults to the company operating date (America/New_York), not the UTC date. */
export function resolveEffectiveDate(value: string | undefined, now = new Date()): string {
  return value ?? nowIsoDate(now);
}
