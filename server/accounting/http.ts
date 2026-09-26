import type { Express, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { commandEnvelopeSchema, isoDateSchema, legalEntityIdSchema, newRecordId, organizationIdSchema, propertyReferenceIdSchema } from "../../shared/company";
import {
  ACCOUNTING_OPERATION_COMMAND_KINDS,
  accountingOperationCommandPayloadSchemas,
  PM_SETTLEMENT_STATES,
  QBO_SYNC_REQUEST_COMMAND_KIND,
} from "../../shared/accounting/operations";
import { ACCOUNTING_PURPOSE_COMMAND_KINDS, accountingPurposeCommandPayloadSchemas, accountingPurposeScopeQuerySchema } from "../../shared/accounting/purpose-contracts";
import { attestTransport } from "../company/authorization";
import { ForbiddenCommandError } from "../company/commands/errors";
import type { FinancialSourceReadPort } from "../../shared/accounting";
import type { AccountingServices } from "./index";
import { loadAuthenticatedPrincipal, authorizeCompanyRead } from "../company/authorization";
import { companyReadHandler, companyWebActor } from "../company/http";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { AccountingError } from "./errors";
import { QuickBooksIntegrationError } from "../integrations/quickbooks/errors";
import type { QboProviderMirrorKind } from "./mirror-store";
import { hashQuickBooksSessionBinding } from "./oauth-state";
import { readCustomerLedger, resolveTenancyCustomer } from "./receivables-read";
import { linkTenancyToQboCustomer } from "./receivables-links";
import { readQboCustomerPlan } from "./qbo-customer-plan-service";

function businessToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const environmentSchema = z.enum(["sandbox", "production"]);
const realmSchema = z.string().regex(/^\d{1,32}$/);
const mirrorKindSchema = z.enum(["accounts", "vendors", "customers", "employees"]);
const purposeMappingQuerySchema = accountingPurposeScopeQuerySchema.omit({ organizationId: true });
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
  /**
   * Whether the browser still carries an administrator session. When given,
   * an OAuth callback without one is redirected to the sign-in page instead of
   * receiving the API's JSON 401. Omitted for synthetic/demo wiring.
   */
  readonly hasAdminSession?: (request: Request) => boolean;
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
    // The callback URL carries the one-time authorization code; never leak it
    // through a Referer header from whatever this response renders.
    response.setHeader("Referrer-Policy", "no-referrer");
    const query = callbackQuerySchema.parse(request.query);
    if (services.qbo.status !== "configured") throw new AccountingError("accounting_configuration", "QuickBooks is not configured");
    const pending = await services.qbo.oauthConnection.peek(query.state);
    if (!pending || (expectedOrganizationId !== null && pending.organizationId !== expectedOrganizationId)) throw new AccountingError("accounting_conflict", "QuickBooks OAuth state is invalid, expired, or already used");
    const actorId = companyWebActor(request);
    if (pending.actorId !== actorId) throw new AccountingError("accounting_conflict", "QuickBooks OAuth callback actor does not match the initiating session");
    await authorizedScope(executor, request, pending.organizationId, pending.legalEntityId, MUTATION_ROLES);
    const result = await services.qbo.oauthConnection.complete({ state: query.state, actorId, sessionBinding: browserSessionBinding(request), code: query.code, callbackRealmId: query.realmId, providerError: query.error });
    // Always leave the code-bearing callback URL for a clean application URL.
    const search = result.status === "pending_confirmation"
      ? new URLSearchParams({ section: "accounting", company: pending.organizationId, qboPending: result.pendingId, qboEntity: result.scope.legalEntityId })
      : new URLSearchParams({ section: "accounting", company: pending.organizationId, qboConnected: result.scope.realmId, qboEntity: result.scope.legalEntityId });
    response.redirect(303, `/ops?${search.toString()}`);
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
        refresh_token_hard_expires_at: unknown;
        status: unknown;
        updated_at: unknown;
        company_name: unknown;
        read_enabled: unknown;
      }>(
        `SELECT c.legal_entity_id, c.environment, c.realm_id, c.version,
                c.access_token_expires_at, c.refresh_token_expires_at, c.refresh_token_hard_expires_at, c.status, c.updated_at,
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
          WHERE c.organization_id=$1 AND c.legal_entity_id=$2 AND c.environment=$3 AND c.status IN ('active','needs_reconnect')
          ORDER BY c.realm_id`,
        [organizationId, query.legalEntityId, query.environment],
      );
      return rows.rows.map(row => ({
        scope: { provider: "qbo" as const, organizationId, legalEntityId: query.legalEntityId, environment: environmentSchema.parse(row.environment), realmId: realmSchema.parse(String(row.realm_id)) },
        name: typeof row.company_name === "string" && row.company_name.trim() ? row.company_name.trim() : "QuickBooks Online",
        status: row.status === "needs_reconnect" ? "needs_reconnect" as const : row.read_enabled === true || row.read_enabled === "true" ? "ready" as const : "connected" as const,
        version: Number(row.version),
        accessTokenExpiresAt: row.access_token_expires_at instanceof Date ? row.access_token_expires_at.toISOString() : String(row.access_token_expires_at),
        refreshTokenExpiresAt: row.refresh_token_expires_at === null || row.refresh_token_expires_at === undefined ? null : row.refresh_token_expires_at instanceof Date ? row.refresh_token_expires_at.toISOString() : String(row.refresh_token_expires_at),
        refreshTokenHardExpiresAt: row.refresh_token_hard_expires_at === null || row.refresh_token_hard_expires_at === undefined ? null : row.refresh_token_hard_expires_at instanceof Date ? row.refresh_token_hard_expires_at.toISOString() : String(row.refresh_token_hard_expires_at),
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
  app.get("/api/company/:organizationId/accounting/qbo/purpose-mappings", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const query = purposeMappingQuerySchema.parse(request.query);
    const items = await authorizedRead(executor, request, organizationId, query.legalEntityId, transaction => services.purposeMappings.forExecutor(transaction).listPurposeMappings({ provider: "qbo", organizationId, legalEntityId: query.legalEntityId, environment: query.environment, realmId: query.realmId }, query.providerAccountId));
    response.json({ items });
  }));
  app.get("/api/company/:organizationId/accounting/qbo/transactions", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const query = z.object({ legalEntityId: legalEntityIdSchema, environment: environmentSchema, realmId: realmSchema, from: z.string().date().optional(), through: z.string().date().optional(), limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().min(1).max(512).optional() }).strict().parse(request.query);
    const page = await authorizedRead(executor, request, organizationId, query.legalEntityId, transaction => services.mirror.forExecutor(transaction).listTransactions({ scope: { provider: "qbo", organizationId, legalEntityId: query.legalEntityId, environment: query.environment, realmId: query.realmId }, from: query.from, through: query.through, limit: query.limit, cursor: query.cursor }));
    response.json(page);
  }));
  // Sync runs in the background worker; this request only queues it.
  app.post("/api/company/:organizationId/accounting/qbo/sync", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const body = z.object({ legalEntityId: legalEntityIdSchema, environment: environmentSchema, realmId: realmSchema, maxPages: z.number().int().min(1).max(100).optional(), fullReplay: z.boolean().optional() }).strict().parse(request.body);
    const { actorId } = await authorizedScope(executor, request, organizationId, body.legalEntityId, MUTATION_ROLES);
    if (services.qbo.status !== "configured") throw new AccountingError("accounting_configuration", "QuickBooks is not configured");
    if (body.environment !== services.qbo.environment) throw new AccountingError("accounting_conflict", "The requested QuickBooks environment is not configured for this server");
    const connection = await executor.query<{ status: string }>(
      `SELECT status FROM accounting_qbo_connections WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4`,
      [organizationId, body.legalEntityId, body.environment, body.realmId],
    );
    if (connection.rows[0]?.status !== "active") throw new QuickBooksIntegrationError("quickbooks_unauthorized", "QuickBooks needs to be reconnected for this company");
    const operationId = newRecordId();
    const resolvePrincipal = (transaction: RentOpsQueryExecutor) => loadAuthenticatedPrincipal(transaction, { actorId, organizationId, role: "admin" });
    const receipt = await services.operations.execute(QBO_SYNC_REQUEST_COMMAND_KIND, {
      operationId, idempotencyKey: `qbo-sync:${operationId}`, scope: { organizationId, legalEntityId: body.legalEntityId },
      payload: { environment: body.environment, realmId: body.realmId, forceFullReplay: body.fullReplay === true },
    }, { principal: await resolvePrincipal(executor), resolvePrincipal, transport: attestTransport("web") });
    response.status(202).json({ status: "queued", jobId: receipt.affectedRecordIds[0] ?? null, message: receipt.validationOutcomes[0]?.message ?? "QuickBooks refresh queued." });
  }));
  app.post("/api/company/:organizationId/accounting/qbo/purpose-commands/:commandKind", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const kind = z.enum(ACCOUNTING_PURPOSE_COMMAND_KINDS).parse(request.params.commandKind);
    const envelope = commandEnvelopeSchema(accountingPurposeCommandPayloadSchemas[kind]).parse(request.body);
    if (envelope.scope.organizationId !== organizationId) throw new ForbiddenCommandError("Accounting purpose mapping company does not match this request.");
    const actorId = companyWebActor(request);
    const resolvePrincipal = (transaction: RentOpsQueryExecutor) => loadAuthenticatedPrincipal(transaction, { actorId, organizationId, role: "admin" });
    const principal = await resolvePrincipal(executor);
    response.json(await services.purposeCommands.execute(kind, envelope, { principal, resolvePrincipal, transport: attestTransport("web") }));
  }));
  app.get("/api/company/:organizationId/accounting/qbo/coverage", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const legalEntityId = legalEntityIdSchema.parse(request.query.legalEntityId);
    const realmId = realmSchema.parse(request.query.realmId);
    const environment = environmentSchema.parse(request.query.environment);
    const coverage = await authorizedRead(executor, request, organizationId, legalEntityId, transaction => services.mirror.forExecutor(transaction).readCoverage({ provider: "qbo", organizationId, legalEntityId, environment, realmId }));
    response.json(coverage);
  }));
  // QuickBooks-backed customer/tenant history (QS04). Reads the verified
  // receivables mirror only; it never calls QuickBooks from a request.
  app.get("/api/company/:organizationId/accounting/qbo/receivables/customer-ledger", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const query = z.object({
      legalEntityId: legalEntityIdSchema, environment: environmentSchema, realmId: realmSchema,
      customerId: z.string().min(1).max(200), asOf: z.string().date().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100), cursor: z.string().min(1).max(64).optional(),
    }).strict().parse(request.query);
    const ledger = await authorizedRead(executor, request, organizationId, query.legalEntityId, transaction => readCustomerLedger(transaction, {
      scope: { provider: "qbo", organizationId, legalEntityId: query.legalEntityId, environment: query.environment, realmId: query.realmId },
      customerObjectId: query.customerId, asOf: query.asOf, today: businessToday(), limit: query.limit, cursor: query.cursor,
    }));
    response.json(ledger);
  }));
  app.get("/api/company/:organizationId/accounting/qbo/receivables/tenancy-ledger", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const query = z.object({
      tenancyId: z.string().min(1).max(160), environment: environmentSchema, asOf: z.string().date().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100), cursor: z.string().min(1).max(64).optional(),
    }).strict().parse(request.query);
    if (!executor.transaction) throw new AccountingError("accounting_configuration", "Accounting reads require a transactional company database");
    const actorId = companyWebActor(request);
    const result = await executor.transaction(async transaction => {
      const link = await resolveTenancyCustomer(transaction, { organizationId, tenancyId: query.tenancyId, environment: query.environment });
      if (!link) return null;
      // Authorize against the linked company before reading any of its data.
      const principal = await loadAuthenticatedPrincipal(transaction, { actorId, organizationId, role: "admin" });
      authorizeCompanyRead(principal, { organizationId, legalEntityId: link.scope.legalEntityId }, READ_ROLES);
      return readCustomerLedger(transaction, { scope: link.scope, customerObjectId: link.customerObjectId, asOf: query.asOf, today: businessToday(), limit: query.limit, cursor: query.cursor });
    }, { readOnly: true });
    if (!result) { response.status(404).json({ code: "accounting_not_linked", message: "This tenancy is not linked to a QuickBooks customer yet; its QuickBooks history is not shown." }); return; }
    response.json(result);
  }));
  app.post("/api/company/:organizationId/accounting/qbo/receivables/tenancy-links", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const body = z.object({ legalEntityId: legalEntityIdSchema, environment: environmentSchema, realmId: realmSchema, tenancyId: z.string().min(1).max(160), customerId: z.string().min(1).max(200) }).strict().parse(request.body);
    if (!executor.transaction) throw new AccountingError("accounting_configuration", "Accounting changes require a transactional company database");
    const actorId = companyWebActor(request);
    const result = await executor.transaction(async transaction => {
      const principal = await loadAuthenticatedPrincipal(transaction, { actorId, organizationId, role: "admin" });
      authorizeCompanyRead(principal, { organizationId, legalEntityId: body.legalEntityId }, MUTATION_ROLES);
      return linkTenancyToQboCustomer(transaction, { scope: { provider: "qbo", organizationId, legalEntityId: body.legalEntityId, environment: body.environment, realmId: body.realmId }, tenancyId: body.tenancyId, customerObjectId: body.customerId });
    });
    response.status(result.status === "linked" ? 201 : 200).json(result);
  }));
  // Read-only QuickBooks customer plan: one proposed Customer per tenancy in
  // the owning entity's company. Nothing is written to QuickBooks.
  app.get("/api/company/:organizationId/accounting/qbo/customer-plan", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const query = z.object({ environment: environmentSchema.default("production"), legalEntityId: legalEntityIdSchema.optional(), asOf: z.string().date().optional() }).strict().parse(request.query);
    if (!executor.transaction) throw new AccountingError("accounting_configuration", "Accounting reads require a transactional company database");
    const actorId = companyWebActor(request);
    const plan = await executor.transaction(async transaction => {
      const principal = await loadAuthenticatedPrincipal(transaction, { actorId, organizationId, role: "admin" });
      authorizeCompanyRead(principal, { organizationId, ...(query.legalEntityId ? { legalEntityId: query.legalEntityId } : {}) }, READ_ROLES);
      return readQboCustomerPlan(transaction, { organizationId, environment: query.environment, asOf: query.asOf ?? businessToday(), ...(query.legalEntityId ? { legalEntityId: query.legalEntityId } : {}) });
    }, { readOnly: true });
    response.json(plan);
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
    // Refresh Intuit's discovery document (cached) so the authorize URL is current.
    await services.qbo.oauth.resolveEndpoints();
    response.json(await services.qbo.oauthConnection.begin({ actorId, sessionBinding: browserSessionBinding(request), organizationId, legalEntityId: body.legalEntityId, environment: services.qbo.environment, expectedRealmId: body.expectedRealmId }));
  }));
  // Intuit redirect URIs must match exactly, so the organization-free route is
  // the one registered with Intuit. Both routes share one completion path.
  // Intuit sends the browser back here after consent. If the administrator
  // session lapsed meanwhile, leave the code-bearing URL for the sign-in page
  // instead of answering with API JSON. The code is never copied forward.
  const callbackSessionGuard: RequestHandler = (request, response, next) => {
    if (options.hasAdminSession && !options.hasAdminSession(request)) {
      response.setHeader("Referrer-Policy", "no-referrer");
      response.redirect(303, `/ops?${new URLSearchParams({ section: "accounting", qboError: "session_expired" }).toString()}`);
      return;
    }
    next();
  };
  // Known OAuth failures (expired state, replayed callback, provider error)
  // also land on the application URL so the browser never sits on the callback.
  const callbackHandler = (expectedOrganizationId: (request: Request) => string | null): RequestHandler => companyReadHandler(async (request, response) => {
    try {
      await completeCallback(request, response, expectedOrganizationId(request));
    } catch (error) {
      if (error instanceof AccountingError || error instanceof QuickBooksIntegrationError) {
        response.setHeader("Referrer-Policy", "no-referrer");
        response.redirect(303, `/ops?${new URLSearchParams({ section: "accounting", qboError: error.code }).toString()}`);
        return;
      }
      throw error;
    }
  });
  app.get("/api/accounting/qbo/callback", callbackSessionGuard, requireAdmin, callbackHandler(() => null));
  app.get("/api/company/:organizationId/accounting/qbo/callback", callbackSessionGuard, requireAdmin, callbackHandler(request => organizationIdSchema.parse(request.params.organizationId)));
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
  registerAccountingOperationRoutes(app, options);
}

const periodQuery = z.object({ legalEntityId: legalEntityIdSchema, periodStart: isoDateSchema, periodEnd: isoDateSchema }).strict();
const csvList = <T extends readonly [string, ...string[]]>(values: T) => z.string().trim().min(1).max(200)
  .transform(value => value.split(",").map(item => item.trim()).filter(Boolean)).pipe(z.array(z.enum(values)).min(1).max(values.length));

/** Accounting operations (health, posting policy, PM settlements, bridge, close, payables); same port as the Codex tools. */
function registerAccountingOperationRoutes(app: Express, options: AccountingHttpRouteOptions): void {
  const { executor, requireAdmin, services } = options;
  const operations = services.operations;
  const principalFor = (request: Request, organizationId: string, connection: RentOpsQueryExecutor = executor) =>
    loadAuthenticatedPrincipal(connection, { actorId: companyWebActor(request), organizationId, role: "admin" });
  app.get("/api/company/:organizationId/accounting/health", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const query = z.object({ legalEntityId: legalEntityIdSchema.optional() }).strict().parse(request.query);
    response.json(await operations.health(await principalFor(request, organizationId), { organizationId, ...query }));
  }));
  app.get("/api/company/:organizationId/accounting/period-close", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const query = periodQuery.parse(request.query);
    response.json(await operations.closeChecklist(await principalFor(request, organizationId), { organizationId, ...query }));
  }));
  app.get("/api/company/:organizationId/accounting/posting-policies", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const query = z.object({ legalEntityId: legalEntityIdSchema }).strict().parse(request.query);
    response.json(await operations.listPostingPolicies(await principalFor(request, organizationId), { organizationId, ...query }));
  }));
  app.get("/api/company/:organizationId/accounting/pm-settlements", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const query = z.object({
      legalEntityId: legalEntityIdSchema.optional(), propertyId: propertyReferenceIdSchema.optional(), state: csvList(PM_SETTLEMENT_STATES).optional(),
      periodFrom: isoDateSchema.optional(), periodThrough: isoDateSchema.optional(), limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().min(1).max(512).optional(),
    }).strict().parse(request.query);
    const { state, ...rest } = query;
    response.json(await operations.listPmSettlements(await principalFor(request, organizationId), { organizationId, ...rest, ...(state ? { states: state } : {}) }));
  }));
  app.get("/api/company/:organizationId/accounting/pm-settlements/:settlementId", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const settlementId = z.string().uuid().parse(request.params.settlementId);
    const query = z.object({ legalEntityId: legalEntityIdSchema.optional(), propertyId: propertyReferenceIdSchema.optional() }).strict().parse(request.query);
    response.json(await operations.getPmSettlement(await principalFor(request, organizationId), { scope: { organizationId, ...query }, settlementId }));
  }));
  app.get("/api/company/:organizationId/accounting/rental-bridge", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const query = periodQuery.extend({ format: z.enum(["json", "csv"]).default("json") }).parse(request.query);
    const principal = await principalFor(request, organizationId);
    const input = { organizationId, legalEntityId: query.legalEntityId, periodStart: query.periodStart, periodEnd: query.periodEnd };
    if (query.format === "csv") {
      const exported = await operations.exportBridgeCsv(principal, input);
      response.setHeader("Content-Type", "text/csv; charset=utf-8");
      response.setHeader("Content-Disposition", `attachment; filename="${exported.filename}"`);
      response.send(exported.csv);
      return;
    }
    response.json(await operations.previewBridge(principal, input));
  }));
  app.get("/api/company/:organizationId/accounting/qbo/payables", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const query = z.object({
      legalEntityId: legalEntityIdSchema, environment: environmentSchema, realmId: realmSchema, kind: z.enum(["bills", "payments"]).default("bills"),
      from: isoDateSchema.optional(), through: isoDateSchema.optional(), limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().min(1).max(512).optional(),
    }).strict().parse(request.query);
    response.json(await operations.listPayables(await principalFor(request, organizationId), { organizationId, ...query }));
  }));
  app.post("/api/company/:organizationId/accounting-commands/:commandKind", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const kind = z.enum(ACCOUNTING_OPERATION_COMMAND_KINDS).parse(request.params.commandKind);
    const envelope = commandEnvelopeSchema(accountingOperationCommandPayloadSchemas[kind]).parse(request.body);
    if (envelope.scope.organizationId !== organizationId) throw new ForbiddenCommandError("Accounting command company does not match this request.");
    const resolvePrincipal = (transaction: RentOpsQueryExecutor) => principalFor(request, organizationId, transaction);
    response.json(await operations.execute(kind, envelope, { principal: await resolvePrincipal(executor), resolvePrincipal, transport: attestTransport("web") }));
  }));
}

export { httpError as accountingHttpError };
