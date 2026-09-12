import assert from "node:assert/strict";
import test from "node:test";
import { decodeRentOpsWorkspaceBootstrap, decodeRentOpsWorkspaceCollection, WORKSPACE_COLLECTIONS } from "../api";
import { syntheticRentOpsSnapshot } from "../../../../../server/rent-ops/fixtures/synthetic";
import { deriveTenantProfile } from "../../../../../server/rent-ops/domain/reports";
import { serializeWorkspaceBootstrap, serializeWorkspaceCollection, workspaceBootstrapCollections } from "../../../../../server/rent-ops/presentation/workspace-read";

const filters = { asOfDate: "2026-08-15" };
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const bootstrap = () => wire(serializeWorkspaceBootstrap(syntheticRentOpsSnapshot(), filters));

test("actual server bootstrap passes browser contract and identifies unloaded collections", () => {
  const result = decodeRentOpsWorkspaceBootstrap(bootstrap());
  assert.deepEqual(result.loadedCollections, [...workspaceBootstrapCollections]);
  assert.equal(result.snapshot.people.length, syntheticRentOpsSnapshot().people.length);
  for (const name of WORKSPACE_COLLECTIONS) {
    assert.equal(result.loadedCollections.includes(name), false);
    assert.deepEqual(result.snapshot[name], []);
  }
  assert.equal("summary" in result, false);
  assert.equal("reports" in result, false);
});

test("each actual server collection passes its matching browser decoder", () => {
  const source = syntheticRentOpsSnapshot();
  for (const name of WORKSPACE_COLLECTIONS) {
    const serialized = wire(serializeWorkspaceCollection(source, name));
    const decoded = decodeRentOpsWorkspaceCollection(name, serialized);
    assert.equal(decoded.length, source[name].length, name);
    assert.deepEqual(wire(decoded), serialized.items, name);
    assert.throws(() => decodeRentOpsWorkspaceCollection(name, { ...serialized, collection: "wrong" }), name);
    assert.throws(() => decodeRentOpsWorkspaceCollection(name, { ...serialized, unexpected: true }), name);
    assert.throws(() => decodeRentOpsWorkspaceCollection(name, { ...serialized, items: [{ rawPayload: "sentinel" }] }), name);
  }
});

test("bootstrap rejects invalid versions, required collection coverage, and forbidden nested fields", () => {
  for (const version of [0, 2, "1", null]) assert.throws(() => decodeRentOpsWorkspaceBootstrap({ ...bootstrap(), workspaceVersion: version }));
  const missing = bootstrap(); missing.loadedCollections = missing.loadedCollections.filter(name => name !== "people");
  assert.throws(() => decodeRentOpsWorkspaceBootstrap(missing));
  assert.throws(() => decodeRentOpsWorkspaceBootstrap({ ...bootstrap(), loadedCollections: [...workspaceBootstrapCollections, "applicationHistory"] }));
  assert.throws(() => decodeRentOpsWorkspaceBootstrap({ ...bootstrap(), generatedAt: "not a timestamp" }));
  const sensitive = bootstrap(); Object.assign(sensitive.tenantIndex[0].person, { ssn: "sentinel" });
  assert.throws(() => decodeRentOpsWorkspaceBootstrap(sensitive));
  const malformed = bootstrap(); Object.assign(malformed.tenantIndex[0], { accountContact: "false" });
  assert.throws(() => decodeRentOpsWorkspaceBootstrap(malformed));
});

test("decoded navigation selects the same tenancy as server profiles and isolates account contacts", () => {
  const source = structuredClone(syntheticRentOpsSnapshot());
  source.householdMemberships.push({ id: "test-account-link", tenancyId: source.tenancies[0].id, personId: source.people[0].id, accountPersonId: source.people[3].id });
  const decoded = decodeRentOpsWorkspaceBootstrap(wire(serializeWorkspaceBootstrap(source, filters)));
  for (const entry of decoded.tenantIndex.filter(entry => entry.person.id !== source.people[3].id)) {
    assert.equal(entry.selectedTenancyId, deriveTenantProfile(source, entry.person.id!, filters)?.tenancy?.id);
    if (entry.selectedTenancyId) assert.ok(entry.tenancyIds.includes(entry.selectedTenancyId));
  }
  assert.equal(decoded.tenantIndex.find(entry => entry.person.id === source.people[0].id)?.category, "current");
  assert.equal(decoded.tenantIndex.find(entry => entry.person.id === source.people[1].id)?.category, "future");
  const account = decoded.tenantIndex.find(entry => entry.person.id === source.people[3].id)!;
  assert.equal(account.category, "contact"); assert.equal(account.accountContact, true);
  assert.equal(account.selectedTenancyId, undefined); assert.deepEqual(account.tenancyIds, []);
});

test("unloaded collection cannot carry financial rows", () => {
  const source = syntheticRentOpsSnapshot();
  const payload = bootstrap();
  payload.snapshot.ledgerTransactions = wire(serializeWorkspaceCollection(source, "ledgerTransactions")).items;
  assert.ok(payload.snapshot.ledgerTransactions.length > 0);
  assert.throws(() => decodeRentOpsWorkspaceBootstrap(payload));
});

test("bootstrap rejects duplicate collection claims", () => {
  const duplicate = bootstrap(); duplicate.loadedCollections.push("people");
  assert.throws(() => decodeRentOpsWorkspaceBootstrap(duplicate));
});

test("bootstrap rejects inconsistent selected tenancy", () => {
  const unrelated = bootstrap(); unrelated.tenantIndex[0].selectedTenancyId = "unrelated-tenancy";
  assert.throws(() => decodeRentOpsWorkspaceBootstrap(unrelated));
});

test("recurring history metadata cannot authorize changes with unknown lineage or omit a resolved boundary", () => {
  const serialized = wire(serializeWorkspaceCollection(syntheticRentOpsSnapshot(), "recurringSchedules"));
  assert.ok(serialized.items.length);
  const original = serialized.items[0];
  for (const metadata of [
    { lineageState: "unknown", canScheduleSuccessor: true },
    { lineageState: "valid", resolvedEffectiveTo: undefined },
    { lineageState: "guessed" },
    { resolvedEffectiveTo: "2026-02-31" },
    { canScheduleSuccessor: "true" },
  ]) {
    assert.throws(() => decodeRentOpsWorkspaceCollection("recurringSchedules", wire({ ...serialized, items: [{ ...original, ...metadata }] })));
  }
});
