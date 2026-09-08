import { createHash } from "node:crypto";

/** Stable JSON encoding: object key order is irrelevant, array order is preserved. */
export function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashRecord(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function hashRecordHashes(hashes: readonly string[]): string {
  return sha256(JSON.stringify([...hashes].sort()));
}

export function hashRegistry(value: unknown): string {
  return hashRecord(value);
}
