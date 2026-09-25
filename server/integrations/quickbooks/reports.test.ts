import assert from "node:assert/strict";
import test from "node:test";
import { createQuickBooksAccountingClient, DEFAULT_QUICKBOOKS_MINOR_VERSION } from "./accounting";
import { QuickBooksIntegrationError } from "./errors";
import { createQuickBooksReportsClient } from "./reports";

const scope = { organizationId: "org", legalEntityId: "entity", realmId: "123456", environment: "sandbox" as const };

test("uses the native reports endpoint and verifies provider basis, period, currency, and filters", async () => {
  let requestUrl = "";
  const client = createQuickBooksReportsClient({
    scope,
    getAccessToken: async () => "access",
    transport: async request => {
      requestUrl = request.url;
      return {
        status: 200,
        headers: { intuit_tid: "tid-1" },
        body: JSON.stringify({ Header: { ReportBasis: "Cash", StartPeriod: "2026-09-01", EndPeriod: "2026-09-21", Currency: "USD", Account: "bank-1" }, Rows: { Row: [] } }),
      };
    },
  });
  const result = await client.getReport("ProfitAndLoss", {
    startDate: "2026-09-01", endDate: "2026-09-21", accountingMethod: "Cash", account: "bank-1", expectedCurrency: "USD",
  });
  const url = new URL(requestUrl);
  assert.equal(url.pathname, "/v3/company/123456/reports/ProfitAndLoss");
  assert.equal(url.searchParams.get("accounting_method"), "Cash");
  assert.equal(url.searchParams.get("start_date"), "2026-09-01");
  assert.equal(url.searchParams.get("end_date"), "2026-09-21");
  assert.equal(url.searchParams.get("minorversion"), DEFAULT_QUICKBOOKS_MINOR_VERSION);
  assert.equal(url.searchParams.get("expectedCurrency"), null);
  assert.equal(result.accountingMethod, "Cash");
  assert.equal(result.currency, "USD");
  assert.equal(result.intuitTid, "tid-1");
});

test("classifies a 2xx report Fault envelope without exposing provider text", async () => {
  const client = createQuickBooksReportsClient({
    scope,
    getAccessToken: async () => "access",
    transport: async () => ({
      status: 200,
      headers: { intuit_tid: "tid-report-fault" },
      body: JSON.stringify({ Fault: { Error: [{ code: "6000", Message: "Sensitive report context", Detail: "private-detail" }] } }),
    }),
  });

  await assert.rejects(() => client.getReport("ProfitAndLoss"), (error: unknown) => {
    assert.ok(error instanceof QuickBooksIntegrationError);
    assert.equal(error.code, "quickbooks_api");
    assert.equal(error.status, 200);
    assert.equal(error.details.providerCode, "6000");
    assert.equal(error.intuitTid, "tid-report-fault");
    assert.doesNotMatch(`${error.message}\n${JSON.stringify(error.details)}\n${JSON.stringify(error)}`, /Sensitive report context|private-detail/);
    return true;
  });
});

test("fails closed when the provider report context does not match the request", async () => {
  const client = createQuickBooksReportsClient({
    scope,
    getAccessToken: async () => "access",
    transport: async () => ({ status: 200, body: JSON.stringify({ Header: { ReportBasis: "Accrual", StartPeriod: "2026-09-01", EndPeriod: "2026-09-21", Currency: "USD" } }) }),
  });
  await assert.rejects(() => client.getReport("ProfitAndLoss", { startDate: "2026-09-01", endDate: "2026-09-21", accountingMethod: "Cash" }), /basis/);
});

test("verifies provider context from Header.Options name/value entries", async () => {
  const client = createQuickBooksReportsClient({
    scope,
    getAccessToken: async () => "access",
    transport: async () => ({
      status: 200,
      body: JSON.stringify({ Header: {
        Options: [
          { Name: "AccountingMethod", Value: "Cash" },
          { Name: "StartPeriod", Value: "2026-09-01" },
          { Name: "EndPeriod", Value: "2026-09-21" },
          { Name: "Currency", Value: "USD" },
          { Name: "Account", Value: "bank-1" },
        ],
      }, Rows: { Row: [] } }),
    }),
  });
  const result = await client.getReport("ProfitAndLoss", { startDate: "2026-09-01", endDate: "2026-09-21", accountingMethod: "Cash", account: "bank-1", expectedCurrency: "USD" });
  assert.equal(result.accountingMethod, "Cash");
  assert.equal(result.currency, "USD");
});

test("keeps large report monetary cells as exact text", async () => {
  const client = createQuickBooksReportsClient({
    scope,
    getAccessToken: async () => "access",
    transport: async () => ({
      status: 200,
      body: '{"Header":{"ReportBasis":"Cash","StartPeriod":"2026-09-01","EndPeriod":"2026-09-21","Currency":"USD"},"Rows":{"Row":[{"ColData":[{"value":90071992547409.93}]}]}}',
    }),
  });
  const result = await client.getReport("ProfitAndLoss", { startDate: "2026-09-01", endDate: "2026-09-21", accountingMethod: "Cash" });
  const row = (result.raw.Rows as { Row: Array<{ ColData: Array<{ value: unknown }> }> }).Row[0];
  assert.equal(row?.ColData[0]?.value, "90071992547409.93");
});

test("a report HTTP 429 starts the realm's back-off, which report and accounting requests both honour", async () => {
  let calls = 0;
  const transport = async () => {
    calls += 1;
    return { status: 429, headers: { "retry-after": "90" }, body: JSON.stringify({ Fault: { Error: [{ code: "003001" }] } }) };
  };
  const reportsScope = { ...scope, realmId: "7654321" };
  const reports = createQuickBooksReportsClient({ scope: reportsScope, getAccessToken: async () => "access", transport });
  await assert.rejects(() => reports.getReport("ProfitAndLoss"), (error: unknown) => error instanceof QuickBooksIntegrationError && error.code === "quickbooks_rate_limited" && error.retryAfterMs === 90_000);
  await assert.rejects(() => reports.getReport("BalanceSheet"), (error: unknown) => error instanceof QuickBooksIntegrationError && error.code === "quickbooks_rate_limited" && (error.retryAfterMs ?? 0) > 80_000);
  const accounting = createQuickBooksAccountingClient({ scope: reportsScope, getAccessToken: async () => "access", transport });
  await assert.rejects(() => accounting.query("select * from Account"), (error: unknown) => error instanceof QuickBooksIntegrationError && error.code === "quickbooks_rate_limited");
  assert.equal(calls, 1, "nothing more is sent to a throttled realm");
});
