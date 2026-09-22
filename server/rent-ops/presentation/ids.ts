import { RentOpsPresentationError } from "./allowlist";

/**
 * Route parameters are opaque identifiers. The presentation layer must not
 * split, decode, reinterpret, or construct meaning from them. This shape
 * check only rejects empty, oversized, or control-character values.
 */
export function isOpaqueTargetId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160 && value.trim() === value && /^[\x21-\x7e]+$/.test(value);
}

export const isOpaqueId = isOpaqueTargetId;
export const targetIdPredicate = isOpaqueTargetId;

export function assertOpaqueTargetId(value: unknown): asserts value is string {
  if (!isOpaqueTargetId(value)) throw new RentOpsPresentationError("invalid_target_id");
}

export function requireOpaqueTargetId(value: unknown): string {
  assertOpaqueTargetId(value);
  return value;
}
