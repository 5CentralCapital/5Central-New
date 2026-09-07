import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyRentOpsSnapshot,
  type RentOpsRecurringChargeSchedule,
  type RentOpsSnapshot,
} from "../../../shared/rent-ops-contracts";
import {
  baseRentScheduleViolations,
  effectiveSchedules,
  validateSnapshot,
} from "./invariants";

function knownSchedule(id: string, overrides: Partial<RentOpsRecurringChargeSchedule> = {}): RentOpsRecurringChargeSchedule {
  return {
    id,
    propertyId: "p1",
    unitId: null,
    tenancyId: null,
    personId: null,
    scopeType: "unit",
    scopeId: "u1",
    scopeTypeKnowledge: "source",
    scopeLinkKnowledge: "exact",
    chargeDefinitionId: "base-rent",
    chargeDefinitionKey: null,
    chargeDefinitionLinkKnowledge: "exact",
    category: "base_rent",
    categoryKnowledge: "source",
    description: null,
    descriptionKnowledge: null,
    amountCents: 100_000,
    amountKnowledge: "known",
    effectiveFrom: "2025-01-01",
    effectiveFromKnowledge: "source",
    effectiveTo: null,
    active: true,
    activeKnowledge: "source",
    sourceArtifactSha256: "a".repeat(64),
    artifactObservationOn: "2025-01-01",
    lineageRootId: id,
    lineageRootOrigin: "artifact",
    supersedesId: null,
    versionAction: "root",
    ...overrides,
  };
}

function scheduleSnapshot(...schedules: RentOpsRecurringChargeSchedule[]): RentOpsSnapshot {
  const snapshot = emptyRentOpsSnapshot();
  snapshot.modelVersion = 3;
  snapshot.properties.push({
    id: "p1",
    name: "Property 1",
    slug: "property-1",
    address: { line1: "1 Main", city: "Town", state: "FL", postalCode: "00000" },
    propertyType: "multifamily",
    state: "active",
  });
  snapshot.units.push({
    id: "u1",
    propertyId: "p1",
    unitNumber: "1",
    readiness: "ready",
    listing: "listed",
    propertyLinkKnowledge: "exact",
  });
  snapshot.recurringSchedules.push(...schedules);
  return snapshot;
}

test("explicit null schedule facts remain unresolved and are never fabricated into references", () => {
  const nullCanary = knownSchedule("null-canary", {
    propertyId: null,
    unitId: null,
    tenancyId: null,
    personId: null,
    scopeType: null,
    scopeId: null,
    scopeTypeKnowledge: null,
    scopeLinkKnowledge: null,
    chargeDefinitionId: null,
    chargeDefinitionKey: null,
    chargeDefinitionLinkKnowledge: null,
    category: null,
    categoryKnowledge: null,
    description: null,
    descriptionKnowledge: null,
    amountCents: null,
    amountKnowledge: null,
    effectiveFrom: null,
    effectiveFromKnowledge: null,
    effectiveTo: null,
    active: null,
    activeKnowledge: null,
  });

  assert.deepEqual(validateSnapshot(scheduleSnapshot(nullCanary)), []);
  assert.deepEqual(baseRentScheduleViolations([nullCanary]), []);
  assert.deepEqual(effectiveSchedules([nullCanary], "t1", "2025-05-01", { propertyId: "p1", unitId: "u1" }), []);
  assert.deepEqual({
    propertyId: nullCanary.propertyId,
    scopeType: nullCanary.scopeType,
    scopeId: nullCanary.scopeId,
    category: nullCanary.category,
    amountCents: nullCanary.amountCents,
    effectiveFrom: nullCanary.effectiveFrom,
    active: nullCanary.active,
  }, {
    propertyId: null,
    scopeType: null,
    scopeId: null,
    category: null,
    amountCents: null,
    effectiveFrom: null,
    active: null,
  });
});

test("canonical schedule scope requires source/manual type and exact/manual link knowledge", () => {
  const first = knownSchedule("first", { effectiveTo: "2025-12-31" });
  const second = knownSchedule("second", { effectiveFrom: "2025-06-01" });
  assert.equal(baseRentScheduleViolations([first, second]).length, 1);

  const inferredType = { ...second, scopeTypeKnowledge: "inferred" as const };
  const ambiguousLink = { ...second, scopeLinkKnowledge: "ambiguous" as const };
  assert.deepEqual(baseRentScheduleViolations([first, inferredType]), []);
  assert.deepEqual(baseRentScheduleViolations([first, ambiguousLink]), []);
  assert.deepEqual(effectiveSchedules([inferredType, ambiguousLink], "t1", "2025-07-01", { unitId: "u1", propertyId: "p1" }), []);

  const scopeIdOnlyUnit = knownSchedule("scope-id-only", { unitId: null });
  assert.deepEqual(validateSnapshot(scheduleSnapshot(scopeIdOnlyUnit)), []);
  assert.deepEqual(effectiveSchedules([scopeIdOnlyUnit], "t1", "2025-07-01", { unitId: "u1", propertyId: "p1" }).map((row) => row.id), ["scope-id-only"]);
});

test("null dates do not become sentinel dates or manufacture an overlap", () => {
  const unknownOpenStart = knownSchedule("unknown-open", {
    effectiveFrom: null,
    effectiveFromKnowledge: "unknown_open_start",
    effectiveTo: null,
  });
  const dated = knownSchedule("dated", { effectiveFrom: "2025-06-01", effectiveTo: null });
  assert.deepEqual(baseRentScheduleViolations([unknownOpenStart, dated]), []);

  const exactMissingTarget = knownSchedule("missing-target", { scopeId: "u-missing" });
  const violations = validateSnapshot(scheduleSnapshot(exactMissingTarget));
  assert.ok(violations.some((violation) => violation.code === "schedule_reference_invalid" && violation.entityId === exactMissingTarget.id));
});

test('historical allocations survive reversals while new allocations and effective overallocations are rejected', async () => {
  const { syntheticRentOpsSnapshot } = await import('../fixtures/synthetic');
  const { validateAllocation } = await import('./invariants');
  const snapshot=syntheticRentOpsSnapshot();const tenancy=snapshot.tenancies[0];
  const base={propertyId:tenancy.propertyId,unitId:tenancy.unitId,tenancyId:tenancy.id,personId:tenancy.primaryPersonId,category:'base_rent' as const,status:'posted' as const,amountCents:10000,postedOn:'2026-09-01',description:'Test'};
  const charge={...base,id:'charge',kind:'charge' as const};const payment={...base,id:'payment',kind:'payment' as const};const replacement={...payment,id:'replacement'};
  const reversal={...payment,id:'reversal',kind:'reversal' as const,reversalOfId:'payment',postedOn:'2026-09-02'};
  const allocation={id:'original-allocation',paymentTransactionId:'payment',chargeTransactionId:'charge',amountCents:10000,allocatedOn:'2026-09-01'};
  snapshot.ledgerTransactions=[charge,payment,reversal,replacement];snapshot.paymentAllocations=[allocation,{...allocation,id:'replacement-allocation',paymentTransactionId:'replacement',allocatedOn:'2026-09-02'}];
  assert.deepEqual(validateSnapshot(snapshot).filter(v=>v.code.startsWith('allocation')),[]);
  assert.ok(validateAllocation({...allocation,id:'new'},payment,charge,snapshot.ledgerTransactions).some(v=>v.code==='allocation_payment_reversed'));
  assert.ok(validateAllocation({...allocation,allocatedOn:'2026-09-03'},payment,charge,snapshot.ledgerTransactions,true).some(v=>v.code==='allocation_payment_reversed'));
  snapshot.paymentAllocations.push({...allocation,id:'excess',paymentTransactionId:'replacement',amountCents:1});
  assert.ok(validateSnapshot(snapshot).some(v=>v.code==='allocations_exceed_charge'));
  snapshot.paymentAllocations=[allocation];snapshot.ledgerTransactions=[charge,payment,{...reversal,reversalOfId:'charge'}];
  assert.deepEqual(validateSnapshot(snapshot).filter(v=>v.code.startsWith('allocation')),[]);
  assert.ok(validateAllocation({...allocation,id:'new'},payment,charge,snapshot.ledgerTransactions).some(v=>v.code==='allocation_charge_reversed'));
});
