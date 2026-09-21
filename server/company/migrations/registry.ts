import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { rentOpsMigrationDefinitions, type RentOpsMigrationDefinition } from "../../rent-ops/persistence";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const legacyPaths = ["shared/schema.ts", "server/ensureSchema.ts", "server/migrate.ts"] as const;
const registrySchema = z.object({
  schemaVersion: z.literal(1),
  authority: z.literal("server/rent-ops/persistence.ts"),
  applicationMode: z.literal("reviewed_artifacts_only"),
  legacyBaseline: z.object({
    status: z.literal("source_fingerprints_only_database_attestation_pending"),
    sources: z.array(z.object({ path: z.enum(legacyPaths), sha256 }).strict()).length(legacyPaths.length),
  }).strict(),
  migrations: z.array(z.object({
    version: z.number().int().positive(),
    fileName: z.string().regex(/^\d{3}_[a-z0-9_]+\.sql$/),
    sha256,
    predecessor: z.number().int().positive().nullable(),
    minimumServerContract: z.number().int().nonnegative(),
    minimumClientContract: z.number().int().nonnegative(),
    recovery: z.string().min(20),
  }).strict()).min(1),
}).strict();

export type CompanyMigrationRegistry = z.infer<typeof registrySchema>;
const repositoryRoot = new URL("../../../", import.meta.url);

export function loadCompanyMigrationRegistry(): CompanyMigrationRegistry {
  return registrySchema.parse(JSON.parse(readFileSync(new URL("./registry.json", import.meta.url), "utf8")));
}

export function legacySchemaFingerprints(): Record<string, string> {
  return Object.fromEntries(legacyPaths.map(path => {
    const content = readFileSync(new URL(path, repositoryRoot), "utf8").replace(/\r\n/g, "\n").trim() + "\n";
    return [path, createHash("sha256").update(content).digest("hex")];
  }));
}

/** Read-only validation: this code never connects to a database or applies SQL. */
export function verifyCompanyMigrationRegistry(
  input: unknown = loadCompanyMigrationRegistry(),
  definitions: readonly RentOpsMigrationDefinition[] = rentOpsMigrationDefinitions(),
  legacyHashes: Readonly<Record<string, string>> = legacySchemaFingerprints(),
): CompanyMigrationRegistry {
  const registry = registrySchema.parse(input);
  if (registry.migrations.length !== definitions.length) throw new Error("company_migration_registry_coverage_mismatch");
  for (let index = 0; index < definitions.length; index += 1) {
    const actual = definitions[index];
    const registered = registry.migrations[index];
    if (registered.version !== index + 1 || actual.version !== registered.version
      || registered.predecessor !== (index || null) || registered.fileName !== actual.fileName) {
      throw new Error(`company_migration_registry_order_mismatch:${index + 1}`);
    }
    if (registered.sha256 !== actual.checksum) throw new Error(`company_migration_registry_checksum_mismatch:${actual.version}`);
  }
  const paths = registry.legacyBaseline.sources.map(source => source.path);
  if (new Set(paths).size !== legacyPaths.length) throw new Error("company_legacy_baseline_coverage_mismatch");
  for (const source of registry.legacyBaseline.sources) {
    if (legacyHashes[source.path] !== source.sha256) throw new Error(`company_legacy_baseline_changed:${source.path}`);
  }
  return registry;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const registry = verifyCompanyMigrationRegistry();
  console.log(JSON.stringify({ valid: true, migrationCount: registry.migrations.length, latestVersion: registry.migrations.at(-1)!.version, legacyDatabaseAttested: false }));
}
