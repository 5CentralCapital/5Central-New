import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  RENT_OPS_DEPLOYMENT_ENV_VARS,
  createRentOpsReadinessGate,
  validateRentOpsProductionConfiguration,
} from "./rent-ops/security/deployment-security";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const productionBlueprint = readFileSync(join(repoRoot, "render.yaml"), "utf8");
const stagingBlueprint = readFileSync(join(repoRoot, "render.staging.yaml"), "utf8");
const hostingRunbook = readFileSync(join(repoRoot, "docs/RENDER_DEPLOYMENT.md"), "utf8");

function serviceBlock(blueprint: string, name: string): string {
  const nameIndex = blueprint.indexOf(`name: ${name}`);
  assert.notEqual(nameIndex, -1, `missing Render service ${name}`);
  const headers = [...blueprint.matchAll(/^([ \t]*)- type:/gm)];
  const header = headers.filter(match => match.index! < nameIndex).at(-1);
  assert.ok(header, `missing service header for ${name}`);
  const next = headers.find(match => match.index! > nameIndex);
  return blueprint.slice(header.index, next?.index);
}

test("Render services belong to the environments that own their external groups", () => {
  for (const [blueprint, environment] of [[productionBlueprint, "Production"], [stagingBlueprint, "Staging"]] as const) {
    assert.match(blueprint, new RegExp(`^projects:\\n  - name: 5Central Ops\\n    environments:\\n      - name: ${environment}\\n        services:\\n`));
    assert.equal([...blueprint.matchAll(/^          - type:/gm)].length, 2);
    assert.doesNotMatch(blueprint, /^services:/m);
  }
});

function completeProductionEnvironment(): Record<string, string> {
  return {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://host-role:secret@db.example/host",
    RENT_OPS_RUNTIME_DATABASE_URL: "postgresql://runtime-role:secret@db.example/rent_ops",
    SESSION_SECRET: "session-secret",
    RENT_OPS_SESSION_SECRET: "synthetic-rent-ops-session-secret-32-characters",
    RENT_OPS_ADMIN_EMAIL: "operator@example.com",
    RENT_OPS_MAGIC_LINK_WEBHOOK_URL: "https://notify.example/rent-ops",
    RENT_OPS_MAGIC_LINK_WEBHOOK_SECRET: "webhook-secret",
    RENT_OPS_PUBLIC_APP_URL: "https://rent-ops.example",
    RENT_OPS_OBJECT_STORE_BACKEND: "private-versioned",
    RENT_OPS_OBJECT_STORE_ENDPOINT: "https://objects.example",
    RENT_OPS_OBJECT_STORE_REGION: "us-east-1",
    RENT_OPS_OBJECT_STORE_BUCKET: "rent-ops-private",
    RENT_OPS_OBJECT_STORE_PREFIX: "rent-ops/private",
    RENT_OPS_OBJECT_STORE_ENCRYPTION: "required",
    RENT_OPS_OBJECT_STORE_VERSIONING: "required",
    RENT_OPS_OBJECT_STORE_RUNTIME_IDENTITY: "runtime-get",
    RENT_OPS_OBJECT_STORE_RUNTIME_TOKEN: "runtime-token",
    RENT_OPS_OBJECT_STORE_UPLOAD_IDENTITY: "applicant-upload",
    RENT_OPS_OBJECT_STORE_UPLOAD_TOKEN: "upload-token",
    RENT_OPS_PUBLIC_LIMITER_MODE: "database",
    RENT_OPS_INSTANCE_MODE: "single",
  };
}

test("Render production and staging Blueprints use paid services and CI-gated deploys", () => {
  for (const [blueprint, branch, group, suffix] of [
    [productionBlueprint, "production", "5central-ops-production", ""],
    [stagingBlueprint, "hosting/render", "5central-ops-staging", "-staging"],
  ] as const) {
    const web = serviceBlock(blueprint, `5central-ops${suffix}-web`);
    const worker = serviceBlock(blueprint, `5central-ops${suffix}-worker`);
    for (const service of [web, worker]) {
      assert.match(service, /plan:\s*starter/);
      assert.match(service, /region:\s*virginia/);
      assert.match(service, new RegExp(`branch:\\s*${branch}\\b`));
      assert.match(service, /numInstances:\s*1/);
      assert.match(service, /buildCommand:\s*npm ci && npm run build/);
      assert.match(service, /autoDeployTrigger:\s*checksPass/);
      assert.match(service, new RegExp(`fromGroup:\\s*${group}\\b`));
      assert.match(service, /key:\s*NODE_VERSION\s*\n\s*value:\s*["']22["']/);
      assert.match(service, /key:\s*QBO_WRITES_ENABLED\s*\n\s*value:\s*["']off["']/);
      assert.match(service, /key:\s*QBO_PRODUCTION_WRITES\s*\n\s*value:\s*["']off["']/);
    }
    assert.match(web, /type:\s*web/);
    assert.match(worker, /type:\s*worker/);
    assert.match(web, /startCommand:\s*npm start/);
    assert.match(worker, /startCommand:\s*npm run worker/);
    assert.match(web, /healthCheckPath:\s*\/readyz/);
    assert.doesNotMatch(worker, /healthCheckPath:/);
    assert.doesNotMatch(worker, /key:\s*DATABASE_URL\b/);
    assert.doesNotMatch(worker, /key:\s*RENT_OPS_OBJECT_STORE_/);
    assert.doesNotMatch(blueprint, /envVarGroups:/);
    assert.doesNotMatch(blueprint, /migrate|migration/i);
    assert.doesNotMatch(blueprint, /ADMIN_API_KEY|DASHBOARD_API_KEY|FIVECENTRAL_API_KEY/);
    assert.doesNotMatch(blueprint, /RM_API_BASE|RM_API_TOKEN|RM_USERNAME|RM_PASSWORD|RM_LOCATION_ID|RENT_MANAGER_CLIENT_PATH/);
  }

  const productionWeb = serviceBlock(productionBlueprint, "5central-ops-web");
  const stagingWeb = serviceBlock(stagingBlueprint, "5central-ops-staging-web");
  assert.match(productionWeb, /fromGroup:\s*5central-ops-production-web/);
  assert.match(stagingWeb, /fromGroup:\s*5central-ops-staging-web/);
  assert.doesNotMatch(serviceBlock(productionBlueprint, "5central-ops-worker"), /fromGroup:\s*5central-ops-production-web/);
  assert.doesNotMatch(serviceBlock(stagingBlueprint, "5central-ops-staging-worker"), /fromGroup:\s*5central-ops-staging-web/);
  assert.match(stagingWeb, /key:\s*SESSION_SECRET\s*\n\s*generateValue:\s*true/);
  assert.match(stagingWeb, /key:\s*RENT_OPS_SESSION_SECRET\s*\n\s*generateValue:\s*true/);
  assert.doesNotMatch(serviceBlock(productionBlueprint, "5central-ops-worker"), /RENT_OPS_HOST_DATABASE_URL/);
  assert.doesNotMatch(serviceBlock(stagingBlueprint, "5central-ops-staging-worker"), /RENT_OPS_HOST_DATABASE_URL/);
  assert.match(productionWeb, /fivecentral-ops-production-651532007693/);
  assert.match(stagingWeb, /fivecentral-ops-staging-651532007693/);
  assert.match(productionWeb, /RENT_OPS_ADMIN_OAUTH_ORIGIN[\s\S]*?https:\/\/5central\.capital/);
  assert.match(stagingWeb, /RENT_OPS_ADMIN_OAUTH_ORIGIN\s*\n\s*value:\s*https:\/\/fivecentral-ops-staging-web\.onrender\.com/);
  assert.doesNotMatch(productionBlueprint, /onrender\.com/);
  assert.match(stagingWeb, /mail-disabled\.invalid/);
  assert.match(stagingWeb, /key:\s*RENT_OPS_TENANT_EMAIL_ENABLED\s*\n\s*value:\s*["']false["']/);
  assert.match(hostingRunbook, /Google sender OAuth client creation is still in progress/i);
  for (const key of ["RENT_OPS_RUNTIME_DATABASE_URL", "QBO_ENVIRONMENT", "QBO_CLIENT_ID", "QBO_CLIENT_SECRET", "QBO_REDIRECT_URI", "QBO_TOKEN_ENCRYPTION_KEY", "RENT_OPS_HOST_DATABASE_URL", "SESSION_SECRET", "RENT_OPS_SESSION_SECRET", "RENT_OPS_ADMIN_EMAIL", "RENT_OPS_ADMIN_OAUTH_CLIENT_ID", "RENT_OPS_OAUTH_ADMIN_SUBJECTS", "RENT_OPS_PUBLIC_APP_URL", "QBO_WEBHOOK_VERIFIER_TOKEN_PRODUCTION", "QBO_WEBHOOK_VERIFIER_TOKEN_SANDBOX", "RENT_OPS_EMAIL_ALLOWED_RECIPIENTS", "RENT_OPS_GMAIL_FROM", "RENT_OPS_GMAIL_CLIENT_ID", "RENT_OPS_GMAIL_CLIENT_SECRET", "RENT_OPS_GMAIL_REFRESH_TOKEN"]) {
    assert.ok(hostingRunbook.includes(key), `runbook must document external group key ${key}`);
  }
  for (const group of ["5central-ops-production", "5central-ops-staging", "5central-ops-production-web", "5central-ops-staging-web"]) {
    assert.ok(hostingRunbook.includes(group), `runbook must document external group ${group}`);
  }
  for (const key of RENT_OPS_DEPLOYMENT_ENV_VARS) {
    assert.ok(productionBlueprint.includes(key) || stagingBlueprint.includes(key) || hostingRunbook.includes(key), `deployment contract key missing from Blueprint and runbook: ${key}`);
  }
});

test("production configuration is valid only with distinct roles and private store gates", () => {
  const valid = validateRentOpsProductionConfiguration(completeProductionEnvironment());
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.blockingReasons, []);

  const missing = completeProductionEnvironment();
  delete missing.RENT_OPS_RUNTIME_DATABASE_URL;
  const missingValidation = validateRentOpsProductionConfiguration(missing);
  assert.equal(missingValidation.valid, false);
  assert.ok(missingValidation.blockingReasons.includes("production_rent_ops_runtime_database_url_invalid"));

  const forbidden = completeProductionEnvironment();
  forbidden.ADMIN_API_KEY = "legacy";
  const forbiddenValidation = validateRentOpsProductionConfiguration(forbidden);
  assert.equal(forbiddenValidation.valid, false);
  assert.ok(forbiddenValidation.blockingReasons.includes("production_legacy_auth_key_forbidden_admin_api_key"));

  const unsafe = completeProductionEnvironment();
  unsafe.RENT_OPS_OBJECT_STORE_BACKEND = "local";
  unsafe.RENT_OPS_PUBLIC_LIMITER_MODE = "process-memory";
  const unsafeValidation = validateRentOpsProductionConfiguration(unsafe);
  assert.equal(unsafeValidation.valid, false);
  assert.ok(unsafeValidation.blockingReasons.includes("production_private_object_store_required"));
  assert.ok(unsafeValidation.blockingReasons.includes("production_global_public_limiter_required"));
});

test("readiness is closed until startup completes and cannot expose payload data", () => {
  const readiness = createRentOpsReadinessGate();
  assert.equal(readiness.state(), "starting");
  readiness.markReady();
  assert.equal(readiness.state(), "ready");
  readiness.markFailed();
  assert.equal(readiness.state(), "failed");
});

 test("web startup rejects importer credentials instead of requesting them", () => {
  for (const key of ["RENT_OPS_DATABASE_URL", "RENT_OPS_OBJECT_STORE_IMPORTER_TOKEN"]) {
    const env = {...completeProductionEnvironment(), [key]: "operator-only-secret"};
    assert.equal(validateRentOpsProductionConfiguration(env).valid, false);
    assert.ok(validateRentOpsProductionConfiguration(env).blockingReasons.includes(`production_importer_credential_forbidden_${key.toLowerCase()}`));
    assert.doesNotMatch(productionBlueprint, new RegExp(`key: ${key}\\b`));
    assert.doesNotMatch(stagingBlueprint, new RegExp(`key: ${key}\\b`));
  }
});

test('managed Replit profile is explicit and does not require or fabricate S3 permissions', () => {
 const env=completeProductionEnvironment();
 for(const key of Object.keys(env))if(key.startsWith('RENT_OPS_OBJECT_STORE_'))delete env[key];
 Object.assign(env,{RENT_OPS_OBJECT_STORE_BACKEND:'replit-managed-gcs',RENT_OPS_OBJECT_STORE_BUCKET:'replit-objstore-58d82ba4-34e9-4e75-b7fd-1b500bf3492b',RENT_OPS_OBJECT_STORE_PREFIX:'rent-ops/private'});
 assert.deepEqual(validateRentOpsProductionConfiguration(env),{valid:true,blockingReasons:[]});
 delete env.RENT_OPS_OBJECT_STORE_BUCKET;
 assert.equal(validateRentOpsProductionConfiguration(env).valid,false);
 env.RENT_OPS_OBJECT_STORE_BACKEND='private-versioned';
 assert.ok(validateRentOpsProductionConfiguration(env).blockingReasons.includes('production_object_store_endpoint_invalid'));
});
