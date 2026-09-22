import assert from "node:assert/strict";
import test from "node:test";

import type { RentOpsRecordChange } from "../../../shared/rent-ops-contracts";
import { createSyntheticRentOpsRepository } from "../fixtures/synthetic";

test("synthetic repository transactions commit completely or roll back completely", async () => {
  const repository = createSyntheticRentOpsRepository();
  const before = await repository.getSnapshot();
  await assert.rejects(() => repository.transaction(async (staged) => {
    await staged.saveProperty({ id: "rollback-property", name: "Rollback", slug: "rollback", address: { line1: "1 Test Way", city: "Test", state: "FL", postalCode: "00000" }, propertyType: "other", state: "active" });
    throw new Error("synthetic failure");
  }), /synthetic failure/);
  assert.deepEqual(await repository.getSnapshot(), before);

  await repository.transaction(async (staged) => {
    await staged.saveProperty({ id: "committed-property", name: "Committed", slug: "committed", address: { line1: "2 Test Way", city: "Test", state: "FL", postalCode: "00000" }, propertyType: "other", state: "active" });
  });
  assert.ok((await repository.getSnapshot()).properties.some((property) => property.id === "committed-property"));
});

test("synthetic manual recurring root persists its change atomically and idempotently", async () => {
  const repository = createSyntheticRentOpsRepository();
  const root = {
    id: "manual-root-atomic",
    scopeType: "tenant" as const,
    scopeId: "demo-person-1",
    scopeTypeKnowledge: "manual" as const,
    scopeLinkKnowledge: "manual" as const,
    chargeDefinitionId: "demo-charge-definition-base-rent",
    chargeDefinitionKey: "base_rent",
    chargeDefinitionKnowledge: "manual" as const,
    chargeDefinitionLinkKnowledge: "manual" as const,
    tenancyId: "demo-tenancy-1",
    personId: "demo-person-1",
    propertyId: "demo-property-a",
    unitId: "demo-unit-a-1",
    category: "base_rent" as const,
    categoryKnowledge: "manual" as const,
    description: "Manual root",
    descriptionKnowledge: "manual" as const,
    amountCents: 120000,
    amountKnowledge: "known" as const,
    effectiveFrom: "2026-08-17" as const,
    effectiveFromKnowledge: "manual" as const,
    effectiveTo: null,
    active: true,
    activeKnowledge: "manual" as const,
    sourceConfidence: "confirmed" as const,
    lineageRootId: "manual-root-atomic",
    lineageRootOrigin: "manual" as const,
    versionOrigin: "manual" as const,
    versionAction: "root" as const,
    recordRevision: 1,
  };
  const change: RentOpsRecordChange = {
    id: "change:manual-root-atomic:1",
    entityType: "recurring_schedule",
    targetId: root.id,
    revision: 1,
    origin: "admin",
    actorSubject: "synthetic-admin",
    occurredAt: "2026-08-17T12:00:00.000Z",
    changedFields: ["amountCents"],
  };
  const first = await repository.saveRecurringScheduleRoot!({ schedule: root, change });
  const second = await repository.saveRecurringScheduleRoot!({ schedule: root, change });
  assert.equal(first.id, root.id);
  assert.equal(second.id, root.id);
  assert.equal((await repository.getSnapshot()).recurringSchedules.filter((schedule) => schedule.id === root.id).length, 1);
  assert.equal((await repository.getRecordChanges!()).filter((row) => row.id === change.id).length, 1);

  const successor = {
    ...root,
    id: "manual-root-atomic-successor",
    source: undefined,
    lineageRootId: root.id,
    supersedesId: root.id,
    versionAction: "replace" as const,
    effectiveFrom: "2026-09-01" as const,
    effectiveFromKnowledge: "manual" as const,
    recordRevision: 2,
  };
  await assert.rejects(
    () => Reflect.apply(repository.saveRecurringScheduleSuccessor!, repository, [{ predecessorId: root.id, successor, expectedRevision: 1 }]),
    /authenticated change record/i,
  );
  assert.equal((await repository.getSnapshot()).recurringSchedules.some((row) => row.id === successor.id), false, "an unaudited direct successor must not append");

  const forged = { ...root, id: "manual-root-forged", lineageRootId: "manual-root-forged", sourceArtifactSha256: "a".repeat(64) };
  await assert.rejects(() => repository.saveRecurringScheduleRoot!({ schedule: forged, change: { ...change, id: "change:manual-root-forged:1", targetId: forged.id } }), /artifact provenance/i);
});

test("synthetic artifact recurring roots reject half or empty source identity pairs", async () => {
  const repository = createSyntheticRentOpsRepository();
  const base = (await repository.getSnapshot()).recurringSchedules[0];
  for (const [suffix, source] of [
    ["missing-source-id", { system: "rent_manager", entityType: "recurring_schedule", sourceId: "" }],
    ["missing-system", { system: "", entityType: "recurring_schedule", sourceId: "schedule-source" }],
  ] as const) {
    const artifactRoot = {
      ...base,
      id: `artifact-half-pair-${suffix}`,
      personId: base.personId ?? null,
      effectiveTo: base.effectiveTo ?? null,
      source: source as never,
      sourceArtifactSha256: "a".repeat(64),
      artifactObservationOn: "2026-08-17",
      lineageRootId: `artifact-half-pair-${suffix}`,
      lineageRootOrigin: "artifact" as const,
      versionOrigin: "artifact" as const,
      supersedesId: null,
      versionAction: "root" as const,
      recordRevision: 1,
    };
    await assert.rejects(() => repository.saveRecurringSchedule(artifactRoot), /artifact provenance/i);
  }
});
