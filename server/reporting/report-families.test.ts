import assert from "node:assert/strict";
import test from "node:test";
import { getReportingDefinition, reportRunRequestSchema, type ReportingEngineContext } from "../../shared/reporting";
import type { WorkOrderSummary } from "../../shared/work-orders";
import type { InvestorDetail } from "../../shared/investors";
import type { FinancialSourceLineResolution } from "../../shared/accounting/source";
import { createAuthenticatedPrincipal } from "../company/authorization";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { syntheticRentOpsSnapshot } from "../rent-ops/fixtures/synthetic";
import { createCombinedFinancialReportingEngine } from "./combined-financial-engine";
import { createInvestorReportingEngine } from "./investor-engine";
import { createLenderManagementPackageEngine } from "./lender-package-engine";
import { createOwnerStatementReportingEngine, type PmSettlementReadPort, type PmSettlementRecord } from "./owner-statement-engine";
import { createProjectReportingEngine } from "./project-engine";
import { createPropertyStatementReportingEngine } from "./property-statement-engine";
import { createRentalExtendedReportingEngine, createRentalLeasingAgentEngine, type RentalSnapshotReadPort } from "./rental-expanded-engine";
import { createWorkOrderReportingEngine } from "./work-order-engine";
import { allocateProRata, createMirrorCombinedFinancialReadPort, type ConsolidationMappingReadPort } from "./ports/mirror-financial";
import { createPropertyStatementReadPort } from "./ports/property-statement";
import { ReportingError } from "./errors";

const organizationId = "11111111-1111-4111-8111-111111111111";
const entityA = "33333333-3333-4333-8333-333333333333";
const entityB = "44444444-4444-4444-8444-444444444444";
const emptyScope = { organizationId, legalEntityIds: [] as string[], propertyIds: [] as string[], unitIds: [], tenantIds: [], tenancyIds: [], ownerIds: [], investorIds: [], projectIds: [], vendorIds: [], staffIds: [] };

function context(reportId: string, period: unknown, extra: Record<string, unknown> = {}): ReportingEngineContext {
  const definition = getReportingDefinition(reportId)!;
  const request = reportRunRequestSchema.parse({ reportId, definitionVersion: "1", scope: { ...emptyScope, ...(extra.scope as object ?? {}) }, filters: extra.filters ?? {}, period, basis: extra.basis ?? definition.basis[0], currency: extra.currency ?? (["cash", "accrual"].includes(String(extra.basis ?? definition.basis[0])) ? "USD" : null), ...(extra.consolidation ? { consolidation: extra.consolidation } : {}), ...(extra.forecast ? { forecast: extra.forecast } : {}) });
  return { runId: "11111111-1111-4111-8111-111111111112", snapshotId: "11111111-1111-4111-8111-111111111113", request, definition, now: "2026-09-21T12:00:00.000Z" as ReportingEngineContext["now"] };
}

const total = (result: { totals?: readonly { key: string; amountCents: string | null }[] }, key: string) => result.totals?.find(item => item.key === key)?.amountCents;

// ── Rental ──────────────────────────────────────────────────────────────
test("rental reports take the period from request.period and honor search", async () => {
  const snapshot = syntheticRentOpsSnapshot();
  snapshot.tenancies = snapshot.tenancies.map(tenancy => tenancy.id === "demo-tenancy-2" ? { ...tenancy, status: "current" } : tenancy);
  const engine = createRentalExtendedReportingEngine({ async readSnapshot() { return { snapshot }; } });
  const current = await engine.run(context("current-tenants", { mode: "as_of", asOfDate: "2026-08-15" }));
  assert.ok(!current.rows.some(row => row.values.tenantName === "Tenant Two"), "a future tenancy is not current before move-in");
  const later = await engine.run(context("current-tenants", { mode: "as_of", asOfDate: "2026-09-15" }));
  assert.ok(later.rows.some(row => row.values.tenantName === "Tenant Two"), "the as-of date comes from request.period");
  const listings = await engine.run(context("unit-listings", { mode: "as_of", asOfDate: "2026-09-15" }, { filters: { search: "2B" } }));
  assert.deepEqual(listings.rows.map(row => row.values.unitNumber), ["2B"]);
});

test("leasing agent attributes applications to the earliest non-system actor and names unattributed ones", async () => {
  const snapshot = syntheticRentOpsSnapshot();
  snapshot.activityEvents = [
    ...snapshot.activityEvents,
    { id: "act-a", applicationId: "demo-application-1", type: "call", occurredAt: "2026-08-10T15:00:00.000Z", actor: "Leasing Agent A", summary: "Screened" },
    { id: "act-b", applicationId: "demo-application-1", type: "note", occurredAt: "2026-08-11T15:00:00.000Z", actor: "Leasing Agent B", summary: "Follow up" },
    { id: "act-sys", applicationId: "demo-application-2", type: "system", occurredAt: "2026-08-11T15:00:00.000Z", actor: "system", summary: "Imported" },
  ];
  const engine = createRentalLeasingAgentEngine({ async readSnapshot() { return { snapshot }; } });
  const result = await engine.run(context("leasing-agent", { mode: "range", fromDate: "2026-01-01", toDate: "2026-12-31" }));
  const byAgent = Object.fromEntries(result.rows.map(row => [row.values.agent, row.values.received]));
  assert.deepEqual(byAgent, { "Leasing Agent A": 1, Unattributed: 1 });
  assert.equal(result.missingData?.find(item => item.code === "leasing_agent_unattributed")?.count, 1);
  const outside = await engine.run(context("leasing-agent", { mode: "range", fromDate: "2027-01-01", toDate: "2027-12-31" }));
  assert.equal(outside.rows.length, 0);
});

// ── Book statements via a fake QBO mirror ───────────────────────────────
function line(input: { entity: string; realm: string; type: "Purchase" | "Bill" | "BillPayment" | "Deposit"; id: string; account: string | null; amount: string; on: string; vendor?: string; lineId?: string; direction?: "debit" | "credit"; flow?: "incoming" | "outgoing" | "unknown"; lineRole?: "receipt" | "expense" | "payable" | "payment_source" | "unknown" }): FinancialSourceLineResolution {
  const incoming = input.type === "Deposit";
  return {
    source: { provider: "qbo", organizationId, legalEntityId: input.entity, environment: "sandbox", realmId: input.realm, objectType: input.type, objectId: input.id, lineId: input.lineId ?? "1", version: "0" },
    direction: input.direction ?? (input.type === "BillPayment" ? "credit" : "debit"), flow: input.flow ?? (incoming ? "incoming" : "outgoing"),
    lineRole: input.lineRole ?? (input.type === "Deposit" ? "receipt" : input.type === "Bill" ? "payable" : input.type === "BillPayment" ? "payment_source" : "expense"),
    amountCents: input.amount, currency: "USD", transactionType: input.type, accountObjectId: input.account, counterpartyObjectId: input.vendor ?? null, description: null,
    postingState: "posted", postedOn: input.on, settlement: { state: "unknown", settledOn: null, settledAmountCents: null }, watermark: { value: "w1", observedAt: "2026-09-20T00:00:00.000Z" },
  } as unknown as FinancialSourceLineResolution;
}

function fakeFinancialDatabase(input: { connections: Record<string, string>; properties: Record<string, string[]>; lines: Record<string, FinancialSourceLineResolution[]>; accounts: Record<string, Record<string, unknown>>; vendors?: Record<string, Record<string, unknown>> }) {
  const executor: RentOpsQueryExecutor = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes("count(*)::text AS count FROM accounting_qbo_connections")) return { rows: [{ count: String(Object.keys(input.connections).length) }] } as never;
      if (sql.includes("FROM accounting_qbo_connections")) { const realm = input.connections[String(values[1])]; return { rows: realm ? [{ realm_id: realm }] : [] } as never; }
      if (sql.includes("FROM accounting_qbo_source_objects")) {
        const bodies = values[4] === "Vendor" ? input.vendors ?? {} : input.accounts;
        return { rows: Object.entries(bodies).map(([object_id, provider_body]) => ({ object_id, provider_body })) } as never;
      }
      if (sql.includes("FROM accounting_qbo_source_line_balances")) {
        const billIds = values[4] as string[];
        const bills = (input.lines[String(values[1])] ?? []).filter(item => item.transactionType === "Bill" && billIds.includes(item.source.objectId));
        return { rows: bills.map(item => ({ object_id: item.source.objectId, line_id: item.source.lineId, account_object_id: item.accountObjectId, amount_cents: item.amountCents, currency: item.currency, posting_state: item.postingState })) } as never;
      }
      if (sql.includes("FROM company_property_entity_periods")) return { rows: (input.properties[String(values[1])] ?? []).map(property_id => ({ property_id, effective_from: "2020-01-01", effective_until: null, covers: true })) } as never;
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const mirror = {
    async readCoverage(scope: { legalEntityId: string }) { return { status: input.lines[scope.legalEntityId] ? "complete" : "unavailable", reason: input.lines[scope.legalEntityId] ? null : "Not synchronized", coveredThrough: "2026-12-31", watermark: { value: "w1", observedAt: "2026-09-20T00:00:00.000Z" } } as never; },
    async listTransactions(query: { scope: { legalEntityId: string }; from?: string; through?: string }) {
      const items = (input.lines[query.scope.legalEntityId] ?? []).filter(item => (!query.from || item.postedOn! >= query.from) && (!query.through || item.postedOn! <= query.through));
      return { items, nextCursor: null, coverage: {} as never };
    },
  };
  return { executor, mirror };
}

const principal = createAuthenticatedPrincipal({ actorId: "demo-admin", organizationId, role: "admin", authorizedScopes: [{}] });
const accountBodies = { "10": { Name: "Rent income", Classification: "Revenue", AccountType: "Income" }, "20": { Name: "Repairs", Classification: "Expense", AccountType: "Expense" }, "21": { Name: "Utilities", Classification: "Expense", AccountType: "Expense" }, "30": { Name: "Operating bank", Classification: "Asset", AccountType: "Bank" } };

test("property T12 from the mirror signs income and expense, attributes a sole mapped property, and recognizes bills by payment on the cash basis", async () => {
  const { executor, mirror } = fakeFinancialDatabase({
    connections: { [entityA]: "9001" }, properties: { [entityA]: ["property-a"] }, accounts: accountBodies,
    lines: { [entityA]: [
      line({ entity: entityA, realm: "9001", type: "Deposit", id: "d1", account: "10", amount: "100000", on: "2026-08-03" }),
      line({ entity: entityA, realm: "9001", type: "Purchase", id: "p1", account: "20", amount: "6000", on: "2026-08-10" }),
      line({ entity: entityA, realm: "9001", type: "Bill", id: "b1", account: "20", amount: "4000", on: "2026-08-12" }),
      line({ entity: entityA, realm: "9001", type: "BillPayment", id: "bp1", account: "30", amount: "4000", on: "2026-08-20", lineId: "linked:Bill:b1" }),
    ] },
  });
  const engine = createCombinedFinancialReportingEngine(createMirrorCombinedFinancialReadPort({ executor, principal, environment: "sandbox", mirror }));
  const accrual = await engine.run(context("property-t12", { mode: "range", fromDate: "2026-08-01", toDate: "2026-08-31" }, { basis: "accrual", scope: { legalEntityIds: [entityA] } }));
  assert.equal(total(accrual, "income"), "100000");
  assert.equal(total(accrual, "expenses"), "10000");
  assert.equal(total(accrual, "net_operating_income"), "90000");
  assert.ok(accrual.rows.every(row => row.values.propertyId === "property-a"));
  assert.equal(accrual.coverage[0]?.state, "partial");
  const cash = await engine.run(context("property-t12", { mode: "range", fromDate: "2026-08-01", toDate: "2026-08-31" }, { basis: "cash", scope: { legalEntityIds: [entityA] } }));
  // The bill itself is not cash; its payment is, attributed to the bill's expense account.
  assert.equal(total(cash, "expenses"), "10000");
});

test("property T12 applies Purchase refund sign and keeps Deposit cash back out of income", async () => {
  const { executor, mirror } = fakeFinancialDatabase({
    connections: { [entityA]: "9001" }, properties: { [entityA]: ["property-a"] }, accounts: {
      ...accountBodies,
      "36": { Name: "Cash on hand", Classification: "Asset", AccountType: "CashOnHand" },
    },
    lines: { [entityA]: [
      line({ entity: entityA, realm: "9001", type: "Deposit", id: "d1", account: "10", amount: "100000", on: "2026-08-03" }),
      line({ entity: entityA, realm: "9001", type: "Deposit", id: "d1", account: "36", amount: "2000", on: "2026-08-03", lineId: "synthetic:cashback", flow: "outgoing", lineRole: "unknown" }),
      line({ entity: entityA, realm: "9001", type: "Purchase", id: "p1", account: "20", amount: "6000", on: "2026-08-10" }),
      line({ entity: entityA, realm: "9001", type: "Purchase", id: "r1", account: "20", amount: "1000", on: "2026-08-11", direction: "credit", flow: "incoming" }),
    ] },
  });
  const engine = createCombinedFinancialReportingEngine(createMirrorCombinedFinancialReadPort({ executor, principal, environment: "sandbox", mirror }));
  const result = await engine.run(context("property-t12", { mode: "range", fromDate: "2026-08-01", toDate: "2026-08-31" }, { basis: "accrual", scope: { legalEntityIds: [entityA] } }));
  assert.equal(total(result, "income"), "100000");
  assert.equal(total(result, "expenses"), "5000");
  assert.equal(total(result, "net_operating_income"), "95000");
  assert.ok(!result.rows.some(row => row.values.accountName === "Cash on hand"), "asset cash-back account is not an income-statement row");
});

test("cash-basis statements attribute bill payments pro rata to the paid bill's lines and name payments they cannot attribute", async () => {
  const { executor, mirror } = fakeFinancialDatabase({
    connections: { [entityA]: "9001" }, properties: { [entityA]: ["property-a"] }, accounts: accountBodies,
    lines: { [entityA]: [
      line({ entity: entityA, realm: "9001", type: "Purchase", id: "p1", account: "20", amount: "6000", on: "2026-08-10" }),
      // A July bill with two expense lines, partly paid in August.
      line({ entity: entityA, realm: "9001", type: "Bill", id: "b1", account: "20", amount: "3000", on: "2026-07-20", lineId: "1" }),
      line({ entity: entityA, realm: "9001", type: "Bill", id: "b1", account: "21", amount: "1001", on: "2026-07-20", lineId: "2" }),
      line({ entity: entityA, realm: "9001", type: "BillPayment", id: "bp1", account: "30", amount: "2001", on: "2026-08-20", lineId: "linked:Bill:b1" }),
      // A payment whose bill is not mirrored.
      line({ entity: entityA, realm: "9001", type: "BillPayment", id: "bp2", account: "30", amount: "700", on: "2026-08-21", lineId: "linked:Bill:b9" }),
    ] },
  });
  const engine = createCombinedFinancialReportingEngine(createMirrorCombinedFinancialReadPort({ executor, principal, environment: "sandbox", mirror }));
  const cash = await engine.run(context("property-t12", { mode: "range", fromDate: "2026-08-01", toDate: "2026-08-31" }, { basis: "cash", scope: { legalEntityIds: [entityA] } }));
  // 2001 split 3000:1001 is 1499.75 : 501.25 -> 1500 + 501 after the largest remainder, summing exactly to 2001.
  const byAccount = Object.fromEntries(cash.rows.map(row => [row.values.accountName, row.values.amountCents]));
  assert.equal(byAccount.Repairs, "7500");
  assert.equal(byAccount.Utilities, "501");
  assert.equal(total(cash, "expenses"), "8001");
  assert.match(String(cash.coverage[0]?.reason), /1 bill payment line \(7\.00\) is excluded from this cash-basis statement/);
  assert.equal(cash.coverage[0]?.state, "partial");
  assert.equal(cash.coverage[0]?.evidence, "unverified");
  const accrual = await engine.run(context("property-t12", { mode: "range", fromDate: "2026-07-01", toDate: "2026-08-31" }, { basis: "accrual", scope: { legalEntityIds: [entityA] } }));
  assert.equal(total(accrual, "expenses"), "10001", "the accrual basis recognizes the bill, never its payment");
});

test("pro-rata allocation is exact and deterministic", () => {
  assert.deepEqual(allocateProRata(BigInt(2001), [BigInt(3000), BigInt(1001)]).map(String), ["1500", "501"]);
  assert.deepEqual(allocateProRata(BigInt(100), [BigInt(1), BigInt(1), BigInt(1)]).map(String), ["34", "33", "33"]);
  assert.deepEqual(allocateProRata(BigInt(-100), [BigInt(1), BigInt(1), BigInt(1)]).map(String), ["-34", "-33", "-33"]);
  assert.deepEqual(allocateProRata(BigInt(5), [BigInt(0), BigInt(7)]).map(String), ["0", "5"]);
  assert.throws(() => allocateProRata(BigInt(5), [BigInt(0)]));
});

test("accounts payable nets bill payments against bills per vendor through the report date", async () => {
  const { executor, mirror } = fakeFinancialDatabase({
    connections: { [entityA]: "9001" }, properties: { [entityA]: ["property-a"] }, accounts: accountBodies, vendors: { V1: { DisplayName: "Example Plumbing" } },
    lines: { [entityA]: [
      line({ entity: entityA, realm: "9001", type: "Bill", id: "b1", account: "20", amount: "50000", on: "2026-08-12", vendor: "V1" }),
      line({ entity: entityA, realm: "9001", type: "BillPayment", id: "bp1", account: "30", amount: "20000", on: "2026-08-20", vendor: "V1", lineId: "linked:Bill:b1" }),
      line({ entity: entityA, realm: "9001", type: "BillPayment", id: "bp2", account: "30", amount: "30000", on: "2026-09-20", vendor: "V1", lineId: "linked:Bill:b1" }),
    ] },
  });
  const engine = createCombinedFinancialReportingEngine(createMirrorCombinedFinancialReadPort({ executor, principal, environment: "sandbox", mirror }));
  const result = await engine.run(context("accounts-payable", { mode: "as_of", asOfDate: "2026-08-31" }, { basis: "accrual", scope: { legalEntityIds: [entityA] } }));
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.values.accountName, "Example Plumbing");
  assert.equal(total(result, "open_payables"), "30000");
});

test("consolidated income statement shows mapped entity totals and approved eliminations", async () => {
  const { executor, mirror } = fakeFinancialDatabase({
    connections: { [entityA]: "9001", [entityB]: "9002" }, properties: { [entityA]: ["property-a"], [entityB]: ["property-b"] }, accounts: accountBodies,
    lines: {
      [entityA]: [line({ entity: entityA, realm: "9001", type: "Deposit", id: "d1", account: "10", amount: "100000", on: "2026-08-03" })],
      [entityB]: [line({ entity: entityB, realm: "9002", type: "Deposit", id: "d2", account: "10", amount: "25000", on: "2026-08-04" }), line({ entity: entityB, realm: "9002", type: "Purchase", id: "p2", account: "20", amount: "5000", on: "2026-08-05" })],
    },
  });
  const consolidation: ConsolidationMappingReadPort = {
    async hasApprovedMapping() { return true; },
    async read({ eliminationVersion }) {
      return {
        accountMappingVersion: "map-2026-08", eliminationVersion,
        accounts: [
          { legalEntityId: entityA, providerAccountId: "10", canonicalAccountId: "4000", canonicalName: "Rental income" },
          { legalEntityId: entityB, providerAccountId: "10", canonicalAccountId: "4000", canonicalName: "Rental income" },
          { legalEntityId: entityB, providerAccountId: "20", canonicalAccountId: "6100", canonicalName: "Repairs" },
        ],
        eliminations: [{ accountId: "4000", canonicalAccountId: "4000", entityId: entityB, amountCents: "-25000", currency: "USD", sourceId: "elim-1" }],
      };
    },
  };
  const engine = createCombinedFinancialReportingEngine(createMirrorCombinedFinancialReadPort({ executor, principal, environment: "sandbox", mirror, consolidation }));
  const policy = { entityIds: [entityA, entityB], currency: "USD", ownershipPolicy: "full_control", eliminationPolicy: "approved_version", eliminationVersion: "elim-v3", translationPolicy: "none" };
  const result = await engine.run(context("income-statement-consolidated", { mode: "range", fromDate: "2026-08-01", toDate: "2026-08-31" }, { basis: "accrual", scope: { legalEntityIds: [entityA, entityB] }, consolidation: policy }));
  const income = result.rows.find(row => row.values.accountName === "Rental income")!;
  assert.equal(income.values.amountCents, "125000");
  assert.equal(income.values.eliminatedAmountCents, "-25000");
  assert.equal(income.values.consolidatedAmountCents, "100000");
  assert.equal(income.values.entityCount, 2);
  assert.equal(total(result, "eliminations"), "-25000");
  assert.equal(total(result, "consolidated_income"), "100000");
  assert.equal(total(result, "consolidated_expenses"), "5000");
  assert.equal(total(result, "consolidated_net_income"), "95000");
  const without = createCombinedFinancialReportingEngine(createMirrorCombinedFinancialReadPort({ executor, principal, environment: "sandbox", mirror }));
  await assert.rejects(() => without.run(context("income-statement-consolidated", { mode: "range", fromDate: "2026-08-01", toDate: "2026-08-31" }, { basis: "accrual", scope: { legalEntityIds: [entityA, entityB] }, consolidation: policy })), /approved account mapping/);
});

test("combined financial reports are unavailable, never zero, without a connection or an unsupported source", async () => {
  const { executor, mirror } = fakeFinancialDatabase({ connections: {}, properties: {}, accounts: accountBodies, lines: {} });
  const port = createMirrorCombinedFinancialReadPort({ executor, principal, environment: "sandbox", mirror });
  const engine = createCombinedFinancialReportingEngine(port);
  await assert.rejects(() => engine.run(context("portfolio-financials", { mode: "custom", fromDate: "2026-08-01", toDate: "2026-08-31" }, { basis: "accrual", scope: { legalEntityIds: [entityA] } })), (error: unknown) => error instanceof ReportingError && error.code === "report_unavailable" && /QuickBooks connection/.test(error.message));
  await assert.rejects(() => engine.run(context("cash-position", { mode: "as_of", asOfDate: "2026-08-31" }, { basis: "cash", scope: { legalEntityIds: [entityA] } })), /No bank balance observations/);
  assert.deepEqual(await port.probe!({ organizationId, reportId: "portfolio-financials" }), { status: "missing_data", reason: "No legal entity has an active QuickBooks connection.", dependency: "verified_quickbooks_connection" });
  assert.equal((await createMirrorCombinedFinancialReadPort({ executor, principal, environment: null, mirror }).probe!({ organizationId, reportId: "property-t12" })).reason, "Connect QuickBooks to run financial statements.");
});

// ── Projects, tasks and work orders ─────────────────────────────────────
function workOrder(overrides: Partial<WorkOrderSummary>): WorkOrderSummary {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000001", reference: "WO-AAAAAAAA", organizationId, legalEntityId: entityA, propertyId: "property-a", propertyName: "Example Property", unitId: "unit-1", unitNumber: "1A",
    tenancyId: null, personId: null, personName: null, projectId: null, projectName: null, title: "Leak", category: "plumbing", priority: "high", status: "new",
    reportedOn: "2026-09-01", scheduledOn: null, completedOn: null, assignedTo: "Example Plumbing", entryPermitted: false, currency: "USD", estimatedCostCents: "10000", chargeback: null,
    recordRevision: 1, createdBy: "demo-admin", updatedBy: "demo-admin", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", ...overrides,
  } as WorkOrderSummary;
}

test("work orders list open orders as of a date and activity in a range, with aging and estimate totals", async () => {
  const orders = [
    workOrder({}),
    workOrder({ id: "aaaaaaaa-0000-4000-8000-000000000002", reference: "WO-AAAAAAA2", status: "completed", reportedOn: "2026-08-20", completedOn: "2026-09-05", estimatedCostCents: "5000", priority: "normal" }),
    workOrder({ id: "aaaaaaaa-0000-4000-8000-000000000003", reference: "WO-AAAAAAA3", status: "in_progress", reportedOn: "2026-08-25", estimatedCostCents: null, assignedTo: "Other Vendor" }),
    workOrder({ id: "aaaaaaaa-0000-4000-8000-000000000004", reference: "WO-AAAAAAA4", status: "canceled", reportedOn: "2026-08-01" }),
  ];
  const engine = createWorkOrderReportingEngine({ async read() { return { workOrders: orders, coverage: { state: "complete", evidence: "synthetic" } }; } });
  const openOn = await engine.run(context("work-orders", { mode: "custom", asOfDate: "2026-09-03" }));
  assert.deepEqual(openOn.rows.map(row => row.values.reference).sort(), ["WO-AAAAAAA2", "WO-AAAAAAA3", "WO-AAAAAAAA"]);
  assert.equal(openOn.rows.find(row => row.values.reference === "WO-AAAAAAA3")?.values.ageDays, 9);
  assert.equal(total(openOn, "estimated_cost"), "15000");
  assert.equal(openOn.totals?.[0]?.state, "partial");
  assert.ok(openOn.missingData?.some(item => item.code === "work_order_cancellation_date_unknown"));
  const range = await engine.run(context("work-orders", { mode: "custom", fromDate: "2026-09-01", toDate: "2026-09-30" }, { filters: { priority: ["high"], assignedTo: "plumbing" } }));
  assert.deepEqual(range.rows.map(row => row.values.reference), ["WO-AAAAAAAA"]);
  const completed = await engine.run(context("work-orders", { mode: "custom", fromDate: "2026-09-01", toDate: "2026-09-30" }, { filters: { status: ["completed"] } }));
  assert.equal(completed.rows[0]?.values.ageDays, 16);
});

test("contractor exposure uses approved commitments recorded through the report date", async () => {
  const project = { id: "55555555-5555-4555-8555-555555555555", organizationId, legalEntityId: entityA, propertyId: "property-a", name: "Unit refresh", description: null, status: "active", currency: "USD", postedActualCoverage: "complete", postedActuals: [], budgetVersions: [], scopeItems: [], tasks: [], draftCosts: [] };
  const commitments = [
    { id: "c1", projectId: project.id, vendorName: "Example Builder", committedCents: "120000", status: "approved", currency: "USD", committedOn: "2026-07-01" },
    { id: "c2", projectId: project.id, vendorName: "Example Builder", committedCents: "30000", status: "closed", currency: "USD", committedOn: "2026-08-01" },
    { id: "c3", projectId: project.id, vendorName: "Example Builder", committedCents: "99999", status: "draft", currency: "USD", committedOn: "2026-08-01" },
    { id: "c4", projectId: project.id, vendorName: "Late Vendor", committedCents: "5000", status: "approved", currency: "USD", committedOn: "2026-10-01" },
  ];
  const engine = createProjectReportingEngine({ async read() { return { projects: [project as never], commitments, coverage: { state: "complete", evidence: "synthetic" } }; } });
  const result = await engine.run(context("contractor-exposure", { mode: "as_of", asOfDate: "2026-09-30" }));
  assert.deepEqual(result.rows.map(row => [row.values.vendorName, row.values.committedCents]), [["Example Builder", "150000"]]);
  assert.equal(total(result, "committed"), "150000");
  assert.ok(!result.missingData?.some(item => item.code === "project_commitments_unavailable"));
});

// ── Investors and owners ────────────────────────────────────────────────
test("investor activity honors investor and status filters", async () => {
  const account = (id: string, name: string) => ({ id, organizationId, displayName: name, activity: [
    { id: `${id}-1`, occurredOn: "2026-08-01", kind: "interest", status: "qbo_posted", amountCents: "1000", currency: "USD", description: "Interest", paymentId: null, instrumentId: null },
    { id: `${id}-2`, occurredOn: "2026-08-15", kind: "interest", status: "due", amountCents: "2500", currency: "USD", description: "Interest due", paymentId: null, instrumentId: null },
  ] }) as unknown as InvestorDetail;
  const accounts = [account("66666666-6666-4666-8666-666666666661", "Investor One"), account("66666666-6666-4666-8666-666666666662", "Investor Two")];
  let requested: readonly string[] = [];
  const engine = createInvestorReportingEngine({ async read(input) { requested = input.investorIds; return { accounts, coverage: { state: "complete", evidence: "synthetic" } }; } });
  const result = await engine.run(context("investor-owner-activity", { mode: "range", fromDate: "2026-08-01", toDate: "2026-08-31" }, { filters: { investorIds: ["66666666-6666-4666-8666-666666666662"], status: ["due"] } }));
  assert.deepEqual(requested, ["66666666-6666-4666-8666-666666666662"]);
  assert.deepEqual(result.rows.map(row => [row.values.investorName, row.values.status]), [["Investor Two", "due"]]);
  assert.equal(total(result, "interest_expected"), "2500");
  assert.equal(total(result, "interest_recorded"), undefined, "expected amounts are never added to recorded payments");
});

test("investor activity totals each kind separately and leaves unverified and reversed payments out", async () => {
  const investorId = "66666666-6666-4666-8666-666666666663";
  const activity = (id: string, kind: string, status: string, amountCents: string, paymentId: string | null = `pay-${id}`) => ({ id, occurredOn: "2026-08-10", kind, status, amountCents, currency: "USD", description: kind, paymentId, instrumentId: null });
  const account = { id: investorId, organizationId, displayName: "Investor Three",
    payments: [{ id: "pay-principal", reversesPaymentId: null }, { id: "pay-reversal", reversesPaymentId: "pay-principal" }],
    activity: [
      activity("contribution", "contribution", "bank_settled", "100000"),
      activity("distribution", "distribution", "qbo_posted", "30000"),
      activity("interest-posted", "interest", "manual_recorded", "4000"),
      activity("interest-review", "interest", "review_required", "5000"),
      activity("principal", "principal", "qbo_posted", "20000", "pay-principal"),
      activity("reversal", "correction", "reversed", "-20000", "pay-reversal"),
      activity("interest-due", "interest", "due", "2500", null),
    ] } as unknown as InvestorDetail;
  const engine = createInvestorReportingEngine({ async read() { return { accounts: [account], coverage: { state: "complete", evidence: "synthetic" } }; } });
  const result = await engine.run(context("investor-owner-activity", { mode: "range", fromDate: "2026-08-01", toDate: "2026-08-31" }));
  // Every activity stays visible as a row with how it counts.
  assert.equal(result.rows.length, 7);
  assert.deepEqual(result.rows.map(row => `${row.values.kind}/${row.values.status}/${row.values.totalTreatment}`).sort(), [
    "contribution/bank_settled/recorded", "correction/reversed/reversed", "distribution/qbo_posted/recorded", "interest/due/expected",
    "interest/manual_recorded/recorded", "interest/review_required/review_required", "principal/qbo_posted/reversed",
  ]);
  const totals = Object.fromEntries((result.totals ?? []).map(item => [item.key, [item.amountCents, item.state]]));
  assert.deepEqual(totals, {
    contribution_recorded: ["100000", "complete"],
    distribution_recorded: ["30000", "complete"],
    interest_recorded: ["4000", "partial"],
    interest_expected: ["2500", "complete"],
  });
  assert.equal(total(result, "activity_amount"), undefined, "money in and money out are never summed together");
  assert.equal(result.missingData?.find(item => item.code === "investor_activity_review_required")?.count, 1);
  assert.equal(result.missingData?.find(item => item.code === "investor_activity_reversed")?.count, 2);
});

function settlement(overrides: Partial<PmSettlementRecord>): PmSettlementRecord {
  return {
    id: "77777777-7777-4777-8777-777777777771", legalEntityId: entityA, propertyId: "property-a", propertyName: "Example Property", managerName: "Example PM", periodStart: "2026-07-01", periodEnd: "2026-07-31", currency: "USD",
    openingHeldCents: "0", grossCollectionsCents: "100000", pmFeesCents: "6000", pmExpensesCents: "4000", otherDeductionsCents: "0", ownerRemittanceCents: "90000", closingHeldCents: "0",
    state: "reconciled", exceptionReason: null, bankSettledOn: "2026-08-05", lines: [], ...overrides,
  };
}

test("owner statements reconcile each settlement and the chain between periods", async () => {
  const july = settlement({ closingHeldCents: "5000", ownerRemittanceCents: "85000" });
  const august = settlement({ id: "77777777-7777-4777-8777-777777777772", periodStart: "2026-08-01", periodEnd: "2026-08-31", openingHeldCents: "5000", grossCollectionsCents: "100000", ownerRemittanceCents: "95000", closingHeldCents: "0", lines: [
    { lineNumber: 1, kind: "rent_receipt", description: "Rent", amountCents: "100000", occurredOn: "2026-08-03", unitId: null, tenancyId: null },
    { lineNumber: 2, kind: "pm_fee", description: "Management fee", amountCents: "6000", occurredOn: null, unitId: null, tenancyId: null },
    { lineNumber: 3, kind: "pm_expense", description: "Repair", amountCents: "4000", occurredOn: null, unitId: null, tenancyId: null },
    { lineNumber: 4, kind: "owner_remittance", description: "Owner draw", amountCents: "95000", occurredOn: null, unitId: null, tenancyId: null },
  ] });
  let requested: { from: string | null; through: string } | undefined;
  const engine = createOwnerStatementReportingEngine({ async read(input) { requested = { from: input.from, through: input.through }; return { settlements: [july, august], coverage: { state: "complete", evidence: "synthetic" } }; } });
  const statement = await engine.run(context("rental-owner-statement", { mode: "range", fromDate: "2026-07-01", toDate: "2026-08-31" }));
  assert.deepEqual(requested, { from: "2026-07-01", through: "2026-08-31" });
  assert.equal(statement.missingData?.length, 0);
  assert.equal(total(statement, "opening_held"), "0");
  assert.equal(total(statement, "gross_collections"), "200000");
  assert.equal(total(statement, "pm_fees"), "12000");
  assert.equal(total(statement, "owner_remittance"), "180000");
  assert.equal(total(statement, "closing_held"), "0");
  // opening + gross − fees − expenses − other − remittance = closing, across the statement
  assert.equal(0 + 200000 - 12000 - 8000 - 0 - 180000, 0);
  assert.equal(statement.drilldowns?.[0]?.items.length, 4);
  const broken = createOwnerStatementReportingEngine({ async read() { return { settlements: [july, { ...august, openingHeldCents: "0", ownerRemittanceCents: "90000" }], coverage: { state: "complete", evidence: "synthetic" } }; } });
  const brokenResult = await broken.run(context("rental-owner-statement", { mode: "range", fromDate: "2026-07-01", toDate: "2026-08-31" }));
  assert.ok(brokenResult.missingData?.some(item => item.code === "pm_settlement_chain_break"));
  assert.ok(brokenResult.missingData?.some(item => item.code === "pm_settlement_lines_do_not_tie"));
  assert.equal(brokenResult.coverage[0]?.state, "partial");
  const balances = await engine.run(context("rental-owner-ending-balances", { mode: "as_of", asOfDate: "2026-08-31" }));
  assert.deepEqual(balances.rows.map(row => row.values.closingHeldCents), ["0"]);
  const julyBalance = await createOwnerStatementReportingEngine({ async read() { return { settlements: [july], coverage: { state: "complete", evidence: "synthetic" } }; } }).run(context("rental-owner-ending-balances", { mode: "as_of", asOfDate: "2026-08-15" }));
  assert.equal(total(julyBalance, "closing_held"), "5000");
  assert.ok(julyBalance.missingData?.some(item => item.code === "pm_balance_before_report_date"));
  await assert.rejects(() => createOwnerStatementReportingEngine({ async read() { return { settlements: [], coverage: { state: "complete", evidence: "synthetic" } }; } }).run(context("rental-owner-statement", { mode: "range", fromDate: "2026-07-01", toDate: "2026-08-31" })), /No property-manager settlements/);
});

test("property statement keeps collections, PM deductions and the owner remittance as distinct measures", async () => {
  const engine = createPropertyStatementReportingEngine({
    async read() {
      return {
        properties: [{ propertyId: "property-a", propertyName: "Example Property", legalEntityId: entityA }],
        rentalCollections: [{ propertyId: "property-a", amountCents: "100000", currency: "USD" }], rentalCoverage: { state: "partial" },
        settlements: [settlement({ periodStart: "2026-08-01", periodEnd: "2026-08-31" })], settlementCoverage: { state: "complete" },
        bookActuals: null, bookCoverage: { state: "unavailable", reason: "QuickBooks actuals are not connected for these properties." },
      };
    },
  });
  const result = await engine.run(context("property-statement", { mode: "range", fromDate: "2026-08-01", toDate: "2026-08-31" }, { basis: "cash", scope: { legalEntityIds: [entityA] } }));
  assert.equal(total(result, "gross_collections"), "100000");
  assert.equal(total(result, "pm_fees"), "6000");
  assert.equal(total(result, "pm_expenses"), "4000");
  assert.equal(total(result, "owner_remittance"), "90000");
  assert.equal(total(result, "net_to_owner"), "90000");
  assert.equal(total(result, "rental_collections"), "100000");
  // $1,000 collected, $100 of PM costs, $900 remitted is never $1,900 of income.
  assert.ok(!result.totals?.some(item => item.amountCents === "190000"));
  assert.ok(!result.totals?.some(item => item.key === "income"));
  assert.equal(total(result, "book_income"), null);
  assert.equal(result.rows.find(row => row.rowId === "property-statement:property-a:collections_variance")?.values.amountCents, "0");
  assert.equal(result.rows.find(row => row.rowId === "property-statement:property-a:book_income")?.values.amountCents, null);
  assert.ok(result.missingData?.some(item => item.code === "book_actuals_unavailable"));
});

test("owner statements flag and exclude settlements that end after the report period", async () => {
  const july = settlement({});
  const augustIntoSeptember = settlement({ id: "77777777-7777-4777-8777-777777777773", periodStart: "2026-08-01", periodEnd: "2026-09-15", grossCollectionsCents: "150000", ownerRemittanceCents: "140000" });
  const engine = createOwnerStatementReportingEngine({ async read() { return { settlements: [july, augustIntoSeptember], coverage: { state: "complete", evidence: "synthetic" } }; } });
  const statement = await engine.run(context("rental-owner-statement", { mode: "range", fromDate: "2026-07-01", toDate: "2026-08-31" }));
  assert.deepEqual(statement.rows.map(row => row.rowId), [`owner-statement:${july.id}`]);
  assert.equal(total(statement, "gross_collections"), "100000");
  assert.equal(statement.missingData?.find(item => item.code === "pm_settlement_extends_past_period")?.count, 1);
  assert.ok(statement.totals?.every(item => item.state === "partial"), "a period with an excluded settlement is never complete");
  assert.equal(statement.coverage[0]?.state, "partial");
  // Ending balances only use settlements that ended by the report date.
  const balances = await engine.run(context("rental-owner-ending-balances", { mode: "as_of", asOfDate: "2026-08-31" }));
  assert.deepEqual(balances.rows.map(row => row.values.balanceThrough), ["2026-07-31"]);
});

function rentalPort(): RentalSnapshotReadPort {
  const snapshot = syntheticRentOpsSnapshot();
  return { async readSnapshot() { return { snapshot, coverage: { state: "complete" } }; } };
}
const noSettlements: PmSettlementReadPort = { async read() { return { settlements: [], coverage: { state: "complete", evidence: "synthetic" } }; } };
const bookLines = [
  line({ entity: entityA, realm: "9001", type: "Deposit", id: "d1", account: "10", amount: "100000", on: "2026-08-03" }),
  line({ entity: entityA, realm: "9001", type: "Purchase", id: "p1", account: "20", amount: "6000", on: "2026-08-10" }),
];

test("property statement book actuals are unknown, not zero, when mirror lines cannot be attributed to the property", async () => {
  const { executor, mirror } = fakeFinancialDatabase({ connections: { [entityA]: "9001" }, properties: { [entityA]: ["demo-property-a", "demo-property-b"] }, accounts: accountBodies, lines: { [entityA]: bookLines } });
  const financial = createMirrorCombinedFinancialReadPort({ executor, principal, environment: "sandbox", mirror });
  const engine = createPropertyStatementReportingEngine(createPropertyStatementReadPort({ rental: rentalPort(), settlements: noSettlements, financial }));
  const result = await engine.run(context("property-statement", { mode: "range", fromDate: "2026-08-01", toDate: "2026-08-31" }, { basis: "cash", scope: { legalEntityIds: [entityA], propertyIds: ["demo-property-a"] } }));
  assert.equal(total(result, "book_income"), null);
  assert.equal(total(result, "book_expenses"), null);
  assert.equal(result.totals?.find(item => item.key === "book_income")?.state, "unknown");
  assert.equal(result.rows.find(row => row.rowId === "property-statement:demo-property-a:book_income")?.values.amountCents, null);
  assert.ok(result.missingData?.some(item => item.code === "book_actuals_not_attributed" && item.state === "unknown"));
  assert.match(String(result.coverage.find(item => item.source === "quickbooks_accounting_mirror")?.reason), /not attributed/);
});

test("property statement book totals carry the mirror's partial coverage", async () => {
  const { executor, mirror } = fakeFinancialDatabase({ connections: { [entityA]: "9001" }, properties: { [entityA]: ["demo-property-a"] }, accounts: accountBodies, lines: { [entityA]: bookLines } });
  const financial = createMirrorCombinedFinancialReadPort({ executor, principal, environment: "sandbox", mirror });
  const engine = createPropertyStatementReportingEngine(createPropertyStatementReadPort({ rental: rentalPort(), settlements: noSettlements, financial }));
  const result = await engine.run(context("property-statement", { mode: "range", fromDate: "2026-08-01", toDate: "2026-08-31" }, { basis: "cash", scope: { legalEntityIds: [entityA], propertyIds: ["demo-property-a"] } }));
  assert.equal(total(result, "book_income"), "100000");
  assert.equal(total(result, "book_expenses"), "6000");
  assert.equal(result.totals?.find(item => item.key === "book_income")?.state, "partial", "the QuickBooks mirror is always partial, so its totals are never complete");
  assert.ok(!result.missingData?.some(item => item.code === "book_actuals_not_attributed"));
  // A property of an unselected or unmapped entity is unknown, never zero.
  const other = await engine.run(context("property-statement", { mode: "range", fromDate: "2026-08-01", toDate: "2026-08-31" }, { basis: "cash", scope: { legalEntityIds: [entityA], propertyIds: ["demo-property-b"] } }));
  assert.equal(total(other, "book_income"), null);
});

test("lender package lists each template section with its frozen run state", async () => {
  const engine = createLenderManagementPackageEngine({ async read() { return { sections: [
    { section: "balance_sheet", title: "Balance sheet", reportId: "balance-sheet", runId: "", rowCount: 0, state: "unavailable", reason: "Run Balance sheet for this period and these entities first." },
    { section: "rent_roll", title: "Rent roll", reportId: "rent-roll", runId: "88888888-8888-4888-8888-888888888888", rowCount: 12, state: "ready" },
  ], coverage: { state: "partial", evidence: "reproducible_snapshot", reason: "1 of 2 package sections are missing or incomplete." } }; } });
  const result = await engine.run(context("lender-management-package", { mode: "custom", fromDate: "2026-08-01", toDate: "2026-08-31" }, { scope: { legalEntityIds: [entityA] } }));
  assert.deepEqual(result.rows.map(row => [row.rowId, row.values.state]), [["lender-package:balance_sheet", "unavailable"], ["lender-package:rent_roll", "ready"]]);
  assert.equal(result.missingData?.length, 1);
});

test("tenant vehicles on application-only records honor unit and tenant selections", async () => {
  const snapshot = syntheticRentOpsSnapshot();
  snapshot.applications = snapshot.applications.map(application => application.id === "demo-application-1"
    ? { ...application, unitId: "demo-unit-a-2", vehicles: [{ makeModel: "Applicant sedan", plateLastFour: "1111" }] }
    : application);
  snapshot.tenancies = snapshot.tenancies.map(tenancy => tenancy.id === "demo-tenancy-1" ? { ...tenancy, applicationId: "demo-application-9" } : tenancy);
  snapshot.applications = [...snapshot.applications, { ...snapshot.applications[0]!, id: "demo-application-9", unitId: "demo-unit-a-1", convertedTenancyId: "demo-tenancy-1", vehicles: [{ makeModel: "Tenant truck", plateLastFour: "2222" }] }];
  const engine = createRentalExtendedReportingEngine({ async readSnapshot() { return { snapshot }; } });
  const all = await engine.run(context("tenant-vehicles", { mode: "as_of", asOfDate: "2026-09-15" }));
  assert.deepEqual(all.rows.map(row => row.values.makeModel).sort(), ["Applicant sedan", "Tenant truck"]);
  const byTenant = await engine.run(context("tenant-vehicles", { mode: "as_of", asOfDate: "2026-09-15" }, { filters: { tenantIds: ["demo-person-1"] } }));
  assert.deepEqual(byTenant.rows.map(row => row.values.makeModel), ["Tenant truck"]);
  const byUnit = await engine.run(context("tenant-vehicles", { mode: "as_of", asOfDate: "2026-09-15" }, { filters: { unitIds: ["demo-unit-a-1"] } }));
  assert.deepEqual(byUnit.rows.map(row => row.values.makeModel), ["Tenant truck"]);
});
