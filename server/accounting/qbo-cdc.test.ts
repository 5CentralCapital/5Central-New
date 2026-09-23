import assert from "node:assert/strict";
import test from "node:test";
import type { QuickBooksJsonObject } from "../../shared/accounting/quickbooks";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import type { QuickBooksAccountingClient, QuickBooksCdcResponse } from "../integrations/quickbooks/accounting";
import { QuickBooksIntegrationError } from "../integrations/quickbooks/errors";
import { PostgresQuickBooksCapabilityStore } from "./capabilities";
import { createQboAccountingMirrorStore } from "./mirror-store";
import { createQboProviderSync, QBO_CHANGE_STREAM } from "./provider-sync";
import { PostgresQboCheckpointStore } from "./sync";

const scope = { organizationId: SYNTHETIC_COMPANY.organizationId, legalEntityId: SYNTHETIC_COMPANY.entityId, environment: "sandbox" as const, realmId: "123456" };
const sourceScope = { provider: "qbo" as const, ...scope };
type Store = Record<string, QuickBooksJsonObject[]>;

function bill(id: string, syncToken: string, updated: string, amount = 100): QuickBooksJsonObject {
  return {
    Id: id, SyncToken: syncToken, TxnDate: "2026-09-10", TotalAmt: amount, CurrencyRef: { value: "USD" }, VendorRef: { value: "56" },
    APAccountRef: { value: "33" }, MetaData: { LastUpdatedTime: updated },
    Line: [{ Id: "1", Amount: amount, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: "7" } } }],
  } as QuickBooksJsonObject;
}

function fakeClient(store: Store, cdc: { calls: string[]; next: () => QuickBooksCdcResponse | Error }, reads: { missing?: Set<string> } = {}): QuickBooksAccountingClient {
  return {
    read: async (entity: string, id: string) => {
      if (entity === "CompanyInfo") return { entity: { Id: "1", CompanyName: "Synthetic", MetaData: { LastUpdatedTime: "2026-09-01T00:00:00Z" } }, raw: {}, status: 200 };
      if (reads.missing?.has(`${entity}:${id}`)) throw new QuickBooksIntegrationError("quickbooks_api", "not found", { status: 400, details: { providerCode: "610" } });
      const found = (store[entity] ?? []).find(item => item.Id === id);
      if (!found) throw new QuickBooksIntegrationError("quickbooks_api", "not found", { status: 400, details: { providerCode: "610" } });
      return { entity: found, raw: {}, status: 200 };
    },
    query: async (query: string) => {
      if (/FROM Preferences/.test(query)) return { entities: [{ CurrencyPrefs: { HomeCurrency: { value: "USD" }, MultiCurrencyEnabled: false } }], raw: {}, status: 200 };
      const entity = /FROM (\w+)/.exec(query)?.[1] ?? "";
      const start = Number(/STARTPOSITION (\d+)/.exec(query)?.[1] ?? "1");
      return { entities: (store[entity] ?? []).slice(start - 1, start - 1 + 500), raw: {}, status: 200 };
    },
    cdc: async (_entities: readonly string[], changedSince: string) => {
      cdc.calls.push(changedSince);
      const next = cdc.next();
      if (next instanceof Error) throw next;
      return next;
    },
    create: async () => { throw new Error("unused"); },
    update: async () => { throw new Error("unused"); },
  } as unknown as QuickBooksAccountingClient;
}

function cdcResponse(entities: Record<string, QuickBooksJsonObject[]>, time: string, truncated = false): QuickBooksCdcResponse {
  const objectCount = Object.values(entities).reduce((sum, list) => sum + list.length, 0);
  return { entities, objectCount, truncated, time, status: 200 };
}

async function harness(store: Store, start: string) {
  const synthetic = await createSyntheticCompanyDatabase();
  const executor = await createSyntheticRuntimeExecutor(synthetic.db);
  let current = new Date(start);
  const now = () => current;
  const mirror = createQboAccountingMirrorStore(executor, now);
  const cdc = { calls: [] as string[], queue: [] as (QuickBooksCdcResponse | Error)[], next: () => cdc.queue.shift() ?? cdcResponse({}, now().toISOString()) };
  const reads = { missing: new Set<string>() };
  const sync = createQboProviderSync({ executor, client: fakeClient(store, cdc, reads), scope, mirror, capabilityStore: new PostgresQuickBooksCapabilityStore(executor), now });
  await sync.bootstrapRead();
  return { synthetic, executor, mirror, sync, cdc, reads, advance: (ms: number) => { current = new Date(current.getTime() + ms); }, set: (value: string) => { current = new Date(value); }, close: () => synthetic.close() };
}

const DAY = 86_400_000;

test("sync strategy: full replay without a checkpoint, CDC within 30 days, full replay after the horizon or a CDC overflow", async () => {
  const store: Store = { Bill: [bill("10", "0", "2026-09-10T10:00:00Z")], Account: [{ Id: "7", SyncToken: "0", AccountType: "Expense", MetaData: { LastUpdatedTime: "2026-09-01T00:00:00Z" } }] };
  const h = await harness(store, "2026-09-20T00:00:00Z");
  try {
    const first = await h.sync.syncChanges();
    assert.equal(first.mode, "full_replay");
    assert.equal(first.reason, "no_checkpoint");
    assert.equal(first.anchored, true);
    assert.equal(first.status, "complete");
    assert.equal(h.cdc.calls.length, 0);
    const checkpoint = await new PostgresQboCheckpointStore(h.executor).load(scope, QBO_CHANGE_STREAM);
    assert.equal(checkpoint?.watermark, "2026-09-20T00:00:00.000Z");
    assert.equal(checkpoint?.cursor, "verified:2026-09-20T00:00:00.000Z");

    h.advance(DAY);
    h.cdc.queue.push(cdcResponse({ Bill: [bill("11", "0", "2026-09-20T12:00:00Z", 40)] }, "2026-09-21T00:00:00Z"));
    const second = await h.sync.syncChanges();
    assert.equal(second.mode, "cdc");
    assert.equal(second.status, "complete", "an anchored change chain keeps complete coverage");
    assert.equal(second.appliedCount, 1);
    assert.deepEqual(h.cdc.calls, ["2026-09-19T23:55:00.000Z"], "CDC re-reads a five-minute overlap");
    assert.equal((await h.mirror.resolveLine({ scope: sourceScope, objectType: "Bill", objectId: "11", lineId: "1" }))?.amountCents, "4000");
    assert.equal((await h.mirror.readCoverage(sourceScope)).status, "complete");

    // Twenty-nine days later CDC is still used; thirty-one days forces a replay.
    h.advance(29 * DAY);
    const third = await h.sync.syncChanges();
    assert.equal(third.mode, "cdc");
    h.advance(31 * DAY);
    const expired = await h.sync.syncChanges();
    assert.equal(expired.mode, "full_replay");
    assert.equal(expired.reason, "checkpoint_expired");
    assert.equal(h.cdc.calls.length, 2, "no CDC call is made once the watermark is past the horizon");

    h.advance(DAY);
    h.cdc.queue.push(cdcResponse({ Bill: Array.from({ length: 1000 }, (_, index) => bill(String(1000 + index), "0", "2026-09-22T00:00:00Z")) }, "2026-11-22T00:00:00Z", true));
    const overflow = await h.sync.syncChanges();
    assert.equal(overflow.mode, "full_replay");
    assert.equal(overflow.reason, "cdc_overflow");
    assert.equal(await h.mirror.resolveLine({ scope: sourceScope, objectType: "Bill", objectId: "1000", lineId: "1" }), null, "a capped CDC response is never applied");

    h.advance(DAY);
    h.cdc.queue.push(new QuickBooksIntegrationError("quickbooks_rate_limited", "slow down", { status: 429, retryable: true, retryAfterMs: 60_000 }));
    const before = await new PostgresQboCheckpointStore(h.executor).load(scope, QBO_CHANGE_STREAM);
    const failed = await h.sync.syncChanges();
    assert.equal(failed.status, "failed");
    assert.equal((await new PostgresQboCheckpointStore(h.executor).load(scope, QBO_CHANGE_STREAM))?.watermark, before?.watermark, "a failed CDC call never advances the watermark");
  } finally {
    await h.close();
  }
});

test("a CDC deletion tombstones the object, retires its lines and blocks the allocations that consumed them", async () => {
  const store: Store = { Bill: [bill("20", "0", "2026-09-10T10:00:00Z", 250)] };
  const h = await harness(store, "2026-09-20T00:00:00Z");
  try {
    await h.sync.syncChanges();
    const line = await h.mirror.resolveLine({ scope: sourceScope, objectType: "Bill", objectId: "20", lineId: "1" });
    assert.equal(line?.amountCents, "25000");
    await h.mirror.reserve({ source: line!.source, consumerKind: "project", consumerId: "project-1", amountCents: "20000", currency: "USD" });

    h.advance(DAY);
    h.cdc.queue.push(cdcResponse({ Bill: [{ Id: "20", status: "Deleted", domain: "QBO", MetaData: { LastUpdatedTime: "2026-09-20T08:00:00Z" } } as QuickBooksJsonObject] }, "2026-09-21T00:00:00Z"));
    const result = await h.sync.syncChanges();
    assert.equal(result.mode, "cdc");
    assert.equal(result.deletedCount, 1);
    assert.equal(await h.mirror.resolveLine({ scope: sourceScope, objectType: "Bill", objectId: "20", lineId: "1" }), null, "deleted lines are no longer current");
    const balance = await h.executor.query<{ is_current: boolean; posting_state: string; allocation_blocked: boolean }>("SELECT is_current, posting_state, allocation_blocked FROM accounting_qbo_source_line_balances WHERE object_id = '20'");
    assert.deepEqual(balance.rows[0], { is_current: false, posting_state: "voided", allocation_blocked: true });
    await assert.rejects(() => h.mirror.reserve({ source: line!.source, consumerKind: "investor", consumerId: "investor-1", amountCents: "100", currency: "USD" }), /no longer eligible/);
    const page = await h.mirror.listTransactions({ scope: sourceScope });
    assert.equal(page.items.some(item => item.source.objectId === "20"), false, "readers exclude deleted objects");
    assert.equal(await h.mirror.countActiveTombstones(scope), 1);
    const tombstone = await h.executor.query<{ detected_via: string; last_known_version: string; source_deleted_at: Date }>("SELECT detected_via, last_known_version, source_deleted_at FROM accounting_qbo_deletion_tombstones");
    assert.equal(tombstone.rows[0]?.detected_via, "cdc");
    assert.equal(tombstone.rows[0]?.last_known_version, "0");
    const deletedAgain = await h.mirror.recordDeletion({ scope, objectType: "Bill", objectId: "20", detectedVia: "webhook", observedAt: new Date().toISOString() });
    assert.equal(deletedAgain.tombstoneCreated, false, "tombstones are idempotent");

    // A fetch that raced the deletion (same revision) cannot resurrect it.
    const stale = await h.sync.applyObject({ objectType: "Bill", objectId: "20", operation: "updated" });
    assert.equal(stale.status, "stale");
    assert.equal(await h.mirror.resolveLine({ scope: sourceScope, objectType: "Bill", objectId: "20", lineId: "1" }), null);

    // A later provider revision re-creates the object and resolves the tombstone.
    store.Bill = [bill("20", "1", "2026-09-21T09:00:00Z", 300)];
    const recreated = await h.sync.applyObject({ objectType: "Bill", objectId: "20", operation: "updated" });
    assert.equal(recreated.status, "applied");
    assert.equal((await h.mirror.resolveLine({ scope: sourceScope, objectType: "Bill", objectId: "20", lineId: "1" }))?.amountCents, "30000");
    assert.equal(await h.mirror.countActiveTombstones(scope), 0);
  } finally {
    await h.close();
  }
});

test("a full replay tombstones objects QBO stopped returning and restores one that reappears unchanged", async () => {
  const store: Store = { Bill: [bill("30", "0", "2026-09-10T10:00:00Z"), bill("31", "0", "2026-09-10T10:00:01Z")] };
  const h = await harness(store, "2026-09-20T00:00:00Z");
  try {
    await h.sync.syncChanges();
    const kept = store.Bill![1]!;
    store.Bill = [store.Bill![0]!];
    const replay = await h.sync.syncChanges({ forceFullReplay: true });
    assert.equal(replay.mode, "full_replay");
    assert.equal(replay.reason, "requested");
    assert.equal(replay.deletedCount, 1);
    assert.equal(replay.status, "partial", "an inferred deletion stays an open exception");
    assert.equal(await h.mirror.resolveLine({ scope: sourceScope, objectType: "Bill", objectId: "31", lineId: "1" }), null);
    assert.deepEqual((await h.mirror.listOpenSyncExceptions(scope)).map(item => [item.objectId, item.kind]), [["31", "missing_from_full_replay"]]);
    assert.equal((await h.executor.query<{ detected_via: string }>("SELECT detected_via FROM accounting_qbo_deletion_tombstones")).rows[0]?.detected_via, "full_replay");

    store.Bill = [store.Bill[0]!, kept];
    const restored = await h.sync.syncChanges({ forceFullReplay: true });
    assert.equal(restored.status, "complete");
    assert.equal((await h.mirror.resolveLine({ scope: sourceScope, objectType: "Bill", objectId: "31", lineId: "1" }))?.amountCents, "10000");
    assert.deepEqual(await h.mirror.listOpenSyncExceptions(scope), []);
    assert.equal(await h.mirror.countActiveTombstones(scope), 0);
  } finally {
    await h.close();
  }
});

test("webhook object fetches apply updates, tombstone deletes and report objects that vanished", async () => {
  const store: Store = { Bill: [bill("40", "0", "2026-09-10T10:00:00Z")], Vendor: [{ Id: "56", SyncToken: "3", DisplayName: "Synthetic Supply", MetaData: { LastUpdatedTime: "2026-09-10T10:00:00Z" } } as QuickBooksJsonObject] };
  const h = await harness(store, "2026-09-20T00:00:00Z");
  try {
    assert.equal((await h.sync.applyObject({ objectType: "Bill", objectId: "40", operation: "created" })).status, "applied");
    assert.equal((await h.sync.applyObject({ objectType: "Vendor", objectId: "56", operation: "updated" })).status, "applied");
    assert.equal((await h.mirror.listProviderMirrors(scope, "vendors"))[0]?.displayName, "Synthetic Supply");
    assert.equal((await h.sync.applyObject({ objectType: "Invoice", objectId: "9", operation: "created" })).status, "unsupported");
    h.reads.missing.add("Bill:41");
    assert.equal((await h.sync.applyObject({ objectType: "Bill", objectId: "41", operation: "updated" })).status, "not_found");
    const deleted = await h.sync.applyObject({ objectType: "Bill", objectId: "40", operation: "deleted", occurredAt: "2026-09-20T01:00:00Z" });
    assert.equal(deleted.status, "deleted");
    assert.equal(await h.mirror.resolveLine({ scope: sourceScope, objectType: "Bill", objectId: "40", lineId: "1" }), null);
    // A delete notice older than a revision we already mirrored is stale.
    store.Bill = [bill("40", "1", "2026-09-20T02:00:00Z")];
    assert.equal((await h.sync.applyObject({ objectType: "Bill", objectId: "40", operation: "updated" })).status, "applied");
    const late = await h.sync.applyObject({ objectType: "Bill", objectId: "40", operation: "deleted", occurredAt: "2026-09-20T01:30:00Z" });
    assert.equal(late.status, "stale");
    assert.ok(await h.mirror.resolveLine({ scope: sourceScope, objectType: "Bill", objectId: "40", lineId: "1" }));
  } finally {
    await h.close();
  }
});
