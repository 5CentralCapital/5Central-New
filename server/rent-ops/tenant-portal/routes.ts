import { Readable } from "node:stream";
import { RentOpsService } from "../services/service";
import type { StorageReadAdapter } from "../storage";
import { isTenantLeaseFile } from "./lease-files";
import { createTenantAccessNotifier, type TenantAccessNotifier } from "./delivery";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Router, type Express, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import type { RentOpsRepository } from "../../../shared/rent-ops-contracts";
import type { TenantAccountSummary, TenantIdentity, TenantSessionResponse } from "../../../shared/tenant-portal-contracts";
import type { RentOpsQueryExecutor } from "../repositories/postgres";
import { hashTenantPassword, validTenantPassword, verifyTenantPassword } from "./passwords";
import { eligibleTenantTenancies, presentTenantHome, resolveTenantBinding } from "./presentation";
import { PostgresTenantAccountStore, type TenantAccountRecord, type TenantAccountStore } from "./store";

declare module "express-session" {
  interface SessionData {
    tenantAccountId?: string;
    tenantSessionVersion?: number;
    tenantCsrfToken?: string;
  }
}

declare global {
  namespace Express {
    interface Request { tenantAccount?: TenantIdentity; }
  }
}

export interface TenantPortalOptions {
  repository: RentOpsRepository;
  documentStorage?: StorageReadAdapter;
  database?: RentOpsQueryExecutor;
  requireAdmin: RequestHandler;
  now?: () => Date;
  /** Dependency seam for deterministic route tests; no fallback store exists. */
  accountStore?: TenantAccountStore;
  publicAppUrl?: string;
  accessNotifier?: TenantAccessNotifier;
}

class TenantPortalError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const emailSchema = z.string().trim().email().max(240).transform((value) => value.toLowerCase());
const passwordSchema = z.string().refine(validTenantPassword, "Use 12 to 128 characters for your password.");
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const idSchema = z.string().min(1).max(160);
const ACTIVATION_TTL_MS = 24 * 60 * 60 * 1000;
const AUTH_WINDOW_MS = 15 * 60 * 1000;

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const tokenPair = () => { const token = randomBytes(32).toString("base64url"); return { token, hash: digest(token) }; };

export function tenantIdentity(record: TenantAccountRecord): TenantIdentity {
  if (record.status !== "active") throw new TenantPortalError(401, "Sign in to your tenant account.");
  return { id: record.id, email: record.email, personId: record.personId, tenancyId: record.tenancyId, status: "active" };
}

export function tenantAccountSummary(record: TenantAccountRecord): TenantAccountSummary {
  return { id: record.id, email: record.email, personId: record.personId, tenancyId: record.tenancyId, status: record.status,
    createdAt: record.createdAt, activatedAt: record.activatedAt, invitationExpiresAt: record.invitationExpiresAt };
}

export function getTenantIdentity(req: Request): TenantIdentity | undefined { return req.tenantAccount; }

function sameSecret(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" || !a || a.length > 256 || a.length !== b.length) return false;
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
}

async function establishSession(req: Request, record: TenantAccountRecord): Promise<TenantSessionResponse> {
  await new Promise<void>((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
  req.session.tenantAccountId = record.id;
  req.session.tenantSessionVersion = record.sessionVersion;
  req.session.tenantCsrfToken = randomBytes(32).toString("base64url");
  await saveSession(req);
  return { account: tenantIdentity(record), csrfToken: req.session.tenantCsrfToken };
}

function safeHandler(work: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res) => { void work(req, res).catch((error: unknown) => {
    if (res.headersSent) return;
    if (error instanceof z.ZodError) { res.status(400).json({ message: "Check the supplied fields and password requirements." }); return; }
    if (error instanceof TenantPortalError) { res.status(error.status).json({ message: error.message }); return; }
    res.status(503).json({ message: "Tenant account service is temporarily unavailable." });
  }); };
}

/** Public tenant identities never populate req.user or generic/admin markers. */
export function registerTenantPortalRoutes(app: Express, options: TenantPortalOptions) {
  if (!options.database && !options.accountStore) throw new Error("Tenant accounts require persistent storage");
  const store = options.accountStore ?? new PostgresTenantAccountStore(options.database!);
  const now = options.now ?? (() => new Date());
  const appUrl = options.publicAppUrl ?? process.env.RENT_OPS_PUBLIC_APP_URL;
  const notifier = options.accessNotifier ?? createTenantAccessNotifier();
  const router = Router();
  const documentService = new RentOpsService(options.repository, now, undefined, undefined, false, { documentStorage: options.documentStorage, allowEphemeralDocumentBindings: false });
  let activePasswordOperations = 0;

  async function passwordOperation<T>(work: () => Promise<T>): Promise<T> {
    if (activePasswordOperations >= 4) throw new TenantPortalError(429, "Sign-in is busy. Please try again shortly.");
    activePasswordOperations++;
    try { return await work(); } finally { activePasswordOperations--; }
  }

  async function limit(req: Request, scope: string, max = 20, identity?: string) {
    const timestamp = now().toISOString();
    const accepted = await store.consumeRateLimit(digest(`${scope}:ip:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`), max, AUTH_WINDOW_MS, timestamp);
    const accountAccepted = !identity || await store.consumeRateLimit(digest(`${scope}:account:${identity}`), 10, AUTH_WINDOW_MS, timestamp);
    if (!accepted || !accountAccepted) throw new TenantPortalError(429, "Too many attempts. Please try again in 15 minutes.");
  }

  router.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Pragma": "no-cache", "X-Content-Type-Options": "nosniff" });
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      // JSON + SameSite cookies are backed by explicit browser-origin and
      // per-session CSRF checks. Non-browser clients still need credentials.
      if (req.get("sec-fetch-site") === "cross-site") { res.status(403).json({ message: "Use the tenant portal to make this request." }); return; }
      const origin = req.get("origin");
      if (origin) {
        let expected: string;
        try { expected = appUrl ? new URL(appUrl).origin : `${req.protocol}://${req.get("host")}`; }
        catch { res.status(503).json({ message: "Tenant account service is temporarily unavailable." }); return; }
        if (origin !== expected) { res.status(403).json({ message: "Use the tenant portal to make this request." }); return; }
      }
      if (!req.is("application/json")) { res.status(415).json({ message: "A JSON request is required." }); return; }
    }
    next();
  });

  const requireTenant: RequestHandler = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    void (async () => {
      if (req.get("x-api-key") || req.get("authorization") || !req.session?.tenantAccountId) throw new TenantPortalError(401, "Sign in to your tenant account.");
      const record = await store.getById(req.session.tenantAccountId);
      if (!record || record.status !== "active" || record.sessionVersion !== req.session.tenantSessionVersion) throw new TenantPortalError(401, "Your session has ended. Sign in again.");
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !sameSecret(req.session.tenantCsrfToken, req.get("x-tenant-csrf"))) throw new TenantPortalError(403, "Refresh the tenant portal and try again.");
      const snapshot = await options.repository.getSnapshot();
      if (!resolveTenantBinding(snapshot, record.personId, record.tenancyId)) throw new TenantPortalError(403, "Contact management to review your account access.");
      req.tenantAccount = tenantIdentity(record);
      next();
    })().catch((error: unknown) => {
      const status = error instanceof TenantPortalError ? error.status : 503;
      res.status(status).json({ message: error instanceof TenantPortalError ? error.message : "Tenant account service is temporarily unavailable." });
    });
  };

  router.post("/auth/login", safeHandler(async (req, res) => {
    const input = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict().parse(req.body);
    await limit(req, "login", 20, input.email);
    const record = await store.getByEmail(input.email);
    const valid = await passwordOperation(() => verifyTenantPassword(input.password, record?.passwordHash));
    if (!valid || !record || record.status !== "active") throw new TenantPortalError(401, "Email or password was not accepted.");
    if (!resolveTenantBinding(await options.repository.getSnapshot(), record.personId, record.tenancyId)) throw new TenantPortalError(401, "Email or password was not accepted.");
    const current = await store.recordLogin(record.id, record.sessionVersion, now().toISOString());
    if (!current) throw new TenantPortalError(401, "Email or password was not accepted.");
    res.json(await establishSession(req, current));
  }));

  router.post("/auth/activate", safeHandler(async (req, res) => {
    const input = z.object({ token: tokenSchema, password: passwordSchema }).strict().parse(req.body);
    await limit(req, "activation", 20);
    const passwordHash = await passwordOperation(() => hashTenantPassword(input.password));
    const record = await store.consumeActivation(digest(input.token), passwordHash, now().toISOString());
    if (!record) throw new TenantPortalError(400, "This link has expired or was already used. Request a new link from management.");
    if (!resolveTenantBinding(await options.repository.getSnapshot(), record.personId, record.tenancyId)) throw new TenantPortalError(403, "Contact management to review your account access.");
    res.json(await establishSession(req, record));
  }));

  async function deliverAccess(record: TenantAccountRecord, purpose: "invitation" | "password_reset") {
    if (!notifier) throw new TenantPortalError(503, "Email delivery is unavailable. Contact management for an access link.");
    const token = tokenPair(); const timestamp = now();
    const expiresAt = new Date(timestamp.getTime() + 30 * 60 * 1000).toISOString();
    const issued = await store.issueRecovery(record.id, token.hash, expiresAt, timestamp.toISOString());
    if (!issued) return;
    try { await notifier({ issuanceId: randomUUID(), accountId: record.id, email: record.email, token: token.token, expiresAt, purpose }); }
    catch {
      // A timeout may mean accepted delivery. Invalidate only this issuance;
      // a late email cannot change a password and a newer request survives.
      await store.invalidateToken(record.id, token.hash);
      throw new TenantPortalError(503, "Email delivery could not be confirmed. Request a new link or contact management.");
    }
  }

  router.post("/auth/recovery", safeHandler(async (req, res) => {
    const input = z.object({ email: emailSchema }).strict().parse(req.body);
    await limit(req, "recovery", 10, input.email);
    if (!notifier) { res.json({ message: "Email recovery is unavailable. Contact management to request a new secure sign-in link." }); return; }
    const record = await store.getByEmail(input.email);
    if (record?.status === "active" && resolveTenantBinding(await options.repository.getSnapshot(), record.personId, record.tenancyId)) {
      // Keep the same public response for unknown accounts and delivery errors.
      try { await deliverAccess(record, "password_reset"); } catch { /* never reveal account membership */ }
    }
    res.json({ message: "If an eligible account exists, a reset link has been requested. If no email arrives, try again or contact management." });
  }));

  router.get("/auth/session", requireTenant, safeHandler(async (req, res) => {
    if (!req.session.tenantCsrfToken) { req.session.tenantCsrfToken = randomBytes(32).toString("base64url"); await saveSession(req); }
    res.json({ account: req.tenantAccount!, csrfToken: req.session.tenantCsrfToken } satisfies TenantSessionResponse);
  }));

  router.post("/auth/logout", requireTenant, safeHandler(async (req, res) => {
    await new Promise<void>((resolve, reject) => req.session.destroy((error) => error ? reject(error) : resolve()));
    res.clearCookie("connect.sid", { path: "/" });
    res.json({ message: "Signed out." });
  }));

  router.post("/auth/password", requireTenant, safeHandler(async (req, res) => {
    const input = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema }).strict().parse(req.body);
    await limit(req, "password", 10, req.tenantAccount!.id);
    const record = await store.getById(req.tenantAccount!.id);
    if (!record || record.sessionVersion !== req.session.tenantSessionVersion || !await passwordOperation(() => verifyTenantPassword(input.currentPassword, record.passwordHash))) throw new TenantPortalError(400, "Current password was not accepted.");
    const hash = await passwordOperation(() => hashTenantPassword(input.newPassword));
    const updated = await store.changePassword(record.id, record.sessionVersion, hash, now().toISOString());
    if (!updated) throw new TenantPortalError(401, "Your session has ended. Sign in again.");
    res.json(await establishSession(req, updated));
  }));

  const getTenantHome = async (identity: TenantIdentity) => {
    const snapshot = await options.repository.getSnapshot();
    const home = presentTenantHome(snapshot, identity, now().toISOString().slice(0, 10));
    if (!home) return home;
    // A positive metadata label alone must not advertise a downloadable file.
    const available = await Promise.all(home.leaseFiles.map(async file => {
      const document = snapshot.documents.find(row => row.id === file.id)!;
      const binding = await options.repository.getDocumentObjectBinding?.(file.id);
      return options.documentStorage && binding && binding.documentId === file.id
        && Boolean(binding.immutableGeneration || binding.immutableVersion)
        && document.storageKey === `documents/${binding.checksumSha256}`
        && binding.checksumSha256 === document.checksumSha256 && binding.sizeBytes === document.sizeBytes ? file : undefined;
    }));
    home.leaseFiles = available.filter((file): file is NonNullable<typeof file> => Boolean(file));
    return home;
  };
  router.get("/home", requireTenant, safeHandler(async (req, res) => {
    const home = await getTenantHome(req.tenantAccount!);
    if (!home) throw new TenantPortalError(403, "Contact management to review your account access.");
    res.json(home);
  }));
  router.get("/lease-files/:id/download", requireTenant, safeHandler(async (req, res) => {
    const unavailable = () => new TenantPortalError(404, "Lease file is unavailable.");
    if (!/^[A-Za-z0-9:_-]{1,160}$/.test(req.params.id) || Object.keys(req.query).length) throw unavailable();
    const identity = req.tenantAccount!;
    const snapshot = await options.repository.getSnapshot();
    const tenancy = resolveTenantBinding(snapshot, identity.personId, identity.tenancyId);
    const document = snapshot.documents.find(row => row.id === req.params.id);
    if (!tenancy || !document || !isTenantLeaseFile(document, identity, tenancy)) throw unavailable();
    const opened = await documentService.openVerifiedDocument(document.id);
    // The storage service rereads metadata. Recheck its actual returned row,
    // so a reassignment between authorization and opening cannot expose it.
    if (!isTenantLeaseFile(opened.document, identity, tenancy)) { opened.stream.destroy(); throw unavailable(); }
    const iterator = opened.stream[Symbol.asyncIterator]();
    const prefix: Buffer[] = [];
    let prefixLength = 0;
    try {
      while (prefixLength < 5) {
        const chunk = await iterator.next();
        if (chunk.done) break;
        const bytes = Buffer.isBuffer(chunk.value) ? chunk.value : Buffer.from(chunk.value);
        prefix.push(bytes); prefixLength += bytes.length;
      }
      if (Buffer.concat(prefix).subarray(0, 5).toString("ascii") !== "%PDF-") { opened.stream.destroy(); throw unavailable(); }
    } catch (error) { opened.stream.destroy(); throw error; }
    const stream = Readable.from((async function* () {
      try { for (const bytes of prefix) yield bytes; for (;;) { const next = await iterator.next(); if (next.done) break; yield next.value; } }
      finally { await iterator.return?.(); }
    })());
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    // Keep document scripts/origin isolated while allowing its attachment download.
    res.set("Content-Security-Policy", "sandbox allow-downloads");
    res.set("Content-Type", "application/pdf");
    const fileName = (opened.document.fileName || "lease.pdf").replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 180);
    res.set("Content-Disposition", `attachment; filename="${fileName}"`);
    stream.on("error", () => { if (!res.headersSent) res.status(503).end(); else res.destroy(); });
    res.on("close", () => { stream.destroy(); opened.stream.destroy(); });
    stream.pipe(res);
  }));
  app.use("/api/tenant", router);

  const admin = Router();
  admin.use(options.requireAdmin);
  admin.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  admin.get("/", safeHandler(async (_req, res) => {
    const accounts = await store.list();
    const snapshot = await options.repository.getSnapshot();
    res.json({ deliveryAvailable: !!notifier, accounts: accounts.map(tenantAccountSummary), eligibleTenancies: eligibleTenantTenancies(snapshot) });
  }));
  admin.post("/", safeHandler(async (req, res) => {
    const input = z.object({ email: emailSchema, personId: idSchema, tenancyId: idSchema }).strict().parse(req.body);
    const snapshot = await options.repository.getSnapshot();
    if (!eligibleTenantTenancies(snapshot).some((row) => row.personId === input.personId && row.tenancyId === input.tenancyId)) throw new TenantPortalError(400, "Select an exact current or future primary tenant before creating an account.");
    const token = tokenPair(); const timestamp = now(); const expiresAt = new Date(timestamp.getTime() + ACTIVATION_TTL_MS).toISOString();
    const account = await store.create({ id: `tenant-account-${randomUUID()}`, ...input, tokenHash: token.hash, expiresAt, now: timestamp.toISOString() });
    if (!account) throw new TenantPortalError(409, "An account already uses this email or tenancy. Reissue its secure link instead.");
    res.status(201).json({ account: tenantAccountSummary(account), activationPath: `/tenant#activate=${token.token}`, expiresAt });
  }));
  admin.post("/:id/reissue", safeHandler(async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const existing = await store.getById(id);
    if (!existing) throw new TenantPortalError(404, "Tenant account was not found.");
    if (!resolveTenantBinding(await options.repository.getSnapshot(), existing.personId, existing.tenancyId)) throw new TenantPortalError(409, "Review the person and tenancy association before reissuing access.");
    const token = tokenPair(); const timestamp = now(); const expiresAt = new Date(timestamp.getTime() + ACTIVATION_TTL_MS).toISOString();
    const account = await store.rotateActivation(id, token.hash, expiresAt, timestamp.toISOString());
    if (!account) throw new TenantPortalError(404, "Tenant account was not found.");
    res.json({ account: tenantAccountSummary(account), activationPath: `/tenant#activate=${token.token}`, expiresAt });
  }));
  admin.post("/:id/send-link", safeHandler(async (req, res) => {
    await limit(req, "admin-delivery", 20);
    const record = await store.getById(idSchema.parse(req.params.id));
    if (!record || record.status === "revoked") throw new TenantPortalError(404, "An eligible account was not found.");
    if (!resolveTenantBinding(await options.repository.getSnapshot(), record.personId, record.tenancyId)) throw new TenantPortalError(409, "Review the tenancy association first.");
    await deliverAccess(record, record.status === "active" ? "password_reset" : "invitation");
    res.json({ delivery: "accepted", message: "The email provider accepted the access-link request." });
  }));
  admin.post("/:id/revoke", safeHandler(async (req, res) => {
    const account = await store.revoke(idSchema.parse(req.params.id), now().toISOString());
    if (!account) throw new TenantPortalError(404, "Tenant account was not found.");
    res.json({ account: tenantAccountSummary(account) });
  }));
  app.use("/api/rent-ops/tenant-accounts", admin);
  return { requireTenant, getTenantIdentity, getTenantHome };
}
