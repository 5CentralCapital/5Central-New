import type { Express, Request, RequestHandler, Response } from "express";
import { ZodError, z } from "zod";
import { isoDateSchema, legalEntityIdSchema, organizationIdSchema, propertyReferenceIdSchema, commandEnvelopeSchema, type LegalEntityId, type OrganizationId } from "../../shared/company";
import { TIME_COMMAND_KINDS, timeCommandPayloadSchemas, timeConnectionScopeSchema, timeConnectionSetupScopeSchema, timeEnvironmentSchema, timeListQuerySchema, timeSyncOptionsSchema } from "../../shared/time";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { attestTransport, authorizeCompanyRead, loadAuthenticatedPrincipal } from "../company/authorization";
import { CompanyCommandError, ForbiddenCommandError } from "../company/commands/errors";
import { companyWebActor } from "../company/http";
import { AccountingError } from "../accounting/errors";
import type { TimeServices } from "./service";

const timeReadRoles = ["owner", "admin", "finance", "operations_pm", "project_manager", "read_only_reviewer"] as const;

function browserSessionBinding(request: Request): string {
  const sessionId = request.sessionID;
  if (typeof sessionId !== "string" || sessionId.length < 8 || sessionId.length > 512) throw new AccountingError("accounting_conflict", "QuickBooks Time OAuth requires the current authenticated browser session");
  return sessionId;
}

function publicTimeError(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof AccountingError) {
    const status = error.code === "accounting_validation" ? 400 : error.code === "accounting_not_found" ? 404 : error.code === "accounting_conflict" ? 409 : 503;
    const message = error.code === "accounting_configuration" ? "QuickBooks Time connection setup is required." : error.code === "accounting_not_found" ? "The time record is unavailable in this company." : error.code === "accounting_validation" ? "Check the time fields and selected company." : error.code === "accounting_conflict" ? "The time record changed or its connection needs attention." : "QuickBooks Time is temporarily unavailable.";
    return { status, body: { code: error.code, message } };
  }
  if (error instanceof CompanyCommandError) return { status: error.status, body: { code: `company_${error.code}`, message: error.message } };
  if (error instanceof ZodError) return { status: 400, body: { code: "company_validation", message: "Check the supplied time fields and selected company.", fields: error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })) } };
  return { status: 503, body: { code: "time_unavailable", message: "Employee time records are temporarily unavailable." } };
}

function timeHandler(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response) => {
    response.set("Cache-Control", "no-store");
    void handler(request, response).catch(error => {
      const failure = publicTimeError(error);
      if (!response.headersSent) response.status(failure.status).json(failure.body);
    });
  };
}

function queryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a single value`);
  return value;
}

function scopeQuery(request: Request): { readonly organizationId: ReturnType<typeof organizationIdSchema.parse>; readonly legalEntityId: ReturnType<typeof legalEntityIdSchema.parse>; readonly environment: "sandbox" | "production"; readonly providerCompanyId: string; readonly propertyId?: ReturnType<typeof propertyReferenceIdSchema.parse> } {
  const organizationId = organizationIdSchema.parse(request.params.organizationId);
  const legalEntityId = legalEntityIdSchema.parse(request.query.legalEntityId);
  const environment = timeEnvironmentSchema.parse(queryString(request.query.environment, "environment"));
  const providerCompanyId = timeConnectionScopeSchema.shape.providerCompanyId.parse(queryString(request.query.providerCompanyId, "providerCompanyId"));
  const propertyId = request.query.propertyId === undefined ? undefined : propertyReferenceIdSchema.parse(queryString(request.query.propertyId, "propertyId"));
  return { organizationId, legalEntityId, environment, providerCompanyId, ...(propertyId === undefined ? {} : { propertyId }) };
}

const connectionDirectoryQuery = z.object({ legalEntityId: legalEntityIdSchema, environment: timeEnvironmentSchema.optional() }).strict();

async function authorized(executor: RentOpsQueryExecutor, request: Request, organizationId: OrganizationId, legalEntityId: LegalEntityId) {
  const actorId = companyWebActor(request);
  const principal = await loadAuthenticatedPrincipal(executor, { actorId, organizationId, role: "admin" });
  authorizeCompanyRead(principal, { organizationId, legalEntityId }, timeReadRoles);
  return { actorId, principal };
}

export interface TimeHttpRouteOptions {
  readonly executor: RentOpsQueryExecutor;
  readonly requireAdmin: RequestHandler;
  readonly services: TimeServices;
}

/** HTTP is a thin adapter over the same time read and command services used by MCP. */
export function registerTimeHttpRoutes(app: Express, options: TimeHttpRouteOptions): void {
  const { executor, requireAdmin, services } = options;
  const web = attestTransport("web");

  app.get("/api/company/:organizationId/time/entries", requireAdmin, timeHandler(async (request, response) => {
    const scope = scopeQuery(request);
    const { principal } = await authorized(executor, request, scope.organizationId, scope.legalEntityId);
    const query = timeListQuerySchema.parse({
      scope: { organizationId: scope.organizationId, legalEntityId: scope.legalEntityId, ...(scope.propertyId === undefined ? {} : { propertyId: scope.propertyId }) },
      environment: scope.environment,
      providerCompanyId: scope.providerCompanyId,
      reviewState: queryString(request.query.reviewState, "reviewState"),
      mappingStatus: queryString(request.query.mappingStatus, "mappingStatus"),
      from: queryString(request.query.from, "from"),
      through: queryString(request.query.through, "through"),
      limit: request.query.limit === undefined ? undefined : Number(queryString(request.query.limit, "limit")),
      cursor: queryString(request.query.cursor, "cursor"),
    });
    response.json(await services.read.listEntries(principal, query));
  }));
  app.get("/api/company/:organizationId/time/connections", requireAdmin, timeHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const query = connectionDirectoryQuery.parse(request.query);
    const { principal } = await authorized(executor, request, organizationId, query.legalEntityId);
    response.json(await services.read.listConnections(principal, { organizationId, legalEntityId: query.legalEntityId, environment: query.environment }));
  }));
  app.get("/api/company/:organizationId/time/users", requireAdmin, timeHandler(async (request, response) => {
    const scope = scopeQuery(request);
    const { principal } = await authorized(executor, request, scope.organizationId, scope.legalEntityId);
    response.json(await services.read.listUsers(principal, scope));
  }));
  app.get("/api/company/:organizationId/time/jobcodes", requireAdmin, timeHandler(async (request, response) => {
    const scope = scopeQuery(request);
    const { principal } = await authorized(executor, request, scope.organizationId, scope.legalEntityId);
    response.json(await services.read.listJobcodes(principal, scope));
  }));
  app.get("/api/company/:organizationId/time/employee-mappings", requireAdmin, timeHandler(async (request, response) => {
    const scope = scopeQuery(request);
    const { principal } = await authorized(executor, request, scope.organizationId, scope.legalEntityId);
    response.json(await services.read.listEmployeeMappings(principal, scope));
  }));
  app.get("/api/company/:organizationId/time/jobcode-mappings", requireAdmin, timeHandler(async (request, response) => {
    const scope = scopeQuery(request);
    const { principal } = await authorized(executor, request, scope.organizationId, scope.legalEntityId);
    response.json(await services.read.listJobcodeMappings(principal, scope));
  }));
  app.get("/api/company/:organizationId/time/payroll-links", requireAdmin, timeHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const legalEntityId = legalEntityIdSchema.parse(queryString(request.query.legalEntityId, "legalEntityId"));
    const { principal } = await authorized(executor, request, organizationId, legalEntityId);
    response.json({ items: await services.read.listPayrollLinks(principal, { organizationId, legalEntityId }) });
  }));
  app.get("/api/company/:organizationId/time/coverage", requireAdmin, timeHandler(async (request, response) => {
    const scope = scopeQuery(request);
    const { principal } = await authorized(executor, request, scope.organizationId, scope.legalEntityId);
    response.json(await services.read.readCoverage(principal, scope));
  }));
  app.post("/api/company/:organizationId/time/sync", requireAdmin, timeHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const body = z.object({ legalEntityId: legalEntityIdSchema, providerCompanyId: timeConnectionScopeSchema.shape.providerCompanyId, environment: timeEnvironmentSchema, maxPages: z.number().int().min(1).max(10_000).optional(), startDate: isoDateSchema.optional(), endDate: isoDateSchema.optional() }).strict().parse(request.body);
    await authorized(executor, request, organizationId, body.legalEntityId);
    response.json(await services.sync.sync({ organizationId, legalEntityId: body.legalEntityId, environment: body.environment, providerCompanyId: body.providerCompanyId }, timeSyncOptionsSchema.parse({ maxPages: body.maxPages, startDate: body.startDate, endDate: body.endDate })));
  }));
  app.post("/api/company/:organizationId/time-commands/:commandKind", requireAdmin, timeHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const kind = z.enum(TIME_COMMAND_KINDS).parse(request.params.commandKind);
    const envelope = commandEnvelopeSchema(timeCommandPayloadSchemas[kind]).parse(request.body);
    if (envelope.scope.organizationId !== organizationId) throw new ForbiddenCommandError("Time company does not match this request.");
    const actorId = companyWebActor(request);
    const resolvePrincipal = (transaction: RentOpsQueryExecutor) => loadAuthenticatedPrincipal(transaction, { actorId, organizationId, role: "admin" });
    const principal = await resolvePrincipal(executor);
    response.json(await services.commands.execute(kind, envelope, { principal, resolvePrincipal, transport: web }));
  }));
  app.post("/api/company/:organizationId/time/connect", requireAdmin, timeHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const body = z.object({ legalEntityId: legalEntityIdSchema, providerCompanyId: timeConnectionScopeSchema.shape.providerCompanyId.optional(), displayMode: z.enum(["login", "create"]).optional() }).strict().parse(request.body);
    const { actorId } = await authorized(executor, request, organizationId, body.legalEntityId);
    if (services.qbt.status !== "configured") throw new AccountingError("accounting_configuration", "QuickBooks Time is not configured");
    const result = await services.qbt.oauthConnection.begin({ actorId, sessionBinding: browserSessionBinding(request), scope: timeConnectionSetupScopeSchema.parse({ organizationId, legalEntityId: body.legalEntityId, environment: services.qbt.environment, ...(body.providerCompanyId === undefined ? {} : { providerCompanyId: body.providerCompanyId }) }), displayMode: body.displayMode });
    response.json({ ...result, environment: services.qbt.environment });
  }));
  app.get("/api/company/:organizationId/time/callback", requireAdmin, timeHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const query = z.object({ state: z.string().min(32).max(512), code: z.string().max(8_000).optional(), error: z.string().max(512).optional() }).strict().parse(request.query);
    if (services.qbt.status !== "configured") throw new AccountingError("accounting_configuration", "QuickBooks Time is not configured");
    const pending = await services.qbt.oauthConnection.peek(query.state);
    if (!pending || pending.scope.organizationId !== organizationId) throw new AccountingError("accounting_conflict", "QuickBooks Time OAuth state is invalid, expired, or already used");
    const actorId = companyWebActor(request);
    if (pending.actorId !== actorId) throw new AccountingError("accounting_conflict", "QuickBooks Time OAuth callback actor does not match the initiating session");
    await authorized(executor, request, organizationId, pending.scope.legalEntityId);
    response.json(await services.qbt.oauthConnection.complete({ state: query.state, actorId, sessionBinding: browserSessionBinding(request), code: query.code, providerError: query.error }));
  }));
}
