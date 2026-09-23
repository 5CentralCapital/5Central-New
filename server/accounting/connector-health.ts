import {
  connectorHealthResponseSchema,
  periodCloseChecklistSchema,
  type ConnectorHealth,
  type ConnectorHealthResponse,
  type PeriodCloseChecklist,
} from "../../shared/accounting/operations";
import { isoDateSchema, legalEntityIdSchema, organizationIdSchema } from "../../shared/company";
import { authorizeCompanyRead, type AuthenticatedPrincipal } from "../company/authorization";
import { ValidationCommandError } from "../company/commands/errors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { createQboAccountingMirrorStore } from "./mirror-store";
import { ACCOUNTING_READ_ROLES } from "./posting-policy";
import { QBO_CHANGE_STREAM } from "./provider-sync";

const STALE_AFTER_SECONDS = 2 * 60 * 60;
const WORKER_ALIVE_MS = 2 * 60_000;

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

interface ConnectionRow {
  organization_id: string;
  legal_entity_id: string;
  legal_entity_name: string;
  environment: "sandbox" | "production";
  realm_id: string;
  status: string | null;
  access_token_expires_at: unknown;
  refresh_token_hard_expires_at: unknown;
  read_enabled: boolean;
  company_name: string | null;
}

/**
 * Per-binding connector health for the operator: connection state, sync and
 * change-capture freshness, coverage, open exceptions, active deletion
 * tombstones, job backlog and failures, last webhook and 429 cooldown.
 */
export async function readConnectorHealth(executor: RentOpsQueryExecutor, principal: AuthenticatedPrincipal, input: { readonly organizationId: string; readonly legalEntityId?: string }, now: () => Date = () => new Date()): Promise<ConnectorHealthResponse> {
  const organizationId = organizationIdSchema.parse(input.organizationId);
  const legalEntityId = input.legalEntityId === undefined ? undefined : legalEntityIdSchema.parse(input.legalEntityId);
  authorizeCompanyRead(principal, { organizationId, ...(legalEntityId ? { legalEntityId } : {}) }, ACCOUNTING_READ_ROLES);
  const current = now();
  const rows = await executor.query<ConnectionRow>(
    `SELECT b.organization_id, b.legal_entity_id, e.name AS legal_entity_name, b.environment, b.realm_id, c.status,
            c.access_token_expires_at, c.refresh_token_hard_expires_at,
            EXISTS (SELECT 1 FROM accounting_qbo_capabilities cap
                     WHERE cap.organization_id=b.organization_id AND cap.legal_entity_id=b.legal_entity_id AND cap.environment=b.environment
                       AND cap.realm_id=b.realm_id AND cap.capability='accounting.read' AND cap.enabled AND cap.evidence='live_provider_readback') AS read_enabled,
            COALESCE(b.provider_company_name, b.provider_legal_name) AS company_name
       FROM accounting_qbo_realm_bindings b
       JOIN company_legal_entities e ON e.organization_id = b.organization_id AND e.id = b.legal_entity_id
       LEFT JOIN accounting_qbo_connections c ON c.organization_id=b.organization_id AND c.legal_entity_id=b.legal_entity_id
            AND c.environment=b.environment AND c.realm_id=b.realm_id
      WHERE b.organization_id = $1 AND ($2::uuid IS NULL OR b.legal_entity_id = $2)
      ORDER BY e.name, b.environment, b.realm_id
      LIMIT 200`,
    [organizationId, legalEntityId ?? null],
  );
  const mirror = createQboAccountingMirrorStore(executor, now);
  const items: ConnectorHealth[] = [];
  for (const row of rows.rows) {
    // A principal limited to some entities only sees those connections.
    try { authorizeCompanyRead(principal, { organizationId, legalEntityId: row.legal_entity_id as never }, ACCOUNTING_READ_ROLES); } catch { continue; }
    const scope = { organizationId, legalEntityId: String(row.legal_entity_id), environment: row.environment, realmId: String(row.realm_id) };
    const scopeParams = [scope.organizationId, scope.legalEntityId, scope.environment, scope.realmId];
    const checkpoints = await executor.query<{ stream: string; watermark: string | null; cursor: string | null; updated_at: unknown }>(
      `SELECT stream, watermark, cursor, updated_at FROM accounting_qbo_sync_checkpoints
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4`,
      scopeParams,
    );
    const change = checkpoints.rows.find(item => item.stream === QBO_CHANGE_STREAM);
    const lastSuccessfulSyncAt = checkpoints.rows.map(item => iso(item.updated_at)).filter((value): value is string => value !== null).sort().at(-1) ?? null;
    const lastChangeSyncAt = iso(change?.watermark ?? null);
    const lastVerifiedFullReplayAt = typeof change?.cursor === "string" && change.cursor.startsWith("verified:") ? iso(change.cursor.slice("verified:".length)) : null;
    const lagSeconds = lastChangeSyncAt ? Math.max(0, Math.floor((current.getTime() - Date.parse(lastChangeSyncAt)) / 1000)) : null;
    const coverage = await mirror.readCoverage({ provider: "qbo", ...scope } as never);
    const openSyncExceptions = (await mirror.listOpenSyncExceptions(scope)).length;
    const activeTombstones = await mirror.countActiveTombstones(scope);
    const jobs = await executor.query<{ state: string; count: unknown }>(
      `SELECT state, COUNT(*) AS count FROM company_jobs
        WHERE organization_id = $1 AND topic LIKE 'accounting.qbo.%' AND state IN ('queued','running','retry','dead')
          AND payload->>'legalEntityId' = $2 AND payload->>'environment' = $3 AND payload->>'realmId' = $4
        GROUP BY state`,
      scopeParams,
    );
    const count = (state: string) => Number(jobs.rows.find(item => item.state === state)?.count ?? 0);
    const failure = await executor.query<{ last_error_code: string | null }>(
      `SELECT last_error_code FROM company_jobs
        WHERE organization_id = $1 AND topic LIKE 'accounting.qbo.%' AND state IN ('retry','dead') AND last_error_code IS NOT NULL
          AND payload->>'legalEntityId' = $2 AND payload->>'environment' = $3 AND payload->>'realmId' = $4
        ORDER BY updated_at DESC LIMIT 1`,
      scopeParams,
    );
    const throttle = await executor.query<{ until: unknown }>(
      `SELECT MAX(run_after) AS until FROM company_jobs
        WHERE organization_id = $1 AND topic LIKE 'accounting.qbo.%' AND state = 'retry' AND last_error_code = 'quickbooks_rate_limited' AND run_after > $5
          AND payload->>'legalEntityId' = $2 AND payload->>'environment' = $3 AND payload->>'realmId' = $4`,
      [...scopeParams, current.toISOString()],
    );
    const webhook = await executor.query<{ received_at: unknown }>(
      `SELECT MAX(received_at) AS received_at FROM accounting_qbo_webhook_events WHERE environment = $1 AND realm_id = $2`,
      [scope.environment, scope.realmId],
    );
    const status = row.status === "active" || row.status === "needs_reconnect" || row.status === "revoked" ? row.status : "missing";
    const freshness: ConnectorHealth["freshness"] = status !== "active" ? "disconnected" : lagSeconds === null ? "never_synced" : lagSeconds > STALE_AFTER_SECONDS ? "stale" : "current";
    items.push({
      scope: scope as ConnectorHealth["scope"],
      legalEntityName: String(row.legal_entity_name),
      companyName: row.company_name ?? null,
      connection: {
        status,
        readEnabled: row.read_enabled === true,
        accessTokenExpiresAt: iso(row.access_token_expires_at) as ConnectorHealth["connection"]["accessTokenExpiresAt"],
        refreshTokenHardExpiresAt: iso(row.refresh_token_hard_expires_at) as ConnectorHealth["connection"]["refreshTokenHardExpiresAt"],
      },
      freshness,
      lastSuccessfulSyncAt: lastSuccessfulSyncAt as ConnectorHealth["lastSuccessfulSyncAt"],
      lastChangeSyncAt: lastChangeSyncAt as ConnectorHealth["lastChangeSyncAt"],
      lastVerifiedFullReplayAt: lastVerifiedFullReplayAt as ConnectorHealth["lastVerifiedFullReplayAt"],
      lagSeconds,
      coverage: { status: coverage.status, reason: coverage.reason },
      openSyncExceptions,
      activeTombstones,
      jobs: { queued: count("queued"), running: count("running"), retry: count("retry"), dead: count("dead"), lastFailureCode: failure.rows[0]?.last_error_code ?? null },
      lastWebhookAt: iso(webhook.rows[0]?.received_at ?? null) as ConnectorHealth["lastWebhookAt"],
      rateLimitedUntil: iso(throttle.rows[0]?.until ?? null) as ConnectorHealth["rateLimitedUntil"],
    });
  }
  const workers = await executor.query<{ active: unknown; last_seen: unknown }>(
    `SELECT COUNT(*) FILTER (WHERE last_seen_at >= $1) AS active, MAX(last_seen_at) AS last_seen FROM company_worker_heartbeats`,
    [new Date(current.getTime() - WORKER_ALIVE_MS).toISOString()],
  );
  return connectorHealthResponseSchema.parse({
    items,
    workers: { active: Number(workers.rows[0]?.active ?? 0), lastSeenAt: iso(workers.rows[0]?.last_seen ?? null) },
    generatedAt: current.toISOString(),
  });
}

/**
 * Read-only close checklist for one entity and period. It reports; it never
 * locks or changes anything in QuickBooks.
 */
export async function readPeriodCloseChecklist(executor: RentOpsQueryExecutor, principal: AuthenticatedPrincipal, input: { readonly organizationId: string; readonly legalEntityId: string; readonly periodStart: string; readonly periodEnd: string }, now: () => Date = () => new Date()): Promise<PeriodCloseChecklist> {
  const organizationId = organizationIdSchema.parse(input.organizationId);
  const legalEntityId = legalEntityIdSchema.parse(input.legalEntityId);
  const periodStart = isoDateSchema.parse(input.periodStart);
  const periodEnd = isoDateSchema.parse(input.periodEnd);
  if (periodEnd < periodStart) throw new ValidationCommandError("The period end cannot be before its start", { reason: "period_order" });
  authorizeCompanyRead(principal, { organizationId, legalEntityId }, ACCOUNTING_READ_ROLES);
  const items: PeriodCloseChecklist["items"][number][] = [];

  const policies = await executor.query<{ method: string; effective_from: unknown; effective_until: unknown }>(
    `SELECT method, effective_from, effective_until FROM accounting_rental_posting_policies
      WHERE organization_id=$1 AND legal_entity_id=$2 AND effective_from <= $4::date AND (effective_until IS NULL OR effective_until > $3::date)`,
    [organizationId, legalEntityId, periodStart, periodEnd],
  );
  const methodLabel = (method: string) => method === "native_receivables" ? "Native QuickBooks receivables" : method === "summary_bridge" ? "Summary bridge" : "Not posted";
  items.push(policies.rows.length === 0
    ? { code: "posting_policy", label: "Rental accounting method", state: "blocked", detail: "No method is set for this period." }
    : policies.rows.length === 1
      ? { code: "posting_policy", label: "Rental accounting method", state: "complete", detail: methodLabel(policies.rows[0]!.method) }
      : { code: "posting_policy", label: "Rental accounting method", state: "attention", detail: "The method changes inside this period; confirm the cutoff bridge." });

  const health = await readConnectorHealth(executor, principal, { organizationId, legalEntityId }, now);
  const active = health.items.filter(item => item.connection.status === "active");
  if (!health.items.length) {
    items.push({ code: "sync_complete", label: "QuickBooks sync", state: "attention", detail: "QuickBooks is not connected for this entity." });
  } else {
    const synced = active.length > 0 && active.every(item => item.lastChangeSyncAt !== null && item.lastChangeSyncAt.slice(0, 10) > periodEnd && item.coverage.status === "complete");
    items.push({ code: "sync_complete", label: "QuickBooks sync", state: synced ? "complete" : active.length ? "attention" : "blocked", detail: synced ? "Synced past the period end with complete coverage." : active.length ? "Sync has not covered the full period with complete coverage yet." : "QuickBooks needs to be reconnected." });
  }
  const exceptions = health.items.reduce((sum, item) => sum + item.openSyncExceptions, 0);
  items.push({ code: "exceptions_resolved", label: "Sync exceptions", state: exceptions === 0 ? "complete" : "attention", detail: exceptions === 0 ? "No open sync exceptions." : `${exceptions} open sync exception${exceptions === 1 ? "" : "s"}.` });
  const settlements = await executor.query<{ state: string; count: unknown }>(
    `SELECT state, COUNT(*) AS count FROM accounting_pm_settlements
      WHERE organization_id=$1 AND legal_entity_id=$2 AND period_start <= $4::date AND period_end >= $3::date GROUP BY state`,
    [organizationId, legalEntityId, periodStart, periodEnd],
  );
  const byState = (state: string) => Number(settlements.rows.find(row => row.state === state)?.count ?? 0);
  const total = settlements.rows.reduce((sum, row) => sum + Number(row.count ?? 0), 0);
  items.push(total === 0
    ? { code: "pm_settlements_reconciled", label: "PM settlements", state: "not_applicable", detail: "No manager statements are recorded for this period." }
    : byState("exception") > 0
      ? { code: "pm_settlements_reconciled", label: "PM settlements", state: "blocked", detail: `${byState("exception")} statement${byState("exception") === 1 ? " has" : "s have"} an exception.` }
      : byState("draft") > 0
        ? { code: "pm_settlements_reconciled", label: "PM settlements", state: "attention", detail: `${byState("draft")} of ${total} statements are not reconciled.` }
        : { code: "pm_settlements_reconciled", label: "PM settlements", state: "complete", detail: `${total} statement${total === 1 ? "" : "s"} reconciled.` });
  const tombstones = health.items.reduce((sum, item) => sum + item.activeTombstones, 0);
  items.push({ code: "deletions_reviewed", label: "QuickBooks deletions", state: tombstones === 0 ? "complete" : "attention", detail: tombstones === 0 ? "No deleted source records affect the mirror." : `${tombstones} deleted QuickBooks record${tombstones === 1 ? "" : "s"} to review.` });
  return periodCloseChecklistSchema.parse({
    organizationId, legalEntityId, periodStart, periodEnd, items,
    completeCount: items.filter(item => item.state === "complete" || item.state === "not_applicable").length,
    generatedAt: now().toISOString(),
  });
}
