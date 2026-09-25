import assert from "node:assert/strict";
import test from "node:test";
import { rentOpsMigrationDefinitions } from "../../rent-ops/persistence";
import { legacySchemaFingerprints, loadCompanyMigrationRegistry, verifyCompanyMigrationRegistry } from "./registry";

test("one frozen migration registry covers the rental chain and additive company schema", () => {
  const registry = verifyCompanyMigrationRegistry();
  assert.equal(registry.migrations.at(-1)?.version, 52);
  assert.equal(registry.applicationMode, "reviewed_artifacts_only");
  assert.equal(registry.legacyBaseline.status, "source_fingerprints_only_database_attestation_pending");
});

test("changed historical SQL, missing entries, and reordered migrations block artifact release", () => {
  const definitions = rentOpsMigrationDefinitions();
  const changed = definitions.map(d => ({ ...d }));
  changed[0].checksum = "0".repeat(64);
  assert.throws(() => verifyCompanyMigrationRegistry(loadCompanyMigrationRegistry(), changed), /checksum_mismatch:1/);
  const missing = loadCompanyMigrationRegistry(); missing.migrations.pop();
  assert.throws(() => verifyCompanyMigrationRegistry(missing), /coverage_mismatch/);
  const reordered = loadCompanyMigrationRegistry();
  [reordered.migrations[1], reordered.migrations[2]] = [reordered.migrations[2], reordered.migrations[1]];
  assert.throws(() => verifyCompanyMigrationRegistry(reordered), /order_mismatch/);
  const predecessor = loadCompanyMigrationRegistry(); predecessor.migrations[2].predecessor = 1;
  assert.throws(() => verifyCompanyMigrationRegistry(predecessor), /order_mismatch/);
});

test("legacy schema drift and incomplete source coverage require explicit reconciliation", () => {
  const hashes = { ...legacySchemaFingerprints(), "shared/schema.ts": "f".repeat(64) };
  assert.throws(() => verifyCompanyMigrationRegistry(loadCompanyMigrationRegistry(), rentOpsMigrationDefinitions(), hashes), /legacy_baseline_changed/);
  const duplicate = loadCompanyMigrationRegistry(); duplicate.legacyBaseline.sources[1] = duplicate.legacyBaseline.sources[0];
  assert.throws(() => verifyCompanyMigrationRegistry(duplicate), /coverage_mismatch/);
  assert.throws(() => verifyCompanyMigrationRegistry({ ...loadCompanyMigrationRegistry(), applicationMode: "automatic" }));
});
