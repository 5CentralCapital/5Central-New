import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Express, Request } from "express";
import { READ_SCOPE, validateIssuer, verifyOAuthToken, type McpPrincipal, type OAuthConfig } from "./rent-ops/mcp/oauth";

export const ADMIN_OAUTH_ISSUER = "https://dev-0mw45hx037gk3vbi.us.auth0.com/";
export const ADMIN_OAUTH_ORIGIN = "https://5-central-new.replit.app";
export const ADMIN_OAUTH_SUBJECT = "google-oauth2|118183229923455274061";
export const ADMIN_OAUTH_CALLBACK = `${ADMIN_OAUTH_ORIGIN}/api/rent-ops/auth/oauth/callback`;
export const ADMIN_OAUTH_EMAIL = "michael@5central.capital";
interface PendingLogin { state: string; verifier: string; expiresAt: number }
declare module "express-session" {
  interface SessionData {
    rentOpsOAuthPending?: PendingLogin;
    rentOpsOAuthSubject?: string;
  }
}
export function managerOAuthAllowed(env: NodeJS.ProcessEnv, subject: string): boolean {
  return subject === ADMIN_OAUTH_SUBJECT && env.RENT_OPS_ADMIN_EMAIL?.trim().toLowerCase() === ADMIN_OAUTH_EMAIL
    && (env.RENT_OPS_OAUTH_ADMIN_SUBJECTS ?? "").split(",").map(x => x.trim()).includes(subject);
}
export function consumeOAuthPending(session: { rentOpsOAuthPending?: PendingLogin }, state: unknown, now = Date.now()): PendingLogin | undefined {
  const pending = session.rentOpsOAuthPending;
  delete session.rentOpsOAuthPending;
  if (!pending || typeof state !== "string" || state.length !== pending.state.length || now >= pending.expiresAt) return;
  if (!timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))) return;
  return pending;
}
interface Options {
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  now?: () => number;
  verify?: (token: string, config: OAuthConfig) => Promise<McpPrincipal>;
  discover?: (config: OAuthConfig) => Promise<void>;
  getAdmin: () => Promise<{ id: string; role: string; email: string } | undefined>;
  csrfToken: () => string;
  limit: (ip: string) => number;
}
async function save(req: Request) {
  try { await new Promise<void>((resolve, reject) => req.session.save(e => e ? reject(e) : resolve())); }
  catch (error) { await new Promise<void>(resolve => req.session.destroy(() => resolve())); throw error; }
}
export function registerManagerOAuthRoutes(app: Express, options: Options) {
  const env = options.env ?? process.env;
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const configured = () => Boolean(env.RENT_OPS_ADMIN_OAUTH_CLIENT_ID?.match(/^[A-Za-z0-9_-]{8,128}$/)) && managerOAuthAllowed(env, ADMIN_OAUTH_SUBJECT);
  const config: OAuthConfig = { mode: "jwt", issuer: ADMIN_OAUTH_ISSUER, resource: `${ADMIN_OAUTH_ORIGIN}/mcp`, adminSubjects: [ADMIN_OAUTH_SUBJECT] };
  let issuerReady: Promise<void> | undefined;
  const ready = () => issuerReady ??= (options.discover ?? validateIssuer)(config).catch(error => { issuerReady = undefined; throw error; });
  app.get("/api/rent-ops/auth/oauth/config", (_req, res) => res.set("Cache-Control", "no-store").json({ enabled: configured() }));
  app.get("/api/rent-ops/auth/oauth/start", async (req, res) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    const retry = options.limit(req.ip || req.socket.remoteAddress || "unknown");
    if (retry) { res.set("Retry-After", String(retry)).status(429).send("Too many sign-in attempts. Try again later."); return; }
    if (!configured()) { res.status(503).send("Manager Google sign-in is not configured."); return; }
    let stage = "issuer_discovery";
    try {
      await ready();
      stage = "session_save";
      const state = randomBytes(32).toString("base64url");
      const verifier = randomBytes(48).toString("base64url");
      req.session.rentOpsOAuthPending = { state, verifier, expiresAt: now() + 5 * 60 * 1000 };
      await save(req);
      const url = new URL("authorize", ADMIN_OAUTH_ISSUER);
      url.search = new URLSearchParams({ response_type: "code", client_id: env.RENT_OPS_ADMIN_OAUTH_CLIENT_ID!, redirect_uri: ADMIN_OAUTH_CALLBACK,
        audience: config.resource, scope: `openid ${READ_SCOPE}`, connection: "google-oauth2", state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
      res.redirect(302, url.toString());
    } catch (error) {
      const rawCode = error && typeof error === "object" && "code" in error ? error.code : undefined;
      const code = typeof rawCode === "string" && (/^[0-9A-Z]{5}$/.test(rawCode) || ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"].includes(rawCode)) ? rawCode : "unclassified";
      console.error("manager_oauth_start_unavailable", { stage, code }); res.status(503).send("Manager sign-in is temporarily unavailable."); }
  });
  app.get("/api/rent-ops/auth/oauth/callback", async (req, res) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    try {
      const pending = consumeOAuthPending(req.session, req.query.state, now());
      await save(req); // Persist one-use consumption before contacting the token endpoint.
      const retry = options.limit(req.ip || req.socket.remoteAddress || "unknown");
      if (!configured() || !pending || retry || req.query.iss !== ADMIN_OAUTH_ISSUER || typeof req.query.code !== "string" || req.query.code.length > 2048 || req.query.error) throw new Error("login rejected");
      await ready();
      const response = await fetcher(new URL("oauth/token", ADMIN_OAUTH_ISSUER), { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: env.RENT_OPS_ADMIN_OAUTH_CLIENT_ID!, code: req.query.code, code_verifier: pending.verifier, redirect_uri: ADMIN_OAUTH_CALLBACK }) });
      if (!response.ok) throw new Error("token exchange rejected");
      const token = await response.json() as { access_token?: unknown; token_type?: unknown };
      if (typeof token.access_token !== "string" || token.token_type?.toString().toLowerCase() !== "bearer") throw new Error("token rejected");
      const principal = await (options.verify ?? verifyOAuthToken)(token.access_token, config);
      if (!managerOAuthAllowed(env, principal.subject) || !principal.scopes.includes(READ_SCOPE)) throw new Error("admin rejected");
      const admin = await options.getAdmin();
      if (!admin || admin.role !== "admin" || admin.email.trim().toLowerCase() !== ADMIN_OAUTH_EMAIL) throw new Error("admin rejected");
      await new Promise<void>((resolve, reject) => req.session.regenerate(e => e ? reject(e) : resolve()));
      req.session.rentOpsAdminUserId = admin.id;
      req.session.rentOpsOAuthSubject = principal.subject;
      req.session.rentOpsCsrfToken = options.csrfToken();
      await save(req);
      res.redirect(303, `${ADMIN_OAUTH_ORIGIN}/ops`);
    } catch { res.redirect(303, `${ADMIN_OAUTH_ORIGIN}/ops?login=failed`); }
  });
}
