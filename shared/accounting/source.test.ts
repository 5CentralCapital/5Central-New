import assert from "node:assert/strict";
import test from "node:test";
import { financialSourceReferenceKey } from "./source";

const reference = {
  provider: "qbo" as const,
  organizationId: "10000000-0000-4000-8000-000000000001",
  legalEntityId: "20000000-0000-4000-8000-000000000001",
  environment: "sandbox" as const,
  realmId: "123456",
  objectType: "Bill",
  objectId: "77",
  lineId: "1",
  version: "3",
};

test("financial source reference keys accept a full reference and are stable", () => {
  const key = financialSourceReferenceKey(reference);
  assert.equal(key, financialSourceReferenceKey({ ...reference }));
  assert.notEqual(key, financialSourceReferenceKey({ ...reference, lineId: "2" }));
  assert.notEqual(key, financialSourceReferenceKey({ ...reference, lineId: null }));
});
