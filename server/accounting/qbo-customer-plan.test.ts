import assert from "node:assert/strict";
import test from "node:test";
import { buildQboCustomerPlan, cleanQboNamePart, owningEntities, qboCustomerDisplayName, QBO_CUSTOMER_DISPLAY_NAME_MAX, type PlanEntity, type PlanTenancy, type QboCustomerPlanInput } from "./qbo-customer-plan";

const ENTITY_A = "20000000-0000-4000-8000-00000000000a";
const ENTITY_B = "20000000-0000-4000-8000-00000000000b";
const ENTITY_C = "20000000-0000-4000-8000-00000000000c";

function tenancy(id: string, overrides: Partial<PlanTenancy> = {}): PlanTenancy {
  return { tenancyId: id, sourceId: id.replace("t-", ""), status: "current", tenantName: `Synthetic Tenant ${id}`, propertyId: "prop-a", propertyName: "Oak Court", unitNumber: "1A", startOn: "2024-01-01", endOn: null, ...overrides };
}

function entity(legalEntityId: string, overrides: Partial<PlanEntity> = {}): PlanEntity {
  return { legalEntityId, name: `Entity ${legalEntityId.at(-1)}`, realmId: `9${legalEntityId.at(-1)!.charCodeAt(0)}`, mirrorRead: true, names: [], ...overrides };
}

function input(overrides: Partial<QboCustomerPlanInput> = {}): QboCustomerPlanInput {
  return {
    environment: "production", asOf: "2026-09-23",
    tenancies: [],
    periods: [
      { propertyId: "prop-a", legalEntityId: ENTITY_A, from: "2020-01-01", until: null },
      { propertyId: "prop-b", legalEntityId: ENTITY_A, from: "2020-01-01", until: "2025-06-01" },
      { propertyId: "prop-b", legalEntityId: ENTITY_B, from: "2025-06-01", until: null },
      { propertyId: "prop-c", legalEntityId: ENTITY_C, from: "2020-01-01", until: null },
    ],
    entities: [entity(ENTITY_A), entity(ENTITY_B), entity(ENTITY_C, { realmId: null })],
    links: [],
    ...overrides,
  };
}

const rowsOf = (plan: ReturnType<typeof buildQboCustomerPlan>) => plan.entities.flatMap(group => group.rows);
const rowFor = (plan: ReturnType<typeof buildQboCustomerPlan>, tenancyId: string) => rowsOf(plan).find(row => row.tenancyId === tenancyId)!;

test("display names follow the scheme, drop colons and control characters, and never truncate the RM id", () => {
  assert.deepEqual(qboCustomerDisplayName({ tenantName: "Ada Example", propertyName: "Oak Court", unitNumber: "1A", sourceKey: "4411" }), { displayName: "Ada Example · Oak Court 1A · RM4411", truncated: false });
  assert.equal(cleanQboNamePart("  Unit:\t2\nRear  "), "Unit 2 Rear");
  assert.deepEqual(qboCustomerDisplayName({ tenantName: "Ada\tExample", propertyName: "Oak: Court", unitNumber: "Apt:1", sourceKey: "id:77" }), { displayName: "Ada Example · Oak Court Apt 1 · RMid77", truncated: false });
  const long = qboCustomerDisplayName({ tenantName: "Maximiliana Alexandrina Bartholomew-Featherstonehaugh", propertyName: "The Extraordinarily Long Named Garden Apartments at Riverside", unitNumber: "1204-B", sourceKey: "123456789" })!;
  assert.equal(long.truncated, true);
  assert.ok(long.displayName.length <= QBO_CUSTOMER_DISPLAY_NAME_MAX, `${long.displayName.length}`);
  assert.equal(long.displayName.length, QBO_CUSTOMER_DISPLAY_NAME_MAX);
  assert.ok(long.displayName.endsWith("… · RM123456789"), long.displayName);
  assert.ok(long.displayName.startsWith("Maximiliana Alexandrina"));
  assert.doesNotMatch(long.displayName, /[:\t\n]/);
  // A unit equal to the property label is not repeated; a missing tenant name is explicit.
  assert.equal(qboCustomerDisplayName({ tenantName: null, propertyName: "12 Elm St", unitNumber: "12 Elm St", sourceKey: "9" })!.displayName, "Unknown tenant · 12 Elm St · RM9");
  // An id that leaves no room for a readable name is refused rather than cut.
  assert.equal(qboCustomerDisplayName({ tenantName: "A", propertyName: "B", unitNumber: null, sourceKey: "x".repeat(90) }), null);
});

test("ownership is decided by the property's entity periods for the tenancy dates", () => {
  const periods = input().periods;
  assert.deepEqual(owningEntities(tenancy("t-1", { propertyId: "prop-b", startOn: "2023-01-01", endOn: "2024-12-31" }), periods, "2026-09-23"), { owner: ENTITY_A, entityIds: [ENTITY_A] });
  assert.deepEqual(owningEntities(tenancy("t-2", { propertyId: "prop-b", startOn: "2025-06-01" }), periods, "2026-09-23"), { owner: ENTITY_B, entityIds: [ENTITY_B] });
  // until is exclusive: a tenancy ending the day before the sale stays with the seller.
  assert.deepEqual(owningEntities(tenancy("t-3", { propertyId: "prop-b", startOn: "2024-01-01", endOn: "2025-05-31" }), periods, "2026-09-23"), { owner: ENTITY_A, entityIds: [ENTITY_A] });
  assert.deepEqual(owningEntities(tenancy("t-4", { propertyId: "prop-b", startOn: "2024-01-01" }), periods, "2026-09-23"), { owner: ENTITY_B, entityIds: [ENTITY_A, ENTITY_B] });
  assert.deepEqual(owningEntities(tenancy("t-5", { propertyId: "prop-z" }), periods, "2026-09-23"), { owner: null, entityIds: [] });
});

test("the plan classifies create, former, linked, blocked, ownership change, matches and collisions per entity", () => {
  const plan = buildQboCustomerPlan(input({
    tenancies: [
      tenancy("t-1"),
      tenancy("t-2", { status: "past", endOn: "2025-02-28" }),
      tenancy("t-3"),
      tenancy("t-4", { tenantName: "Match Person" }),
      tenancy("t-5", { tenantName: "Vendor Clash" }),
      tenancy("t-6", { tenantName: "Linked Elsewhere" }),
      tenancy("t-7", { propertyId: "prop-b", propertyName: "Birch Row", startOn: "2024-01-01" }),
      tenancy("t-8", { propertyId: "prop-c", propertyName: "Cedar Flats" }),
      tenancy("t-9", { propertyId: "prop-z", propertyName: "Unowned" }),
      tenancy("t-10", { status: "cancelled" }),
      tenancy("t-11", { tenantName: "Twin", sourceId: "500" }),
      tenancy("t-12", { tenantName: "Twin", sourceId: "500" }),
      tenancy("t-13", { tenantName: "Employee Clash" }),
    ],
    entities: [
      entity(ENTITY_A, { names: [
        { objectType: "Customer", objectId: "58", displayName: "  match person · oak court 1a · RM4 " },
        { objectType: "Vendor", objectId: "70", displayName: "Vendor Clash · Oak Court 1A · RM5" },
        { objectType: "Customer", objectId: "61", displayName: "LINKED ELSEWHERE · OAK COURT 1A · RM6" },
        { objectType: "Employee", objectId: "80", displayName: "Employee Clash · Oak Court 1A · RM13" },
        { objectType: "Customer", objectId: "99", displayName: "Unrelated Customer" },
      ] }),
      entity(ENTITY_B),
      entity(ENTITY_C, { realmId: null }),
    ],
    links: [
      { tenancyId: "t-3", customerObjectId: "57", legalEntityId: ENTITY_A, realmId: "997" },
      { tenancyId: "t-other", customerObjectId: "61", legalEntityId: ENTITY_A, realmId: entity(ENTITY_A).realmId! },
    ],
  }));
  assert.equal(plan.kind, "qbo_customer_plan");
  assert.equal(plan.readOnly, true);
  assert.deepEqual(rowFor(plan, "t-1").proposed, { displayName: "Synthetic Tenant t-1 · Oak Court 1A · RM1", active: true, truncated: false });
  assert.equal(rowFor(plan, "t-1").status, "create");
  assert.equal(rowFor(plan, "t-1").legalEntityId, ENTITY_A);
  assert.deepEqual([rowFor(plan, "t-2").status, rowFor(plan, "t-2").proposed?.active], ["create", false], "former tenants are proposed inactive");
  assert.deepEqual([rowFor(plan, "t-3").status, rowFor(plan, "t-3").linkedCustomerId, rowFor(plan, "t-3").proposed], ["linked", "57", null]);
  assert.deepEqual([rowFor(plan, "t-4").status, rowFor(plan, "t-4").conflict?.objectId], ["review_possible_match", "58"]);
  assert.deepEqual([rowFor(plan, "t-5").status, rowFor(plan, "t-5").conflict?.objectType], ["review_name_collision", "Vendor"]);
  assert.deepEqual([rowFor(plan, "t-6").status, rowFor(plan, "t-6").conflict?.objectId], ["review_name_collision", "61"], "a customer linked to another tenancy is a collision, not a match");
  assert.deepEqual([rowFor(plan, "t-7").status, rowFor(plan, "t-7").legalEntityId, rowFor(plan, "t-7").ownershipChange, rowFor(plan, "t-7").ownerEntityIds], ["review_ownership_change", ENTITY_B, true, [ENTITY_A, ENTITY_B]]);
  assert.deepEqual([rowFor(plan, "t-8").status, rowFor(plan, "t-8").legalEntityId], ["blocked_not_connected", ENTITY_C]);
  assert.ok(rowFor(plan, "t-8").proposed, "a blocked row still shows the proposed name for review");
  assert.deepEqual([rowFor(plan, "t-9").status, rowFor(plan, "t-9").legalEntityId], ["blocked_no_entity", null]);
  assert.deepEqual([rowFor(plan, "t-10").status, rowFor(plan, "t-10").proposed], ["skipped_cancelled", null]);
  assert.deepEqual([rowFor(plan, "t-11").status, rowFor(plan, "t-12").status], ["review_name_collision", "review_name_collision"], "duplicate names inside the plan");
  assert.deepEqual([rowFor(plan, "t-13").status, rowFor(plan, "t-13").conflict?.objectType], ["review_name_collision", "Employee"]);

  const groupA = plan.entities.find(group => group.legalEntityId === ENTITY_A)!;
  assert.equal(groupA.counts.create, 2);
  assert.equal(groupA.counts.review_name_collision, 5);
  assert.equal(groupA.counts.linked, 1);
  assert.match(groupA.planSha256, /^[a-f0-9]{64}$/);
  assert.equal(plan.entities.at(-1)!.legalEntityId, null, "unassigned tenancies are grouped last");
  assert.equal(plan.counts.create + plan.counts.linked + plan.counts.blocked_no_entity, 4);
  assert.equal(Object.values(plan.counts).reduce((sum, count) => sum + count, 0), 13);
  const groupC = plan.entities.find(group => group.legalEntityId === ENTITY_C)!;
  assert.deepEqual([groupC.connected, groupC.realmId], [false, null]);
});

test("an unread mirror blocks creates, and the digest is stable and changes with the plan", () => {
  const base = input({ tenancies: [tenancy("t-1"), tenancy("t-2")], entities: [entity(ENTITY_A, { mirrorRead: false }), entity(ENTITY_B)] });
  const plan = buildQboCustomerPlan(base);
  assert.equal(rowFor(plan, "t-1").status, "blocked_mirror_not_read");
  assert.equal(buildQboCustomerPlan(base).planSha256, plan.planSha256);
  assert.equal(buildQboCustomerPlan({ ...base, tenancies: [...base.tenancies].reverse() }).planSha256, plan.planSha256, "input order does not matter");
  const renamed = buildQboCustomerPlan({ ...base, tenancies: [tenancy("t-1", { tenantName: "Renamed" }), tenancy("t-2")] });
  assert.notEqual(renamed.planSha256, plan.planSha256);
  assert.equal(renamed.entities.find(group => group.legalEntityId === ENTITY_B)!.planSha256, plan.entities.find(group => group.legalEntityId === ENTITY_B)!.planSha256);
});
