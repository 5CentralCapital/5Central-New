import assert from "node:assert/strict";
import test from "node:test";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { snapshotHash } from "./maintenance";
import { prepareOccupancyEstablishment } from "./occupancy-establishment-proposal";
function fixture() {
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  const person = snapshot.people[0], unit = snapshot.units[0], property = snapshot.properties.find(row => row.id === unit.propertyId)!;
  person.source = { system: "rent_manager", entityType: "person", sourceId: "980" };
  unit.source = { system: "rent_manager", entityType: "unit", sourceId: "186" };
  property.source = { system: "rent_manager", entityType: "property", sourceId: "30" };
  snapshot.tenancies = snapshot.tenancies.filter(row => row.unitId !== unit.id && row.primaryPersonId !== person.id);
  const request = { expectedSnapshotSha256: snapshotHash(snapshot), personSourceId: "980", unitSourceId: "186", propertySourceId: "30", occupiedAsOf: "2026-09-08", leaseStartOn: "2026-09-01", leaseEndOn: "2027-08-31", monthlyBaseCents: 155000, monthlyFeeCents: 3500, evidence: [{path: "/evidence", sha256: "a".repeat(64), reference: "Explicit owner occupancy confirmation"}] };
  return { snapshot, request };
}
test("prepares exact identity guards without inventing move-in, activation or posting dates", () => {
  const { snapshot, request } = fixture(), before = structuredClone(snapshot);
  const proposal = prepareOccupancyEstablishment(snapshot, request);
  assert.equal(proposal.state, "proposal_only_not_executable");
  assert.equal(proposal.occupancyEvidence.actualMoveInOn, null);
  assert.equal(proposal.proposedLease.contractStartOn, "2026-09-01");
  assert.equal(proposal.proposedMonthlyObligations.reduce((sum, row) => sum + row.amountCents, 0), 158500);
  assert.deepEqual(snapshot, before);
});
test("rejects stale snapshots and ambiguous source identities", () => {
  const { snapshot, request } = fixture();
  snapshot.people[0].displayName += " changed";
  assert.throws(() => prepareOccupancyEstablishment(snapshot, request), /Snapshot changed/);
  snapshot.people.push({ ...snapshot.people[0], id: "duplicate" });
  request.expectedSnapshotSha256 = snapshotHash(snapshot);
  assert.throws(() => prepareOccupancyEstablishment(snapshot, request), /identity_not_unique/);
});
test("rejects an existing current or future assignment instead of creating competing occupancy", () => {
  const { snapshot, request } = fixture();
  snapshot.tenancies.push({ id: "existing-future", propertyId: snapshot.units[0].propertyId, unitId: snapshot.units[0].id, primaryPersonId: snapshot.people[0].id, status: "future", plannedMoveInOn: "2026-10-01", createdAt: "2026-09-01T00:00:00Z" });
  request.expectedSnapshotSha256 = snapshotHash(snapshot);
  assert.throws(() => prepareOccupancyEstablishment(snapshot, request), /Existing occupancy or future assignment/);
});
