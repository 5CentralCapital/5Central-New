/**
 * QuickBooks Online SANDBOX acceptance harness (local only).
 *
 * Starts the synthetic company demo with QBO accounting services configured
 * from QBO_* environment variables, adds a cookie session so the OAuth flow can
 * bind to `request.sessionID`, and exposes harness-only `/__sandbox/*` JSON
 * endpoints. None of these endpoints exist in production routes.
 *
 * Evidence written by the acceptance run contains only method, host, path,
 * status, intuit_tid, pass/fail, and notes. Tokens and provider bodies are
 * never written or returned.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import express, { type Request, type RequestHandler, type Response } from "express";
import { createCompanyDemoApp, COMPANY_DEMO_CSRF_TOKEN } from "../../server/company/demo";
import { SYNTHETIC_COMPANY } from "../../server/company/testing/synthetic-database";
import { AccountingError } from "../../server/accounting/errors";
import { financialSourceScopeSchema } from "../../shared/accounting";
import type { QboProviderSyncResult } from "../../server/accounting/provider-sync";
import { isQuickBooksIntegrationError } from "../../server/integrations/quickbooks/errors";
import { QUICKBOOKS_ACCOUNTING_SCOPE } from "../../server/integrations/quickbooks/oauth";
import type { ConfiguredAccountingQboServices } from "../../server/accounting";
import type { QuickBooksConnectionScope, QuickBooksJsonObject } from "../../shared/accounting/quickbooks";

export const DEFAULT_SANDBOX_PORT = 4178;
export const DEFAULT_EVIDENCE_DIR = path.join(homedir(), ".local", "state", "r-ops", "qbo-sandbox");
const SESSION_COOKIE = "rops_sandbox_sid";
const REQUIRED_VARIABLES = ["QBO_CLIENT_ID", "QBO_CLIENT_SECRET", "QBO_REDIRECT_URI", "QBO_ENVIRONMENT"] as const;

/** Returns why the harness must not start. An empty list means it may start. */
export function sandboxEnvironmentProblems(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = REQUIRED_VARIABLES.filter(name => !env[name]?.trim()).map(name => `${name} is required`);
  if (env.QBO_ENVIRONMENT && env.QBO_ENVIRONMENT !== "sandbox") problems.push("QBO_ENVIRONMENT must be exactly \"sandbox\"; this harness never runs against production");
  if (env.NODE_ENV === "production") problems.push("NODE_ENV=production is not allowed");
  return problems;
}

interface RecordedCall {
  readonly at: string;
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly status: number | null;
  readonly intuitTid: string | null;
  readonly grantType: string | null;
  readonly transportError: string | null;
  /** Internal only: SHA-256 of a refresh token returned by Intuit. Never serialized. */
  readonly refreshTokenSha256?: string;
}

type PublicCall = Omit<RecordedCall, "refreshTokenSha256" | "grantType"> & { readonly grantType?: string };

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function publicCall(call: RecordedCall): PublicCall {
  const { refreshTokenSha256: _secret, grantType, ...rest } = call;
  return { ...rest, ...(grantType ? { grantType } : {}) };
}

/** Wraps fetch and records safe request metadata for evidence. */
function createRecordingFetch(fetchImpl: typeof fetch) {
  const calls: RecordedCall[] = [];
  const recordingFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const isOAuthForm = url.host.endsWith("intuit.com") && !url.host.includes("quickbooks.api") && typeof init?.body === "string";
    const grantType = isOAuthForm ? new URLSearchParams(init!.body as string).get("grant_type") : null;
    const at = new Date().toISOString();
    try {
      const response = await fetchImpl(input, init);
      let refreshTokenSha256: string | undefined;
      if (grantType && response.ok) {
        try {
          const body = await response.clone().json() as { refresh_token?: unknown };
          if (typeof body.refresh_token === "string") refreshTokenSha256 = sha256(body.refresh_token);
        } catch { /* not JSON; the adapter reports it */ }
      }
      calls.push({ at, method, host: url.host, path: url.pathname, status: response.status, intuitTid: response.headers.get("intuit_tid") ?? response.headers.get("intuit-tid"), grantType, transportError: null, ...(refreshTokenSha256 ? { refreshTokenSha256 } : {}) });
      return response;
    } catch (error) {
      calls.push({ at, method, host: url.host, path: url.pathname, status: null, intuitTid: null, grantType, transportError: error instanceof Error ? error.name : "unknown" });
      throw error;
    }
  };
  return { fetch: recordingFetch, calls };
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

/** Harness-only cookie session: gives every browser/curl client a random
 * `request.sessionID` so the OAuth state can bind to it. */
function sandboxSession(): RequestHandler {
  return (request, response, next) => {
    let id = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (!id || !/^[A-Za-z0-9_-]{32,128}$/.test(id)) {
      id = randomBytes(24).toString("base64url");
      response.append("Set-Cookie", `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax`);
      // Make the new session visible to same-request forwards.
      request.headers.cookie = [request.headers.cookie, `${SESSION_COOKIE}=${id}`].filter(Boolean).join("; ");
    }
    (request as Request & { sessionID: string }).sessionID = id;
    next();
  };
}

function safeError(error: unknown): string {
  if (isQuickBooksIntegrationError(error)) {
    const details = Object.entries(error.details).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`).join(" ");
    return [error.code, error.status === undefined ? null : `status=${error.status}`, error.intuitTid ? `intuit_tid=${error.intuitTid}` : null, details || null].filter(Boolean).join(" ");
  }
  if (error instanceof AccountingError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return `${error.name}: ${error.message.slice(0, 240)}`;
  return "unknown error";
}

/** A sandbox sync is accepted only when every required mirror stream has
 * complete coverage and no source objects or lines were left unsupported. */
export function qboProviderSyncAcceptance(result: QboProviderSyncResult): { pass: boolean; notes: string[] } {
  const pass = result.status === "complete"
    && result.streams.length > 0
    && result.streams.every(stream => stream.result.status === "complete"
      && stream.coverageStatus === "complete"
      && stream.unsupportedCount === 0
      // Durable exceptions from earlier runs must also be resolved; a smaller
      // count in a later incremental run is not evidence of resolution.
      && stream.openExceptionCount === 0
      && stream.missingFromReplayCount === 0);
  return {
    pass,
    notes: [`status=${result.status}`, ...result.streams.map(stream => `${stream.stream}: ${stream.result.status}, mode=${stream.mode}, coverage=${stream.coverageStatus}, unsupported_this_run=${stream.unsupportedCount}, open_exceptions=${stream.openExceptionCount}, missing_from_replay=${stream.missingFromReplayCount}`)],
  };
}

const RECONCILED_ENTITIES = ["Purchase", "Bill", "BillPayment", "Deposit"] as const;

function centsOf(value: unknown): bigint | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : null;
  if (text === null || !/^-?\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.replace("-", "").split(".");
  const cents = BigInt(whole) * BigInt(100) + BigInt((fraction + "00").slice(0, 2));
  return text.startsWith("-") ? -cents : cents;
}

/**
 * Provider-vs-mirror reconciliation for the harness. Every provider object
 * must be either mirrored with current lines whose total equals its TotalAmt,
 * or carried as an open exception. Amounts are compared in integer cents.
 */
export function reconcileQboMirror(input: {
  readonly entity: string;
  readonly providerObjects: readonly QuickBooksJsonObject[];
  readonly mirroredLineCentsByObject: ReadonlyMap<string, bigint>;
  readonly openExceptionIds: ReadonlySet<string>;
}) {
  let providerTotal = BigInt(0);
  let mirroredTotal = BigInt(0);
  let exceptionTotal = BigInt(0);
  let mirroredCount = 0;
  const unexplained: string[] = [];
  const mismatched: string[] = [];
  for (const object of input.providerObjects) {
    const id = String(object.Id ?? "");
    const total = centsOf(object.TotalAmt);
    if (total !== null) providerTotal += total;
    if (input.openExceptionIds.has(id)) { if (total !== null) exceptionTotal += total; continue; }
    const mirrored = input.mirroredLineCentsByObject.get(id);
    if (mirrored === undefined) { unexplained.push(id); continue; }
    mirroredCount += 1;
    mirroredTotal += mirrored;
    if (total === null || mirrored !== total) mismatched.push(id);
  }
  const pass = unexplained.length === 0 && mismatched.length === 0 && providerTotal === mirroredTotal + exceptionTotal;
  return {
    entity: input.entity,
    pass,
    providerCount: input.providerObjects.length,
    mirroredCount,
    exceptionCount: input.openExceptionIds.size,
    providerTotalCents: providerTotal.toString(),
    mirroredTotalCents: mirroredTotal.toString(),
    exceptionTotalCents: exceptionTotal.toString(),
    unexplainedObjectIds: unexplained.slice(0, 50),
    mismatchedObjectIds: mismatched.slice(0, 50),
  };
}

const SHAPE_REDACTED_KEYS = /^(Name|DisplayName|CompanyName|GivenName|FamilyName|PrintOnCheckName|PrivateNote|Memo|Description|Line1|Line2|City|PostalCode|Addr|BillAddr|ShipAddr|PrimaryEmailAddr|PrimaryPhone|DocNumber|CheckNum|name)$/;

/** Structural summary of a provider object: keys, types, IDs, reference
 * types and amounts only; free-text and contact fields are redacted. */
export function qboObjectShape(value: unknown, depth = 0): unknown {
  if (depth > 6) return "…";
  if (Array.isArray(value)) return value.slice(0, 20).map(item => qboObjectShape(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, SHAPE_REDACTED_KEYS.test(key) ? "[redacted]" : qboObjectShape(item, depth + 1)]));
  }
  if (typeof value === "string") return value.length > 40 ? `[string:${value.length}]` : value;
  return value;
}

interface EvidenceStep {
  readonly name: string;
  readonly pass: boolean;
  readonly notes: readonly string[];
  readonly requests: readonly PublicCall[];
}

const MANUAL_CHECKLIST_ITEMS = [
  "Connect rejection with a wrong redirect URI and an environment/realm mismatch (requires editing the Intuit app or a second sandbox company).",
  "Reconnect after disconnect: run /__sandbox/connect-url again, authorize in a browser, replay/confirm, then run acceptance again.",
  "OAuth failure matrix (invalid grant, expired refresh token, malformed token response, timeout, 429, 5xx): covered by mocked tests; not reproducible on demand against the sandbox.",
  "API failure matrix (401, validation 400, 429, 5xx, timeout, malformed success): covered by mocked tests; stale-token conflict is automated here.",
  "Webhook: capture one real signed sandbox webhook and verify the raw body with intuit-signature (requires a public HTTPS endpoint).",
  "Capability gate: Payments, money movement, and Projects GraphQL stay disabled (unit-tested; no sandbox request is made).",
] as const;

export interface QboSandboxHarnessOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly evidenceDir?: string;
  readonly publicDir?: string;
  readonly now?: () => Date;
}

export async function createQboSandboxHarness(options: QboSandboxHarnessOptions) {
  const problems = sandboxEnvironmentProblems(options.env);
  if (problems.length) throw new Error(`QBO sandbox harness refused to start: ${problems.join("; ")}`);
  const accountingEnvironment: NodeJS.ProcessEnv = {
    QBO_CLIENT_ID: options.env.QBO_CLIENT_ID,
    QBO_CLIENT_SECRET: options.env.QBO_CLIENT_SECRET,
    QBO_REDIRECT_URI: options.env.QBO_REDIRECT_URI,
    QBO_ENVIRONMENT: "sandbox",
    // The synthetic database is in memory, so an ephemeral key is sufficient.
    QBO_TOKEN_ENCRYPTION_KEY: options.env.QBO_TOKEN_ENCRYPTION_KEY || `base64:${randomBytes(32).toString("base64")}`,
  };
  const recorder = createRecordingFetch(options.fetchImpl ?? fetch);
  const demo = await createCompanyDemoApp({
    ...(options.publicDir ? { publicDir: options.publicDir } : {}),
    accountingEnvironment,
    accountingQbo: { transport: { fetchImpl: recorder.fetch }, discovery: true },
  });
  const qboServices = demo.services.accounting.qbo;
  if (qboServices.status !== "configured") {
    await demo.close();
    throw new Error(`QBO sandbox harness refused to start: accounting services are ${qboServices.reason}`);
  }
  const qbo: ConfiguredAccountingQboServices = qboServices;
  const evidenceDir = options.evidenceDir ?? DEFAULT_EVIDENCE_DIR;
  const now = options.now ?? (() => new Date());
  const organizationId = SYNTHETIC_COMPANY.organizationId;
  const legalEntityId = SYNTHETIC_COMPANY.entityId;
  const lastPendingBySession = new Map<string, string>();
  let lastEvidenceFile: string | null = null;

  const sessionId = (request: Request) => (request as Request & { sessionID: string }).sessionID;
  const selfOrigin = (request: Request) => `http://127.0.0.1:${request.socket.localPort}`;
  const companyApi = `/api/company/${organizationId}/accounting/qbo`;
  /** Calls the real app routes with this request's cookie session. */
  const forward = (request: Request, pathAndQuery: string, init: RequestInit = {}) => fetch(`${selfOrigin(request)}${pathAndQuery}`, {
    ...init,
    redirect: "manual",
    headers: { cookie: request.headers.cookie ?? "", "x-rent-ops-csrf": COMPANY_DEMO_CSRF_TOKEN, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
  });
  const activeConnections = () => qbo.tokenRepository.listMetadata({ organizationId, legalEntityId, environment: "sandbox" });

  const app = express();
  app.disable("x-powered-by");
  app.use(sandboxSession());
  const sandbox = express.Router();
  sandbox.use(express.json({ limit: "64kb" }));
  sandbox.use((_request, response, next) => { response.set("Cache-Control", "no-store"); next(); });
  const handle = (work: (request: Request, response: Response) => Promise<void>): RequestHandler => (request, response) => {
    void work(request, response).catch(error => response.status(500).json({ error: safeError(error) }));
  };

  sandbox.get("/status", handle(async (request, response) => {
    const connections = await activeConnections();
    response.json({
      harness: "qbo-sandbox",
      environment: qbo.environment,
      redirectUri: accountingEnvironment.QBO_REDIRECT_URI,
      scope: QUICKBOOKS_ACCOUNTING_SCOPE,
      organizationId,
      legalEntityId,
      session: { bound: Boolean(sessionId(request)), pendingId: lastPendingBySession.get(sessionId(request)) ?? null },
      connections: connections.map(connection => ({ realmId: connection.realmId, environment: connection.environment, version: connection.version, accessTokenExpiresAt: connection.accessTokenExpiresAt, refreshTokenExpiresAt: connection.refreshTokenExpiresAt, updatedAt: connection.updatedAt })),
      providerRequests: recorder.calls.length,
      lastEvidenceFile,
    });
  }));

  sandbox.post("/connect-url", handle(async (request, response) => {
    const begin = await qbo.oauthConnection.begin({ actorId: SYNTHETIC_COMPANY.actorId, sessionBinding: sessionId(request), organizationId, legalEntityId, environment: "sandbox" });
    response.json({ authorizationUrl: begin.authorizationUrl, expiresAt: begin.expiresAt, redirectUri: accountingEnvironment.QBO_REDIRECT_URI, next: "Open authorizationUrl in a browser and sign in to the sandbox company. If the redirect to localhost cannot reach this server, copy the full redirected URL and call GET /__sandbox/replay?url=<that URL> with this same cookie." });
  }));

  sandbox.get("/replay", handle(async (request, response) => {
    const raw = typeof request.query.url === "string" ? request.query.url : "";
    let callback: URL;
    try { callback = new URL(raw); } catch { response.status(400).json({ error: "url must be the full redirected callback URL" }); return; }
    if (callback.pathname !== "/api/accounting/qbo/callback") { response.status(400).json({ error: "url path must be /api/accounting/qbo/callback" }); return; }
    const forwarded = await forward(request, `/api/accounting/qbo/callback${callback.search}`);
    const location = forwarded.headers.get("location");
    if (forwarded.status === 303 && location) {
      const params = new URL(location, selfOrigin(request)).searchParams;
      const callbackError = params.get("qboError");
      if (callbackError) {
        // The callback never renders JSON on failure; the application URL carries the code.
        response.status(409).json({ status: "rejected", error: callbackError, workspaceUrl: location });
        return;
      }
      const pendingId = params.get("qboPending");
      if (!pendingId && params.get("qboConnected")) {
        // A previously confirmed realm binding reconnects without a new confirmation.
        response.json({ status: "connected", realmId: params.get("qboConnected") });
        return;
      }
      if (pendingId) lastPendingBySession.set(sessionId(request), pendingId);
      response.json({ status: "pending_confirmation", pendingId, workspaceUrl: location, next: "POST /__sandbox/confirm to confirm the CompanyInfo binding (or open workspaceUrl in a browser with this cookie)." });
      return;
    }
    const body = await forwarded.json().catch(() => ({}));
    response.status(forwarded.status).json({ status: "callback_rejected", callbackStatus: forwarded.status, body });
  }));

  sandbox.post("/confirm", handle(async (request, response) => {
    const pendingId = typeof request.body?.pendingId === "string" ? request.body.pendingId : lastPendingBySession.get(sessionId(request));
    if (!pendingId) { response.status(409).json({ error: "No pending QuickBooks confirmation for this session. Replay the callback first." }); return; }
    const preview = await forward(request, `${companyApi}/pending?${new URLSearchParams({ legalEntityId, pendingId })}`);
    const previewBody = await preview.json().catch(() => ({}));
    if (!preview.ok) { response.status(preview.status).json({ status: "pending_unavailable", body: previewBody }); return; }
    const confirmed = await forward(request, `${companyApi}/confirm`, { method: "POST", body: JSON.stringify({ legalEntityId, pendingId, confirmRealmBinding: true }) });
    const body = await confirmed.json().catch(() => ({})) as { status?: string; scope?: QuickBooksConnectionScope };
    if (confirmed.ok) lastPendingBySession.delete(sessionId(request));
    const proof = (previewBody as { proof?: { providerCompanyName?: unknown; providerCompanyId?: unknown } }).proof;
    response.status(confirmed.status).json({ status: body.status ?? "confirm_failed", scope: body.scope ?? null, providerCompanyName: proof?.providerCompanyName ?? null, providerCompanyId: proof?.providerCompanyId ?? null });
  }));

  const loadAllProviderObjects = async (scope: QuickBooksConnectionScope, entity: string) => {
    const client = qbo.createAccountingClient(scope);
    const all: QuickBooksJsonObject[] = [];
    for (let start = 1; start < 100_000; start += 1000) {
      const page = await client.query<QuickBooksJsonObject>(`SELECT * FROM ${entity} STARTPOSITION ${start} MAXRESULTS 1000`);
      all.push(...page.entities);
      if (page.entities.length < 1000) break;
    }
    return all;
  };

  const reconcile = async (scope: QuickBooksConnectionScope) => {
    const mirror = demo.services.accounting.mirror;
    const results = [];
    for (const entity of RECONCILED_ENTITIES) {
      const providerObjects = await loadAllProviderObjects(scope, entity);
      const lines = await demo.database.db.query<{ object_id: string; cents: string }>(
        `SELECT object_id, SUM(amount_cents)::text AS cents FROM accounting_qbo_source_line_balances
          WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND is_current = true
          GROUP BY object_id`,
        [scope.organizationId, scope.legalEntityId, scope.environment, scope.realmId, entity],
      );
      const open = await mirror.listOpenSyncExceptions(scope, `transactions.${entity.toLowerCase()}`);
      results.push(reconcileQboMirror({
        entity,
        providerObjects,
        mirroredLineCentsByObject: new Map(lines.rows.map(row => [String(row.object_id), BigInt(row.cents)])),
        openExceptionIds: new Set(open.map(item => item.objectId)),
      }));
    }
    return results;
  };

  const requireScope = async (request: Request, response: Response): Promise<QuickBooksConnectionScope | null> => {
    const connections = await activeConnections();
    const requestedRealm = typeof request.body?.realmId === "string" ? request.body.realmId : typeof request.query.realmId === "string" ? request.query.realmId : undefined;
    const connection = connections.find(item => !requestedRealm || item.realmId === requestedRealm);
    if (!connection) { response.status(409).json({ error: "No confirmed sandbox connection." }); return null; }
    return { organizationId, legalEntityId, environment: "sandbox", realmId: connection.realmId };
  };

  /** Read-only mirror run: bootstrap, catch-up (optionally a full replay), open exceptions and reconciliation. */
  sandbox.post("/sync", handle(async (request, response) => {
    const scope = await requireScope(request, response);
    if (!scope) return;
    const maxPages = Number.isSafeInteger(request.body?.maxPages) && request.body.maxPages > 0 && request.body.maxPages <= 50 ? request.body.maxPages as number : 10;
    const sync = qbo.createProviderSync(scope);
    await sync.bootstrapRead();
    const result = await sync.catchUp({ maxPages, fullReplay: request.body?.fullReplay === true });
    const exceptions = await demo.services.accounting.mirror.listOpenSyncExceptions(scope);
    response.json({
      acceptance: qboProviderSyncAcceptance(result),
      streams: result.streams.map(stream => ({ stream: stream.stream, status: stream.result.status, mode: stream.mode, coverage: stream.coverageStatus, unsupportedThisRun: stream.unsupportedCount, openExceptions: stream.openExceptionCount, missingFromReplay: stream.missingFromReplayCount, pages: stream.result.pagesFetched, items: stream.result.itemsApplied, error: stream.result.error ? safeError(stream.result.error) : null })),
      exceptions: exceptions.map(item => ({ stream: item.stream, objectType: item.objectType, objectId: item.objectId, version: item.version, kind: item.kind, reasons: item.reasons })),
      coverage: await demo.services.accounting.mirror.readCoverage(financialSourceScopeSchema.parse({ provider: "qbo", ...scope })),
      reconciliation: request.body?.reconcile === false ? null : await reconcile(scope),
    });
  }));

  /** Structural, redacted view of one sandbox object for diagnosing a rejection. */
  sandbox.get("/inspect", handle(async (request, response) => {
    const scope = await requireScope(request, response);
    if (!scope) return;
    const entity = typeof request.query.entity === "string" && /^(Purchase|Bill|BillPayment|Deposit|Account|Preferences)$/.test(request.query.entity) ? request.query.entity : null;
    const id = typeof request.query.id === "string" && /^\d{1,20}$/.test(request.query.id) ? request.query.id : null;
    if (!entity) { response.status(400).json({ error: "entity is required" }); return; }
    const client = qbo.createAccountingClient(scope);
    const result = entity === "Preferences"
      ? (await client.query<QuickBooksJsonObject>("SELECT * FROM Preferences")).entities[0]
      : id ? (await client.read<QuickBooksJsonObject>(entity, id)).entity : null;
    response.json({ entity, id, shape: qboObjectShape(result ?? null) });
  }));

  sandbox.post("/acceptance", handle(async (request, response) => {
    const connections = await activeConnections();
    const requestedRealm = typeof request.body?.realmId === "string" ? request.body.realmId : undefined;
    const connection = connections.find(item => !requestedRealm || item.realmId === requestedRealm);
    if (!connection) { response.status(409).json({ error: "No confirmed sandbox connection. Use /__sandbox/connect-url, authorize, replay, and confirm first." }); return; }
    const runDisconnect = request.body?.disconnect !== false;
    const maxPages = Number.isSafeInteger(request.body?.maxPages) && request.body.maxPages > 0 && request.body.maxPages <= 20 ? request.body.maxPages as number : 3;
    const scope: QuickBooksConnectionScope = { organizationId, legalEntityId, environment: "sandbox", realmId: connection.realmId };
    const priorRequests = recorder.calls.map(publicCall);
    const steps: EvidenceStep[] = [];
    const step = async (name: string, work: (requestsSoFar: () => readonly RecordedCall[]) => Promise<{ pass: boolean; notes: string[] }>) => {
      const from = recorder.calls.length;
      const since = () => recorder.calls.slice(from);
      try {
        const result = await work(since);
        steps.push({ name, pass: result.pass, notes: result.notes, requests: since().map(publicCall) });
      } catch (error) {
        steps.push({ name, pass: false, notes: [safeError(error)], requests: since().map(publicCall) });
      }
      return steps.at(-1)!.pass;
    };
    const client = qbo.createAccountingClient(scope);
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    let readEvidence: { version: string; traceId: string | null } | null = null;
    let vendor: { id: string; syncToken: string } | null = null;
    let staleSyncToken: string | null = null;
    let updatedCompanyName: string | null = null;

    await step("companyinfo_read_bootstrap", async () => {
      const bootstrap = await qbo.createProviderSync(scope).bootstrapRead();
      readEvidence = { version: bootstrap.capability.evidenceVersion, traceId: bootstrap.capability.providerTraceId };
      return { pass: bootstrap.capability.enabled, notes: [`CompanyInfo.Id=${bootstrap.providerCompanyId}`, `companyName=${bootstrap.providerCompanyName ?? "(none)"}`, `homeCurrency=${bootstrap.homeCurrency ?? "(none)"}`, "accounting.read enabled from live provider read-back"] };
    });
    await step("provider_sync_catch_up", async () => {
      const result = await qbo.createProviderSync(scope).catchUp({ maxPages, fullReplay: request.body?.fullReplay === true });
      const acceptance = qboProviderSyncAcceptance(result);
      // Safe record-level detail: provider IDs and normalizer-authored reasons only.
      const exceptions = await demo.services.accounting.mirror.listOpenSyncExceptions(scope);
      return { pass: acceptance.pass, notes: [...acceptance.notes, ...exceptions.slice(0, 40).map(item => `exception ${item.objectType} ${item.objectId} (${item.kind}): ${item.reasons.join(" | ")}`)] };
    });
    await step("accounting_query", async () => {
      const result = await client.query<QuickBooksJsonObject>("SELECT * FROM Vendor MAXRESULTS 5");
      return { pass: result.status === 200, notes: [`Vendor rows returned=${result.entities.length}`] };
    });
    await step("enable_write_capabilities_sandbox_only", async () => {
      if (!readEvidence) return { pass: false, notes: ["skipped: no live CompanyInfo read-back evidence"] };
      if (scope.environment !== "sandbox" || qbo.environment !== "sandbox") return { pass: false, notes: ["refused: not a sandbox scope"] };
      const evidence = readEvidence as { version: string; traceId: string | null };
      const notes: string[] = [];
      for (const capability of ["accounting.create", "accounting.update"] as const) {
        if (await qbo.capabilityGate.isEnabled(scope, capability)) { notes.push(`${capability} already enabled`); continue; }
        await qbo.capabilityStore.record({ scope, capability, enabled: true, evidence: "live_provider_readback", evidenceVersion: `sandbox-harness:${evidence.version}`.slice(0, 120), verifiedAt: now().toISOString(), providerTraceId: evidence.traceId });
        notes.push(`${capability} enabled for sandbox realm ${scope.realmId} after CompanyInfo read-back`);
      }
      return { pass: true, notes };
    });
    const displayName = `R-ops sandbox test ${stamp}`;
    await step("create_and_read_back", async () => {
      const created = await client.create<QuickBooksJsonObject, QuickBooksJsonObject>("Vendor", { DisplayName: displayName });
      const id = String(created.entity.Id ?? "");
      const read = await client.read<QuickBooksJsonObject>("Vendor", id);
      vendor = { id, syncToken: String(read.entity.SyncToken ?? "") };
      const pass = Boolean(id) && read.entity.DisplayName === displayName;
      return { pass, notes: [`created Vendor Id=${id}`, `read-back DisplayName matches=${read.entity.DisplayName === displayName}`, `SyncToken=${vendor.syncToken}`] };
    });
    await step("update_with_synctoken_and_read_back", async () => {
      if (!vendor) return { pass: false, notes: ["skipped: create failed"] };
      const current = vendor as { id: string; syncToken: string };
      const before = await client.read<QuickBooksJsonObject>("Vendor", current.id);
      staleSyncToken = String(before.entity.SyncToken);
      updatedCompanyName = `R-ops sandbox updated ${stamp}`;
      await client.update({ entity: "Vendor", id: current.id, syncToken: staleSyncToken, fields: { sparse: true, CompanyName: updatedCompanyName } });
      const after = await client.read<QuickBooksJsonObject>("Vendor", current.id);
      const newToken = String(after.entity.SyncToken);
      vendor = { id: current.id, syncToken: newToken };
      const incremented = Number(newToken) > Number(staleSyncToken);
      return { pass: after.entity.CompanyName === updatedCompanyName && incremented, notes: [`SyncToken ${staleSyncToken} -> ${newToken}`, `read-back CompanyName matches=${after.entity.CompanyName === updatedCompanyName}`] };
    });
    await step("stale_synctoken_update_rejected_without_retry", async since => {
      if (!vendor || staleSyncToken === null) return { pass: false, notes: ["skipped: update failed"] };
      const current = vendor as { id: string; syncToken: string };
      let rejection: string | null = null;
      try {
        await client.update({ entity: "Vendor", id: current.id, syncToken: staleSyncToken, fields: { sparse: true, CompanyName: `R-ops stale write ${stamp}` } });
      } catch (error) { rejection = safeError(error); }
      const writes = since().filter(call => call.method === "POST" && call.host.endsWith("quickbooks.api.intuit.com")).length;
      const after = await client.read<QuickBooksJsonObject>("Vendor", current.id);
      const unchanged = after.entity.CompanyName === updatedCompanyName && String(after.entity.SyncToken) === current.syncToken;
      return { pass: rejection !== null && writes === 1 && unchanged, notes: [`provider rejection: ${rejection ?? "none (unexpected)"}`, `POST attempts=${writes} (expected 1, no retry)`, `current record unchanged=${unchanged}`] };
    });
    await step("forced_refresh_rotation", async since => {
      const before = await qbo.tokenRepository.load(scope);
      if (!before) return { pass: false, notes: ["no active connection"] };
      const beforeHash = sha256(before.refreshToken);
      await demo.database.db.query(
        "UPDATE accounting_qbo_connections SET access_token_expires_at = now() - interval '1 hour' WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND revoked_at IS NULL",
        [scope.organizationId, scope.legalEntityId, scope.environment, scope.realmId],
      );
      const read = await client.read<QuickBooksJsonObject>("CompanyInfo", scope.realmId);
      const refreshes = since().filter(call => call.grantType === "refresh_token");
      const after = await qbo.tokenRepository.load(scope);
      const persistedLatest = Boolean(after && refreshes.length === 1 && refreshes[0]!.refreshTokenSha256 === sha256(after.refreshToken));
      return {
        pass: read.status === 200 && refreshes.length === 1 && persistedLatest && (after?.version ?? 0) > (before.version ?? 0),
        notes: [`refresh calls=${refreshes.length} (expected 1)`, `persisted refresh token is the latest returned by Intuit=${persistedLatest}`, `refresh token value changed=${after ? sha256(after.refreshToken) !== beforeHash : "unknown"} (Intuit rotates the value about once every 24 hours, so an unchanged value within that window is expected and does not prove rotation handling)`, `connection version ${before.version} -> ${after?.version}`],
      };
    });
    if (runDisconnect) {
      await step("disconnect_via_route", async () => {
        const result = await forward(request, `${companyApi}/disconnect`, { method: "POST", body: JSON.stringify({ legalEntityId, realmId: scope.realmId }) });
        const body = await result.json().catch(() => ({})) as { status?: string; providerOutcome?: string; code?: string };
        return { pass: result.status === 200 && body.status === "disconnected", notes: [`HTTP ${result.status}`, `status=${body.status ?? body.code ?? "unknown"}`, `providerOutcome=${body.providerOutcome ?? "n/a"}`] };
      });
      await step("post_disconnect_requires_reconnect", async since => {
        const notes: string[] = [];
        let tokenRejected = false;
        try { await qbo.tokenManager.getAccessToken(scope); } catch (error) { tokenRejected = isQuickBooksIntegrationError(error) && error.code === "quickbooks_unauthorized"; notes.push(`token: ${safeError(error)}`); }
        let readRejected = false;
        try { await client.read("CompanyInfo", scope.realmId); } catch (error) { readRejected = true; notes.push(`read: ${safeError(error)}`); }
        const remaining = (await activeConnections()).filter(item => item.realmId === scope.realmId).length;
        const providerCalls = since().length;
        notes.push(`active connections for realm=${remaining}`, `provider requests=${providerCalls} (expected 0)`);
        return { pass: tokenRejected && readRejected && remaining === 0 && providerCalls === 0, notes };
      });
    }
    const passed = steps.filter(item => item.pass).length;
    const evidence = {
      generatedAt: now().toISOString(),
      harness: "scripts/company/qbo-sandbox.ts",
      environment: "sandbox",
      scope: { organizationId, legalEntityId, realmId: scope.realmId },
      redirectUri: accountingEnvironment.QBO_REDIRECT_URI,
      summary: { passed, failed: steps.length - passed, total: steps.length, disconnectIncluded: runDisconnect },
      steps,
      connectRequests: priorRequests,
      manualChecklistItems: MANUAL_CHECKLIST_ITEMS,
    };
    const serialized = JSON.stringify(evidence, null, 2);
    await mkdir(evidenceDir, { recursive: true });
    const file = path.join(evidenceDir, `acceptance-${stamp}.json`);
    await writeFile(file, `${serialized}\n`, { mode: 0o600 });
    await writeFile(path.join(evidenceDir, "latest.json"), `${serialized}\n`, { mode: 0o600 });
    lastEvidenceFile = file;
    response.json({ evidenceFile: file, ...evidence });
  }));

  app.use("/__sandbox", sandbox);
  app.use(demo.app);
  return { app, demo, recorder, accountingEnvironment, close: () => demo.close() };
}

async function main(): Promise<void> {
  const problems = sandboxEnvironmentProblems(process.env);
  if (problems.length) {
    console.error(`Refusing to start the QBO sandbox harness:\n- ${problems.join("\n- ")}`);
    process.exitCode = 1;
    return;
  }
  const port = Number(process.env.ROPS_SANDBOX_PORT ?? DEFAULT_SANDBOX_PORT);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("ROPS_SANDBOX_PORT must be a TCP port");
  const harness = await createQboSandboxHarness({ env: process.env, evidenceDir: process.env.ROPS_EVIDENCE_DIR || DEFAULT_EVIDENCE_DIR });
  const expectedRedirect = `http://localhost:${port}/api/accounting/qbo/callback`;
  if (harness.accountingEnvironment.QBO_REDIRECT_URI !== expectedRedirect) console.warn(`Note: QBO_REDIRECT_URI is not ${expectedRedirect}. Use /__sandbox/replay to deliver the callback to this harness.`);
  if (!process.env.QBO_TOKEN_ENCRYPTION_KEY) console.log("QBO_TOKEN_ENCRYPTION_KEY not set; using an ephemeral in-memory key.");
  const listener = harness.app.listen(port, "127.0.0.1", () => {
    const address = listener.address() as AddressInfo;
    console.log(`QBO sandbox harness: http://localhost:${address.port}/ops?section=accounting`);
    console.log(`Status: curl -s -c jar -b jar http://localhost:${address.port}/__sandbox/status`);
  });
  const close = () => { listener.close(); void harness.close(); };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
}
