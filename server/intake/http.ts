import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { companyScopeSchema, legalEntityIdSchema, organizationIdSchema, propertyReferenceIdSchema, recordReferenceIdSchema } from "../../shared/company";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { loadAuthenticatedPrincipal } from "../company/authorization";
import { companyReadHandler, companyWebActor } from "../company/http";
import type { IntakePort } from "./port";

const listQuery = z.object({
  legalEntityId: legalEntityIdSchema.optional(),
  propertyId: propertyReferenceIdSchema.optional(),
  cursor: z.string().trim().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

const scopeQuery = z.object({
  legalEntityId: legalEntityIdSchema.optional(),
  propertyId: propertyReferenceIdSchema.optional(),
}).strict();

/**
 * Browser routes are read-only. MRA upload, mapping, preview and apply are
 * Codex-only (see ./mcp.ts); there is deliberately no web mutation route.
 */
export function registerIntakeRoutes(app: Express, options: { executor: RentOpsQueryExecutor; requireAdmin: RequestHandler; intake: IntakePort }): void {
  const { executor, requireAdmin, intake } = options;
  const principalFor = (actorId: string, organizationId: string) => loadAuthenticatedPrincipal(executor, { actorId, organizationId, role: "admin" });
  app.get("/api/company/:organizationId/intake/packets", requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const { legalEntityId, propertyId, cursor, limit } = listQuery.parse(req.query);
    const principal = await principalFor(companyWebActor(req), organizationId);
    res.json(await intake.list(principal, { scope: companyScopeSchema.parse({ organizationId, legalEntityId, propertyId }), cursor, limit }));
  }));
  app.get("/api/company/:organizationId/intake/packets/:packetId", requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const packetId = recordReferenceIdSchema.parse(req.params.packetId);
    const query = scopeQuery.parse(req.query);
    const principal = await principalFor(companyWebActor(req), organizationId);
    res.json(await intake.get(principal, { scope: companyScopeSchema.parse({ organizationId, ...query }), packetId }));
  }));
}
