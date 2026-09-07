import { storageError } from "./errors";

export const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
export const LOGICAL_KEY_PATTERN = /^sha256:([a-f0-9]{64})$/;

export type Sha256Checksum = string;
export type LogicalObjectKey = string;

export function assertSha256Checksum(value: string, code: "storage_checksum_invalid" | "storage_checksum_mismatch" = "storage_checksum_invalid"): Sha256Checksum {
  if (!SHA256_HEX_PATTERN.test(value)) throw storageError(code);
  return value;
}

/** The only logical-key derivation used by the storage core. */
export function logicalKeyForChecksum(checksum: string): LogicalObjectKey {
  return `sha256:${assertSha256Checksum(checksum)}`;
}

/**
 * Accept the canonical colon form and the equivalent slash form used by a few
 * object-store clients, but always return the canonical opaque form.
 */
export function normalizeLogicalKey(value: string): LogicalObjectKey {
  if (typeof value !== "string" || value.includes("\0")) throw storageError("storage_logical_key_invalid");
  const normalized = value.startsWith("sha256/") ? `sha256:${value.slice("sha256/".length)}` : value;
  const match = LOGICAL_KEY_PATTERN.exec(normalized);
  if (!match?.[1]) throw storageError("storage_logical_key_invalid");
  return logicalKeyForChecksum(match[1]);
}

export function checksumForLogicalKey(value: string): Sha256Checksum {
  const normalized = normalizeLogicalKey(value);
  return normalized.slice("sha256:".length);
}

export function isLogicalObjectKey(value: string): boolean {
  try {
    normalizeLogicalKey(value);
    return true;
  } catch {
    return false;
  }
}
