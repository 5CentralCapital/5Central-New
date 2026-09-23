/**
 * Integrator tool: refresh registry.json sha256 values for migrations that are
 * not yet released (version > RELEASED_THROUGH). Released entries are frozen and
 * verified, never rewritten: the script refuses to run if a released
 * migration's file or checksum no longer matches its frozen entry.
 * Usage: npx tsx scripts/company/refresh-migration-registry.ts
 *
 * Release step: when migrations above RELEASED_THROUGH ship to production,
 * raise RELEASED_THROUGH to the highest shipped version in the same change, so
 * those entries become frozen too.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { rentOpsMigrationDefinitions } from "../../server/rent-ops/persistence";

const RELEASED_THROUGH = 48;
const RECOVERY: Record<number, string> = {
  43: "Disable MRA intake commands; keep staged packets, line registry and account outcomes, then apply a reviewed forward repair.",
  44: "Disable company document commands; keep verified immutable sources and links, then apply a reviewed forward repair.",
  45: "Disable review-case commands and the detector job; keep cases and append-only history, then apply a reviewed forward repair.",
  46: "Stop the worker and outbox dispatcher; keep queued, running and dead jobs for operator recovery, then apply a reviewed forward repair.",
  47: "Disable webhook intake, posting-policy and PM settlement commands; keep ledgers and tombstones, then apply a reviewed forward repair.",
  48: "Disable forecast commands; keep scenarios, immutable assumption versions and snapshots, then apply a reviewed forward repair.",
};
const path = new URL("../../server/company/migrations/registry.json", import.meta.url);
const registry = JSON.parse(readFileSync(path, "utf8"));
const definitions = rentOpsMigrationDefinitions();
const drift: string[] = [];
for (const definition of definitions) {
  if (definition.version > RELEASED_THROUGH) continue;
  const frozen = registry.migrations.find((entry: { version: number }) => entry.version === definition.version);
  if (!frozen) drift.push(`${definition.version}: missing from the registry`);
  else if (frozen.sha256 !== definition.checksum || frozen.fileName !== definition.fileName) drift.push(`${definition.version}: ${definition.fileName} differs from its frozen entry`);
}
if (drift.length) {
  console.error(`Released migrations changed; they are frozen and must not be edited:\n${drift.join("\n")}`);
  process.exit(1);
}
registry.migrations = registry.migrations.filter((entry: { version: number }) => entry.version <= RELEASED_THROUGH);
for (const definition of definitions) {
  if (definition.version <= RELEASED_THROUGH) continue;
  registry.migrations.push({
    version: definition.version,
    fileName: definition.fileName,
    sha256: definition.checksum,
    predecessor: definition.version - 1,
    minimumServerContract: 1,
    minimumClientContract: 1,
    recovery: RECOVERY[definition.version] ?? "Disable the affected commands; keep recorded history and apply a reviewed forward repair.",
  });
}
writeFileSync(path, JSON.stringify(registry, null, 2) + "\n");
console.log(`registry now ends at version ${registry.migrations.at(-1).version}`);
