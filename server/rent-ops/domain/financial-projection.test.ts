import assert from "node:assert/strict";
import test from "node:test";
import { emptyRentOpsSnapshot, type RentOpsSnapshot } from "../../../shared/rent-ops-contracts";
import { projectFinancialOccupancy, projectFinancialSchedules, resolveEffectiveScheduleVersions } from "./financial-projection";

function snapshotWithUnit(propertyId = "p1", unitId = "u1"): RentOpsSnapshot {
  const snapshot = emptyRentOpsSnapshot();
  snapshot.modelVersion = 3;
  snapshot.properties.push({ id: propertyId, name: `Property ${propertyId}`, slug: propertyId, address: { line1: "1 Main", city: "Town", state: "FL", postalCode: "00000" }, propertyType: "multifamily", state: "active" });
  snapshot.units.push({ id: unitId, propertyId, unitNumber: unitId, readiness: "ready", listing: "listed", propertyLinkKnowledge: "exact" });
  return snapshot;
}

function addLeaseBackedTenancy(snapshot: RentOpsSnapshot, input: { propertyId?: string; unitId?: string; personId?: string; tenancyId?: string; status?: "current" | "future" | "notice" | "past"; actualMoveInOn?: string; plannedMoveInOn?: string; actualMoveOutOn?: string }): void {
  const propertyId = input.propertyId ?? "p1";
  const unitId = input.unitId ?? "u1";
  const personId = input.personId ?? `person-${unitId}`;
  const tenancyId = input.tenancyId ?? `tenancy-${unitId}`;
  snapshot.people.push({ id: personId, firstName: "Synthetic", lastName: personId });
  const tenancy = { id: tenancyId, propertyId, unitId, primaryPersonId: personId, status: input.status ?? "current", createdAt: "2025-01-01T00:00:00.000Z" } as any;
  if (input.actualMoveInOn !== undefined) tenancy.actualMoveInOn = input.actualMoveInOn;
  else if ((input.status ?? "current") !== "future") tenancy.actualMoveInOn = "2025-01-01";
  if (input.plannedMoveInOn !== undefined) tenancy.plannedMoveInOn = input.plannedMoveInOn;
  if (input.actualMoveOutOn !== undefined) tenancy.actualMoveOutOn = input.actualMoveOutOn;
  tenancy.propertyLinkKnowledge = "exact";
  tenancy.unitLinkKnowledge = "exact";
  tenancy.primaryPersonLinkKnowledge = "exact";
  tenancy.statusKnowledge = "source";
  tenancy.actualMoveInKnowledge = tenancy.actualMoveInOn ? "source" : "unknown";
  tenancy.plannedMoveInKnowledge = tenancy.plannedMoveInOn ? "source" : "unknown";
  tenancy.actualMoveOutKnowledge = tenancy.actualMoveOutOn ? "source" : "unknown";
  snapshot.tenancies.push(tenancy);
  snapshot.leaseTerms.push({ id: `lease-${tenancyId}`, tenancyId, tenancyLinkKnowledge: "exact", status: "executed", statusKnowledge: "source", contractStartOn: "2025-01-01", contractStartKnowledge: "source", contractEndOn: "2026-12-31", contractEndKnowledge: "source", monthToMonth: false, monthToMonthKnowledge: "source", createdAt: "2025-01-01T00:00:00.000Z" });
}

function schedule(input: Record<string, unknown>): RentOpsSnapshot["recurringSchedules"][number] {
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(input, key);
  const scopeType = (has("scopeType") ? input.scopeType : undefined) as "tenant" | "unit" | "property" | null | undefined;
  const propertyId = (has("propertyId") ? input.propertyId : "p1") as string | null;
  const unitId = (has("unitId") ? input.unitId : null) as string | null;
  const personId = (has("personId") ? input.personId : null) as string | null;
  const defaultScopeId = scopeType === "unit" && typeof unitId === "string"
    ? unitId
    : scopeType === "tenant" && typeof personId === "string"
      ? personId
      : scopeType === "property" && typeof propertyId === "string"
        ? propertyId
        : null;
  const category = has("category") ? input.category : "base_rent";
  const amountCents = has("amountCents") ? input.amountCents : 1000;
  const effectiveFrom = has("effectiveFrom") ? input.effectiveFrom : "2025-01-01";
  const active = has("active") ? input.active : true;
  const chargeDefinitionId = has("chargeDefinitionId") ? input.chargeDefinitionId : null;
  return {
    id: String(input.id),
    source: { system: "rm", sourceId: `source:${String(input.id)}` },
    propertyId,
    scopeType,
    scopeId: (has("scopeId") ? input.scopeId : defaultScopeId) as string | null | undefined,
    scopeLinkKnowledge: (has("scopeLinkKnowledge") ? input.scopeLinkKnowledge : "exact") as any,
    scopeTypeKnowledge: (has("scopeTypeKnowledge") ? input.scopeTypeKnowledge : "source") as any,
    tenancyId: (has("tenancyId") ? input.tenancyId : null) as string | null,
    personId,
    unitId,
    category: category as never,
    categoryKnowledge: (has("categoryKnowledge") ? input.categoryKnowledge : category === null ? "unknown" : "source") as any,
    amountCents: amountCents as never,
    amountKnowledge: (has("amountKnowledge") ? input.amountKnowledge : amountCents === null ? "unknown" : "known") as any,
    effectiveFrom: effectiveFrom as any,
    effectiveFromKnowledge: (has("effectiveFromKnowledge") ? input.effectiveFromKnowledge : "source") as any,
    active: active as boolean | null,
    activeKnowledge: (has("activeKnowledge") ? input.activeKnowledge : "source") as any,
    chargeDefinitionId: chargeDefinitionId as string | null,
    chargeDefinitionLinkKnowledge: (has("chargeDefinitionLinkKnowledge") ? input.chargeDefinitionLinkKnowledge : chargeDefinitionId ? "exact" : "unknown") as any,
    chargeDefinitionKey: (has("chargeDefinitionKey") ? input.chargeDefinitionKey : null) as string | null,
    description: has("description") ? input.description as string | null : "synthetic",
    descriptionKnowledge: (has("descriptionKnowledge") ? input.descriptionKnowledge : "source") as any,
    sourceArtifactSha256: has("sourceArtifactSha256") ? input.sourceArtifactSha256 as string | null : "a".repeat(64),
    artifactObservationOn: has("artifactObservationOn") ? input.artifactObservationOn as any : "2025-01-01",
    lineageRootId: String(input.lineageRootId ?? input.id),
    lineageRootOrigin: "artifact",
    versionOrigin: "artifact",
    versionAction: "root",
  } as any;
}

test("month projection keeps a vacant unit vacant and unassigned unit schedules uncertain", () => {
  const snapshot = snapshotWithUnit();
  snapshot.recurringSchedules.push(schedule({ id: "s-vacant", scopeType: "unit", unitId: "u1" }));
  assert.equal(projectFinancialOccupancy(snapshot, snapshot.units[0], "2025-05").occupancy, "vacant");
  const result = projectFinancialSchedules(snapshot, "2025-05");
  assert.equal(result.knownCents, 0);
  assert.equal(result.unassignedCents, 0);
  assert.equal(result.rows.length, 0);
});

test("future occupancy requires planned move-in and an executed lease", () => {
  const snapshot = snapshotWithUnit();
  addLeaseBackedTenancy(snapshot, { status: "future", actualMoveInOn: undefined, plannedMoveInOn: "2025-06-15" });
  assert.equal(projectFinancialOccupancy(snapshot, snapshot.units[0], "2025-05").occupancy, "vacant");
  assert.equal(projectFinancialOccupancy(snapshot, snapshot.units[0], "2025-06").occupancy, "future_preleased");
});

test("current and past occupancy require exact lease overlap and actual dates", () => {
  const snapshot = snapshotWithUnit();
  addLeaseBackedTenancy(snapshot, { status: "current", actualMoveInOn: "2025-01-15" });
  assert.equal(projectFinancialOccupancy(snapshot, snapshot.units[0], "2025-02").occupancy, "current");
  snapshot.tenancies[0].status = "past";
  snapshot.tenancies[0].actualMoveOutOn = "2025-02-10";
  snapshot.tenancies[0].actualMoveOutKnowledge = "source";
  assert.equal(projectFinancialOccupancy(snapshot, snapshot.units[0], "2025-02").occupancy, "past");
  assert.equal(projectFinancialOccupancy(snapshot, snapshot.units[0], "2025-03").occupancy, "vacant");
});

test("an exact pre-month move-out remains excluded even when lease evidence is ambiguous", () => {
  const snapshot = snapshotWithUnit();
  addLeaseBackedTenancy(snapshot, { status: "past", actualMoveInOn: "2024-01-15", actualMoveOutOn: "2025-02-10" });
  snapshot.tenancies[0].actualMoveOutKnowledge = "source";
  snapshot.leaseTerms.push({ ...snapshot.leaseTerms[0], id: "lease-tenancy-u1-duplicate" });
  assert.equal(projectFinancialOccupancy(snapshot, snapshot.units[0], "2025-03").occupancy, "vacant");
});

test("duplicate overlapping lease identities remain unknown even when visible dates match", () => {
  const snapshot = snapshotWithUnit();
  addLeaseBackedTenancy(snapshot, { status: "current", actualMoveInOn: "2025-01-15" });
  snapshot.leaseTerms.push({ ...snapshot.leaseTerms[0], id: "lease-tenancy-u1-duplicate" });
  const projected = projectFinancialOccupancy(snapshot, snapshot.units[0], "2025-02");
  assert.equal(projected.occupancy, "unknown");
  assert.ok(projected.exceptionCodes.includes("lease_unknown"));
});

test("matching tenancy identifiers with unknown property-link evidence make the unit unknown, not vacant", () => {
  const snapshot = snapshotWithUnit();
  addLeaseBackedTenancy(snapshot, { status: "current", actualMoveInOn: "2025-01-15" });
  snapshot.tenancies[0].propertyLinkKnowledge = "unknown";
  const projected = projectFinancialOccupancy(snapshot, snapshot.units[0], "2025-02");
  assert.equal(projected.occupancy, "unknown");
  assert.ok(projected.exceptionCodes.includes("property_link_unknown"));
});

test("a former exact-tenancy schedule never applies to the current occupant", () => {
  const snapshot = snapshotWithUnit();
  addLeaseBackedTenancy(snapshot, { tenancyId: "former", personId: "former-person", status: "past", actualMoveInOn: "2024-01-01", actualMoveOutOn: "2025-01-31" });
  addLeaseBackedTenancy(snapshot, { tenancyId: "current", personId: "current-person", status: "current", actualMoveInOn: "2025-02-01" });
  // Both helper tenancies target u1; isolate the synthetic current row by
  // making the former schedule explicit and letting occupancy report the
  // simultaneous-source conflict as unknown rather than crossing identities.
  snapshot.tenancies[0].unitId = "u1";
  snapshot.tenancies[1].unitId = "u1";
  snapshot.recurringSchedules.push(schedule({ id: "s-former", scopeType: "tenant", tenancyId: "former", personId: "former-person" }));
  const result = projectFinancialSchedules(snapshot, "2025-02");
  assert.equal(result.rows.length, 0);
  assert.equal(result.notApplicableCount, 1);
});

test("person-only schedule does not cross a property or ambiguous historical tenancy", () => {
  const snapshot = snapshotWithUnit("p1", "u1");
  snapshot.properties.push({ id: "p2", name: "Property p2", slug: "p2", address: { line1: "2 Main", city: "Town", state: "FL", postalCode: "00000" }, propertyType: "multifamily", state: "active" });
  snapshot.units.push({ id: "u2", propertyId: "p2", unitNumber: "u2", readiness: "ready", listing: "listed" });
  addLeaseBackedTenancy(snapshot, { propertyId: "p2", unitId: "u2", personId: "same-person", tenancyId: "t2" });
  snapshot.recurringSchedules.push(schedule({ id: "s-person", scopeType: "tenant", personId: "same-person", propertyId: "p1", chargeDefinitionKey: "raw-source-key" }));
  const result = projectFinancialSchedules(snapshot, "2025-05");
  assert.equal(result.rows[0].unitId, undefined);
  assert.equal(result.rows[0].known, false);
  assert.equal(result.rows[0].exceptionCodes?.includes("schedule_person_assignment_ambiguous"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(result.rows[0], "chargeDefinitionKey"), false);
});

test("person-only schedule uses an exact corroborating unit before checking assignment ambiguity", () => {
  const snapshot = snapshotWithUnit("p1", "u1");
  snapshot.units.push({ id: "u2", propertyId: "p1", unitNumber: "u2", readiness: "ready", listing: "listed", propertyLinkKnowledge: "exact" });
  addLeaseBackedTenancy(snapshot, { propertyId: "p1", unitId: "u1", personId: "same-person", tenancyId: "t1" });
  addLeaseBackedTenancy(snapshot, { propertyId: "p1", unitId: "u2", personId: "same-person", tenancyId: "t2" });
  snapshot.recurringSchedules.push(schedule({ id: "s-person-u2", scopeType: "tenant", scopeId: "same-person", personId: "same-person", unitId: "u2", propertyId: "p1" }));
  const result = projectFinancialSchedules(snapshot, "2025-05");
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].unitId, "u2");
  assert.equal(result.rows[0].exceptionCodes?.includes("schedule_person_assignment_ambiguous"), false);
});

test("unknown occupancy, amount, and scope stay visible as uncertainty", () => {
  const snapshot = snapshotWithUnit();
  addLeaseBackedTenancy(snapshot, { status: "current", actualMoveInOn: undefined });
  snapshot.recurringSchedules.push(schedule({ id: "s-unknown", scopeType: undefined, amountCents: null, category: null }));
  const result = projectFinancialSchedules(snapshot, "2025-05");
  assert.equal(result.sourceRowCount, 1);
  assert.equal(result.unknownAmountCount, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].known, false);
  assert.equal(result.rows[0].amountCents, null);
});

test("future-before-move-in schedule is not applicable, not uncertain billing", () => {
  const snapshot = snapshotWithUnit();
  addLeaseBackedTenancy(snapshot, { status: "future", actualMoveInOn: undefined, plannedMoveInOn: "2025-07-15" });
  snapshot.recurringSchedules.push(schedule({ id: "s-future", scopeType: "tenant", tenancyId: "tenancy-u1", personId: "person-u1", amountCents: 1700 }));
  const result = projectFinancialSchedules(snapshot, "2025-06");
  assert.equal(result.rows.length, 0);
  assert.equal(result.notApplicableCount, 1);
  assert.equal(result.notApplicableCents, 1700);
  assert.equal(result.unassignedCents, 0);
});

test("property schedules emit once, while exact unit precedence prevents double count", () => {
  const snapshot = snapshotWithUnit();
  addLeaseBackedTenancy(snapshot, { status: "current" });
  snapshot.recurringSchedules.push(schedule({ id: "s-property", scopeType: "property", propertyId: "p1", chargeDefinitionId: "def-utility", amountCents: 500 }));
  snapshot.recurringSchedules.push(schedule({ id: "s-unit", scopeType: "unit", unitId: "u1", propertyId: "p1", chargeDefinitionId: "def-utility", amountCents: 700 }));
  snapshot.recurringSchedules.push(schedule({ id: "s-property-only", scopeType: "property", propertyId: "p1", chargeDefinitionId: "def-other", amountCents: 300 }));
  const result = projectFinancialSchedules(snapshot, "2025-05");
  assert.equal(result.propertyOnceCount, 2);
  assert.equal(result.suppressedByPrecedenceCount, 0);
  assert.equal(result.rows.filter((row) => row.chargeDefinitionId === "def-utility").length, 2);
  assert.equal(result.rows.filter((row) => row.chargeDefinitionId === "def-other").length, 1);
});

test("property-linked tenancy with unknown unit isolates every property unit as uncertain", () => {
  const snapshot = snapshotWithUnit("p1", "u1");
  snapshot.units.push({ id: "u2", propertyId: "p1", unitNumber: "u2", readiness: "ready", listing: "listed", propertyLinkKnowledge: "exact" });
  snapshot.people.push({ id: "property-person", firstName: "Synthetic", lastName: "Property" });
  snapshot.tenancies.push({ id: "property-tenancy", propertyId: "p1", unitId: undefined, primaryPersonId: "property-person", status: "current", actualMoveInOn: "2025-01-01", createdAt: "2025-01-01T00:00:00.000Z", propertyLinkKnowledge: "exact", unitLinkKnowledge: "unknown", primaryPersonLinkKnowledge: "exact", statusKnowledge: "source", actualMoveInKnowledge: "source" } as any);
  snapshot.leaseTerms.push({ id: "property-lease", tenancyId: "property-tenancy", tenancyLinkKnowledge: "exact", status: "executed", statusKnowledge: "source", contractStartOn: "2025-01-01", contractStartKnowledge: "source", contractEndOn: "2025-12-31", contractEndKnowledge: "source", monthToMonth: false, monthToMonthKnowledge: "source", createdAt: "2025-01-01T00:00:00.000Z" });
  assert.equal(projectFinancialOccupancy(snapshot, snapshot.units[0], "2025-05").occupancy, "unknown");
  assert.equal(projectFinancialOccupancy(snapshot, snapshot.units[1], "2025-05").occupancy, "unknown");
});

test("fixed-term unknown end is uncertain, while explicit month-to-month stays open", () => {
  const snapshot = snapshotWithUnit();
  addLeaseBackedTenancy(snapshot, { status: "current" });
  snapshot.leaseTerms[0].contractEndKnowledge = "unknown";
  assert.equal(projectFinancialOccupancy(snapshot, snapshot.units[0], "2025-05").occupancy, "unknown");
  snapshot.leaseTerms[0].status = "month_to_month";
  snapshot.leaseTerms[0].statusKnowledge = "manual";
  snapshot.leaseTerms[0].contractEndOn = undefined;
  snapshot.leaseTerms[0].monthToMonth = true;
  snapshot.leaseTerms[0].monthToMonthKnowledge = "manual";
  assert.equal(projectFinancialOccupancy(snapshot, snapshot.units[0], "2026-05").occupancy, "current");
});

test("invalid lineage is isolated from known totals and stays conserved as uncertainty", () => {
  const snapshot = snapshotWithUnit();
  addLeaseBackedTenancy(snapshot, { status: "current" });
  snapshot.recurringSchedules.push(schedule({ id: "root-invalid", scopeType: "unit", unitId: "u1", chargeDefinitionId: "def-invalid", amountCents: 500 }));
  snapshot.recurringSchedules.push({ ...schedule({ id: "successor-missing", scopeType: "unit", unitId: "u1", chargeDefinitionId: "def-invalid", amountCents: 600 }), source: undefined, lineageRootId: "root-invalid", lineageRootOrigin: "artifact", versionOrigin: "manual", versionAction: "replace", supersedesId: "missing-predecessor", effectiveFrom: "2025-06-01", effectiveFromKnowledge: "manual" } as any);
  const result = projectFinancialSchedules(snapshot, "2025-06");
  assert.equal(result.invalidLineageCount, 2);
  assert.equal(result.knownCents, 0);
  assert.equal(result.uncertainCents, 1100);
  assert.equal(result.sourceRowCount, 2);
  assert.ok(result.exceptionCodes.includes("schedule_lineage_predecessor_missing"));
});

test("unknown definition links remain distinct and duplicate property obligations conflict", () => {
  const snapshot = snapshotWithUnit();
  addLeaseBackedTenancy(snapshot, { status: "current" });
  snapshot.recurringSchedules.push(schedule({ id: "unknown-definition-a", scopeType: "unit", unitId: "u1", chargeDefinitionId: "def-unknown", chargeDefinitionLinkKnowledge: "unknown", amountCents: 200 }));
  snapshot.recurringSchedules.push(schedule({ id: "unknown-definition-b", scopeType: "unit", unitId: "u1", chargeDefinitionId: "def-unknown", chargeDefinitionLinkKnowledge: "unknown", amountCents: 300 }));
  snapshot.recurringSchedules.push(schedule({ id: "property-duplicate-a", scopeType: "property", propertyId: "p1", chargeDefinitionId: "def-property", amountCents: 400 }));
  snapshot.recurringSchedules.push(schedule({ id: "property-duplicate-b", scopeType: "property", propertyId: "p1", chargeDefinitionId: "def-property", amountCents: 450 }));
  const result = projectFinancialSchedules(snapshot, "2025-05");
  assert.equal(result.rows.filter((row) => row.chargeDefinitionId === "def-unknown").length, 2);
  assert.equal(result.propertyOnceCount, 0);
  assert.equal(result.exceptionCodes.includes("property_schedule_duplicate_conflict"), true);
});

test("unknown-open roots accept successors only at or after the approved observation boundary", () => {
  const base = schedule({ id: "open-root", scopeType: "unit", unitId: "u1", chargeDefinitionId: "def-open", amountCents: 100 });
  const root = { ...base, effectiveFrom: null, effectiveFromKnowledge: "unknown_open_start", sourceArtifactSha256: "a".repeat(64), artifactObservationOn: "2025-06-15", lineageRootId: "open-root", lineageRootOrigin: "artifact", versionAction: "root" } as any;
  const makeSuccessor = (id: string, effectiveFrom: string) => ({ ...base, id, source: undefined, lineageRootId: "open-root", lineageRootOrigin: "artifact", versionOrigin: "manual", versionAction: "replace", supersedesId: "open-root", effectiveFrom, effectiveFromKnowledge: "manual", sourceArtifactSha256: "a".repeat(64), artifactObservationOn: "2025-06-15" } as any);
  assert.equal(resolveEffectiveScheduleVersions([root, makeSuccessor("before", "2025-06-14")], "2025-06", { strictLineage: true }).invalidSchedules.length, 2);
  assert.equal(resolveEffectiveScheduleVersions([root, makeSuccessor("on", "2025-06-15")], "2025-06", { strictLineage: true }).invalidSchedules.length, 0);
  assert.equal(resolveEffectiveScheduleVersions([root, makeSuccessor("after", "2025-06-16")], "2025-06", { strictLineage: true }).invalidSchedules.length, 0);
  const tampered = { ...makeSuccessor("tampered", "2025-06-15"), artifactObservationOn: "2025-06-14" };
  assert.equal(resolveEffectiveScheduleVersions([root, tampered], "2025-06", { strictLineage: true }).invalidSchedules.length, 2);
});

test("artifact open-start roots apply from their own observation month forward, never before it", () => {
  const root = {
    ...schedule({ id: "artifact-open-forward", scopeType: "property", propertyId: "p1", amountCents: 900 }),
    effectiveFrom: null,
    effectiveFromKnowledge: "unknown_open_start",
    artifactObservationOn: "2025-06-15",
    sourceArtifactSha256: "a".repeat(64),
    lineageRootOrigin: "artifact",
    versionOrigin: "artifact",
  } as any;
  assert.equal(resolveEffectiveScheduleVersions([root], "2025-05", { strictLineage: true }).selectedSchedules.length, 0);
  assert.equal(resolveEffectiveScheduleVersions([root], "2025-06", { strictLineage: true }).selectedSchedules.length, 1);
  assert.equal(resolveEffectiveScheduleVersions([root], "2025-09", { strictLineage: true }).selectedSchedules.length, 1);
});

test("strict lineage rejects missing root/action and the legacy source-root action", () => {
  const missingRoot = { ...schedule({ id: "missing-root", scopeType: "unit", unitId: "u1" }), lineageRootId: undefined } as any;
  const missingAction = { ...schedule({ id: "missing-action", scopeType: "unit", unitId: "u1" }), versionAction: undefined } as any;
  const legacySource = { ...schedule({ id: "legacy-source", scopeType: "unit", unitId: "u1" }), versionAction: "source" } as any;
  const result = resolveEffectiveScheduleVersions([missingRoot, missingAction, legacySource], "2025-05", { strictLineage: true });
  assert.equal(result.invalidSchedules.length, 3);
  assert.ok(result.exceptionCodes.includes("schedule_lineage_root_or_action_missing"));
});

test("artifact and manual roots have distinct evidence boundaries", () => {
  const artifact = schedule({ id: "artifact-root", scopeType: "unit", unitId: "u1" });
  const manual = { ...schedule({ id: "manual-root", scopeType: "unit", unitId: "u1" }), source: undefined, lineageRootOrigin: "manual", versionOrigin: "manual", sourceArtifactSha256: null, artifactObservationOn: null, effectiveFromKnowledge: "manual" } as any;
  const valid = resolveEffectiveScheduleVersions([artifact, manual], "2025-05", { strictLineage: true });
  assert.equal(valid.invalidSchedules.length, 0);
  const manualOpen = { ...manual, id: "manual-open", lineageRootId: "manual-open", effectiveFrom: undefined, effectiveFromKnowledge: "unknown_open_start" } as any;
  const invalid = resolveEffectiveScheduleVersions([manualOpen], "2025-05", { strictLineage: true });
  assert.equal(invalid.invalidSchedules.length, 1);
  assert.ok(invalid.exceptionCodes.includes("schedule_lineage_manual_date_required"));
});

test("strict lineage rejects forged root and successor version provenance", () => {
  const artifact = schedule({ id: "provenance-artifact", scopeType: "unit", unitId: "u1" });
  const artifactWithoutSource = { ...artifact, id: "artifact-without-source", lineageRootId: "artifact-without-source", source: undefined } as any;
  const manualWithSource = { ...artifact, id: "manual-with-source", lineageRootId: "manual-with-source", lineageRootOrigin: "manual", versionOrigin: "manual", sourceArtifactSha256: null, artifactObservationOn: null, effectiveFromKnowledge: "manual" } as any;
  const successorWithSource = { ...artifact, id: "successor-with-source", lineageRootId: artifact.id, lineageRootOrigin: "artifact", versionOrigin: "manual", versionAction: "replace", supersedesId: artifact.id, effectiveFrom: "2025-06-01", effectiveFromKnowledge: "manual", amountCents: 1200, amountKnowledge: "known" } as any;
  const resolved = resolveEffectiveScheduleVersions([artifact, artifactWithoutSource, manualWithSource, successorWithSource], "2025-06", { strictLineage: true });
  assert.ok(resolved.invalidSchedules.some((row) => row.id === artifactWithoutSource.id));
  assert.ok(resolved.invalidSchedules.some((row) => row.id === manualWithSource.id));
  assert.ok(resolved.invalidSchedules.some((row) => row.id === successorWithSource.id));
  assert.ok(resolved.exceptionCodes.includes("schedule_lineage_version_provenance_invalid"));
});

test("known successors require known dates and continuous artifact identity", () => {
  const root = schedule({ id: "known-boundary-root", scopeType: "unit", unitId: "u1", chargeDefinitionId: "def-boundary" });
  const unknownDate = { ...root, id: "known-boundary-unknown-date", source: undefined, lineageRootId: root.id, lineageRootOrigin: "artifact", versionOrigin: "manual", versionAction: "replace", supersedesId: root.id, effectiveFrom: "2025-06-01", effectiveFromKnowledge: "unknown_open_start" } as any;
  const mismatchedArtifact = { ...root, id: "known-boundary-mismatched-artifact", source: undefined, lineageRootId: root.id, lineageRootOrigin: "artifact", versionOrigin: "manual", versionAction: "replace", supersedesId: root.id, effectiveFrom: "2025-06-01", effectiveFromKnowledge: "manual", sourceArtifactSha256: "b".repeat(64) } as any;
  assert.equal(resolveEffectiveScheduleVersions([root, unknownDate], "2025-06", { strictLineage: true }).invalidSchedules.length, 2);
  const result = resolveEffectiveScheduleVersions([root, mismatchedArtifact], "2025-06", { strictLineage: true });
  assert.equal(result.invalidSchedules.length, 2);
  assert.ok(result.exceptionCodes.includes("schedule_lineage_artifact_boundary_mismatch"));
});

test("successors cannot mutate inherited source facts or weaken link knowledge", () => {
  const root = schedule({ id: "immutable-facts-root", scopeType: "unit", unitId: "u1", chargeDefinitionId: "def-immutable", amountCents: 1000 });
  const changedDescription = { ...root, id: "immutable-facts-description", source: undefined, lineageRootId: root.id, versionOrigin: "manual", versionAction: "replace", supersedesId: root.id, effectiveFrom: "2025-06-01", effectiveFromKnowledge: "manual", amountCents: 1200, description: "Changed source description" } as any;
  const weakenedLink = { ...root, id: "immutable-facts-link", source: undefined, lineageRootId: root.id, versionOrigin: "manual", versionAction: "replace", supersedesId: root.id, effectiveFrom: "2025-06-01", effectiveFromKnowledge: "manual", amountCents: 1200, scopeLinkKnowledge: "unknown" } as any;
  for (const successor of [changedDescription, weakenedLink]) {
    const resolved = resolveEffectiveScheduleVersions([root, successor], "2025-06", { strictLineage: true });
    assert.equal(resolved.invalidSchedules.length, 2);
    assert.ok(resolved.exceptionCodes.includes("schedule_lineage_inherited_fact_mutation"));
  }
});

test("two valid versions select one winner and conserve the superseded version", () => {
  const root = schedule({ id: "two-version-root", scopeType: "unit", unitId: "u1", chargeDefinitionId: "def-version", amountCents: 1000 });
  const successor = { ...root, id: "two-version-successor", source: undefined, lineageRootId: root.id, lineageRootOrigin: "artifact", versionOrigin: "manual", versionAction: "replace", supersedesId: root.id, effectiveFrom: "2025-06-01", effectiveFromKnowledge: "manual", amountCents: 1200 } as any;
  const before = resolveEffectiveScheduleVersions([root, successor], "2025-05", { strictLineage: true });
  assert.deepEqual(before.schedules.map((row) => row.id), [root.id]);
  assert.deepEqual(before.futureSchedules.map((row) => row.id), [successor.id]);
  const after = resolveEffectiveScheduleVersions([root, successor], "2025-07", { strictLineage: true });
  assert.deepEqual(after.schedules.map((row) => row.id), [successor.id]);
  assert.deepEqual(after.supersededSchedules.map((row) => row.id), [root.id]);
  const projection = projectFinancialSchedules(snapshotWithUnit(), "2025-05");
  projection.rows.length; // keep the projection API type exercised by this fixture family
});

test("ended, inactive, and future winners are separate non-income buckets", () => {
  const rootEnd = schedule({ id: "ended-root", scopeType: "unit", unitId: "u1", chargeDefinitionId: "def-ended", amountCents: 1000 });
  const end = { ...rootEnd, id: "ended-version", source: undefined, lineageRootId: rootEnd.id, lineageRootOrigin: "artifact", versionOrigin: "manual", versionAction: "end", supersedesId: rootEnd.id, effectiveFrom: "2025-06-01", effectiveFromKnowledge: "manual", effectiveTo: "2025-06-01", amountCents: null, amountKnowledge: "unknown", active: false, activeKnowledge: "manual" } as any;
  const ended = projectFinancialSchedules(Object.assign(snapshotWithUnit(), { recurringSchedules: [rootEnd, end] }), "2025-07");
  assert.equal(ended.rows.length, 0);
  assert.equal(ended.endedCount, 1);
  assert.equal(ended.supersededCount, 1);
  assert.equal(ended.accountedRowCount, ended.sourceRowCount);

  const inactive = projectFinancialSchedules(Object.assign(snapshotWithUnit(), { recurringSchedules: [schedule({ id: "inactive", scopeType: "unit", unitId: "u1", active: false })] }), "2025-05");
  assert.equal(inactive.rows.length, 0);
  assert.equal(inactive.inactiveCount, 1);
  const future = projectFinancialSchedules(Object.assign(snapshotWithUnit(), { recurringSchedules: [schedule({ id: "future", scopeType: "unit", unitId: "u1", effectiveFrom: "2026-01-01" })] }), "2025-05");
  assert.equal(future.rows.length, 0);
  assert.equal(future.futureCount, 1);
});

test("an end tombstone remains terminal after its own effective date", () => {
  const root = schedule({ id: "terminal-boundary-root", scopeType: "unit", unitId: "u1", chargeDefinitionId: "def-terminal-boundary", amountCents: 1000 });
  const end = {
    ...root,
    id: "terminal-boundary-end",
    source: undefined,
    lineageRootId: root.id,
    lineageRootOrigin: "artifact",
    versionOrigin: "manual",
    versionAction: "end",
    supersedesId: root.id,
    effectiveFrom: "2025-06-01",
    effectiveFromKnowledge: "manual",
    effectiveTo: "2025-06-01",
    amountCents: null,
    amountKnowledge: "unknown",
    active: false,
    activeKnowledge: "manual",
  } as any;
  const snapshot = Object.assign(snapshotWithUnit(), { recurringSchedules: [root, end] });
  const afterEnd = projectFinancialSchedules(snapshot, "2025-10");
  const versions = resolveEffectiveScheduleVersions([root, end], "2025-10", { strictLineage: true });
  assert.equal(afterEnd.rows.length, 0);
  assert.deepEqual(versions.endedSchedules.map((row) => row.id), [end.id]);
  assert.deepEqual(versions.supersededSchedules.map((row) => row.id), [root.id]);
  assert.equal(afterEnd.accountedRowCount, afterEnd.sourceRowCount);
});

test("suppressed null amounts are counted once and remain diagnostic-only", () => {
  const snapshot = snapshotWithUnit();
  addLeaseBackedTenancy(snapshot, { tenancyId: "t-suppress", personId: "p-suppress", status: "current" });
  snapshot.recurringSchedules.push(schedule({ id: "unit-null", scopeType: "unit", unitId: "u1", chargeDefinitionId: "def-suppress", amountCents: null }));
  snapshot.recurringSchedules.push(schedule({ id: "tenant-winner", scopeType: "tenant", tenancyId: "t-suppress", personId: "p-suppress", chargeDefinitionId: "def-suppress", amountCents: 800 }));
  const result = projectFinancialSchedules(snapshot, "2025-05");
  assert.equal(result.rows.length, 1);
  assert.equal(result.suppressedByPrecedenceCount, 1);
  assert.equal(result.suppressedByPrecedenceCents, 0);
  assert.equal(result.unknownAmountCount, 1);
  assert.equal(result.accountedRowCount, result.sourceRowCount);
});

test("not-applicable null amounts are not uncertain income and are counted once", () => {
  const snapshot = snapshotWithUnit();
  snapshot.recurringSchedules.push(schedule({ id: "vacant-null", scopeType: "unit", unitId: "u1", amountCents: null }));
  const result = projectFinancialSchedules(snapshot, "2025-05");
  assert.equal(result.rows.length, 0);
  assert.equal(result.notApplicableCount, 1);
  assert.equal(result.notApplicableCents, 0);
  assert.equal(result.unknownAmountCount, 1);
  assert.equal(result.uncertainCents, 0);
  assert.equal(result.accountedRowCount, result.sourceRowCount);
});

test("property and unresolved tenant obligations appear once at property level, never per unit", () => {
  const snapshot = snapshotWithUnit();
  snapshot.units.push({ id: "u2", propertyId: "p1", unitNumber: "u2", readiness: "ready", listing: "listed", propertyLinkKnowledge: "exact" });
  addLeaseBackedTenancy(snapshot, { tenancyId: "t-one", personId: "p-one", unitId: "u1", status: "current" });
  addLeaseBackedTenancy(snapshot, { tenancyId: "t-two", personId: "p-two", unitId: "u2", status: "current" });
  snapshot.recurringSchedules.push(schedule({ id: "property-once", scopeType: "property", propertyId: "p1", chargeDefinitionId: "def-property", amountCents: 100 }));
  snapshot.recurringSchedules.push(schedule({ id: "exact-tenant", scopeType: "tenant", tenancyId: "t-one", personId: "p-one", propertyId: "p1", chargeDefinitionId: "def-tenant", amountCents: 200 }));
  snapshot.recurringSchedules.push(schedule({ id: "unresolved-tenant", scopeType: "tenant", propertyId: "p1", chargeDefinitionId: "def-unresolved", amountCents: 300 }));
  const property = projectFinancialSchedules(snapshot, "2025-05");
  assert.equal(property.sourceRowCount, 3);
  assert.equal(property.rows.length, 3);
  assert.equal(property.propertyOnceCount, 1);
  assert.equal(property.unassignedRowCount, 1);
  assert.equal(new Set(property.rows.map((row) => row.scheduleId)).size, 3);
  assert.equal(property.accountedRowCount, property.sourceRowCount);
  const unitOne = projectFinancialSchedules(snapshot, "2025-05", { unitId: "u1" });
  assert.equal(unitOne.sourceRowCount, 1);
  assert.deepEqual(unitOne.rows.map((row) => row.scheduleId), ["exact-tenant"]);
  const unitTwo = projectFinancialSchedules(snapshot, "2025-05", { unitId: "u2" });
  assert.equal(unitTwo.sourceRowCount, 0);
  assert.equal(unitTwo.rows.length, 0);
});

test("conservation buckets are disjoint and cover every filtered input version", () => {
  const snapshot = snapshotWithUnit();
  addLeaseBackedTenancy(snapshot, { tenancyId: "t-conserve", personId: "p-conserve", status: "current" });
  const root = schedule({ id: "conserve-root", scopeType: "unit", unitId: "u1", chargeDefinitionId: "def-conserve", amountCents: 100 });
  const successor = { ...root, id: "conserve-successor", source: undefined, lineageRootId: root.id, lineageRootOrigin: "artifact", versionOrigin: "manual", versionAction: "replace", supersedesId: root.id, effectiveFrom: "2025-06-01", effectiveFromKnowledge: "manual", amountCents: 150 } as any;
  snapshot.recurringSchedules.push(root, successor);
  snapshot.recurringSchedules.push(schedule({ id: "conserve-future", scopeType: "unit", unitId: "u1", effectiveFrom: "2026-01-01", amountCents: 200 }));
  snapshot.recurringSchedules.push(schedule({ id: "conserve-unresolved", scopeType: "tenant", amountCents: 250 }));
  const result = projectFinancialSchedules(snapshot, "2025-05");
  const disjoint = result.emittedKnownRowCount + result.emittedUncertainRowCount + result.unassignedRowCount + result.invalidLineageCount + result.supersededCount + result.endedCount + result.inactiveCount + result.futureCount + result.notApplicableCount + result.suppressedByPrecedenceCount;
  assert.equal(result.accountedRowCount, disjoint);
  assert.equal(result.accountedRowCount, result.sourceRowCount);
  assert.equal(result.unknownAmountCount, 0);
});

test("canonical unit scopeId assigns and filters a schedule when copied unitId is absent", () => {
  const snapshot = snapshotWithUnit();
  snapshot.units.push({ id: "u2", propertyId: "p1", unitNumber: "u2", readiness: "ready", listing: "listed", propertyLinkKnowledge: "exact" });
  addLeaseBackedTenancy(snapshot, { tenancyId: "t-scope", personId: "p-scope", unitId: "u1", status: "current" });
  snapshot.recurringSchedules.push(schedule({ id: "scope-id-only", scopeType: "unit", scopeId: "u1", unitId: undefined, chargeDefinitionId: "def-scope", amountCents: 900 }));
  snapshot.recurringSchedules.push(schedule({ id: "scope-copy-conflict", scopeType: "unit", scopeId: "u1", unitId: "u2", chargeDefinitionId: "def-conflict", amountCents: 400 }));

  const portfolio = projectFinancialSchedules(snapshot, "2025-05");
  assert.equal(portfolio.rows.find((row) => row.scheduleId === "scope-id-only")?.unitId, "u1");
  assert.equal(portfolio.rows.find((row) => row.scheduleId === "scope-copy-conflict")?.unitId, undefined);
  assert.equal(portfolio.unassignedRowCount, 1);
  assert.equal(portfolio.accountedRowCount, portfolio.sourceRowCount);

  const unitOne = projectFinancialSchedules(snapshot, "2025-05", { unitId: "u1" });
  assert.deepEqual(unitOne.rows.map((row) => row.scheduleId), ["scope-id-only"]);
  assert.equal(unitOne.sourceRowCount, 1);
  const unitTwo = projectFinancialSchedules(snapshot, "2025-05", { unitId: "u2" });
  assert.equal(unitTwo.rows.length, 0);
  assert.equal(unitTwo.sourceRowCount, 0);
});

test("conflicting convenience links never broaden canonical property, unit, or tenant scope", () => {
  const snapshot = snapshotWithUnit();
  addLeaseBackedTenancy(snapshot, { tenancyId: "t-canonical", personId: "p-canonical", unitId: "u1", status: "current" });
  snapshot.recurringSchedules.push(
    schedule({ id: "property-narrow-link", scopeType: "property", scopeId: "p1", propertyId: "p1", unitId: "u1", chargeDefinitionId: "def-property-conflict" }),
    schedule({ id: "unit-person-link", scopeType: "unit", scopeId: "u1", unitId: "u1", personId: "p-canonical", chargeDefinitionId: "def-unit-conflict" }),
    schedule({ id: "tenant-person-conflict", scopeType: "tenant", scopeId: "p-canonical", tenancyId: "t-canonical", personId: "different-person", propertyId: "p1", unitId: "u1", chargeDefinitionId: "def-tenant-conflict" }),
  );
  const portfolio = projectFinancialSchedules(snapshot, "2025-05");
  assert.equal(portfolio.unassignedRowCount, 3);
  assert.equal(portfolio.knownCents, 0);
  assert.equal(portfolio.accountedRowCount, portfolio.sourceRowCount);
  assert.equal(projectFinancialSchedules(snapshot, "2025-05", { unitId: "u1" }).sourceRowCount, 0);
});

test("an end version is terminal and any replace or end successor invalidates the lineage", () => {
  for (const successorAction of ["replace", "end"] as const) {
    const root = schedule({ id: `terminal-${successorAction}-root`, scopeType: "unit", unitId: "u1", chargeDefinitionId: `def-terminal-${successorAction}`, amountCents: 100 });
    const ended = { ...root, id: `terminal-${successorAction}-end`, source: undefined, lineageRootId: root.id, lineageRootOrigin: "artifact", versionOrigin: "manual", versionAction: "end", supersedesId: root.id, effectiveFrom: "2025-06-01", effectiveFromKnowledge: "manual", effectiveTo: "2025-06-01", amountCents: null, amountKnowledge: "unknown", active: false, activeKnowledge: "manual" } as any;
    const successor = { ...root, id: `terminal-${successorAction}-successor`, source: undefined, lineageRootId: root.id, lineageRootOrigin: "artifact", versionOrigin: "manual", versionAction: successorAction, supersedesId: ended.id, effectiveFrom: "2025-07-01", effectiveFromKnowledge: "manual", amountCents: successorAction === "replace" ? 120 : null, amountKnowledge: successorAction === "replace" ? "known" : "unknown" } as any;
    const resolved = resolveEffectiveScheduleVersions([root, ended, successor], "2025-08", { strictLineage: true });
    assert.equal(resolved.invalidSchedules.length, 3);
    assert.equal(resolved.schedules.length, 0);
    assert.ok(resolved.exceptionCodes.includes("schedule_lineage_end_terminal"));

    const snapshot = Object.assign(snapshotWithUnit(), { recurringSchedules: [root, ended, successor] });
    const projection = projectFinancialSchedules(snapshot, "2025-08");
    assert.equal(projection.knownCents, 0);
    assert.equal(projection.invalidLineageCount, 3);
    assert.equal(projection.accountedRowCount, projection.sourceRowCount);
  }
});

test("explicit null schedule facts remain null in uncertainty output", () => {
  const snapshot = snapshotWithUnit();
  snapshot.recurringSchedules.push(schedule({
    id: "null-canary",
    propertyId: null,
    scopeType: null,
    scopeId: null,
    scopeTypeKnowledge: null,
    scopeLinkKnowledge: null,
    category: null,
    categoryKnowledge: null,
    description: null,
    descriptionKnowledge: null,
    amountCents: null,
    amountKnowledge: null,
    active: null,
    activeKnowledge: null,
    chargeDefinitionId: null,
    chargeDefinitionLinkKnowledge: null,
  }));

  const result = projectFinancialSchedules(snapshot, "2025-05");
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.deepEqual({
    propertyId: row.propertyId,
    propertyName: row.propertyName,
    scopeType: row.scopeType,
    category: row.category,
    description: row.description,
    amountCents: row.amountCents,
    amountKnowledge: row.amountKnowledge,
    categoryKnowledge: row.categoryKnowledge,
    chargeDefinitionId: row.chargeDefinitionId,
    chargeDefinitionLinkKnowledge: row.chargeDefinitionLinkKnowledge,
  }, {
    propertyId: null,
    propertyName: null,
    scopeType: null,
    category: null,
    description: null,
    amountCents: null,
    amountKnowledge: null,
    categoryKnowledge: null,
    chargeDefinitionId: null,
    chargeDefinitionLinkKnowledge: null,
  });
  assert.equal(result.knownCents, 0);
  assert.equal(result.uncertainCents, 0);
  assert.equal(result.unknownAmountCount, 1);
  assert.equal(result.unassignedRowCount, 1);
  assert.equal(result.accountedRowCount, result.sourceRowCount);
  assert.ok(result.exceptionCodes.includes("schedule_scope_unknown"));
  assert.equal(projectFinancialSchedules(snapshot, "2025-05", { unitId: "u1" }).sourceRowCount, 0);
});

test("scope values are canonical only with source/manual type and exact/manual link knowledge", () => {
  const snapshot = snapshotWithUnit();
  addLeaseBackedTenancy(snapshot, { status: "current" });
  snapshot.recurringSchedules.push(
    schedule({ id: "type-inferred", scopeType: "unit", scopeId: "u1", unitId: null, scopeTypeKnowledge: "inferred", scopeLinkKnowledge: "exact", chargeDefinitionId: "def-inferred" }),
    schedule({ id: "link-ambiguous", scopeType: "unit", scopeId: "u1", unitId: null, scopeTypeKnowledge: "source", scopeLinkKnowledge: "ambiguous", chargeDefinitionId: "def-ambiguous" }),
  );

  const portfolio = projectFinancialSchedules(snapshot, "2025-05");
  assert.equal(portfolio.rows.length, 2);
  assert.equal(portfolio.unassignedRowCount, 2);
  assert.equal(portfolio.knownCents, 0);
  assert.equal(portfolio.accountedRowCount, portfolio.sourceRowCount);
  assert.equal(projectFinancialSchedules(snapshot, "2025-05", { unitId: "u1" }).sourceRowCount, 0);
});

test("confirmed holdover occupancy and rent agree across monthly projection and rent roll", async () => {
  const { deriveRentRoll, deriveScheduledIncome, deriveTenantProfile } = await import("./reports");
  const snapshot = snapshotWithUnit();
  addLeaseBackedTenancy(snapshot, { tenancyId: "holdover", personId: "resident" });
  snapshot.leaseTerms[0].contractEndOn = "2026-09-15";
  const rent = schedule({ id: "holdover-rent", scopeType: "tenant", scopeId: "resident", tenancyId: "holdover", personId: "resident", unitId: "u1", chargeDefinitionId: "rent", amountCents: 145000 });
  rent.billingFrequency = "monthly";
  snapshot.recurringSchedules.push(rent);
  const filters = { asOfDate: "2026-10-01", month: "2026-10" };
  const occupancy = projectFinancialOccupancy(snapshot, snapshot.units[0], "2026-10", filters.asOfDate);
  assert.equal(occupancy.occupancy, "current");
  assert.equal(occupancy.tenancyId, "holdover");
  assert.ok(occupancy.exceptionCodes.includes("lease_unknown"));
  const roll = deriveRentRoll(snapshot, filters)[0];
  assert.equal(roll.tenancyId, "holdover");
  assert.equal(roll.baseRentCents, 145000);
  const income = deriveScheduledIncome(snapshot, filters);
  assert.deepEqual(income.map(row => [row.tenancyId, row.scheduleId, row.amountCents, row.known]), [["holdover", "holdover-rent", 145000, true]]);
  assert.deepEqual(deriveTenantProfile(snapshot, "resident", filters)?.operationalScheduleIds, ["holdover-rent"]);
  snapshot.tenancies[0].status = "past";
  snapshot.tenancies[0].actualMoveOutOn = "2026-09-20";
  snapshot.tenancies[0].actualMoveOutKnowledge = "source";
  assert.equal(projectFinancialOccupancy(snapshot, snapshot.units[0], "2026-10").occupancy, "vacant");
  assert.equal(deriveRentRoll(snapshot, filters)[0].occupancy, "vacant");
  assert.equal(deriveScheduledIncome(snapshot, filters).length, 0);
});

test("monthly occupancy respects dated Past account evidence without rewriting earlier observations", () => {
  const snapshot = snapshotWithUnit();
  addLeaseBackedTenancy(snapshot, { tenancyId: "ended", personId: "resident", status: "past" });
  snapshot.people[0].sourceAccountFacts = { status: "past", rawStatus: "Past", statusKnowledge: "source", postingStartOn: null, postingEndOn: null, postingStartKnowledge: "unknown", postingEndKnowledge: "unknown", observedOn: "2026-09-07", artifactSha256: "a".repeat(64) };
  assert.equal(projectFinancialOccupancy(snapshot, snapshot.units[0], "2026-09", "2026-09-06").occupancy, "unknown");
  assert.equal(projectFinancialOccupancy(snapshot, snapshot.units[0], "2026-09", "2026-09-07").occupancy, "vacant");
  assert.equal(snapshot.tenancies[0].actualMoveOutOn, undefined);
});
