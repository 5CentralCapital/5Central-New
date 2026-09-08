import assert from "node:assert/strict";
import test from "node:test";
import {
  createFinancialSemanticCrosswalkEntry,
  financialSemanticCrosswalkValue,
  validateFinancialSemanticCrosswalk,
  type RentManagerFinancialSemanticCrosswalk,
} from "../../../shared/rent-ops-contracts";

const DIGEST = "a".repeat(64);

function crosswalk(entries: RentManagerFinancialSemanticCrosswalk["entries"]): RentManagerFinancialSemanticCrosswalk {
  return { artifactSha256: DIGEST, normalization: "trim_lower_unicode_v1", entries };
}

test("financial crosswalk computes exact normalized values and binds the approved artifact", () => {
  const entry = createFinancialSemanticCrosswalkEntry({
    artifactSha256: DIGEST,
    sourceCollection: "tenants.current",
    sourceField: "$partition",
    semanticKind: "tenancy_status",
    normalization: "trim_lower_unicode_v1",
    rawValue: "  current ",
    targetValue: "current",
  });
  assert.ok(entry);
  const value = crosswalk([entry]);
  assert.equal(validateFinancialSemanticCrosswalk(value, DIGEST).valid, true);
  assert.deepEqual(validateFinancialSemanticCrosswalk(value, "b".repeat(64)).issueCodes, ["artifact_not_approved"]);
  assert.equal(financialSemanticCrosswalkValue(value, { artifactSha256: DIGEST, sourceCollection: "tenants.current", sourceField: "$partition", semanticKind: "tenancy_status", rawValue: "current" }), "current");
  assert.equal(financialSemanticCrosswalkValue(value, { artifactSha256: DIGEST, sourceCollection: "tenants.current", sourceField: "$partition", semanticKind: "tenancy_status", rawValue: "current-inactive" }), undefined);
});

test("crosswalk validation fails closed for missing approval, wrong field, conflicts, domains, and digest casing", () => {
  const entry = createFinancialSemanticCrosswalkEntry({
    artifactSha256: DIGEST.toUpperCase(),
    sourceCollection: "recurringSchedules",
    sourceField: "Description",
    semanticKind: "recurring_active",
    normalization: "trim_lower_unicode_v1",
    rawValue: "active",
    targetValue: "maybe",
  });
  assert.ok(entry);
  const invalid: RentManagerFinancialSemanticCrosswalk = { artifactSha256: DIGEST.toUpperCase(), normalization: "exact_v1", entries: [entry, { ...entry, targetValue: "true" }] };
  const result = validateFinancialSemanticCrosswalk(invalid);
  assert.equal(result.valid, false);
  assert.ok(result.issueCodes.includes("artifact_approval_missing"));
  assert.ok(result.issueCodes.includes("artifact_digest_invalid"));
  assert.ok(result.issueCodes.includes("source_field_not_approved"));
  assert.ok(result.issueCodes.includes("target_value_out_of_domain"));
  assert.ok(result.issueCodes.includes("crosswalk_conflict"));
  assert.equal(JSON.stringify(result).includes("active"), false);
});

test("substring collisions are not status evidence", () => {
  const entry = createFinancialSemanticCrosswalkEntry({
    artifactSha256: DIGEST,
    sourceCollection: "tenants.former",
    sourceField: "$partition",
    semanticKind: "tenancy_status",
    normalization: "exact_v1",
    rawValue: "former",
    targetValue: "past",
  });
  assert.ok(entry);
  const value: RentManagerFinancialSemanticCrosswalk = { artifactSha256: DIGEST, normalization: "exact_v1", entries: [entry] };
  assert.equal(financialSemanticCrosswalkValue(value, { artifactSha256: DIGEST, sourceCollection: "tenants.former", sourceField: "$partition", semanticKind: "tenancy_status", rawValue: "former" }), "past");
  assert.equal(financialSemanticCrosswalkValue(value, { artifactSha256: DIGEST, sourceCollection: "tenants.former", sourceField: "$partition", semanticKind: "tenancy_status", rawValue: "formerish" }), undefined);
});

test("charge-definition activity is a distinct exact semantic from recurring activity", () => {
  const entry = createFinancialSemanticCrosswalkEntry({
    artifactSha256: DIGEST,
    sourceCollection: "chargeTypes",
    sourceField: "IsActive",
    semanticKind: "charge_definition_active",
    normalization: "trim_lower_unicode_v1",
    rawValue: true,
    targetValue: "true",
  });
  assert.ok(entry);
  const value = crosswalk([entry]);
  assert.equal(validateFinancialSemanticCrosswalk(value, DIGEST).valid, true);
  assert.equal(financialSemanticCrosswalkValue(value, { artifactSha256: DIGEST, sourceCollection: "chargeTypes", sourceField: "IsActive", semanticKind: "charge_definition_active", rawValue: true }), "true");
  assert.equal(financialSemanticCrosswalkValue(value, { artifactSha256: DIGEST, sourceCollection: "recurringSchedules", sourceField: "EntityType", semanticKind: "recurring_active", rawValue: true }), undefined);
});
