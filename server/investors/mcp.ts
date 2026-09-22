import { z } from "zod";
import { commandEnvelopeSchema, companyScopeSchema, isoDateSchema, organizationIdSchema } from "../../shared/company";
import {
  INVESTOR_COMMAND_KINDS,
  investorCommandPayloadSchemas,
  investorListQuerySchema,
  investorPaymentLogQuerySchema,
} from "../../shared/investors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import type { InvestorPort } from "./port";

export type InvestorToolRegistrar = (name: string, description: string, schema: z.ZodRawShape, write: boolean, handler: (args: any) => Promise<unknown>) => void;

/** Register the same investor port for Codex without a second mutation path. */
export function registerInvestorMcpTools(register: InvestorToolRegistrar, options: { executor: RentOpsQueryExecutor; investors: InvestorPort; actorId: string }): void {
  const { executor, investors, actorId } = options;
  const transport = attestTransport("codex_mcp");
  const principalFor = (organizationId: string, connection = executor) => loadAuthenticatedPrincipal(connection, { actorId, organizationId, role: "admin" });
  register("list_investors", "List scoped investor accounts with committed, verified funded, returned, and next-obligation rollups.", { query: investorListQuerySchema }, false,
    async ({ query }) => investors.list(await principalFor(query.scope.organizationId), query));
  register("list_investor_contacts", "List existing company contacts that can be linked to an investor account.", { scope: companyScopeSchema, search: z.string().trim().max(200).optional() }, false,
    async ({ scope, search }) => investors.listContacts(await principalFor(scope.organizationId), { scope, search }));
  register("list_investor_documents", "List existing authorized documents by legal entity or property for controlled investor contract references.", { scope: companyScopeSchema, propertyIds: z.array(z.string()).max(100).optional(), search: z.string().trim().max(200).optional() }, false,
    async ({ scope, propertyIds, search }) => investors.listDocuments(await principalFor(scope.organizationId), { scope, propertyIds, search }));
  register("list_investor_financial_sources", "List current posted QBO source lines available for scoped investor payment linking, with an opaque cursor when more lines remain.", { scope: companyScopeSchema, from: isoDateSchema.optional(), through: isoDateSchema.optional(), limit: z.number().int().min(1).max(500).optional(), cursor: z.string().trim().min(1).max(512).optional() }, false,
    async ({ scope, from, through, limit, cursor }) => investors.listFinancialSources(await principalFor(scope.organizationId), { scope: { ...scope, legalEntityId: scope.legalEntityId! }, from, through, limit, cursor }));
  register("get_investor", "Read one scoped investor account, ownership instruments, versioned contracts, debt, monthly obligations, payments, and activity.", { scope: companyScopeSchema, accountId: z.string() }, false,
    async args => investors.get(await principalFor(args.scope.organizationId), args));
  register("list_investor_monthly_payments", "Read expected, manual, verified QBO-posted, independently settled, partial, overpaid, and reversed monthly rows.", { query: investorPaymentLogQuerySchema }, false,
    async ({ query }) => investors.monthlyPayments(await principalFor(query.scope.organizationId), query));
  for (const kind of INVESTOR_COMMAND_KINDS) {
    register(kind.replaceAll(".", "_"), `Save ${kind.replaceAll(".", " ")} in R-ops. Supply a stable operationId/idempotencyKey and the current revision for edits. QBO and settlement links remain fail closed until verified source evidence is available.`, { command: commandEnvelopeSchema(investorCommandPayloadSchemas[kind]) }, true,
      async ({ command }) => {
        const organizationId = organizationIdSchema.parse(command.scope.organizationId);
        const principal = await principalFor(organizationId);
        return investors.execute(kind, command, { principal, resolvePrincipal: transaction => principalFor(organizationId, transaction), transport });
      });
  }
}
