import assert from "node:assert/strict";
import test from "node:test";
import {
  RENT_OPS_ALL_TABLES,
  RENT_OPS_APPEND_ONLY_TABLES,
  RENT_OPS_APPLICATION_TABLES,
  RENT_OPS_RUNTIME_EPHEMERAL_TABLES,
  RENT_OPS_IMPORTER_TABLES,
  validateRentOpsProductionConfiguration,
  RENT_OPS_IMPORTER_DATABASE_URL_ENV,
  RENT_OPS_IMPORTER_INSERT_ONLY_TABLES,
  RENT_OPS_IMPORTER_READ_ONLY_TABLES,
  RENT_OPS_RESTRICTED_TABLES,
  RENT_OPS_RUNTIME_DATABASE_URL_ENV,
  RENT_OPS_RUNTIME_READ_ONLY_TABLES,
  RENT_OPS_RUNTIME_TABLES,
  RENT_OPS_RUNTIME_WRITABLE_TABLES,
  buildRentOpsSecurityChecklist,
  createRentOpsSecurityManifest,
  renderRentOpsSecuritySql,
  validateRentOpsSecurityManifest,
} from "./deployment-security";
import { RENT_OPS_REQUIRED_TABLES } from "../persistence";

const CHECKSUM = "a".repeat(64);

function verifiedManifest(environment: "staging" | "production" = "staging") {
  return createRentOpsSecurityManifest(environment, {
    gates: {
      backupVerified: true,
      backupAttestation: "backup-20260817",
      independentAuditVerified: true,
      independentAuditAttestation: "audit-20260817",
      schemaChecksumSha256: CHECKSUM,
    },
    roleAttestation: {
      runtimeRoleIsNotRestrictedTableOwner: true,
      runtimeRoleNoInherit: true,
      importerRoleIsDistinct: true,
      auditorRoleIsDistinct: true,
      auditorRoleNoInherit: true,
    },
    authorization: environment === "production"
      ? { productionExplicitlyAuthorized: true, authorizationReference: "approval-20260817" }
      : { productionExplicitlyAuthorized: false },
  });
}

test("staging and production targets use the executable runtime/importer URL env contract", () => {
  const staging = createRentOpsSecurityManifest("staging");
  const production = createRentOpsSecurityManifest("production");
  assert.notEqual(staging.target.databaseName, production.target.databaseName);
  assert.equal(staging.target.runtimeDatabaseUrlEnv, RENT_OPS_RUNTIME_DATABASE_URL_ENV);
  assert.equal(staging.target.importerDatabaseUrlEnv, RENT_OPS_IMPORTER_DATABASE_URL_ENV);
  assert.equal(production.target.runtimeDatabaseUrlEnv, RENT_OPS_RUNTIME_DATABASE_URL_ENV);
  assert.equal(production.target.importerDatabaseUrlEnv, RENT_OPS_IMPORTER_DATABASE_URL_ENV);
  assert.notEqual(staging.target.runtimeDatabaseUrlEnv, staging.target.importerDatabaseUrlEnv);
  assert.notEqual(production.target.runtimeDatabaseUrlEnv, production.target.importerDatabaseUrlEnv);
});

test("security manifest rejects env aliases that the runtime and importer do not read", () => {
  const manifest = verifiedManifest();
  manifest.target.runtimeDatabaseUrlEnv = "RENT_OPS_STAGING_RUNTIME_DATABASE_URL";
  manifest.target.importerDatabaseUrlEnv = "RENT_OPS_STAGING_IMPORTER_DATABASE_URL";
  const validation = validateRentOpsSecurityManifest(manifest);
  assert.ok(validation.blockingReasons.includes("security_runtime_database_url_env_contract_mismatch"));
  assert.ok(validation.blockingReasons.includes("security_importer_database_url_env_contract_mismatch"));
  const checklist = buildRentOpsSecurityChecklist(manifest);
  assert.equal(checklist.canApply, false);
  assert.ok(checklist.items.some((item) => item.id === "dedicated_runtime_database_url" && item.status === "blocked"));
  assert.ok(checklist.items.some((item) => item.id === "dedicated_importer_database_url" && item.status === "blocked"));
});

test("security inventory matches all migration tables and repository runtime reads", () => {
  assert.equal(RENT_OPS_ALL_TABLES.length, RENT_OPS_REQUIRED_TABLES.length);
  assert.deepEqual([...RENT_OPS_ALL_TABLES].sort(), [...RENT_OPS_REQUIRED_TABLES].sort());

  // Mirrors PostgresRentOpsRepository.loadSnapshot(), which reads these
  // operational tables on every runtime snapshot. The v7 record-change table
  // is also in the runtime grant because patches append an audit row atomically.
  // are part of the runtime contract even when a deployment has no rows.
  // Provenance tables are importer/auditor-only; verified document bindings
  // are a separate private runtime grant and are included in readiness.
  const repositorySnapshotTables = [
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
  ];
  assert.deepEqual([...RENT_OPS_RUNTIME_TABLES].sort(), [...repositorySnapshotTables, ...RENT_OPS_APPLICATION_TABLES].sort());
  assert.deepEqual([...RENT_OPS_RUNTIME_READ_ONLY_TABLES], [
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
  ]);
  assert.deepEqual([...RENT_OPS_IMPORTER_READ_ONLY_TABLES], ["rent_ops_schema_meta", "rent_ops_schema_migrations", "rent_ops_record_changes"]);
  assert.deepEqual([...RENT_OPS_APPEND_ONLY_TABLES], ["rent_ops_recurring_charge_schedules", "rent_ops_ledger_transactions", "rent_ops_payment_allocations", "rent_ops_activity_events", "rent_ops_record_changes", "rent_ops_payment_events", "rent_ops_billing_charges"]);
  assert.deepEqual([...RENT_OPS_IMPORTER_INSERT_ONLY_TABLES], [
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
  ]);
  assert.equal(RENT_OPS_RUNTIME_WRITABLE_TABLES.length, repositorySnapshotTables.length + RENT_OPS_APPLICATION_TABLES.length - RENT_OPS_RUNTIME_READ_ONLY_TABLES.length);

  // saveLedgerTransaction/savePaymentAllocation/saveActivity use insertOnly;
  // every other runtime save method uses the repository upsert path.
  const repositoryUpsertTables = [
    "rent_ops_charge_definitions",
    "rent_ops_properties",
    "rent_ops_units",
    "rent_ops_people",
    "rent_ops_tenancies",
    "rent_ops_household_memberships",
    "rent_ops_lease_terms",
    "rent_ops_security_deposits",
    "rent_ops_subsidy_contracts",
    "rent_ops_subsidy_tenants",
    "rent_ops_subsidy_payments",
    "rent_ops_applications",
    "rent_ops_application_household_members",
    "rent_ops_application_requirements",
    "rent_ops_documents",
  ];
  assert.deepEqual(
    [...new Set([...repositoryUpsertTables, ...RENT_OPS_APPEND_ONLY_TABLES, ...RENT_OPS_APPLICATION_TABLES])].sort(),
    [...RENT_OPS_RUNTIME_WRITABLE_TABLES].sort(),
  );
});

test("dry-run is the default and cannot apply without backup, audit, checksum, and role gates", () => {
  const manifest = createRentOpsSecurityManifest("staging");
  const validation = validateRentOpsSecurityManifest(manifest);
  assert.equal(validation.valid, false);
  assert.ok(validation.blockingReasons.includes("verified_backup_gate_missing"));
  assert.ok(validation.blockingReasons.includes("independent_audit_gate_missing"));
  assert.ok(validation.blockingReasons.includes("schema_checksum_gate_missing"));
  assert.ok(validation.blockingReasons.includes("runtime_restricted_table_owner_attestation_missing"));

  const plan = renderRentOpsSecuritySql(manifest);
  assert.equal(plan.mode, "dry_run");
  assert.equal(plan.canApply, false);
  assert.equal(plan.sql, "");
  assert.deepEqual(plan.statements, []);
});

test("verified staging plan grants normal tables and importer-only access to restricted tables", () => {
  const manifest = verifiedManifest();
  const plan = renderRentOpsSecuritySql(manifest);
  assert.equal(plan.canApply, true);
  assert.equal(plan.mode, "dry_run");
  assert.match(plan.sql, /DRY RUN ONLY/);
  assert.match(plan.sql, /Runtime URL env: RENT_OPS_RUNTIME_DATABASE_URL/);
  assert.match(plan.sql, /Importer\/archive URL env: RENT_OPS_DATABASE_URL/);
  assert.match(plan.sql, /GRANT SELECT, INSERT, UPDATE ON TABLE/);
  assert.match(plan.sql, /GRANT SELECT ON TABLE "public"\."rent_ops_schema_meta", "public"\."rent_ops_schema_migrations", "public"\."rent_ops_record_changes" TO "rent_ops_staging_importer"/);
  assert.match(plan.sql, /GRANT SELECT, INSERT ON TABLE .*rent_ops_ledger_transactions.*rent_ops_payment_allocations.*rent_ops_activity_events.* TO "rent_ops_staging_web"/);
  assert.match(plan.sql, /GRANT SELECT, INSERT ON TABLE .*rent_ops_ledger_transactions.*rent_ops_payment_allocations.*rent_ops_activity_events.* TO "rent_ops_staging_importer"/);
  assert.match(plan.sql, /GRANT SELECT, INSERT, UPDATE ON TABLE [^;]*"public"\."rent_ops_charge_definitions"[^;]* TO "rent_ops_staging_web"/);
  assert.match(plan.sql, /GRANT SELECT, INSERT ON TABLE [^;]*"public"\."rent_ops_charge_definitions"[^;]*"public"\."rent_ops_application_history_aggregates"[^;]* TO "rent_ops_staging_importer"/);
  assert.doesNotMatch(plan.sql, /GRANT SELECT, INSERT, UPDATE ON TABLE [^;]*rent_ops_charge_definitions[^;]* TO "rent_ops_staging_importer"/);
  assert.doesNotMatch(plan.sql, /GRANT SELECT, INSERT, UPDATE ON TABLE [^;]*rent_ops_ledger_transactions[^;]* TO "rent_ops_staging_web"/);
  assert.doesNotMatch(plan.sql, /GRANT SELECT, INSERT, UPDATE ON TABLE [^;]*rent_ops_payment_allocations[^;]* TO "rent_ops_staging_web"/);
  assert.doesNotMatch(plan.sql, /GRANT SELECT, INSERT, UPDATE ON TABLE [^;]*rent_ops_activity_events[^;]* TO "rent_ops_staging_web"/);
  assert.doesNotMatch(plan.sql, /GRANT SELECT, INSERT, UPDATE ON TABLE [^;]*rent_ops_ledger_transactions[^;]* TO "rent_ops_staging_importer"/);
  assert.doesNotMatch(plan.sql, /GRANT SELECT, INSERT, UPDATE ON TABLE [^;]*rent_ops_payment_allocations[^;]* TO "rent_ops_staging_importer"/);
  assert.doesNotMatch(plan.sql, /GRANT SELECT, INSERT, UPDATE ON TABLE [^;]*rent_ops_activity_events[^;]* TO "rent_ops_staging_importer"/);
  assert.doesNotMatch(plan.sql, /GRANT SELECT, INSERT[^;]*rent_ops_record_changes[^;]* TO "rent_ops_staging_importer"/);
  assert.doesNotMatch(plan.sql, /GRANT [^;]*(?:UPDATE|DELETE)[^;]*rent_ops_record_changes[^;]*/);
  assert.doesNotMatch(plan.sql, /GRANT SELECT, INSERT, UPDATE ON TABLE [^;]*rent_ops_source_records[^;]* TO "rent_ops_staging_web"/);
  assert.doesNotMatch(plan.sql, /GRANT SELECT, INSERT, UPDATE ON TABLE [^;]*rent_ops_import_runs[^;]* TO "rent_ops_staging_web"/);
  assert.doesNotMatch(plan.sql, /GRANT SELECT, INSERT, UPDATE ON TABLE [^;]*rent_ops_schema_migrations[^;]* TO "rent_ops_staging_importer"/);
  assert.match(plan.sql, /rent_ops_source_payloads.*FROM PUBLIC/);
  assert.match(plan.sql, /REVOKE ALL PRIVILEGES ON TABLE .*rent_ops_source_payloads.*rent_ops_source_binaries.* FROM "rent_ops_staging_web"/);
  assert.match(plan.sql, /GRANT SELECT, INSERT ON TABLE .*rent_ops_source_payloads.*rent_ops_source_binaries.* TO "rent_ops_staging_importer"/);
  assert.match(plan.sql, /GRANT SELECT ON TABLE .*rent_ops_source_payloads.*rent_ops_source_binaries.* TO "rent_ops_staging_auditor"/);
  assert.match(plan.sql, /GRANT SELECT ON TABLE .*rent_ops_document_objects.*rent_ops_record_changes.* TO "rent_ops_staging_auditor"/);
  assert.doesNotMatch(plan.sql, /GRANT [^;]*(?:INSERT|UPDATE|DELETE)[^;]*rent_ops_record_changes[^;]* TO "rent_ops_staging_auditor"/);
  assert.doesNotMatch(plan.sql, /GRANT [^;]*UPDATE[^;]* ON TABLE [^;]*rent_ops_source_payloads[^;]* TO "rent_ops_staging_importer"/);
  assert.doesNotMatch(plan.sql, /GRANT [^;]*rent_ops_source_payloads[^;]* TO "rent_ops_staging_web"/);
  assert.doesNotMatch(plan.sql, /ALL TABLES IN SCHEMA/);
  assert.doesNotMatch(plan.sql, /ALL SEQUENCES IN SCHEMA/);
  assert.match(plan.sql, /ALTER ROLE "rent_ops_staging_web" NOINHERIT/);
  assert.match(plan.sql, /ALTER ROLE "rent_ops_staging_importer" NOINHERIT/);
  assert.match(plan.sql, /ALTER ROLE "rent_ops_staging_auditor" NOINHERIT/);
  assert.equal(plan.sql.includes("postgres://"), false);
});

test("production remains blocked until explicit human authorization and a reference are present", () => {
  const unauthorised = verifiedManifest("production");
  unauthorised.authorization = { productionExplicitlyAuthorized: false };
  const validation = validateRentOpsSecurityManifest(unauthorised);
  assert.equal(validation.valid, false);
  assert.ok(validation.blockingReasons.includes("production_not_explicitly_authorized"));
  assert.ok(validation.blockingReasons.includes("production_authorization_reference_missing"));
  assert.throws(() => renderRentOpsSecuritySql(unauthorised, { mode: "apply" }), /rent_ops_security_apply_blocked:.*production_not_explicitly_authorized/);

  const authorised = verifiedManifest("production");
  const plan = renderRentOpsSecuritySql(authorised, { mode: "apply" });
  assert.equal(plan.mode, "apply");
  assert.equal(plan.canApply, true);
  assert.match(plan.sql, /Target: production\/rent_ops_production/);
  assert.match(plan.sql, /COMMIT;/);
});

test("manifest rejects shared DATABASE_URL, restricted runtime tables, and destructive web privilege", () => {
  const manifest = verifiedManifest();
  manifest.target.runtimeDatabaseUrlEnv = "DATABASE_URL";
  manifest.runtimeTables = [...manifest.runtimeTables, RENT_OPS_RESTRICTED_TABLES[0]];
  manifest.runtimeTablePrivileges = ["SELECT", "DELETE"];
  const validation = validateRentOpsSecurityManifest(manifest);
  assert.ok(validation.blockingReasons.includes("security_target_runtime_database_url_env_invalid"));
  assert.ok(validation.blockingReasons.includes("runtime_restricted_table_forbidden"));
  assert.ok(validation.blockingReasons.includes("runtime_table_privilege_outside_allowlist"));

  const metadataOvergrant = verifiedManifest();
  metadataOvergrant.runtimeReadOnlyTablePrivileges = ["SELECT", "UPDATE"];
  const metadataValidation = validateRentOpsSecurityManifest(metadataOvergrant);
  assert.ok(metadataValidation.blockingReasons.includes("runtime_read_only_table_privilege_outside_allowlist"));

  const appendOnlyOvergrant = verifiedManifest();
  appendOnlyOvergrant.runtimeAppendOnlyTablePrivileges = ["SELECT", "UPDATE"];
  const appendOnlyValidation = validateRentOpsSecurityManifest(appendOnlyOvergrant);
  assert.ok(appendOnlyValidation.blockingReasons.includes("runtime_append_only_table_privilege_outside_allowlist"));

  const restrictedOvergrant = verifiedManifest();
  restrictedOvergrant.restrictedTablePrivileges = ["SELECT", "INSERT", "UPDATE"];
  const restrictedOvergrantValidation = validateRentOpsSecurityManifest(restrictedOvergrant);
  assert.ok(restrictedOvergrantValidation.blockingReasons.includes("restricted_table_privilege_outside_allowlist"));

  const restrictedIncomplete = verifiedManifest();
  restrictedIncomplete.restrictedTablePrivileges = ["SELECT"];
  const restrictedIncompleteValidation = validateRentOpsSecurityManifest(restrictedIncomplete);
  assert.ok(restrictedIncompleteValidation.blockingReasons.includes("restricted_table_privilege_set_incomplete"));

  const importerLedgerOvergrant = verifiedManifest();
  importerLedgerOvergrant.importerReadOnlyTablePrivileges = ["SELECT", "UPDATE"];
  const importerLedgerValidation = validateRentOpsSecurityManifest(importerLedgerOvergrant);
  assert.ok(importerLedgerValidation.blockingReasons.includes("importer_read_only_table_privilege_outside_allowlist"));
});

test("checklist exposes the separate target and all deployment gates without credentials", () => {
  const manifest = verifiedManifest();
  const checklist = buildRentOpsSecurityChecklist(manifest);
  assert.equal(checklist.canApply, true);
  assert.equal(checklist.target.environment, "staging");
  assert.ok(checklist.items.some((item) => item.id === "dedicated_runtime_database_url" && item.status === "pass"));
  assert.ok(checklist.items.some((item) => item.id === "dedicated_importer_database_url" && item.status === "pass"));
  assert.ok(checklist.items.some((item) => item.id === "backup_attestation" && item.status === "pass"));
  assert.equal(JSON.stringify(checklist).includes("postgres://"), false);
});


test("application account and receipt tables receive only their runtime grants", () => {
  const manifest = verifiedManifest();
  const plan = renderRentOpsSecuritySql(manifest, { mode: "apply" });
  for (const table of RENT_OPS_APPLICATION_TABLES) {
    assert.ok(!RENT_OPS_IMPORTER_TABLES.includes(table as never));
    const runtimeGrants = plan.statements.filter((statement) => statement.startsWith("GRANT ") && statement.endsWith('TO "rent_ops_staging_web";') && statement.includes(`"${table}"`));
    assert.equal(runtimeGrants.length, 1, `${table} has one runtime privilege class`);
    const grant = runtimeGrants[0];
    if ((RENT_OPS_RUNTIME_EPHEMERAL_TABLES as readonly string[]).includes(table)) assert.match(grant, /^GRANT SELECT, INSERT, UPDATE, DELETE /);
    else if ((RENT_OPS_APPEND_ONLY_TABLES as readonly string[]).includes(table)) assert.match(grant, /^GRANT SELECT, INSERT ON /);
    else assert.match(grant, /^GRANT SELECT, INSERT, UPDATE ON /);
    assert.equal(plan.statements.some((statement) => statement.startsWith("GRANT ") && /TO "rent_ops_staging_(importer|auditor)";$/.test(statement) && statement.includes(`"${table}"`)), false, `${table} excluded from importer/auditor`);
    assert.ok(plan.statements.some((statement) => statement.startsWith("REVOKE ALL PRIVILEGES ON TABLE ") && statement.endsWith("FROM PUBLIC;") && statement.includes(`"${table}"`)));
  }
  assert.equal(plan.statements.some((statement) => /ALTER (TABLE|SEQUENCE).*OWNER/.test(statement)), false);
});

test("database public limiter is explicit and edge mode still requires its secret", () => {
  const database = validateRentOpsProductionConfiguration({ NODE_ENV: "production", RENT_OPS_PUBLIC_LIMITER_MODE: "database" });
  assert.ok(!database.blockingReasons.includes("production_global_public_limiter_required"));
  assert.ok(!database.blockingReasons.includes("production_rent_ops_edge_attestation_secret_required"));
  assert.ok(database.blockingReasons.includes("production_rent_ops_runtime_database_url_invalid"));
  assert.ok(database.blockingReasons.includes("production_database_limiter_session_secret_too_short"));
  const edge = validateRentOpsProductionConfiguration({ NODE_ENV: "production", RENT_OPS_PUBLIC_LIMITER_MODE: "edge-attestation" });
  assert.ok(edge.blockingReasons.includes("production_rent_ops_edge_attestation_secret_required"));
  const memory = validateRentOpsProductionConfiguration({ NODE_ENV: "production", RENT_OPS_PUBLIC_LIMITER_MODE: "process-memory" });
  assert.ok(memory.blockingReasons.includes("production_global_public_limiter_required"));
});

test("managed Gmail startup does not require an unused webhook receiver or manual OAuth secrets",()=>{
 const configured=validateRentOpsProductionConfiguration({NODE_ENV:"production",RENT_OPS_TENANT_EMAIL_PROVIDER:"replit-gmail",RENT_OPS_TENANT_EMAIL_ENABLED:"true",RENT_OPS_GMAIL_FROM:"sender@example.test",RENT_OPS_PUBLIC_APP_URL:"https://portal.example.test"});
 assert.equal(configured.blockingReasons.some(reason=>/webhook|gmail_client|gmail_refresh|email_delivery_disabled|gmail_sender/.test(reason)),false);
 const disabled=validateRentOpsProductionConfiguration({NODE_ENV:"production",RENT_OPS_TENANT_EMAIL_PROVIDER:"replit-gmail"});
 assert.ok(disabled.blockingReasons.includes("production_email_delivery_disabled"));
});

test("pre-launch production email requires an exact recipient allowlist when enabled", () => {
  const validate = (allowed?: string) => validateRentOpsProductionConfiguration({ NODE_ENV: "production", RENT_OPS_TENANT_EMAIL_ENABLED: "true", RENT_OPS_EMAIL_ALLOWED_RECIPIENTS: allowed }).blockingReasons;
  assert.ok(validate().includes("production_email_recipient_allowlist_required"));
  assert.ok(validate("*").includes("production_email_recipient_allowlist_invalid"));
  assert.equal(validate("qa@example.test").some(reason => reason.startsWith("production_email_recipient_allowlist_")), false);
});
