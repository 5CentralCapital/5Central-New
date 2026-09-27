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

test("full replay mirrors balanced zero-total journals with long descriptions and exact line readback", async () => {
  const description = "Synthetic supporting detail ".repeat(75).trim();
  const journal: QuickBooksJsonObject = {
    Id: "journal-long", SyncToken: "0", TxnDate: "2026-09-10", TotalAmt: 0,
    CurrencyRef: { value: "USD" }, MetaData: { LastUpdatedTime: "2026-09-10T10:00:00Z" },
    Line: [
      { Id: "0", Amount: "123.45", Description: description, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "7" }, Entity: { Type: "Customer", EntityRef: { value: "58" } } } },
      { Id: "1", Amount: "123.45", DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "8" } } },
    ],
  };
  const store: Store = { JournalEntry: [journal], Account: [
    { Id: "7", SyncToken: "0", AccountType: "Accounts Receivable", MetaData: { LastUpdatedTime: "2026-09-01T00:00:00Z" } },
    { Id: "8", SyncToken: "0", AccountType: "Bank", MetaData: { LastUpdatedTime: "2026-09-01T00:00:00Z" } },
  ] };
  const h = await harness(store, "2026-09-20T00:00:00Z");
  try {
    assert.equal((await h.sync.syncChanges()).status, "complete");
    const line = await h.mirror.resolveLine({ scope: sourceScope, objectType: "JournalEntry", objectId: "journal-long", lineId: "0" });
    assert.equal(line?.amountCents, "12345");
    assert.equal(line?.description, description);
    assert.equal(line?.settlement.state, "unknown");
    assert.equal((await h.sync.syncChanges({ forceFullReplay: true })).status, "complete");
    const count = await h.executor.query<{ count: number }>("SELECT count(*)::int AS count FROM accounting_qbo_transaction_lines WHERE object_id='journal-long'");
    assert.equal(count.rows[0]?.count, 2);
    const effects = await h.executor.query<{ description: string; amount_cents: string }>("SELECT description, amount_cents::text FROM accounting_qbo_receivable_effects WHERE object_id='journal-long'");
    assert.equal(effects.rows[0]?.description, description.slice(0, 500));
    assert.equal(effects.rows[0]?.amount_cents, "12345");
  } finally { await h.close(); }
});

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

test("a pre-existing verified changes checkpoint cannot skip the per-stream full baseline", async () => {
  const h = await harness({}, "2026-09-20T00:00:00Z");
  try {
    // This is the state created by the pre-receivables synchronizer: the
    // global change chain is marked verified, but migration 050 streams have
    // never been fetched from the beginning. The first post-migration sync
    // must replay every required stream before it can use CDC.
    await h.executor.query(
      `INSERT INTO accounting_qbo_sync_checkpoints
        (organization_id, legal_entity_id, environment, realm_id, stream, watermark, cursor, version, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8)`,
      [scope.organizationId, scope.legalEntityId, scope.environment, scope.realmId, QBO_CHANGE_STREAM, "2026-09-19T00:00:00.000Z", "verified:2026-09-19T00:00:00.000Z", "2026-09-20T00:00:00.000Z"],
    );
    const first = await h.sync.syncChanges();
    assert.equal(first.mode, "full_replay");
    assert.equal(first.reason, "missing_baseline");
    assert.equal(first.anchored, true);
    assert.equal(h.cdc.calls.length, 0, "a legacy global anchor cannot trigger CDC before every stream is replayed");

    h.cdc.queue.push(cdcResponse({}, "2026-09-21T00:00:00Z"));
    const second = await h.sync.syncChanges();
    assert.equal(second.mode, "cdc");
    assert.equal(second.status, "complete");
    assert.equal(h.cdc.calls.length, 1);

    // A per-object hold projects a complete stream to partial. The stored
    // replay proof must survive (or the next run would schedule another
    // unnecessary full replay), but it is never shown as a human reason.
    await h.executor.query(
      `INSERT INTO accounting_qbo_sync_exceptions
        (organization_id, legal_entity_id, environment, realm_id, stream, object_type, object_id, object_version, exception_kind, reasons, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,$4,'accounts','Account','7','0','unsupported','["synthetic"]'::jsonb,$5,$5)`,
      [scope.organizationId, scope.legalEntityId, scope.environment, scope.realmId, "2026-09-21T00:00:00.000Z"],
    );
    const accountCoverage = await h.mirror.readCoverage(sourceScope, "accounts");
    assert.equal(accountCoverage.status, "partial");
    assert.doesNotMatch(accountCoverage.reason ?? "", /QBO_FULL_REPLAY_ANCHOR/);
    assert.match(accountCoverage.reason ?? "", /unresolved mirror exceptions/);
    const stored = await h.executor.query<{ reason: string | null }>(
      `SELECT reason FROM accounting_qbo_coverage WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND stream='accounts'`,
      [scope.organizationId, scope.legalEntityId, scope.environment, scope.realmId],
    );
    assert.match(stored.rows[0]?.reason ?? "", /QBO_FULL_REPLAY_ANCHOR_V2/);
    h.cdc.queue.push(cdcResponse({}, "2026-09-22T00:00:00Z"));
    assert.equal((await h.sync.syncChanges()).mode, "cdc", "an open hold must not force another full replay");
  } finally {
    await h.close();
  }
});

test("coverage becomes partial when no successful provider read is observed beyond the CDC lookback", async () => {
  const store: Store = { Bill: [bill("50", "0", "2026-09-10T10:00:00Z")], Account: [{ Id: "7", SyncToken: "0", AccountType: "Expense", MetaData: { LastUpdatedTime: "2026-09-01T00:00:00Z" } }] };
  const h = await harness(store, "2026-09-20T00:00:00Z");
  try {
    const first = await h.sync.syncChanges();
    assert.equal(first.status, "complete");
    h.set("2026-10-21T00:00:01Z");
    const coverage = await h.mirror.readCoverage(sourceScope);
    assert.equal(coverage.status, "partial");
    assert.match(coverage.reason ?? "", /coverage is stale/i);
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
    assert.equal(replay.status, "complete", "a full replay confirms the absent object as a deletion");
    assert.equal(await h.mirror.resolveLine({ scope: sourceScope, objectType: "Bill", objectId: "31", lineId: "1" }), null);
    assert.deepEqual(await h.mirror.listOpenSyncExceptions(scope), []);
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
    assert.equal((await h.sync.applyObject({ objectType: "Estimate", objectId: "9", operation: "created" })).status, "unsupported");
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

test("the CDC watermark compares instants, not strings, when Intuit reports a local offset", async () => {
  const h = await harness({}, "2026-09-20T00:00:00Z");
  const checkpoints = new PostgresQboCheckpointStore(h.executor);
  try {
    await h.sync.syncChanges();
    h.advance(DAY);
    // 2026-09-20T18:00-07:00 is 2026-09-21T01:00Z: later, although it sorts lower as a string.
    h.cdc.queue.push(cdcResponse({}, "2026-09-20T18:00:00-07:00"));
    const advanced = await h.sync.syncChanges();
    assert.equal(advanced.mode, "cdc");
    assert.equal(advanced.watermark, "2026-09-21T01:00:00.000Z");
    assert.equal((await checkpoints.load(scope, QBO_CHANGE_STREAM))?.watermark, "2026-09-21T01:00:00.000Z", "stored as UTC ISO");

    h.advance(60 * 60_000);
    // 2026-09-21T02:00+05:00 is 2026-09-20T21:00Z: earlier, although it sorts higher as a string.
    h.cdc.queue.push(cdcResponse({}, "2026-09-21T02:00:00+05:00"));
    const older = await h.sync.syncChanges();
    assert.equal(older.watermark, "2026-09-21T01:00:00.000Z", "an earlier provider time never moves the watermark back");
    assert.equal((await checkpoints.load(scope, QBO_CHANGE_STREAM))?.watermark, "2026-09-21T01:00:00.000Z");
    assert.equal(h.cdc.calls.at(-1), "2026-09-21T00:55:00.000Z", "the next change window starts from the parsed instant");
  } finally {
    await h.close();
  }
});

test("an explicit deletion after an inferred one is recorded, so a racing fetch of the same revision cannot restore it", async () => {
  const store: Store = { Bill: [bill("30", "0", "2026-09-10T10:00:00Z"), bill("31", "0", "2026-09-10T10:00:01Z")] };
  const h = await harness(store, "2026-09-20T00:00:00Z");
  try {
    await h.sync.syncChanges();
    const kept = store.Bill![1]!;
    store.Bill = [store.Bill![0]!];
    await h.sync.syncChanges({ forceFullReplay: true });
    const explicit = await h.sync.applyObject({ objectType: "Bill", objectId: "31", operation: "deleted", occurredAt: "2026-09-20T00:30:00Z" });
    assert.equal(explicit.status, "deleted");
    const rows = await h.executor.query<{ detected_via: string; tombstone_seq: number }>("SELECT detected_via, tombstone_seq FROM accounting_qbo_deletion_tombstones WHERE object_id = '31' ORDER BY tombstone_seq");
    assert.deepEqual(rows.rows.map(row => [row.detected_via, Number(row.tombstone_seq)]), [["full_replay", 1], ["webhook", 2]], "the inferred row is kept; the explicit one is appended");
    assert.equal((await h.mirror.readDeletionState(scope, "Bill", "31"))?.detectedVia, "webhook");
    assert.equal(await h.mirror.countActiveTombstones(scope), 1, "one deleted object, however many tombstone rows");

    store.Bill = [store.Bill[0]!, kept];
    const raced = await h.sync.applyObject({ objectType: "Bill", objectId: "31", operation: "updated" });
    assert.equal(raced.status, "stale", "the same revision no longer undoes an explicit deletion");
    assert.equal(await h.mirror.resolveLine({ scope: sourceScope, objectType: "Bill", objectId: "31", lineId: "1" }), null);
    const again = await h.mirror.recordDeletion({ scope, objectType: "Bill", objectId: "31", detectedVia: "cdc", observedAt: new Date().toISOString() });
    assert.equal(again.tombstoneCreated, false, "a repeated explicit notice is idempotent");
  } finally {
    await h.close();
  }
});

test("an object deleted again after it came back gets a new tombstone with its newer revision", async () => {
  const store: Store = { Bill: [bill("50", "0", "2026-09-10T10:00:00Z")] };
  const h = await harness(store, "2026-09-20T00:00:00Z");
  try {
    await h.sync.syncChanges();
    assert.equal((await h.sync.applyObject({ objectType: "Bill", objectId: "50", operation: "deleted", occurredAt: "2026-09-20T01:00:00Z" })).status, "deleted");
    store.Bill = [bill("50", "1", "2026-09-20T02:00:00Z", 300)];
    assert.equal((await h.sync.applyObject({ objectType: "Bill", objectId: "50", operation: "updated" })).status, "applied");
    const second = await h.sync.applyObject({ objectType: "Bill", objectId: "50", operation: "deleted", occurredAt: "2026-09-20T03:00:00Z" });
    assert.equal(second.status, "deleted");
    const state = await h.mirror.readDeletionState(scope, "Bill", "50");
    assert.equal(state?.lastKnownVersion, "1");
    assert.equal(state?.sourceDeletedAt, "2026-09-20T03:00:00.000Z");
    // A fetch of revision 1 that raced the second deletion cannot resurrect it.
    const raced = await h.sync.applyObject({ objectType: "Bill", objectId: "50", operation: "updated" });
    assert.equal(raced.status, "stale");
    assert.equal(await h.mirror.resolveLine({ scope: sourceScope, objectType: "Bill", objectId: "50", lineId: "1" }), null);
  } finally {
    await h.close();
  }
});

test("re-reading an unchanged revision after a rename or a posting keeps the first body instead of failing the replay", async () => {
  const account = { Id: "7", SyncToken: "0", Name: "Electric", FullyQualifiedName: "Utilities:Electric", AccountType: "Expense", CurrentBalance: 100, ParentRef: { value: "6", name: "Utilities" }, MetaData: { LastUpdatedTime: "2026-09-01T00:00:00Z" } };
  const store: Store = { Bill: [{ ...bill("40", "0", "2026-09-10T10:00:00Z"), VendorRef: { value: "56", name: "Old Vendor Name" } } as QuickBooksJsonObject], Account: [account] };
  const h = await harness(store, "2026-09-20T00:00:00Z");
  try {
    assert.equal((await h.sync.syncChanges()).status, "complete");
    // Same SyncTokens; QuickBooks now reports the renamed vendor and parent account and a new balance.
    store.Bill = [{ ...store.Bill![0]!, VendorRef: { value: "56", name: "New Vendor Name" } } as QuickBooksJsonObject];
    store.Account = [{ ...account, FullyQualifiedName: "Energy:Electric", CurrentBalance: 250, ParentRef: { value: "6", name: "Energy" } }];
    const replay = await h.sync.syncChanges({ forceFullReplay: true });
    assert.equal(replay.status, "complete");
    assert.equal(replay.anchored, true);
    assert.equal((await h.mirror.resolveLine({ scope: sourceScope, objectType: "Bill", objectId: "40", lineId: "1" }))?.amountCents, "10000");

    // A real change under the same SyncToken stays held without rolling back
    // the independent Bill in the same full-replay stream.
    store.Bill = [
      { ...store.Bill[0]!, TotalAmt: 999 } as QuickBooksJsonObject,
      bill("41", "0", "2026-09-11T10:00:00Z", 200),
    ];
    const changed = await h.sync.syncChanges({ forceFullReplay: true });
    assert.equal(changed.status, "partial");
    assert.equal(changed.anchored, true);
    assert.deepEqual((await h.mirror.listOpenSyncExceptions(scope, "transactions.bill")).map(item => [item.objectType, item.objectId, item.version]), [["Bill", "40", "0"]]);
    assert.equal((await h.mirror.resolveLine({ scope: sourceScope, objectType: "Bill", objectId: "40", lineId: "1" }))?.amountCents, "10000", "the original body and amount remain unchanged");
    assert.equal((await h.mirror.resolveLine({ scope: sourceScope, objectType: "Bill", objectId: "41", lineId: "1" }))?.amountCents, "20000", "independent source objects continue syncing");
  } finally {
    await h.close();
  }
});

test("CDC isolates a same-token source conflict, advances independent objects and keeps stream coverage partial", async () => {
  const account = { Id: "7", SyncToken: "0", Name: "Electric", AccountType: "Expense", MetaData: { LastUpdatedTime: "2026-09-01T00:00:00Z" } };
  const store: Store = { Bill: [bill("60", "0", "2026-09-10T10:00:00Z")], Account: [account as QuickBooksJsonObject] };
  const h = await harness(store, "2026-09-20T00:00:00Z");
  try {
    assert.equal((await h.sync.syncChanges()).status, "complete");
    const original = bill("60", "0", "2026-09-10T10:00:00Z", 999);
    const independent = bill("61", "0", "2026-09-11T10:00:00Z", 150);
    h.cdc.queue.push(cdcResponse({ Bill: [original, independent] }, "2026-09-20T00:05:00Z"));

    const result = await h.sync.syncChanges();
    assert.equal(result.mode, "cdc");
    assert.equal(result.status, "partial");
    assert.equal(result.unsupportedCount, 1);
    assert.equal(result.appliedCount, 1);
    assert.deepEqual((await h.mirror.listOpenSyncExceptions(scope, "transactions.bill")).map(item => [item.objectType, item.objectId, item.version]), [["Bill", "60", "0"]]);
    assert.equal((await h.mirror.readCoverage(sourceScope, "transactions.bill")).status, "partial");
    assert.equal((await h.mirror.resolveLine({ scope: sourceScope, objectType: "Bill", objectId: "60", lineId: "1" }))?.amountCents, "10000");
    assert.equal((await h.mirror.resolveLine({ scope: sourceScope, objectType: "Bill", objectId: "61", lineId: "1" }))?.amountCents, "15000");
  } finally {
    await h.close();
  }
});

test("object webhooks persist partial coverage for a source conflict before the next independent object", async () => {
  const account = { Id: "7", SyncToken: "0", Name: "Electric", AccountType: "Expense", MetaData: { LastUpdatedTime: "2026-09-01T00:00:00Z" } };
  const store: Store = { Bill: [bill("70", "0", "2026-09-10T10:00:00Z"), bill("71", "0", "2026-09-10T10:00:00Z")], Account: [account as QuickBooksJsonObject] };
  const h = await harness(store, "2026-09-20T00:00:00Z");
  try {
    assert.equal((await h.sync.syncChanges()).status, "complete");
    store.Bill = [
      bill("70", "0", "2026-09-10T10:00:00Z", 999),
      bill("71", "0", "2026-09-10T10:00:00Z", 999),
      bill("72", "0", "2026-09-11T10:00:00Z", 150),
    ];

    const held = await h.sync.applyObject({ objectType: "Bill", objectId: "70", operation: "updated" });
    assert.equal(held.status, "unsupported");
    assert.equal((await h.sync.applyObject({ objectType: "Bill", objectId: "71", operation: "updated" })).status, "unsupported");
    const coverage = await h.synthetic.db.query<{ status: string; reason: string | null }>(
      "SELECT status, reason FROM accounting_qbo_coverage WHERE stream='transactions.bill'",
    );
    assert.equal(coverage.rows[0]?.status, "partial", "the webhook writes partial coverage in the same transaction as the exception");
    assert.match(coverage.rows[0]?.reason ?? "", /unresolved mirror exceptions/);
    assert.deepEqual((await h.mirror.listOpenSyncExceptions(scope, "transactions.bill")).map(item => [item.objectType, item.objectId, item.version]), [["Bill", "70", "0"], ["Bill", "71", "0"]]);

    const next = await h.sync.applyObject({ objectType: "Bill", objectId: "72", operation: "created" });
    assert.equal(next.status, "applied");
    assert.equal((await h.mirror.resolveLine({ scope: sourceScope, objectType: "Bill", objectId: "72", lineId: "1" }))?.amountCents, "15000");
    assert.equal((await h.mirror.readCoverage(sourceScope, "transactions.bill")).status, "partial", "the later object does not clear the unresolved hold");

    store.Bill[0] = bill("70", "1", "2026-09-20T00:01:00Z", 110);
    assert.equal((await h.sync.applyObject({ objectType: "Bill", objectId: "70", operation: "updated" })).status, "applied");
    assert.equal((await h.mirror.listOpenSyncExceptions(scope, "transactions.bill")).length, 1, "another held object still keeps the stream partial");
    assert.equal((await h.mirror.readCoverage(sourceScope, "transactions.bill")).status, "partial");

    store.Bill[1] = bill("71", "1", "2026-09-20T00:02:00Z", 120);
    assert.equal((await h.sync.applyObject({ objectType: "Bill", objectId: "71", operation: "updated" })).status, "applied");
    assert.deepEqual(await h.mirror.listOpenSyncExceptions(scope, "transactions.bill"), []);
    assert.equal((await h.mirror.readCoverage(sourceScope, "transactions.bill")).status, "complete", "accepted retries restore only the still-anchored stream after every hold resolves");
  } finally {
    await h.close();
  }
});

test("an unanchored object webhook retry cannot claim complete coverage", async () => {
  const account = { Id: "7", SyncToken: "0", Name: "Electric", AccountType: "Expense", MetaData: { LastUpdatedTime: "2026-09-01T00:00:00Z" } };
  const store: Store = { Bill: [bill("73", "0", "2026-09-10T10:00:00Z")], Account: [account as QuickBooksJsonObject] };
  const h = await harness(store, "2026-09-20T00:00:00Z");
  try {
    assert.equal((await h.sync.applyObject({ objectType: "Bill", objectId: "73", operation: "created" })).status, "applied");
    store.Bill[0] = bill("73", "0", "2026-09-10T10:00:00Z", 999);
    assert.equal((await h.sync.applyObject({ objectType: "Bill", objectId: "73", operation: "updated" })).status, "unsupported");
    assert.equal((await h.mirror.readCoverage(sourceScope, "transactions.bill")).status, "partial");

    store.Bill[0] = bill("73", "1", "2026-09-20T00:01:00Z", 110);
    assert.equal((await h.sync.applyObject({ objectType: "Bill", objectId: "73", operation: "updated" })).status, "applied");
    assert.deepEqual(await h.mirror.listOpenSyncExceptions(scope, "transactions.bill"), []);
    assert.equal((await h.mirror.readCoverage(sourceScope, "transactions.bill")).status, "partial", "a webhook retry cannot replace the missing full-replay baseline");
  } finally {
    await h.close();
  }
});

test("a same-version conflict cannot restore a full-replay tombstone before source validation", async () => {
  const account = { Id: "7", SyncToken: "0", Name: "Electric", AccountType: "Expense", MetaData: { LastUpdatedTime: "2026-09-01T00:00:00Z" } };
  const original = bill("80", "0", "2026-09-10T10:00:00Z");
  const store: Store = { Bill: [original], Account: [account as QuickBooksJsonObject] };
  const h = await harness(store, "2026-09-20T00:00:00Z");
  try {
    assert.equal((await h.sync.syncChanges()).status, "complete");
    store.Bill = [];
    const missing = await h.sync.syncChanges({ forceFullReplay: true });
    assert.equal(missing.status, "complete", "the full replay has reconciled the absent object as a deletion");
    assert.equal((await h.mirror.readDeletionState(scope, "Bill", "80"))?.deleted, true);

    store.Bill = [bill("80", "0", "2026-09-10T10:00:00Z", 999)];
    const conflict = await h.sync.syncChanges({ forceFullReplay: true });
    assert.equal(conflict.status, "partial");
    const deletion = await h.mirror.readDeletionState(scope, "Bill", "80");
    assert.deepEqual([deletion?.deleted, deletion?.detectedVia, deletion?.lastKnownVersion], [true, "full_replay", "0"]);
    assert.equal(await h.mirror.resolveLine({ scope: sourceScope, objectType: "Bill", objectId: "80", lineId: "1" }), null);
    const source = await h.synthetic.db.query<{ deleted_at: unknown; provider_body: Record<string, unknown> }>(
      "SELECT deleted_at, provider_body FROM accounting_qbo_source_objects WHERE object_type='Bill' AND object_id='80' AND object_version='0'",
    );
    assert.equal(source.rows.length, 1);
    assert.notEqual(source.rows[0]?.deleted_at, null, "the conflicting body leaves the original tombstone intact");
    assert.equal((source.rows[0]?.provider_body as Record<string, unknown>).TotalAmt, 100);
    assert.equal((await h.mirror.readCoverage(sourceScope, "transactions.bill")).status, "partial");
  } finally {
    await h.close();
  }
});
