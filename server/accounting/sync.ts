import { z } from "zod";
import type { QuickBooksConnectionScope } from "../../shared/accounting/quickbooks";
import { financialSourceScopeSchema } from "../../shared/accounting";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { AccountingError } from "./errors";

export interface QboSyncCheckpoint {
  readonly scope: QuickBooksConnectionScope;
  readonly stream: string;
  readonly watermark: string | null;
  readonly cursor: string | null;
  readonly version: number;
  readonly updatedAt: string;
}

export interface QboCheckpointStore {
  load(scope: QuickBooksConnectionScope, stream: string): Promise<QboSyncCheckpoint | null>;
  save(scope: QuickBooksConnectionScope, stream: string, checkpoint: Omit<QboSyncCheckpoint, "scope" | "stream" | "version" | "updatedAt">, expectedVersion: number | null, executor?: RentOpsQueryExecutor): Promise<QboSyncCheckpoint>;
}

interface QboCheckpointRow {
  organization_id: unknown;
  legal_entity_id: unknown;
  environment: unknown;
  realm_id: unknown;
  stream: unknown;
  watermark: unknown;
  cursor: unknown;
  version: unknown;
  updated_at: unknown;
}

function parsedScope(scope: QuickBooksConnectionScope) {
  return financialSourceScopeSchema.parse({ provider: "qbo", ...scope });
}

function text(value: unknown, field: string, max = 255): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new AccountingError("accounting_unavailable", `Stored QBO checkpoint ${field} is invalid`);
  return value;
}

function timestampText(value: unknown, field: string): string {
  if (value instanceof Date) return value.toISOString();
  return text(value, field, 80);
}

function integer(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 1) throw new AccountingError("accounting_unavailable", "Stored QBO checkpoint version is invalid");
  return number;
}

function mapRow(row: QboCheckpointRow): QboSyncCheckpoint {
  const scope = {
    organizationId: text(row.organization_id, "organization", 160),
    legalEntityId: text(row.legal_entity_id, "legal entity", 160),
    environment: text(row.environment, "environment", 20) as "sandbox" | "production",
    realmId: text(row.realm_id, "realm", 32),
  };
  parsedScope(scope);
  return {
    scope,
    stream: text(row.stream, "stream", 120),
    watermark: row.watermark === null || row.watermark === undefined ? null : text(row.watermark, "watermark"),
    cursor: row.cursor === null || row.cursor === undefined ? null : text(row.cursor, "cursor"),
    version: integer(row.version),
    updatedAt: timestampText(row.updated_at, "updated at"),
  };
}

const columns = "organization_id, legal_entity_id, environment, realm_id, stream, watermark, cursor, version, updated_at";

export class PostgresQboCheckpointStore implements QboCheckpointStore {
  constructor(private readonly executor: RentOpsQueryExecutor, private readonly now: () => Date = () => new Date()) {}

  async load(scope: QuickBooksConnectionScope, stream: string): Promise<QboSyncCheckpoint | null> {
    const parsed = parsedScope(scope);
    const validStream = z.string().trim().min(1).max(120).regex(/^[a-z][a-z0-9_.:-]*$/).parse(stream);
    const result = await this.executor.query<QboCheckpointRow>(
      `SELECT ${columns} FROM accounting_qbo_sync_checkpoints
       WHERE organization_id = $1 AND legal_entity_id = $2 AND environment = $3 AND realm_id = $4 AND stream = $5`,
      [parsed.organizationId, parsed.legalEntityId, parsed.environment, parsed.realmId, validStream],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async save(scope: QuickBooksConnectionScope, stream: string, checkpoint: Omit<QboSyncCheckpoint, "scope" | "stream" | "version" | "updatedAt">, expectedVersion: number | null, executor = this.executor): Promise<QboSyncCheckpoint> {
    const parsed = parsedScope(scope);
    const validStream = z.string().trim().min(1).max(120).regex(/^[a-z][a-z0-9_.:-]*$/).parse(stream);
    if (checkpoint.watermark !== null) text(checkpoint.watermark, "watermark");
    if (checkpoint.cursor !== null) text(checkpoint.cursor, "cursor");
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) throw new AccountingError("accounting_validation", "QBO checkpoint version is invalid");
    const values: unknown[] = [parsed.organizationId, parsed.legalEntityId, parsed.environment, parsed.realmId, validStream, checkpoint.watermark, checkpoint.cursor, this.now().toISOString()];
    const result = expectedVersion === null
      ? await executor.query<QboCheckpointRow>(
        `INSERT INTO accounting_qbo_sync_checkpoints
          (organization_id, legal_entity_id, environment, realm_id, stream, watermark, cursor, version, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8)
         ON CONFLICT (organization_id, legal_entity_id, environment, realm_id, stream)
         DO NOTHING
         RETURNING ${columns}`,
        values,
      )
      : await executor.query<QboCheckpointRow>(
        `INSERT INTO accounting_qbo_sync_checkpoints
          (organization_id, legal_entity_id, environment, realm_id, stream, watermark, cursor, version, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8)
         ON CONFLICT (organization_id, legal_entity_id, environment, realm_id, stream)
         DO UPDATE SET watermark = EXCLUDED.watermark, cursor = EXCLUDED.cursor,
           version = accounting_qbo_sync_checkpoints.version + 1, updated_at = EXCLUDED.updated_at
         WHERE accounting_qbo_sync_checkpoints.version = $9
         RETURNING ${columns}`,
        [...values, expectedVersion],
      );
    if (!result.rows[0]) throw new AccountingError("accounting_checkpoint_conflict", "QBO sync checkpoint changed during catch-up");
    return mapRow(result.rows[0]);
  }
}

export interface QboCatchUpPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly watermark: string | null;
}

export interface QboCatchUpResult {
  readonly status: "complete" | "failed";
  readonly checkpoint: QboSyncCheckpoint | null;
  readonly pagesFetched: number;
  readonly itemsApplied: number;
  readonly error?: unknown;
}

export interface QboCatchUpOptions<T> {
  readonly executor: RentOpsQueryExecutor;
  readonly checkpointStore: QboCheckpointStore;
  readonly scope: QuickBooksConnectionScope;
  readonly stream: string;
  readonly fetchPage: (input: { readonly sinceWatermark: string | null; readonly cursor: string | null }) => Promise<QboCatchUpPage<T>>;
  readonly applyPage: (executor: RentOpsQueryExecutor, items: readonly T[]) => Promise<void>;
  /** Optional final mirror/coverage work performed before checkpoint save. */
  readonly finalize?: (executor: RentOpsQueryExecutor, context: { readonly pages: readonly QboCatchUpPage<T>[]; readonly itemsApplied: number }) => Promise<void>;
  readonly maxPages?: number;
  /**
   * Full replay: fetch from the beginning instead of the stored watermark.
   * The saved watermark never moves backwards.
   */
  readonly ignoreStoredWatermark?: boolean;
}

/** Fetches first, then applies all pages in one transaction before advancing the watermark. */
export async function runQboCatchUp<T>(options: QboCatchUpOptions<T>): Promise<QboCatchUpResult> {
  const maxPages = options.maxPages ?? 10_000;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100_000) throw new AccountingError("accounting_validation", "QBO catch-up page limit is invalid");
  const before = await options.checkpointStore.load(options.scope, options.stream);
  const pages: QboCatchUpPage<T>[] = [];
  const since = options.ignoreStoredWatermark ? null : before?.watermark ?? null;
  // An interrupted run never commits a cursor (pages are applied atomically
  // at the end), so every run restarts from the committed watermark.
  let cursor: string | null = null;
  let watermark = before?.watermark ?? null;
  try {
    for (;;) {
      if (pages.length >= maxPages) throw new AccountingError("accounting_unavailable", "QBO catch-up exceeded the page limit");
      const page = await options.fetchPage({ sinceWatermark: since, cursor });
      if (!page || !Array.isArray(page.items) || (page.watermark !== null && (typeof page.watermark !== "string" || page.watermark.length === 0))) throw new AccountingError("accounting_unavailable", "QBO catch-up returned an invalid page");
      if (page.nextCursor !== null && (typeof page.nextCursor !== "string" || page.nextCursor.length === 0 || page.nextCursor === cursor)) throw new AccountingError("accounting_unavailable", "QBO catch-up returned a non-advancing cursor");
      pages.push(page);
      if (page.watermark !== null && (watermark === null || page.watermark > watermark)) watermark = page.watermark;
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
  } catch (error) {
    return { status: "failed", checkpoint: before, pagesFetched: pages.length, itemsApplied: 0, error };
  }

  if (!options.executor.transaction) throw new AccountingError("accounting_configuration", "QBO catch-up requires transaction support");
  try {
    const checkpoint = await options.executor.transaction(async (transaction) => {
      for (const page of pages) await options.applyPage(transaction, page.items);
      if (options.finalize) await options.finalize(transaction, { pages, itemsApplied: pages.reduce((sum, page) => sum + page.items.length, 0) });
      return options.checkpointStore.save(options.scope, options.stream, { watermark, cursor }, before?.version ?? null, transaction);
    });
    return { status: "complete", checkpoint, pagesFetched: pages.length, itemsApplied: pages.reduce((sum, page) => sum + page.items.length, 0) };
  } catch (error) {
    // The transaction rolls back both mirror writes and the checkpoint. The
    // returned checkpoint is deliberately the last committed value.
    return { status: "failed", checkpoint: before, pagesFetched: pages.length, itemsApplied: 0, error };
  }
}
