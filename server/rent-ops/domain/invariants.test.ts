import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyRentOpsSnapshot,
  type RentOpsRecurringChargeSchedule,
  type RentOpsSnapshot,
} from "../../../shared/rent-ops-contracts";
import {
  assertApplicationStatusTransition,
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

function manualBaseSchedule(id: string, overrides: Partial<RentOpsRecurringChargeSchedule> = {}): RentOpsRecurringChargeSchedule {
  return knownSchedule(id, {
    lineageRootOrigin: "manual",
    versionOrigin: "manual",
    sourceArtifactSha256: null,
    artifactObservationOn: null,
    effectiveFromKnowledge: "manual",
    ...overrides,
  });
}

function replacementSchedule(predecessor: RentOpsRecurringChargeSchedule, id: string, effectiveFrom: string, amountCents = 120_000): RentOpsRecurringChargeSchedule {
  return {
    ...predecessor,
    id,
    source: undefined,
    versionOrigin: "manual",
    versionAction: "replace",
    supersedesId: predecessor.id,
    effectiveFrom,
    effectiveFromKnowledge: "manual",
    amountCents,
    amountKnowledge: "known",
  };
}

function endSchedule(predecessor: RentOpsRecurringChargeSchedule, id: string, effectiveFrom: string): RentOpsRecurringChargeSchedule {
  return {
    ...predecessor,
    id,
    source: undefined,
    versionOrigin: "manual",
    versionAction: "end",
    supersedesId: predecessor.id,
    effectiveFrom,
    effectiveFromKnowledge: "manual",
    effectiveTo: effectiveFrom,
    amountCents: null,
    amountKnowledge: "unknown",
    active: false,
    activeKnowledge: "manual",
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

test("base-rent overlap uses effective lineage intervals after a terminal end", () => {
  const root = manualBaseSchedule("ended-root", { effectiveFrom: "2025-01-01", effectiveTo: "2025-12-31" });
  const end = endSchedule(root, "ended-root-end", "2025-06-01");
  const futureRoot = manualBaseSchedule("future-root", { effectiveFrom: "2025-07-01", effectiveTo: "2025-12-31" });
  assert.deepEqual(baseRentScheduleViolations([root, end, futureRoot]), []);

  assert.deepEqual(effectiveSchedules([root, end], "t1", "2025-05-31", { unitId: "u1", propertyId: "p1" }).map((schedule) => schedule.id), [root.id]);
  assert.deepEqual(effectiveSchedules([root, end], "t1", "2025-06-01", { unitId: "u1", propertyId: "p1" }), []);

  const historicalOverlap = manualBaseSchedule("historical-overlap", { effectiveFrom: "2025-05-01", effectiveTo: "2025-05-31" });
  const violations = baseRentScheduleViolations([root, end, historicalOverlap]);
  assert.ok(violations.some((violation) => violation.entityId === historicalOverlap.id));
});

test("base-rent overlap accepts a valid replacement chain but rejects an external overlap", () => {
  const root = manualBaseSchedule("replacement-root", { effectiveFrom: "2025-01-01", effectiveTo: "2025-12-31" });
  const first = replacementSchedule(root, "replacement-v2", "2025-06-01");
  const second = replacementSchedule(first, "replacement-v3", "2025-09-01", 130_000);
  assert.deepEqual(baseRentScheduleViolations([root, first, second]), []);
  assert.deepEqual(effectiveSchedules([root, first, second], "t1", "2025-05-31", { unitId: "u1", propertyId: "p1" }).map((schedule) => schedule.id), [root.id]);
  assert.deepEqual(effectiveSchedules([root, first, second], "t1", "2025-06-01", { unitId: "u1", propertyId: "p1" }).map((schedule) => schedule.id), [first.id]);
  assert.deepEqual(effectiveSchedules([root, first, second], "t1", "2025-09-01", { unitId: "u1", propertyId: "p1" }).map((schedule) => schedule.id), [second.id]);

  const external = manualBaseSchedule("replacement-external", { effectiveFrom: "2025-08-15", effectiveTo: "2025-08-20" });
  const violations = baseRentScheduleViolations([root, first, second, external]);
  assert.ok(violations.some((violation) => violation.entityId === external.id));
});

test("malformed or forked schedule lineage falls back conservatively and cannot hide overlap", () => {
  const root = manualBaseSchedule("fork-root", { effectiveFrom: "2025-01-01", effectiveTo: "2025-12-31" });
  const branchOne = replacementSchedule(root, "fork-v2-a", "2025-06-01");
  const branchTwo = replacementSchedule(root, "fork-v2-b", "2025-07-01");
  const external = manualBaseSchedule("fork-external", { effectiveFrom: "2025-08-01", effectiveTo: "2025-08-31" });
  const violations = baseRentScheduleViolations([root, branchOne, branchTwo, external]);
  assert.ok(violations.some((violation) => violation.entityId === external.id));

  const orphan = replacementSchedule(root, "orphan-successor", "2025-06-01");
  orphan.supersedesId = "missing-predecessor";
  const orphanOverlap = manualBaseSchedule("orphan-external", { effectiveFrom: "2025-08-01", effectiveTo: "2025-08-31" });
  assert.ok(baseRentScheduleViolations([root, orphan, orphanOverlap]).some((violation) => violation.entityId === orphanOverlap.id));
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


test("source application progress cannot bypass manual approval or conversion", () => {
  for (const status of ["complete", "in_progress", "awaiting_payment"] as const) {
    assert.doesNotThrow(() => assertApplicationStatusTransition(status, status));
    assert.doesNotThrow(() => assertApplicationStatusTransition(status, "missing_information"));
    assert.throws(() => assertApplicationStatusTransition(status, "approved"));
    assert.throws(() => assertApplicationStatusTransition(status, "converted"));
  }
  assert.doesNotThrow(() => assertApplicationStatusTransition("complete", "under_review"));
  assert.doesNotThrow(() => assertApplicationStatusTransition("in_progress", "submitted"));
  assert.doesNotThrow(() => assertApplicationStatusTransition("awaiting_payment", "submitted"));
});


test('artifact-bound source update retains a future-effective allocation created before an NSF', async () => {
 const { validateAllocation }=await import('./invariants');
 const payment={id:'p',kind:'payment' as const,status:'posted' as const,propertyId:'property',amountCents:18935,postedOn:'2023-10-23'} as any;
 const charge={...payment,id:'c',kind:'charge'};
 const reversal={...payment,id:'r',kind:'reversal',reversalOfId:'p',postedOn:'2023-10-26'};
 const allocation={id:'7318',paymentTransactionId:'p',chargeTransactionId:'c',amountCents:18935,allocatedOn:'2023-11-01',paymentLinkKnowledge:'exact',chargeLinkKnowledge:'exact',sourceArtifactSha256:'a'.repeat(64),source:{system:'rent_manager',entityType:'payment_allocation',sourceId:'7318',sourceUpdatedAt:'2023-10-24T05:04:01Z'}} as any;
 assert.deepEqual(validateAllocation(allocation,payment,charge,[payment,charge,reversal],true),[]);
 assert.equal(allocation.allocatedOn,'2023-11-01');
 assert.ok(validateAllocation(allocation,payment,charge,[payment,charge,reversal]).some(v=>v.code==='allocation_payment_reversed'));
 for(const change of [{sourceArtifactSha256:null},{source:{...allocation.source,sourceUpdatedAt:'2023-10-27T05:04:01Z'}},{source:{...allocation.source,sourceUpdatedAt:'invalid'}},{paymentLinkKnowledge:'unknown'}]) assert.ok(validateAllocation({...allocation,...change},payment,charge,[payment,charge,reversal],true).some(v=>v.code==='allocation_payment_reversed'));
});

test("v3 absent unit link stays unknown while every present tenancy reference is validated", async () => {
  const { syntheticRentOpsSnapshot } = await import("../fixtures/synthetic");
  const snapshot = syntheticRentOpsSnapshot(); snapshot.modelVersion = 3;
  const tenancy = snapshot.tenancies[0]; tenancy.unitId = ""; tenancy.unitLinkKnowledge = "unknown";
  const own = () => validateSnapshot(snapshot).filter((v) => v.entityId === tenancy.id && v.code === "tenancy_reference_invalid");
  assert.equal(own().length, 0);
  const originalProperty = tenancy.propertyId; tenancy.propertyId = "invalid-present";
  assert.equal(own().length, 1);
  tenancy.propertyId = originalProperty; tenancy.unitId = "invalid-present";
  assert.equal(own().length, 1);
  tenancy.unitId = ""; tenancy.unitLinkKnowledge = "ambiguous";
  assert.equal(own().length, 1);
});


test('source cancellation preserves dates when a future prepay application was already recorded before NSF',async()=>{
 const {syntheticRentOpsSnapshot}=await import('../fixtures/synthetic');
 const {validateAllocation}=await import('./invariants');
 const snapshot=syntheticRentOpsSnapshot(),base=snapshot.ledgerTransactions[0];
 const payment={...base,id:'1892',kind:'payment' as const,amountCents:75000,postedOn:'2023-10-23'};
 const charge={...base,id:'2853',kind:'charge' as const,amountCents:75000,postedOn:'2023-11-01'};
 snapshot.ledgerTransactions=[payment,charge,{...payment,id:'nsf',kind:'reversal',status:'posted',reversalOfId:'1892',postedOn:'2023-10-26'}];
 const positive={id:'7318',kind:'allocation' as const,paymentTransactionId:'1892',chargeTransactionId:'2853',amountCents:18935,allocatedOn:'2023-11-01',paymentLinkKnowledge:'exact' as const,chargeLinkKnowledge:'exact' as const,amountKnowledge:'known' as const,allocatedOnKnowledge:'source' as const,sourceArtifactSha256:'a'.repeat(64),artifactObservationOn:'2026-09-07',source:{system:'rent_manager',entityType:'payment_allocation' as const,sourceId:'7318',sourceUpdatedAt:'2023-10-24T01:04:01Z'}};
 const negative={...positive,id:'7359',kind:'reversal' as const,amountCents:-18935,allocatedOn:'2023-10-26',source:{...positive.source,sourceId:'7359',sourceUpdatedAt:'2023-10-26T07:09:22Z'}};
 snapshot.paymentAllocations=[positive,negative];
 assert.deepEqual(validateSnapshot(snapshot).filter(v=>v.code.startsWith('allocation')),[]);
 assert.equal(snapshot.paymentAllocations[0].allocatedOn,'2023-11-01');assert.equal(snapshot.paymentAllocations[1].allocatedOn,'2023-10-26');
 assert.ok(validateAllocation(negative,payment,charge,snapshot.ledgerTransactions,false,snapshot.paymentAllocations).some(v=>v.code==='allocation_predates_charge'));
 for(const invalid of [{...positive,sourceArtifactSha256:'b'.repeat(64)},{...positive,source:{...positive.source,sourceUpdatedAt:'2023-10-27T01:04:01Z'}},{...positive,amountCents:18934}]) {snapshot.paymentAllocations=[invalid,negative];assert.ok(validateSnapshot(snapshot).some(v=>v.code==='allocation_reversal_exceeds_history'));}
});
