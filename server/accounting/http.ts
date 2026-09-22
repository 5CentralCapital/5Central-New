import type { Express, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { legalEntityIdSchema, organizationIdSchema } from "../../shared/company";
import type { FinancialSourceReadPort } from "../../shared/accounting";
import type { AccountingServices } from "./index";
import { loadAuthenticatedPrincipal, authorizeCompanyRead } from "../company/authorization";
import { companyReadHandler, companyWebActor } from "../company/http";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { AccountingError } from "./errors";
import { QuickBooksIntegrationError } from "../integrations/quickbooks/errors";
import type { QboProviderMirrorKind } from "./mirror-store";
import { hashQuickBooksSessionBinding } from "./oauth-state";

const environmentSchema = z.enum(["sandbox", "production"]);
const realmSchema = z.string().regex(/^\d{1,32}$/);
const mirrorKindSchema = z.enum(["accounts", "vendors", "customers", "employees"]);
const callbackQuerySchema = z.object({ state: z.string(), code: z.string().optional(), realmId: realmSchema.optional(), error: z.string().optional(), error_description: z.string().max(2_000).optional() }).strict();

function browserSessionBinding(request: unknown): string {
  const sessionId = (request as { readonly sessionID?: unknown }).sessionID;
  if (typeof sessionId !== "string" || sessionId.length < 8 || sessionId.length > 512) {
    throw new AccountingError("accounting_conflict", "QuickBooks OAuth requires the current authenticated browser session");
  }
  return sessionId;
}

function httpError(error: unknown, response: { status(code: number): { json(body: unknown): void } }): void {
  if (error instanceof AccountingError) {
    const status = error.code === "accounting_validation" ? 400 : error.code === "accounting_capability_disabled" ? 403 : error.code === "accounting_not_found" ? 404 : error.code === "accounting_conflict" ? 409 : 503;
    response.status(status).json({ code: error.code, message: error.message });
    return;
  }
  if (error instanceof QuickBooksIntegrationError) {
    const status = error.code === "quickbooks_validation" ? 400 : error.code === "quickbooks_unauthorized" ? 401 : error.code === "quickbooks_conflict" ? 409 : error.code === "quickbooks_ambiguous_write" ? 409 : 503;
    response.status(status).json({ code: error.code, message: error.message });
    return;
  }
  response.status(503).json({ code: "accounting_unavailable", message: "Accounting services are temporarily unavailable." });
}

type AccountingReadRole = "owner" | "admin" | "finance" | "read_only_reviewer";
const READ_ROLES: readonly AccountingReadRole[] = ["owner", "admin", "finance", "read_only_reviewer"];
const MUTATION_ROLES: readonly AccountingReadRole[] = ["owner", "admin", "finance"];

async function authorizedScope(executor: RentOpsQueryExecutor, request: unknown, organizationId: string, legalEntityId: string, allowedRoles: readonly AccountingReadRole[] = READ_ROLES) {
  const actorId = companyWebActor(request as Parameters<typeof companyWebActor>[0]);
  const parsedOrganizationId = organizationIdSchema.parse(organizationId);
  const parsedLegalEntityId = legalEntityIdSchema.parse(legalEntityId);
  const principal = await loadAuthenticatedPrincipal(executor, { actorId, organizationId: parsedOrganizationId, role: "admin" });
  authorizeCompanyRead(principal, { organizationId: parsedOrganizationId, legalEntityId: parsedLegalEntityId }, allowedRoles);
  return { actorId, principal };
}

/**
 * Read authorization and the mirror query must share one transaction.  A
 * grant can be revoked between two independent queries, so authorizing before
 * calling a read port is not sufficient for company financial data.
 */
async function authorizedRead<T>(
  executor: RentOpsQueryExecutor,
  request: unknown,
  organizationId: string,
  legalEntityId: string,
  read: (transaction: RentOpsQueryExecutor, actorId: string) => Promise<T>,
): Promise<T> {
  if (!executor.transaction) throw new AccountingError("accounting_configuration", "Accounting reads require a transactional company database");
  const parsedOrganizationId = organizationIdSchema.parse(organizationId);
  const parsedLegalEntityId = legalEntityIdSchema.parse(legalEntityId);
  const actorId = companyWebActor(request as Parameters<typeof companyWebActor>[0]);
  return executor.transaction(async transaction => {
    const principal = await loadAuthenticatedPrincipal(transaction, { actorId, organizationId: parsedOrganizationId, role: "admin" });
    authorizeCompanyRead(principal, { organizationId: parsedOrganizationId, legalEntityId: parsedLegalEntityId }, READ_ROLES);
    return read(transaction, actorId);
  }, { readOnly: true });
}

export interface AccountingHttpRouteOptions {
  readonly executor: RentOpsQueryExecutor;
  readonly requireAdmin: RequestHandler;
  readonly services: AccountingServices;
}

/** Root wiring owns the route prefix; this adapter only supplies authenticated handlers. */
export function registerAccountingHttpRoutes(app: Express, options: AccountingHttpRouteOptions): void {
  const { executor, requireAdmin, services } = options;
  /**
   * Intuit sends only state/code/realmId/error. Recover the bound organization
   * and legal entity from the server-side state, then re-check the current
   * actor, session, and grant before consuming the state or persisting any
   * provider credentials. `expectedOrganizationId` is null for the static
   * organization-free redirect URI.
   */
  const completeCallback = async (request: Request, response: Response, expectedOrganizationId: string | null): Promise<void> => {
    const query = callbackQuerySchema.parse(request.query);
    if (services.qbo.status !== "configured") throw new AccountingError("accounting_configuration", "QuickBooks is not configured");
    const pending = await services.qbo.oauthConnection.peek(query.state);
    if (!pending || (expectedOrganizationId !== null && pending.organizationId !== expectedOrganizationId)) throw new AccountingError("accounting_conflict", "QuickBooks OAuth state is invalid, expired, or already used");
    const actorId = companyWebActor(request);
    if (pending.actorId !== actorId) throw new AccountingError("accounting_conflict", "QuickBooks OAuth callback actor does not match the initiating session");
    await authorizedScope(executor, request, pending.organizationId, pending.legalEntityId, MUTATION_ROLES);
    const result = await services.qbo.oauthConnection.complete({ state: query.state, actorId, sessionBinding: browserSessionBinding(request), code: query.code, callbackRealmId: query.realmId, providerError: query.error });
    if (result.status === "pending_confirmation") {
      const search = new URLSearchParams({ section: "accounting", company: pending.organizationId, qboPending: result.pendingId, qboEntity: result.scope.legalEntityId });
      response.redirect(303, `/ops?${search.toString()}`);
      return;
    }
    response.json(result);
  };
  app.get("/api/company/:organizationId/accounting/qbo/configuration", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const query = z.object({ legalEntityId: legalEntityIdSchema }).strict().parse(request.query);
    await authorizedScope(executor, request, organizationId, query.legalEntityId, READ_ROLES);
    response.json(services.qbo.status === "configured"
      ? { configured: true, environment: services.qbo.environment }
      : { configured: false, environment: null });
  }));
  app.get("/api/company/:organizationId/accounting/qbo/connections", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const query = z.object({ legalEntityId: legalEntityIdSchema, environment: environmentSchema }).strict().parse(request.query);
    const connections = await authorizedRead(executor, request, organizationId, query.legalEntityId, async transaction => {
      const rows = await transaction.query<{
        legal_entity_id: unknown;
        environment: unknown;
        realm_id: unknown;
        version: unknown;
        access_token_expires_at: unknown;
        refresh_token_expires_at: unknown;
        updated_at: unknown;
        company_name: unknown;
        read_enabled: unknown;
      }>(
        `SELECT c.legal_entity_id, c.environment, c.realm_id, c.version,
                c.access_token_expires_at, c.refresh_token_expires_at, c.updated_at,
                info.provider_body->>'CompanyName' AS company_name,
                EXISTS (
                  SELECT 1 FROM accounting_qbo_capabilities cap
                   WHERE cap.organization_id=c.organization_id AND cap.legal_entity_id=c.legal_entity_id
                     AND cap.environment=c.environment AND cap.realm_id=c.realm_id
                     AND cap.capability='accounting.read' AND cap.enabled=true
                     AND cap.evidence='live_provider_readback'
                ) AS read_enabled
           FROM accounting_qbo_connections c
           LEFT JOIN LATERAL (
             SELECT provider_body FROM accounting_qbo_source_objects
              WHERE organization_id=c.organization_id AND legal_entity_id=c.legal_entity_id
                AND environment=c.environment AND realm_id=c.realm_id AND object_type='CompanyInfo' AND deleted_at IS NULL
              ORDER BY received_at DESC LIMIT 1
           ) info ON true
          WHERE c.organization_id=$1 AND c.legal_entity_id=$2 AND c.environment=$3 AND c.revoked_at IS NULL
          ORDER BY c.realm_id`,
        [organizationId, query.legalEntityId, query.environment],
      );
      return rows.rows.map(row => ({
        scope: { provider: "qbo" as const, organizationId, legalEntityId: query.legalEntityId, environment: environmentSchema.parse(row.environment), realmId: realmSchema.parse(String(row.realm_id)) },
        name: typeof row.company_name === "string" && row.company_name.trim() ? row.company_name.trim() : "QuickBooks Online",
        status: row.read_enabled === true || row.read_enabled === "true" ? "ready" as const : "connected" as const,
        version: Number(row.version),
        accessTokenExpiresAt: row.access_token_expires_at instanceof Date ? row.access_token_expires_at.toISOString() : String(row.access_token_expires_at),
        refreshTokenExpiresAt: row.refresh_token_expires_at === null || row.refresh_token_expires_at === undefined ? null : row.refresh_token_expires_at instanceof Date ? row.refresh_token_expires_at.toISOString() : String(row.refresh_token_expires_at),
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      }));
    });
    response.json({ items: connections });
  }));
  app.get("/api/company/:organizationId/accounting/qbo/pending", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const query = z.object({ legalEntityId: legalEntityIdSchema, pendingId: z.string().uuid() }).strict().parse(request.query);
    if (services.qbo.status !== "configured") throw new AccountingError("accounting_configuration", "QuickBooks is not configured");
    const sessionBindingHash = hashQuickBooksSessionBinding(browserSessionBinding(request));
    const preview = await authorizedRead(executor, request, organizationId, query.legalEntityId, (transaction, actorId) => services.qbo.status === "configured"
      ? services.qbo.previewPendingBinding({ executor: transaction, pendingId: query.pendingId, actorId, sessionBindingHash, organizationId, legalEntityId: query.legalEntityId })
      : Promise.resolve(null));
    if (!preview) { response.status(404).json({ code: "accounting_not_found", message: "QuickBooks connection confirmation is no longer available." }); return; }
    response.json(preview);
  }));
  app.get("/api/company/:organizationId/accounting/qbo/mirrors", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const query = z.object({ legalEntityId: legalEntityIdSchema, environment: environmentSchema, realmId: realmSchema, kind: mirrorKindSchema }).strict().parse(request.query);
    const items = await authorizedRead(executor, request, organizationId, query.legalEntityId, transaction => services.mirror.forExecutor(transaction).listProviderMirrors({ organizationId, legalEntityId: query.legalEntityId, environment: query.environment, realmId: query.realmId }, query.kind as QboProviderMirrorKind));
    response.json({ items });
  }));
  app.get("/api/company/:organizationId/accounting/qbo/transactions", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const query = z.object({ legalEntityId: legalEntityIdSchema, environment: environmentSchema, realmId: realmSchema, from: z.string().date().optional(), through: z.string().date().optional(), limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().min(1).max(512).optional() }).strict().parse(request.query);
    const page = await authorizedRead(executor, request, organizationId, query.legalEntityId, transaction => services.mirror.forExecutor(transaction).listTransactions({ scope: { provider: "qbo", organizationId, legalEntityId: query.legalEntityId, environment: query.environment, realmId: query.realmId }, from: query.from, through: query.through, limit: query.limit, cursor: query.cursor }));
    response.json(page);
  }));
  app.post("/api/company/:organizationId/accounting/qbo/sync", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const body = z.object({ legalEntityId: legalEntityIdSchema, environment: environmentSchema, realmId: realmSchema, maxPages: z.number().int().min(1).max(100).optional() }).strict().parse(request.body);
    const { actorId } = await authorizedScope(executor, request, organizationId, body.legalEntityId, MUTATION_ROLES);
    void actorId;
    if (services.qbo.status !== "configured") throw new AccountingError("accounting_configuration", "QuickBooks is not configured");
    if (body.environment !== services.qbo.environment) throw new AccountingError("accounting_conflict", "The requested QuickBooks environment is not configured for this server");
    const sync = services.qbo.createProviderSync({ organizationId, legalEntityId: body.legalEntityId, environment: body.environment, realmId: body.realmId });
    await sync.bootstrapRead();
    response.json(await sync.catchUp({ maxPages: body.maxPages }));
  }));
  app.get("/api/company/:organizationId/accounting/qbo/coverage", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const legalEntityId = legalEntityIdSchema.parse(request.query.legalEntityId);
    const realmId = realmSchema.parse(request.query.realmId);
    const environment = environmentSchema.parse(request.query.environment);
    const coverage = await authorizedRead(executor, request, organizationId, legalEntityId, transaction => services.mirror.forExecutor(transaction).readCoverage({ provider: "qbo", organizationId, legalEntityId, environment, realmId }));
    response.json(coverage);
  }));
  app.get("/api/company/:organizationId/accounting/qbo/source-line", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const legalEntityId = legalEntityIdSchema.parse(request.query.legalEntityId);
    const realmId = realmSchema.parse(request.query.realmId);
    const environment = environmentSchema.parse(request.query.environment);
    const resolution = await authorizedRead(executor, request, organizationId, legalEntityId, transaction => services.mirror.forExecutor(transaction).resolveLine({
      scope: { provider: "qbo", organizationId, legalEntityId, environment, realmId },
      objectType: z.string().parse(request.query.objectType), objectId: z.string().parse(request.query.objectId), lineId: z.string().parse(request.query.lineId),
      ...(request.query.version ? { version: z.string().parse(request.query.version) } : {}),
    }));
    if (!resolution) { response.status(404).json({ code: "accounting_not_found", message: "Accounting source line was not found." }); return; }
    response.json(resolution);
  }));
  app.post("/api/company/:organizationId/accounting/qbo/connect", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const body = z.object({ legalEntityId: legalEntityIdSchema, expectedRealmId: realmSchema.optional() }).strict().parse(request.body);
    const { actorId } = await authorizedScope(executor, request, organizationId, body.legalEntityId, MUTATION_ROLES);
    if (services.qbo.status !== "configured") throw new AccountingError("accounting_configuration", "QuickBooks is not configured");
    response.json(await services.qbo.oauthConnection.begin({ actorId, sessionBinding: browserSessionBinding(request), organizationId, legalEntityId: body.legalEntityId, environment: services.qbo.environment, expectedRealmId: body.expectedRealmId }));
  }));
  // Intuit redirect URIs must match exactly, so the organization-free route is
  // the one registered with Intuit. Both routes share one completion path.
  app.get("/api/accounting/qbo/callback", requireAdmin, companyReadHandler((request, response) => completeCallback(request, response, null)));
  app.get("/api/company/:organizationId/accounting/qbo/callback", requireAdmin, companyReadHandler((request, response) => completeCallback(request, response, organizationIdSchema.parse(request.params.organizationId))));
  app.post("/api/company/:organizationId/accounting/qbo/confirm", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const body = z.object({ legalEntityId: legalEntityIdSchema, pendingId: z.string().uuid(), confirmRealmBinding: z.literal(true) }).strict().parse(request.body);
    const { actorId } = await authorizedScope(executor, request, organizationId, body.legalEntityId, MUTATION_ROLES);
    if (services.qbo.status !== "configured") throw new AccountingError("accounting_configuration", "QuickBooks is not configured");
    response.json(await services.qbo.oauthConnection.confirm({ pendingId: body.pendingId, actorId, sessionBinding: browserSessionBinding(request), organizationId, legalEntityId: body.legalEntityId }));
  }));
  app.post("/api/company/:organizationId/accounting/qbo/disconnect", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const body = z.object({ legalEntityId: legalEntityIdSchema, realmId: realmSchema }).strict().parse(request.body);
    const { actorId } = await authorizedScope(executor, request, organizationId, body.legalEntityId, MUTATION_ROLES);
    if (services.qbo.status !== "configured") throw new AccountingError("accounting_configuration", "QuickBooks is not configured");
    response.json(await services.qbo.disconnect({ actorId, channel: "web", scope: { organizationId, legalEntityId: body.legalEntityId, environment: services.qbo.environment, realmId: body.realmId } }));
  }));
}

export { httpError as accountingHttpError };
