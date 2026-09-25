import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConnectorHealthResponse, PeriodCloseChecklist, PmSettlementDetail, RentalBridgePreview } from "@shared/accounting/operations";
import { previousOperatingMonth } from "./format";
import type { AccountingApi } from "./types";

// The test runner compiles JSX with the classic runtime; the app build uses Vite's automatic runtime.
(globalThis as { React?: typeof React }).React = React;
const views = import("./views");

const ORG = "10000000-0000-4000-8000-000000000001";
const ENTITY = "20000000-0000-4000-8000-000000000001";
const never = () => new Promise<never>(() => undefined);
const api = new Proxy({}, { get: (_target, name) => name === "bridgeCsvHref" ? () => "/export.csv" : never }) as AccountingApi;

function render(element: ReturnType<typeof createElement>, seed: (client: QueryClient) => void): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed(client);
  return renderToString(createElement(QueryClientProvider, { client }, element)).replace(/<!-- -->/g, "");
}

const detail: PmSettlementDetail = {
  id: "50000000-0000-4000-8000-000000000001", legalEntityId: ENTITY as never, propertyId: "demo-property-a", propertyName: "Demo property A", managerName: "Synthetic PM",
  periodStart: "2026-08-01" as never, periodEnd: "2026-08-31" as never, currency: "USD" as never, state: "draft", exceptionReason: null,
  grossCollectionsCents: "100000" as never, pmCostsCents: "10000" as never, ownerRemittanceCents: "90000" as never, closingHeldCents: "0" as never, bankSettledOn: null,
  recordRevision: 1 as never, updatedAt: "2026-09-01T00:00:00.000Z" as never, openingHeldCents: "0" as never, pmFeesCents: "10000" as never, pmExpensesCents: "0" as never,
  otherDeductionsCents: "0" as never, statementDocumentId: null, intakePacketId: null, bankObservationReference: null, qboReferences: [], sourceFingerprint: "a".repeat(64),
  lines: [
    { lineNumber: 1, kind: "rent_receipt", tenancyId: null, unitId: "demo-unit-a-1", description: "Rent", amountCents: "100000" as never, occurredOn: null, sourcePage: 2 },
    { lineNumber: 2, kind: "pm_fee", tenancyId: null, unitId: null, description: "Fee", amountCents: "10000" as never, occurredOn: null, sourcePage: null },
    { lineNumber: 3, kind: "owner_remittance", tenancyId: null, unitId: null, description: "Draw", amountCents: "90000" as never, occurredOn: null, sourcePage: null },
  ],
  grossToNet: {
    collections: { rentCents: "100000", subsidyCents: "0", depositCents: "0", otherCents: "0", totalCents: "100000" } as never,
    operatingCollectionsCents: "100000" as never, costs: { feesCents: "10000", expensesCents: "0", otherDeductionsCents: "0", totalCents: "10000" } as never,
    remittedCents: "90000" as never, openingHeldCents: "0" as never, closingHeldCents: "0" as never, heldChangeCents: "0" as never,
  },
  differences: [{ code: "remittance_not_bank_settled", label: "Remittance not matched to a bank deposit", amountCents: "90000" as never }],
};

test("the PM statement detail shows gross-to-net without inflating income", async () => {
  const { SettlementDetail } = await views;
  const html = render(createElement(SettlementDetail, { api, organizationId: ORG, legalEntityId: ENTITY, settlementId: detail.id, onChanged: () => undefined }), client => { client.setQueryData<PmSettlementDetail>(["accounting", "pm-settlement", ORG, detail.id], detail); });
  assert.match(html, /Collections<\/th><td class="is-number">\$1,000\.00/);
  assert.match(html, /PM costs<\/th><td class="is-number">\$100\.00/);
  assert.match(html, /Remitted to owner<\/th><td class="is-number">\$900\.00/);
  assert.doesNotMatch(html, /1,900/);
  assert.match(html, /Remittance not matched to a bank deposit/);
  assert.match(html, />Reconcile</);
});

test("overview and period close render health, clearing and checklist state", async () => {
  const { OverviewPanel, PeriodCloseView } = await views;
  const period = previousOperatingMonth();
  const health: ConnectorHealthResponse = {
    items: [{
      scope: { organizationId: ORG, legalEntityId: ENTITY, environment: "sandbox", realmId: "555" } as never, legalEntityName: "Example LLC", companyName: "Synthetic QBO",
      connection: { status: "active", readEnabled: true, accessTokenExpiresAt: null, refreshTokenHardExpiresAt: null }, freshness: "stale",
      lastSuccessfulSyncAt: null, lastChangeSyncAt: null, lastVerifiedFullReplayAt: null, lagSeconds: 10_800, coverage: { status: "partial", reason: "1 QBO object(s) have unresolved mirror exceptions" },
      openSyncExceptions: 1, activeTombstones: 2, jobs: { queued: 0, running: 0, retry: 1, dead: 1, lastFailureCode: "quickbooks_server" }, lastWebhookAt: null, rateLimitedUntil: null,
    }],
    workers: { active: 0, lastSeenAt: null }, generatedAt: "2026-09-23T00:00:00.000Z" as never,
  };
  const checklist: PeriodCloseChecklist = {
    organizationId: ORG as never, legalEntityId: ENTITY as never, periodStart: period.periodStart as never, periodEnd: period.periodEnd as never,
    items: [{ code: "posting_policy", label: "Rental accounting method", state: "blocked", detail: "No method is set for this period." }, { code: "exceptions_resolved", label: "Sync exceptions", state: "complete", detail: "No open sync exceptions." }],
    completeCount: 1, generatedAt: "2026-09-23T00:00:00.000Z" as never,
  };
  const overview = render(createElement(OverviewPanel, { api, organizationId: ORG, legalEntityId: ENTITY, currency: "USD", onOpen: () => undefined }), client => {
    client.setQueryData(["accounting", "health", ORG, ENTITY], health);
    client.setQueryData(["accounting", "close", ORG, ENTITY, period], checklist);
    client.setQueryData(["accounting", "pm-open", ORG, ENTITY], { items: [{ ...detail }], nextCursor: null });
  });
  assert.match(overview, /background worker isn(&#x27;|')t running/);
  assert.match(overview, /\$900\.00/);
  assert.match(overview, /1 of 2 steps/);
  assert.match(overview, /Blocked: Rental accounting method/, "the close figure's caption names the open step, not the method heading");
  assert.match(overview, /Background work<\/dt><dd>1 in progress · 1 failed/);
  assert.match(overview, /No webhooks received yet/);
  assert.equal((overview.match(/accounting-button-primary/g) ?? []).length, 1, "one filled button: Continue close");
  assert.match(overview, /accounting-button accounting-button-primary"[^>]*>Continue close/);
  assert.doesNotMatch(overview, /PRODUCTION|SANDBOX/);

  const { quickBooksStatus } = await views;
  const stale = quickBooksStatus({ environment: "sandbox", connection: { name: "Synthetic QBO", status: "ready" }, health: health.items[0], now: new Date("2026-09-23T03:00:00Z") });
  assert.equal(stale.tone, "warning");
  assert.match(stale.text, /^QuickBooks sandbox · Synthetic QBO · out of date · synced 3 h(r)? ago · coverage partial · 1 exception · 2 deletions to review · 1 failed job$/);
  const ready = quickBooksStatus({ environment: "production", connection: { name: "Synthetic QBO", status: "ready" }, health: { ...health.items[0]!, freshness: "current", lastChangeSyncAt: "2026-09-23T02:30:00.000Z" as never, coverage: { status: "complete", reason: null }, openSyncExceptions: 0, activeTombstones: 0, jobs: { queued: 0, running: 0, retry: 0, dead: 0, lastFailureCode: null } }, now: new Date("2026-09-23T03:00:00Z") });
  assert.deepEqual(ready, { tone: "positive", text: "QuickBooks production · Synthetic QBO · synced 30 min ago · coverage complete · 0 exceptions · 0 deletions to review" });
  assert.deepEqual(quickBooksStatus({ environment: "production", connection: { name: "Synthetic QBO", status: "needs_reconnect" }, health: null }), { tone: "critical", text: "QuickBooks production · Synthetic QBO · needs reconnect" });
  assert.equal(quickBooksStatus({ environment: "production", connection: null, health: null }).text, "QuickBooks production · not connected");

  const preview = { organizationId: ORG, legalEntityId: ENTITY, periodStart: period.periodStart, periodEnd: period.periodEnd, currency: "USD", postingMethod: null, status: "no_policy", reason: "No rental accounting method is set for this entity and period.",
    controlTotals: { chargesCents: "150000", chargeCount: 1, creditsCents: "0", receipts: { tenantCents: "100000", subsidyCents: "40000", otherCents: "0", totalCents: "140000", count: 2 }, depositReceiptsCents: "0", depositsReceivedCents: "0", depositsHeldAtEndCents: "0", reversalsCents: "0", adjustments: { debitCents: "0", creditCents: "0" }, netReceivableChangeCents: "10000", excludedVoidedCount: 0, excludedPendingCount: 0, excludedUnknownCount: 1 },
    byProperty: [], fingerprint: "b".repeat(64), generatedAt: "2026-09-23T00:00:00.000Z" } as unknown as RentalBridgePreview;
  const close = render(createElement(PeriodCloseView, { api, organizationId: ORG, legalEntityId: ENTITY, currency: "USD" }), client => {
    client.setQueryData(["accounting", "close", ORG, ENTITY, period], checklist);
    client.setQueryData(["accounting", "policies", ORG, ENTITY], []);
    client.setQueryData(["accounting", "bridge", ORG, ENTITY, period], preview);
  });
  assert.match(close, /Blocked/);
  assert.match(close, /No method set/);
  assert.match(close, /Receipts \(2\)<\/th><td class="is-number">\$1,400\.00/);
  assert.match(close, /1 with unknown values/);
  assert.match(close, /href="\/export\.csv"/);
});

test("banking shows its own heading and a one-line status when no remittance awaits a bank match", async () => {
  const { BankingView } = await views;
  const html = render(createElement(BankingView, { api, organizationId: ORG, legalEntityId: ENTITY, currency: "USD", onOpen: () => undefined }), client => {
    client.setQueryData(["accounting", "pm-open", ORG, ENTITY, undefined], { items: [], nextCursor: null });
  });
  assert.match(html, /<h2[^>]*>Banking &amp; reconciliation<\/h2>/);
  assert.match(html, /ops-status-line is-positive[\s\S]*No owner remittance is waiting for bank evidence/);
  assert.doesNotMatch(html, /Remittances awaiting a bank match<\/h3>/);

  const waiting = render(createElement(BankingView, { api, organizationId: ORG, legalEntityId: ENTITY, currency: "USD", onOpen: () => undefined }), client => {
    client.setQueryData(["accounting", "pm-open", ORG, ENTITY, undefined], { items: [{ ...detail }], nextCursor: null });
  });
  assert.match(waiting, /Remittances awaiting a bank match<\/h3>/);
  assert.match(waiting, /Remittance total[\s\S]*\$900\.00/);
});
