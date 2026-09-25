import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { commandEnvelopeSchema, companyScopeSchema, legalEntityIdSchema, organizationIdSchema, propertyReferenceIdSchema } from "../../shared/company";
import {
  REVIEW_CASE_COMMAND_KINDS,
  REVIEW_CASE_STATES,
  REVIEW_CAUSE_FAMILIES,
  REVIEW_MATERIALITIES,
  REVIEW_REASON_CODES,
  reviewCaseCommandPayloadSchemas,
  reviewCaseIdSchema,
  reviewCaseListQuerySchema,
} from "../../shared/review-cases";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import { companyReadHandler, companyWebActor } from "../company/http";
import { ForbiddenCommandError } from "../company/commands/errors";
import type { ReviewCasePort } from "./port";

const csv = <T extends readonly [string, ...string[]]>(values: T) => z.string().trim().min(1).max(1_000)
  .transform(value => value.split(",").map(item => item.trim()).filter(Boolean))
  .pipe(z.array(z.enum(values)).min(1).max(values.length));

const listQuery = z.object({
  legalEntityId: legalEntityIdSchema.optional(),
  propertyId: propertyReferenceIdSchema.optional(),
  state: csv(REVIEW_CASE_STATES).optional(),
  reason: csv(REVIEW_REASON_CODES).optional(),
  materiality: csv(REVIEW_MATERIALITIES).optional(),
  family: csv(REVIEW_CAUSE_FAMILIES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(512).optional(),
}).strict();

const scopeQuery = z.object({
  legalEntityId: legalEntityIdSchema.optional(),
  propertyId: propertyReferenceIdSchema.optional(),
}).strict();

/** Browser routes; they call the same port as the Codex tools. */
export function registerReviewCaseRoutes(app: Express, options: { executor: RentOpsQueryExecutor; requireAdmin: RequestHandler; reviewCases: ReviewCasePort }): void {
  const web = attestTransport("web");
  const { executor, requireAdmin, reviewCases } = options;
  const principalFor = (actorId: string, organizationId: string, connection: RentOpsQueryExecutor = executor) =>
    loadAuthenticatedPrincipal(connection, { actorId, organizationId, role: "admin" });

  app.get("/api/company/:organizationId/review-cases", requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const { legalEntityId, propertyId, state, reason, materiality, family, ...rest } = listQuery.parse(req.query);
    const principal = await principalFor(companyWebActor(req), organizationId);
    res.json(await reviewCases.list(principal, reviewCaseListQuerySchema.parse({
      ...rest,
      scope: { organizationId, legalEntityId, propertyId },
      ...(state ? { states: state } : {}),
      ...(reason ? { reasonCodes: reason } : {}),
      ...(materiality ? { materialities: materiality } : {}),
      ...(family ? { causeFamilies: family } : {}),
    })));
  }));
  app.get("/api/company/:organizationId/review-cases/inventory", requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const query = scopeQuery.extend({ limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query);
    const principal = await principalFor(companyWebActor(req), organizationId);
    res.json(await reviewCases.inventory(principal, { scope: companyScopeSchema.parse({ organizationId, legalEntityId: query.legalEntityId, propertyId: query.propertyId }), limit: query.limit }));
  }));
  app.get("/api/company/:organizationId/review-cases/:caseId", requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const caseId = reviewCaseIdSchema.parse(req.params.caseId);
    const query = scopeQuery.parse(req.query);
    const principal = await principalFor(companyWebActor(req), organizationId);
    res.json(await reviewCases.get(principal, { scope: companyScopeSchema.parse({ organizationId, ...query }), caseId }));
  }));
  app.post("/api/company/:organizationId/review-case-commands/:commandKind", requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const kind = z.enum(REVIEW_CASE_COMMAND_KINDS).parse(req.params.commandKind);
    const envelope = commandEnvelopeSchema(reviewCaseCommandPayloadSchemas[kind]).parse(req.body);
    if (envelope.scope.organizationId !== organizationId) throw new ForbiddenCommandError("Review case company does not match this request.");
    const actorId = companyWebActor(req);
    const resolvePrincipal = (transaction: RentOpsQueryExecutor) => principalFor(actorId, organizationId, transaction);
    const principal = await resolvePrincipal(executor);
    res.json(await reviewCases.execute(kind, envelope, { principal, resolvePrincipal, transport: web }));
  }));
}
