import { z } from "zod";
import { ACCOUNTING_PURPOSE_COMMAND_KINDS, accountingPurposeCommandPayloadSchemas } from "../../shared/accounting";
import { legalEntityIdSchema, organizationIdSchema } from "../../shared/company";
import type { CommandRole } from "../../shared/company";
import { commandEnvelopeSchema } from "../../shared/company";
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
  register("list_accounting_purpose_mappings", "List dated, reviewed QBO Account purpose mappings for an authorized legal entity and realm. A mapping is effective only while its exact mirrored Account revision remains current.", { scope: scopeInput, providerAccountId: z.string().trim().min(1).max(200).optional() }, false, async (args) => {
    const scope = scopeInput.parse(args.scope);
    return readAuthorized(scope, executor => options.services.purposeMappings.forExecutor(executor).listPurposeMappings(scope, args.providerAccountId));
  });
  register("list_accounting_transactions", "List exact mirrored QBO source lines with coverage evidence and pagination.", { scope: scopeInput, from: z.string().date().optional(), through: z.string().date().optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().min(1).max(512).optional() }, false, async (args) => {
    const scope = scopeInput.parse(args.scope);
    return readAuthorized(scope, executor => options.services.mirror.forExecutor(executor).listTransactions({ scope, from: args.from, through: args.through, limit: args.limit, cursor: args.cursor }));
  });
  register("sync_accounting_source", "Run a read-only CompanyInfo probe and source mirror catch-up for an authorized QBO connection.", { scope: scopeInput, maxPages: z.number().int().min(1).max(100).optional() }, true, async (args) => {
    const scope = scopeInput.parse(args.scope);
    const principal = await principalFor(scope.organizationId);
    authorizeCompanyRead(principal, { organizationId: scope.organizationId, legalEntityId: scope.legalEntityId }, ["owner", "admin", "finance"]);
    if (options.services.qbo.status !== "configured") throw new AccountingError("accounting_configuration", "QuickBooks is not configured");
    if (scope.environment !== options.services.qbo.environment) throw new AccountingError("accounting_conflict", "The requested QuickBooks environment is not configured for this server");
    const sync = options.services.qbo.createProviderSync(scope);
    await sync.bootstrapRead();
    return sync.catchUp({ maxPages: args.maxPages });
  });
  for (const kind of ACCOUNTING_PURPOSE_COMMAND_KINDS) {
    register(kind.replaceAll(".", "_"), "Map one exact mirrored Other Current Asset Account to capitalized cost for a dated period. Supply its current Account revision, review evidence, legal-entity command scope, and a stable operationId/idempotencyKey; this changes only R-ops mapping metadata and never QuickBooks.", { command: commandEnvelopeSchema(accountingPurposeCommandPayloadSchemas[kind]) }, true, async ({ command }) => {
      const organizationId = organizationIdSchema.parse(command.scope.organizationId);
      const principal = await principalFor(organizationId);
      return options.services.purposeCommands.execute(kind, command, { principal, resolvePrincipal: transaction => principalFor(organizationId, transaction), transport });
    });
  }
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
}
