import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticCompanyDatabase, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import type { QuickBooksAccountingClient } from "../integrations/quickbooks/accounting";
import type { QuickBooksJsonObject } from "../../shared/accounting/quickbooks";
import { createQboAccountingMirrorStore } from "./mirror-store";
import { PostgresQuickBooksCapabilityStore } from "./capabilities";
import { createQboProviderSync } from "./provider-sync";

const scope = {
  organizationId: SYNTHETIC_COMPANY.organizationId,
  legalEntityId: SYNTHETIC_COMPANY.entityId,
  environment: "sandbox" as const,
  realmId: "123456",
};
const updated = "2026-09-21T14:00:00Z";

function clientFixture(): QuickBooksAccountingClient {
  const purchase = {
    Id: "101", SyncToken: "0", TxnDate: "2026-09-20", CurrencyRef: { value: "USD" }, PaymentType: "Check",
    EntityRef: { value: "vendor-1" }, AccountRef: { value: "bank-1" }, MetaData: { LastUpdatedTime: updated },
    Line: [{ Id: "1", Amount: "125.40", AccountBasedExpenseLineDetail: { AccountRef: { value: "expense-1" } }, Description: "Materials" }],
  } as QuickBooksJsonObject;
  const client = {
      read: async () => ({ entity: { Id: "1", CompanyName: "Synthetic QBO" }, raw: {}, status: 200 }),
    query: async <T extends QuickBooksJsonObject = QuickBooksJsonObject>(query: string) => {
      const type = /FROM (Purchase|BillPayment|Bill)\b/.exec(query)?.[1];
      const entities = type === "Purchase" && query.includes("STARTPOSITION 1") ? [purchase as T] : [];
      return { entities, raw: { QueryResponse: {} }, status: 200 };
    },
    create: async () => { throw new Error("unused"); },
    update: async () => { throw new Error("unused"); },
  } as unknown as QuickBooksAccountingClient;
  return client;
}

test("bootstrap probe enables read and provider catch-up mirrors exact QBO Purchase line", async () => {
  const synthetic = await createSyntheticCompanyDatabase();
  try {
    const mirror = createQboAccountingMirrorStore(synthetic.executor);
    const sync = createQboProviderSync({
      executor: synthetic.executor,
      client: clientFixture(),
      scope,
      mirror,
      capabilityStore: new PostgresQuickBooksCapabilityStore(synthetic.executor),
      now: () => new Date("2026-09-21T15:00:00Z"),
    });
    const probe = await sync.bootstrapRead();
    assert.equal(probe.providerRealmId, scope.realmId);
    assert.equal(probe.capability.enabled, true);
    const caught = await sync.catchUp();
    assert.equal(caught.status, "complete");
    const coverage = await mirror.readCoverage({ provider: "qbo", ...scope });
    assert.equal(coverage.evidence, "live_provider_readback");
    assert.equal(coverage.status, "complete");
    assert.equal(coverage.objectCount, 1);
    assert.equal(coverage.transactionCount, 1);
    assert.equal(coverage.lineCount, 1);
    const line = await mirror.resolveLine({ scope: { provider: "qbo", ...scope }, objectType: "Purchase", objectId: "101", lineId: "1" });
    assert.equal(line?.amountCents, "12540");
    assert.equal(line?.settlement.state, "unknown");
    await mirror.ingestSourceObject({
      scope, objectType: "Account", objectId: "bank-1", version: "0", providerUpdatedAt: updated,
      providerBody: { Id: "bank-1", SyncToken: "0", AccountType: "Bank", MetaData: { LastUpdatedTime: updated } }, receivedAt: updated,
    });
    await mirror.ingestSourceObject({
      scope, objectType: "Account", objectId: "expense-1", version: "0", providerUpdatedAt: updated,
      providerBody: { Id: "expense-1", SyncToken: "0", AccountType: "Expense", MetaData: { LastUpdatedTime: updated } }, receivedAt: updated,
    });
    const paymentContext = await mirror.readPaymentContext({ scope: { provider: "qbo", ...scope }, objectType: "Purchase", objectId: "101", lineId: "1" });
    assert.equal(paymentContext?.cashAccountObjectId, "bank-1");
    assert.equal(paymentContext?.payeeObjectId, "vendor-1");
    assert.equal(paymentContext?.flow, "outgoing");
    assert.equal(paymentContext?.subtype, "Check");
    assert.equal(paymentContext?.amountCents, "12540");
    const costContext = await mirror.readCostContext({ scope: { provider: "qbo", ...scope }, objectType: "Purchase", objectId: "101", lineId: "1" });
    assert.equal(costContext?.classification, "expense");
    assert.equal(costContext?.eligible, true);
    const balance = await mirror.getBalance(line!.source);
    await mirror.reserve({ source: line!.source, consumerKind: "project", consumerId: "project-1", amountCents: "10000", currency: "USD" });
    await assert.rejects(() => mirror.reserve({ source: line!.source, consumerKind: "investor", consumerId: "investor-1", amountCents: "3000", currency: "USD" }), /exceeds/);
    assert.equal((await mirror.getBalance(line!.source)).allocatedCents, "10000");
    assert.equal(balance.lineAmountCents, "12540");

    const nextObject = await mirror.ingestSourceObject({
      scope, objectType: "Purchase", objectId: "101", version: "1", providerUpdatedAt: "2026-09-21T14:01:00Z",
      providerBody: { Id: "101", SyncToken: "1", TxnDate: "2026-09-20", CurrencyRef: { value: "USD" }, PaymentType: "Check", EntityRef: { value: "vendor-1" }, AccountRef: { value: "bank-1" }, MetaData: { LastUpdatedTime: "2026-09-21T14:01:00Z" }, Line: [{ Id: "2", Amount: "125.40", AccountBasedExpenseLineDetail: { AccountRef: { value: "expense-1" } }, Description: "Re-keyed" }] },
      receivedAt: "2026-09-21T15:01:00Z",
    });
    const nextTransaction = await mirror.ingestTransaction({ sourceObjectId: nextObject.id, scope, objectType: "Purchase", objectId: "101", version: "1", transactionDate: "2026-09-20", postingState: "posted", currency: "USD", watermark: "2026-09-21T14:01:00Z", updatedAt: "2026-09-21T14:01:00Z" });
    await mirror.beginTransactionRevision({ scope, objectType: "Purchase", objectId: "101", version: "1", lineIds: ["2"] });
    await mirror.ingestTransactionLine({ transactionId: nextTransaction.id, sourceObjectId: nextObject.id, source: { provider: "qbo", ...scope, objectType: "Purchase", objectId: "101", lineId: "2", version: "1" }, lineNumber: 1, transactionType: "Purchase", direction: "debit", flow: "outgoing", lineRole: "expense", amountCents: "12540", currency: "USD", postingState: "posted", postedOn: "2026-09-20", settlementState: "unknown", settledOn: null, settledAmountCents: null, accountObjectId: "expense-1", counterpartyObjectId: "vendor-1", description: "Re-keyed", watermark: "2026-09-21T14:01:00Z", updatedAt: "2026-09-21T14:01:00Z" });
    assert.equal(await mirror.resolveLine({ scope: { provider: "qbo", ...scope }, objectType: "Purchase", objectId: "101", lineId: "1" }), null);
    const newLine = await mirror.resolveLine({ scope: { provider: "qbo", ...scope }, objectType: "Purchase", objectId: "101", lineId: "2" });
    assert.equal(newLine?.source.version, "1");
    await assert.rejects(() => mirror.reserve({ source: newLine!.source, consumerKind: "investor", consumerId: "investor-2", amountCents: "100", currency: "USD" }), /eligible/);
    await mirror.release({ source: line!.source, consumerKind: "project", consumerId: "project-1", amountCents: "10000", currency: "USD" });
  } finally {
    await synthetic.close();
  }
});

test("provider sync orders only by LastUpdatedTime and preserves overlap pagination deduplication", async () => {
  const synthetic = await createSyntheticCompanyDatabase();
  try {
    const mirror = createQboAccountingMirrorStore(synthetic.executor);
    const queries: string[] = [];
    const phase: { value: "seed" | "overlap" } = { value: "seed" };
    const purchase = {
      Id: "101", SyncToken: "0", TxnDate: "2026-09-20", CurrencyRef: { value: "USD" }, PaymentType: "Check",
      EntityRef: { value: "vendor-1" }, AccountRef: { value: "bank-1" }, MetaData: { LastUpdatedTime: updated },
      Line: [{ Id: "1", Amount: "125.40", AccountBasedExpenseLineDetail: { AccountRef: { value: "expense-1" } }, Description: "Materials" }],
    } as QuickBooksJsonObject;
    const unsupported = { Id: "900", MetaData: { LastUpdatedTime: updated } } as QuickBooksJsonObject;
    const client = {
      read: async () => ({ entity: { Id: "1", CompanyName: "Synthetic QBO" }, raw: {}, status: 200 }),
      query: async (query: string) => {
        queries.push(query);
        const entity = /FROM (Purchase|BillPayment|Bill|Deposit|Account)\b/.exec(query)?.[1];
        const startPosition = Number(/STARTPOSITION (\d+)/.exec(query)?.[1] ?? "1");
        let entities: QuickBooksJsonObject[] = [];
        if (entity === "Purchase") {
          if (phase.value === "seed" && startPosition === 1) entities = [purchase];
          if (phase.value === "overlap" && startPosition === 1) entities = [...Array.from({ length: 499 }, () => unsupported), purchase];
          if (phase.value === "overlap" && startPosition === 501) entities = [purchase];
        }
        return { entities, raw: { QueryResponse: {} }, status: 200 };
      },
      create: async () => { throw new Error("unused"); },
      update: async () => { throw new Error("unused"); },
    } as unknown as QuickBooksAccountingClient;
    const sync = createQboProviderSync({
      executor: synthetic.executor,
      client,
      scope,
      mirror,
      capabilityStore: new PostgresQuickBooksCapabilityStore(synthetic.executor),
      now: () => new Date("2026-09-21T15:00:00Z"),
    });

    await sync.bootstrapRead();
    assert.equal((await sync.catchUp()).status, "complete");
    phase.value = "overlap";
    const overlapped = await sync.catchUp();

    const purchaseQueries = queries.filter(query => /FROM Purchase\b/.test(query));
    assert.equal(purchaseQueries.length, 3);
    for (const query of purchaseQueries) {
      const orderBy = /\bORDERBY\s+(.+?)\s+STARTPOSITION\b/i.exec(query)?.[1];
      assert.equal(orderBy, "MetaData.LastUpdatedTime ASC");
      assert.doesNotMatch(orderBy ?? "", /\bId\b/i);
    }
    const overlapQueries = purchaseQueries.slice(1);
    assert.match(overlapQueries[0]!, /WHERE MetaData\.LastUpdatedTime >= '2026-09-21T13:59:59\.000Z'/);
    assert.match(overlapQueries[0]!, /STARTPOSITION 1 MAXRESULTS 500$/);
    assert.match(overlapQueries[1]!, /STARTPOSITION 501 MAXRESULTS 500$/);
    assert.equal(overlapped.streams.find(stream => stream.stream === "transactions.purchase")?.result.pagesFetched, 2);

    const coverage = await mirror.readCoverage({ provider: "qbo", ...scope }, "transactions.purchase");
    assert.equal(coverage.objectCount, 1);
    assert.equal(coverage.transactionCount, 1);
    assert.equal(coverage.lineCount, 1);
    const persisted = await synthetic.executor.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM accounting_qbo_source_objects
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4
          AND object_type=$5 AND object_id=$6 AND object_version=$7`,
      [scope.organizationId, scope.legalEntityId, scope.environment, scope.realmId, "Purchase", "101", "0"],
    );
    assert.equal(Number(persisted.rows[0]?.count), 1);
  } finally {
    await synthetic.close();
  }
});

test("provider sync mirrors JournalEntry cost lines and exposes capitalized cost context", async () => {
  const synthetic = await createSyntheticCompanyDatabase();
  try {
    const mirror = createQboAccountingMirrorStore(synthetic.executor);
    const journal = {
      Id: "2949", SyncToken: "0", TxnDate: "2026-09-08", CurrencyRef: { value: "USD" },
      MetaData: { LastUpdatedTime: "2026-09-23T19:30:49Z" },
      Line: [
        { Id: "0", Amount: "1286.44", Description: "Inventory cost", JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "inventory-1" }, Entity: { Type: "Customer", EntityRef: { value: "customer-test-42", name: "Synthetic customer" } } } },
        { Id: "1", Amount: "1286.44", Description: "Refund", JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "refund-1" } } },
      ],
    } as QuickBooksJsonObject;
    const nonCostJournal = {
      Id: "2951", SyncToken: "0", TxnDate: "2026-09-08", CurrencyRef: { value: "USD" },
      MetaData: { LastUpdatedTime: "2026-09-23T19:30:50Z" },
      Line: [
        { Id: "0", Amount: "10.00", Description: "Security deposit reserve", JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "deposit-1" } } },
        { Id: "1", Amount: "10.00", Description: "Offset", JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "refund-1" } } },
      ],
    } as QuickBooksJsonObject;
    const inventory = { Id: "inventory-1", SyncToken: "0", AccountType: "Other Current Asset", AccountSubType: "OtherCurrentAssets", MetaData: { LastUpdatedTime: "2026-09-23T19:30:49Z" } } as QuickBooksJsonObject;
    const refund = { Id: "refund-1", SyncToken: "0", AccountType: "Other Current Asset", AccountSubType: "OtherCurrentAssets", MetaData: { LastUpdatedTime: "2026-09-23T19:30:49Z" } } as QuickBooksJsonObject;
    const deposit = { Id: "deposit-1", SyncToken: "0", AccountType: "Other Current Asset", AccountSubType: "Other Current Asset", MetaData: { LastUpdatedTime: "2026-09-23T19:30:49Z" } } as QuickBooksJsonObject;
    const client = {
      read: async () => ({ entity: { Id: "1", CompanyName: "Synthetic QBO" }, raw: {}, status: 200 }),
      query: async (query: string) => {
        if (/FROM Preferences/.test(query)) return { entities: [{ CurrencyPrefs: { HomeCurrency: { value: "USD" }, MultiCurrencyEnabled: false } }], raw: {}, status: 200 };
        const entity = /FROM (JournalEntry|Account|Purchase|BillPayment|Bill|Deposit)\b/.exec(query)?.[1];
        if (entity === "JournalEntry") return { entities: [journal, nonCostJournal], raw: {}, status: 200 };
        if (entity === "Account") return { entities: [inventory, refund, deposit], raw: {}, status: 200 };
        return { entities: [], raw: {}, status: 200 };
      },
      create: async () => { throw new Error("unused"); },
      update: async () => { throw new Error("unused"); },
    } as unknown as QuickBooksAccountingClient;
    const sync = createQboProviderSync({
      executor: synthetic.executor,
      client,
      scope,
      mirror,
      capabilityStore: new PostgresQuickBooksCapabilityStore(synthetic.executor),
      now: () => new Date("2026-09-24T00:00:00Z"),
    });
    await sync.bootstrapRead();
    const result = await sync.catchUp();
    assert.equal(result.status, "complete");
    const stream = result.streams.find(item => item.stream === "transactions.journalentry");
    assert.equal(stream?.result.itemsApplied, 2);
    assert.equal(stream?.coverageStatus, "complete");
    const unreviewedCost = await mirror.readCostContext({ scope: { provider: "qbo", ...scope }, objectType: "JournalEntry", objectId: "2949", lineId: "0" });
    assert.equal(unreviewedCost?.classification, "other_asset");
    assert.equal(unreviewedCost?.eligible, false);
    for (const providerAccountId of ["inventory-1", "refund-1"] as const) {
      await mirror.purposeMappings.mapPurpose({
        scope: { provider: "qbo", ...scope },
        providerAccountId,
        purpose: "capitalized_cost",
        effectiveFrom: "2026-01-01",
        reviewEvidence: "Synthetic reviewed mapping for a capitalized cost account",
        actorId: "synthetic-test",
      });
    }
    const line = await mirror.resolveLine({ scope: { provider: "qbo", ...scope }, objectType: "JournalEntry", objectId: "2949", lineId: "0" });
    assert.equal(line?.amountCents, "128644");
    assert.equal(line?.direction, "debit");
    assert.equal(line?.flow, "outgoing");
    assert.equal(line?.lineRole, "expense");
    assert.equal(line?.accountObjectId, "inventory-1");
    assert.equal(line?.counterpartyObjectId, "customer-test-42");
    const refundLine = await mirror.resolveLine({ scope: { provider: "qbo", ...scope }, objectType: "JournalEntry", objectId: "2949", lineId: "1" });
    assert.equal(refundLine?.direction, "credit");
    assert.equal(refundLine?.flow, "incoming");
    assert.equal(refundLine?.lineRole, "expense");
    const listed = await mirror.listTransactions({ scope: { provider: "qbo", ...scope }, from: "2026-09-08", through: "2026-09-08" });
    assert.deepEqual(listed.items.filter(item => item.source.objectType === "JournalEntry" && item.source.objectId === "2949").map(item => [item.source.objectId, item.source.lineId, item.amountCents]), [["2949", "0", "128644"], ["2949", "1", "128644"]]);
    const cost = await mirror.readCostContext({ scope: { provider: "qbo", ...scope }, objectType: "JournalEntry", objectId: "2949", lineId: "0" });
    assert.equal(cost?.classification, "capitalized_cost");
    assert.equal(cost?.eligible, true);
    const refundCost = await mirror.readCostContext({ scope: { provider: "qbo", ...scope }, objectType: "JournalEntry", objectId: "2949", lineId: "1" });
    assert.equal(refundCost?.classification, "capitalized_cost");
    assert.equal(refundCost?.eligible, true);
    const nonCost = await mirror.readCostContext({ scope: { provider: "qbo", ...scope }, objectType: "JournalEntry", objectId: "2951", lineId: "0" });
    assert.equal(nonCost?.classification, "other_asset");
    assert.equal(nonCost?.eligible, false);
    assert.equal((await mirror.readCoverage({ provider: "qbo", ...scope })).status, "complete");
  } finally {
    await synthetic.close();
  }
});

test("aggregate coverage stays partial until the JournalEntry stream is present", async () => {
  const synthetic = await createSyntheticCompanyDatabase();
  try {
    const mirror = createQboAccountingMirrorStore(synthetic.executor);
    const observedAt = "2026-09-24T00:00:00Z";
    for (const stream of ["accounts", "transactions.purchase", "transactions.bill", "transactions.billpayment", "transactions.deposit"] as const) {
      await mirror.recordCoverage({
        scope,
        stream,
        status: "complete",
        evidence: "live_provider_readback",
        basis: "source_transactions",
        watermark: null,
        coveredFrom: null,
        coveredThrough: null,
        observedAt,
        objectCount: 0,
        transactionCount: 0,
        lineCount: 0,
      });
    }
    const coverage = await mirror.readCoverage({ provider: "qbo", ...scope });
    assert.equal(coverage.status, "partial");
    assert.match(coverage.reason ?? "", /transactions\.journalentry/);
  } finally {
    await synthetic.close();
  }
});
