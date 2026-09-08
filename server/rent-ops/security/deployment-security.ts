/**
 * Render and validate the least-privilege role boundary for Rent Ops.
 *
 * This module is deliberately a pure artifact builder. It never reads an
 * environment variable, opens a database connection, or executes SQL. The
 * generated SQL assumes it is reviewed and run by an owner/operator role.
 *
 * The web role receives only the application tables listed below. The raw RM
 * payload and binary binding tables are explicitly revoked from it. Verified
 * document bindings are a separate narrow private class: the runtime and
 * importer may SELECT/INSERT those bindings, while raw source/parity tables
 * remain importer/auditor-only. Neither role is made an owner by this artifact.
 */

export const RENT_OPS_SECURITY_VERSION = "rent-ops-security/v1" as const;

/**
 * Production deployment configuration is intentionally explicit.  Render
 * supplies these names exactly; startup rejects aliases and unsafe fallbacks
 * before opening a database, session store, or object-store client.
 */
export const RENT_OPS_DEPLOYMENT_ENVIRONMENT = "production" as const;
export const RENT_OPS_LEGACY_AUTH_KEY_ENV_VARS = ["ADMIN_API_KEY", "DASHBOARD_API_KEY", "FIVECENTRAL_API_KEY"] as const;
// Common deployment inputs. Edge mode additionally requires its attestation secret.
export const RENT_OPS_DEPLOYMENT_ENV_VARS = [
  "NODE_ENV",
  "DATABASE_URL",
  "RENT_OPS_RUNTIME_DATABASE_URL",
  "RENT_OPS_DATABASE_URL",
  "SESSION_SECRET",
  "RENT_OPS_SESSION_SECRET",
  "RENT_OPS_ADMIN_EMAIL",
  "RENT_OPS_MAGIC_LINK_WEBHOOK_URL",
  "RENT_OPS_MAGIC_LINK_WEBHOOK_SECRET",
  "RENT_OPS_PUBLIC_APP_URL",
  "RENT_OPS_OBJECT_STORE_BACKEND",
  "RENT_OPS_OBJECT_STORE_ENDPOINT",
  "RENT_OPS_OBJECT_STORE_REGION",
  "RENT_OPS_OBJECT_STORE_BUCKET",
  "RENT_OPS_OBJECT_STORE_PREFIX",
  "RENT_OPS_OBJECT_STORE_ENCRYPTION",
  "RENT_OPS_OBJECT_STORE_VERSIONING",
  "RENT_OPS_OBJECT_STORE_RUNTIME_IDENTITY",
  "RENT_OPS_OBJECT_STORE_RUNTIME_TOKEN",
  "RENT_OPS_OBJECT_STORE_UPLOAD_IDENTITY",
  "RENT_OPS_OBJECT_STORE_UPLOAD_TOKEN",
  "RENT_OPS_OBJECT_STORE_IMPORTER_IDENTITY",
  "RENT_OPS_OBJECT_STORE_IMPORTER_TOKEN",
  "RENT_OPS_PUBLIC_LIMITER_MODE",
  "RENT_OPS_INSTANCE_MODE",
] as const;

export type RentOpsDeploymentEnvironment = Readonly<Record<string, string | undefined>>;

export interface RentOpsProductionConfigurationValidation {
  valid: boolean;
  blockingReasons: readonly string[];
}

function configured(env: RentOpsDeploymentEnvironment, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" && value.trim() === value && value.length > 0 ? value : undefined;
}

function postgresUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "postgres:" || parsed.protocol === "postgresql:") && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function safeDeploymentValue(value: string | undefined, pattern: RegExp): boolean {
  return Boolean(value && pattern.test(value));
}

/** Pure production gate used by startup and no-network deployment tests. */
export function validateRentOpsProductionConfiguration(
  env: RentOpsDeploymentEnvironment = process.env,
): RentOpsProductionConfigurationValidation {
  const blockingReasons: string[] = [];
  if (configured(env, "NODE_ENV") !== RENT_OPS_DEPLOYMENT_ENVIRONMENT) blockingReasons.push("production_node_env_required");
  for (const key of ["DATABASE_URL", "RENT_OPS_RUNTIME_DATABASE_URL", "RENT_OPS_DATABASE_URL"] as const) {
    if (!postgresUrl(configured(env, key))) blockingReasons.push(`production_${key.toLowerCase()}_invalid`);
  }
  const hostDatabase = configured(env, "DATABASE_URL");
  const runtimeDatabase = configured(env, "RENT_OPS_RUNTIME_DATABASE_URL");
  const importerDatabase = configured(env, "RENT_OPS_DATABASE_URL");
  if (runtimeDatabase && importerDatabase && runtimeDatabase === importerDatabase) blockingReasons.push("production_runtime_importer_database_must_be_distinct");
  if (hostDatabase && (hostDatabase === runtimeDatabase || hostDatabase === importerDatabase)) blockingReasons.push("production_host_and_rent_ops_databases_must_be_distinct");
  const emailProvider = configured(env, "RENT_OPS_TENANT_EMAIL_PROVIDER");
  const gmailDelivery = emailProvider === "gmail" || emailProvider === "replit-gmail";
  if (gmailDelivery) {
    if (configured(env, "RENT_OPS_TENANT_EMAIL_ENABLED") !== "true") blockingReasons.push("production_email_delivery_disabled");
    if (!safeDeploymentValue(configured(env, "RENT_OPS_GMAIL_FROM"), /^[^\s@]+@[^\s@]+\.[^\s@]+$/)) blockingReasons.push("production_gmail_sender_required");
    if (emailProvider === "gmail") for (const key of ["RENT_OPS_GMAIL_CLIENT_ID", "RENT_OPS_GMAIL_CLIENT_SECRET", "RENT_OPS_GMAIL_REFRESH_TOKEN"]) if (!configured(env,key)) blockingReasons.push(`production_${key.toLowerCase()}_required`);
  }
  for (const key of ["SESSION_SECRET", "RENT_OPS_SESSION_SECRET", "RENT_OPS_ADMIN_EMAIL", ...(!gmailDelivery ? ["RENT_OPS_MAGIC_LINK_WEBHOOK_SECRET"] : [])]) {
    if (!configured(env, key)) blockingReasons.push(`production_${key.toLowerCase()}_required`);
  }
  for (const key of ["RENT_OPS_PUBLIC_APP_URL", ...(!gmailDelivery ? ["RENT_OPS_MAGIC_LINK_WEBHOOK_URL"] : [])]) {
    if (!safeDeploymentValue(configured(env, key), /^https:\/\/[^\s]+$/)) blockingReasons.push(`production_${key.toLowerCase()}_invalid`);
  }
  if (configured(env, "RENT_OPS_OBJECT_STORE_BACKEND") !== "private-versioned") blockingReasons.push("production_private_object_store_required");
  if (!safeDeploymentValue(configured(env, "RENT_OPS_OBJECT_STORE_ENDPOINT"), /^https:\/\/[^\s]+$/)) blockingReasons.push("production_object_store_endpoint_invalid");
  if (!safeDeploymentValue(configured(env, "RENT_OPS_OBJECT_STORE_REGION"), /^[A-Za-z0-9._-]{1,64}$/)) blockingReasons.push("production_object_store_region_invalid");
  for (const key of ["RENT_OPS_OBJECT_STORE_BUCKET", "RENT_OPS_OBJECT_STORE_PREFIX"] as const) {
    if (!safeDeploymentValue(configured(env, key), /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/)) blockingReasons.push(`production_${key.toLowerCase()}_invalid`);
  }
  if (configured(env, "RENT_OPS_OBJECT_STORE_ENCRYPTION") !== "required") blockingReasons.push("production_object_store_encryption_required");
  if (configured(env, "RENT_OPS_OBJECT_STORE_VERSIONING") !== "required") blockingReasons.push("production_object_store_versioning_required");
  const identityKeys = [
    "RENT_OPS_OBJECT_STORE_RUNTIME_IDENTITY",
    "RENT_OPS_OBJECT_STORE_UPLOAD_IDENTITY",
    "RENT_OPS_OBJECT_STORE_IMPORTER_IDENTITY",
  ] as const;
  for (const key of identityKeys) if (!safeDeploymentValue(configured(env, key), /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)) blockingReasons.push(`production_${key.toLowerCase()}_invalid`);
  const identities = identityKeys.map((key) => configured(env, key)).filter((value): value is string => Boolean(value));
  if (new Set(identities).size !== identities.length) blockingReasons.push("production_object_store_identities_must_be_distinct");
  for (const key of ["RENT_OPS_OBJECT_STORE_RUNTIME_TOKEN", "RENT_OPS_OBJECT_STORE_UPLOAD_TOKEN", "RENT_OPS_OBJECT_STORE_IMPORTER_TOKEN"] as const) {
    if (!configured(env, key)) blockingReasons.push(`production_${key.toLowerCase()}_required`);
  }
  const limiterMode = configured(env, "RENT_OPS_PUBLIC_LIMITER_MODE");
  if (limiterMode !== "edge-attestation" && limiterMode !== "database") blockingReasons.push("production_global_public_limiter_required");
  if (limiterMode === "edge-attestation" && !configured(env, "RENT_OPS_EDGE_ATTESTATION_SECRET")) blockingReasons.push("production_rent_ops_edge_attestation_secret_required");
  if (limiterMode === "database" && (configured(env, "RENT_OPS_SESSION_SECRET")?.length ?? 0) < 32) blockingReasons.push("production_database_limiter_session_secret_too_short");
  if (configured(env, "RENT_OPS_INSTANCE_MODE") !== "single") blockingReasons.push("production_single_instance_limiter_mode_required");
  for (const key of RENT_OPS_LEGACY_AUTH_KEY_ENV_VARS) {
    if (configured(env, key)) blockingReasons.push(`production_legacy_auth_key_forbidden_${key.toLowerCase()}`);
  }
  return { valid: blockingReasons.length === 0, blockingReasons: uniqueStrings(blockingReasons) };
}

export function assertRentOpsProductionConfiguration(env: RentOpsDeploymentEnvironment = process.env): void {
  const validation = validateRentOpsProductionConfiguration(env);
  if (!validation.valid) throw new Error(`rent_ops_production_configuration_blocked:${validation.blockingReasons.join(",")}`);
}

export interface RentOpsReadinessGate {
  state(): "starting" | "ready" | "failed";
  markReady(): void;
  markFailed(): void;
}

export function createRentOpsReadinessGate(): RentOpsReadinessGate {
  let current: "starting" | "ready" | "failed" = "starting";
  return {
    state: () => current,
    markReady: () => { current = "ready"; },
    markFailed: () => { current = "failed"; },
  };
}

/**
 * Runtime and importer credentials are deliberately separate environment
 * variables.  These names are the executable contract used by
 * runtime-database.ts and restricted-migration-cli.ts; deployment manifests
 * must not invent environment-specific aliases that the programs never read.
 */
export const RENT_OPS_RUNTIME_DATABASE_URL_ENV = "RENT_OPS_RUNTIME_DATABASE_URL" as const;
export const RENT_OPS_IMPORTER_DATABASE_URL_ENV = "RENT_OPS_DATABASE_URL" as const;

export const RENT_OPS_RESTRICTED_TABLES = [
  "rent_ops_source_payloads",
  "rent_ops_source_binaries",
  "rent_ops_restricted_parity_observations",
  "rent_ops_restricted_parity_collection_occurrences",
  "rent_ops_restricted_parity_row_occurrences",
  "rent_ops_financial_semantic_crosswalks",
] as const;

/** Verified object bindings have a separate least-privilege runtime seam. */
export const RENT_OPS_RUNTIME_PRIVATE_TABLES = ["rent_ops_document_objects"] as const;
export const RENT_OPS_IMPORTER_PRIVATE_TABLES = [...RENT_OPS_RUNTIME_PRIVATE_TABLES] as const;

/** Independent auditor access covers binding controls, the redacted change ledger, and restricted rows. */
export const RENT_OPS_AUDITOR_TABLES = [...RENT_OPS_RUNTIME_PRIVATE_TABLES, "rent_ops_record_changes", ...RENT_OPS_RESTRICTED_TABLES] as const;

/** Application-created accounts, receipts and counters are never imported from RM. */
export const RENT_OPS_APPLICATION_TABLES = [
  "rent_ops_tenant_accounts",
  "rent_ops_tenant_auth_limits",
  "rent_ops_tenant_payments",
  "rent_ops_payment_events",
  "rent_ops_payment_adjustments",
  "rent_ops_billing_charges",
  "rent_ops_public_rate_limits",
] as const;

/** Hashed rate-limit counters alone require DELETE for bounded expiration cleanup. */
export const RENT_OPS_RUNTIME_EPHEMERAL_TABLES = [
  "rent_ops_tenant_auth_limits",
  "rent_ops_public_rate_limits",
] as const;

/** All tables created by the current Rent Ops migration, including restricted tables. */
export const RENT_OPS_ALL_TABLES = [
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
  "rent_ops_documents",
  ...RENT_OPS_RUNTIME_PRIVATE_TABLES,
  "rent_ops_activity_events",
  "rent_ops_record_changes",
  "rent_ops_source_records",
  "rent_ops_import_runs",
  ...RENT_OPS_RESTRICTED_TABLES,
  ...RENT_OPS_APPLICATION_TABLES,
] as const;

/** Tables written by the staff application and authenticated tenant services. */
export const RENT_OPS_RUNTIME_WRITABLE_TABLES = [
  "rent_ops_properties",
  "rent_ops_units",
  "rent_ops_people",
  "rent_ops_tenancies",
  "rent_ops_household_memberships",
  "rent_ops_lease_terms",
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
  "rent_ops_activity_events",
  "rent_ops_record_changes",
  ...RENT_OPS_APPLICATION_TABLES,
] as const;

/**
 * Metadata tables read by PostgresRentOpsRepository.getSnapshot(). They are
 * intentionally read-only for the web role; the importer owns their writes.
 */
export const RENT_OPS_RUNTIME_READ_ONLY_TABLES = [
  "rent_ops_charge_definitions",
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
] as const;

/** Migration ledgers are inspected by imports but changed only by the migration owner. */
export const RENT_OPS_IMPORTER_READ_ONLY_TABLES = [
  "rent_ops_schema_meta",
  "rent_ops_schema_migrations",
  "rent_ops_record_changes",
] as const;

/** Append-only tables use INSERT plus idempotency SELECT, never UPDATE/DELETE. */
export const RENT_OPS_APPEND_ONLY_TABLES = [
  "rent_ops_recurring_charge_schedules",
  "rent_ops_ledger_transactions",
  "rent_ops_payment_allocations",
  "rent_ops_activity_events",
  "rent_ops_record_changes",
  "rent_ops_payment_events",
  "rent_ops_billing_charges",
] as const;

/** Importer-only operational facts: the web role may read definitions, but
 * only the importer may establish them, and never by UPDATE. */
export const RENT_OPS_IMPORTER_INSERT_ONLY_TABLES = [
  "rent_ops_charge_definitions",
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
] as const;

/** Every normal table queried by the web repository, in loadSnapshot order. */
export const RENT_OPS_RUNTIME_TABLES = [
  ...RENT_OPS_RUNTIME_WRITABLE_TABLES,
  ...RENT_OPS_RUNTIME_READ_ONLY_TABLES,
] as const;

/** Tables needed by the importer to make the normalized import idempotent. */
export const RENT_OPS_IMPORTER_TABLES = [
  ...RENT_OPS_RUNTIME_TABLES.filter((table) =>
    !(RENT_OPS_IMPORTER_READ_ONLY_TABLES as readonly string[]).includes(table)
    && !(RENT_OPS_APPLICATION_TABLES as readonly string[]).includes(table)),
  "rent_ops_source_records",
  "rent_ops_import_runs",
  ...RENT_OPS_IMPORTER_READ_ONLY_TABLES,
] as const;

/** The migration uses application-assigned varchar IDs, so no sequence is needed today. */
export const RENT_OPS_SEQUENCE_NAMES = [] as const;

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const SAFE_ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const SAFE_REFERENCE = /^[A-Za-z0-9_.:/-]{1,160}$/;
const SHA256 = /^[a-f0-9]{64}$/i;

export type RentOpsSecurityEnvironment = "staging" | "production";
export type RentOpsSecurityMode = "dry_run" | "apply";
export type RentOpsTablePrivilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE";
export type RentOpsSequencePrivilege = "USAGE" | "SELECT" | "UPDATE";

export interface RentOpsSecurityTarget {
  environment: RentOpsSecurityEnvironment;
  /** A label only; this artifact never contains a database URL or password. */
  databaseName: string;
  schemaName: string;
  runtimeRole: string;
  importerRole: string;
  auditorRole: string;
  runtimeDatabaseUrlEnv: string;
  importerDatabaseUrlEnv: string;
}

export interface RentOpsSecurityGates {
  backupVerified: boolean;
  backupAttestation: string;
  independentAuditVerified: boolean;
  independentAuditAttestation: string;
  schemaChecksumSha256: string;
}

export interface RentOpsSecurityRoleAttestation {
  /** A web role must not own either restricted table. */
  runtimeRoleIsNotRestrictedTableOwner: boolean;
  /** NOINHERIT prevents accidental access through a broader role membership. */
  runtimeRoleNoInherit: boolean;
  importerRoleIsDistinct: boolean;
  auditorRoleIsDistinct: boolean;
  auditorRoleNoInherit: boolean;
}

export interface RentOpsSecurityAuthorization {
  /** Must remain false for production until a human explicitly approves it. */
  productionExplicitlyAuthorized: boolean;
  authorizationReference?: string;
}

export interface RentOpsSecurityManifest {
  version: typeof RENT_OPS_SECURITY_VERSION;
  target: RentOpsSecurityTarget;
  runtimeTables: readonly string[];
  runtimeReadOnlyTables: readonly string[];
  runtimeAppendOnlyTables: readonly string[];
  runtimePrivateTables: readonly string[];
  importerTables: readonly string[];
  importerReadOnlyTables: readonly string[];
  importerPrivateTables: readonly string[];
  importerInsertOnlyTables: readonly string[];
  runtimeTablePrivileges: readonly RentOpsTablePrivilege[];
  runtimeReadOnlyTablePrivileges: readonly RentOpsTablePrivilege[];
  runtimeAppendOnlyTablePrivileges: readonly RentOpsTablePrivilege[];
  runtimePrivateTablePrivileges: readonly RentOpsTablePrivilege[];
  importerTablePrivileges: readonly RentOpsTablePrivilege[];
  importerReadOnlyTablePrivileges: readonly RentOpsTablePrivilege[];
  importerPrivateTablePrivileges: readonly RentOpsTablePrivilege[];
  importerAppendOnlyTablePrivileges: readonly RentOpsTablePrivilege[];
  runtimeSequences: readonly string[];
  importerSequences: readonly string[];
  runtimeSequencePrivileges: readonly RentOpsSequencePrivilege[];
  importerSequencePrivileges: readonly RentOpsSequencePrivilege[];
  restrictedTablePrivileges: readonly RentOpsTablePrivilege[];
  auditorTablePrivileges: readonly RentOpsTablePrivilege[];
  gates: RentOpsSecurityGates;
  roleAttestation: RentOpsSecurityRoleAttestation;
  authorization: RentOpsSecurityAuthorization;
}

export interface RentOpsSecurityManifestOverrides {
  target?: Partial<RentOpsSecurityTarget>;
  runtimeTables?: readonly string[];
  runtimeReadOnlyTables?: readonly string[];
  runtimeAppendOnlyTables?: readonly string[];
  runtimePrivateTables?: readonly string[];
  importerTables?: readonly string[];
  importerReadOnlyTables?: readonly string[];
  importerPrivateTables?: readonly string[];
  importerInsertOnlyTables?: readonly string[];
  runtimeTablePrivileges?: readonly RentOpsTablePrivilege[];
  runtimeReadOnlyTablePrivileges?: readonly RentOpsTablePrivilege[];
  runtimeAppendOnlyTablePrivileges?: readonly RentOpsTablePrivilege[];
  runtimePrivateTablePrivileges?: readonly RentOpsTablePrivilege[];
  importerTablePrivileges?: readonly RentOpsTablePrivilege[];
  importerReadOnlyTablePrivileges?: readonly RentOpsTablePrivilege[];
  importerPrivateTablePrivileges?: readonly RentOpsTablePrivilege[];
  importerAppendOnlyTablePrivileges?: readonly RentOpsTablePrivilege[];
  runtimeSequences?: readonly string[];
  importerSequences?: readonly string[];
  runtimeSequencePrivileges?: readonly RentOpsSequencePrivilege[];
  importerSequencePrivileges?: readonly RentOpsSequencePrivilege[];
  restrictedTablePrivileges?: readonly RentOpsTablePrivilege[];
  auditorTablePrivileges?: readonly RentOpsTablePrivilege[];
  gates?: Partial<RentOpsSecurityGates>;
  roleAttestation?: Partial<RentOpsSecurityRoleAttestation>;
  authorization?: Partial<RentOpsSecurityAuthorization>;
}

export interface RentOpsSecurityValidation {
  valid: boolean;
  blockingReasons: readonly string[];
}

export type RentOpsChecklistStatus = "pass" | "pending" | "blocked";

export interface RentOpsSecurityChecklistItem {
  id: string;
  label: string;
  status: RentOpsChecklistStatus;
  blockingReasons: readonly string[];
}

export interface RentOpsSecurityChecklist {
  version: typeof RENT_OPS_SECURITY_VERSION;
  target: Pick<RentOpsSecurityTarget, "environment" | "databaseName" | "runtimeDatabaseUrlEnv" | "importerDatabaseUrlEnv">;
  items: readonly RentOpsSecurityChecklistItem[];
  canApply: boolean;
}

export interface RentOpsSecuritySqlPlan {
  mode: RentOpsSecurityMode;
  target: RentOpsSecurityTarget;
  canApply: boolean;
  blockingReasons: readonly string[];
  /** SQL is present only when all deployment gates pass. */
  sql: string;
  statements: readonly string[];
}

const DEFAULT_TARGETS: Record<RentOpsSecurityEnvironment, RentOpsSecurityTarget> = {
  staging: {
    environment: "staging",
    databaseName: "rent_ops_staging",
    schemaName: "public",
    runtimeRole: "rent_ops_staging_web",
    importerRole: "rent_ops_staging_importer",
    auditorRole: "rent_ops_staging_auditor",
    runtimeDatabaseUrlEnv: RENT_OPS_RUNTIME_DATABASE_URL_ENV,
    importerDatabaseUrlEnv: RENT_OPS_IMPORTER_DATABASE_URL_ENV,
  },
  production: {
    environment: "production",
    databaseName: "rent_ops_production",
    schemaName: "public",
    runtimeRole: "rent_ops_production_web",
    importerRole: "rent_ops_production_importer",
    auditorRole: "rent_ops_production_auditor",
    runtimeDatabaseUrlEnv: RENT_OPS_RUNTIME_DATABASE_URL_ENV,
    importerDatabaseUrlEnv: RENT_OPS_IMPORTER_DATABASE_URL_ENV,
  },
};

const DEFAULT_RUNTIME_TABLE_PRIVILEGES: readonly RentOpsTablePrivilege[] = ["SELECT", "INSERT", "UPDATE"];
const DEFAULT_RUNTIME_READ_ONLY_TABLE_PRIVILEGES: readonly RentOpsTablePrivilege[] = ["SELECT"];
const DEFAULT_APPEND_ONLY_TABLE_PRIVILEGES: readonly RentOpsTablePrivilege[] = ["SELECT", "INSERT"];
const DEFAULT_PRIVATE_TABLE_PRIVILEGES: readonly RentOpsTablePrivilege[] = ["SELECT", "INSERT"];
const DEFAULT_IMPORTER_TABLE_PRIVILEGES: readonly RentOpsTablePrivilege[] = ["SELECT", "INSERT", "UPDATE"];
const DEFAULT_RESTRICTED_TABLE_PRIVILEGES: readonly RentOpsTablePrivilege[] = ["SELECT", "INSERT"];
const DEFAULT_AUDITOR_TABLE_PRIVILEGES: readonly RentOpsTablePrivilege[] = ["SELECT"];
const DEFAULT_SEQUENCE_PRIVILEGES: readonly RentOpsSequencePrivilege[] = ["USAGE", "SELECT"];
const ALLOWED_RUNTIME_TABLE_PRIVILEGES = new Set<RentOpsTablePrivilege>(["SELECT", "INSERT", "UPDATE"]);
const ALLOWED_RUNTIME_READ_ONLY_TABLE_PRIVILEGES = new Set<RentOpsTablePrivilege>(["SELECT"]);
const ALLOWED_APPEND_ONLY_TABLE_PRIVILEGES = new Set<RentOpsTablePrivilege>(["SELECT", "INSERT"]);
const ALLOWED_PRIVATE_TABLE_PRIVILEGES = new Set<RentOpsTablePrivilege>(["SELECT", "INSERT"]);
const ALLOWED_IMPORTER_TABLE_PRIVILEGES = new Set<RentOpsTablePrivilege>(["SELECT", "INSERT", "UPDATE"]);
const ALLOWED_RESTRICTED_TABLE_PRIVILEGES = new Set<RentOpsTablePrivilege>(["SELECT", "INSERT"]);
const ALLOWED_AUDITOR_TABLE_PRIVILEGES = new Set<RentOpsTablePrivilege>(["SELECT"]);
const ALLOWED_SEQUENCE_PRIVILEGES = new Set<RentOpsSequencePrivilege>(["USAGE", "SELECT", "UPDATE"]);
const restrictedTableSet = new Set<string>(RENT_OPS_RESTRICTED_TABLES);
const runtimePrivateTableSet = new Set<string>(RENT_OPS_RUNTIME_PRIVATE_TABLES);
const importerPrivateTableSet = new Set<string>(RENT_OPS_IMPORTER_PRIVATE_TABLES);
const allTableSet = new Set<string>(RENT_OPS_ALL_TABLES);
const runtimeTableSet = new Set<string>(RENT_OPS_RUNTIME_TABLES);
const runtimeWritableTableSet = new Set<string>(RENT_OPS_RUNTIME_WRITABLE_TABLES);
const runtimeReadOnlyTableSet = new Set<string>(RENT_OPS_RUNTIME_READ_ONLY_TABLES);
const appendOnlyTableSet = new Set<string>(RENT_OPS_APPEND_ONLY_TABLES);
const importerTableSet = new Set<string>(RENT_OPS_IMPORTER_TABLES);
const importerReadOnlyTableSet = new Set<string>(RENT_OPS_IMPORTER_READ_ONLY_TABLES);
const importerInsertOnlyTableSet = new Set<string>(RENT_OPS_IMPORTER_INSERT_ONLY_TABLES);

function safeIdentifier(value: string, field: string): string {
  if (!SAFE_IDENTIFIER.test(value)) throw new Error(`rent_ops_security_invalid_${field}`);
  return value;
}

function safeEnvironmentName(value: string, field: string): string {
  if (!SAFE_ENV_NAME.test(value) || value === "DATABASE_URL" || !value.endsWith("_DATABASE_URL")) {
    throw new Error(`rent_ops_security_invalid_${field}`);
  }
  return value;
}

function safeReference(value: string, field: string): string {
  if (!SAFE_REFERENCE.test(value)) throw new Error(`rent_ops_security_invalid_${field}`);
  return value;
}

function quoteIdentifier(value: string, field: string): string {
  return `"${safeIdentifier(value, field).replaceAll('"', '""')}"`;
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function ensureUnique(values: readonly string[], reason: string, blockingReasons: string[]): void {
  if (new Set(values).size !== values.length) blockingReasons.push(reason);
}

function ensureSubset(values: readonly string[], allowed: ReadonlySet<string>, reason: string, blockingReasons: string[]): void {
  if (values.some((value) => !allowed.has(value))) blockingReasons.push(reason);
}

function ensurePrivileges<T extends string>(values: readonly T[], allowed: ReadonlySet<T>, reason: string, blockingReasons: string[]): void {
  if (values.some((value) => !allowed.has(value))) blockingReasons.push(reason);
}

function targetFor(environment: RentOpsSecurityEnvironment): RentOpsSecurityTarget {
  return { ...DEFAULT_TARGETS[environment] };
}

export function createRentOpsSecurityManifest(
  environment: RentOpsSecurityEnvironment,
  overrides: RentOpsSecurityManifestOverrides = {},
): RentOpsSecurityManifest {
  const target = { ...targetFor(environment), ...(overrides.target ?? {}), environment };
  return {
    version: RENT_OPS_SECURITY_VERSION,
    target,
    runtimeTables: [...(overrides.runtimeTables ?? RENT_OPS_RUNTIME_TABLES)],
    runtimeReadOnlyTables: [...(overrides.runtimeReadOnlyTables ?? RENT_OPS_RUNTIME_READ_ONLY_TABLES)],
    runtimeAppendOnlyTables: [...(overrides.runtimeAppendOnlyTables ?? RENT_OPS_APPEND_ONLY_TABLES)],
    runtimePrivateTables: [...(overrides.runtimePrivateTables ?? RENT_OPS_RUNTIME_PRIVATE_TABLES)],
    importerTables: [...(overrides.importerTables ?? RENT_OPS_IMPORTER_TABLES)],
    importerReadOnlyTables: [...(overrides.importerReadOnlyTables ?? RENT_OPS_IMPORTER_READ_ONLY_TABLES)],
    importerPrivateTables: [...(overrides.importerPrivateTables ?? RENT_OPS_IMPORTER_PRIVATE_TABLES)],
    importerInsertOnlyTables: [...(overrides.importerInsertOnlyTables ?? RENT_OPS_IMPORTER_INSERT_ONLY_TABLES)],
    runtimeTablePrivileges: [...(overrides.runtimeTablePrivileges ?? DEFAULT_RUNTIME_TABLE_PRIVILEGES)],
    runtimeReadOnlyTablePrivileges: [...(overrides.runtimeReadOnlyTablePrivileges ?? DEFAULT_RUNTIME_READ_ONLY_TABLE_PRIVILEGES)],
    runtimeAppendOnlyTablePrivileges: [...(overrides.runtimeAppendOnlyTablePrivileges ?? DEFAULT_APPEND_ONLY_TABLE_PRIVILEGES)],
    runtimePrivateTablePrivileges: [...(overrides.runtimePrivateTablePrivileges ?? DEFAULT_PRIVATE_TABLE_PRIVILEGES)],
    importerTablePrivileges: [...(overrides.importerTablePrivileges ?? DEFAULT_IMPORTER_TABLE_PRIVILEGES)],
    importerReadOnlyTablePrivileges: [...(overrides.importerReadOnlyTablePrivileges ?? DEFAULT_RUNTIME_READ_ONLY_TABLE_PRIVILEGES)],
    importerPrivateTablePrivileges: [...(overrides.importerPrivateTablePrivileges ?? DEFAULT_PRIVATE_TABLE_PRIVILEGES)],
    importerAppendOnlyTablePrivileges: [...(overrides.importerAppendOnlyTablePrivileges ?? DEFAULT_APPEND_ONLY_TABLE_PRIVILEGES)],
    runtimeSequences: [...(overrides.runtimeSequences ?? RENT_OPS_SEQUENCE_NAMES)],
    importerSequences: [...(overrides.importerSequences ?? RENT_OPS_SEQUENCE_NAMES)],
    runtimeSequencePrivileges: [...(overrides.runtimeSequencePrivileges ?? DEFAULT_SEQUENCE_PRIVILEGES)],
    importerSequencePrivileges: [...(overrides.importerSequencePrivileges ?? DEFAULT_SEQUENCE_PRIVILEGES)],
    restrictedTablePrivileges: [...(overrides.restrictedTablePrivileges ?? DEFAULT_RESTRICTED_TABLE_PRIVILEGES)],
    auditorTablePrivileges: [...(overrides.auditorTablePrivileges ?? DEFAULT_AUDITOR_TABLE_PRIVILEGES)],
    gates: {
      backupVerified: false,
      backupAttestation: "",
      independentAuditVerified: false,
      independentAuditAttestation: "",
      schemaChecksumSha256: "",
      ...(overrides.gates ?? {}),
    },
    roleAttestation: {
      runtimeRoleIsNotRestrictedTableOwner: false,
      runtimeRoleNoInherit: false,
      importerRoleIsDistinct: true,
      auditorRoleIsDistinct: false,
      auditorRoleNoInherit: false,
      ...(overrides.roleAttestation ?? {}),
    },
    authorization: {
      productionExplicitlyAuthorized: false,
      ...(overrides.authorization ?? {}),
    },
  };
}

export function validateRentOpsSecurityManifest(manifest: RentOpsSecurityManifest): RentOpsSecurityValidation {
  const blockingReasons: string[] = [];
  if (manifest.version !== RENT_OPS_SECURITY_VERSION) blockingReasons.push("security_manifest_version_unsupported");

  const target = manifest.target;
  if (!target || (target.environment !== "staging" && target.environment !== "production")) {
    blockingReasons.push("security_target_environment_invalid");
  } else {
    for (const [field, value] of [
      ["database_name", target.databaseName],
      ["schema_name", target.schemaName],
      ["runtime_role", target.runtimeRole],
      ["importer_role", target.importerRole],
      ["auditor_role", target.auditorRole],
    ] as const) {
      try {
        safeIdentifier(value, field);
      } catch {
        blockingReasons.push(`security_target_${field}_invalid`);
      }
    }
    for (const [field, value] of [
      ["runtime_database_url_env", target.runtimeDatabaseUrlEnv],
      ["importer_database_url_env", target.importerDatabaseUrlEnv],
    ] as const) {
      try {
        safeEnvironmentName(value, field);
      } catch {
        blockingReasons.push(`security_target_${field}_invalid`);
      }
    }
    if (target.runtimeRole === target.importerRole) blockingReasons.push("security_roles_must_be_distinct");
    if (target.runtimeRole === target.auditorRole || target.importerRole === target.auditorRole) blockingReasons.push("security_roles_must_be_distinct");
    if (target.runtimeDatabaseUrlEnv === target.importerDatabaseUrlEnv) blockingReasons.push("security_database_url_envs_must_be_distinct");
    if (target.runtimeDatabaseUrlEnv === "DATABASE_URL" || target.importerDatabaseUrlEnv === "DATABASE_URL") {
      blockingReasons.push("security_shared_database_url_forbidden");
    }
    if (target.runtimeDatabaseUrlEnv !== RENT_OPS_RUNTIME_DATABASE_URL_ENV) {
      blockingReasons.push("security_runtime_database_url_env_contract_mismatch");
    }
    if (target.importerDatabaseUrlEnv !== RENT_OPS_IMPORTER_DATABASE_URL_ENV) {
      blockingReasons.push("security_importer_database_url_env_contract_mismatch");
    }
  }

  ensureUnique(manifest.runtimeTables, "runtime_table_list_contains_duplicates", blockingReasons);
  ensureUnique(manifest.runtimeReadOnlyTables, "runtime_read_only_table_list_contains_duplicates", blockingReasons);
  ensureUnique(manifest.runtimeAppendOnlyTables, "runtime_append_only_table_list_contains_duplicates", blockingReasons);
  ensureUnique(manifest.runtimePrivateTables, "runtime_private_table_list_contains_duplicates", blockingReasons);
  ensureUnique(manifest.importerTables, "importer_table_list_contains_duplicates", blockingReasons);
  ensureUnique(manifest.importerReadOnlyTables, "importer_read_only_table_list_contains_duplicates", blockingReasons);
  ensureUnique(manifest.importerPrivateTables, "importer_private_table_list_contains_duplicates", blockingReasons);
  ensureUnique(manifest.importerInsertOnlyTables, "importer_insert_only_table_list_contains_duplicates", blockingReasons);
  ensureUnique(manifest.runtimeSequences, "runtime_sequence_list_contains_duplicates", blockingReasons);
  ensureUnique(manifest.importerSequences, "importer_sequence_list_contains_duplicates", blockingReasons);
  ensureSubset(manifest.runtimeTables, runtimeTableSet, "runtime_table_outside_allowlist", blockingReasons);
  ensureSubset(manifest.runtimeReadOnlyTables, runtimeReadOnlyTableSet, "runtime_read_only_table_outside_allowlist", blockingReasons);
  ensureSubset(manifest.runtimeReadOnlyTables, new Set(manifest.runtimeTables), "runtime_read_only_table_not_in_runtime_allowlist", blockingReasons);
  ensureSubset(manifest.runtimeAppendOnlyTables, appendOnlyTableSet, "runtime_append_only_table_outside_allowlist", blockingReasons);
  ensureSubset(manifest.runtimeAppendOnlyTables, new Set(manifest.runtimeTables), "runtime_append_only_table_not_in_runtime_allowlist", blockingReasons);
  ensureSubset(manifest.runtimePrivateTables, runtimePrivateTableSet, "runtime_private_table_outside_allowlist", blockingReasons);
  ensureSubset(manifest.importerTables, importerTableSet, "importer_table_outside_allowlist", blockingReasons);
  ensureSubset(manifest.importerReadOnlyTables, importerReadOnlyTableSet, "importer_read_only_table_outside_allowlist", blockingReasons);
  ensureSubset(manifest.importerReadOnlyTables, new Set(manifest.importerTables), "importer_read_only_table_not_in_importer_allowlist", blockingReasons);
  ensureSubset(manifest.importerPrivateTables, importerPrivateTableSet, "importer_private_table_outside_allowlist", blockingReasons);
  ensureSubset(manifest.importerInsertOnlyTables, importerInsertOnlyTableSet, "importer_insert_only_table_outside_allowlist", blockingReasons);
  ensureSubset(manifest.importerInsertOnlyTables, new Set(manifest.importerTables), "importer_insert_only_table_not_in_importer_allowlist", blockingReasons);
  ensureSubset(manifest.runtimeTables, allTableSet, "runtime_table_unknown", blockingReasons);
  ensureSubset(manifest.importerTables, allTableSet, "importer_table_unknown", blockingReasons);
  ensureSubset(manifest.runtimePrivateTables, allTableSet, "runtime_private_table_unknown", blockingReasons);
  ensureSubset(manifest.importerPrivateTables, allTableSet, "importer_private_table_unknown", blockingReasons);
  ensureSubset(manifest.importerInsertOnlyTables, allTableSet, "importer_insert_only_table_unknown", blockingReasons);
  ensureSubset(manifest.runtimeSequences, new Set(RENT_OPS_SEQUENCE_NAMES), "runtime_sequence_outside_allowlist", blockingReasons);
  ensureSubset(manifest.importerSequences, new Set(RENT_OPS_SEQUENCE_NAMES), "importer_sequence_outside_allowlist", blockingReasons);
  if (manifest.runtimeTables.length === 0) blockingReasons.push("runtime_table_list_empty");
  // A runtime role has no provenance/read-only source tables.  Empty is the
  // intended least-privilege state; source records/import runs belong to the
  // importer/auditor identities only.
  if (manifest.runtimeAppendOnlyTables.length === 0) blockingReasons.push("runtime_append_only_table_list_empty");
  if (manifest.runtimePrivateTables.length === 0) blockingReasons.push("runtime_private_table_list_empty");
  if (manifest.importerTables.length === 0) blockingReasons.push("importer_table_list_empty");
  if (manifest.importerReadOnlyTables.length === 0) blockingReasons.push("importer_read_only_table_list_empty");
  if (manifest.importerPrivateTables.length === 0) blockingReasons.push("importer_private_table_list_empty");
  if (manifest.importerInsertOnlyTables.length === 0) blockingReasons.push("importer_insert_only_table_list_empty");
  if (manifest.auditorTablePrivileges.length === 0) blockingReasons.push("auditor_table_privilege_list_empty");
  if (manifest.runtimeTablePrivileges.length === 0) blockingReasons.push("runtime_table_privilege_list_empty");
  if (manifest.runtimeReadOnlyTablePrivileges.length === 0) blockingReasons.push("runtime_read_only_table_privilege_list_empty");
  if (manifest.runtimeAppendOnlyTablePrivileges.length === 0) blockingReasons.push("runtime_append_only_table_privilege_list_empty");
  if (manifest.importerTablePrivileges.length === 0) blockingReasons.push("importer_table_privilege_list_empty");
  if (manifest.importerReadOnlyTablePrivileges.length === 0) blockingReasons.push("importer_read_only_table_privilege_list_empty");
  if (manifest.importerAppendOnlyTablePrivileges.length === 0) blockingReasons.push("importer_append_only_table_privilege_list_empty");
  if (manifest.restrictedTablePrivileges.length === 0) blockingReasons.push("restricted_table_privilege_list_empty");
  if (manifest.runtimeTables.some((table) => restrictedTableSet.has(table))) blockingReasons.push("runtime_restricted_table_forbidden");
  if (manifest.runtimeTables.some((table) => runtimePrivateTableSet.has(table))) blockingReasons.push("runtime_private_table_requires_private_grant_set");
  if (manifest.runtimePrivateTables.some((table) => restrictedTableSet.has(table))) blockingReasons.push("runtime_private_table_overlaps_restricted");
  if (manifest.runtimeReadOnlyTables.some((table) => !runtimeReadOnlyTableSet.has(table))) blockingReasons.push("runtime_read_only_table_unknown");
  if (manifest.runtimeReadOnlyTables.some((table) => !manifest.runtimeTables.includes(table))) blockingReasons.push("runtime_read_only_table_not_in_runtime_allowlist");
  if (manifest.runtimeAppendOnlyTables.some((table) => !appendOnlyTableSet.has(table))) blockingReasons.push("runtime_append_only_table_unknown");
  if (manifest.runtimeAppendOnlyTables.some((table) => !manifest.runtimeTables.includes(table))) blockingReasons.push("runtime_append_only_table_not_in_runtime_allowlist");
  if (manifest.runtimeTables.some((table) => runtimeWritableTableSet.has(table) && manifest.runtimeReadOnlyTables.includes(table))) blockingReasons.push("runtime_table_cannot_be_both_read_only_and_writable");
  if (manifest.runtimeAppendOnlyTables.some((table) => manifest.runtimeReadOnlyTables.includes(table))) blockingReasons.push("runtime_table_cannot_be_both_read_only_and_append_only");
  if (manifest.importerInsertOnlyTables.some((table) => manifest.importerReadOnlyTables.includes(table))) blockingReasons.push("importer_insert_only_table_cannot_be_read_only");
  // The record-change ledger is append-only for the runtime writer but
  // deliberately read-only for the importer. Other append-only tables retain
  // their normal importer append grant.
  if (manifest.importerReadOnlyTables.some((table) => appendOnlyTableSet.has(table) && table !== "rent_ops_record_changes")) blockingReasons.push("importer_table_cannot_be_both_read_only_and_append_only");
  if (manifest.runtimeTables.length !== runtimeTableSet.size || runtimeTableSet.size !== new Set(manifest.runtimeTables).size || Array.from(runtimeTableSet).some((table) => !manifest.runtimeTables.includes(table))) blockingReasons.push("runtime_table_allowlist_incomplete");
  if (manifest.runtimeReadOnlyTables.length !== runtimeReadOnlyTableSet.size || runtimeReadOnlyTableSet.size !== new Set(manifest.runtimeReadOnlyTables).size || Array.from(runtimeReadOnlyTableSet).some((table) => !manifest.runtimeReadOnlyTables.includes(table))) blockingReasons.push("runtime_read_only_table_allowlist_incomplete");
  if (manifest.runtimeAppendOnlyTables.length !== appendOnlyTableSet.size || appendOnlyTableSet.size !== new Set(manifest.runtimeAppendOnlyTables).size || Array.from(appendOnlyTableSet).some((table) => !manifest.runtimeAppendOnlyTables.includes(table))) blockingReasons.push("runtime_append_only_table_allowlist_incomplete");
  if (manifest.runtimePrivateTables.length !== runtimePrivateTableSet.size || runtimePrivateTableSet.size !== new Set(manifest.runtimePrivateTables).size || Array.from(runtimePrivateTableSet).some((table) => !manifest.runtimePrivateTables.includes(table))) blockingReasons.push("runtime_private_table_allowlist_incomplete");
  if (manifest.importerTables.length !== importerTableSet.size || importerTableSet.size !== new Set(manifest.importerTables).size || Array.from(importerTableSet).some((table) => !manifest.importerTables.includes(table))) blockingReasons.push("importer_table_allowlist_incomplete");
  if (manifest.importerReadOnlyTables.length !== importerReadOnlyTableSet.size || importerReadOnlyTableSet.size !== new Set(manifest.importerReadOnlyTables).size || Array.from(importerReadOnlyTableSet).some((table) => !manifest.importerReadOnlyTables.includes(table))) blockingReasons.push("importer_read_only_table_allowlist_incomplete");
  if (manifest.importerPrivateTables.length !== importerPrivateTableSet.size || importerPrivateTableSet.size !== new Set(manifest.importerPrivateTables).size || Array.from(importerPrivateTableSet).some((table) => !manifest.importerPrivateTables.includes(table))) blockingReasons.push("importer_private_table_allowlist_incomplete");
  if (manifest.importerInsertOnlyTables.length !== importerInsertOnlyTableSet.size || importerInsertOnlyTableSet.size !== new Set(manifest.importerInsertOnlyTables).size || Array.from(importerInsertOnlyTableSet).some((table) => !manifest.importerInsertOnlyTables.includes(table))) blockingReasons.push("importer_insert_only_table_allowlist_incomplete");
  if (manifest.importerTables.some((table) => restrictedTableSet.has(table))) blockingReasons.push("restricted_tables_must_use_restricted_grant_set");
  if (manifest.importerTables.some((table) => importerPrivateTableSet.has(table))) blockingReasons.push("importer_private_table_requires_private_grant_set");

  ensurePrivileges(manifest.runtimeTablePrivileges, ALLOWED_RUNTIME_TABLE_PRIVILEGES, "runtime_table_privilege_outside_allowlist", blockingReasons);
  ensurePrivileges(manifest.runtimeReadOnlyTablePrivileges, ALLOWED_RUNTIME_READ_ONLY_TABLE_PRIVILEGES, "runtime_read_only_table_privilege_outside_allowlist", blockingReasons);
  ensurePrivileges(manifest.runtimeAppendOnlyTablePrivileges, ALLOWED_APPEND_ONLY_TABLE_PRIVILEGES, "runtime_append_only_table_privilege_outside_allowlist", blockingReasons);
  ensurePrivileges(manifest.runtimePrivateTablePrivileges, ALLOWED_PRIVATE_TABLE_PRIVILEGES, "runtime_private_table_privilege_outside_allowlist", blockingReasons);
  ensurePrivileges(manifest.importerTablePrivileges, ALLOWED_IMPORTER_TABLE_PRIVILEGES, "importer_table_privilege_outside_allowlist", blockingReasons);
  ensurePrivileges(manifest.importerReadOnlyTablePrivileges, ALLOWED_RUNTIME_READ_ONLY_TABLE_PRIVILEGES, "importer_read_only_table_privilege_outside_allowlist", blockingReasons);
  ensurePrivileges(manifest.importerPrivateTablePrivileges, ALLOWED_PRIVATE_TABLE_PRIVILEGES, "importer_private_table_privilege_outside_allowlist", blockingReasons);
  ensurePrivileges(manifest.importerAppendOnlyTablePrivileges, ALLOWED_APPEND_ONLY_TABLE_PRIVILEGES, "importer_append_only_table_privilege_outside_allowlist", blockingReasons);
  ensurePrivileges(manifest.restrictedTablePrivileges, ALLOWED_RESTRICTED_TABLE_PRIVILEGES, "restricted_table_privilege_outside_allowlist", blockingReasons);
  ensurePrivileges(manifest.auditorTablePrivileges, ALLOWED_AUDITOR_TABLE_PRIVILEGES, "auditor_table_privilege_outside_allowlist", blockingReasons);
  if (manifest.auditorTablePrivileges.length !== ALLOWED_AUDITOR_TABLE_PRIVILEGES.size || Array.from(ALLOWED_AUDITOR_TABLE_PRIVILEGES).some((privilege) => !manifest.auditorTablePrivileges.includes(privilege))) {
    blockingReasons.push("auditor_table_privilege_set_incomplete");
  }
  if (
    manifest.restrictedTablePrivileges.length !== ALLOWED_RESTRICTED_TABLE_PRIVILEGES.size
    || Array.from(ALLOWED_RESTRICTED_TABLE_PRIVILEGES).some((privilege) => !manifest.restrictedTablePrivileges.includes(privilege))
  ) {
    blockingReasons.push("restricted_table_privilege_set_incomplete");
  }
  if (manifest.runtimePrivateTablePrivileges.length !== ALLOWED_PRIVATE_TABLE_PRIVILEGES.size || Array.from(ALLOWED_PRIVATE_TABLE_PRIVILEGES).some((privilege) => !manifest.runtimePrivateTablePrivileges.includes(privilege))) blockingReasons.push("runtime_private_table_privilege_set_incomplete");
  if (manifest.importerPrivateTablePrivileges.length !== ALLOWED_PRIVATE_TABLE_PRIVILEGES.size || Array.from(ALLOWED_PRIVATE_TABLE_PRIVILEGES).some((privilege) => !manifest.importerPrivateTablePrivileges.includes(privilege))) blockingReasons.push("importer_private_table_privilege_set_incomplete");
  ensurePrivileges(manifest.runtimeSequencePrivileges, ALLOWED_SEQUENCE_PRIVILEGES, "runtime_sequence_privilege_outside_allowlist", blockingReasons);
  ensurePrivileges(manifest.importerSequencePrivileges, ALLOWED_SEQUENCE_PRIVILEGES, "importer_sequence_privilege_outside_allowlist", blockingReasons);

  if (manifest.roleAttestation.runtimeRoleIsNotRestrictedTableOwner !== true) blockingReasons.push("runtime_restricted_table_owner_attestation_missing");
  if (manifest.roleAttestation.runtimeRoleNoInherit !== true) blockingReasons.push("runtime_role_noinherit_attestation_missing");
  if (manifest.roleAttestation.importerRoleIsDistinct !== true) blockingReasons.push("importer_role_distinct_attestation_missing");
  if (manifest.roleAttestation.auditorRoleIsDistinct !== true) blockingReasons.push("auditor_role_distinct_attestation_missing");
  if (manifest.roleAttestation.auditorRoleNoInherit !== true) blockingReasons.push("auditor_role_noinherit_attestation_missing");
  if (manifest.gates.backupVerified !== true || !SAFE_REFERENCE.test(manifest.gates.backupAttestation)) blockingReasons.push("verified_backup_gate_missing");
  if (manifest.gates.independentAuditVerified !== true || !SAFE_REFERENCE.test(manifest.gates.independentAuditAttestation)) blockingReasons.push("independent_audit_gate_missing");
  if (!SHA256.test(manifest.gates.schemaChecksumSha256)) blockingReasons.push("schema_checksum_gate_missing");

  const authorizationReference = manifest.authorization.authorizationReference;
  if (authorizationReference !== undefined && !SAFE_REFERENCE.test(authorizationReference)) blockingReasons.push("production_authorization_reference_invalid");
  if (target?.environment === "production" && manifest.authorization.productionExplicitlyAuthorized !== true) {
    blockingReasons.push("production_not_explicitly_authorized");
  }
  if (target?.environment === "staging" && manifest.authorization.productionExplicitlyAuthorized === true) {
    blockingReasons.push("production_authorization_cannot_be_attached_to_staging");
  }
  if (target?.environment === "production" && !authorizationReference) blockingReasons.push("production_authorization_reference_missing");

  return { valid: blockingReasons.length === 0, blockingReasons: uniqueStrings(blockingReasons) };
}

function qualifiedTable(schemaName: string, tableName: string): string {
  return `${quoteIdentifier(schemaName, "schema_name")}.${quoteIdentifier(tableName, "table_name")}`;
}

function qualifiedSequence(schemaName: string, sequenceName: string): string {
  return `${quoteIdentifier(schemaName, "schema_name")}.${quoteIdentifier(sequenceName, "sequence_name")}`;
}

function joinObjects(schemaName: string, names: readonly string[], kind: "table" | "sequence"): string {
  return names.map((name) => kind === "table" ? qualifiedTable(schemaName, name) : qualifiedSequence(schemaName, name)).join(", ");
}

function grant(privileges: readonly string[], objectType: "TABLE" | "SEQUENCE", objects: string, role: string): string {
  return `GRANT ${privileges.join(", ")} ON ${objectType} ${objects} TO ${quoteIdentifier(role, "role")};`;
}

function revokeAll(objectType: "TABLE" | "SEQUENCE" | "SCHEMA", objects: string, role: string): string {
  return `REVOKE ALL PRIVILEGES ON ${objectType} ${objects} FROM ${quoteIdentifier(role, "role")};`;
}

function tableStatements(manifest: RentOpsSecurityManifest): string[] {
  const { target } = manifest;
  const normalAndRestricted = uniqueStrings([...RENT_OPS_ALL_TABLES, ...RENT_OPS_RUNTIME_PRIVATE_TABLES]);
  const runtimeWritableTables = manifest.runtimeTables.filter((table) => !manifest.runtimeReadOnlyTables.includes(table));
  const runtimeEphemeralTables = runtimeWritableTables.filter((table) => (RENT_OPS_RUNTIME_EPHEMERAL_TABLES as readonly string[]).includes(table));
  const runtimeUpsertTables = runtimeWritableTables.filter((table) => !manifest.runtimeAppendOnlyTables.includes(table) && !runtimeEphemeralTables.includes(table));
  const importerUpsertTables = manifest.importerTables.filter(
    (table) => !appendOnlyTableSet.has(table) && !importerInsertOnlyTableSet.has(table) && !manifest.importerReadOnlyTables.includes(table),
  );
  const importerAppendOnlyTables = RENT_OPS_APPEND_ONLY_TABLES.filter((table) => manifest.importerTables.includes(table) && !manifest.importerReadOnlyTables.includes(table));
  const importerInsertOnlyTables = manifest.importerInsertOnlyTables.filter((table) => !manifest.importerReadOnlyTables.includes(table));
  const statements = [
    `REVOKE ALL PRIVILEGES ON TABLE ${joinObjects(target.schemaName, normalAndRestricted, "table")} FROM ${quoteIdentifier(target.runtimeRole, "runtime_role")};`,
    `REVOKE ALL PRIVILEGES ON TABLE ${joinObjects(target.schemaName, normalAndRestricted, "table")} FROM ${quoteIdentifier(target.importerRole, "importer_role")};`,
    `REVOKE ALL PRIVILEGES ON TABLE ${joinObjects(target.schemaName, normalAndRestricted, "table")} FROM ${quoteIdentifier(target.auditorRole, "auditor_role")};`,
    `REVOKE ALL PRIVILEGES ON TABLE ${joinObjects(target.schemaName, RENT_OPS_RESTRICTED_TABLES, "table")} FROM PUBLIC;`,
    `REVOKE ALL PRIVILEGES ON TABLE ${joinObjects(target.schemaName, RENT_OPS_RUNTIME_PRIVATE_TABLES, "table")} FROM PUBLIC;`,
    `REVOKE ALL PRIVILEGES ON TABLE ${joinObjects(target.schemaName, RENT_OPS_APPLICATION_TABLES, "table")} FROM PUBLIC;`,
    ...(runtimeEphemeralTables.length > 0 ? [grant(["SELECT", "INSERT", "UPDATE", "DELETE"], "TABLE", joinObjects(target.schemaName, runtimeEphemeralTables, "table"), target.runtimeRole)] : []),
    ...(runtimeUpsertTables.length > 0 ? [grant(manifest.runtimeTablePrivileges, "TABLE", joinObjects(target.schemaName, runtimeUpsertTables, "table"), target.runtimeRole)] : []),
    ...(manifest.runtimeReadOnlyTables.length > 0 ? [grant(manifest.runtimeReadOnlyTablePrivileges, "TABLE", joinObjects(target.schemaName, manifest.runtimeReadOnlyTables, "table"), target.runtimeRole)] : []),
    ...(manifest.runtimeAppendOnlyTables.length > 0 ? [grant(manifest.runtimeAppendOnlyTablePrivileges, "TABLE", joinObjects(target.schemaName, manifest.runtimeAppendOnlyTables, "table"), target.runtimeRole)] : []),
    revokeAll("TABLE", joinObjects(target.schemaName, RENT_OPS_RESTRICTED_TABLES, "table"), target.runtimeRole),
    grant(manifest.runtimePrivateTablePrivileges, "TABLE", joinObjects(target.schemaName, manifest.runtimePrivateTables, "table"), target.runtimeRole),
    grant(manifest.importerTablePrivileges, "TABLE", joinObjects(target.schemaName, importerUpsertTables, "table"), target.importerRole),
    grant(manifest.importerReadOnlyTablePrivileges, "TABLE", joinObjects(target.schemaName, manifest.importerReadOnlyTables, "table"), target.importerRole),
    grant(manifest.importerPrivateTablePrivileges, "TABLE", joinObjects(target.schemaName, manifest.importerPrivateTables, "table"), target.importerRole),
    ...(importerAppendOnlyTables.length > 0 ? [grant(manifest.importerAppendOnlyTablePrivileges, "TABLE", joinObjects(target.schemaName, importerAppendOnlyTables, "table"), target.importerRole)] : []),
    ...(importerInsertOnlyTables.length > 0 ? [grant(manifest.importerAppendOnlyTablePrivileges, "TABLE", joinObjects(target.schemaName, importerInsertOnlyTables, "table"), target.importerRole)] : []),
    grant(manifest.restrictedTablePrivileges, "TABLE", joinObjects(target.schemaName, RENT_OPS_RESTRICTED_TABLES, "table"), target.importerRole),
    grant(manifest.auditorTablePrivileges, "TABLE", joinObjects(target.schemaName, RENT_OPS_AUDITOR_TABLES, "table"), target.auditorRole),
  ];
  return statements;
}

function sequenceStatements(manifest: RentOpsSecurityManifest): string[] {
  const { target } = manifest;
  const allSequences = uniqueStrings(Array.from(manifest.runtimeSequences).concat(Array.from(manifest.importerSequences)));
  if (allSequences.length === 0) return ["-- No Rent Ops sequences are currently defined; no sequence privileges are granted."];
  return [
    revokeAll("SEQUENCE", joinObjects(target.schemaName, allSequences, "sequence"), target.runtimeRole),
    revokeAll("SEQUENCE", joinObjects(target.schemaName, allSequences, "sequence"), target.importerRole),
    grant(manifest.runtimeSequencePrivileges, "SEQUENCE", joinObjects(target.schemaName, manifest.runtimeSequences, "sequence"), target.runtimeRole),
    grant(manifest.importerSequencePrivileges, "SEQUENCE", joinObjects(target.schemaName, manifest.importerSequences, "sequence"), target.importerRole),
  ];
}

function buildSqlStatements(manifest: RentOpsSecurityManifest): string[] {
  const { target } = manifest;
  const schema = quoteIdentifier(target.schemaName, "schema_name");
  const runtimeRole = quoteIdentifier(target.runtimeRole, "runtime_role");
  const importerRole = quoteIdentifier(target.importerRole, "importer_role");
  const auditorRole = quoteIdentifier(target.auditorRole, "auditor_role");
  return [
    `-- Target: ${target.environment}/${target.databaseName}`,
    `-- Runtime URL env: ${target.runtimeDatabaseUrlEnv}`,
    `-- Importer/archive URL env: ${target.importerDatabaseUrlEnv}`,
    "BEGIN;",
    `ALTER ROLE ${runtimeRole} NOINHERIT;`,
    `ALTER ROLE ${importerRole} NOINHERIT;`,
    `ALTER ROLE ${auditorRole} NOINHERIT;`,
    `REVOKE ALL PRIVILEGES ON SCHEMA ${schema} FROM ${runtimeRole};`,
    `REVOKE ALL PRIVILEGES ON SCHEMA ${schema} FROM ${importerRole};`,
    `REVOKE ALL PRIVILEGES ON SCHEMA ${schema} FROM ${auditorRole};`,
    `GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole};`,
    `GRANT USAGE ON SCHEMA ${schema} TO ${importerRole};`,
    `GRANT USAGE ON SCHEMA ${schema} TO ${auditorRole};`,
    ...tableStatements(manifest),
    ...sequenceStatements(manifest),
    "COMMIT;",
  ];
}

function dryRunSql(statements: readonly string[]): string {
  return [
    "-- DRY RUN ONLY: no SQL is executed by this module.",
    ...statements.map((statement) => `-- ${statement}`),
    "",
  ].join("\n");
}

export function renderRentOpsSecuritySql(
  manifest: RentOpsSecurityManifest,
  options: { mode?: RentOpsSecurityMode } = {},
): RentOpsSecuritySqlPlan {
  const mode = options.mode ?? "dry_run";
  const validation = validateRentOpsSecurityManifest(manifest);
  const statements = validation.valid ? buildSqlStatements(manifest) : [];
  if (mode === "apply" && !validation.valid) {
    throw new Error(`rent_ops_security_apply_blocked:${validation.blockingReasons.join(",")}`);
  }
  return {
    mode,
    target: { ...manifest.target },
    canApply: validation.valid,
    blockingReasons: validation.blockingReasons,
    sql: validation.valid ? (mode === "dry_run" ? dryRunSql(statements) : `${statements.join("\n")}\n`) : "",
    statements,
  };
}

function checklistStatus(passed: boolean, pending: boolean): RentOpsChecklistStatus {
  return passed ? "pass" : pending ? "pending" : "blocked";
}

export function buildRentOpsSecurityChecklist(manifest: RentOpsSecurityManifest): RentOpsSecurityChecklist {
  const validation = validateRentOpsSecurityManifest(manifest);
  const reasons = new Set(validation.blockingReasons);
  const target = manifest.target;
  const items: RentOpsSecurityChecklistItem[] = [
    {
      id: "target_environment_classified",
      label: `Target is explicitly classified as ${target.environment}.`,
      status: target.environment === "staging" || target.environment === "production" ? "pass" : "blocked",
      blockingReasons: reasons.has("security_target_environment_invalid") ? ["security_target_environment_invalid"] : [],
    },
    {
      id: "dedicated_runtime_database_url",
      label: `Runtime uses ${target.runtimeDatabaseUrlEnv}; values are supplied out of band.`,
      status: target.runtimeDatabaseUrlEnv === RENT_OPS_RUNTIME_DATABASE_URL_ENV ? "pass" : "blocked",
      blockingReasons: validation.blockingReasons.filter((reason) => reason === "security_target_runtime_database_url_env_invalid" || reason === "security_runtime_database_url_env_contract_mismatch"),
    },
    {
      id: "dedicated_importer_database_url",
      label: `Importer/archive uses ${target.importerDatabaseUrlEnv}; values are supplied out of band.`,
      status: target.importerDatabaseUrlEnv === RENT_OPS_IMPORTER_DATABASE_URL_ENV ? "pass" : "blocked",
      blockingReasons: validation.blockingReasons.filter((reason) => reason === "security_target_importer_database_url_env_invalid" || reason === "security_importer_database_url_env_contract_mismatch"),
    },
    {
      id: "backup_attestation",
      label: "A fresh, restorable pre-change backup is attested.",
      status: checklistStatus(manifest.gates.backupVerified === true && SAFE_REFERENCE.test(manifest.gates.backupAttestation), false),
      blockingReasons: reasons.has("verified_backup_gate_missing") ? ["verified_backup_gate_missing"] : [],
    },
    {
      id: "independent_audit_attestation",
      label: "An independent source-to-target audit is attested.",
      status: checklistStatus(manifest.gates.independentAuditVerified === true && SAFE_REFERENCE.test(manifest.gates.independentAuditAttestation), false),
      blockingReasons: reasons.has("independent_audit_gate_missing") ? ["independent_audit_gate_missing"] : [],
    },
    {
      id: "schema_checksum_attestation",
      label: "The exact migration checksum is recorded.",
      status: checklistStatus(SHA256.test(manifest.gates.schemaChecksumSha256), false),
      blockingReasons: reasons.has("schema_checksum_gate_missing") ? ["schema_checksum_gate_missing"] : [],
    },
    {
      id: "runtime_role_is_not_owner",
      label: "The web runtime role is not owner of restricted raw tables.",
      status: checklistStatus(manifest.roleAttestation.runtimeRoleIsNotRestrictedTableOwner === true, false),
      blockingReasons: reasons.has("runtime_restricted_table_owner_attestation_missing") ? ["runtime_restricted_table_owner_attestation_missing"] : [],
    },
    {
      id: "runtime_role_noinherit",
      label: "The web runtime role is NOINHERIT and receives no restricted grants.",
      status: checklistStatus(manifest.roleAttestation.runtimeRoleNoInherit === true, false),
      blockingReasons: reasons.has("runtime_role_noinherit_attestation_missing") ? ["runtime_role_noinherit_attestation_missing"] : [],
    },
    {
      id: "production_human_authorization",
      label: "Production is blocked until explicit human authorization is recorded.",
      status: target.environment === "staging"
        ? "pass"
        : checklistStatus(manifest.authorization.productionExplicitlyAuthorized === true && Boolean(manifest.authorization.authorizationReference), false),
      blockingReasons: target.environment === "production"
        ? validation.blockingReasons.filter((reason) => reason.startsWith("production_"))
        : [],
    },
  ];
  return {
    version: RENT_OPS_SECURITY_VERSION,
    target: {
      environment: target.environment,
      databaseName: target.databaseName,
      runtimeDatabaseUrlEnv: target.runtimeDatabaseUrlEnv,
      importerDatabaseUrlEnv: target.importerDatabaseUrlEnv,
    },
    items,
    canApply: validation.valid,
  };
}
