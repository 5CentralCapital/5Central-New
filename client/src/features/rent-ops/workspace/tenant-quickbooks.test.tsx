import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompanyContext } from "@shared/company/context";
import { tenantSourceResolutionSchema, type TenantSourceResolution } from "@shared/accounting/tenant-source-resolution";
import type { AccountingApi } from "../../accounting/types";
import { parseCustomerLedger } from "../../accounting/customer-ledger";
import { createDemoAdminSnapshot } from "../demo";

// The test runner compiles JSX with the classic runtime; the app build uses Vite's automatic runtime.
(globalThis as { React?: typeof React }).React = React;
const panel = import("./tenant-quickbooks");

const ORG = "00000000-0000-4000-8000-000000000001";
const ENTITY = "00000000-0000-4000-8000-000000000002";
const SECOND_ORG = "00000000-0000-4000-8000-000000000003";
const SECOND_ENTITY = "00000000-0000-4000-8000-000000000004";
const never = () => new Promise<never>(() => undefined);
const api = new Proxy({}, { get: () => never }) as AccountingApi;
const context: CompanyContext = { organizations: [{ id: ORG, name: "Synthetic Co", role: "finance", entities: [{ id: ENTITY, name: "Synthetic LLC", currency: "USD", properties: [{ id: "demo-property-a", name: "Demo A", units: [] }] }] }] };
const multiOrgContext: CompanyContext = { organizations: [
  ...context.organizations,
  { id: SECOND_ORG, name: "Synthetic Books Two", role: "finance", entities: [{ id: SECOND_ENTITY, name: "Synthetic LLC Two", currency: "USD", properties: [{ id: "demo-property-a", name: "Demo A", units: [] }] }] },
] };
function sourceResolution(currentState: TenantSourceResolution["currentState"], options: { readonly historicalQboLink?: boolean; readonly organizationId?: string; readonly legalEntityId?: string; readonly noOverlappingPeriod?: boolean } = {}): TenantSourceResolution {
  const historicalQboLink = options.historicalQboLink === true;
  const organizationId = options.organizationId ?? ORG;
  const legalEntityId = options.legalEntityId ?? ENTITY;
  const noOverlappingPeriod = options.noOverlappingPeriod === true;
  const realmId = organizationId === SECOND_ORG ? "9131" : "9130";
  const connected = currentState === "linked" || currentState === "unlinked" || historicalQboLink;
  const ownershipReview = currentState === "ownership_review";
  const qboState: TenantSourceResolution["qbo"]["state"] = currentState === "linked" ? "linked" : currentState === "unlinked" ? "unlinked" : ownershipReview ? "ownership_review" : "not_connected";
  return tenantSourceResolutionSchema.parse({
    kind: "tenant_source_resolution",
    organizationId,
    tenancyId: "demo-tenancy-a",
    asOf: "2026-09-26",
    tenancy: { status: "current", propertyId: "demo-property-a", unitId: "demo-unit-a-1", startOn: "2026-01-01", endOn: null },
    local: { state: "local_history_available", sourceSystem: "rent_ops", ledgerEntryCount: 2 },
    ownership: {
      state: ownershipReview ? "review" : "resolved",
      coverageComplete: !ownershipReview,
      propertyName: "Demo A",
      periods: noOverlappingPeriod ? [] : [{ legalEntityId, legalEntityName: legalEntityId === SECOND_ENTITY ? "Synthetic LLC Two" : "Synthetic LLC", effectiveFrom: "2020-01-01", effectiveUntil: null, overlapsTenancy: !ownershipReview }],
      effectiveLegalEntityId: ownershipReview ? null : legalEntityId,
      effectiveLegalEntityName: ownershipReview ? null : legalEntityId === SECOND_ENTITY ? "Synthetic LLC Two" : "Synthetic LLC",
    },
    qbo: {
      environment: "sandbox",
      state: qboState,
      scope: connected ? { provider: "qbo", organizationId, legalEntityId, environment: "sandbox", realmId } : null,
      binding: connected ? { realmId, providerCompanyName: organizationId === SECOND_ORG ? "Synthetic Books Two" : "Synthetic Books" } : null,
      connection: connected ? { state: historicalQboLink ? "needs_reconnect" : "active", realmId, readCapabilityEnabled: !historicalQboLink, updatedAt: "2026-09-26T12:00:00.000Z" } : null,
      customerLink: currentState === "linked" || historicalQboLink ? { customerObjectId: "58", legalEntityId } : null,
    },
    currentState,
    reasons: ownershipReview ? ["The historical property owner could not be resolved for this tenancy."] : [],
  });
}

async function render(seed: (client: QueryClient) => void, resolution: TenantSourceResolution = sourceResolution("linked"), options: { readonly context?: CompanyContext; readonly resolutions?: readonly TenantSourceResolution[] } = {}): Promise<string> {
  const { TenantQuickBooksPanel } = await panel;
  const snapshot = createDemoAdminSnapshot();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["company-context", "lane-c"], options.context ?? context);
  for (const source of options.resolutions ?? [resolution]) {
    client.setQueryData(["rent-ops-qbo-ledger", "source-resolution", source.organizationId, source.tenancyId], source);
  }
  seed(client);
  return renderToString(createElement(QueryClientProvider, { client }, createElement(TenantQuickBooksPanel, { tenant: snapshot.tenants[0]!, snapshot, api }))).replace(/<!-- -->/g, "");
}

test("not connected for the property's legal entity is explicit", async () => {
  const html = await render(() => undefined, sourceResolution("not_connected"));
  assert.match(html, /QuickBooks is not connected for Synthetic LLC/);
  assert.match(html, /QuickBooks data, read-only/);
  assert.doesNotMatch(html, /\$0\.00/);
});

test("an unlinked tenancy offers the customer link, never a zero balance", async () => {
  const html = await render(client => {
    client.setQueryData(["rent-ops-qbo-ledger", "tenancy-ledger", ORG, "demo-tenancy-a", "sandbox"], { pages: [null], pageParams: [undefined] });
    client.setQueryData(["rent-ops-qbo-ledger", "customers", ORG, ENTITY, "sandbox", "9130"], [{ kind: "customers", objectType: "Customer", providerObjectId: "58", displayName: "Synthetic Resident", active: true, version: "0", providerUpdatedAt: null }]);
  }, sourceResolution("unlinked"));
  assert.match(html, /Not linked to a QuickBooks customer/);
  assert.match(html, /The balance is unknown, not zero/);
  assert.match(html, /Synthetic Resident · QuickBooks #58/);
  assert.match(html, /Link customer/);
  assert.doesNotMatch(html, /\$0\.00/);
});

test("a linked tenancy with partial coverage shows the ledger, the gaps and the as-of time", async () => {
  const ledger = parseCustomerLedger({
    scope: { organizationId: ORG, legalEntityId: ENTITY, environment: "sandbox", realmId: "9130" },
    customer: { objectId: "58", displayName: "Synthetic Resident", active: true },
    asOf: null,
    entries: [{ objectType: "Invoice", objectId: "101", version: "0", txnDate: "2026-08-01", dueDate: "2026-08-05", docNumber: "1001", kinds: ["charge"], amountCents: "150000", runningBalanceCents: "150000", openBalanceCents: "150000", postingState: "posted" }],
    totals: { chargesCents: "150000", creditsCents: "0", paymentsCents: "0", adjustmentsCents: "0", endingBalanceCents: "150000" },
    openItems: [{ objectType: "Invoice", objectId: "101", docNumber: "1001", txnDate: "2026-08-01", dueDate: "2026-08-05", openBalanceCents: "150000", daysPastDue: 49 }],
    aging: { currentCents: "0", days1To30Cents: "0", days31To60Cents: "150000", days61To90Cents: "0", over90Cents: "0" },
    verification: { state: "unverified", providerBalanceCents: "150000", computedBalanceCents: "150000", reason: "Balances agree, but receivable coverage is not complete" },
    coverage: { status: "partial", reasons: ["receivables.payment: first read still running"], observedAt: new Date().toISOString() },
    page: { total: 1, nextCursor: null },
  });
  const html = await render(client => {
    client.setQueryData(["rent-ops-qbo-ledger", "tenancy-ledger", ORG, "demo-tenancy-a", "sandbox"], { pages: [ledger], pageParams: [undefined] });
  }, sourceResolution("linked"));
  assert.match(html, /Partial QuickBooks coverage/);
  assert.match(html, /receivables\.payment: first read still running/);
  assert.match(html, /Not verified/);
  assert.match(html, /<td>Invoice<\/td>/);
  assert.match(html, /\$1,500\.00/);
  assert.match(html, /Ending balance \(complete history\)/);
  assert.match(html, /31–60 days/);
  assert.match(html, /49 days/);
});

test("local historical source keeps R-ops history visible without a QBO link prompt", async () => {
  const html = await render(() => undefined, sourceResolution("local_history_available"));
  assert.match(html, /Historical records remain in R-ops/);
  assert.match(html, /Ledger and Deposits tabs/);
  assert.doesNotMatch(html, /Not linked to a QuickBooks customer/);
  assert.doesNotMatch(html, /Link customer/);
});

test("local history with a stale QBO link explains the unavailable source", async () => {
  const html = await render(() => undefined, sourceResolution("local_history_available", { historicalQboLink: true }));
  assert.match(html, /QuickBooks connection needs attention/);
  assert.match(html, /historical QuickBooks customer link exists/);
  assert.doesNotMatch(html, /no QuickBooks customer link is expected/);
  assert.doesNotMatch(html, /Link customer/);
});

test("ownership review withholds QBO linking while preserving local history", async () => {
  const html = await render(() => undefined, sourceResolution("ownership_review"));
  assert.match(html, /Historical QuickBooks ownership needs review/);
  assert.match(html, /local R-ops history remains available/);
  assert.doesNotMatch(html, /Link customer/);
});

test("sequential organization ownership selects the sole overlapping historical owner", async () => {
  const priorOwner = sourceResolution("ownership_review", { organizationId: ORG, legalEntityId: ENTITY, noOverlappingPeriod: true });
  const currentOwner = sourceResolution("unlinked", { organizationId: SECOND_ORG, legalEntityId: SECOND_ENTITY });
  const html = await render(client => {
    client.setQueryData(["rent-ops-qbo-ledger", "tenancy-ledger", SECOND_ORG, "demo-tenancy-a", "sandbox"], { pages: [null], pageParams: [undefined] });
    client.setQueryData(["rent-ops-qbo-ledger", "customers", SECOND_ORG, SECOND_ENTITY, "sandbox", "9131"], [{ kind: "customers", objectType: "Customer", providerObjectId: "58", displayName: "Synthetic Resident", active: true, version: "0", providerUpdatedAt: null }]);
  }, priorOwner, { context: multiOrgContext, resolutions: [priorOwner, currentOwner] });
  assert.match(html, /Not linked to a QuickBooks customer/);
  assert.match(html, /Synthetic Resident · QuickBooks #58/);
  assert.doesNotMatch(html, /Historical QuickBooks ownership needs review/);
});

test("multiple overlapping organization owners fail closed into ownership review", async () => {
  const firstOwner = sourceResolution("linked", { organizationId: ORG, legalEntityId: ENTITY });
  const secondOwner = sourceResolution("linked", { organizationId: SECOND_ORG, legalEntityId: SECOND_ENTITY });
  const html = await render(() => undefined, firstOwner, { context: multiOrgContext, resolutions: [firstOwner, secondOwner] });
  assert.match(html, /Historical QuickBooks ownership needs review/);
  assert.match(html, /one historical property owner is confirmed/);
  assert.doesNotMatch(html, /Link customer/);
  assert.doesNotMatch(html, /Ending balance/);
});
