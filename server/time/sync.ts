import { isoTimestampSchema } from "../../shared/company";
import { timeConnectionScopeSchema, timeSyncStreamSchema, type TimeConnectionScope, type TimeCoverage, type TimeSyncPort } from "../../shared/time";
import { AccountingError } from "../accounting/errors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { normalizeTimeDeleted, normalizeTimeEntry, normalizeTimeJobcode, normalizeTimeUser, type NormalizedDelete, type NormalizedTimeEntry, type NormalizedTimeJobcode, type NormalizedTimeUser } from "./normalize";
import { createQuickBooksTimeClient, type QuickBooksTimeClient, type TimeProviderPage } from "./provider";
import { createTimeStore, type TimeStore } from "./store";

const STREAMS = ["users", "jobcodes", "timesheets", "timesheets_deleted"] as const;
type Stream = (typeof STREAMS)[number];

function overlap(value: string | null): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time - 1_000).toISOString() : undefined;
}
function maxModified(items: readonly Record<string, unknown>[]): string | null {
  let latest: string | null = null;
  for (const item of items) {
    const value = item.last_modified;
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) continue;
    const normalized = new Date(value).toISOString();
    if (!latest || normalized > latest) latest = normalized;
  }
  return latest;
}
function scopeOf(scope: TimeConnectionScope): TimeConnectionScope { return timeConnectionScopeSchema.parse(scope); }

interface FetchedStream { readonly stream: Stream; readonly items: readonly Record<string, unknown>[]; readonly deleted: readonly Record<string, unknown>[]; readonly watermark: string | null; readonly modifiedSince: string | null; readonly complete: boolean; readonly reason: string | null; }

async function withSavepoint<T>(executor: RentOpsQueryExecutor, name: string, work: () => Promise<T>): Promise<T> {
  await executor.query(`SAVEPOINT ${name}`);
  try {
    const result = await work();
    await executor.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    await executor.query(`ROLLBACK TO SAVEPOINT ${name}`);
    await executor.query(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}

async function fetchAll(client: QuickBooksTimeClient, stream: Stream, accessToken: string, checkpoint: { modifiedSince: string | null } | null, maxPages: number): Promise<FetchedStream> {
  const items: Record<string, unknown>[] = []; let page = 1; let more = false; let reason: string | null = null; const since = overlap(checkpoint?.modifiedSince ?? null) ?? null;
  do {
    if (page > maxPages) { reason = "Provider pagination limit reached; checkpoint was not advanced"; break; }
    const response: TimeProviderPage = await client.getPage(stream, { accessToken, page, limit: 200, modifiedSince: since ?? undefined });
    items.push(...Object.values(response.results)); more = response.more; page += 1;
  } while (more);
  return { stream, items, deleted: stream === "timesheets_deleted" ? items : [], watermark: maxModified(items), modifiedSince: since, complete: !more && reason === null, reason };
}

export interface TimeSyncService extends TimeSyncPort {
  bootstrapRead(scope: TimeConnectionScope, accessToken: string): Promise<{ readonly providerCompanyId: string; readonly userCount: number }>;
}

export function createTimeSyncService(options: { readonly executor: RentOpsQueryExecutor; readonly client?: QuickBooksTimeClient; readonly getAccessToken: (scope: TimeConnectionScope) => Promise<string>; readonly now?: () => Date; readonly store?: TimeStore }): TimeSyncService {
  const now = options.now ?? (() => new Date());
  const rootStore = options.store ?? createTimeStore(options.executor, now);
  const client = options.client ?? createQuickBooksTimeClient(async request => { throw new AccountingError("accounting_configuration", "QuickBooks Time transport is not configured"); });
  return {
    async bootstrapRead(scopeInput, accessToken) {
      const scope = scopeOf(scopeInput); const response = await client.getPage("users", { accessToken, page: 1, limit: 1 });
      return { providerCompanyId: scope.providerCompanyId, userCount: Object.keys(response.results).length };
    },
    async sync(scopeInput, input = {}) {
      const scope = scopeOf(scopeInput); const maxPages = input.maxPages ?? 50; if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10_000) throw new AccountingError("accounting_validation", "QuickBooks Time maxPages is invalid");
      const accessToken = await options.getAccessToken(scope); const runId = await rootStore.beginSyncRun(scope, `sync:${now().toISOString()}`);
        const fetched: FetchedStream[] = []; const conflicts: string[] = [];
        let hadPartialStream = false;
      try {
        for (const stream of STREAMS) { const checkpoint = await rootStore.readCheckpoint(scope, stream); fetched.push(await fetchAll(client, stream, accessToken, checkpoint, maxPages)); }
        const transaction = options.executor.transaction;
        if (!transaction) throw new AccountingError("accounting_configuration", "QuickBooks Time sync requires an atomic SQL transaction");
        await transaction(async executor => {
          const store = rootStore.forExecutor(executor);
          let itemIndex = 0;
          for (const result of fetched) {
            let objectCount = 0; let deletedCount = 0; let partialReason = result.reason;
            if (partialReason !== null) hadPartialStream = true;
            for (const value of result.items) {
              const savepoint = `time_sync_item_${itemIndex}`;
              itemIndex += 1;
              try {
                await withSavepoint(executor, savepoint, async () => {
                  if (result.stream === "users") { await store.upsertUser(scope, normalizeTimeUser(scope, value), now().toISOString()); objectCount += 1; }
                  else if (result.stream === "jobcodes") { await store.upsertJobcode(scope, normalizeTimeJobcode(scope, value), now().toISOString()); objectCount += 1; }
                  else if (result.stream === "timesheets") { const normalized = normalizeTimeEntry(scope, value); const applied = await store.upsertEntry(scope, normalized, now().toISOString()); if (applied.conflict !== "none") conflicts.push(`${normalized.providerTimesheetId}:${applied.conflict}`); if (normalized.conflict !== "none") { partialReason = partialReason ?? `Timesheet ${normalized.providerTimesheetId} has invalid provider duration`; hadPartialStream = true; } objectCount += 1; }
                  else { await store.applyDeleted(scope, normalizeTimeDeleted(scope, value), now().toISOString()); deletedCount += 1; }
                });
              } catch (error) {
                partialReason = partialReason ?? (error instanceof Error ? error.message : "Provider object could not be mirrored");
                hadPartialStream = true;
              }
            }
            const status = result.complete && partialReason === null ? "complete" : "partial";
            if (status === "partial") hadPartialStream = true;
            if (status === "partial" && result.reason) { /* leave the prior checkpoint in place for truncated pages */ }
            const coverage: TimeCoverage = {
              scope, stream: timeSyncStreamSchema.parse(result.stream), status, evidence: "live_provider_readback",
              modifiedSince: result.modifiedSince ? isoTimestampSchema.parse(result.modifiedSince) : null,
              watermark: result.watermark ? isoTimestampSchema.parse(result.watermark) : null,
              observedAt: isoTimestampSchema.parse(now().toISOString()), objectCount, deletedCount, reason: partialReason,
            };
            await store.recordCoverage({ ...coverage, runId });
            if (status === "complete") await store.saveCheckpoint(scope, result.stream, { modifiedSince: result.watermark, watermark: result.watermark, status, reason: null, runId });
          }
        });
        const status = !hadPartialStream && conflicts.length === 0 ? "complete" : "partial";
        await rootStore.finishSyncRun(scope, runId, status);
        const streams = await rootStore.readCoverage(scope);
        return { status, streams, conflicts };
      } catch (error) {
        await rootStore.finishSyncRun(scope, runId, "failed", { code: error instanceof AccountingError ? error.code : "time_sync_failed", message: error instanceof Error ? error.message : "QuickBooks Time sync failed" });
        throw error;
      }
    },
  };
}

export type { NormalizedDelete, NormalizedTimeEntry, NormalizedTimeJobcode, NormalizedTimeUser };
