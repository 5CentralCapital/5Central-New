import assert from "node:assert/strict";
import test from "node:test";

import {
  addressLines,
  propertyUnitFieldValue,
  propertyUnitFieldUnverified,
  unitLayoutLabel,
  buildPropertyEditValues,
  buildUnitEditValues,
  occupancyHistoryForUnit,
  propertyUnitListItems,
  propertyUnitRecurringDisplay,
  recurringRecordCreateValues,
  recurringRecordSuccessorValues,
  propertyUnits,
  recurringSchedulesForUnit,
  recurringSchedulesForProperty,
  resolvePropertyUnitSelection,
} from "./property-unit-model";
import type { AdminSnapshot, AdminSnapshotView } from "../types";

function makeSnapshot(overrides: Partial<AdminSnapshotView> = {}): AdminSnapshot {
  const snapshot: AdminSnapshotView = {
    properties: [],
    units: [],
    people: [],
    householdMemberships: [],
    tenancies: [],
    leaseTerms: [],
    recurringSchedules: [],
    ledgerTransactions: [],
    paymentAllocations: [],
    securityDeposits: [],
    subsidyContracts: [],
    applications: [],
    applicationHouseholdMembers: [],
    applicationRequirements: [],
    documents: [],
    activityEvents: [],
    ...overrides,
  };
  return { snapshot } as unknown as AdminSnapshot;
}

test("address rendering does not repeat city, state, or postal code already in line1", () => {
  assert.deepEqual(addressLines({ line1: "123 Main St, Tampa, FL 33601", city: "Tampa", state: "FL", postalCode: "33601" }), ["123 Main St, Tampa, FL 33601"]);
  assert.deepEqual(addressLines({ line1: "123 Main St", city: "Tampa", state: "FL", postalCode: "33601" }), ["123 Main St", "Tampa, FL 33601"]);
  assert.deepEqual(addressLines({ line1: "123 Main St, Tampa", city: "Tampa", state: "FL", postalCode: "33601" }), ["123 Main St, Tampa", "FL 33601"]);
});

test("property and unit search keeps the matching property context and filters archived scope", () => {
  const snapshot = makeSnapshot({
    properties: [
      { id: "property:one", name: "Maple Court", state: "active", address: { line1: "1 Maple Way", city: "Tampa", state: "FL" } },
      { id: "property:two", name: "Cedar Court", state: "archived", address: { line1: "2 Cedar Way", city: "Tampa", state: "FL" } },
    ],
    units: [
      { id: "unit:one", propertyId: "property:one", unitNumber: "A-101", readiness: "ready" },
      { id: "unit:two", propertyId: "property:one", unitNumber: "A-202", readiness: "not_ready" },
      { id: "unit:three", propertyId: "property:two", unitNumber: "B-101", readiness: "ready" },
    ],
  });
  const rows = propertyUnitListItems(snapshot, { propertyId: "all", propertyScope: "active" }, "A-202");
  assert.deepEqual(rows.map((row) => [row.kind, row.id]), [["property", "property:one"], ["unit", "unit:two"]]);
  assert.equal(propertyUnitListItems(snapshot, { propertyId: "all", propertyScope: "active" }, "Cedar").length, 0);
  assert.equal(propertyUnitListItems(snapshot, { propertyId: "all", propertyScope: "all" }, "Cedar")[0]?.id, "property:two");
});

test("selection honors a unit URL target and otherwise defaults to the first matched property", () => {
  const snapshot = makeSnapshot({
    properties: [{ id: "property:one", name: "First", state: "active" }, { id: "property:two", name: "Second", state: "active" }],
    units: [{ id: "unit:two", propertyId: "property:two", unitNumber: "2" }],
  });
  assert.equal(resolvePropertyUnitSelection(snapshot, { propertyId: "all", propertyScope: "active" })?.property?.id, "property:one");
  assert.equal(resolvePropertyUnitSelection(snapshot, { propertyId: "all", propertyScope: "active" }, undefined, "unit:two")?.kind, "unit");
  assert.equal(resolvePropertyUnitSelection(snapshot, { propertyId: "all", propertyScope: "active" }, "property:two")?.property?.id, "property:two");
});

test("edit values preserve the record identity and current revision while leaving unknown amounts blank", () => {
  const property = { id: "property:one", recordRevision: 8, name: "Maple Court", slug: "maple", propertyType: "multifamily", state: "active", address: { line1: "1 Maple Way", city: "Tampa", state: "FL", postalCode: "33601" }, operatingContact: "Operations" };
  const unit = { id: "unit:one", recordRevision: 13, propertyId: "property:one", unitNumber: "A-101", unitType: "1/1", marketRentCents: undefined, defaultDepositCents: 125000, bedrooms: undefined, bathrooms: 1, squareFeet: undefined, readiness: "ready", listing: "listed" };
  assert.deepEqual(buildPropertyEditValues(property), {
    id: "property:one", revision: 8, name: "Maple Court", slug: "maple", address1: "1 Maple Way", city: "Tampa", stateCode: "FL", postalCode: "33601", propertyType: "multifamily", propertyState: "active", operatingContact: "Operations",
  });
  const values = buildUnitEditValues(unit);
  assert.equal(values.id, "unit:one");
  assert.equal(values.revision, 13);
  assert.equal(values.marketRentDollars, "");
  assert.equal(values.defaultDepositDollars, "1250");
  assert.equal(values.bedrooms, "");
});

test("occupancy history remains unknown without a known linked tenancy even when market rent exists", () => {
  const snapshot = makeSnapshot({ properties: [{ id: "property:one", state: "active" }], units: [{ id: "unit:one", propertyId: "property:one", marketRentCents: 150000 }] });
  const rows = occupancyHistoryForUnit(snapshot, snapshot.snapshot.units[0]!);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.occupancyStatus, "unknown");
  assert.equal(rows[0]?.tenancy, undefined);
});

test("recurring schedules distinguish direct unit charges from inherited property charges", () => {
  const snapshot = makeSnapshot({
    properties: [{ id: "property:one", state: "active" }],
    units: [{ id: "unit:one", propertyId: "property:one", unitNumber: "A-101" }],
    recurringSchedules: [
      { id: "schedule:unit", scopeType: "unit", scopeId: "unit:one", propertyId: "property:one", unitId: "unit:one", category: "recurring_fee", amountCents: 5000 },
      { id: "schedule:property", scopeType: "property", scopeId: "property:one", propertyId: "property:one", category: "recurring_fee", amountCents: 2500 },
    ],
  });
  assert.deepEqual(recurringSchedulesForUnit(snapshot, snapshot.snapshot.units[0]!).map((row) => [row.schedule.id, row.relationship]), [["schedule:unit", "direct"], ["schedule:property", "inherited"]]);
});


test("uncertain current status and resident links cannot become confirmed occupancy", () => {
  const snapshot = makeSnapshot({
    units: [{ id: "u", propertyId: "p" }],
    people: [{ id: "person", firstName: "Sample", lastName: "Resident" }],
    tenancies: [{ id: "t", unitId: "u", status: "current", statusKnowledge: "unknown", primaryPersonId: "person", primaryPersonLinkKnowledge: "ambiguous" }],
  });
  const [row] = occupancyHistoryForUnit(snapshot, snapshot.snapshot.units[0]!);
  assert.equal(row?.occupancyStatus, "unknown");
  assert.equal(row?.occupantName, undefined);
});

test("unit billing follows known tenancy links and excludes unrelated and uncertain inherited scopes", () => {
  const snapshot = makeSnapshot({
    units: [{ id: "u", propertyId: "p", propertyLinkKnowledge: "unknown" }],
    tenancies: [{ id: "t", unitId: "u" }],
    recurringSchedules: [
      { id: "tenant", scopeType: "tenant", tenancyId: "t" },
      { id: "other", scopeType: "tenant", tenancyId: "other" },
      { id: "inherited", scopeType: "property", scopeId: "p" },
      { id: "direct", scopeType: "unit", scopeId: "u" },
    ],
  });
  assert.deepEqual(recurringSchedulesForUnit(snapshot, snapshot.snapshot.units[0]!).map((row) => row.schedule.id), ["tenant", "direct"]);
});

test("property billing includes unit scopes without redundant property ids and labels them accurately", () => {
  const snapshot = makeSnapshot({
    units: [{ id: "u", propertyId: "p" }, { id: "other", propertyId: "other-p" }],
    recurringSchedules: [
      { id: "unit", scopeType: "unit", scopeId: "u" },
      { id: "other", scopeType: "unit", scopeId: "other" },
      { id: "property", scopeType: "property", scopeId: "p" },
    ],
  });
  assert.deepEqual(recurringSchedulesForProperty(snapshot, "p").map((row) => [row.schedule.id, row.relationshipLabel]), [["unit", "Direct · unit"], ["property", "Direct · property"]]);
});

test("explicit property filtering prevents another property's URL record from bypassing scope", () => {
  const snapshot = makeSnapshot({ properties: [{ id: "p", state: "active" }, { id: "other", state: "active" }], units: [{ id: "other-u", propertyId: "other" }] });
  assert.equal(resolvePropertyUnitSelection(snapshot, { propertyId: "p", propertyScope: "all" }, "other", "other-u")?.property?.id, "p");
  assert.deepEqual(propertyUnitListItems(snapshot, { propertyId: "p", propertyScope: "all" }).map((row) => row.id), ["p"]);
});

test("directories retain natural property and unit ordering after an updated row moves to the end", () => {
  const properties = [{ id: "p10", name: "Court 10", state: "active" }, { id: "p2", name: "Court 2", state: "active" }];
  const units = [{ id: "u1", propertyId: "p2", unitNumber: "TEST 1" }, { id: "u2", propertyId: "p2", unitNumber: "TEST 2" }, { id: "u10", propertyId: "p2", unitNumber: "TEST 10" }];
  const initial = makeSnapshot({ properties, units });
  const updated = makeSnapshot({ properties: [...properties].reverse(), units: [units[2]!, units[1]!, { ...units[0]!, recordRevision: 2, readiness: "ready" }] });
  const filters = { propertyId: "all", propertyScope: "active" as const };
  const expected = ["p2", "u1", "u2", "u10", "p10"];
  assert.deepEqual(propertyUnitListItems(initial, filters).map((row) => row.id), expected);
  assert.deepEqual(propertyUnitListItems(updated, filters).map((row) => row.id), expected);
  assert.deepEqual(propertyUnits(updated, "p2").map((unit) => unit.id), ["u1", "u2", "u10"]);
  assert.equal(resolvePropertyUnitSelection(updated, filters)?.property?.id, "p2");
  const selected = resolvePropertyUnitSelection(updated, filters, "p2", "u1");
  assert.equal(selected?.unit?.id, "u1");
  assert.equal(selected?.unit?.recordRevision, 2);
  assert.deepEqual(updated.snapshot.units.map((unit) => unit.id), ["u10", "u2", "u1"], "Sorting does not mutate the shared snapshot");
});

test("equal and missing directory labels use stable identity ties", () => {
  const snapshot = makeSnapshot({ properties: [{ id: "p", name: "Court", state: "active" }], units: [{ id: "z", propertyId: "p" }, { id: "b", propertyId: "p", unitNumber: "A" }, { id: "a", propertyId: "p", unitNumber: "a" }] });
  assert.deepEqual(propertyUnits(snapshot, "p").map((unit) => unit.id), ["a", "b", "z"]);
});

test("property unit recurring display uses resolved replacement ends and fails closed without metadata", () => {
  const schedule = { id: "charge", scopeType: "property", scopeId: "p", active: true, effectiveFrom: "2026-01-01", effectiveTo: null, resolvedEffectiveTo: "2026-08-31", lineageState: "valid" as const, canScheduleSuccessor: false };
  const snapshot = makeSnapshot({ recurringSchedules: [schedule] });
  const [record] = recurringSchedulesForProperty(snapshot, "p");
  const display = propertyUnitRecurringDisplay(record!, "2026-09-12");
  assert.equal(display.effectiveTo, "2026-08-31");
  assert.equal(display.state, "ended");
  assert.equal(schedule.effectiveTo, null, "Immutable source end is unchanged");
  const unconfirmed = propertyUnitRecurringDisplay({ ...record!, schedule: { ...schedule, lineageState: undefined, resolvedEffectiveTo: undefined } }, "2026-09-12");
  assert.equal(unconfirmed.state, "unknown");
  assert.equal(unconfirmed.effectiveTo, undefined);
  assert.ok(unconfirmed.uncertaintyCodes.includes("schedule_lineage_unconfirmed"));
  const future = propertyUnitRecurringDisplay({ ...record!, schedule: { ...schedule, effectiveFrom: "2026-10-01", resolvedEffectiveTo: null } }, "2026-09-12");
  assert.equal(future.state, "future");
  assert.equal(future.effectiveTo, null);
});

test("record recurring actions require verified context and authoritative successor permission", () => {
  const unit = { id: "u", propertyId: "p" };
  const snapshot = makeSnapshot({ properties: [{ id: "p" }], units: [unit] });
  assert.deepEqual(recurringRecordCreateValues(snapshot, "p", unit), { propertyId: "p", unitId: "u", scopeType: "unit", scopeId: "u" });
  assert.equal(recurringRecordCreateValues(snapshot, "p", { ...unit, propertyLinkKnowledge: "unknown" }), undefined);
  const schedule = { id: "s", recordRevision: 3, propertyId: "p", scopeType: "unit", scopeId: "u", lineageState: "valid" as const, canScheduleSuccessor: true };
  assert.equal(recurringRecordSuccessorValues(snapshot, schedule)?.expectedRevision, 3);
  assert.equal(recurringRecordSuccessorValues(snapshot, { ...schedule, canScheduleSuccessor: false }), undefined);
  assert.equal(recurringRecordSuccessorValues(snapshot, { ...schedule, lineageState: undefined }), undefined);
  assert.equal(recurringRecordSuccessorValues(snapshot, { ...schedule, scopeId: "missing" }), undefined);
});

test("multiple chosen properties retain only their unit inventories",()=>{
 const snapshot=makeSnapshot({properties:[{id:'a',state:'active'},{id:'b',state:'active'},{id:'c',state:'active'}],units:[{id:'ua',propertyId:'a'},{id:'ub',propertyId:'b'},{id:'uc',propertyId:'c'}]});
 const filters={propertyId:'all',propertyIds:['a','b'],propertyScope:'active' as const};
 assert.deepEqual(propertyUnitListItems(snapshot,filters).map(row=>row.id),['a','ua','b','ub']);
 assert.notEqual(resolvePropertyUnitSelection(snapshot,filters,'c')?.property?.id,'c');
});


test("optional property metadata stays neutral while real values and explicit uncertainty remain available", () => {
  assert.equal(propertyUnitFieldValue(undefined), "—");
  assert.equal(propertyUnitFieldValue(" "), "—");
  assert.equal(propertyUnitFieldValue(0), "0");
  assert.equal(propertyUnitFieldValue("A complete long operating contact name"), "A complete long operating contact name");
  assert.equal(propertyUnitFieldUnverified("unknown"), true);
  assert.equal(propertyUnitFieldUnverified("manual"), false);
  assert.deepEqual(addressLines(undefined), []);
  assert.equal(unitLayoutLabel({ bedrooms: 0, bathrooms: 1 }), "0 bd · 1 ba");
  assert.equal(unitLayoutLabel({ bedrooms: 2 }), "2 bd");
  assert.equal(unitLayoutLabel({}), "—");
});
