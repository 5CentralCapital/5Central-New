import { createHash } from "node:crypto";
import type { CommandEnvelope } from "../../../shared/company";
import { ValidationCommandError } from "./errors";

const MAX_CANONICAL_DEPTH = 128;

interface CanonicalState {
  readonly stack: WeakSet<object>;
}

function canonicalJsonValue(value: unknown, state: CanonicalState, depth: number): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new ValidationCommandError("Command payload is too deeply nested", { reason: "canonical_depth" });
  }
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ValidationCommandError("Command contains a non-finite number", { reason: "non_finite_number" });
    return JSON.stringify(value);
  }
  if (typeof value === "bigint" || typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    throw new ValidationCommandError("Command payload is not canonical JSON", { reason: "non_json_value" });
  }
  if (typeof value !== "object") {
    throw new ValidationCommandError("Command payload is not canonical JSON", { reason: "non_json_value" });
  }
  if (state.stack.has(value)) {
    throw new ValidationCommandError("Command payload contains a cycle", { reason: "canonical_cycle" });
  }
  state.stack.add(value);
  try {
    if (Array.isArray(value)) {
      const values: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new ValidationCommandError("Command payload contains a sparse array", { reason: "canonical_sparse_array" });
        }
        values.push(canonicalJsonValue(value[index], state, depth + 1));
      }
      return `[${values.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ValidationCommandError("Command payload contains a non-plain object", { reason: "canonical_non_plain_object" });
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(record[key], state, depth + 1)}`).join(",")}}`;
  } finally {
    state.stack.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalJsonValue(value, { stack: new WeakSet<object>() }, 0);
}

export interface CommandFingerprintInput<TPayload> {
  readonly commandKind: string;
  readonly envelope: CommandEnvelope<TPayload>;
}

/** operationId and idempotencyKey are intentionally excluded for replay. */
export function canonicalCommandFingerprint<TPayload>(input: CommandFingerprintInput<TPayload>): string {
  return canonicalJson({
    commandKind: input.commandKind,
    scope: input.envelope.scope,
    payload: input.envelope.payload,
    expectedRevision: input.envelope.expectedRevision ?? null,
    effectiveDate: input.envelope.effectiveDate ?? null,
    evidence: input.envelope.sourceDocumentIds ?? [],
  });
}

export function canonicalTextSha256(canonicalText: string): string {
  return createHash("sha256").update(canonicalText, "utf8").digest("hex");
}

export function commandPayloadSha256<TPayload>(input: CommandFingerprintInput<TPayload>): string {
  return canonicalTextSha256(canonicalCommandFingerprint(input));
}

export const fingerprintCommand = commandPayloadSha256;

/** Hash a JSON value after canonicalizing it. Strings are JSON strings. */
export function canonicalJsonSha256(value: unknown): string {
  return canonicalTextSha256(canonicalJson(value));
}
