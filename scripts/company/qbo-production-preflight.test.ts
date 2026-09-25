import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import {
  formatFindings,
  qboConnectionFindings,
  qboProductionConfigFindings,
  runQboProductionPreflight,
  type PreflightFinding,
} from "./qbo-production-preflight";

const SECRET = "prod-secret-value-never-printed";
const good = {
  QBO_ENVIRONMENT: "production",
  QBO_CLIENT_ID: "ABprodclientid123",
  QBO_CLIENT_SECRET: SECRET,
  QBO_REDIRECT_URI: "https://5central.capital/api/accounting/qbo/callback",
  QBO_TOKEN_ENCRYPTION_KEY: `base64:${randomBytes(32).toString("base64")}`,
} as NodeJS.ProcessEnv;

const levelOf = (findings: readonly PreflightFinding[], check: string) => findings.find(finding => finding.check === check)?.level;

test("a correct production configuration has no failures and never prints secrets", () => {
  const findings = qboProductionConfigFindings(good);
  assert.deepEqual(findings.filter(finding => finding.level !== "ok"), []);
  const output = formatFindings(findings);
  assert.ok(!output.includes(SECRET));
  assert.ok(!output.includes(good.QBO_CLIENT_ID!));
  assert.ok(!output.includes(good.QBO_TOKEN_ENCRYPTION_KEY!));
});

test("QBO_ENVIRONMENT must be exactly production", () => {
  assert.equal(levelOf(qboProductionConfigFindings({ ...good, QBO_ENVIRONMENT: "sandbox" }), "QBO_ENVIRONMENT"), "fail");
  const cased = qboProductionConfigFindings({ ...good, QBO_ENVIRONMENT: "Production " });
  assert.equal(levelOf(cased, "QBO_ENVIRONMENT"), "fail");
  assert.match(cased.find(finding => finding.check === "QBO_ENVIRONMENT")!.detail, /exactly "production"/);
  assert.equal(levelOf(qboProductionConfigFindings({ ...good, QBO_ENVIRONMENT: undefined }), "QBO_ENVIRONMENT"), "fail");
});

test("pasted secrets with whitespace fail", () => {
  assert.equal(levelOf(qboProductionConfigFindings({ ...good, QBO_CLIENT_ID: " ABprod\n" }), "QBO_CLIENT_ID"), "fail");
  assert.equal(levelOf(qboProductionConfigFindings({ ...good, QBO_CLIENT_SECRET: "" }), "QBO_CLIENT_SECRET"), "fail");
});

test("the redirect URI must be the canonical host exactly", () => {
  for (const uri of [
    "https://5-central-new.replit.app/api/accounting/qbo/callback",
    "https://5central.capital/api/accounting/qbo/callback/",
    "http://5central.capital/api/accounting/qbo/callback",
  ]) {
    assert.equal(levelOf(qboProductionConfigFindings({ ...good, QBO_REDIRECT_URI: uri }), "QBO_REDIRECT_URI"), "fail", uri);
  }
  const custom = { ...good, RENT_OPS_PUBLIC_APP_URL: "https://ops.example.com/", QBO_REDIRECT_URI: "https://ops.example.com/api/accounting/qbo/callback" };
  assert.equal(levelOf(qboProductionConfigFindings(custom), "QBO_REDIRECT_URI"), "ok");
});

test("the token encryption key must decode to 32 bytes", () => {
  assert.equal(levelOf(qboProductionConfigFindings({ ...good, QBO_TOKEN_ENCRYPTION_KEY: "short-passphrase" }), "QBO_TOKEN_ENCRYPTION_KEY"), "fail");
  assert.equal(levelOf(qboProductionConfigFindings({ ...good, QBO_TOKEN_ENCRYPTION_KEY: undefined }), "QBO_TOKEN_ENCRYPTION_KEY"), "fail");
});

test("write switches and disabled discovery are warnings, not failures", () => {
  const findings = qboProductionConfigFindings({ ...good, QBO_WRITES_ENABLED: "on", QBO_OAUTH_DISCOVERY: "off" });
  assert.equal(levelOf(findings, "QuickBooks writes"), "warn");
  assert.equal(levelOf(findings, "QBO_OAUTH_DISCOVERY"), "warn");
  assert.equal(findings.filter(finding => finding.level === "fail").length, 0);
});

test("explicit off write switches are the intended state; any other value or a write-type list warns", () => {
  const off = qboProductionConfigFindings({ ...good, QBO_WRITES_ENABLED: "off", QBO_PRODUCTION_WRITES: "off" });
  assert.equal(levelOf(off, "QuickBooks writes"), "ok");
  const typo = qboProductionConfigFindings({ ...good, QBO_WRITES_ENABLED: "yes" });
  assert.equal(levelOf(typo, "QuickBooks writes"), "warn");
  assert.doesNotMatch(typo.find(finding => finding.check === "QuickBooks writes")!.detail, /yes/);
  const types = qboProductionConfigFindings({ ...good, QBO_WRITES_ENABLED: "off", QBO_WRITE_TYPES: "Vendor:create" });
  assert.equal(levelOf(types, "QuickBooks writes"), "warn");
});

test("open sandbox connections are flagged for disconnection before the switch", () => {
  const findings = qboConnectionFindings([
    { environment: "sandbox", status: "active", count: 1 },
    { environment: "production", status: "active", count: 2 },
  ]);
  assert.equal(levelOf(findings, "Sandbox connections"), "warn");
  assert.match(findings.find(finding => finding.check === "Production connections")!.detail, /2 active/);
  assert.equal(levelOf(qboConnectionFindings([]), "Sandbox connections"), "ok");
});

test("network check reads Intuit's production discovery document through the app's OAuth client", async () => {
  const requested: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return new Response(JSON.stringify({
      issuer: "https://oauth.platform.intuit.com/op/v1",
      authorization_endpoint: "https://appcenter.intuit.com/connect/oauth2",
      token_endpoint: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      revocation_endpoint: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const findings = await runQboProductionPreflight({ env: good, config: false, network: true, fetchImpl });
  assert.equal(requested.length, 1);
  assert.match(requested[0], /^https:\/\/developer\.api\.intuit\.com\/\.well-known\/openid_configuration/);
  assert.equal(levelOf(findings, "Production discovery"), "ok");
});

test("database check reports load failures without throwing", async () => {
  const findings = await runQboProductionPreflight({ env: good, config: false, database: true, loadConnectionCounts: async () => { throw new Error("RENT_OPS_RUNTIME_DATABASE_URL must be configured"); } });
  assert.equal(levelOf(findings, "Database"), "fail");
});
