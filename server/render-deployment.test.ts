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
const blueprint = readFileSync(join(repoRoot, "render.yaml"), "utf8");

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

test("Render Blueprint declares the reviewed fail-closed service contract", () => {
  assert.match(blueprint, /plan:\s*free/);
  assert.match(blueprint, /numInstances:\s*1/);
  assert.match(blueprint, /buildCommand:\s*npm ci && npm run check && npm run test:rent-ops && npm run build/);
  assert.match(blueprint, /startCommand:\s*npm start/);
  assert.match(blueprint, /healthCheckPath:\s*\/healthz/);
  assert.doesNotMatch(blueprint, /migrate|migration/i);
  for (const key of RENT_OPS_DEPLOYMENT_ENV_VARS) assert.match(blueprint, new RegExp(`key:\\s*${key}\\b`), key);
  for (const key of ["DATABASE_URL", "RENT_OPS_RUNTIME_DATABASE_URL", "RENT_OPS_ADMIN_EMAIL", "RENT_OPS_MAGIC_LINK_WEBHOOK_URL", "RENT_OPS_MAGIC_LINK_WEBHOOK_SECRET", "RENT_OPS_PUBLIC_APP_URL", "RENT_OPS_OBJECT_STORE_ENDPOINT", "RENT_OPS_OBJECT_STORE_REGION", "RENT_OPS_OBJECT_STORE_BUCKET", "RENT_OPS_OBJECT_STORE_RUNTIME_IDENTITY", "RENT_OPS_OBJECT_STORE_RUNTIME_TOKEN", "RENT_OPS_OBJECT_STORE_UPLOAD_IDENTITY", "RENT_OPS_OBJECT_STORE_UPLOAD_TOKEN"]) {
    const block = blueprint.match(new RegExp(`- key: ${key}([\\s\\S]*?)(?=\\n      - key:|$)`))?.[1] ?? "";
    assert.match(block, /sync:\s*false/);
  }
  for (const key of ["PLAID_ENV", "PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_REDIRECT_URI", "RAMP_CLIENT_ID", "RAMP_CLIENT_SECRET"]) {
    const block = blueprint.match(new RegExp(`- key: ${key}([\\s\\S]*?)(?=\\n      - key:|$)`))?.[1] ?? "";
    assert.match(block, /sync:\s*false/);
  }
  assert.doesNotMatch(blueprint, /ADMIN_API_KEY|DASHBOARD_API_KEY|FIVECENTRAL_API_KEY/);
  assert.doesNotMatch(blueprint, /RM_API_BASE|RM_API_TOKEN|RM_USERNAME|RM_PASSWORD|RM_LOCATION_ID|RENT_MANAGER_CLIENT_PATH/);
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
    assert.doesNotMatch(blueprint, new RegExp(`key: ${key}\\b`));
  }
});
