import assert from "node:assert/strict";
import test from "node:test";
import { getReportingDefinition, reportRunRequestSchema } from "../../shared/reporting";
import type { ProjectDetail } from "../../shared/projects";
import { canonicalSourceValue } from "./source-engine-utils";
import { createProjectReportingEngine } from "./project-engine";
import { createCombinedFinancialReportingEngine, type CombinedFinancialReadResult } from "./combined-financial-engine";
import { createForecastReportingEngine, type ForecastReportingReadResult, type ForecastWeek } from "./forecast-engine";

const organizationId = "11111111-1111-4111-8111-111111111111";
const legalEntityId = "33333333-3333-4333-8333-333333333333";
const propertyId = "property-a";
const projectId = "55555555-5555-4555-8555-555555555555";
const emptyScope = { organizationId, legalEntityIds: [legalEntityId], propertyIds: [propertyId], unitIds: [], tenantIds: [], tenancyIds: [], ownerIds: [], investorIds: [], projectIds: [projectId], vendorIds: [], staffIds: [] };

function request(reportId: string, period: unknown, extra: Record<string, unknown> = {}) {
  return reportRunRequestSchema.parse({ reportId, definitionVersion: "1", scope: emptyScope, filters: {}, period, basis: "mixed", currency: "USD", ...extra });
}

function context(reportId: string, period: unknown, extra: Record<string, unknown> = {}) {
  const req = request(reportId, period, extra);
  return { runId: "11111111-1111-4111-8111-111111111112", snapshotId: "11111111-1111-4111-8111-111111111113", request: req, definition: getReportingDefinition(reportId)!, now: "2026-09-21T12:00:00.000Z" as const };
}

function projectFixture(): ProjectDetail {
  return {
    id: projectId, organizationId, legalEntityId, propertyId, unitId: null, name: "Lucia rehab", projectType: "rehab", description: "Unit refresh", status: "active", currency: "USD", startOn: "2026-08-01", targetOn: "2026-11-01", recordRevision: 1, updatedAt: "2026-09-21T00:00:00.000Z", archivedAt: null, scopeItemCount: 0, taskCount: 0, approvedBudgetCents: "200", draftCostCents: "0", postedActualCents: "999", postedActualCoverage: "complete", scopeItems: [], tasks: [], draftCosts: [], postedActuals: [
      { id: "77777777-7777-4777-8777-777777777777", projectId, scopeItemId: null, provider: "qbo", sourceScope: "book-a", externalId: "actual-september", description: "September actual", amountCents: "20", currency: "USD", postedOn: "2026-09-10", createdAt: "2026-09-11T00:00:00.000Z" },
      { id: "88888888-8888-4888-8888-888888888888", projectId, scopeItemId: null, provider: "qbo", sourceScope: "book-a", externalId: "actual-october", description: "October actual", amountCents: "80", currency: "USD", postedOn: "2026-10-01", createdAt: "2026-10-02T00:00:00.000Z" },
    ], budgetVersions: [
      { id: "99999999-9999-4999-8999-999999999999", projectId, versionNo: 1, status: "superseded", currency: "USD", totalEstimatedCents: "100", notes: null, createdBy: "actor", approvedBy: "actor", createdAt: "2026-08-01T00:00:00.000Z", approvedAt: "2026-08-02T00:00:00.000Z", lines: [] },
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", projectId, versionNo: 2, status: "approved", currency: "USD", totalEstimatedCents: "200", notes: null, createdBy: "actor", approvedBy: "actor", createdAt: "2026-10-01T00:00:00.000Z", approvedAt: "2026-10-02T00:00:00.000Z", lines: [] },
    ],
  } as unknown as ProjectDetail;
}

test("new money boundary treats numeric cents as cents and rejects unsafe integers", () => {
  assert.equal(canonicalSourceValue(123, "amountCents"), "123");
  assert.throws(() => canonicalSourceValue(Number.MAX_SAFE_INTEGER + 1, "amountCents"), /safe integer/);
});

test("project performance uses the budget approved by the report date and period actuals", async () => {
  const engine = createProjectReportingEngine({ async read() { return { projects: [projectFixture()], coverage: { state: "complete", evidence: "synthetic", watermark: null, reason: null } }; } });
  const result = await engine.run(context("project-performance", { mode: "range", fromDate: "2026-09-01", toDate: "2026-09-30" }));
  assert.equal(result.rows[0]?.values.approvedBudgetCents, "100");
  assert.equal(result.rows[0]?.values.postedActualCents, "20");
  assert.equal(result.rows[0]?.values.varianceCents, "-80");
});

test("project actuals use cumulative history through an as-of date", async () => {
  const engine = createProjectReportingEngine({ async read() { return { projects: [projectFixture()], coverage: { state: "complete", evidence: "synthetic", watermark: null, reason: null } }; } });
  const result = await engine.run(context("project-performance", { mode: "as_of", asOfDate: "2026-09-30" }));
  assert.equal(result.rows[0]?.values.postedActualCents, "20");
  assert.equal(result.rows[0]?.values.actualScope, "cumulative_through_as_of");
});

function financialContext(reportId: string, period: unknown, extra: Record<string, unknown> = {}) {
  return context(reportId, period, { ...extra, scope: extra.scope ?? emptyScope });
}

test("budget actuals sum duplicate source lines and preserve realm identity", async () => {
  const source: CombinedFinancialReadResult = {
    lines: [
      { id: "l1", legalEntityId, propertyId, unitId: null, accountId: "600", accountName: "Repairs", date: "2026-09-05", month: "2026-09", amountCents: "25", currency: "USD", sourceId: "s1", sourceRealmId: "realm-a", canonicalAccountId: null, statement: "income_statement", basis: "accrual" },
      { id: "l2", legalEntityId, propertyId, unitId: null, accountId: "600", accountName: "Repairs", date: "2026-09-20", month: "2026-09", amountCents: "35", currency: "USD", sourceId: "s2", sourceRealmId: "realm-a", canonicalAccountId: null, statement: "income_statement", basis: "accrual" },
    ],
    budgetLines: [{ id: "b1", legalEntityId, propertyId, unitId: null, accountId: "600", period: "2026-09", budgetCents: "100", currency: "USD", sourceId: "budget", sourceRealmId: "realm-a" }],
    coverage: { state: "complete", evidence: "synthetic", watermark: null, reason: null },
  };
  const engine = createCombinedFinancialReportingEngine({ async read() { return source; } });
  const result = await engine.run(financialContext("budget-vs-actual", { mode: "range", fromDate: "2026-09-01", toDate: "2026-09-30" }, { basis: "accrual" }));
  assert.equal(result.rows[0]?.values.actualCents, "60");
  assert.equal(result.rows[0]?.values.varianceCents, "-40");
});

test("budget actuals aggregate repeated budget lines before calculating variance", async () => {
  const source: CombinedFinancialReadResult = {
    lines: [{ id: "l1", legalEntityId, propertyId, unitId: null, accountId: "600", accountName: "Repairs", date: "2026-09-05", month: "2026-09", amountCents: "60", currency: "USD", sourceId: "s1", sourceRealmId: "realm-a", canonicalAccountId: null, statement: "income_statement", basis: "accrual" }],
    budgetLines: [
      { id: "b1", legalEntityId, propertyId, unitId: null, accountId: "600", period: "2026-09", budgetCents: "100", currency: "USD", sourceId: "budget-1", sourceRealmId: "realm-a" },
      { id: "b2", legalEntityId, propertyId, unitId: null, accountId: "600", period: "2026-09", budgetCents: "50", currency: "USD", sourceId: "budget-2", sourceRealmId: "realm-a" },
    ],
    coverage: { state: "complete", evidence: "synthetic", watermark: null, reason: null },
  };
  const engine = createCombinedFinancialReportingEngine({ async read() { return source; } });
  const result = await engine.run(financialContext("budget-vs-actual", { mode: "range", fromDate: "2026-09-01", toDate: "2026-09-30" }, { basis: "accrual" }));
  assert.equal(result.rows[0]?.values.budgetCents, "150");
  assert.equal(result.rows[0]?.values.actualCents, "60");
  assert.equal(result.rows[0]?.values.varianceCents, "-90");
});

test("consolidated none policy preserves source amounts and does not apply supplied eliminations", async () => {
  const source: CombinedFinancialReadResult = {
    lines: [{ id: "l1", legalEntityId, propertyId, unitId: null, accountId: "100", accountName: "Cash", date: "2026-09-20", amountCents: "100", currency: "USD", sourceId: "s1", sourceRealmId: "realm-a", canonicalAccountId: "cash", statement: "balance_sheet", basis: "accrual" }],
    eliminations: [{ accountId: "100", canonicalAccountId: "cash", entityId: legalEntityId, amountCents: "-25", currency: "USD", sourceId: "e1" }],
    eliminationVersion: "elim-v1",
    accountMappingVersion: "accounts-v1",
    coverage: { state: "complete", evidence: "synthetic", watermark: null, reason: null },
  };
  const engine = createCombinedFinancialReportingEngine({ async read() { return source; } });
  const result = await engine.run(financialContext("balance-sheet-consolidated", { mode: "as_of", asOfDate: "2026-09-30" }, {
    basis: "accrual",
    consolidation: { entityIds: [legalEntityId], currency: "USD", ownershipPolicy: "full_control", eliminationPolicy: "none", translationPolicy: "none" },
  }));
  assert.equal(result.rows[0]?.values.amountCents, "100");
  assert.equal(result.rows[0]?.values.eliminatedAmountCents, "0");
  assert.equal(result.rows[0]?.values.consolidatedAmountCents, "100");
});

test("consolidated ownership and translation policies apply line values", async () => {
  const secondEntity = "44444444-4444-4444-8444-444444444444";
  const source: CombinedFinancialReadResult = {
    lines: [
      { id: "l1", legalEntityId, propertyId, unitId: null, accountId: "100", accountName: "Cash", date: "2026-09-20", amountCents: "100", currency: "USD", sourceId: "s1", sourceRealmId: "realm-a", canonicalAccountId: "cash", ownershipBps: 5_000, statement: "balance_sheet", basis: "accrual" },
      { id: "l2", legalEntityId: secondEntity, propertyId, unitId: null, accountId: "100", accountName: "Cash", date: "2026-09-20", amountCents: "200", currency: "USD", sourceId: "s2", sourceRealmId: "realm-b", canonicalAccountId: "cash", ownershipBps: 5_000, statement: "balance_sheet", basis: "accrual" },
    ],
    accountMappingVersion: "accounts-v1",
    ownershipMappingVersion: "ownership-v1",
    coverage: { state: "complete", evidence: "synthetic", watermark: null, reason: null },
  };
  const engine = createCombinedFinancialReportingEngine({ async read() { return source; } });
  const result = await engine.run(financialContext("balance-sheet-consolidated", { mode: "as_of", asOfDate: "2026-09-30" }, {
    basis: "accrual",
    scope: { ...emptyScope, legalEntityIds: [legalEntityId, secondEntity] },
    consolidation: { entityIds: [legalEntityId, secondEntity], currency: "USD", ownershipPolicy: "pro_rata", eliminationPolicy: "none", translationPolicy: "none" },
  }));
  assert.equal(result.rows[0]?.values.consolidatedAmountCents, "150");

  const translatedSource: CombinedFinancialReadResult = {
    ...source,
    lines: [{ ...source.lines[0]!, currency: "EUR", translatedAmountCents: "120", translatedCurrency: "USD", ownershipBps: null }],
    translationVersion: "fx-v1",
  };
  const translatedEngine = createCombinedFinancialReportingEngine({ async read() { return translatedSource; } });
  const translated = await translatedEngine.run(financialContext("balance-sheet-consolidated", { mode: "as_of", asOfDate: "2026-09-30" }, {
    basis: "accrual",
    consolidation: { entityIds: [legalEntityId], currency: "USD", ownershipPolicy: "full_control", eliminationPolicy: "none", translationPolicy: "approved_rates", translationVersion: "fx-v1" },
  }));
  assert.equal(translated.rows[0]?.values.consolidatedAmountCents, "120");
});

test("balance sheet as-of scope is cumulative through the requested date", async () => {
  const source: CombinedFinancialReadResult = {
    lines: [
      { id: "l1", legalEntityId, propertyId, unitId: null, accountId: "100", accountName: "Cash", date: "2026-08-31", amountCents: "10", currency: "USD", sourceId: "s1", sourceRealmId: "realm-a", canonicalAccountId: null, statement: "balance_sheet", basis: "accrual", fundType: "operations" },
      { id: "l2", legalEntityId, propertyId, unitId: null, accountId: "100", accountName: "Cash", date: "2026-09-20", amountCents: "20", currency: "USD", sourceId: "s2", sourceRealmId: "realm-a", canonicalAccountId: null, statement: "balance_sheet", basis: "accrual", fundType: "operations" },
      { id: "l3", legalEntityId, propertyId, unitId: null, accountId: "100", accountName: "Cash", date: "2026-10-01", amountCents: "80", currency: "USD", sourceId: "s3", sourceRealmId: "realm-a", canonicalAccountId: null, statement: "balance_sheet", basis: "accrual", fundType: "operations" },
    ],
    coverage: { state: "complete", evidence: "synthetic", watermark: null, reason: null },
    fundMappingVersion: "fund-v1",
  };
  const engine = createCombinedFinancialReportingEngine({ async read() { return source; } });
  const result = await engine.run(financialContext("balance-sheet-by-fund-type", { mode: "as_of", asOfDate: "2026-09-30" }, { basis: "accrual" }));
  assert.equal(result.rows[0]?.values.amountCents, "30");
});

function forecastWeeks(mismatch = false): ForecastWeek[] {
  const weeks: ForecastWeek[] = [];
  for (let index = 0; index < 13; index += 1) {
    const date = new Date(Date.UTC(2026, 8, 7 + index * 7)).toISOString().slice(0, 10);
    const opening = BigInt(1_000 + index * 10);
    const closing = opening + BigInt(10);
    weeks.push({ weekStart: date, inflowsCents: "25", outflowsCents: "15", openingCashCents: opening.toString(), closingCashCents: (mismatch && index === 4 ? closing + BigInt(1) : closing).toString(), currency: "USD" });
  }
  return weeks;
}

test("13-week forecast requires continuous reconciled weeks and an actual boundary", async () => {
  const source: ForecastReportingReadResult = { actuals: [{ date: "2026-09-01", category: "cash", amountCents: "100", currency: "USD", sourceId: "a1" }], weeks: forecastWeeks(), coverage: { state: "complete", evidence: "synthetic", watermark: null, reason: null } };
  const engine = createForecastReportingEngine({ async read() { return source; } });
  const ctx = context("cash-forecast-13-week", { mode: "custom", fromDate: "2026-09-07", toDate: "2026-12-06" }, { forecast: { scenarioId: "base", inputVersion: "v1", modelVersion: "m1" } });
  const result = await engine.run(ctx);
  assert.equal(result.rows.length, 13);
  const shortEngine = createForecastReportingEngine({ async read() { return { ...source, weeks: source.weeks!.slice(0, 12) }; } });
  await assert.rejects(() => shortEngine.run(ctx), /exactly 13/);
  const badEngine = createForecastReportingEngine({ async read() { return { ...source, weeks: forecastWeeks(true) }; } });
  await assert.rejects(() => badEngine.run(ctx), /does not reconcile/);
});
