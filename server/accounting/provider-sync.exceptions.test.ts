import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticCompanyDatabase, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import type { QuickBooksAccountingClient } from "../integrations/quickbooks/accounting";
import type { QuickBooksJsonObject } from "../../shared/accounting/quickbooks";
import { createQboAccountingMirrorStore } from "./mirror-store";
import { PostgresQuickBooksCapabilityStore } from "./capabilities";
import { createQboProviderSync, decodeQboKeysetCursor, encodeQboKeysetCursor, nextQboKeysetCursor, queryFor } from "./provider-sync";

const scope = {
  organizationId: SYNTHETIC_COMPANY.organizationId,
  legalEntityId: SYNTHETIC_COMPANY.entityId,
  environment: "sandbox" as const,
  realmId: "123456",
};
const sourceScope = { provider: "qbo" as const, ...scope };

type Store = Record<string, QuickBooksJsonObject[]>;

function fixtureClient(store: Store, options: { preferences?: QuickBooksJsonObject; failOn?: (query: string) => boolean; queries?: string[] } = {}): QuickBooksAccountingClient {
  return {
    read: async () => ({ entity: { Id: "1", CompanyName: "Synthetic QBO", MetaData: { LastUpdatedTime: "2026-09-01T00:00:00Z" } }, raw: {}, status: 200 }),
    query: async (query: string) => {
      options.queries?.push(query);
      if (options.failOn?.(query)) throw new Error("synthetic transport failure");
      if (/FROM Preferences/.test(query)) return { entities: options.preferences ? [options.preferences] : [], raw: {}, status: 200 };
      const entity = /FROM (\w+)/.exec(query)?.[1] ?? "";
      const floor = /LastUpdatedTime >= '([^']+)'/.exec(query)?.[1];
      const start = Number(/STARTPOSITION (\d+)/.exec(query)?.[1] ?? "1");
      const max = Number(/MAXRESULTS (\d+)/.exec(query)?.[1] ?? "500");
      const rows = (store[entity] ?? [])
        .filter(row => !floor || new Date(String((row.MetaData as Record<string, unknown>).LastUpdatedTime)) >= new Date(floor))
        .sort((a, b) => new Date(String((a.MetaData as Record<string, unknown>).LastUpdatedTime)).getTime() - new Date(String((b.MetaData as Record<string, unknown>).LastUpdatedTime)).getTime());
      return { entities: rows.slice(start - 1, start - 1 + max), raw: {}, status: 200 };
    },
    create: async () => { throw new Error("unused"); },
    update: async () => { throw new Error("unused"); },
  } as unknown as QuickBooksAccountingClient;
}

function billPayment(id: string, syncToken: string, updated: string, lines: { amount: number; txnType: string; txnId: string }[], total: number): QuickBooksJsonObject {
  return {
    Id: id, SyncToken: syncToken, TxnDate: "2026-09-10", TotalAmt: total, VendorRef: { value: "56" }, PayType: "Check",
    CheckPayment: { BankAccountRef: { value: "35" } }, MetaData: { LastUpdatedTime: updated },
    Line: lines.map(line => ({ Amount: line.amount, LinkedTxn: [{ TxnId: line.txnId, TxnType: line.txnType }] })),
  } as QuickBooksJsonObject;
}

const account = (id: string, type: string) => ({ Id: id, SyncToken: "0", AccountType: type, MetaData: { LastUpdatedTime: "2026-09-01T00:00:00Z" } }) as QuickBooksJsonObject;

async function harness(store: Store, extra: Parameters<typeof fixtureClient>[1] = {}) {
  const synthetic = await createSyntheticCompanyDatabase();
  const mirror = createQboAccountingMirrorStore(synthetic.executor);
  const capabilityStore = new PostgresQuickBooksCapabilityStore(synthetic.executor);
  const sync = createQboProviderSync({ executor: synthetic.executor, client: fixtureClient(store, { preferences: { CurrencyPrefs: { HomeCurrency: { value: "USD" }, MultiCurrencyEnabled: false } }, ...extra }), scope, mirror, capabilityStore, now: () => new Date("2026-09-21T15:00:00Z") });
  await sync.bootstrapRead();
  return { synthetic, mirror, sync };
}

test("an unsupported object stays an open exception across later incremental runs and is never partially mirrored", async () => {
  const store: Store = {
    BillPayment: [
      billPayment("10", "0", "2026-09-10T10:00:00Z", [{ amount: 100, txnType: "Bill", txnId: "1" }], 100),
      billPayment("11", "0", "2026-09-10T11:00:00Z", [{ amount: 100, txnType: "Bill", txnId: "2" }, { amount: 30, txnType: "VendorCredit", txnId: "3" }], 70),
    ],
    Account: [account("35", "Bank")],
  };
  const { synthetic, mirror, sync } = await harness(store);
  try {
    const first = await sync.catchUp();
    const stream = first.streams.find(item => item.stream === "transactions.billpayment")!;
    assert.equal(first.status, "partial");
    assert.equal(stream.unsupportedCount, 1);
    assert.equal(stream.openExceptionCount, 1);
    assert.equal(await mirror.resolveLine({ scope: sourceScope, objectType: "BillPayment", objectId: "11", lineId: "linked:Bill:2" }), null, "no partial line list is mirrored");
    assert.equal((await mirror.resolveLine({ scope: sourceScope, objectType: "BillPayment", objectId: "10", lineId: "linked:Bill:1" }))?.amountCents, "10000");

    // A later incremental run sees no new rejected rows but must not report the gap as closed.
    const second = await sync.catchUp();
    const again = second.streams.find(item => item.stream === "transactions.billpayment")!;
    assert.equal(again.mode, "incremental");
    assert.equal(again.openExceptionCount, 1);
    assert.equal(again.coverageStatus, "partial");
    const open = await mirror.listOpenSyncExceptions(scope);
    assert.deepEqual(open.map(item => [item.objectType, item.objectId, item.kind]), [["BillPayment", "11", "unsupported"]]);
    assert.ok(open[0]!.reasons.some(reason => /VendorCredit/.test(reason)));
    assert.equal((await mirror.readCoverage(sourceScope)).status, "partial");

    // The provider revision is corrected in QBO; a full replay resolves the exception and establishes complete coverage.
    store.BillPayment![1] = billPayment("11", "1", "2026-09-11T09:00:00Z", [{ amount: 70, txnType: "Bill", txnId: "2" }], 70);
    const replay = await sync.catchUp({ fullReplay: true });
    assert.equal(replay.status, "complete");
    assert.deepEqual(await mirror.listOpenSyncExceptions(scope), []);
    assert.equal((await mirror.readCoverage(sourceScope)).status, "complete");
  } finally {
    await synthetic.close();
  }
});

test("a newer unsupported revision retires the stale mirrored lines", async () => {
  const store: Store = { BillPayment: [billPayment("20", "0", "2026-09-10T10:00:00Z", [{ amount: 50, txnType: "Bill", txnId: "5" }], 50)], Account: [account("35", "Bank")] };
  const { synthetic, mirror, sync } = await harness(store);
  try {
    await sync.catchUp();
    assert.equal((await mirror.resolveLine({ scope: sourceScope, objectType: "BillPayment", objectId: "20", lineId: "linked:Bill:5" }))?.amountCents, "5000");
    store.BillPayment = [billPayment("20", "1", "2026-09-12T10:00:00Z", [{ amount: 50, txnType: "Bill", txnId: "5" }, { amount: 10, txnType: "JournalEntry", txnId: "6" }], 40)];
    await sync.catchUp();
    assert.equal(await mirror.resolveLine({ scope: sourceScope, objectType: "BillPayment", objectId: "20", lineId: "linked:Bill:5" }), null);
    assert.equal((await mirror.listOpenSyncExceptions(scope, "transactions.billpayment")).length, 1);
  } finally {
    await synthetic.close();
  }
});

test("an item-based expense without an account cannot claim complete coverage", async () => {
  const store: Store = {
    Purchase: [{
      Id: "25", SyncToken: "0", TxnDate: "2026-09-10", TotalAmt: 12, CurrencyRef: { value: "USD" },
      PaymentType: "Cash", AccountRef: { value: "35" }, MetaData: { LastUpdatedTime: "2026-09-10T10:00:00Z" },
      Line: [{ Id: "1", Amount: 12, ItemBasedExpenseLineDetail: { ItemRef: { value: "item-1" } } }],
    } as QuickBooksJsonObject],
    Account: [account("35", "Bank")],
  };
  const { synthetic, mirror, sync } = await harness(store);
  try {
    const result = await sync.catchUp();
    const stream = result.streams.find(item => item.stream === "transactions.purchase")!;
    assert.equal(result.status, "partial");
    assert.equal(stream.unsupportedCount, 1);
    assert.equal(stream.openExceptionCount, 1);
    assert.equal(await mirror.resolveLine({ scope: sourceScope, objectType: "Purchase", objectId: "25", lineId: "1" }), null);
    assert.equal((await mirror.readCoverage(sourceScope, "transactions.purchase")).status, "partial");
  } finally {
    await synthetic.close();
  }
});

test("provider sync mirrors refund and cash-back lines with signed flow and no duplicate replay", async () => {
  const store: Store = {
    Purchase: [{
      Id: "26", SyncToken: "0", TxnDate: "2026-09-10", TotalAmt: 12, CurrencyRef: { value: "USD" },
      PaymentType: "CreditCard", Credit: true, AccountRef: { value: "41" }, MetaData: { LastUpdatedTime: "2026-09-10T10:00:00Z" },
      Line: [{ Id: "1", Amount: 12, AccountBasedExpenseLineDetail: { AccountRef: { value: "7" } } }],
    } as QuickBooksJsonObject],
    Deposit: [{
      Id: "121", SyncToken: "0", TxnDate: "2026-09-10", TotalAmt: 80, CurrencyRef: { value: "USD" }, DepositToAccountRef: { value: "35" },
      CashBack: { AccountRef: { value: "36" }, Amount: 20 }, MetaData: { LastUpdatedTime: "2026-09-10T11:00:00Z" },
      Line: [{ Id: "1", Amount: 100, DepositLineDetail: { AccountRef: { value: "79" } } }],
    } as QuickBooksJsonObject],
    Account: [account("35", "Bank"), account("36", "CashOnHand"), account("41", "Credit Card"), account("7", "Expense"), account("79", "Income")],
  };
  const { synthetic, mirror, sync } = await harness(store);
  try {
    const first = await sync.catchUp();
    assert.equal(first.status, "complete");
    assert.deepEqual(await mirror.listOpenSyncExceptions(scope), []);
    const refund = await mirror.resolveLine({ scope: sourceScope, objectType: "Purchase", objectId: "26", lineId: "1" });
    assert.equal(refund?.amountCents, "1200");
    assert.equal(refund?.direction, "credit");
    assert.equal(refund?.flow, "incoming");
    assert.equal(refund?.lineRole, "expense");
    assert.equal(await mirror.readPaymentContext({ scope: sourceScope, objectType: "Purchase", objectId: "26", lineId: "1" }), null, "a Purchase refund is not an outgoing payment");
    const deposit = await mirror.resolveLine({ scope: sourceScope, objectType: "Deposit", objectId: "121", lineId: "1" });
    assert.equal(deposit?.amountCents, "10000");
    const cashBack = await mirror.resolveLine({ scope: sourceScope, objectType: "Deposit", objectId: "121", lineId: "synthetic:cashback" });
    assert.equal(cashBack?.amountCents, "2000");
    assert.equal(cashBack?.direction, "debit");
    assert.equal(cashBack?.flow, "outgoing");
    assert.equal(cashBack?.lineRole, "unknown");
    assert.equal(await mirror.readPaymentContext({ scope: sourceScope, objectType: "Deposit", objectId: "121", lineId: "synthetic:cashback" }), null, "cash back is not an incoming receipt");
    assert.equal((await mirror.readCostContext({ scope: sourceScope, objectType: "Deposit", objectId: "121", lineId: "synthetic:cashback" }))?.eligible, false, "cash back account classification remains fail-closed");

    const replay = await sync.catchUp({ fullReplay: true });
    assert.equal(replay.status, "complete");
    assert.deepEqual(await mirror.listOpenSyncExceptions(scope), []);
    const lines = await mirror.listTransactions({ scope: sourceScope, from: "2026-09-10", through: "2026-09-10", limit: 20 });
    assert.equal(lines.items.filter(item => item.source.objectType === "Purchase" && item.source.objectId === "26").length, 1);
    assert.equal(lines.items.filter(item => item.source.objectType === "Deposit" && item.source.objectId === "121").length, 2);
  } finally {
    await synthetic.close();
  }
});

test("a full replay flags mirrored objects that QBO no longer returns", async () => {
  const store: Store = {
    BillPayment: [billPayment("30", "0", "2026-09-10T10:00:00Z", [{ amount: 5, txnType: "Bill", txnId: "7" }], 5), billPayment("31", "0", "2026-09-10T10:00:01Z", [{ amount: 6, txnType: "Bill", txnId: "8" }], 6)],
    Account: [account("35", "Bank")],
  };
  const { synthetic, mirror, sync } = await harness(store);
  try {
    assert.equal((await sync.catchUp()).status, "complete");
    store.BillPayment = [store.BillPayment![0]!];
    const replay = await sync.catchUp({ fullReplay: true });
    const stream = replay.streams.find(item => item.stream === "transactions.billpayment")!;
    assert.equal(stream.missingFromReplayCount, 1);
    assert.equal(replay.status, "complete", "a full replay confirms the absent object as a deletion");
    assert.deepEqual(await mirror.listOpenSyncExceptions(scope), []);
    assert.equal((await mirror.readCoverage(sourceScope, "transactions.billpayment")).status, "complete");
  } finally {
    await synthetic.close();
  }
});

test("an interrupted fetch commits neither mirror rows, exceptions nor the checkpoint", async () => {
  const many = Array.from({ length: 501 }, (_, index) => billPayment(String(100 + index), "0", `2026-09-10T10:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`, [{ amount: 1, txnType: "Bill", txnId: String(5000 + index) }], 1));
  const store: Store = { BillPayment: many, Account: [account("35", "Bank")] };
  let fail = true;
  const { synthetic, mirror, sync } = await harness(store, { failOn: query => fail && /FROM BillPayment/.test(query) && !/STARTPOSITION 1 /.test(query) });
  try {
    const interrupted = await sync.catchUp();
    assert.equal(interrupted.status, "partial");
    assert.equal(interrupted.streams.find(item => item.stream === "transactions.billpayment")?.result.status, "failed");
    const rows = await synthetic.executor.query<{ count: string | number }>("SELECT COUNT(*) AS count FROM accounting_qbo_source_objects WHERE object_type='BillPayment'");
    assert.equal(Number(rows.rows[0]?.count), 0);
    const checkpoint = await synthetic.executor.query("SELECT 1 FROM accounting_qbo_sync_checkpoints WHERE stream='transactions.billpayment'");
    assert.equal(checkpoint.rows.length, 0);
    fail = false;
    const recovered = await sync.catchUp();
    assert.equal(recovered.streams.find(item => item.stream === "transactions.billpayment")?.result.itemsApplied, 501);
    assert.equal(recovered.status, "complete");
    assert.equal((await mirror.readCoverage(sourceScope, "transactions.billpayment")).objectCount, 501);
  } finally {
    await synthetic.close();
  }
});

test("keyset pagination restarts at the last timestamp so a mid-sync edit cannot shift records past the cursor", () => {
  const at = (time: string) => ({ Id: time, MetaData: { LastUpdatedTime: time } }) as QuickBooksJsonObject;
  const page = Array.from({ length: 500 }, (_, index) => at(index < 498 ? `2026-09-10T10:00:${String(index % 60).padStart(2, "0")}Z` : "2026-09-10T11:00:00Z"));
  const next = nextQboKeysetCursor({ floor: null, startPosition: 1 }, page);
  assert.deepEqual(next, { floor: "2026-09-10T11:00:00.000Z", startPosition: 3 });
  assert.match(queryFor("Bill", next!), /WHERE MetaData\.LastUpdatedTime >= '2026-09-10T11:00:00\.000Z' ORDERBY MetaData\.LastUpdatedTime ASC STARTPOSITION 3 MAXRESULTS 500$/);
  const tied = Array.from({ length: 500 }, () => at("2026-09-10T11:00:00Z"));
  assert.deepEqual(nextQboKeysetCursor(next!, tied), { floor: "2026-09-10T11:00:00.000Z", startPosition: 503 });
  assert.equal(nextQboKeysetCursor(next!, tied.slice(0, 10)), null);
  assert.deepEqual(decodeQboKeysetCursor(encodeQboKeysetCursor(next!)), next);
  assert.throws(() => decodeQboKeysetCursor("2026-09-10' OR 1=1|1"), /cursor/);
});

test("objects without CurrencyRef use the realm's verified Preferences home currency, never a default", async () => {
  const deposit = { Id: "40", SyncToken: "0", TxnDate: "2026-09-10", TotalAmt: 25, DepositToAccountRef: { value: "35" }, MetaData: { LastUpdatedTime: "2026-09-10T10:00:00Z" }, Line: [{ Id: "1", Amount: 25, DepositLineDetail: { AccountRef: { value: "79" } } }] } as QuickBooksJsonObject;
  const store: Store = { Deposit: [deposit], Account: [account("35", "Bank")] };
  const withPrefs = await harness(store);
  try {
    await withPrefs.sync.catchUp();
    const line = await withPrefs.mirror.resolveLine({ scope: sourceScope, objectType: "Deposit", objectId: "40", lineId: "1" });
    assert.equal(line?.currency, "USD");
    assert.equal(line?.accountObjectId, "79");
  } finally {
    await withPrefs.synthetic.close();
  }
  const synthetic = await createSyntheticCompanyDatabase();
  try {
    const mirror = createQboAccountingMirrorStore(synthetic.executor);
    const sync = createQboProviderSync({ executor: synthetic.executor, client: fixtureClient(store), scope, mirror, capabilityStore: new PostgresQuickBooksCapabilityStore(synthetic.executor), now: () => new Date("2026-09-21T15:00:00Z") });
    await sync.bootstrapRead();
    const result = await sync.catchUp();
    assert.equal(result.streams.find(item => item.stream === "transactions.deposit")?.openExceptionCount, 1);
    assert.ok((await mirror.listOpenSyncExceptions(scope))[0]!.reasons.some(reason => /home currency/.test(reason)));
  } finally {
    await synthetic.close();
  }
});
