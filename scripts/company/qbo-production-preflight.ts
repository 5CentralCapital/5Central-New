/**
 * QuickBooks Online PRODUCTION preflight (read-only).
 *
 * Run in the deployment shell after changing the QBO_* secrets and before
 * connecting a company:
 *
 *   npm run company:qbo-preflight                     # configuration only
 *   npm run company:qbo-preflight -- --network        # + Intuit production discovery document
 *   npm run company:qbo-preflight -- --database       # + existing connections by environment
 *
 * The app treats missing or misspelled QBO_* values as "not configured"
 * instead of failing at startup, so this check is the place a typo shows up.
 * It never prints secret values, never calls the Accounting API, never
 * exchanges or refreshes tokens, and never writes to the database.
 */
import { pathToFileURL } from "node:url";
import { createQuickBooksOAuthClient } from "../../server/integrations/quickbooks/oauth";
import { createQuickBooksFetchTransport } from "../../server/integrations/quickbooks/transport";
import { loadQboTokenEncryptionKey } from "../../server/accounting/token-crypto";
import type { QuickBooksTransport } from "../../shared/accounting/quickbooks";

export const CANONICAL_APP_ORIGIN = "https://5central.capital";
export const QBO_CALLBACK_PATH = "/api/accounting/qbo/callback";

export type PreflightLevel = "ok" | "warn" | "fail";
export interface PreflightFinding {
  readonly level: PreflightLevel;
  readonly check: string;
  readonly detail: string;
}

export interface QboConnectionCount {
  readonly environment: string;
  readonly status: string;
  readonly count: number;
}

const ok = (check: string, detail: string): PreflightFinding => ({ level: "ok", check, detail });
const warn = (check: string, detail: string): PreflightFinding => ({ level: "warn", check, detail });
const fail = (check: string, detail: string): PreflightFinding => ({ level: "fail", check, detail });

function expectedRedirectUri(env: NodeJS.ProcessEnv): string {
  const configured = env.RENT_OPS_PUBLIC_APP_URL?.trim();
  let origin = CANONICAL_APP_ORIGIN;
  if (configured) {
    try { origin = new URL(configured).origin; } catch { /* reported by the app's own config checks */ }
  }
  return `${origin}${QBO_CALLBACK_PATH}`;
}

function secretShape(name: string, value: string | undefined): PreflightFinding {
  if (value === undefined || value.length === 0) return fail(name, "missing");
  if (value.trim() !== value) return fail(name, "has leading or trailing whitespace (re-paste the value)");
  if (/\s/.test(value)) return fail(name, "contains whitespace (re-paste the value)");
  return ok(name, "set");
}

/** Configuration checks. Pure: reads only the supplied environment. */
export function qboProductionConfigFindings(env: NodeJS.ProcessEnv): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  const environment = env.QBO_ENVIRONMENT;
  if (environment === "production") findings.push(ok("QBO_ENVIRONMENT", "production"));
  else if (environment?.trim().toLowerCase() === "production") findings.push(fail("QBO_ENVIRONMENT", "must be exactly \"production\" (lowercase, no spaces); the app treats this value as not configured"));
  else if (environment === "sandbox") findings.push(fail("QBO_ENVIRONMENT", "still \"sandbox\""));
  else findings.push(fail("QBO_ENVIRONMENT", environment ? "unrecognized value; the app treats QuickBooks as not configured" : "missing"));

  findings.push(secretShape("QBO_CLIENT_ID", env.QBO_CLIENT_ID));
  findings.push(secretShape("QBO_CLIENT_SECRET", env.QBO_CLIENT_SECRET));

  const redirectUri = env.QBO_REDIRECT_URI;
  const expected = expectedRedirectUri(env);
  if (!redirectUri) findings.push(fail("QBO_REDIRECT_URI", `missing; expected ${expected}`));
  else if (redirectUri !== expected) findings.push(fail("QBO_REDIRECT_URI", `is ${redirectUri}; expected exactly ${expected} (must also match the Production redirect URI in the Intuit portal)`));
  else findings.push(ok("QBO_REDIRECT_URI", redirectUri));

  const clientShapesOk = findings.every(finding => !(finding.level === "fail" && (finding.check === "QBO_CLIENT_ID" || finding.check === "QBO_CLIENT_SECRET")));
  if (redirectUri && clientShapesOk) {
    try {
      const noNetwork: QuickBooksTransport = async () => { throw new Error("preflight configuration check makes no network calls"); };
      createQuickBooksOAuthClient({ clientId: env.QBO_CLIENT_ID!, clientSecret: env.QBO_CLIENT_SECRET!, redirectUri, environment: "production", transport: noNetwork, discovery: { enabled: false } });
      findings.push(ok("OAuth client", "production client accepts this configuration"));
    } catch (error) {
      findings.push(fail("OAuth client", error instanceof Error ? error.message : "rejected the configuration"));
    }
  }

  try {
    loadQboTokenEncryptionKey(env);
    findings.push(ok("QBO_TOKEN_ENCRYPTION_KEY", "decodes to 32 bytes (keep the existing key; do not rotate it during the switch)"));
  } catch (error) {
    findings.push(fail("QBO_TOKEN_ENCRYPTION_KEY", error instanceof Error ? error.message : "invalid"));
  }

  if (env.QBO_OAUTH_DISCOVERY === "off") findings.push(warn("QBO_OAUTH_DISCOVERY", "off; documented endpoints will be used instead of Intuit's discovery document"));
  else findings.push(ok("QBO_OAUTH_DISCOVERY", "on"));

  const writeFlags = (["QBO_WRITES_ENABLED", "QBO_PRODUCTION_WRITES", "QBO_WRITE_TYPES"] as const).filter(name => env[name]?.trim());
  if (writeFlags.length) findings.push(warn("QuickBooks writes", `${writeFlags.join(", ")} set; keep writes off until the read-only comparison and books cleanup are signed off`));
  else findings.push(ok("QuickBooks writes", "off"));

  return findings;
}

/** Findings from existing (non-revoked) connection counts. */
export function qboConnectionFindings(rows: readonly QboConnectionCount[]): PreflightFinding[] {
  const sandbox = rows.filter(row => row.environment === "sandbox" && row.count > 0);
  const production = rows.filter(row => row.environment === "production" && row.count > 0);
  const findings: PreflightFinding[] = [];
  if (sandbox.length) {
    const summary = sandbox.map(row => `${row.count} ${row.status}`).join(", ");
    findings.push(warn("Sandbox connections", `${summary}. Disconnect them while the server is still on sandbox keys; after the switch the app cannot see or revoke them.`));
  } else {
    findings.push(ok("Sandbox connections", "none open"));
  }
  const productionTotal = production.reduce((sum, row) => sum + row.count, 0);
  findings.push(ok("Production connections", productionTotal ? production.map(row => `${row.count} ${row.status}`).join(", ") : "none yet"));
  return findings;
}

/** Fetch Intuit's production discovery document through the app's own OAuth client. */
export async function qboProductionDiscoveryFindings(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<PreflightFinding[]> {
  try {
    const client = createQuickBooksOAuthClient({
      clientId: env.QBO_CLIENT_ID?.trim() || "preflight",
      clientSecret: env.QBO_CLIENT_SECRET?.trim() || "preflight",
      redirectUri: env.QBO_REDIRECT_URI || expectedRedirectUri(env),
      environment: "production",
      transport: createQuickBooksFetchTransport(fetchImpl ? { fetchImpl } : {}),
      discovery: { enabled: true },
    });
    const document = await client.getDiscoveryDocument();
    const hosts = [document.authorizationEndpoint, document.tokenEndpoint, document.revokeEndpoint].map(url => new URL(url).host);
    if (!hosts.every(host => host === "intuit.com" || host.endsWith(".intuit.com"))) {
      return [fail("Production discovery", `unexpected endpoint hosts: ${hosts.join(", ")}`)];
    }
    return [ok("Production discovery", `reachable; token endpoint ${document.tokenEndpoint}`)];
  } catch (error) {
    return [warn("Production discovery", `${error instanceof Error ? error.message : "failed"}; the app falls back to the documented endpoints`)];
  }
}

export interface PreflightOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly config?: boolean;
  readonly network?: boolean;
  readonly database?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly loadConnectionCounts?: () => Promise<readonly QboConnectionCount[]>;
}

export async function runQboProductionPreflight(options: PreflightOptions = {}): Promise<PreflightFinding[]> {
  const env = options.env ?? process.env;
  const findings: PreflightFinding[] = [];
  if (options.config !== false) findings.push(...qboProductionConfigFindings(env));
  if (options.network) findings.push(...await qboProductionDiscoveryFindings(env, options.fetchImpl));
  if (options.database) {
    try {
      const load = options.loadConnectionCounts ?? (() => loadConnectionCountsFromRuntimeDatabase(env));
      findings.push(...qboConnectionFindings(await load()));
    } catch (error) {
      findings.push(fail("Database", error instanceof Error ? error.message : "connection counts could not be read"));
    }
  }
  return findings;
}

async function loadConnectionCountsFromRuntimeDatabase(env: NodeJS.ProcessEnv): Promise<QboConnectionCount[]> {
  const { createRentOpsRuntimeDatabase } = await import("../../server/rent-ops/runtime-database");
  const database = await createRentOpsRuntimeDatabase({ env });
  try {
    const result = await database.query<{ environment: string; status: string; count: string | number }>(
      `SELECT environment, status, count(*) AS count
         FROM accounting_qbo_connections
        WHERE revoked_at IS NULL
        GROUP BY environment, status
        ORDER BY environment, status`,
      [],
    );
    return result.rows.map(row => ({ environment: String(row.environment), status: String(row.status), count: Number(row.count) }));
  } finally {
    await database.close();
  }
}

export function formatFindings(findings: readonly PreflightFinding[]): string {
  const label: Record<PreflightLevel, string> = { ok: "  ok  ", warn: " warn ", fail: " FAIL " };
  const lines = findings.map(finding => `[${label[finding.level]}] ${finding.check}: ${finding.detail}`);
  const failed = findings.filter(finding => finding.level === "fail").length;
  const warned = findings.filter(finding => finding.level === "warn").length;
  lines.push("", failed ? `${failed} failed, ${warned} warning(s). Fix the failures before connecting a company.` : `No failures (${warned} warning(s)).`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const unknown = argv.filter(arg => !["--network", "--database", "--skip-config"].includes(arg));
  if (unknown.length) {
    console.error(`Unknown option(s): ${unknown.join(" ")}. Use --network, --database, --skip-config.`);
    process.exitCode = 2;
    return;
  }
  const findings = await runQboProductionPreflight({ config: !args.has("--skip-config"), network: args.has("--network"), database: args.has("--database") });
  console.log(formatFindings(findings));
  process.exitCode = findings.some(finding => finding.level === "fail") ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
