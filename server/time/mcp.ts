import { z } from "zod";
import { commandEnvelopeSchema, organizationIdSchema, type CompanyScope } from "../../shared/company";
import { TIME_COMMAND_KINDS, timeCommandPayloadSchemas, timeConnectionScopeSchema, timeConnectionSetupScopeSchema, timeListQuerySchema, type TimeConnectionSetupScope } from "../../shared/time";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { attestTransport, authorizeCompanyRead, loadAuthenticatedPrincipal } from "../company/authorization";
import type { TimeServices } from "./service";

export type TimeToolRegistrar = (name: string, description: string, schema: z.ZodRawShape, write: boolean, handler: (args: any) => Promise<unknown>) => void;

const timeReadRoles = ["owner", "admin", "finance", "operations_pm", "project_manager", "read_only_reviewer"] as const;

export interface TimeMcpOptions {
  readonly executor: RentOpsQueryExecutor;
  readonly services: TimeServices;
  readonly actorId: string;
  readonly browserSetupUrl?: (scope: TimeConnectionSetupScope) => string;
}

/** MCP exposes the same scoped reads and company command runner as the browser. */
export function registerTimeMcpTools(register: TimeToolRegistrar, options: TimeMcpOptions): void {
  const { executor, services, actorId } = options;
  const transport = attestTransport("codex_mcp");
  const principalFor = (organizationId: string, connection = executor) => loadAuthenticatedPrincipal(connection, { actorId, organizationId, role: "admin" });
  const read = async <T>(scope: CompanyScope, work: (principal: Awaited<ReturnType<typeof principalFor>>) => Promise<T>): Promise<T> => {
    const principal = await principalFor(scope.organizationId);
    authorizeCompanyRead(principal, scope, timeReadRoles);
    return work(principal);
  };

  register("list_time_entries", "List scoped QuickBooks Time entries for admin review. Provider clock-in data, 5Central Ops approval, estimated labor and posted payroll remain separate states.", { query: timeListQuerySchema }, false,
    async ({ query }) => read(query.scope, principal => services.read.listEntries(principal, query)));
  register("list_time_connections", "List named QuickBooks Time connections for a legal entity. Connection credentials and tokens are never returned.", { organizationId: organizationIdSchema, legalEntityId: timeConnectionScopeSchema.shape.legalEntityId, environment: timeConnectionScopeSchema.shape.environment.optional() }, false,
    async ({ organizationId, legalEntityId, environment }) => read({ organizationId, legalEntityId }, principal => services.read.listConnections(principal, { organizationId, legalEntityId, environment })));
  register("list_time_users", "List the provider employee roster and submitted or approved-through dates used to interpret locked time.", { scope: timeConnectionScopeSchema }, false,
    async ({ scope }) => read(scope, principal => services.read.listUsers(principal, scope)));
  register("list_time_jobcodes", "List provider jobcodes available for project and property mapping.", { scope: timeConnectionScopeSchema }, false,
    async ({ scope }) => read(scope, principal => services.read.listJobcodes(principal, scope)));
  register("list_time_employee_mappings", "List scoped provider employee to company-contact mappings and optional exact hourly rate assumptions.", { scope: timeConnectionScopeSchema }, false,
    async ({ scope }) => read(scope, principal => services.read.listEmployeeMappings(principal, scope)));
  register("list_time_jobcode_mappings", "List scoped provider jobcode mappings to properties, projects and cost codes.", { scope: timeConnectionScopeSchema }, false,
    async ({ scope }) => read(scope, principal => services.read.listJobcodeMappings(principal, scope)));
  register("list_time_payroll_links", "List posted payroll links for a legal entity: the QBO payroll or journal line, pay period, amount, linked timesheets, and whether the link is active or released.", { organizationId: organizationIdSchema, legalEntityId: timeConnectionScopeSchema.shape.legalEntityId }, false,
    async ({ organizationId, legalEntityId }) => read({ organizationId, legalEntityId }, async principal => ({ items: await services.read.listPayrollLinks(principal, { organizationId, legalEntityId }) })));
  register("get_time_coverage", "Read provider synchronization coverage, modified-since watermarks, pagination status and deletion-stream completeness.", { scope: timeConnectionScopeSchema }, false,
    async ({ scope }) => read(scope, principal => services.read.readCoverage(principal, scope)));
  register("sync_time_records", "Mirror provider users, jobcodes, timesheets and deletion tombstones into 5Central Ops. This does not write back to QuickBooks Time or post payroll.", { scope: timeConnectionScopeSchema, maxPages: z.number().int().min(1).max(10_000).optional() }, true,
    async ({ scope, maxPages }) => read(scope, () => services.sync.sync(scope, { maxPages })));
  register("begin_quickbooks_time_connect", "Return a scoped browser setup link for the separate QuickBooks Time connection. OAuth state stays bound to the initiating browser session and cannot be completed through MCP.", { scope: timeConnectionSetupScopeSchema }, true,
    async ({ scope }) => {
      const principal = await principalFor(scope.organizationId);
      authorizeCompanyRead(principal, scope, ["owner", "admin", "finance"]);
      if (services.qbt.status !== "configured") throw new Error("QuickBooks Time is not configured");
      const provider = scope.providerCompanyId === undefined ? "" : `&providerCompanyId=${encodeURIComponent(scope.providerCompanyId)}`;
      return { status: "browser_required" as const, scope, setupUrl: options.browserSetupUrl?.(scope) ?? `/ops?section=time&company=${encodeURIComponent(scope.organizationId)}&entity=${encodeURIComponent(scope.legalEntityId)}${provider}` };
    });
  for (const kind of TIME_COMMAND_KINDS) {
    register(kind.replaceAll(".", "_"), `Save ${kind.replaceAll(".", " ")} in 5Central Ops. Supply a stable operationId/idempotencyKey and retry an uncertain response with the identical envelope. This does not alter QuickBooks Time or post payroll.`, { command: commandEnvelopeSchema(timeCommandPayloadSchemas[kind]) }, true,
      async ({ command }) => {
        const organizationId = organizationIdSchema.parse(command.scope.organizationId);
        const principal = await principalFor(organizationId);
        return services.commands.execute(kind, command, { principal, resolvePrincipal: (transaction: RentOpsQueryExecutor) => principalFor(organizationId, transaction), transport });
      });
  }
}
