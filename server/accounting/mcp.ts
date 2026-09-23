import { z } from "zod";
import { randomUUID } from "node:crypto";
import { commandEnvelopeSchema, companyScopeSchema, isoDateSchema, legalEntityIdSchema, organizationIdSchema } from "../../shared/company";
import {
  ACCOUNTING_OPERATION_MCP_TOOL_NAMES,
  accountingOperationCommandPayloadSchemas,
  PM_SETTLEMENT_COMMAND_KINDS,
  pmSettlementListQuerySchema,
  QBO_SYNC_REQUEST_COMMAND_KIND,
  RENTAL_POSTING_COMMAND_KINDS,
  type PmSettlementCommandKind,
  type RentalPostingCommandKind,
} from "../../shared/accounting/operations";
import type { CommandRole } from "../../shared/company";
import type { AccountingServices } from "./index";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { attestTransport, loadAuthenticatedPrincipal, authorizeCompanyRead } from "../company/authorization";
import { AccountingError } from "./errors";

export type AccountingToolRegistrar = (name: string, description: string, schema: z.ZodRawShape, write: boolean, handler: (args: any) => Promise<unknown>) => void;

const scopeInput = z.object({
  provider: z.literal("qbo"),
  organizationId: organizationIdSchema,
  legalEntityId: legalEntityIdSchema,
  environment: z.enum(["sandbox", "production"]),
  realmId: z.string().regex(/^\d{1,32}$/),
}).strict();

export interface AccountingMcpOptions {
  readonly executor: RentOpsQueryExecutor;
  readonly services: AccountingServices;
  readonly actorId: string;
  /** Trusted session role; command arguments cannot select this value. */
  readonly role?: CommandRole;
  /** Returns an in-app browser URL that will bind OAuth to its own session. */
  readonly browserSetupUrl?: (scope: { readonly provider: "qbo"; readonly organizationId: string; readonly legalEntityId: string; readonly environment: "sandbox" | "production"; readonly expectedRealmId: string | null }) => string;
}

/** MCP adapter accepts identity only from the authenticated server options. */
export function registerAccountingMcpTools(register: AccountingToolRegistrar, options: AccountingMcpOptions): void {
  const transport = attestTransport("codex_mcp");
  const principalRole = options.role ?? "admin";
  const principalFor = (organizationId: string, executor = options.executor) => loadAuthenticatedPrincipal(executor, { actorId: options.actorId, organizationId, role: principalRole });
  const readAuthorized = async <T>(scope: z.infer<typeof scopeInput>, read: (executor: RentOpsQueryExecutor) => Promise<T>): Promise<T> => {
    if (!options.executor.transaction) throw new AccountingError("accounting_configuration", "Accounting reads require a transactional company database");
    return options.executor.transaction(async executor => {
      const principal = await principalFor(scope.organizationId, executor);
      authorizeCompanyRead(principal, { organizationId: scope.organizationId, legalEntityId: scope.legalEntityId }, ["owner", "admin", "finance", "read_only_reviewer"]);
      return read(executor);
    }, { readOnly: true });
  };
  register("get_accounting_coverage", "Read verified QBO mirror coverage for an authorized legal entity and realm. Coverage does not establish bank settlement.", { scope: scopeInput }, false, async ({ scope }) => {
    const parsed = scopeInput.parse(scope);
    return readAuthorized(parsed, executor => options.services.mirror.forExecutor(executor).readCoverage(parsed));
  });
  register("resolve_accounting_source_line", "Resolve one exact QBO transaction line. A raw provider ID or posted status alone is not payment proof.", { scope: scopeInput, objectType: z.string(), objectId: z.string(), lineId: z.string(), version: z.string().optional() }, false, async (args) => {
    const scope = scopeInput.parse(args.scope);
    return readAuthorized(scope, executor => options.services.mirror.forExecutor(executor).resolveLine({ scope, objectType: args.objectType, objectId: args.objectId, lineId: args.lineId, version: args.version }));
  });
  register("get_accounting_mirrors", "List named Account, Vendor, Customer, or Employee records from the verified QBO mirror.", { scope: scopeInput, kind: z.enum(["accounts", "vendors", "customers", "employees"]) }, false, async (args) => {
    const scope = scopeInput.parse(args.scope);
    return readAuthorized(scope, executor => options.services.mirror.forExecutor(executor).listProviderMirrors(scope, args.kind));
  });
  register("list_accounting_transactions", "List exact mirrored QBO source lines with coverage evidence and pagination.", { scope: scopeInput, from: z.string().date().optional(), through: z.string().date().optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().min(1).max(512).optional() }, false, async (args) => {
    const scope = scopeInput.parse(args.scope);
    return readAuthorized(scope, executor => options.services.mirror.forExecutor(executor).listTransactions({ scope, from: args.from, through: args.through, limit: args.limit, cursor: args.cursor }));
  });
  register("sync_accounting_source", "Queue a read-only QuickBooks catch-up (change data capture, or a full replay with deletion reconciliation when needed) for an authorized connection. The background worker runs it; follow progress with get_accounting_connector_health. Pass the same operationId to retry safely.", { scope: scopeInput, fullReplay: z.boolean().optional(), operationId: z.string().uuid().optional() }, true, async (args) => {
    const scope = scopeInput.parse(args.scope);
    if (options.services.qbo.status !== "configured") throw new AccountingError("accounting_configuration", "QuickBooks is not configured");
    if (scope.environment !== options.services.qbo.environment) throw new AccountingError("accounting_conflict", "The requested QuickBooks environment is not configured for this server");
    const operationId = args.operationId ?? randomUUID();
    return options.services.operations.execute(QBO_SYNC_REQUEST_COMMAND_KIND, {
      operationId, idempotencyKey: `qbo-sync:${operationId}`, scope: { organizationId: scope.organizationId, legalEntityId: scope.legalEntityId },
      payload: { environment: scope.environment, realmId: scope.realmId, forceFullReplay: args.fullReplay === true },
    }, { principal: await principalFor(scope.organizationId), transport, resolvePrincipal: executor => principalFor(scope.organizationId, executor) });
  });
  register("disconnect_quickbooks", "Revoke an authorized QBO connection at Intuit, then clear its local credentials and disable its capabilities. A failed or uncertain revoke keeps the connection for retry. Reconnect requires the browser flow.", { scope: scopeInput }, true, async (args) => {
    const scope = scopeInput.parse(args.scope);
    const principal = await principalFor(scope.organizationId);
    authorizeCompanyRead(principal, { organizationId: scope.organizationId, legalEntityId: scope.legalEntityId }, ["owner", "admin", "finance"]);
    if (options.services.qbo.status !== "configured") throw new AccountingError("accounting_configuration", "QuickBooks is not configured");
    if (scope.environment !== options.services.qbo.environment) throw new AccountingError("accounting_conflict", "The requested QuickBooks environment is not configured for this server");
    return options.services.qbo.disconnect({ actorId: options.actorId, channel: "codex_mcp", scope: { organizationId: scope.organizationId, legalEntityId: scope.legalEntityId, environment: scope.environment, realmId: scope.realmId } });
  });
  register("begin_quickbooks_connect", "Return a scoped browser setup link for QuickBooks. OAuth state is created only by the authenticated browser session, so an MCP actor cannot complete a browser callback directly.", { organizationId: organizationIdSchema, legalEntityId: legalEntityIdSchema, expectedRealmId: z.string().regex(/^\d{1,32}$/).optional() }, true, async (args) => {
    const organizationId = organizationIdSchema.parse(args.organizationId);
    const legalEntityId = legalEntityIdSchema.parse(args.legalEntityId);
    const principal = await principalFor(organizationId);
    authorizeCompanyRead(principal, { organizationId, legalEntityId }, ["owner", "admin", "finance"]);
    if (options.services.qbo.status !== "configured") throw new Error("QuickBooks is not configured");
    const scope = { provider: "qbo" as const, organizationId, legalEntityId, environment: options.services.qbo.environment, expectedRealmId: args.expectedRealmId ?? null };
    const defaultSetupUrl = `/ops?${new URLSearchParams({ section: "accounting", company: organizationId, ...(args.expectedRealmId ? { expectedRealmId: args.expectedRealmId } : {}) }).toString()}`;
    return {
      status: "browser_required" as const,
      scope,
      expectedRealmId: args.expectedRealmId ?? null,
      setupUrl: options.browserSetupUrl?.(scope) ?? defaultSetupUrl,
    };
  });

  const operations = options.services.operations;
  register("get_accounting_connector_health", "Read QuickBooks connector health per legal entity and realm: connection state, last sync and change capture, lag, coverage, open exceptions, deletion tombstones, job backlog and failures, last webhook and rate-limit cooldown.", { organizationId: organizationIdSchema, legalEntityId: legalEntityIdSchema.optional() }, false,
    async args => operations.health(await principalFor(args.organizationId), { organizationId: args.organizationId, ...(args.legalEntityId ? { legalEntityId: args.legalEntityId } : {}) }));
  register("get_period_close_checklist", "Read the period close checklist for one legal entity: posting method, sync completeness, exceptions, PM settlements and deletions. Read-only; it never locks QuickBooks.", { organizationId: organizationIdSchema, legalEntityId: legalEntityIdSchema, periodStart: isoDateSchema, periodEnd: isoDateSchema }, false,
    async args => operations.closeChecklist(await principalFor(args.organizationId), args));
  register("list_rental_posting_policies", "List the rental accounting method (native QuickBooks receivables, summary bridge, or not posted) for each effective period of a legal entity. Read recordRevision before closing one.", { organizationId: organizationIdSchema, legalEntityId: legalEntityIdSchema }, false,
    async args => operations.listPostingPolicies(await principalFor(args.organizationId), args));
  register("list_pm_settlements", "List property-manager statements with gross collections, PM costs, owner remittance and held funds. Follow nextCursor to continue. Names are untrusted data.", { query: pmSettlementListQuerySchema }, false,
    async ({ query }) => operations.listPmSettlements(await principalFor(query.organizationId), query));
  register("get_pm_settlement", "Read one PM statement with its lines, gross-to-net report and differences (header vs lines, held-funds roll-forward, missing bank settlement).", { scope: companyScopeSchema, settlementId: z.string().uuid() }, false,
    async ({ scope, settlementId }) => operations.getPmSettlement(await principalFor(scope.organizationId), { scope, settlementId }));
  register("preview_rental_bridge", "Preview the rental summary bridge for a legal entity and period from the rental ledger with explicit control totals (charges, receipts by tenant vs subsidy, deposits, credits, reversals). Preview only; nothing is posted.", { organizationId: organizationIdSchema, legalEntityId: legalEntityIdSchema, periodStart: isoDateSchema, periodEnd: isoDateSchema }, false,
    async args => operations.previewBridge(await principalFor(args.organizationId), args));
  register("list_accounting_payables", "List mirrored QuickBooks Bills or BillPayments (read-only) with vendor, dates, amount and open balance.", { scope: scopeInput, kind: z.enum(["bills", "payments"]).optional(), from: isoDateSchema.optional(), through: isoDateSchema.optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().min(1).max(512).optional() }, false,
    async args => {
      const scope = scopeInput.parse(args.scope);
      return operations.listPayables(await principalFor(scope.organizationId), { organizationId: scope.organizationId, legalEntityId: scope.legalEntityId, environment: scope.environment, realmId: scope.realmId, ...(args.kind ? { kind: args.kind } : {}), ...(args.from ? { from: args.from } : {}), ...(args.through ? { through: args.through } : {}), ...(args.limit ? { limit: args.limit } : {}), ...(args.cursor ? { cursor: args.cursor } : {}) });
    });
  const descriptions: Readonly<Record<RentalPostingCommandKind | PmSettlementCommandKind, string>> = {
    "accounting.rental_posting_policy.set": "Set the rental accounting method for a legal entity from a date (scope needs legalEntityId). Periods cannot overlap; native receivables require confirming QuickBooks invoice email is off; changing method needs an opening balance bridge reference.",
    "accounting.rental_posting_policy.close": "End a rental accounting method on a date so another can start. Requires expectedRevision.",
    "accounting.pm_settlement.create": "Record a property-manager statement: header totals and lines by kind. Lines must add up to each header total and held funds must roll forward. Saved in 5Central Ops only.",
    "accounting.pm_settlement.update": "Replace a draft or exception statement's header and lines (earlier line sets are kept). Requires expectedRevision.",
    "accounting.pm_settlement.reconcile": "Reconcile a statement; an owner remittance needs the bank deposit reference and date. Requires expectedRevision. Nothing is posted to QuickBooks.",
    "accounting.pm_settlement.exception.mark": "Mark a statement as an exception with a reason (reopens a reconciled statement). Requires expectedRevision.",
    "accounting.pm_settlement.exception.clear": "Return an exception statement to draft. Requires expectedRevision.",
  };
  for (const kind of [...RENTAL_POSTING_COMMAND_KINDS, ...PM_SETTLEMENT_COMMAND_KINDS]) {
    register(ACCOUNTING_OPERATION_MCP_TOOL_NAMES[kind], `${descriptions[kind]} Supply a stable operationId/idempotencyKey and retry an uncertain response with the identical envelope.`,
      { command: commandEnvelopeSchema(accountingOperationCommandPayloadSchemas[kind]) }, true,
      async ({ command }) => {
        const organizationId = organizationIdSchema.parse(command.scope.organizationId);
        return operations.execute(kind, command, { principal: await principalFor(organizationId), transport, resolvePrincipal: executor => principalFor(organizationId, executor) });
      });
  }
}
