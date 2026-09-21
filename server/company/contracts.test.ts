import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  POSTGRES_SIGNED_64_MAX,
  POSTGRES_SIGNED_64_MIN,
  allocateCents,
  assertAllocationSum,
  assertExpectedRevision,
  authenticatedActorSchema,
  bindAuthenticatedActor,
  canonicalizeDecimal,
  centsFromBigInt,
  centsSchema,
  centsToLegacyNumber,
  companyIdSchema,
  companyScopeSchema,
  commandEnvelopeSchema,
  createOperationReceipt,
  currencyCodeSchema,
  decimalSchema,
  effectivePeriodSchema,
  authenticatedPrincipalIdSchema,
  documentReferenceIdSchema,
  isCanonicalCents,
  isCanonicalUuid,
  isIsoDate,
  isIsoTimestamp,
  legacyNumberToCents,
  legacyNumberToDecimal,
  moneySchema,
  multiplyDecimalToCents,
  nextRevision,
  operationReceiptSchema,
  parseCents,
  parseCommandEnvelope,
  parseRevision,
  personReferenceIdSchema,
  propertyReferenceIdSchema,
  preserveLegacyRentalId,
  recordReferenceIdSchema,
  revisionSchema,
  sumCents,
  type CompanyId,
} from "../../shared/company/index";

const IDS = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  legalEntityId: "10000000-0000-4000-8000-000000000002",
  propertyId: "10000000-0000-4000-8000-000000000003",
  actorId: "10000000-0000-4000-8000-000000000004",
  documentId: "10000000-0000-4000-8000-000000000005",
  operationId: "10000000-0000-4000-8000-000000000006",
  recordId: "10000000-0000-4000-8000-000000000007",
} as const;

const scope = {
  organizationId: IDS.organizationId,
  legalEntityId: IDS.legalEntityId,
  propertyId: IDS.propertyId,
};

test("cents use canonical decimal strings and PostgreSQL signed BIGINT bounds", () => {
  assert.equal(centsFromBigInt(POSTGRES_SIGNED_64_MIN), "-9223372036854775808");
  assert.equal(centsFromBigInt(POSTGRES_SIGNED_64_MAX), "9223372036854775807");
  assert.equal(isCanonicalCents("0"), true);
  assert.equal(isCanonicalCents("-0"), false);
  assert.equal(isCanonicalCents("01"), false);
  assert.equal(isCanonicalCents("+1"), false);
  assert.equal(isCanonicalCents("9223372036854775808"), false);
  assert.equal(isCanonicalCents("-9223372036854775809"), false);
  assert.equal(isCanonicalCents("9".repeat(100_000)), false);
  assert.equal(centsSchema.parse("-12"), "-12");
  assert.throws(() => parseCents(12), /canonical decimal string/);
});

test("legacy number adapters are explicit and refuse lossy conversions", () => {
  assert.equal(legacyNumberToCents(125), "125");
  assert.equal(legacyNumberToCents(Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER));
  assert.throws(() => legacyNumberToCents(1.5), /safe integer/);
  assert.throws(() => legacyNumberToCents(Number.MAX_SAFE_INTEGER + 1), /safe integer/);
  assert.throws(() => legacyNumberToCents(Number.POSITIVE_INFINITY), /safe integer/);
  assert.equal(centsToLegacyNumber("-9007199254740991"), -9007199254740991);
  assert.throws(() => centsToLegacyNumber(POSTGRES_SIGNED_64_MAX.toString()), /represented exactly/);
  assert.equal(legacyNumberToDecimal(1.25), "1.25");
  assert.equal(legacyNumberToDecimal(1e-7), "0.0000001");
  assert.equal(legacyNumberToDecimal(-0), "0");
  assert.throws(() => legacyNumberToDecimal(Number.NaN), /finite/);
});

test("decimal text is exact and multiplication rounds signed half cents deliberately", () => {
  assert.equal(canonicalizeDecimal("001"), "1");
  assert.equal(canonicalizeDecimal("-0.1000"), "-0.1");
  assert.equal(decimalSchema.parse("12.500"), "12.5");
  assert.equal(multiplyDecimalToCents("2.5", "1.20"), "300");
  assert.equal(multiplyDecimalToCents("1", "0.005"), "1");
  assert.equal(multiplyDecimalToCents("-1", "0.005"), "-1");
  assert.equal(multiplyDecimalToCents("1", "0.005", "half_even"), "0");
  assert.equal(multiplyDecimalToCents("-1", "0.005", "half_even"), "0");
  assert.equal(multiplyDecimalToCents("-1", "0.005", "floor"), "-1");
  assert.equal(multiplyDecimalToCents("-1", "0.005", "ceil"), "0");
  assert.equal(multiplyDecimalToCents("-1", "0.005", "toward_zero"), "0");
  assert.throws(() => decimalSchema.parse("1e2"));
  const smallest = `0.${"0".repeat(999)}1`;
  assert.equal(multiplyDecimalToCents(smallest, smallest), "0");
  assert.equal(multiplyDecimalToCents(smallest, smallest, "ceil"), "1");
  assert.equal(decimalSchema.safeParse("9".repeat(1_001)).success, false);
  assert.throws(() => canonicalizeDecimal("9".repeat(100_000)), /length/);
});

test("deterministic cent allocation preserves signed totals and tie order", () => {
  assert.deepEqual(allocateCents("100", ["1", "1", "1"]), ["34", "33", "33"]);
  assert.deepEqual(allocateCents("-100", ["1", "1", "1"]), ["-34", "-33", "-33"]);
  assert.deepEqual(allocateCents("1", ["0.5", "0.3", "0.2"]), ["1", "0", "0"]);
  assert.deepEqual(allocateCents("5", ["0", "1", "1"]), ["0", "3", "2"]);
  const allocation = allocateCents("9223372036854775807", ["1", "1"]);
  assert.equal(sumCents(allocation), "9223372036854775807");
  assertAllocationSum("-100", allocateCents("-100", ["1", "2", "7"]));
  assert.throws(() => allocateCents("10", []), /at least one/i);
  assert.throws(() => allocateCents("10", ["-1", "2"]), /negative/i);
  assert.throws(() => allocateCents("0", ["0", "0"]), /positive/i);
});

test("currency and money contracts keep currency separate from amount", () => {
  assert.equal(currencyCodeSchema.parse("USD"), "USD");
  assert.equal(currencyCodeSchema.parse("EUR"), "EUR");
  assert.equal(currencyCodeSchema.safeParse("usd").success, false);
  assert.equal(currencyCodeSchema.safeParse("US").success, false);
  assert.deepEqual(moneySchema.parse({ amountCents: "1250", currency: "USD" }), {
    amountCents: "1250",
    currency: "USD",
  });
  assert.equal(moneySchema.safeParse({ amountCents: 1250, currency: "USD" }).success, false);
});

test("dates validate real leap days and separate effective periods from timestamps", () => {
  assert.equal(isIsoDate("2024-02-29"), true);
  assert.equal(isIsoDate("2000-02-29"), true);
  assert.equal(isIsoDate("2023-02-29"), false);
  assert.equal(isIsoDate("1900-02-29"), false);
  assert.equal(isIsoDate("2024-04-31"), false);
  assert.equal(isIsoDate("2024-1-01"), false);
  assert.equal(isIsoTimestamp("2026-09-21T14:30:00.123Z"), true);
  assert.equal(isIsoTimestamp("2026-09-21T14:30:00-04:00"), false);
  assert.equal(isIsoTimestamp("2026-09-21T24:00:00Z"), false);
  assert.equal(effectivePeriodSchema.safeParse({ effectiveFrom: "2024-02-29", effectiveTo: "2024-03-01" }).success, true);
  assert.equal(effectivePeriodSchema.safeParse({ effectiveFrom: "2024-03-01", effectiveTo: "2024-02-29" }).success, false);
  assert.equal(effectivePeriodSchema.safeParse({ effectiveFrom: "2024-03-01", effectiveTo: "2024-03-01" }).success, false);
});

test("new company IDs are strict UUIDs while legacy rental IDs retain their exact format", () => {
  assert.equal(isCanonicalUuid(IDS.operationId), true);
  assert.equal(isCanonicalUuid("abcdefab-cdef-4abc-8def-abcdefabcdef".toUpperCase()), false);
  assert.equal(companyIdSchema.safeParse("legacy-123").success, false);
  const legacy = "RM-001/Unit-04";
  assert.equal(preserveLegacyRentalId(legacy), legacy);
  assert.notEqual(preserveLegacyRentalId("001"), "1");
  assert.equal(propertyReferenceIdSchema.parse("legacy-property-7"), "legacy-property-7");
  assert.equal(personReferenceIdSchema.parse("legacy-person-9"), "legacy-person-9");
  assert.equal(documentReferenceIdSchema.parse("legacy-document-2"), "legacy-document-2");
  assert.equal(recordReferenceIdSchema.parse("legacy-property-7"), "legacy-property-7");
  for (const schema of [propertyReferenceIdSchema, personReferenceIdSchema, documentReferenceIdSchema, recordReferenceIdSchema]) {
    assert.equal(schema.safeParse("").success, false);
    assert.equal(schema.safeParse("legacy\u0000id").success, false);
  }
});

test("organization, legal-entity, and property scope are distinct and tenancy is not accepted", () => {
  assert.equal(companyScopeSchema.safeParse(scope).success, true);
  assert.equal(companyScopeSchema.safeParse({ ...scope, propertyId: "legacy-property-7" }).success, true);
  assert.equal(companyScopeSchema.safeParse({ ...scope, tenancyId: "legacy-tenant-1" }).success, false);
  assert.equal(companyScopeSchema.safeParse({ organizationId: "legacy-org" }).success, false);
  assert.equal(companyScopeSchema.safeParse({ organizationId: IDS.organizationId, propertyId: "legacy-property-7" }).success, false);
});

test("revision contracts expose optimistic concurrency conflicts", () => {
  assert.equal(parseRevision(1), 1);
  assert.equal(nextRevision(2), 3);
  assert.equal(revisionSchema.safeParse(0).success, false);
  assert.doesNotThrow(() => assertExpectedRevision(4, 4));
  assert.throws(() => assertExpectedRevision(5, 4), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "revision_conflict");
    assert.equal((error as { expected?: number }).expected, 4);
    assert.equal((error as { actual?: number }).actual, 5);
    return true;
  });
});

test("command envelope is typed, idempotent, scoped, and rejects actor identity in user input", () => {
  const payloadSchema = z.object({ name: z.string().min(1) }).strict();
  const envelopeInput = {
    operationId: IDS.operationId,
    idempotencyKey: "company-create-001",
    scope,
    expectedRevision: 2,
    effectiveDate: "2026-09-21",
    sourceDocumentIds: [IDS.documentId],
    payload: { name: "Synthetic Property" },
  };
  const parsed = parseCommandEnvelope(payloadSchema, envelopeInput);
  assert.equal(parsed.operationId, IDS.operationId);
  assert.equal(parsed.expectedRevision, 2);
  assert.equal(commandEnvelopeSchema(payloadSchema).safeParse({ ...envelopeInput, actorId: IDS.actorId }).success, false);
  assert.equal(commandEnvelopeSchema(payloadSchema).safeParse({ ...envelopeInput, userId: IDS.actorId }).success, false);
  assert.equal(commandEnvelopeSchema(payloadSchema).safeParse({ ...envelopeInput, idempotencyKey: "" }).success, false);
  assert.equal(commandEnvelopeSchema(payloadSchema).safeParse({ ...envelopeInput, idempotencyKey: "key\u0000suffix" }).success, false);

  const actor = authenticatedActorSchema.parse({ actorId: "demo-admin", organizationId: IDS.organizationId, role: "admin" });
  const bound = bindAuthenticatedActor(parsed, actor);
  assert.equal(bound.actor.actorId, "demo-admin");
  assert.equal(authenticatedPrincipalIdSchema.safeParse("\u0000").success, false);
  assert.throws(() => bindAuthenticatedActor(parsed, { ...actor, organizationId: "10000000-0000-4000-8000-000000000099" as CompanyId }), /organization scope/);
});

test("operation receipts return stable operation/idempotency data and revisions", () => {
  const payloadSchema = z.object({ name: z.string() }).strict();
  const envelope = parseCommandEnvelope(payloadSchema, {
    operationId: IDS.operationId,
    idempotencyKey: "idempotency-001",
    scope,
    payload: { name: "Synthetic" },
  });
  const receipt = createOperationReceipt(envelope, {
    state: "saved_in_rops",
    affectedRecordIds: [IDS.recordId],
    resultingRevisions: [{ recordId: IDS.recordId, revision: 1 }],
    validationOutcomes: [{ code: "validated", severity: "info", message: "Synthetic record accepted" }],
    recordedAt: "2026-09-21T14:30:00Z",
  });
  assert.equal(receipt.operationId, IDS.operationId);
  assert.equal(receipt.idempotencyKey, "idempotency-001");
  assert.equal(receipt.resultingRevisions[0]?.revision, 1);
  assert.equal(operationReceiptSchema.safeParse({ ...receipt, affectedRecordIds: [IDS.recordId, IDS.recordId] }).success, false);
  assert.equal(operationReceiptSchema.safeParse({
    ...receipt,
    affectedRecordIds: ["legacy-property-7"],
    resultingRevisions: [{ recordId: "legacy-property-7", revision: 1 }],
  }).success, true);
  assert.equal(operationReceiptSchema.safeParse({ ...receipt, recordedAt: "2026-02-30T00:00:00Z" }).success, false);
});
