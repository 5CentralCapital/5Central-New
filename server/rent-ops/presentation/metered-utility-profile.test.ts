import assert from "node:assert/strict";
import test from "node:test";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { deriveTenantProfile } from "../domain/reports";
import { serializeAdminTenantProfile } from "./entities";
import { decodeMeteredUtility } from "../../../client/src/features/rent-ops/api";

test("confirmed future metered water flows through selected profile without fixed charges", () => {
  const snapshot = syntheticRentOpsSnapshot();
  const tenancy = snapshot.tenancies[0];
  const observation = { schema: "metered_utility_v1", id: "utility:test", tenancyId: tenancy.id, personId: tenancy.primaryPersonId, propertyId: tenancy.propertyId, unitId: tenancy.unitId, utility: "water", billingMethod: "metered", effectiveFrom: "2026-10-01", amountCents: null, amountKnowledge: "unknown", reviewedAt: "2026-09-12T12:00:00Z", reviewedBy: "Manager", evidenceReference: "private evidence", evidenceSha256: "a".repeat(64) };
  const before = deriveTenantProfile(snapshot, tenancy.primaryPersonId, { asOfDate: "2026-09-12" })!;
  snapshot.activityEvents.push({ id: observation.id, tenancyId: tenancy.id, personId: tenancy.primaryPersonId, propertyId: tenancy.propertyId, unitId: tenancy.unitId, type: "note", occurredAt: observation.reviewedAt, actor: observation.reviewedBy, summary: "Metered water", detail: JSON.stringify(observation) });
  const profile = deriveTenantProfile(snapshot, tenancy.primaryPersonId, { asOfDate: "2026-09-12" })!;
  const visible = serializeAdminTenantProfile(profile, snapshot.recurringSchedules);
  assert.equal(visible.meteredUtilities?.length, 1);
  assert.deepEqual(decodeMeteredUtility(visible.meteredUtilities![0]), { utility: "water", billingMethod: "metered", effectiveFrom: "2026-10-01", amountCents: null, amountKnowledge: "unknown" });
  assert.deepEqual(profile.schedules, before.schedules);
  assert.deepEqual(profile.ledger, before.ledger);
  assert.deepEqual(deriveTenantProfile(snapshot, tenancy.primaryPersonId, { asOfDate: "2026-09-11" })?.meteredUtilities, []);
});
