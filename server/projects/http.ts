import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { companyScopeSchema, isoDateSchema, legalEntityIdSchema, organizationIdSchema, propertyReferenceIdSchema } from "../../shared/company";
import { costSourceLinePurposeSchema, costSourceLineQuerySchema } from "../../shared/projects/source-lines";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { loadAuthenticatedPrincipal } from "../company/authorization";
import { companyReadHandler, companyWebActor } from "../company/http";
import type { ProjectInsightsPort } from "./insights";

const scopeQuery = z.object({
  legalEntityId: legalEntityIdSchema.optional(),
  propertyId: propertyReferenceIdSchema.optional(),
  asOf: isoDateSchema.optional(),
}).strict();

const sourceLineQuery = z.object({
  legalEntityId: legalEntityIdSchema,
  purpose: costSourceLinePurposeSchema.default("cost"),
  search: z.string().trim().max(200).optional(),
  from: isoDateSchema.optional(),
  through: isoDateSchema.optional(),
  availableOnly: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(512).optional(),
}).strict();

/** Project cost report, labor allocation and QBO line picker reads for the web workspace. */
export function registerProjectInsightRoutes(app: Express, options: { executor: RentOpsQueryExecutor; requireAdmin: RequestHandler; insights: ProjectInsightsPort }): void {
  const { executor, requireAdmin, insights } = options;
  const principalFor = (actorId: string, organizationId: string) => loadAuthenticatedPrincipal(executor, { actorId, organizationId, role: "admin" });
  app.get("/api/company/:organizationId/projects/:projectId/cost-report", requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const { legalEntityId, propertyId, asOf } = scopeQuery.parse(req.query);
    const principal = await principalFor(companyWebActor(req), organizationId);
    res.json(await insights.costReport(principal, { scope: companyScopeSchema.parse({ organizationId, legalEntityId, propertyId }), projectId: z.string().uuid().parse(req.params.projectId), asOf }));
  }));
  app.get("/api/company/:organizationId/projects/:projectId/labor", requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const { legalEntityId, propertyId } = scopeQuery.parse(req.query);
    const principal = await principalFor(companyWebActor(req), organizationId);
    res.json(await insights.labor(principal, { scope: companyScopeSchema.parse({ organizationId, legalEntityId, propertyId }), projectId: z.string().uuid().parse(req.params.projectId) }));
  }));
  app.get("/api/company/:organizationId/cost-source-lines", requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const { availableOnly, ...query } = sourceLineQuery.parse(req.query);
    const principal = await principalFor(companyWebActor(req), organizationId);
    res.json(await insights.costSourceLines(principal, costSourceLineQuerySchema.parse({ ...query, organizationId, ...(availableOnly ? { availableOnly: availableOnly === "true" } : {}) })));
  }));
}
