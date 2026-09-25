import assert from "node:assert/strict";
import test from "node:test";
import { getReportingDefinition, reportRunRequestSchema } from "../../shared/reporting";
import { createQuickBooksReportingEngine } from "./quickbooks-engine";

const organizationId = "11111111-1111-4111-8111-111111111111";
const entityId = "33333333-3333-4333-8333-333333333333";

test("native QBO engine uses typed provider columns and preserves summary rows", async () => {
  let received: Record<string, unknown> | undefined;
  const engine = createQuickBooksReportingEngine({
    resolveConnectionScope: async () => ({ organizationId, legalEntityId: entityId, realmId: "123", environment: "sandbox" }),
    createClient: async () => ({ getReport: async (_name, request) => {
      received = request as Record<string, unknown>;
      return {
        reportName: "ProfitAndLoss", scope: { organizationId, legalEntityId: entityId, realmId: "123", environment: "sandbox" }, accountingMethod: "Cash" as const, currency: "USD", status: 200, intuitTid: "tid-1",
        raw: { Header: { ReportBasis: "Cash", StartPeriod: "2026-09-01", EndPeriod: "2026-09-30", Currency: "USD" }, Columns: { Column: [{ ColTitle: "Account", ColType: "String" }, { ColTitle: "Total", ColType: "Money" }] }, Rows: { Row: [{ group: "Income", Header: { ColData: [{ value: "Income", id: "section-account-1" }, { value: "" }] }, Rows: { Row: [{ ColData: [{ value: "100", id: "account-100" }, { value: "10.25" }] }] }, Summary: { ColData: [{ value: "Total Income" }, { value: "10.25" }] } }] } },
      };
    } }),
  });
  const request = reportRunRequestSchema.parse({ reportId: "income-statement", definitionVersion: "1", scope: { organizationId, legalEntityIds: [entityId], propertyIds: [], unitIds: [], tenantIds: [], tenancyIds: [], ownerIds: [], investorIds: [], projectIds: [], vendorIds: [], staffIds: [] }, filters: { basis: "cash", currency: "USD", grouping: "month", accountIds: ["100"] }, period: { mode: "range", fromDate: "2026-09-01", toDate: "2026-09-30" }, basis: "cash", currency: "USD" });
  const result = await engine.run({ runId: "11111111-1111-4111-8111-111111111112", snapshotId: "11111111-1111-4111-8111-111111111113", request, definition: getReportingDefinition("income-statement")!, now: "2026-09-21T00:00:00.000Z" });
  assert.equal(received?.startDate, "2026-09-01");
  assert.equal(received?.account, "100");
  assert.equal(received?.summarizeColumnBy, "Month");
  assert.equal(result.rows.find(row => row.values.rowKind === "detail")?.values.account, "100");
  assert.equal(result.rows.find(row => row.values.rowKind === "summary")?.values.providerGroup, "Income");
  assert.equal(result.rows.find(row => row.values.rowKind === "summary")?.values.providerTotalCents, "1025");
  assert.ok(!result.columns.some(column => column.id === "providerGroup"), "provider metadata is not a visible report column");
  assert.equal(result.rows.find(row => row.values.rowKind === "section")?.values.sectionAccountId, "section-account-1");
  assert.equal(result.rows.find(row => row.values.rowKind === "detail")?.values.accountId, "account-100");
  assert.equal(result.rows.find(row => row.values.rowKind === "detail")?.values.totalCents, "1025");
  assert.equal(result.rows.find(row => row.values.rowKind === "summary")?.values.totalCents, "1025");
  assert.deepEqual(result.rows.map(row => row.values.rowKind), ["section", "detail", "summary"], "a section's total follows its detail rows");
});

test("native QBO engine refuses an unmarked empty provider result", async () => {
  const engine = createQuickBooksReportingEngine({ resolveConnectionScope: async () => ({ organizationId, legalEntityId: entityId, realmId: "123", environment: "sandbox" }), createClient: async () => ({ getReport: async () => ({ reportName: "TrialBalance", scope: { organizationId, legalEntityId: entityId, realmId: "123", environment: "sandbox" }, accountingMethod: "Accrual" as const, currency: "USD", status: 200, raw: { Header: { ReportBasis: "Accrual", EndPeriod: "2026-09-21", Currency: "USD" }, Rows: { Row: [] } } }) }) });
  const request = reportRunRequestSchema.parse({ reportId: "trial-balance", definitionVersion: "1", scope: { organizationId, legalEntityIds: [entityId], propertyIds: [], unitIds: [], tenantIds: [], tenancyIds: [], ownerIds: [], investorIds: [], projectIds: [], vendorIds: [], staffIds: [] }, filters: { basis: "accrual", currency: "USD", grouping: "none" }, period: { mode: "as_of", asOfDate: "2026-09-21" }, basis: "accrual", currency: "USD" });
  await assert.rejects(() => engine.run({ runId: "11111111-1111-4111-8111-111111111114", snapshotId: "11111111-1111-4111-8111-111111111115", request, definition: getReportingDefinition("trial-balance")!, now: "2026-09-21T00:00:00.000Z" }), /no rows/);
});

test("native QBO month periods use the calendar month end", async () => {
  let received: Record<string, unknown> | undefined;
  const engine = createQuickBooksReportingEngine({
    resolveConnectionScope: async () => ({ organizationId, legalEntityId: entityId, realmId: "123", environment: "sandbox" }),
    createClient: async () => ({ getReport: async (_name, request) => {
      received = request as Record<string, unknown>;
      return { reportName: "TrialBalance", scope: { organizationId, legalEntityId: entityId, realmId: "123", environment: "sandbox" }, accountingMethod: "Accrual" as const, currency: "USD", status: 200, raw: { Header: { ReportBasis: "Accrual", StartPeriod: "2026-02-01", EndPeriod: "2026-02-28", Currency: "USD" }, Columns: { Column: [{ ColTitle: "Account", ColType: "String" }] }, Rows: { Row: [{ ColData: [{ value: "100" }] }] } } };
    } }),
  });
  const request = reportRunRequestSchema.parse({ reportId: "trial-balance", definitionVersion: "1", scope: { organizationId, legalEntityIds: [entityId], propertyIds: [], unitIds: [], tenantIds: [], tenancyIds: [], ownerIds: [], investorIds: [], projectIds: [], vendorIds: [], staffIds: [] }, filters: { basis: "accrual", currency: "USD", grouping: "none" }, period: { mode: "month", month: "2026-02" }, basis: "accrual", currency: "USD" });
  const result = await engine.run({ runId: "11111111-1111-4111-8111-111111111116", snapshotId: "11111111-1111-4111-8111-111111111117", request, definition: getReportingDefinition("trial-balance")!, now: "2026-09-21T00:00:00.000Z" });
  assert.equal(received?.startDate, "2026-02-01");
  assert.equal(received?.endDate, "2026-02-28");
  assert.equal(result.coverage[0]?.coveredThrough, "2026-02-28");
});
