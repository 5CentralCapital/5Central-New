import { createHash } from "node:crypto";
import {
  RENT_OPS_SCHEMA_VERSION,
  rentOpsMigrationDefinitions,
  splitRentOpsSqlStatements,
  type RentOpsMigrationDefinition,
} from "../../rent-ops/persistence";
import {
  RENT_OPS_ALL_TABLES,
  RENT_OPS_RUNTIME_PRIVATE_TABLES,
  createRentOpsSecurityManifest,
  renderRentOpsSecuritySql,
  type RentOpsSecurityEnvironment,
  type RentOpsSecurityManifest,
} from "../../rent-ops/security/deployment-security";
import { verifyCompanyMigrationRegistry } from "../migrations/registry";

/*
 * Reviewed production schema operations.
 *
 * This module is the only code path that applies the ordered migration chain
 * to a live database. It never runs at application startup. Every mutating
 * operation is bound to a plan digest that the operator reviewed first: the
 * plan is recomputed inside the same transaction that applies it, under an
 * advisory lock, and the work is refused if the database changed in between.
 */

/** Minimal query surface; one instance must represent ONE database session. */
export interface SchemaSession {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export class ProductionSchemaError extends Error {
  constructor(readonly code: string, message: string, readonly details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "ProductionSchemaError";
  }
}

export interface InstalledMigration {
  readonly version: number;
  readonly checksum: string;
}

export interface PendingMigration {
  readonly version: number;
  readonly fileName: string;
  readonly checksum: string;
  readonly statementCount: number;
  readonly renderedSha256: string;
}

export interface SchemaMigrationPlan {
  readonly throughVersion: number;
  readonly installedThrough: number;
  readonly installed: readonly InstalledMigration[];
  readonly pending: readonly PendingMigration[];
  /** Digest over the installed ledger and every pending rendered artifact. */
  readonly planSha256: string;
}

/** Advisory lock key shared by every schema operation (stable across releases). */
export const PRODUCTION_SCHEMA_LOCK_KEY = 5_243_113_705;
const LOCK_TIMEOUT = "15s";
const STATEMENT_TIMEOUT = "10min";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function definitionsThrough(throughVersion: number, definitions: readonly RentOpsMigrationDefinition[]): RentOpsMigrationDefinition[] {
  if (!Number.isSafeInteger(throughVersion) || throughVersion < 1 || throughVersion > definitions.length) {
    throw new ProductionSchemaError("schema_target_invalid", `Target version must be between 1 and ${definitions.length}`);
  }
  return definitions.slice(0, throughVersion);
}

/**
 * Pure plan: which reviewed artifacts are missing, given the installed
 * ledger. Refuses checksum drift, gaps, duplicates and versions newer than
 * the target (a database ahead of this build is never "fixed" by it).
 */
export function planSchemaMigration(
  installedRows: readonly { version: unknown; checksum_sha256: unknown }[],
  throughVersion: number = RENT_OPS_SCHEMA_VERSION,
  definitions: readonly RentOpsMigrationDefinition[] = rentOpsMigrationDefinitions(),
): SchemaMigrationPlan {
  const target = definitionsThrough(throughVersion, definitions);
  const installed: InstalledMigration[] = [];
  const seen = new Set<number>();
  for (const row of installedRows) {
    const version = Number(row.version);
    const checksum = typeof row.checksum_sha256 === "string" ? row.checksum_sha256 : "";
    if (!Number.isSafeInteger(version) || version < 1) throw new ProductionSchemaError("schema_ledger_invalid", "Installed migration ledger has an invalid version");
    if (seen.has(version)) throw new ProductionSchemaError("schema_ledger_duplicate", `Installed migration ledger repeats version ${version}`);
    seen.add(version);
    const definition = definitions.find(item => item.version === version);
    if (!definition) throw new ProductionSchemaError("schema_ahead_of_build", `Database has version ${version}, which this build does not know`, { version });
    if (version > throughVersion) throw new ProductionSchemaError("schema_ahead_of_target", `Database already has version ${version}, beyond target ${throughVersion}`, { version });
    if (definition.checksum !== checksum) throw new ProductionSchemaError("schema_checksum_mismatch", `Installed version ${version} does not match the reviewed artifact`, { version });
    installed.push({ version, checksum });
  }
  installed.sort((a, b) => a.version - b.version);
  const installedThrough = installed.at(-1)?.version ?? 0;
  for (let version = 1; version <= installedThrough; version += 1) {
    if (!seen.has(version)) throw new ProductionSchemaError("schema_chain_gap", `Installed migration ledger is missing version ${version}`, { version });
  }
  const pending = target
    .filter(definition => !seen.has(definition.version))
    .map(definition => ({
      version: definition.version,
      fileName: definition.fileName,
      checksum: definition.checksum,
      statementCount: splitRentOpsSqlStatements(definition.renderedSql).length,
      renderedSha256: sha256(definition.renderedSql),
    }));
  const planSha256 = sha256(JSON.stringify({
    throughVersion,
    installed: installed.map(item => [item.version, item.checksum]),
    pending: pending.map(item => [item.version, item.checksum, item.renderedSha256]),
  }));
  return { throughVersion, installedThrough, installed, pending, planSha256 };
}

async function readInstalled(session: SchemaSession): Promise<{ version: unknown; checksum_sha256: unknown }[]> {
  const exists = await session.query<{ present: string | null }>("SELECT to_regclass('public.rent_ops_schema_migrations')::text AS present");
  if (!exists.rows[0]?.present) return [];
  return (await session.query<{ version: unknown; checksum_sha256: unknown }>("SELECT version, checksum_sha256 FROM rent_ops_schema_migrations ORDER BY version")).rows;
}

/** Read-only: current ledger and the plan to reach `throughVersion`. */
export async function inspectSchema(session: SchemaSession, throughVersion: number = RENT_OPS_SCHEMA_VERSION): Promise<SchemaMigrationPlan> {
  verifyCompanyMigrationRegistry();
  return planSchemaMigration(await readInstalled(session), throughVersion);
}

async function beginGuarded(session: SchemaSession): Promise<void> {
  await session.query("BEGIN");
  await session.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
  await session.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
  await session.query("SET LOCAL idle_in_transaction_session_timeout = '15min'");
  const lock = await session.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS locked", [PRODUCTION_SCHEMA_LOCK_KEY]);
  if (lock.rows[0]?.locked !== true) throw new ProductionSchemaError("schema_operation_in_progress", "Another schema operation holds the lock");
}

async function rollbackQuietly(session: SchemaSession): Promise<void> {
  try { await session.query("ROLLBACK"); } catch { /* keep the original failure */ }
}

export interface ApplySchemaResult {
  readonly applied: readonly number[];
  readonly installedThrough: number;
  readonly planSha256: string;
}

/**
 * Apply exactly the reviewed plan in ONE transaction. `confirmPlanSha256`
 * must equal the digest printed by `inspect`/`plan`; the plan is recomputed
 * under the lock so a concurrent change aborts the whole operation.
 */
export async function applySchemaMigration(
  session: SchemaSession,
  options: { readonly throughVersion: number; readonly confirmPlanSha256: string; readonly definitions?: readonly RentOpsMigrationDefinition[] },
): Promise<ApplySchemaResult> {
  const definitions = options.definitions ?? rentOpsMigrationDefinitions();
  if (!options.definitions) verifyCompanyMigrationRegistry();
  if (!/^[a-f0-9]{64}$/.test(options.confirmPlanSha256)) throw new ProductionSchemaError("schema_confirmation_invalid", "A reviewed plan digest is required");
  await beginGuarded(session);
  try {
    const plan = planSchemaMigration(await readInstalled(session), options.throughVersion, definitions);
    if (plan.planSha256 !== options.confirmPlanSha256) {
      throw new ProductionSchemaError("schema_plan_changed", "The database or build changed since the plan was reviewed; inspect again", { planSha256: plan.planSha256 });
    }
    for (const pending of plan.pending) {
      const definition = definitions.find(item => item.version === pending.version)!;
      for (const statement of splitRentOpsSqlStatements(definition.renderedSql)) await session.query(statement);
    }
    const after = planSchemaMigration(await readInstalled(session), options.throughVersion, definitions);
    if (after.pending.length !== 0 || after.installedThrough !== options.throughVersion) {
      throw new ProductionSchemaError("schema_readback_failed", "The migration ledger does not show the target version after applying", { installedThrough: after.installedThrough });
    }
    await session.query("COMMIT");
    return { applied: plan.pending.map(item => item.version), installedThrough: after.installedThrough, planSha256: plan.planSha256 };
  } catch (error) {
    await rollbackQuietly(session);
    throw error;
  }
}

/* ------------------------------ runtime grants ----------------------------- */

export interface GrantRoles {
  readonly runtimeRole: string;
  /**
   * Importer and auditor roles are provisioned together or not at all. When
   * both are omitted the plan is runtime-only: it manages the web/worker role
   * and PUBLIC revocations and leaves every other role's privileges untouched.
   */
  readonly importerRole?: string;
  readonly auditorRole?: string;
}

/** Names that exist only while rendering a runtime-only plan; never executed. */
const RUNTIME_ONLY_PLACEHOLDERS = { importerRole: "rent_ops_unmanaged_importer_placeholder", auditorRole: "rent_ops_unmanaged_auditor_placeholder" } as const;

export interface GrantAttestation {
  /** e.g. the Neon backup branch name and its verified ledger digest. */
  readonly backup: string;
  /** Who reviewed the rendered grant SQL. */
  readonly review: string;
  /** Reference to the owner's explicit production authorization. */
  readonly authorization: string;
}

export interface GrantPlan {
  readonly statements: readonly string[];
  readonly sql: string;
  readonly grantSha256: string;
  readonly manifest: RentOpsSecurityManifest;
  /** True when only the runtime role (and PUBLIC) is managed. */
  readonly runtimeOnly: boolean;
  /** Roles the statements grant to; each must exist before applying. */
  readonly managedRoles: readonly string[];
}

const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;
/** Same shape the security manifest accepts (no spaces). */
const ATTESTATION = /^[A-Za-z0-9_.:/-]{3,160}$/;

export function planRuntimeGrants(
  roles: GrantRoles,
  attestation: GrantAttestation,
  databaseName: string,
  environment: RentOpsSecurityEnvironment = "production",
): GrantPlan {
  const hasImporter = roles.importerRole !== undefined;
  const hasAuditor = roles.auditorRole !== undefined;
  if (hasImporter !== hasAuditor) throw new ProductionSchemaError("grant_role_invalid", "Pass both --importer-role and --auditor-role, or neither for a runtime-only plan");
  const runtimeOnly = !hasImporter;
  const resolved = {
    runtimeRole: roles.runtimeRole,
    importerRole: roles.importerRole ?? RUNTIME_ONLY_PLACEHOLDERS.importerRole,
    auditorRole: roles.auditorRole ?? RUNTIME_ONLY_PLACEHOLDERS.auditorRole,
  };
  for (const [field, value] of Object.entries(resolved)) {
    if (typeof value !== "string" || !ROLE.test(value)) throw new ProductionSchemaError("grant_role_invalid", `${field} is not a valid role name`);
  }
  if (!runtimeOnly && Object.values(RUNTIME_ONLY_PLACEHOLDERS).some(name => name === resolved.importerRole || name === resolved.auditorRole)) {
    throw new ProductionSchemaError("grant_role_invalid", "Reserved placeholder role name");
  }
  if (new Set(Object.values(resolved)).size !== 3) throw new ProductionSchemaError("grant_role_invalid", "Runtime, importer and auditor roles must be distinct");
  if (!ROLE.test(databaseName)) throw new ProductionSchemaError("grant_database_invalid", "Database name is invalid");
  if (![attestation.backup, attestation.review, attestation.authorization].every(value => typeof value === "string" && ATTESTATION.test(value))) {
    throw new ProductionSchemaError("grant_attestation_invalid", "Backup, review and authorization references are required (letters, digits and _ . : / - only)");
  }
  const definitions = rentOpsMigrationDefinitions();
  const manifest = createRentOpsSecurityManifest(environment, {
    target: { databaseName, runtimeRole: resolved.runtimeRole, importerRole: resolved.importerRole, auditorRole: resolved.auditorRole },
    gates: {
      backupVerified: true,
      backupAttestation: attestation.backup,
      independentAuditVerified: true,
      independentAuditAttestation: attestation.review,
      schemaChecksumSha256: definitions.at(-1)!.checksum,
    },
    roleAttestation: {
      runtimeRoleIsNotRestrictedTableOwner: true,
      runtimeRoleNoInherit: true,
      importerRoleIsDistinct: true,
      auditorRoleIsDistinct: true,
      auditorRoleNoInherit: true,
    },
    authorization: {
      productionExplicitlyAuthorized: environment === "production",
      authorizationReference: attestation.authorization,
    },
  });
  const rendered = renderRentOpsSecuritySql(manifest, { mode: "apply" });
  if (!rendered.canApply) throw new ProductionSchemaError("grant_manifest_blocked", "The security manifest is not applicable", { reasons: rendered.blockingReasons });
  let statements = rendered.statements;
  if (runtimeOnly) {
    const placeholders = Object.values(RUNTIME_ONLY_PLACEHOLDERS).map(name => `"${name}"`);
    statements = statements.filter(statement => !placeholders.some(name => statement.includes(name)));
    statements = [statements[0]!, "-- Runtime-only plan: importer and auditor role privileges are not managed by these statements.", ...statements.slice(1)];
  }
  const sql = `${statements.join("\n")}\n`;
  const managedRoles = runtimeOnly ? [resolved.runtimeRole] : [resolved.runtimeRole, resolved.importerRole, resolved.auditorRole];
  // Bind the reviewed digest to the target environment and identity as well as the SQL.
  const grantSha256 = sha256(JSON.stringify({
    environment,
    databaseName,
    managedRoles,
    sql: statements.filter(s => !s.startsWith("--")).join("\n"),
  }));
  return { statements, sql, grantSha256, manifest, runtimeOnly, managedRoles };
}

type Privilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE" | "REFERENCES" | "TRIGGER";
const TABLE_PRIVILEGES: readonly Privilege[] = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

function tablesIn(objects: string): string[] {
  return Array.from(objects.matchAll(/"[a-z_][a-z0-9_]*"\."([a-z_][a-z0-9_]*)"/g), match => match[1]!);
}

/**
 * Expected table privileges per role, derived from the same rendered
 * statements that grant them (REVOKE ALL resets, GRANT adds, in order).
 */
export function expectedTablePrivileges(statements: readonly string[]): Map<string, Map<string, Set<Privilege>>> {
  const byRole = new Map<string, Map<string, Set<Privilege>>>();
  const tableMap = (role: string) => {
    let map = byRole.get(role);
    if (!map) byRole.set(role, map = new Map());
    return map;
  };
  for (const statement of statements) {
    const revoke = /^REVOKE ALL PRIVILEGES ON TABLE (.+) FROM "([a-z_][a-z0-9_]*)";$/.exec(statement);
    if (revoke) {
      const map = tableMap(revoke[2]!);
      for (const table of tablesIn(revoke[1]!)) map.set(table, new Set());
      continue;
    }
    const grant = /^GRANT ([A-Z, ]+) ON TABLE (.+) TO "([a-z_][a-z0-9_]*)";$/.exec(statement);
    if (grant) {
      const privileges = grant[1]!.split(",").map(value => value.trim()) as Privilege[];
      const map = tableMap(grant[3]!);
      for (const table of tablesIn(grant[2]!)) {
        const set = map.get(table) ?? new Set<Privilege>();
        for (const privilege of privileges) set.add(privilege);
        map.set(table, set);
      }
    }
  }
  return byRole;
}

export interface PrivilegeMismatch {
  readonly role: string;
  readonly table: string;
  readonly privilege: Privilege;
  readonly expected: boolean;
  readonly actual: boolean;
}

/** Compare live privileges with the manifest for every 5Central Ops table. */
export async function verifyRuntimeGrants(session: SchemaSession, plan: GrantPlan): Promise<readonly PrivilegeMismatch[]> {
  const expected = expectedTablePrivileges(plan.statements);
  const tables = Array.from(new Set<string>([...RENT_OPS_ALL_TABLES, ...RENT_OPS_RUNTIME_PRIVATE_TABLES]));
  const mismatches: PrivilegeMismatch[] = [];
  for (const [role, perTable] of Array.from(expected.entries())) {
    const rows = (await session.query<{ table_name: string; privilege: Privilege; granted: boolean }>(
      `SELECT t.table_name, p.privilege, has_table_privilege($1, format('public.%I', t.table_name), p.privilege) AS granted
         FROM unnest($2::text[]) AS t(table_name)
         CROSS JOIN unnest($3::text[]) AS p(privilege)
        WHERE to_regclass(format('public.%I', t.table_name)) IS NOT NULL`,
      [role, tables, TABLE_PRIVILEGES],
    )).rows;
    for (const row of rows) {
      const want = perTable.get(row.table_name)?.has(row.privilege) ?? false;
      if (want !== row.granted) mismatches.push({ role, table: row.table_name, privilege: row.privilege, expected: want, actual: row.granted });
    }
  }
  return mismatches;
}

export async function applyRuntimeGrants(session: SchemaSession, plan: GrantPlan, confirmGrantSha256: string): Promise<{ readonly verifiedTables: number }> {
  if (plan.grantSha256 !== confirmGrantSha256) throw new ProductionSchemaError("grant_plan_changed", "The rendered grants differ from the reviewed digest");
  const roles = [...plan.managedRoles];
  await beginGuarded(session);
  try {
    const present = (await session.query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])", [roles])).rows.map(row => row.rolname);
    const missing = roles.filter(role => !present.includes(role));
    if (missing.length) throw new ProductionSchemaError("grant_role_missing", "A manifest role does not exist in this database", { missing });
    for (const statement of plan.statements) {
      if (statement.startsWith("--") || statement === "BEGIN;" || statement === "COMMIT;") continue;
      await session.query(statement);
    }
    const mismatches = await verifyRuntimeGrants(session, plan);
    if (mismatches.length) throw new ProductionSchemaError("grant_readback_failed", "Live privileges differ from the manifest after granting", { mismatches: mismatches.slice(0, 20), count: mismatches.length });
    await session.query("COMMIT");
  } catch (error) {
    await rollbackQuietly(session);
    throw error;
  }
  return { verifiedTables: new Set([...RENT_OPS_ALL_TABLES, ...RENT_OPS_RUNTIME_PRIVATE_TABLES]).size };
}

/* --------------------------------- backups -------------------------------- */

export interface BackupComparison {
  readonly matches: boolean;
  readonly ledgerMatches: boolean;
  readonly tables: number;
  readonly differingTables: readonly string[];
  readonly ledgerSha256: string;
}

async function tableCounts(session: SchemaSession): Promise<Map<string, string>> {
  const tables = Array.from(new Set<string>([...RENT_OPS_ALL_TABLES, ...RENT_OPS_RUNTIME_PRIVATE_TABLES])).sort();
  const present = (await session.query<{ table_name: string }>(
    "SELECT t.table_name FROM unnest($1::text[]) AS t(table_name) WHERE to_regclass(format('public.%I', t.table_name)) IS NOT NULL",
    [tables],
  )).rows.map(row => row.table_name).sort();
  const counts = new Map<string, string>();
  for (const table of present) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) continue;
    const result = await session.query<{ n: string | number }>(`SELECT count(*)::text AS n FROM public."${table}"`);
    counts.set(table, String(result.rows[0]?.n ?? ""));
  }
  return counts;
}

/**
 * Verify a backup copy (e.g. a Neon branch created from production) is
 * readable and matches the source: same migration ledger and identical row
 * counts for every 5Central Ops table. Run against the source immediately
 * after creating the branch, before any writes resume.
 */
export async function compareBackup(source: SchemaSession, backup: SchemaSession): Promise<BackupComparison> {
  const [sourceLedger, backupLedger] = await Promise.all([readInstalled(source), readInstalled(backup)]);
  const normalize = (rows: { version: unknown; checksum_sha256: unknown }[]) => JSON.stringify(rows.map(row => [Number(row.version), String(row.checksum_sha256)]));
  const ledgerMatches = normalize(sourceLedger) === normalize(backupLedger);
  const [sourceCounts, backupCounts] = await Promise.all([tableCounts(source), tableCounts(backup)]);
  const names = new Set(Array.from(sourceCounts.keys()).concat(Array.from(backupCounts.keys())));
  const differingTables = Array.from(names).filter(name => sourceCounts.get(name) !== backupCounts.get(name)).sort();
  return { matches: ledgerMatches && differingTables.length === 0, ledgerMatches, tables: names.size, differingTables, ledgerSha256: sha256(normalize(backupLedger)) };
}

/** Names-only facts about the connected session; never returns credentials. */
export async function describeSession(session: SchemaSession): Promise<Record<string, unknown>> {
  const facts = (await session.query<Record<string, unknown>>(
    `SELECT current_database() AS database, current_user AS "user", current_setting('server_version') AS server_version,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`,
  )).rows[0] ?? {};
  const roles = (await session.query<{ rolname: string; rolcanlogin: boolean; rolinherit: boolean }>(
    "SELECT rolname, rolcanlogin, rolinherit FROM pg_roles WHERE rolname !~ '^pg_' AND rolname NOT IN ('cloud_admin','neon_superuser','neon_service') ORDER BY rolname",
  )).rows;
  const owner = (await session.query<{ owner: string | null }>(
    "SELECT tableowner AS owner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'rent_ops_schema_migrations'",
  )).rows[0]?.owner ?? null;
  return { ...facts, migrationLedgerOwner: owner, roles };
}
