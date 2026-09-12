import assert from "node:assert/strict";
import test from "node:test";
import { actionFields, baseOptions, scopedFields, editorTitle, relationshipErrors } from "./editor-model";
import type { AdminSnapshot } from "../types";
const snapshot = { chargeDefinitions: [], snapshot: {
  properties: [{ id: "p1", name: "Oak" }, { id: "p2", name: "Pine" }],
  units: [{ id: "u1", propertyId: "p1", unitNumber: "1" }, { id: "u2", propertyId: "p2", unitNumber: "1" }],
  people: [{ id: "person1", firstName: "Jane", lastName: "Smith" }],
  tenancies: [{ id: "t1", propertyId: "p1", unitId: "u1", primaryPersonId: "person1", status: "current" }],
  householdMemberships: [], ledgerTransactions: [], applicationHouseholdMembers: [],
} } as unknown as AdminSnapshot;
test("tenancy labels disambiguate property, unit, person and status", () => {
  assert.equal(baseOptions(snapshot).tenancies[0][1], "Oak · Unit 1 · Jane Smith · Current");
});
test("unit choices follow property while preserving existing archived or missing selection", () => {
  const choices = (values: Record<string, string>) => scopedFields("save-tenancy", snapshot, {}, values).find(f => f.name === "unitId")!.options;
  assert.deepEqual(choices({ propertyId: "p1" })?.map(x => x[0]), ["u1"]);
  assert.deepEqual(choices({ propertyId: "p1", unitId: "u2" })?.map(x => x[0]), ["u1", "u2"]);
  assert.equal(choices({ propertyId: "p1", unitId: "missing" })?.at(-1)?.[1], "Existing selection · needs review");
});
test("editing unknown facts stays sparse and HAP edits remain status only", () => {
  assert.ok(actionFields("save-property", snapshot, { id: "p1", revision: 2 }).every(f => !f.required));
  assert.deepEqual(actionFields("save-subsidy-contract", snapshot, { id: "hap", revision: 2 }).map(f => f.name), ["status"]);
  assert.equal(editorTitle("save-person", { id: "person1" }), "Edit Tenant");
});
test("relationship validation requires correction only when chosen relationships change", () => {
  const existing = { revision: 2, propertyId: "p1", unitId: "u2" };
  assert.deepEqual(relationshipErrors(snapshot, existing, existing), {});
  assert.ok(relationshipErrors(snapshot, existing, { ...existing, unitId: "u1" }).unitId);
  assert.deepEqual(relationshipErrors(snapshot, { propertyId: "p1", unitId: "u1" }, {}), {});
});

test("allocation and reversal choices exclude cross-property transactions and follow changed parents", () => {
  const source = structuredClone(snapshot);
  source.snapshot.ledgerTransactions = [
    { id: "pay1", kind: "payment", status: "posted", propertyId: "p1", unitId: "u1", tenancyId: "t1", personId: "person1" },
    { id: "charge1", kind: "charge", status: "posted", propertyId: "p1", unitId: "u1", tenancyId: "t1", personId: "person1" },
    { id: "pay2", kind: "payment", status: "posted", propertyId: "p2", unitId: "u2" },
    { id: "charge2", kind: "charge", status: "posted", propertyId: "p2", unitId: "u2" },
  ];
  const choices = (action: "save-payment-allocation" | "reverse-ledger-transaction", field: string, values: Record<string, string>) => scopedFields(action, source, {}, values).find(f => f.name === field)!.options!.map(o => o[0]);
  assert.deepEqual(choices("save-payment-allocation", "paymentTransactionId", { propertyId: "p1" }), ["pay1"]);
  assert.deepEqual(choices("save-payment-allocation", "paymentTransactionId", { propertyId: "p2" }), ["pay2"]);
  assert.deepEqual(choices("save-payment-allocation", "chargeTransactionId", { paymentTransactionId: "pay1" }), ["charge1"]);
  assert.deepEqual(choices("save-payment-allocation", "chargeTransactionId", { paymentTransactionId: "pay2" }), ["charge2"]);
  assert.deepEqual(choices("reverse-ledger-transaction", "originalId", { personId: "person1" }), ["pay1", "charge1"]);
  assert.deepEqual(choices("reverse-ledger-transaction", "originalId", { tenancyId: "t1" }), ["pay1", "charge1"]);
  // Preserve selection visibly, but prevent a save after moving its parent context.
  assert.deepEqual(choices("save-payment-allocation", "paymentTransactionId", { propertyId: "p2", paymentTransactionId: "pay1" }), ["pay1", "pay2"]);
  assert.ok(relationshipErrors(source, { propertyId: "p2", paymentTransactionId: "pay1" }, { propertyId: "p1", paymentTransactionId: "pay1" }).paymentTransactionId);
});

test("tenant context includes known tenancy-level entries but excludes unrelated or unknown parents", () => {
  const source = structuredClone(snapshot);
  source.snapshot.ledgerTransactions = [
    { id: "known", kind: "charge", status: "posted", tenancyId: "t1" },
    { id: "unknown", kind: "charge", status: "posted" },
    { id: "other", kind: "charge", status: "posted", tenancyId: "t1", personId: "someone-else" },
  ];
  const field = scopedFields("reverse-ledger-transaction", source, {}, { propertyId: "p1", personId: "person1" }).find(f => f.name === "originalId")!;
  assert.deepEqual(field.options?.map(o => o[0]), ["known"]);
});
