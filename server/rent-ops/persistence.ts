import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const RENT_OPS_SCHEMA_VERSION = 30;
export const RENT_OPS_MIGRATION_CHECKSUM_TOKEN = "__RENT_OPS_V1_CHECKSUM__";
export const RENT_OPS_V2_MIGRATION_CHECKSUM_TOKEN = "__RENT_OPS_V2_CHECKSUM__";
export const RENT_OPS_V3_MIGRATION_CHECKSUM_TOKEN = "__RENT_OPS_V3_CHECKSUM__";
export const RENT_OPS_V4_MIGRATION_CHECKSUM_TOKEN = "__RENT_OPS_V4_CHECKSUM__";
export const RENT_OPS_V5_MIGRATION_CHECKSUM_TOKEN = "__RENT_OPS_V5_CHECKSUM__";
export const RENT_OPS_V6_MIGRATION_CHECKSUM_TOKEN = "__RENT_OPS_V6_CHECKSUM__";
export const RENT_OPS_V7_MIGRATION_CHECKSUM_TOKEN = "__RENT_OPS_V7_CHECKSUM__";
export const RENT_OPS_V8_MIGRATION_CHECKSUM_TOKEN = "__RENT_OPS_V8_CHECKSUM__";
export const RENT_OPS_V9_MIGRATION_CHECKSUM_TOKEN = "__RENT_OPS_V9_CHECKSUM__";
export const RENT_OPS_V10_MIGRATION_CHECKSUM_TOKEN = "__RENT_OPS_V10_CHECKSUM__";
export const RENT_OPS_V11_MIGRATION_CHECKSUM_TOKEN = "__RENT_OPS_V11_CHECKSUM__";
export const RENT_OPS_V12_MIGRATION_CHECKSUM_TOKEN = "__RENT_OPS_V12_CHECKSUM__";
export const RENT_OPS_V13_MIGRATION_CHECKSUM_TOKEN = "__RENT_OPS_V13_CHECKSUM__";

const RENT_OPS_MIGRATION_FILES = [
  "001_rent_ops.sql",
  "002_rent_ops_fidelity.sql",
  "003_rent_ops_operational_fidelity.sql",
  "004_rent_ops_verified_documents.sql",
  "005_rent_ops_restricted_occurrences.sql",
  "006_rent_ops_hap_fidelity.sql",
  "007_rent_ops_manual_patches.sql",
  "008_rent_ops_financial_truth.sql",
  "009_rent_ops_application_history.sql",
  "010_rent_ops_tenant_accounts.sql",
  "011_rent_ops_payments.sql",
  "012_rent_ops_recurring_billing.sql",
  "013_rent_ops_public_rate_limits.sql",
  "014_rent_ops_application_source_states.sql",
  "015_rent_ops_deposit_source_balances.sql",
  "016_rent_ops_allocation_reversals.sql",
  "017_rent_ops_recurring_root_audit.sql",
  "018_rent_ops_unknown_answer_type.sql",
  "019_rent_ops_household_account_parent.sql",
  "020_rent_ops_credit_allocations.sql",
  "021_rent_ops_observed_tenancy_status_binding.sql",
  "022_rent_ops_parity_collection_identity.sql",
  "023_rent_ops_credit_source_scope.sql",
  "024_rent_ops_admin_document_binding.sql",
  "025_rent_ops_source_financial_readiness.sql",
  "026_rent_ops_charge_definition_configuration.sql",
  "027_rent_ops_source_account_facts.sql",
  "028_rent_ops_actual_move_out_audit.sql",
  "029_rent_ops_terminal_end_at_start.sql",
  "030_rent_ops_occupancy_confirmation.sql",
] as const;

export const RENT_OPS_SUPPORTED_SCHEMA_VERSIONS = RENT_OPS_MIGRATION_FILES.map((_, index) => index + 1);

export const RENT_OPS_REQUIRED_TABLES = [
  "rent_ops_schema_meta",
  "rent_ops_schema_migrations",
  "rent_ops_properties",
  "rent_ops_units",
  "rent_ops_people",
  "rent_ops_tenancies",
  "rent_ops_household_memberships",
  "rent_ops_lease_terms",
  "rent_ops_charge_definitions",
  "rent_ops_recurring_charge_schedules",
  "rent_ops_ledger_transactions",
  "rent_ops_payment_allocations",
  "rent_ops_security_deposits",
  "rent_ops_subsidy_contracts",
  "rent_ops_subsidy_tenants",
  "rent_ops_subsidy_payments",
  "rent_ops_applications",
  "rent_ops_application_household_members",
  "rent_ops_application_requirements",
  "rent_ops_documents",
  "rent_ops_document_objects",
  "rent_ops_activity_events",
  "rent_ops_record_changes",
  "rent_ops_source_records",
  "rent_ops_import_runs",
  "rent_ops_source_payloads",
  "rent_ops_source_binaries",
  "rent_ops_restricted_parity_observations",
  "rent_ops_restricted_parity_collection_occurrences",
  "rent_ops_restricted_parity_row_occurrences",
  "rent_ops_financial_semantic_crosswalks",
  "rent_ops_prospects",
  "rent_ops_application_history",
  "rent_ops_application_interests",
  "rent_ops_application_participants",
  "rent_ops_application_requirement_occurrences",
  "rent_ops_application_template_definitions",
  "rent_ops_application_template_sections",
  "rent_ops_application_template_fields",
  "rent_ops_application_answer_occurrences",
  "rent_ops_application_history_documents",
  "rent_ops_application_history_activities",
  "rent_ops_application_history_blockers",
  "rent_ops_application_history_aggregates",
  "rent_ops_tenant_accounts",
  "rent_ops_tenant_auth_limits",
  "rent_ops_tenant_payments",
  "rent_ops_payment_events",
  "rent_ops_payment_adjustments",
  "rent_ops_billing_charges",
  "rent_ops_public_rate_limits",
] as const;

/**
 * Runtime readiness is intentionally narrower than the migration/audit
 * inventory.  The web role must be able to operate with restricted source
 * tables invisible; only business tables plus the verified-object binding
 * table and read-only migration checksum metadata belong to this contract.
 * Source records/import runs are importer
 * provenance and are not loaded by the web repository.
 */
export const RENT_OPS_RUNTIME_REQUIRED_TABLES = RENT_OPS_REQUIRED_TABLES.filter((table) => ![
  "rent_ops_schema_meta",
  "rent_ops_source_records",
  "rent_ops_import_runs",
  "rent_ops_source_payloads",
  "rent_ops_source_binaries",
  "rent_ops_financial_semantic_crosswalks",
  "rent_ops_restricted_parity_observations",
  "rent_ops_restricted_parity_collection_occurrences",
  "rent_ops_restricted_parity_row_occurrences",
].includes(table));

/** Full immutable schema inventory used by migration and independent audit. */
export const RENT_OPS_MIGRATION_REQUIRED_TABLES = RENT_OPS_REQUIRED_TABLES;
export const RENT_OPS_AUDIT_REQUIRED_TABLES = RENT_OPS_REQUIRED_TABLES;

export interface RentOpsMigrationDefinition {
  version: number;
  fileName: string;
  checksum: string;
  sourceSql: string;
  renderedSql: string;
}

/** A deliberately tiny executor boundary. It can be a pg/Neon query wrapper. */
export type RentOpsSqlExecutor = (statement: string) => Promise<void>;

export interface RentOpsSchemaEnsureResult {
  version: number;
  mode: "dry_run" | "applied";
  requiredTables: readonly string[];
  statementCount: number;
  message: string;
  checksum: string;
  migrationChecksums?: Readonly<Record<number, string>>;
}

export function rentOpsMigrationSql(): string {
  return readFileSync(fileURLToPath(new URL("./migrations/001_rent_ops.sql", import.meta.url)), "utf8");
}

export function rentOpsMigrationSqlForVersion(version: number): string {
  const fileName = Number.isInteger(version) ? RENT_OPS_MIGRATION_FILES[version - 1] : undefined;
  if (!fileName) throw new Error(`Unknown Rent Operations migration version ${version}`);
  return readFileSync(fileURLToPath(new URL(`./migrations/${fileName}`, import.meta.url)), "utf8");
}

function canonicalMigrationSql(sql: string): string {
  return sql.replace(/\r\n/g, "\n").trim() + "\n";
}

/** Checksum of the one versioned SQL source, before its runtime token is filled. */
export function rentOpsMigrationChecksum(sql = rentOpsMigrationSql()): string {
  return createHash("sha256").update(canonicalMigrationSql(sql)).digest("hex");
}

function migrationSqlWithChecksum(sql: string, checksum: string, version = 1): string {
  if (!RENT_OPS_SUPPORTED_SCHEMA_VERSIONS.includes(version)) throw new Error(`Unknown Rent Operations migration version ${version}`);
  const token = `__RENT_OPS_V${version}_CHECKSUM__`;
  if (!sql.includes(token)) throw new Error(`Rent Operations migration is missing ${token}`);
  let rendered = sql.replaceAll(token, checksum);
  for (const priorVersion of RENT_OPS_SUPPORTED_SCHEMA_VERSIONS) {
    if (priorVersion >= version) break;
    const priorToken = `__RENT_OPS_V${priorVersion}_CHECKSUM__`;
    if (rendered.includes(priorToken)) rendered = rendered.replaceAll(priorToken, rentOpsMigrationChecksumForVersion(priorVersion));
  }
  return rendered;
}

/**
 * Returns the operator-ready migration with the checksum guard rendered. The
 * checked-in SQL intentionally keeps a placeholder so its source checksum is
 * deterministic; never hand that raw source to a database operator.
 */
export function renderRentOpsMigrationSql(sql = rentOpsMigrationSql()): string {
  return migrationSqlWithChecksum(sql, rentOpsMigrationChecksum(sql));
}

export function rentOpsMigrationChecksumForVersion(version: number): string {
  return rentOpsMigrationChecksum(rentOpsMigrationSqlForVersion(version));
}

export function renderRentOpsMigrationSqlForVersion(version: number): string {
  const sourceSql = rentOpsMigrationSqlForVersion(version);
  return migrationSqlWithChecksum(sourceSql, rentOpsMigrationChecksum(sourceSql), version);
}

export function rentOpsMigrationDefinitions(): RentOpsMigrationDefinition[] {
  return RENT_OPS_SUPPORTED_SCHEMA_VERSIONS.map((version) => ({
    version,
    fileName: RENT_OPS_MIGRATION_FILES[version - 1],
    sourceSql: rentOpsMigrationSqlForVersion(version),
    checksum: rentOpsMigrationChecksumForVersion(version),
    renderedSql: renderRentOpsMigrationSqlForVersion(version),
  }));
}

/**
 * Split the versioned SQL source without splitting semicolons inside quoted
 * literals or comments. The v1 migration intentionally contains no procedural
 * SQL, but keeping this parser conservative prevents a future checksum guard
 * or text literal from being silently truncated.
 */
export function splitRentOpsSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let lineComment = false;
  let blockComment = false;
  let dollarQuote: string | null = null;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    if (dollarQuote) {
      current += character;
      if (sql.startsWith(dollarQuote, index)) {
        const suffix = dollarQuote.slice(1);
        if (suffix) {
          current += suffix;
          index += suffix.length;
        }
        dollarQuote = null;
      }
      continue;
    }
    if (lineComment) {
      current += character;
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      current += character;
      if (character === "*" && next === "/") {
        current += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (!quote && character === "-" && next === "-") {
      current += character + next;
      index += 1;
      lineComment = true;
      continue;
    }
    if (!quote && character === "/" && next === "*") {
      current += character + next;
      index += 1;
      blockComment = true;
      continue;
    }
    if (!quote && character === "$" && sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0]) {
      const match = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0] ?? "$$";
      dollarQuote = match;
      current += match;
      index += match.length - 1;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) {
        if (next === quote) {
          current += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === ";") {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
      continue;
    }
    current += character;
  }
  const trailing = current.trim();
  if (trailing) statements.push(trailing);
  return statements;
}

/**
 * Explicit schema boundary. Normal application startup never calls this with
 * apply:true. Apply is transactional and fails closed; a checksum/version
 * guard in the SQL source rejects a changed migration after v1 was applied.
 */
export async function ensureRentOpsSchema(options: { executor?: RentOpsSqlExecutor; query?: (statement: string) => Promise<{ rows: Record<string, unknown>[] }>; apply?: boolean } = {}): Promise<RentOpsSchemaEnsureResult> {
  const migrations = rentOpsMigrationDefinitions();
  const checksum = migrations.at(-1)?.checksum ?? rentOpsMigrationChecksum();
  const statements = migrations.flatMap((migration) => splitRentOpsSqlStatements(migration.renderedSql));
  const commands = ["BEGIN", ...statements, "COMMIT"];
  if (!options.apply || !options.executor) {
    return {
      version: RENT_OPS_SCHEMA_VERSION,
      mode: "dry_run",
      requiredTables: RENT_OPS_REQUIRED_TABLES,
      statementCount: commands.length,
      checksum,
      migrationChecksums: Object.fromEntries(migrations.map((migration) => [migration.version, migration.checksum])),
      message: "Rent Operations schema is not applied. Wire an explicit executor and apply:true after backup/approval.",
    };
  }
  if (process.env.NODE_ENV === "production" && !options.query) throw new Error("rent_ops_migration_query_executor_required");
  let appliedCommands = commands;
  try {
    if (options.query) {
      await options.executor("BEGIN");
      const existence = await options.query("SELECT to_regclass('public.rent_ops_schema_migrations') AS migration_table");
      const installed = existence.rows[0]?.migration_table
        ? (await options.query("SELECT version, checksum_sha256 FROM rent_ops_schema_migrations ORDER BY version")).rows
        : [];
      const installedVersions = new Set<number>();
      for (const row of installed) {
        const version = Number(row.version);
        const definition = migrations.find(migration => migration.version === version);
        if (!definition || installedVersions.has(version) || row.checksum_sha256 !== definition.checksum) throw new Error(`rent_ops_migration_checksum_mismatch:${version}`);
        installedVersions.add(version);
      }
      const highest = Math.max(0, ...Array.from(installedVersions));
      for (let version = 1; version <= highest; version++) if (!installedVersions.has(version)) throw new Error(`rent_ops_migration_chain_gap:${version}`);
      const pending = migrations.filter(migration => !installedVersions.has(migration.version));
      appliedCommands = ["BEGIN", ...pending.flatMap(migration => splitRentOpsSqlStatements(migration.renderedSql)), "COMMIT"];
      for (const statement of appliedCommands.slice(1)) await options.executor(statement);
    } else {
      // Query-less executors are retained for isolated SQL-plan fixtures only.
      // They execute the complete chain and never claim an installed version.
      for (const statement of commands) await options.executor(statement);
    }
  } catch (error) {
    try {
      await options.executor("ROLLBACK");
    } catch {
      // Preserve the original migration error; the executor owns rollback logging.
    }
    throw error;
  }
  return {
    version: RENT_OPS_SCHEMA_VERSION,
    mode: "applied",
    requiredTables: RENT_OPS_REQUIRED_TABLES,
    statementCount: appliedCommands.length,
    checksum,
    migrationChecksums: Object.fromEntries(migrations.map((migration) => [migration.version, migration.checksum])),
    message: "Rent Operations schema migration applied explicitly inside a transaction.",
  };
}
