import assert from "node:assert/strict";
import test from "node:test";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { deriveTenantNavigation, deriveTenantProfile, deriveRentRoll } from "./reports";

function fixture() {
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  snapshot.recurringSchedules.forEach(row => { row.billingFrequency = "monthly"; });
  const tenancy = snapshot.tenancies[0];
  snapshot.tenancies = [{ ...tenancy, status: "current", actualMoveInOn: "2025-01-01", actualMoveOutOn: undefined }];
  snapshot.leaseTerms = snapshot.leaseTerms.filter(row => row.tenancyId === tenancy.id);
  return { snapshot, tenancy: snapshot.tenancies[0] };
}
const filters = { asOfDate: "2026-09-12" as const };

test("past tenancy without a move-out cannot override the current tenancy or lend it rent", () => {
  const { snapshot, tenancy } = fixture();
  snapshot.tenancies.push({ ...tenancy, id: "former", status: "past", actualMoveInOn: "2026-01-01" });
  const original = snapshot.recurringSchedules.find(row => row.tenancyId === tenancy.id)!;
  snapshot.recurringSchedules.push({ ...original, id: "former-rent", tenancyId: "former", amountCents: 990000, lineageRootId: "former-rent" });
  const profile = deriveTenantProfile(snapshot, tenancy.primaryPersonId, filters)!;
  assert.equal(profile.tenancy?.id, tenancy.id);
  assert.equal(profile.tenancies?.length, 2);
  assert.ok(profile.schedules.some(row => row.id === "former-rent"));
  assert.ok(!profile.operationalScheduleIds?.includes("former-rent"));
  assert.equal(deriveTenantNavigation(snapshot, tenancy.primaryPersonId, filters)?.category, "current");
});

test("confirmed former interval remains available in historical occupancy", () => {
  const { snapshot, tenancy } = fixture();
  Object.assign(tenancy, { status: "past", actualMoveInOn: "2025-01-01", actualMoveOutOn: "2026-03-01", actualMoveInKnowledge: "source", actualMoveOutKnowledge: "source" });
  assert.equal(deriveTenantNavigation(snapshot, tenancy.primaryPersonId, { asOfDate: "2026-02-01" })?.category, "current");
  assert.equal(deriveRentRoll(snapshot, { asOfDate: "2026-02-01" }).find(row => row.unitId === tenancy.unitId)?.occupancy, "current");
  assert.equal(deriveTenantNavigation(snapshot, tenancy.primaryPersonId, filters)?.category, "former");
  assert.deepEqual(deriveTenantProfile(snapshot, tenancy.primaryPersonId, filters)?.operationalScheduleIds, []);
});

test("lease expiration does not end actual occupancy", () => {
  const { snapshot, tenancy } = fixture();
  snapshot.leaseTerms.forEach(row => { row.contractEndOn = "2026-01-31"; });
  assert.equal(deriveTenantNavigation(snapshot, tenancy.primaryPersonId, filters)?.category, "current");
  assert.equal(deriveRentRoll(snapshot, filters).find(row => row.unitId === tenancy.unitId)?.occupancy, "current");
});

test("competing current tenants do not yield an arbitrary selected profile", () => {
  const { snapshot, tenancy } = fixture();
  snapshot.tenancies.push({ ...tenancy, id: "conflict", primaryPersonId: "other" });
  const navigation = deriveTenantNavigation(snapshot, tenancy.primaryPersonId, filters)!;
  assert.equal(navigation.category, "unknown");
  assert.equal(navigation.tenancy, undefined);
  assert.throws(() => deriveRentRoll(snapshot, filters), /Overlapping/);
});

test("unknown status with move-in evidence is never promoted to current", () => {
  const { snapshot, tenancy } = fixture();
  Object.assign(tenancy, { status: null, statusKnowledge: "unknown" });
  assert.equal(deriveTenantNavigation(snapshot, tenancy.primaryPersonId, filters)?.category, "unknown");
  assert.deepEqual(deriveTenantProfile(snapshot, tenancy.primaryPersonId, filters)?.operationalScheduleIds, []);
});

test("unconfirmed old rent is reviewable but not a rent-roll amount or zero total", () => {
  const { snapshot, tenancy } = fixture();
  const rent = snapshot.recurringSchedules.find(row => row.tenancyId === tenancy.id && row.category === "base_rent")!;
  rent.effectiveFrom = undefined;
  rent.effectiveFromKnowledge = "unknown_open_start";
  const row = deriveRentRoll(snapshot, filters).find(row => row.unitId === tenancy.unitId)!;
  assert.equal(row.baseRentCents, undefined);
  assert.equal(row.totalScheduledCents, null);
  assert.ok(row.exceptionCodes.includes("scheduled_amount_unconfirmed"));
  const profile = deriveTenantProfile(snapshot, tenancy.primaryPersonId, filters)!;
  assert.ok(profile.schedules.some(row => row.id === rent.id));
  assert.ok(!profile.operationalScheduleIds?.includes(rent.id));
  assert.equal(profile.operationalSchedulesComplete, false);
});

test("register and profile share current IDs and keep past and missing-cadence rows separate", async () => {
  const { deriveOperationalScheduleRegister } = await import("./reports");
  const { snapshot, tenancy } = fixture();
  const rent = snapshot.recurringSchedules.find(row => row.tenancyId === tenancy.id && row.category === "base_rent")!;
  snapshot.tenancies.push({ ...tenancy, id: "past-register", status: "past" });
  snapshot.recurringSchedules.push({ ...rent, id: "past-register-rent", tenancyId: "past-register", lineageRootId: "past-register-rent" });
  const register = deriveOperationalScheduleRegister(snapshot, filters);
  const profile = deriveTenantProfile(snapshot, tenancy.primaryPersonId, filters)!;
  assert.ok(register.currentScheduleIds.includes(rent.id));
  assert.ok(register.historicalScheduleIds.includes("past-register-rent"));
  assert.ok(!profile.operationalScheduleIds?.includes("past-register-rent"));
  assert.ok(profile.operationalScheduleIds?.every(id => register.currentScheduleIds.includes(id)));
  rent.billingFrequency = null;
  const unknown = deriveOperationalScheduleRegister(snapshot, filters);
  assert.ok(!unknown.currentScheduleIds.includes(rent.id));
  assert.ok(unknown.reviewScheduleIds.includes(rent.id));
  snapshot.recurringSchedules = snapshot.recurringSchedules.filter(row => row.id !== "past-register-rent");
  assert.equal(deriveRentRoll(snapshot, filters).find(row => row.unitId === tenancy.unitId)?.baseRentCents, undefined);
});

test("source Past account excludes old schedules only on or after its observation", async () => {
  const { deriveOperationalScheduleRegister } = await import("./reports");
  const { snapshot, tenancy } = fixture();
  const person = snapshot.people.find(row => row.id === tenancy.primaryPersonId)!;
  Object.assign(person, { sourceAccountFacts: { status: "past", rawStatus: "Past", statusKnowledge: "source", postingStartOn: null, postingEndOn: null, postingStartKnowledge: "unknown", postingEndKnowledge: "unknown", observedOn: "2026-09-10", artifactSha256: "a".repeat(64) } });
  const rent = snapshot.recurringSchedules.find(row => row.tenancyId === tenancy.id && row.category === "base_rent")!;
  const before = deriveOperationalScheduleRegister(snapshot, { asOfDate: "2026-09-09" });
  assert.ok(before.currentScheduleIds.includes(rent.id));
  const after = deriveOperationalScheduleRegister(snapshot, filters);
  assert.ok(!after.currentScheduleIds.includes(rent.id));
  assert.ok(after.historicalScheduleIds.includes(rent.id));
  assert.equal(tenancy.actualMoveOutOn, undefined);
});

test("shared unit default belongs to current partition once even when a future tenancy inherits it", async () => {
  const { deriveOperationalScheduleRegister } = await import("./reports");
  const { snapshot, tenancy } = fixture();
  tenancy.expectedMoveOutOn = "2026-09-30";
  snapshot.tenancies.push({ ...tenancy, id: "upcoming", primaryPersonId: "next-person", status: "future", actualMoveInOn: undefined, plannedMoveInOn: "2026-10-01" });
  const original = snapshot.recurringSchedules[0];
  snapshot.recurringSchedules = [{ ...original, scopeType: "unit", scopeId: tenancy.unitId, tenancyId: undefined, personId: undefined }];
  const register = deriveOperationalScheduleRegister(snapshot, filters);
  assert.deepEqual(register.currentScheduleIds, [original.id]);
  assert.deepEqual(register.futureScheduleIds, []);
  assert.deepEqual(register.unitDefaultScheduleIds, [original.id]);
});

test("future schedule remains review when current occupancy has no departure boundary", async () => {
  const { deriveOperationalScheduleRegister } = await import("./reports");
  const { snapshot, tenancy } = fixture();
  snapshot.people.push({ id: "next-person", firstName: "Next", lastName: "Resident" });
  snapshot.tenancies.push({ ...tenancy, id: "upcoming", primaryPersonId: "next-person", status: "future", actualMoveInOn: undefined, plannedMoveInOn: "2026-10-01" });
  const original = snapshot.recurringSchedules[0];
  snapshot.recurringSchedules.push({ ...original, id: "future-rent", lineageRootId: "future-rent", scopeId: "next-person", personId: "next-person", tenancyId: "upcoming", effectiveFrom: "2026-10-01" });
  const register = deriveOperationalScheduleRegister(snapshot, filters);
  assert.ok(!register.futureScheduleIds.includes("future-rent"));
  assert.ok(register.reviewScheduleIds.includes("future-rent"));
});

test("copied unit IDs with unknown tenancy links cannot establish current charges", async () => {
  const { deriveOperationalScheduleRegister } = await import("./reports");
  const { snapshot, tenancy } = fixture();
  tenancy.unitLinkKnowledge = "unknown";
  const register = deriveOperationalScheduleRegister(snapshot, filters);
  assert.deepEqual(register.currentScheduleIds, []);
  assert.equal(deriveTenantNavigation(snapshot, tenancy.primaryPersonId, filters)?.category, "unknown");
  const roll = deriveRentRoll(snapshot, filters).find(row => row.unitId === tenancy.unitId)!;
  assert.equal(roll.occupancy, "unknown");
  assert.equal(roll.baseRentCents, undefined);
  assert.ok(roll.exceptionCodes.includes("tenancy_link_unknown"));
});
