import type { Express, RequestHandler } from "express";
import { z } from "zod";
import {
  commandEnvelopeSchema,
  companyScopeSchema,
  isoDateSchema,
  legalEntityIdSchema,
  organizationIdSchema,
  propertyReferenceIdSchema,
} from "../../shared/company";
import {
  INVESTOR_COMMAND_KINDS,
  investorCommandPayloadSchemas,
  investorListQuerySchema,
  investorPaymentLogQuerySchema,
} from "../../shared/investors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import { companyReadHandler, companyWebActor } from "../company/http";
import { ForbiddenCommandError } from "../company/commands/errors";
import type { InvestorPort } from "./port";

const readQuery = z.object({
  legalEntityId: legalEntityIdSchema.optional(),
  propertyId: propertyReferenceIdSchema.optional(),
  search: z.string().trim().max(200).optional(),
  status: z.enum(["active", "archived"]).optional(),
  instrumentKind: z.enum(["equity", "preferred_equity", "private_loan", "member_loan"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(512).optional(),
}).strict();

const monthlyQuery = z.object({
  legalEntityId: legalEntityIdSchema,
  propertyId: propertyReferenceIdSchema.optional(),
  accountId: z.string().optional(),
  instrumentId: z.string().optional(),
  fromMonth: isoDateSchema,
  throughMonth: isoDateSchema,
  status: z.enum(["expected", "partially_recorded", "manually_recorded", "partially_posted", "qbo_posted", "partially_settled", "bank_settled", "overpaid", "review_required", "reversed"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().trim().min(1).max(512).optional(),
}).strict();

/** Register investor HTTP reads and commands without changing root routes. */
export function registerInvestorRoutes(app: Express, options: { executor: RentOpsQueryExecutor; requireAdmin: RequestHandler; investors: InvestorPort }): void {
  const web = attestTransport("web");
  const { executor, requireAdmin, investors } = options;
  app.get("/api/company/:organizationId/investors/contacts", requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const actorId = companyWebActor(req);
    const principal = await loadAuthenticatedPrincipal(executor, { actorId, organizationId, role: "admin" });
    res.json(await investors.listContacts(principal, { scope: { organizationId }, search }));
  }));
  app.get("/api/company/:organizationId/investors", requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const query = readQuery.parse(req.query);
    const principal = await loadAuthenticatedPrincipal(executor, { actorId: companyWebActor(req), organizationId, role: "admin" });
    res.json(await investors.list(principal, investorListQuerySchema.parse({ ...query, scope: { organizationId, legalEntityId: query.legalEntityId, propertyId: query.propertyId } })));
  }));
  app.get("/api/company/:organizationId/investors/documents", requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const legalEntityId = legalEntityIdSchema.parse(req.query.legalEntityId);
    const propertyIds = typeof req.query.propertyIds === "string" ? req.query.propertyIds.split(",").filter(Boolean) : undefined;
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const principal = await loadAuthenticatedPrincipal(executor, { actorId: companyWebActor(req), organizationId, role: "admin" });
    res.json(await investors.listDocuments(principal, { scope: { organizationId, legalEntityId }, propertyIds, search }));
  }));
  app.get("/api/company/:organizationId/investors/sources", requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const legalEntityId = legalEntityIdSchema.parse(req.query.legalEntityId);
    const from = typeof req.query.from === "string" ? isoDateSchema.parse(req.query.from) : undefined;
    const through = typeof req.query.through === "string" ? isoDateSchema.parse(req.query.through) : undefined;
    const limit = req.query.limit === undefined ? 100 : z.coerce.number().int().min(1).max(500).parse(req.query.limit);
    const cursor = typeof req.query.cursor === "string" ? z.string().trim().min(1).max(512).parse(req.query.cursor) : undefined;
    const principal = await loadAuthenticatedPrincipal(executor, { actorId: companyWebActor(req), organizationId, role: "admin" });
    res.json(await investors.listFinancialSources(principal, { scope: { organizationId, legalEntityId }, from, through, limit, cursor }));
  }));
  app.get("/api/company/:organizationId/investors/:accountId", requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const scope = companyScopeSchema.parse({ organizationId, legalEntityId: req.query.legalEntityId, propertyId: req.query.propertyId });
    const principal = await loadAuthenticatedPrincipal(executor, { actorId: companyWebActor(req), organizationId, role: "admin" });
    res.json(await investors.get(principal, { scope, accountId: req.params.accountId }));
  }));
  app.get("/api/company/:organizationId/investor-payments", requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const query = monthlyQuery.parse(req.query);
    const principal = await loadAuthenticatedPrincipal(executor, { actorId: companyWebActor(req), organizationId, role: "admin" });
    const { legalEntityId, propertyId, ...queryFields } = query;
    res.json(await investors.monthlyPayments(principal, investorPaymentLogQuerySchema.parse({ ...queryFields, scope: { organizationId, legalEntityId, propertyId } })));
  }));
  app.post("/api/company/:organizationId/investor-commands/:commandKind", requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const kind = z.enum(INVESTOR_COMMAND_KINDS).parse(req.params.commandKind);
    const envelope = commandEnvelopeSchema(investorCommandPayloadSchemas[kind]).parse(req.body);
    if (envelope.scope.organizationId !== organizationId) throw new ForbiddenCommandError("Investor company does not match this request.");
    const actorId = companyWebActor(req);
    const resolvePrincipal = (transaction: RentOpsQueryExecutor) => loadAuthenticatedPrincipal(transaction, { actorId, organizationId, role: "admin" });
    const principal = await resolvePrincipal(executor);
    res.json(await investors.execute(kind, envelope, { principal, resolvePrincipal, transport: web }));
  }));
}
