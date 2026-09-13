import assert from "node:assert/strict";
import test from "node:test";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import type { FixedReportName, RentOpsFilters } from "../../../shared/rent-ops-contracts";
import { createTenantStatusMatcher } from "./tenant-status";
import { deriveFixedReport, financialReportControls } from "./reports";

const filters: RentOpsFilters = { asOfDate: "2026-08-16", month: "2026-08" };
const financialReports: FixedReportName[] = ["scheduled-income", "collected-income", "scheduled-vs-collected", "tenant-ledger", "security-deposit", "hap"];

test("explicit all preserves absent-filter financial rows and controls in both models", () => {
  for (const modelVersion of [2, 3] as const) {
    const snapshot = structuredClone(syntheticRentOpsSnapshot());
    snapshot.modelVersion = modelVersion;
    if (modelVersion === 3) for (const tenant of snapshot.tenancies) Object.assign(tenant, { primaryPersonLinkKnowledge: "exact", propertyLinkKnowledge: "exact", unitLinkKnowledge: "exact" });
    for (const report of financialReports) {
      const original = deriveFixedReport(snapshot, report, filters);
      const all = deriveFixedReport(snapshot, report, { ...filters, tenantStatus: "all" });
      assert.deepEqual(all, original, `${modelVersion} ${report}`);
      assert.deepEqual(financialReportControls(all), financialReportControls(original), `${modelVersion} ${report} controls`);
    }
  }
});

test("status uses dated occupancy and current account precedence within the exact property", () => {
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  const first = snapshot.tenancies[0];
  assert.equal(createTenantStatusMatcher(snapshot, { ...filters, tenantStatus: "current" })({ tenancyId: first.id }), true);
  first.operationalEndConfirmedOn = "2026-08-10";
  first.operationalEndConfirmationKnowledge = "manual";
  assert.equal(createTenantStatusMatcher(snapshot, { ...filters, tenantStatus: "current" })({ tenancyId: first.id }), false);
  assert.equal(createTenantStatusMatcher(snapshot, { ...filters, tenantStatus: "former" })({ tenancyId: first.id }), true);
  assert.equal(createTenantStatusMatcher(snapshot, { ...filters, asOfDate: "2026-08-09", tenantStatus: "current" })({ tenancyId: first.id }), true);
  snapshot.tenancies.push({ ...first, id: "new-lease", unitId: "demo-unit-a-3", actualMoveInOn: "2026-08-11", operationalEndConfirmedOn: undefined });
  assert.equal(createTenantStatusMatcher(snapshot, { ...filters, tenantStatus: "current" })({ tenancyId: first.id }), true);
  const future = snapshot.tenancies[1];
  future.plannedMoveInOn = "2026-09-01";
  assert.equal(createTenantStatusMatcher(snapshot, { ...filters, tenantStatus: "future" })({ tenancyId: future.id }), true);
  future.statusKnowledge = "unknown";
  assert.equal(createTenantStatusMatcher(snapshot, { ...filters, tenantStatus: "unknown" })({ tenancyId: future.id }), true);
  assert.equal(createTenantStatusMatcher(snapshot, { ...filters, tenantStatus: "unknown" })({ tenancyId: "missing" }), true);
  assert.equal(createTenantStatusMatcher(snapshot, { ...filters, tenantStatus: "current" })({ personId: first.primaryPersonId }), false);
});

test("tenant-based report scopes exclude a departed resident before balances and variance aggregation", () => {
  for (const modelVersion of [2, 3] as const) {
    const snapshot = structuredClone(syntheticRentOpsSnapshot());
    snapshot.modelVersion = modelVersion;
    if (modelVersion === 3) for (const tenant of snapshot.tenancies) Object.assign(tenant, { primaryPersonLinkKnowledge: "exact", propertyLinkKnowledge: "exact", unitLinkKnowledge: "exact" });
    const departed = snapshot.tenancies[0];
    departed.operationalEndConfirmedOn = "2026-08-10";
    departed.operationalEndConfirmationKnowledge = "manual";
    const propertyId = departed.propertyId;
    for (const report of ["collected-income", "tenant-ledger", "lease-expiration", "security-deposit", "hap"] as FixedReportName[]) {
      const current = deriveFixedReport(snapshot, report, { ...filters, propertyId, tenantStatus: "current" });
      assert.equal(current.length, 0, `${modelVersion} ${report} current`);
      const former = deriveFixedReport(snapshot, report, { ...filters, propertyId, tenantStatus: "former" });
      assert.ok(former.length > 0, `${modelVersion} ${report} former`);
    }
    const collected = deriveFixedReport(snapshot, "collected-income", { ...filters, tenantStatus: "current" }) as { amountCents: number }[];
    assert.equal(collected.reduce((sum, row) => sum + row.amountCents, 0), 110000);
    const variance = deriveFixedReport(snapshot, "scheduled-vs-collected", { ...filters, tenantStatus: "current" }) as { propertyId: string; collectedCents: number }[];
    assert.equal(variance.reduce((sum, row) => sum + row.collectedCents, 0), 110000);
    assert.ok(variance.every(row => row.propertyId !== propertyId));
    const controls = financialReportControls(collected);
    if (modelVersion === 3) assert.equal(controls?.collectedKnownCents, 110000);
  }
});

test("future and unknown selectable scopes retain deposits and HAP without promoting them to Current", () => {
  for (const status of ["future", "unknown"] as const) {
    const snapshot = structuredClone(syntheticRentOpsSnapshot());
    const tenant = snapshot.tenancies[0];
    tenant.status = status === "future" ? "future" : "current";
    tenant.actualMoveInOn = status === "unknown" ? "2026-01-01" : undefined;
    tenant.plannedMoveInOn = status === "future" ? "2026-09-01" : undefined;
    tenant.statusKnowledge = status === "unknown" ? "unknown" : "manual";
    for (const report of ["collected-income", "tenant-ledger", "lease-expiration", "security-deposit", "hap"] as FixedReportName[]) {
      const scope = { ...filters, propertyId: tenant.propertyId };
      assert.equal(deriveFixedReport(snapshot, report, { ...scope, tenantStatus: "current" }).length, 0, report);
      assert.ok(deriveFixedReport(snapshot, report, { ...scope, tenantStatus: status }).length > 0, `${report} ${status}`);
    }
  }
});


test("a current resident's prior unit history and person-only property receipts remain in the account report", () => {
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  const old = snapshot.tenancies[0];
  old.operationalEndConfirmedOn = "2026-08-10";
  old.operationalEndConfirmationKnowledge = "manual";
  snapshot.tenancies.push({ ...old, id: "relocated", unitId: "demo-unit-a-3", actualMoveInOn: "2026-08-11", operationalEndConfirmedOn: undefined });
  const before = deriveFixedReport(snapshot, "tenant-ledger", { ...filters, personId: old.primaryPersonId, tenantStatus: "all" });
  const current = deriveFixedReport(snapshot, "tenant-ledger", { ...filters, personId: old.primaryPersonId, tenantStatus: "current" });
  assert.deepEqual(current, before);
  assert.equal(deriveFixedReport(snapshot, "security-deposit", { ...filters, tenantStatus: "current" }).length, 1);
  const matches = createTenantStatusMatcher(snapshot, { ...filters, tenantStatus: "current" });
  assert.equal(matches({ personId: old.primaryPersonId, propertyId: old.propertyId, personLinkKnowledge: "exact", propertyLinkKnowledge: "exact" }), true);
  assert.equal(matches({ personId: old.primaryPersonId, propertyId: "demo-property-b" }), false);
  const charge = snapshot.ledgerTransactions.find(row => row.id === "demo-charge-rent-1")!;
  charge.tenancyId = null;
  charge.tenancyLinkKnowledge = "unknown";
  const collected = deriveFixedReport(snapshot, "collected-income", { ...filters, personId: old.primaryPersonId, tenantStatus: "current" }) as { amountCents: number }[];
  assert.equal(collected.reduce((sum, row) => sum + row.amountCents, 0), 110000);
});
