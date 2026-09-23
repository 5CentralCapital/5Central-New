import { createHash } from "node:crypto";
import { companyScopeSchema, legalEntityIdSchema, organizationIdSchema, recordReferenceIdSchema, type CompanyScope, type OperationReceipt } from "../../shared/company";
import {
  PM_SETTLEMENT_COMMAND_KINDS,
  QBO_SYNC_REQUEST_COMMAND_KIND,
  RENTAL_POSTING_COMMAND_KINDS,
  requestQboSyncPayloadSchema,
  type AccountingOperationCommandKind,
  type AccountingPayablesQuery,
  type AccountingPayablesResponse,
  type ConnectorHealthResponse,
  type PeriodCloseChecklist,
  type PmSettlementCommandKind,
  type PmSettlementDetail,
  type PmSettlementListQuery,
  type PmSettlementListResponse,
  type RentalBridgePreview,
  type RentalPostingCommandKind,
  type RentalPostingPolicy,
} from "../../shared/accounting/operations";
import { loadAuthenticatedPrincipal, type AuthenticatedPrincipal, type CommandAuthorizationPolicy } from "../company/authorization";
import { ConflictCommandError, ValidationCommandError } from "../company/commands/errors";
import { runCompanyCommand, type CommandHandlerContext, type CommandHandlerResult } from "../company/commands/runner";
import { PostgresJobQueue } from "../jobs/queue";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { readConnectorHealth, readPeriodCloseChecklist } from "./connector-health";
import { listAccountingPayables } from "./payables-read";
import { executePmSettlementCommand, getPmSettlement, listPmSettlements } from "./pm-settlements";
import { executeRentalPostingCommand, listRentalPostingPolicies, parseEnvelope, type AccountingCommandAccess } from "./posting-policy";
import { previewRentalBridge, rentalBridgePreviewCsv } from "./rental-bridge";
import { qboScopeKeyPart, QBO_SYNC_TOPIC } from "./webhook-ingest";

export const QBO_SYNC_REQUEST_POLICY: CommandAuthorizationPolicy = Object.freeze({
  commandKind: QBO_SYNC_REQUEST_COMMAND_KIND,
  allowedRoles: ["owner", "admin", "finance"] as const,
  requiredScope: "legal_entity" as const,
});

export interface AccountingOperationsPort {
  health(principal: AuthenticatedPrincipal, input: { readonly organizationId: string; readonly legalEntityId?: string }): Promise<ConnectorHealthResponse>;
  closeChecklist(principal: AuthenticatedPrincipal, input: { readonly organizationId: string; readonly legalEntityId: string; readonly periodStart: string; readonly periodEnd: string }): Promise<PeriodCloseChecklist>;
  listPostingPolicies(principal: AuthenticatedPrincipal, input: { readonly organizationId: string; readonly legalEntityId: string }): Promise<{ readonly items: readonly RentalPostingPolicy[] }>;
  listPmSettlements(principal: AuthenticatedPrincipal, query: PmSettlementListQuery): Promise<PmSettlementListResponse>;
  getPmSettlement(principal: AuthenticatedPrincipal, input: { readonly scope: CompanyScope; readonly settlementId: string }): Promise<PmSettlementDetail>;
  previewBridge(principal: AuthenticatedPrincipal, input: { readonly organizationId: string; readonly legalEntityId: string; readonly periodStart: string; readonly periodEnd: string }): Promise<RentalBridgePreview>;
  exportBridgeCsv(principal: AuthenticatedPrincipal, input: { readonly organizationId: string; readonly legalEntityId: string; readonly periodStart: string; readonly periodEnd: string }): Promise<{ readonly filename: string; readonly csv: string }>;
  listPayables(principal: AuthenticatedPrincipal, query: AccountingPayablesQuery): Promise<AccountingPayablesResponse>;
  execute(kind: AccountingOperationCommandKind, envelope: unknown, access: AccountingCommandAccess): Promise<OperationReceipt>;
}

type Context = CommandHandlerContext<Record<string, unknown>>;

/**
 * Queue a scoped QuickBooks catch-up for the worker. Pending requests for
 * the same connection coalesce; the provider is never called in the request.
 */
async function handleSyncRequest(context: Context): Promise<CommandHandlerResult> {
  const payload = requestQboSyncPayloadSchema.parse(context.envelope.payload);
  const legalEntityId = context.envelope.scope.legalEntityId;
  if (!legalEntityId) throw new ValidationCommandError("Choose the legal entity to refresh", { reason: "legal_entity_scope_required" });
  const scope = { organizationId: context.envelope.scope.organizationId, legalEntityId, environment: payload.environment, realmId: payload.realmId };
  const connection = await context.executor.query<{ status: string }>(
    `SELECT status FROM accounting_qbo_connections WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4`,
    [scope.organizationId, scope.legalEntityId, scope.environment, scope.realmId],
  );
  const status = connection.rows[0]?.status;
  if (!status) throw new ValidationCommandError("QuickBooks is not connected for this legal entity", { reason: "qbo_connection_missing" });
  if (status !== "active") throw new ConflictCommandError("QuickBooks needs to be reconnected before it can refresh", { reason: "qbo_needs_reconnect" });
  const queue = new PostgresJobQueue(context.executor);
  const coalesceKey = `sync|${qboScopeKeyPart(scope)}|${payload.forceFullReplay ? "full" : "changes"}`;
  const result = await queue.enqueue({
    jobKey: `qbo.sync:manual:${createHash("sha256").update(qboScopeKeyPart(scope)).digest("hex").slice(0, 24)}:${context.envelope.operationId}`,
    topic: QBO_SYNC_TOPIC,
    organizationId: scope.organizationId,
    coalesceKey,
    payload: { ...scope, origin: "manual", forceFullReplay: payload.forceFullReplay },
    priority: 50,
    maxAttempts: 6,
  });
  return {
    state: "saved_in_rops",
    affectedRecordIds: [recordReferenceIdSchema.parse(result.job.id)],
    resultingRevisions: [],
    validationOutcomes: [{ code: "accounting.qbo.sync.queued", severity: "info", message: result.coalesced ? "A QuickBooks refresh is already queued for this company." : "QuickBooks refresh queued for the background worker." }],
  };
}

export async function executeQboSyncRequest(executor: RentOpsQueryExecutor, rawEnvelope: unknown, access: AccountingCommandAccess): Promise<OperationReceipt> {
  const envelope = parseEnvelope(requestQboSyncPayloadSchema, rawEnvelope, "QuickBooks refresh");
  return runCompanyCommand(executor, { envelope, principal: access.principal, resolvePrincipal: access.resolvePrincipal, transport: access.transport, policy: QBO_SYNC_REQUEST_POLICY, handler: handleSyncRequest });
}

export function createAccountingOperationsPort(executor: RentOpsQueryExecutor, options: { readonly now?: () => Date } = {}): AccountingOperationsPort {
  const now = options.now ?? (() => new Date());
  async function read<T>(principal: AuthenticatedPrincipal, work: (transaction: RentOpsQueryExecutor, fresh: AuthenticatedPrincipal) => Promise<T>): Promise<T> {
    if (!executor.transaction) throw new ValidationCommandError("Accounting reads require transaction support", { reason: "transaction_required" });
    return executor.transaction(async transaction => {
      // Reload grants inside the snapshot so a revoked grant cannot keep reading.
      const fresh = await loadAuthenticatedPrincipal(transaction, { actorId: principal.actorId, organizationId: principal.organizationId, role: principal.role });
      return work(transaction, fresh);
    }, { readOnly: true });
  }
  const bridgeInput = (input: { organizationId: string; legalEntityId: string; periodStart: string; periodEnd: string }) => ({
    organizationId: organizationIdSchema.parse(input.organizationId), legalEntityId: legalEntityIdSchema.parse(input.legalEntityId), periodStart: input.periodStart, periodEnd: input.periodEnd,
  });
  return {
    health: (principal, input) => read(principal, (transaction, fresh) => readConnectorHealth(transaction, fresh, input, now)),
    closeChecklist: (principal, input) => read(principal, (transaction, fresh) => readPeriodCloseChecklist(transaction, fresh, input, now)),
    listPostingPolicies: (principal, input) => read(principal, (transaction, fresh) => listRentalPostingPolicies(transaction, fresh, companyScopeSchema.parse(input) as CompanyScope & { legalEntityId: string })),
    listPmSettlements: (principal, query) => read(principal, (transaction, fresh) => listPmSettlements(transaction, fresh, query)),
    getPmSettlement: (principal, input) => read(principal, (transaction, fresh) => getPmSettlement(transaction, fresh, input)),
    previewBridge: (principal, input) => read(principal, (transaction, fresh) => previewRentalBridge(transaction, fresh, bridgeInput(input), now)),
    exportBridgeCsv: async (principal, input) => {
      const preview = await read(principal, (transaction, fresh) => previewRentalBridge(transaction, fresh, bridgeInput(input), now));
      return { filename: `rental-bridge-${preview.periodStart}-${preview.periodEnd}.csv`, csv: rentalBridgePreviewCsv(preview) };
    },
    listPayables: (principal, query) => read(principal, (transaction, fresh) => listAccountingPayables(transaction, fresh, query)),
    execute: (kind, envelope, access) => {
      if ((RENTAL_POSTING_COMMAND_KINDS as readonly string[]).includes(kind)) return executeRentalPostingCommand(executor, kind as RentalPostingCommandKind, envelope, access);
      if ((PM_SETTLEMENT_COMMAND_KINDS as readonly string[]).includes(kind)) return executePmSettlementCommand(executor, kind as PmSettlementCommandKind, envelope, access);
      if (kind === QBO_SYNC_REQUEST_COMMAND_KIND) return executeQboSyncRequest(executor, envelope, access);
      throw new ValidationCommandError("Unknown accounting command", { reason: "unknown_command" });
    },
  };
}
