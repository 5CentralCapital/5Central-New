import assert from "node:assert/strict";
import test from "node:test";
import type { QuickBooksReportResponse } from "../integrations/quickbooks/reports";
import { createQuickBooksForecastBalanceSource, createQuickBooksForecastPortfolioBalanceSource, qboReportAmountToCents } from "./source-port";

const scope = { organizationId: "org-1", legalEntityId: "entity-1", realmId: "realm-1", environment: "production" as const };
const asOf = "2026-09-21";

function response(input: { readonly rows?: readonly unknown[]; readonly rawRows?: unknown; readonly columns?: readonly unknown[]; readonly end?: string; readonly basis?: "Cash" | "Accrual"; readonly currency?: string; readonly scope?: typeof scope; readonly noReportData?: boolean; readonly truncated?: boolean }): QuickBooksReportResponse {
  return {
    reportName: "BalanceSheet", scope: input.scope ?? scope, accountingMethod: input.basis ?? "Accrual", currency: input.currency ?? "USD", status: 200,
    ...(input.noReportData ? { noReportData: true } : {}), ...(input.truncated ? { truncated: true } : {}),
    raw: {
      Header: { ReportBasis: input.basis ?? "Accrual", EndPeriod: input.end ?? asOf, Currency: input.currency ?? "USD" },
      ...(input.columns ? { Columns: { Column: input.columns } } : {}),
      Rows: { Row: input.rawRows ?? input.rows ?? [] },
    },
  };
}

function account(accountId: string, amount: string): Record<string, unknown> {
  return { ColData: [{ id: accountId, value: accountId }, { value: amount }] };
}

test("native balance source requests the exact cutoff and keeps classified cash separate", async () => {
  let request: Record<string, unknown> | undefined;
  const client = { getReport: async (_name: string, received?: Record<string, unknown>) => {
    request = received;
    return response({ rows: [account("cash-operating", "1,234.56"), account("cash-restricted", "200.04"), account("ap", "3,000.01"), account("property-cost", "100,000.00"), account("property-accum", "(1,250.25)"), account("property-cip", "4,500.50")] });
  } };
  const source = createQuickBooksForecastBalanceSource({
    scope, client, basis: "Accrual", currency: "USD", mappingCoverage: "complete", now: () => "2026-09-26T12:00:00.000Z",
    classifications: [
      { accountId: "cash-operating", kind: "operating_cash" }, { accountId: "cash-restricted", kind: "restricted_cash" }, { accountId: "ap", kind: "accounts_payable" },
      { accountId: "property-cost", kind: "property_cost", propertyId: "property-1" }, { accountId: "property-accum", kind: "property_accumulated_depreciation", propertyId: "property-1" }, { accountId: "property-cip", kind: "property_cip", propertyId: "property-1" },
    ],
  });
  const result = await source.read({ organizationId: scope.organizationId, asOf });
  assert.deepEqual(request, { endDate: asOf, accountingMethod: "Accrual", expectedCurrency: "USD" });
  assert.equal(result.operatingCash.amountCents, "123456");
  assert.equal(result.restrictedCash.amountCents, "20004");
  assert.equal(result.accountsPayable.amountCents, "300001");
  assert.equal(result.propertyBookBalances["property-1"]?.costBasisCents, "10000000");
  assert.equal(result.propertyBookBalances["property-1"]?.accumulatedDepreciationCents, "-125025");
  assert.equal(result.propertyBookBalances["property-1"]?.constructionInProgressCents, "450050");
  assert.equal(result.asOf, asOf);
  assert.equal(result.freshness, "live_read");
  assert.equal(result.reconciliation, "unreconciled");
  assert.equal(result.operatingCash.state, "partial", "a report read alone is not a reconciliation");
  assert.match(result.operatingCash.note ?? "", /not a bank or ledger reconciliation/);
});

test("missing mapped rows stay unknown and are never filled with zero", async () => {
  const source = createQuickBooksForecastBalanceSource({
    scope, client: { getReport: async () => response({ rows: [account("cash-operating", "0.00")] }) }, basis: "Accrual", currency: "USD",
    classifications: [{ accountId: "cash-operating", kind: "operating_cash" }, { accountId: "cash-restricted", kind: "restricted_cash" }, { accountId: "ap", kind: "accounts_payable" }],
  });
  const result = await source.read({ organizationId: scope.organizationId, asOf });
  assert.equal(result.operatingCash.amountCents, "0", "an explicit provider row can be an exact zero");
  assert.equal(result.restrictedCash.amountCents, null);
  assert.equal(result.accountsPayable.amountCents, null);
  assert.equal(result.restrictedCash.state, "unknown");
  assert.equal(result.accountsPayable.state, "unknown");
  assert.equal(result.coverage, "partial", "missing mapped accounts cannot be reported as complete coverage");
});

test("nested QBO groups are traversed and the explicit Total column is selected", async () => {
  const source = createQuickBooksForecastBalanceSource({
    scope, client: {
      getReport: async () => response({
        columns: [{ ColTitle: "Account", ColType: "String" }, { ColTitle: "Prior", ColType: "Money" }, { ColTitle: "Total", ColType: "Money" }],
        rawRows: [{
          Header: { ColData: [{ value: "Assets" }] },
          Rows: { Row: {
            Header: { ColData: [{ value: "Bank" }] },
            Rows: { Row: [
              { ColData: [{ id: "cash-operating", value: "Operating" }, { value: "999.99" }, { value: "123.45" }] },
              { ColData: [{ id: "cash-restricted", value: "Restricted" }, { value: "8.00" }, { value: "4.00" }] },
              { ColData: [{ id: "ap", value: "Payables" }, { value: "12.00" }, { value: "7.00" }] },
            ] },
          } },
        }],
      }),
    }, basis: "Accrual", currency: "USD", mappingCoverage: "complete",
    classifications: [{ accountId: "cash-operating", kind: "operating_cash" }, { accountId: "cash-restricted", kind: "restricted_cash" }, { accountId: "ap", kind: "accounts_payable" }],
  });
  const result = await source.read({ organizationId: scope.organizationId, asOf });
  assert.equal(result.operatingCash.amountCents, "12345");
  assert.equal(result.restrictedCash.amountCents, "400");
  assert.equal(result.accountsPayable.amountCents, "700");
  assert.equal(result.coverage, "complete");
});

test("ambiguous multi-column reports do not use the first populated monetary cell", async () => {
  const source = createQuickBooksForecastBalanceSource({
    scope, client: {
      getReport: async () => response({
        columns: [{ ColTitle: "Account", ColType: "String" }, { ColTitle: "Current", ColType: "Money" }, { ColTitle: "Prior", ColType: "Money" }],
        rows: [account("cash-operating", "999.99")],
      }),
    }, basis: "Accrual", currency: "USD",
    classifications: [{ accountId: "cash-operating", kind: "operating_cash" }],
  });
  const result = await source.read({ organizationId: scope.organizationId, asOf });
  assert.equal(result.coverage, "partial");
  assert.equal(result.operatingCash.amountCents, null);
  assert.match(result.note ?? "", /Provider report coverage is incomplete/);
});

test("missing or duplicate mapped Account.Id rows stay unknown", async () => {
  const source = createQuickBooksForecastBalanceSource({
    scope, client: {
      getReport: async () => response({ rows: [account("cash-operating", "100.00"), account("cash-operating", "200.00")] }),
    }, basis: "Accrual", currency: "USD", mappingCoverage: "complete",
    classifications: [{ accountId: "cash-operating", kind: "operating_cash" }, { accountId: "cash-restricted", kind: "restricted_cash" }],
  });
  const result = await source.read({ organizationId: scope.organizationId, asOf });
  assert.equal(result.operatingCash.amountCents, null);
  assert.equal(result.restrictedCash.amountCents, null);
  assert.match(result.operatingCash.note ?? "", /missing or duplicated/);
});

test("provider error notes are sanitized", async () => {
  const secret = "account-id-and-request-secret";
  const source = createQuickBooksForecastBalanceSource({
    scope, client: { getReport: async () => { throw new Error(secret); } }, basis: "Accrual", currency: "USD",
    classifications: [{ accountId: "cash-operating", kind: "operating_cash" }],
  });
  const result = await source.read({ organizationId: scope.organizationId, asOf });
  assert.equal(result.coverage, "unavailable");
  assert.equal(result.note, "QuickBooks BalanceSheet read unavailable.");
  assert.doesNotMatch(result.note ?? "", new RegExp(secret));
});

test("an empty report without a provider no-data marker is unavailable", async () => {
  const source = createQuickBooksForecastBalanceSource({
    scope, client: { getReport: async () => response({ rows: [] }) }, basis: "Accrual", currency: "USD",
    classifications: [{ accountId: "cash-operating", kind: "operating_cash" }],
  });
  const result = await source.read({ organizationId: scope.organizationId, asOf });
  assert.equal(result.coverage, "unavailable");
  assert.equal(result.operatingCash.amountCents, null);
  assert.match(result.note ?? "", /without a provider-declared no-data marker/);
});

test("provider context mismatch fails closed instead of using a current or wrong-date balance", async () => {
  const source = createQuickBooksForecastBalanceSource({
    scope, client: { getReport: async () => response({ end: "2026-09-22", rows: [account("cash-operating", "100.00")] }) }, basis: "Accrual", currency: "USD",
    classifications: [{ accountId: "cash-operating", kind: "operating_cash" }],
  });
  const result = await source.read({ organizationId: scope.organizationId, asOf });
  assert.equal(result.coverage, "unavailable");
  assert.equal(result.operatingCash.amountCents, null);
  assert.match(result.note ?? "", /did not match/);
});

test("money parsing remains exact and rejects unsafe number input", () => {
  assert.equal(qboReportAmountToCents("9,007,199,254,740.93"), "900719925474093");
  assert.equal(qboReportAmountToCents("(1,250.25)"), "-125025");
  assert.throws(() => qboReportAmountToCents(9007199254740992), /not exact/);
});

test("conflicting cash classifications are rejected before a report is read", () => {
  assert.throws(() => createQuickBooksForecastBalanceSource({
    scope, client: { getReport: async () => response({ rows: [] }) }, basis: "Accrual", currency: "USD",
    classifications: [{ accountId: "cash", kind: "operating_cash" }, { accountId: "cash", kind: "restricted_cash" }],
}), /conflicting classifications/);
});

test("portfolio source requires every entity and aggregates only explicitly mapped balances", async () => {
  const entityTwo = { ...scope, legalEntityId: "entity-2", realmId: "realm-2" };
  const requests: string[] = [];
  const source = createQuickBooksForecastPortfolioBalanceSource({ entities: [
    { scope, basis: "Accrual", currency: "USD", mappingCoverage: "complete", client: { getReport: async (_name, request) => {
      requests.push(String(request?.endDate));
      return response({ scope, rows: [account("cash-operating", "100.01"), account("cash-restricted", "10.00"), account("ap", "5.00")] });
    } }, classifications: [{ accountId: "cash-operating", kind: "operating_cash" }, { accountId: "cash-restricted", kind: "restricted_cash" }, { accountId: "ap", kind: "accounts_payable" }] },
    { scope: entityTwo, basis: "Accrual", currency: "USD", mappingCoverage: "complete", client: { getReport: async (_name, request) => {
      requests.push(String(request?.endDate));
      return response({ scope: entityTwo, rows: [account("cash-operating", "200.02"), account("cash-restricted", "20.00"), account("ap", "6.00")] });
    } }, classifications: [{ accountId: "cash-operating", kind: "operating_cash" }, { accountId: "cash-restricted", kind: "restricted_cash" }, { accountId: "ap", kind: "accounts_payable" }] },
  ], expectedLegalEntityIds: [scope.legalEntityId, entityTwo.legalEntityId] });
  const result = await source.read({ organizationId: scope.organizationId, asOf });
  assert.deepEqual(requests, [asOf, asOf]);
  assert.deepEqual(result.entityScope, [scope.legalEntityId, entityTwo.legalEntityId]);
  assert.equal(result.coverage, "complete");
  assert.equal(result.mappingCoverage, "complete");
  assert.equal(result.legalEntityId, null);
  assert.equal(result.operatingCash.amountCents, "30003");
  assert.equal(result.restrictedCash.amountCents, "3000");
  assert.equal(result.accountsPayable.amountCents, "1100");
  assert.equal(result.reconciliation, "unreconciled");
  assert.equal(result.operatingCash.state, "partial");
});

test("portfolio source keeps a missing entity/account from becoming a portfolio zero", async () => {
  const source = createQuickBooksForecastPortfolioBalanceSource({
    entities: [{ scope, basis: "Accrual", currency: "USD", mappingCoverage: "complete", client: { getReport: async () => response({ scope, rows: [account("cash-operating", "100.00")] }) }, classifications: [{ accountId: "cash-operating", kind: "operating_cash" }, { accountId: "cash-restricted", kind: "restricted_cash" }] }],
    expectedLegalEntityIds: [scope.legalEntityId, "entity-missing"],
  });
  const result = await source.read({ organizationId: scope.organizationId, asOf });
  assert.equal(result.coverage, "partial");
  assert.equal(result.operatingCash.amountCents, null);
  assert.equal(result.restrictedCash.amountCents, null);
  assert.match(result.note ?? "", /entity-missing/);
});

test("portfolio source rejects mixed QuickBooks environments", () => {
  const sandboxScope = { ...scope, legalEntityId: "entity-sandbox", realmId: "realm-sandbox", environment: "sandbox" as const };
  assert.throws(() => createQuickBooksForecastPortfolioBalanceSource({
    entities: [
      { scope, basis: "Accrual", currency: "USD", client: { getReport: async () => response({ scope, noReportData: true }) }, classifications: [] },
      { scope: sandboxScope, basis: "Accrual", currency: "USD", client: { getReport: async () => response({ scope: sandboxScope, noReportData: true }) }, classifications: [] },
    ], expectedLegalEntityIds: [scope.legalEntityId, sandboxScope.legalEntityId],
  }), /share one environment/);
});
