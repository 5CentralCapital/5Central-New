import assert from "node:assert/strict";
import test from "node:test";
import { resolveHostDatabaseUrl } from "./host-database-config";
import { validateRentOpsProductionConfiguration } from "./rent-ops/security/deployment-security";

test("the explicit host connection survives a provider DATABASE_URL replacement", () => {
  const env = { DATABASE_URL: "postgres://managed.example/managed", RENT_OPS_HOST_DATABASE_URL: "postgres://host.example/host", RENT_OPS_RUNTIME_DATABASE_URL: "postgres://ops.example/ops" };
  assert.equal(resolveHostDatabaseUrl(env), env.RENT_OPS_HOST_DATABASE_URL);
  assert.equal(validateRentOpsProductionConfiguration(env).blockingReasons.includes("production_database_url_invalid"), false);
  assert.equal(resolveHostDatabaseUrl({ DATABASE_URL: env.DATABASE_URL }), env.DATABASE_URL);
});

test("invalid explicit host override cannot fall back and database separation uses the selected connection", () => {
  const base = { DATABASE_URL: "postgres://managed.example/managed", RENT_OPS_RUNTIME_DATABASE_URL: "postgres://ops.example/ops" };
  for (const value of ["", "bad", " postgres://host.example/host"]) {
    assert.equal(resolveHostDatabaseUrl({ ...base, RENT_OPS_HOST_DATABASE_URL: value }), value);
    assert.ok(validateRentOpsProductionConfiguration({ ...base, RENT_OPS_HOST_DATABASE_URL: value }).blockingReasons.includes("production_database_url_invalid"));
  }
  assert.ok(validateRentOpsProductionConfiguration({ ...base, RENT_OPS_HOST_DATABASE_URL: base.RENT_OPS_RUNTIME_DATABASE_URL }).blockingReasons.includes("production_host_and_rent_ops_databases_must_be_distinct"));
});
