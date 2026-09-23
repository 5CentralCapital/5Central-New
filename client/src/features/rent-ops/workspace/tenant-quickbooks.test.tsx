import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompanyContext } from "@shared/company/context";
import type { AccountingApi, AccountingConnection } from "../../accounting/types";
import { parseCustomerLedger } from "../../accounting/customer-ledger";
import { createDemoAdminSnapshot } from "../demo";

// The test runner compiles JSX with the classic runtime; the app build uses Vite's automatic runtime.
(globalThis as { React?: typeof React }).React = React;
const panel = import("./tenant-quickbooks");

const ORG = "org-synthetic";
const ENTITY = "entity-synthetic";
const never = () => new Promise<never>(() => undefined);
const api = new Proxy({}, { get: () => never }) as AccountingApi;
const context: CompanyContext = { organizations: [{ id: ORG, name: "Synthetic Co", role: "finance", entities: [{ id: ENTITY, name: "Synthetic LLC", currency: "USD", properties: [{ id: "demo-property-a", name: "Demo A", units: [] }] }] }] };
const connection: AccountingConnection = { scope: { organizationId: ORG, legalEntityId: ENTITY, environment: "sandbox", realmId: "9130" }, name: "Synthetic Books", status: "ready", version: 1, accessTokenExpiresAt: "", refreshTokenExpiresAt: null, refreshTokenHardExpiresAt: null, updatedAt: "" };

async function render(seed: (client: QueryClient) => void): Promise<string> {
  const { TenantQuickBooksPanel } = await panel;
  const snapshot = createDemoAdminSnapshot();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["company-context", "lane-c"], context);
  seed(client);
  return renderToString(createElement(QueryClientProvider, { client }, createElement(TenantQuickBooksPanel, { tenant: snapshot.tenants[0]!, snapshot, api }))).replace(/<!-- -->/g, "");
}

const configured = (client: QueryClient, connections: AccountingConnection[]) => {
  client.setQueryData(["rent-ops-qbo-ledger", "configuration", ORG, ENTITY], { configured: true, environment: "sandbox" });
  client.setQueryData(["rent-ops-qbo-ledger", "connections", ORG, ENTITY, "sandbox"], connections);
};

test("not connected for the property's legal entity is explicit", async () => {
  const html = await render(client => configured(client, []));
  assert.match(html, /QuickBooks is not connected for Synthetic LLC/);
  assert.match(html, /QuickBooks data, read-only/);
  assert.doesNotMatch(html, /\$0\.00/);
});

test("an unlinked tenancy offers the customer link, never a zero balance", async () => {
  const html = await render(client => {
    configured(client, [connection]);
    client.setQueryData(["rent-ops-qbo-ledger", "tenancy-ledger", ORG, "demo-tenancy-a", "sandbox"], { pages: [null], pageParams: [undefined] });
    client.setQueryData(["rent-ops-qbo-ledger", "customers", ORG, ENTITY, "sandbox", "9130"], [{ kind: "customers", objectType: "Customer", providerObjectId: "58", displayName: "Synthetic Resident", active: true, version: "0", providerUpdatedAt: null }]);
  });
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
    configured(client, [connection]);
    client.setQueryData(["rent-ops-qbo-ledger", "tenancy-ledger", ORG, "demo-tenancy-a", "sandbox"], { pages: [ledger], pageParams: [undefined] });
  });
  assert.match(html, /Partial QuickBooks coverage/);
  assert.match(html, /receivables\.payment: first read still running/);
  assert.match(html, /Not verified/);
  assert.match(html, /<td>Invoice<\/td>/);
  assert.match(html, /\$1,500\.00/);
  assert.match(html, /Ending balance \(complete history\)/);
  assert.match(html, /31–60 days/);
  assert.match(html, /49 days/);
});
