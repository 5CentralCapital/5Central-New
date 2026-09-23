import { commandEnvelopeSchema, companyScopeSchema, type CommandEnvelope, type CompanyScope, type OperationReceipt } from "../../shared/company";
import { TIME_COMMAND_KINDS, timeCommandPayloadSchemas, timeConnectionScopeSchema, type TimeCommandKind, type TimeCommandPort, type TimeConnectionScope, type TimeSyncPort, type TimeConnectionSummary, type TimeCoverage, type TimeEntry, type TimeEmployeeMapping, type TimeJobcode, type TimeJobcodeMapping, type TimeListQuery, type TimeUser } from "../../shared/time";
import { authorizeCompanyRead, loadAuthenticatedPrincipal, type AuthenticatedPrincipal, type CommandAuthorizationPolicy, type TransportAttestation } from "../company/authorization";
import { runCompanyCommand } from "../company/commands/runner";
import { ValidationCommandError } from "../company/commands/errors";
import { AccountingError } from "../accounting/errors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { createQuickBooksTimeClient, createQuickBooksTimeFetchTransport, createQuickBooksTimeOAuthClient, type QuickBooksTimeClient, type QuickBooksTimeOAuthClient, type TimeTransport } from "./provider";
import { createTimeOAuthConnectionService, PostgresTimeOAuthStateStore, type TimeOAuthConnectionService, type TimeOAuthStateStore } from "./oauth-state";
import { createConfiguredTimeTokenCipher, type TimeTokenCipher } from "./token-crypto";
import { createTimeTokenRepository, type TimeTokenRepository } from "./connection-store";
import { newTimeRefreshLeaseOwner, PostgresTimeRefreshLease, type TimeRefreshLease } from "./refresh-lease";
import { createTimeStore, type TimeStore } from "./store";
import { createTimeSyncService } from "./sync";
import { linkPayroll, listPayrollLinks, readProjectLabor, unlinkPayroll } from "./labor";
import type { ProjectExecutionFinancePorts } from "../projects/execution-commands";
import { timePayrollLinkPayloadSchema, timePayrollUnlinkPayloadSchema, type ProjectLaborResponse, type TimePayrollLink } from "../../shared/time";

const TIME_WRITE_ROLES = ["owner", "admin", "finance", "operations_pm", "project_manager"] as const;
const TIME_READ_ROLES = ["owner", "admin", "finance", "operations_pm", "project_manager", "read_only_reviewer"] as const;
const TIME_PAYROLL_ROLES = ["owner", "admin", "finance"] as const;
export const TIME_COMMAND_POLICIES: Readonly<Record<TimeCommandKind, CommandAuthorizationPolicy>> = Object.freeze({
  "time.review_timesheet": { commandKind: "time.review_timesheet", allowedRoles: TIME_WRITE_ROLES },
  "time.correct_timesheet": { commandKind: "time.correct_timesheet", allowedRoles: TIME_WRITE_ROLES },
  "time.map_employee": { commandKind: "time.map_employee", allowedRoles: TIME_WRITE_ROLES },
  "time.map_jobcode": { commandKind: "time.map_jobcode", allowedRoles: TIME_WRITE_ROLES },
  "time.payroll.link": { commandKind: "time.payroll.link", allowedRoles: TIME_PAYROLL_ROLES },
  "time.payroll.unlink": { commandKind: "time.payroll.unlink", allowedRoles: TIME_PAYROLL_ROLES },
} satisfies Record<TimeCommandKind, CommandAuthorizationPolicy>);

export interface TimeCommandAccess { readonly principal: AuthenticatedPrincipal; readonly resolvePrincipal: (executor: RentOpsQueryExecutor) => Promise<AuthenticatedPrincipal>; readonly transport: TransportAttestation; }
export interface TimeServicesOptions {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly redirectUri?: string;
  readonly environment?: "sandbox" | "production";
  readonly transport?: TimeTransport;
  readonly client?: QuickBooksTimeClient;
  readonly getAccessToken?: (scope: TimeConnectionScope) => Promise<string>;
  readonly tokenCipher?: TimeTokenCipher;
  readonly tokenRepository?: TimeTokenRepository;
  readonly refreshLease?: TimeRefreshLease;
  readonly refreshLeaseOwnerId?: string;
  readonly refreshLeaseTtlMs?: number;
  readonly oauthStateStore?: TimeOAuthStateStore;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  /** Transaction-bound QBO mirror ports used to verify and reserve posted payroll lines. */
  readonly financeFactory?: (executor: RentOpsQueryExecutor) => ProjectExecutionFinancePorts;
}
export interface ConfiguredTimeServices { readonly status: "configured"; readonly environment: "sandbox" | "production"; readonly client: QuickBooksTimeClient; readonly oauth: QuickBooksTimeOAuthClient; readonly oauthConnection: TimeOAuthConnectionService; readonly tokenRepository: TimeTokenRepository; readonly refreshLease: TimeRefreshLease; readonly sync: TimeSyncPort; readonly getAccessToken: (scope: TimeConnectionScope) => Promise<string>; }
export interface UnconfiguredTimeServices { readonly status: "unconfigured"; readonly reason: "missing_configuration" | "invalid_configuration"; }
export interface TimeServices {
  readonly read: TimeReadPort;
  readonly store: TimeStore;
  readonly commands: TimeCommandPort;
  readonly sync: TimeSyncPort;
  readonly qbt: ConfiguredTimeServices | UnconfiguredTimeServices;
}

/**
 * Authenticated reads are deliberately separate from the persistence store.
 * Each call reopens a read-only transaction, reloads active grants, and runs
 * the query through that transaction so a revoked grant cannot be used after
 * the adapter's initial identity lookup.
 */
export interface TimeReadPort {
  listEntries(principal: AuthenticatedPrincipal, input: TimeListQuery): Promise<{ items: readonly TimeEntry[]; nextCursor: string | null; coverage: readonly TimeCoverage[] }>;
  listUsers(principal: AuthenticatedPrincipal, scope: TimeConnectionScope): Promise<readonly TimeUser[]>;
  listJobcodes(principal: AuthenticatedPrincipal, scope: TimeConnectionScope): Promise<readonly TimeJobcode[]>;
  listEmployeeMappings(principal: AuthenticatedPrincipal, scope: TimeConnectionScope): Promise<readonly TimeEmployeeMapping[]>;
  listJobcodeMappings(principal: AuthenticatedPrincipal, scope: TimeConnectionScope): Promise<readonly TimeJobcodeMapping[]>;
  readCoverage(principal: AuthenticatedPrincipal, scope: TimeConnectionScope): Promise<readonly TimeCoverage[]>;
  listConnections(principal: AuthenticatedPrincipal, scope: { readonly organizationId: TimeConnectionScope["organizationId"]; readonly legalEntityId: TimeConnectionScope["legalEntityId"]; readonly environment?: TimeConnectionScope["environment"] }): Promise<readonly TimeConnectionSummary[]>;
  listPayrollLinks(principal: AuthenticatedPrincipal, scope: CompanyScope & { readonly legalEntityId: string }): Promise<readonly TimePayrollLink[]>;
  /** Approved time mapped to one project through jobcode mappings, with its labor basis. */
  projectLabor(principal: AuthenticatedPrincipal, input: { readonly scope: CompanyScope; readonly projectId: string }): Promise<ProjectLaborResponse>;
}

function createScopedTimeReadPort(executor: RentOpsQueryExecutor, store: TimeStore, openReadTransaction: boolean): TimeReadPort {
  async function inReadTransaction<T>(principal: AuthenticatedPrincipal, scope: CompanyScope, work: (transactionStore: TimeStore) => Promise<T>): Promise<T> {
    const read = async (transaction: RentOpsQueryExecutor): Promise<T> => {
      const fresh = await loadAuthenticatedPrincipal(transaction, { actorId: principal.actorId, organizationId: principal.organizationId, role: principal.role });
      authorizeCompanyRead(fresh, scope, TIME_READ_ROLES);
      return work(store.forExecutor(transaction));
    };
    if (!openReadTransaction) return read(executor);
    if (typeof executor.transaction !== "function") throw new AccountingError("accounting_configuration", "Time reads require transaction support");
    return executor.transaction(read, { readOnly: true });
  }
  return {
    listEntries: (principal, input) => inReadTransaction(principal, input.scope, transactionStore => transactionStore.listEntries(input)),
    listUsers: (principal, scope) => inReadTransaction(principal, scope, transactionStore => transactionStore.listUsers(scope)),
    listJobcodes: (principal, scope) => inReadTransaction(principal, scope, transactionStore => transactionStore.listJobcodes(scope)),
    listEmployeeMappings: (principal, scope) => inReadTransaction(principal, scope, transactionStore => transactionStore.listEmployeeMappings(scope)),
    listJobcodeMappings: (principal, scope) => inReadTransaction(principal, scope, transactionStore => transactionStore.listJobcodeMappings(scope)),
    readCoverage: (principal, scope) => inReadTransaction(principal, scope, transactionStore => transactionStore.readCoverage(scope)),
    listConnections: (principal, scope) => inReadTransaction(principal, scope, transactionStore => transactionStore.listConnections(scope)),
    listPayrollLinks: (principal, scope) => inReadTransaction(principal, scope, transactionStore => listPayrollLinks(transactionStore.executorForRead(), scope)),
    projectLabor: (principal, input) => inReadTransaction(principal, input.scope, async transactionStore => {
      const reader = transactionStore.executorForRead();
      const project = await reader.query<{ legal_entity_id: string; property_id: string }>(`SELECT legal_entity_id, property_id FROM company_projects WHERE organization_id=$1 AND id=$2`, [input.scope.organizationId, input.projectId]);
      const row = project.rows[0];
      if (!row || (input.scope.legalEntityId && row.legal_entity_id !== input.scope.legalEntityId) || (input.scope.propertyId && row.property_id !== input.scope.propertyId)) throw new ValidationCommandError("Project was not found in the requested company scope", { reason: "project_not_found" });
      const scopeItems = await reader.query<{ id: string }>(`SELECT id FROM company_project_scope_items WHERE organization_id=$1 AND project_id=$2`, [input.scope.organizationId, input.projectId]);
      return readProjectLabor(reader, { organizationId: input.scope.organizationId, projectId: input.projectId, scopeItemIds: scopeItems.rows.map(item => String(item.id)) });
    }),
  };
}

function createTimeReadPort(executor: RentOpsQueryExecutor, store: TimeStore): TimeReadPort {
  return createScopedTimeReadPort(executor, store, true);
}

/**
 * Build a read port for a caller that already owns a company transaction.
 * Each method reloads the supplied principal's active grant inside that
 * transaction before reading. This factory never opens a nested transaction;
 * it is intended for reporting and other transaction-bound internal callers.
 */
export function createTransactionBoundTimeReadPort(executor: RentOpsQueryExecutor, now: () => Date = () => new Date()): TimeReadPort {
  return createScopedTimeReadPort(executor, createTimeStore(executor, now), false);
}

function configured(options: TimeServicesOptions): { clientId: string; clientSecret: string; redirectUri: string; environment: "sandbox" | "production" } | null {
  const env = options.env ?? process.env;
  const clientId = options.clientId ?? env.QBO_TIME_CLIENT_ID;
  const clientSecret = options.clientSecret ?? env.QBO_TIME_CLIENT_SECRET;
  const redirectUri = options.redirectUri ?? env.QBO_TIME_REDIRECT_URI;
  const environment = options.environment ?? (env.QBO_TIME_ENVIRONMENT === "production" ? "production" : env.QBO_TIME_ENVIRONMENT === "sandbox" ? "sandbox" : undefined);
  return clientId && clientSecret && redirectUri && environment ? { clientId, clientSecret, redirectUri, environment } : null;
}

export function createTimeServices(executor: RentOpsQueryExecutor, options: TimeServicesOptions = {}): TimeServices {
  const now = options.now ?? (() => new Date()); const store = createTimeStore(executor, now); const read = createTimeReadPort(executor, store);
  const commands: TimeCommandPort = { execute: (kind, envelope, access) => executeTimeCommand(executor, store, kind, envelope, access, options.financeFactory) };
  const config = configured(options);
  if (!config) {
    const unavailable: TimeSyncPort = { async sync() { throw new ValidationCommandError("QuickBooks Time is not configured", { reason: "time_unconfigured" }); } };
    return { read, store, commands, sync: unavailable, qbt: { status: "unconfigured", reason: "missing_configuration" } };
  }
  try {
    const transport = options.transport ?? createQuickBooksTimeFetchTransport();
    const client = options.client ?? createQuickBooksTimeClient(transport);
    const oauth = createQuickBooksTimeOAuthClient(transport, now);
    const tokenRepository = options.tokenRepository ?? createTimeTokenRepository(executor, options.tokenCipher ?? createConfiguredTimeTokenCipher(options.env ?? process.env), now);
    const refreshLease = options.refreshLease ?? new PostgresTimeRefreshLease(executor, now);
    const refreshLeaseOwnerPrefix = options.refreshLeaseOwnerId ?? "rops-time";
    const refreshLeaseTtlMs = options.refreshLeaseTtlMs ?? 120_000;
    if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(refreshLeaseOwnerPrefix) || !Number.isSafeInteger(refreshLeaseTtlMs) || refreshLeaseTtlMs < 1_000 || refreshLeaseTtlMs > 10 * 60_000) throw new AccountingError("accounting_configuration", "QuickBooks Time refresh lease configuration is invalid");
    if (!options.getAccessToken && typeof tokenRepository.saveWithLease !== "function") throw new AccountingError("accounting_configuration", "QuickBooks Time token rotation does not have fenced persistence");
    const getAccessToken = options.getAccessToken ?? (async (scope: TimeConnectionScope): Promise<string> => {
      const refreshLeaseOwnerId = newTimeRefreshLeaseOwner(refreshLeaseOwnerPrefix);
      const tokenIsUsable = (value: { readonly accessToken: string; readonly accessTokenExpiresAt: string }): boolean => {
        const expiresAt = Date.parse(value.accessTokenExpiresAt);
        if (!Number.isFinite(expiresAt)) throw new AccountingError("accounting_unavailable", "QuickBooks Time connection expiry could not be confirmed");
        return expiresAt > now().getTime() + 30_000;
      };
      const refreshIsUsable = (value: { readonly refreshTokenExpiresAt?: string }): void => {
        if (!value.refreshTokenExpiresAt) return;
        const expiresAt = Date.parse(value.refreshTokenExpiresAt);
        if (!Number.isFinite(expiresAt)) throw new AccountingError("accounting_unavailable", "QuickBooks Time refresh expiry could not be confirmed");
        if (expiresAt <= now().getTime()) throw new AccountingError("accounting_conflict", "QuickBooks Time refresh token has expired; reconnect is required", { reason: "time_refresh_expired" });
      };
      const wait = async (): Promise<void> => new Promise(resolve => setTimeout(resolve, 50));
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const token = await tokenRepository.load(scope);
        if (!token) throw new AccountingError("accounting_configuration", "QuickBooks Time connection is not established");
        if (tokenIsUsable(token)) return token.accessToken;
        refreshIsUsable(token);
        const leaseHeld = await refreshLease.acquire(scope, refreshLeaseOwnerId, refreshLeaseTtlMs);
        if (!leaseHeld) { await wait(); continue; }
        try {
          // Re-read after acquiring the durable lease. A worker may have
          // committed a rotation just before this worker acquired an expired lease.
          const latest = await tokenRepository.load(scope);
          if (!latest) throw new AccountingError("accounting_configuration", "QuickBooks Time connection is not established");
          if (tokenIsUsable(latest)) return latest.accessToken;
          refreshIsUsable(latest);
          const rotated = await oauth.refresh({ clientId: config.clientId, clientSecret: config.clientSecret, refreshToken: latest.refreshToken });
          if (rotated.providerCompanyId !== undefined && rotated.providerCompanyId !== scope.providerCompanyId) throw new AccountingError("accounting_conflict", "QuickBooks Time refresh returned a different company identity");
          try {
            const saved = await tokenRepository.saveWithLease!(scope, rotated, latest.version, refreshLeaseOwnerId);
            return saved.accessToken;
          } catch (error) {
            // A worker that lost the fence may still use the winner's committed token.
            const winner = await tokenRepository.load(scope);
            if (winner && tokenIsUsable(winner)) return winner.accessToken;
            throw error;
          }
        } finally {
          try {
            await refreshLease.release(scope, refreshLeaseOwnerId);
          } catch {
            // A committed token remains usable; lease expiry recovers a worker
            // whose release was interrupted.
          }
        }
      }
      throw new AccountingError("accounting_conflict", "QuickBooks Time token refresh is already in progress", { reason: "time_refresh_in_progress" });
    });
    const oauthConnection = createTimeOAuthConnectionService({
      oauth,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
      stateStore: options.oauthStateStore ?? new PostgresTimeOAuthStateStore(executor),
      tokenRepository,
      now,
    });
    const sync = createTimeSyncService({ executor, client, getAccessToken, now, store });
    return { read, store, commands, sync, qbt: { status: "configured", environment: config.environment, client, oauth, oauthConnection, tokenRepository, refreshLease, sync, getAccessToken } };
  } catch {
    return { read, store, commands, sync: { async sync() { throw new ValidationCommandError("QuickBooks Time configuration is invalid", { reason: "time_invalid_configuration" }); } }, qbt: { status: "unconfigured", reason: "invalid_configuration" } };
  }
}

async function executeTimeCommand(executor: RentOpsQueryExecutor, store: TimeStore, kindInput: TimeCommandKind, envelopeInput: unknown, accessInput: unknown, financeFactory?: (executor: RentOpsQueryExecutor) => ProjectExecutionFinancePorts): Promise<OperationReceipt> {
  const kind = TIME_COMMAND_KINDS.includes(kindInput) ? kindInput : (() => { throw new ValidationCommandError("Unsupported time command", { reason: "unsupported_time_command" }); })();
  const access = accessInput as TimeCommandAccess; if (!access || !access.principal || typeof access.resolvePrincipal !== "function" || !access.transport) throw new ValidationCommandError("Time command authentication is unavailable", { reason: "time_authentication_required" });
  const envelope = commandEnvelopeSchema(timeCommandPayloadSchemas[kind]).parse(envelopeInput) as CommandEnvelope<Record<string, unknown>>;
  return runCompanyCommand(executor, { envelope, principal: access.principal, resolvePrincipal: access.resolvePrincipal, transport: access.transport, policy: TIME_COMMAND_POLICIES[kind], handler: async context => {
    const payload = envelope.payload as Record<string, unknown>; const baseScope = companyScopeSchema.parse(envelope.scope); const providerCompanyId = typeof payload.providerCompanyId === "string" ? payload.providerCompanyId : (() => { throw new ValidationCommandError("Provider company is required", { reason: "time_provider_company_required" }); })(); const environment = typeof payload.environment === "string" ? payload.environment : (() => { throw new ValidationCommandError("Provider environment is required", { reason: "time_provider_environment_required" }); })(); const scope = timeConnectionScopeSchema.parse({ ...baseScope, environment, providerCompanyId }); const txStore = store.forExecutor(context.executor);
    if (kind === "time.payroll.link" || kind === "time.payroll.unlink") {
      const payrollContext = { executor: context.executor, scope, actorId: context.principal.actorId, effectiveDate: envelope.effectiveDate ?? new Date().toISOString().slice(0, 10), finance: financeFactory?.(context.executor) };
      const result = kind === "time.payroll.link"
        ? await linkPayroll(payrollContext, timePayrollLinkPayloadSchema.parse(payload))
        : await unlinkPayroll(payrollContext, timePayrollUnlinkPayloadSchema.parse(payload));
      return { state: "saved_in_rops", affectedRecordIds: [result.batchId, ...result.timesheetIds], resultingRevisions: [], validationOutcomes: [{ code: kind === "time.payroll.link" ? "time.payroll_linked" : "time.payroll_unlinked", severity: "info", message: kind === "time.payroll.link" ? "Posted payroll linked to approved time. Labor estimates for this time are replaced by the posted amount." : "Posted payroll link released. Labor returns to its estimate." }] };
    }
    if (kind === "time.correct_timesheet") {
      const result = await txStore.correctTimesheet({ scope, timesheetId: String(payload.timesheetId), expectedCorrectionRevision: payload.expectedCorrectionRevision as number | undefined, type: payload.type as "regular" | "manual", start: payload.start as string | null, end: payload.end as string | null, date: String(payload.date), durationSeconds: Number(payload.durationSeconds), timezoneOffsetMinutes: payload.timezoneOffsetMinutes as number | null, timezoneName: payload.timezoneName as string | null, notes: String(payload.notes), reason: String(payload.reason), actorId: context.principal.actorId, operationId: envelope.operationId });
      return { state: "saved_in_rops", affectedRecordIds: [result.id], resultingRevisions: [], validationOutcomes: [{ code: "time.corrected", severity: "info", message: "Time entry correction saved in R-ops" }] };
    }
    if (kind === "time.review_timesheet") {
      const result = await txStore.reviewTimesheet({ scope, timesheetId: String(payload.timesheetId), action: payload.action as "approve" | "reject" | "request_review", reason: payload.reason as string | undefined, actorId: context.principal.actorId, operationId: envelope.operationId });
      return { state: "saved_in_rops", affectedRecordIds: [result.id], resultingRevisions: [], validationOutcomes: [{ code: `time.${String(payload.action)}`, severity: "info", message: "Time entry review state saved in R-ops" }] };
    }
    if (kind === "time.map_employee") {
      const result = await txStore.mapEmployee({ scope, providerUserId: String(payload.providerUserId), contactId: String(payload.contactId), effectiveFrom: String(payload.effectiveFrom), effectiveTo: payload.effectiveTo as string | null | undefined, hourlyRateCents: payload.hourlyRateCents as string | null | undefined, currency: payload.currency as string | null | undefined, actorId: context.principal.actorId, operationId: envelope.operationId });
      return { state: "saved_in_rops", affectedRecordIds: [result.id], resultingRevisions: [], validationOutcomes: [{ code: "time.employee_mapped", severity: "info", message: "Employee mapping saved in R-ops" }] };
    }
    const result = await txStore.mapJobcode({ scope, providerJobcodeId: String(payload.providerJobcodeId), propertyId: payload.propertyId as string | null | undefined, projectId: payload.projectId as string | null | undefined, costCode: payload.costCode as string | null | undefined, actorId: context.principal.actorId, operationId: envelope.operationId });
    return { state: "saved_in_rops", affectedRecordIds: [result.id], resultingRevisions: [], validationOutcomes: [{ code: "time.jobcode_mapped", severity: "info", message: "Jobcode mapping saved in R-ops" }] };
  } });
}
