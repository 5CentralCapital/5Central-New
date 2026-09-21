import assert from "node:assert/strict";
import test from "node:test";
import { commandEnvelopeSchema } from "../../../shared/company";
import { z } from "zod";
import {
  canonicalCommandFingerprint,
  canonicalJson,
  canonicalJsonSha256,
  commandPayloadSha256,
} from "./fingerprint";
import { ValidationCommandError } from "./errors";

const payloadSchema = z.object({ amount: z.number(), memo: z.string().optional() }).strict();
const baseEnvelope = (operationId: string, idempotencyKey: string, amount = 10) => commandEnvelopeSchema(payloadSchema).parse({
  operationId,
  idempotencyKey,
  scope: {
    organizationId: "10000000-0000-4000-8000-000000000001",
    legalEntityId: "20000000-0000-4000-8000-000000000001",
    propertyId: "legacy-property-7",
  },
  payload: { amount },
});

function rejectsCanonical(work: () => unknown, reason: string): void {
  assert.throws(work, (error: unknown) => {
    assert.equal((error as { code?: string }).code, "validation");
    assert.equal((error as { details?: { reason?: string } }).details?.reason, reason);
    return error instanceof ValidationCommandError;
  });
}

test("command fingerprints are deterministic and exclude operation identity", () => {
  assert.equal(canonicalJson({ z: 1, a: [true, null] }), '{"a":[true,null],"z":1}');
  assert.equal(canonicalJsonSha256({ a: 1, b: 2 }), canonicalJsonSha256({ b: 2, a: 1 }));
  assert.notEqual(canonicalJsonSha256("null"), canonicalJsonSha256(null));

  const one = baseEnvelope("30000000-0000-4000-8000-000000000001", "key-one");
  const retry = baseEnvelope("30000000-0000-4000-8000-000000000002", "key-two");
  assert.equal(commandPayloadSha256({ commandKind: "company.test", envelope: one }), commandPayloadSha256({ commandKind: "company.test", envelope: retry }));
  assert.equal(canonicalCommandFingerprint({ commandKind: "company.test", envelope: one }), canonicalCommandFingerprint({ commandKind: "company.test", envelope: retry }));
  assert.notEqual(commandPayloadSha256({ commandKind: "company.test", envelope: one }), commandPayloadSha256({ commandKind: "company.other", envelope: one }));
});

test("canonicalization rejects ambiguous JSON structures", () => {
  rejectsCanonical(() => canonicalJson(new Date("2026-01-01T00:00:00Z")), "canonical_non_plain_object");
  rejectsCanonical(() => canonicalJson(new Map([["a", 1]])), "canonical_non_plain_object");
  const sparse: string[] = [];
  sparse[1] = "value";
  rejectsCanonical(() => canonicalJson(sparse), "canonical_sparse_array");
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  rejectsCanonical(() => canonicalJson(cycle), "canonical_cycle");
  let deeplyNested: Record<string, unknown> = {};
  const root = deeplyNested;
  for (let index = 0; index < 130; index += 1) {
    const next: Record<string, unknown> = {};
    deeplyNested.child = next;
    deeplyNested = next;
  }
  rejectsCanonical(() => canonicalJson(root), "canonical_depth");
});
