import assert from "node:assert/strict";
import test from "node:test";
import { RENT_OPS_REQUIRED_TABLES, RENT_OPS_SCHEMA_VERSION, rentOpsMigrationChecksumForVersion } from "../persistence";
import type { RentOpsQueryExecutor } from "../repositories/postgres";
import {
  DATABASE_AUDIT_SQL,
  DatabaseAuditError,
  inspectDatabaseTarget,
  runDatabaseAudit,
  type DatabaseAuditCounts,
  type DatabaseAuditExpected,
  type DatabaseAuditFinancialReportControl,
  type DatabaseAuditExpectedFinancialReportProperty,
  type DatabaseAuditRestrictedBinaryDescriptor,
  type DatabaseAuditRestrictedVersion,
  type DatabaseAuditReportParity,
  type DatabaseAuditTotals,
} from "./database-audit";

const STAGING_FINGERPRINT = "0f0362269120239d";
const migrationChecksums = Object.fromEntries(
  Array.from({ length: RENT_OPS_SCHEMA_VERSION }, (_unused, index) => [index + 1, rentOpsMigrationChecksumForVersion(index + 1)]),
);

const counts: DatabaseAuditCounts = {
  properties: 1,
  units: 1,
  people: 1,
  applications: 0,
  applicationHouseholdMembers: 0,
  applicationRequirements: 0,
  tenancies: 1,
  householdMemberships: 0,
  leaseTerms: 1,
  recurringSchedules: 1,
  ledgerTransactions: 4,
  paymentAllocations: 1,
  securityDeposits: 1,
  subsidyContracts: 1,
  documents: 0,
  activityEvents: 0,
  sourceRecords: 14,
  importRuns: 1,
};

const totals: DatabaseAuditTotals = {
  chargesCents: 85000,
  paymentsCents: 85000,
  creditsCents: 0,
  netLedgerCents: 0,
  netLedgerBalanceCents: 0,
  allocationsCents: 85000,
  depositsCents: 85000,
  hapAgencyObligationCents: 40000,
  hapTenantObligationCents: 45000,
};

const report: DatabaseAuditReportParity = {
  rentRollRows: 1,
  currentOccupiedUnits: 1,
  futurePreleasedUnits: 0,
  vacantUnits: 0,
  activeHapContracts: 1,
  hapAgencyCents: 40000,
  hapTenantCents: 45000,
  effectiveBaseRentCents: 85000,
  effectiveRecurringFeesCents: 0,
};

function sourceRows() {
  return [{ system: "rent_manager", entity_type: "property", source_id: "p1", checksum: "a".repeat(64), target_id: "rm:property:p1" }];
}

function zeroChecks(): Record<string, number> {
  return { check_a: 0, check_b: 0 };
}

class AuditFake implements RentOpsQueryExecutor {
  readonly calls: Array<{ text: string; values?: unknown[] }> = [];
  readonly transactions: Array<{ readOnly?: boolean }> = [];
  missingSchema = false;
  countValues: DatabaseAuditCounts = { ...counts };
  totalValues: DatabaseAuditTotals = { ...totals };
  reportValues: DatabaseAuditReportParity = { ...report };
  financialReportValues: Record<string, unknown>[] = [{
    property_id: null,
    source_row_count: 1,
    known_count: 1,
    known_cents: 85000,
    uncertain_count: 0,
    uncertain_cents: 0,
    unassigned_count: 0,
    unassigned_cents: 0,
    not_applicable_count: 0,
    not_applicable_cents: 0,
    suppressed_count: 0,
    suppressed_cents: 0,
    ended_count: 0,
    ended_cents: 0,
    inactive_count: 0,
    inactive_cents: 0,
    future_count: 0,
    future_cents: 0,
    unknown_amount_count: 0,
    unknown_amount_cents: 0,
    invalid_count: 0,
    invalid_cents: 0,
    property_once_count: 0,
    property_once_cents: 0,
    former_tenancy_leakage_count: 0,
  }, {
    property_id: "p1",
    source_row_count: 1,
    known_count: 1,
    known_cents: 85000,
    uncertain_count: 0,
    uncertain_cents: 0,
    unassigned_count: 0,
    unassigned_cents: 0,
    not_applicable_count: 0,
    not_applicable_cents: 0,
    suppressed_count: 0,
    suppressed_cents: 0,
    ended_count: 0,
    ended_cents: 0,
    inactive_count: 0,
    inactive_cents: 0,
    future_count: 0,
    future_cents: 0,
    unknown_amount_count: 0,
    unknown_amount_cents: 0,
    invalid_count: 0,
    invalid_cents: 0,
    property_once_count: 0,
    property_once_cents: 0,
    former_tenancy_leakage_count: 0,
  }];
  orphanValues: Record<string, number> = zeroChecks();
  allocationValues: Record<string, number> = zeroChecks();
  ledgerValues: Record<string, number> = zeroChecks();
  duplicateValues: Record<string, number> = zeroChecks();
  dateValues: Record<string, number> = zeroChecks();
  fidelityValues: Record<string, number> = {};
  sourceValues = sourceRows();
  sourcePayloadValues: Record<string, unknown>[] = [{
    system: "rent_manager",
    source_collection: "tenants",
    source_id: "t1",
    checksum_sha256: "c".repeat(64),
    import_run_id: "run-1",
  }];
  sourceBinaryValues: Record<string, unknown>[] = [{
    system: "rent_manager",
    source_collection: "documents",
    source_id: "d1",
    checksum_sha256: "d".repeat(64),
    import_run_id: "run-1",
    size_bytes: 12,
    content_type: "application/pdf",
    verification_status: "verified",
  }];

  async query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.calls.push({ text, values });
    if (text === DATABASE_AUDIT_SQL.targetIdentity) return { rows: [{ redacted_fingerprint: STAGING_FINGERPRINT }] as T[] };
    if (text === DATABASE_AUDIT_SQL.schemaMeta) return {
      rows: Object.entries(migrationChecksums).map(([version, checksum_sha256]) => ({ version: Number(version), checksum_sha256 })) as T[],
    };
    if (text === DATABASE_AUDIT_SQL.schema) {
      const rows = this.missingSchema ? [] : RENT_OPS_REQUIRED_TABLES.map((table_name) => ({ table_name }));
      return { rows: rows as T[] };
    }
    if (text === DATABASE_AUDIT_SQL.counts) {
      return { rows: Object.entries(this.countValues).map(([metric, value]) => ({ metric, value })) as T[] };
    }
    if (text === DATABASE_AUDIT_SQL.totals) return { rows: [{
      charges_cents: this.totalValues.chargesCents,
      payments_cents: this.totalValues.paymentsCents,
      credits_cents: this.totalValues.creditsCents,
      net_ledger_cents: this.totalValues.netLedgerCents,
      net_ledger_balance_cents: this.totalValues.netLedgerBalanceCents,
      allocations_cents: this.totalValues.allocationsCents,
      deposits_cents: this.totalValues.depositsCents,
      hap_agency_obligation_cents: this.totalValues.hapAgencyObligationCents,
      hap_tenant_obligation_cents: this.totalValues.hapTenantObligationCents,
    }] as T[] };
    if (text === DATABASE_AUDIT_SQL.orphans) return { rows: [this.orphanValues] as T[] };
    if (text === DATABASE_AUDIT_SQL.allocationInvariants) return { rows: [this.allocationValues] as T[] };
    if (text === DATABASE_AUDIT_SQL.ledgerInvariants) return { rows: [this.ledgerValues] as T[] };
    if (text === DATABASE_AUDIT_SQL.duplicates) return { rows: [this.duplicateValues] as T[] };
    if (text === DATABASE_AUDIT_SQL.dates) return { rows: [this.dateValues] as T[] };
    if (text === DATABASE_AUDIT_SQL.propertyControls) return { rows: [] };
    if (text === DATABASE_AUDIT_SQL.sourceRecords) return { rows: this.sourceValues as T[] };
    if (text === DATABASE_AUDIT_SQL.sourcePayloadMetadata) return { rows: this.sourcePayloadValues as T[] };
    if (text === DATABASE_AUDIT_SQL.sourceBinaryMetadata) return { rows: this.sourceBinaryValues as T[] };
    if (text === DATABASE_AUDIT_SQL.reportParity) return { rows: [{
      rent_roll_rows: this.reportValues.rentRollRows,
      current_occupied_units: this.reportValues.currentOccupiedUnits,
      future_preleased_units: this.reportValues.futurePreleasedUnits,
      vacant_units: this.reportValues.vacantUnits,
      active_hap_contracts: this.reportValues.activeHapContracts,
      hap_agency_cents: this.reportValues.hapAgencyCents,
      hap_tenant_cents: this.reportValues.hapTenantCents,
      effective_base_rent_cents: this.reportValues.effectiveBaseRentCents,
      effective_recurring_fees_cents: this.reportValues.effectiveRecurringFeesCents,
    }] as T[] };
    if (text === DATABASE_AUDIT_SQL.financialReportV8) return { rows: this.financialReportValues as T[] };
    if (text === DATABASE_AUDIT_SQL.fidelityControls) return { rows: [this.fidelityValues] as T[] };
    return { rows: [] };
  }

  async transaction<T>(work: (executor: RentOpsQueryExecutor) => Promise<T>, options?: { readOnly?: boolean }): Promise<T> {
    this.transactions.push(options ?? {});
    return work(this);
  }
}

function expectedFor(fake: AuditFake): DatabaseAuditExpected {
  const payloadRecords: DatabaseAuditRestrictedVersion[] = fake.sourcePayloadValues.map((row) => ({
    system: String(row.system),
    sourceCollection: String(row.source_collection),
    sourceId: String(row.source_id),
    checksumSha256: String(row.checksum_sha256),
  }));
  const binaryRecords: DatabaseAuditRestrictedBinaryDescriptor[] = fake.sourceBinaryValues.map((row) => ({
    system: String(row.system),
    sourceCollection: String(row.source_collection),
    sourceId: String(row.source_id),
    checksumSha256: String(row.checksum_sha256),
    sizeBytes: Number(row.size_bytes),
    contentType: String(row.content_type),
    verificationStatus: String(row.verification_status),
  }));
  const financialRows = fake.financialReportValues.map((row) => ({
    propertyKey: row.property_id == null ? "portfolio" : String(row.property_id),
    sourceRowCount: Number(row.source_row_count),
    knownCount: Number(row.known_count),
    knownCents: Number(row.known_cents),
    uncertainCount: Number(row.uncertain_count),
    uncertainCents: Number(row.uncertain_cents),
    unassignedCount: Number(row.unassigned_count),
    unassignedCents: Number(row.unassigned_cents),
    notApplicableCount: Number(row.not_applicable_count),
    notApplicableCents: Number(row.not_applicable_cents),
    suppressedCount: Number(row.suppressed_count),
    suppressedCents: Number(row.suppressed_cents),
    endedCount: Number(row.ended_count),
    endedCents: Number(row.ended_cents),
    inactiveCount: Number(row.inactive_count),
    inactiveCents: Number(row.inactive_cents),
    futureCount: Number(row.future_count),
    futureCents: Number(row.future_cents),
    unknownAmountCount: Number(row.unknown_amount_count),
    unknownAmountCents: Number(row.unknown_amount_cents),
    invalidCount: Number(row.invalid_count),
    invalidCents: Number(row.invalid_cents),
    propertyOnceCount: Number(row.property_once_count),
    propertyOnceCents: Number(row.property_once_cents),
    formerTenancyLeakageCount: Number(row.former_tenancy_leakage_count),
  } satisfies DatabaseAuditFinancialReportControl));
  const portfolio = financialRows.find((row) => row.propertyKey === "portfolio");
  const financialPropertyRows = financialRows.filter((row) => row.propertyKey !== "portfolio").map((row) => ({
    propertyId: row.propertyKey,
    ...row,
  } satisfies DatabaseAuditExpectedFinancialReportProperty));
  return {
    counts: fake.countValues,
    totalsCents: fake.totalValues,
    reportParity: fake.reportValues,
    sourceRecords: fake.sourceValues.map((row) => ({ system: String(row.system), entityType: String(row.entity_type) as never, sourceId: String(row.source_id), checksum: String(row.checksum), targetId: String(row.target_id), id: "source:p1", importedAt: "2026-08-16T12:00:00.000Z" })),
    restrictedSourcePayloads: { records: payloadRecords },
    restrictedSourceBinaries: { records: binaryRecords },
    perProperty: [],
    financialReport: {
      portfolio,
      perProperty: financialPropertyRows,
    },
  };
}

test("target inspection derives a redacted identity and validates the complete ordered migration ledger", async () => {
  const fake = new AuditFake();
  const inspection = await inspectDatabaseTarget(fake);
  assert.deepEqual(inspection, {
    redactedFingerprint: STAGING_FINGERPRINT,
    migrationVersion: RENT_OPS_SCHEMA_VERSION,
    migrationChecksum: migrationChecksums[RENT_OPS_SCHEMA_VERSION],
    requiredTables: RENT_OPS_REQUIRED_TABLES.length,
    migrationChecksums,
    migrationChainValid: true,
  });
  assert.equal(fake.calls.some((call) => call.text === DATABASE_AUDIT_SQL.targetIdentity), true);
  assert.equal(fake.calls.some((call) => call.text === DATABASE_AUDIT_SQL.schemaMeta), true);
});

test("database audit is read-only and passes redacted count, money, HAP, and source-hash controls", async () => {
  const fake = new AuditFake();
  const result = await runDatabaseAudit(fake, { asOfDate: "2026-08-16", expected: expectedFor(fake) });
  assert.equal(result.passed, true);
  assert.equal(fake.transactions.length, 1);
  assert.equal(fake.transactions[0].readOnly, true);
  assert.equal(result.totalsCents.netLedgerBalanceCents, 0);
  assert.equal(result.totalsCents.hapAgencyObligationCents, 40000);
  assert.equal(JSON.stringify(result).includes("Synthetic"), false);
  assert.equal(fake.calls.every((call) => /^\s*SELECT/i.test(call.text)), true);
});

test("count, net-ledger, HAP, and source-hash mismatches block audit", async () => {
  const fake = new AuditFake();
  fake.countValues = { ...counts, units: 2 };
  fake.totalValues = { ...totals, netLedgerCents: 100, netLedgerBalanceCents: 100, hapAgencyObligationCents: 41000 };
  fake.reportValues = { ...report, hapAgencyCents: 41000 };
  fake.sourceValues = [{ ...sourceRows()[0], checksum: "b".repeat(64) }];
  const result = await runDatabaseAudit(fake, { asOfDate: "2026-08-16", expected: expectedFor(new AuditFake()) });
  assert.equal(result.passed, false);
  assert.ok(result.blockingReasons.includes("count_units_mismatch"));
  assert.ok(result.blockingReasons.includes("total_netLedgerCents_mismatch"));
  assert.ok(result.blockingReasons.includes("total_hapAgencyObligationCents_mismatch"));
  assert.ok(result.blockingReasons.includes("report_hapAgencyCents_mismatch"));
  assert.ok(result.blockingReasons.includes("raw_source_hash_parity_failed"));
});

test("orphan, duplicate, and date controls block audit without exposing row identifiers", async () => {
  const fake = new AuditFake();
  fake.orphanValues = { orphan_unit: 1 };
  fake.duplicateValues = { active_unit_conflicts: 1 };
  fake.dateValues = { allocation_before_charge: 1 };
  const result = await runDatabaseAudit(fake, { asOfDate: "2026-08-16", expected: expectedFor(fake) });
  assert.equal(result.passed, false);
  assert.ok(result.blockingReasons.includes("orphans_present"));
  assert.ok(result.blockingReasons.includes("duplicates_present"));
  assert.ok(result.blockingReasons.includes("date_conflicts_present"));
  assert.equal(JSON.stringify(result).includes("p1"), false);
});

test("allocation and ledger invariants block audit without returning entity identifiers", async () => {
  const fake = new AuditFake();
  fake.allocationValues = { allocation_property_mismatch: 1, allocations_exceed_payment: 1 };
  fake.ledgerValues = { reversal_payload_mismatch: 1, allocation_payment_voided: 0 };
  const result = await runDatabaseAudit(fake, { asOfDate: "2026-08-16", expected: expectedFor(fake) });
  assert.equal(result.passed, false);
  assert.ok(result.blockingReasons.includes("allocation_invariants_failed"));
  assert.ok(result.blockingReasons.includes("ledger_invariants_failed"));
  assert.equal(result.allocationChecks.checks.allocation_property_mismatch, 1);
  assert.equal(result.allocationChecks.checks.allocations_exceed_payment, 1);
  assert.equal(result.ledgerChecks.checks.reversal_payload_mismatch, 1);
  assert.equal(JSON.stringify(result).includes("allocation_property_mismatch"), true);
  assert.equal(JSON.stringify(result).includes("p1"), false);
});

test("missing schema fails closed before audit queries", async () => {
  const fake = new AuditFake();
  fake.missingSchema = true;
  await assert.rejects(() => runDatabaseAudit(fake, { asOfDate: "2026-08-16", expected: expectedFor(fake) }), (error: unknown) => error instanceof DatabaseAuditError && error.reasons.includes("required_schema_missing"));
  assert.equal(fake.calls.filter((call) => call.text === DATABASE_AUDIT_SQL.counts).length, 0);
});

test("net-ledger SQL carries debit and credit adjustment reversal semantics", () => {
  assert.match(DATABASE_AUDIT_SQL.totals, /original\.adjustment_direction = 'credit'/);
  assert.match(DATABASE_AUDIT_SQL.totals, /original\.adjustment_direction = 'debit'/);
  assert.match(DATABASE_AUDIT_SQL.totals, /kind = 'adjustment'/);
  assert.match(DATABASE_AUDIT_SQL.totals, /kind = 'reversal'/);
  assert.match(DATABASE_AUDIT_SQL.totals, /THEN amount_cents/);
  assert.match(DATABASE_AUDIT_SQL.totals, /ELSE 0/);
  assert.match(DATABASE_AUDIT_SQL.totals, /original\.kind = 'reversal'/);
  assert.match(DATABASE_AUDIT_SQL.totals, /NOT EXISTS \(SELECT 1 FROM rent_ops_ledger_transactions original/);
  assert.match(DATABASE_AUDIT_SQL.totals, /WHEN kind = 'reversal' THEN 0/);
});

test("v2 audit SQL reads the ordered ledger and treats optional schedule/deposit links as nullable", () => {
  assert.match(DATABASE_AUDIT_SQL.schemaMeta, /rent_ops_schema_migrations/);
  assert.doesNotMatch(DATABASE_AUDIT_SQL.schemaMeta, /rent_ops_schema_meta/);
  assert.match(DATABASE_AUDIT_SQL.orphans, /s\.tenancy_id IS NOT NULL AND t\.id IS NULL/);
  assert.match(DATABASE_AUDIT_SQL.orphans, /s\.unit_id IS NOT NULL AND u\.id IS NULL/);
  assert.match(DATABASE_AUDIT_SQL.orphans, /d\.tenancy_id IS NOT NULL AND t\.id IS NULL/);
  assert.match(DATABASE_AUDIT_SQL.orphans, /d\.unit_id IS NOT NULL AND u\.id IS NULL/);
});

test("independent v2 fidelity controls receive the audit as-of date and block uncertainty/identity drift", async () => {
  const fake = new AuditFake();
  fake.fidelityValues = { schedule_unknown_open_start_boundary_violation_rows: 1, deposit_duplicate_identity_rows: 1 };
  const result = await runDatabaseAudit(fake, { asOfDate: "2026-08-16", expected: expectedFor(fake) });
  assert.equal(result.passed, false);
  assert.ok(result.blockingReasons.includes("fidelity_schedule_unknown_open_start_boundary_violation_rows"));
  assert.ok(result.blockingReasons.includes("fidelity_deposit_duplicate_identity_rows"));
  const fidelityCall = fake.calls.find((call) => call.text === DATABASE_AUDIT_SQL.fidelityControls);
  assert.deepEqual(fidelityCall?.values, ["2026-08-16"]);
});

test("fidelity SQL covers scope/date knowledge, source exact-once, deposit types, and precedence/property-once recomputation", () => {
  const sql = DATABASE_AUDIT_SQL.fidelityControls;
  for (const fragment of [
    "schedule_source_row_count", "schedule_distinct_target_identity_count", "schedule_duplicate_identity_rows",
    "schedule_tenant_amount_cents", "schedule_unit_amount_cents", "schedule_property_amount_cents",
    "schedule_known_start_count", "schedule_unknown_start_count", "schedule_unknown_open_start_boundary_violation_rows",
    "schedule_former_tenant_leakage_rows", "effective_base_rent_cents_independent", "property_definition_overridden_rows",
    "deposit_source_row_count", "deposit_duplicate_identity_rows", "deposit_unknown_receipt_date_count",
    "deposit_known_receipt_date_count", "deposit_unknown_unit_count", "held_unknown_receipt_included_cents",
  ]) assert.match(sql, new RegExp(fragment));
});

test("fidelity controls retain the legacy definition-key fallback outside strict lineage validation", () => {
  const sql = DATABASE_AUDIT_SQL.fidelityControls;
  const fidelityScheduleRows = sql.slice(sql.lastIndexOf("schedule_rows AS ("), sql.indexOf("schedule_sources AS ("));
  assert.match(fidelityScheduleRows, /COALESCE\(s\.charge_definition_id, s\.charge_definition_key, 'unknown:' \|\| s\.id\)/);
  assert.match(sql, /lineage_schedule_rows AS \(/);
});

test("independent v8 financial report SQL contains month, lease, lineage, scope, assignment, precedence, and disjoint buckets", () => {
  const sql = DATABASE_AUDIT_SQL.financialReportV8;
  assert.match(sql, /^\s*SELECT\s+\*\s+FROM\s+\(/i);
  for (const fragment of [
    "report_interval", "DATE_TRUNC('month'", "month_start", "month_end", "observation_month",
    "rent_ops_lease_terms", "contract_start_on", "contract_end_on", "effective_lease_count", "tenancy_link_knowledge",
    "rent_ops_units", "COUNT(u.unit_id)", "property_unknown_unit_tenancies", "unknown_assignment_count", "occupancy_state", "vacant", "scheduled_tenancy_unit_id", "assigned_tenancy_id",
    "WITH RECURSIVE", "lineage_walk", "lineage_root_id", "supersedes_id", "version_action = 'root'",
    "version_action = 'end'", "version_origin", "source_system", "source_artifact_sha256", "artifact_observation_on", "lineage_invalid_quarantined", "scope_type", "scope_id",
    "scope_type_knowledge", "scope_link_knowledge", "person_only", "person_assignment_count",
    "resolved_unit_id", "charge_definition_link_knowledge", "PARTITION BY s.resolved_unit_id, s.definition_key", "maximum_scope_rank_count", "scope_rank DESC",
    "property_definition_count", "property_once_rank", "property_once_count", "property_definition_count = 1", "not_applicable", "not_applicable_count", "former_tenancy_leakage_count",
    "property_inventory", "rent_ops_properties", "LEFT JOIN all_buckets", "COUNT(bucket.id)",
    "actual_move_out_on", "planned_move_in_on", "unknown_open_start", "future_preleased",
    "known_count", "uncertain_count", "unassigned_count", "suppressed_count", "ended_count",
    "inactive_count", "future_count", "unknown_amount_count", "invalid_count", "known_cents",
    "uncertain_cents", "unassigned_cents", "suppressed_cents", "ended_cents", "inactive_cents",
    "future_cents", "unknown_amount_cents", "not_applicable_cents", "property_id NULLS FIRST",
  ]) assert.match(sql, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(sql, /i\.month_start >= DATE_TRUNC\('month', l\.artifact_observation_on\)/);
  assert.match(sql, /PARTITION BY s\.property_id, s\.definition_key/);
  assert.match(sql, /l\.scope_type_knowledge IN \('source', 'manual'\)/);
  assert.match(sql, /maximum_scope_rank_count <> 1/);
  assert.match(sql, /s\.version_origin IS DISTINCT FROM 'artifact'/);
  assert.match(sql, /s\.version_origin IS DISTINCT FROM 'manual'/);
  assert.match(sql, /child\.effective_from_knowledge IS DISTINCT FROM 'manual'/);
  assert.match(sql, /walk\.effective_from IS NULL[\s\S]*walk\.effective_from_knowledge = 'unknown_open_start'[\s\S]*child\.effective_from < walk\.artifact_observation_on/);
  assert.match(sql, /walk\.effective_to IS NOT NULL AND child\.effective_from > walk\.effective_to/);
  const eligibleSql = sql.slice(sql.indexOf("lineage_eligible AS"), sql.indexOf("lineage_classified AS"));
  assert.doesNotMatch(eligibleSql, /l\.effective_to/);
  const baseSql = sql.slice(sql.indexOf("lineage_rows_base AS"), sql.indexOf("lineage_invalid_roots AS"));
  assert.doesNotMatch(baseSql, /s\.scope_type IS NULL|s\.scope_id IS NULL/);
  assert.match(sql, /child\.scope_type_knowledge IS DISTINCT FROM walk\.scope_type_knowledge/);
  assert.match(sql, /child\.description_knowledge IS DISTINCT FROM walk\.description_knowledge/);
  const lineageWalkSql = sql.slice(sql.indexOf("lineage_walk AS"), sql.indexOf("lineage_orphans AS"));
  for (const inheritedColumn of [
    "scope_type_knowledge", "scope_link_knowledge", "charge_definition_key", "charge_definition_knowledge",
    "charge_definition_link_knowledge", "category_knowledge", "description", "description_knowledge",
    "source_confidence", "active_knowledge",
  ]) {
    assert.match(lineageWalkSql, new RegExp(`s\\.${inheritedColumn}`));
    assert.match(lineageWalkSql, new RegExp(`child\\.${inheritedColumn}`));
  }
  assert.match(sql, /child\.version_action = 'end'[\s\S]*child\.effective_to IS DISTINCT FROM child\.effective_from/);
  assert.match(sql, /l\.scope_type = 'unit'[\s\S]*l\.tenancy_id IS NULL AND l\.person_id IS NULL/);
  assert.match(sql, /l\.scope_type = 'tenant'[\s\S]*l\.person_id IS NULL OR l\.person_id = l\.scope_id/);
  assert.match(sql, /l\.scope_type = 'tenant' AND l\.tenancy_id IS NULL[\s\S]*l\.scope_id = uo\.person_id[\s\S]*l\.unit_id IS NULL OR l\.unit_id = uo\.unit_id/);
  assert.match(sql, /COUNT\(\*\) FILTER \(WHERE bucket\.unknown_amount = 1\)::bigint AS unknown_amount_count/);
  assert.doesNotMatch(sql, /bucket = 'unknown_amount'/);
  assert.match(sql, /COALESCE\(MAX\(pu\.unknown_assignment_count\), 0\) = 0[\s\S]*THEN MAX\(u\.tenancy_id\)/);
  assert.match(sql, /COALESCE\(MAX\(pu\.unknown_assignment_count\), 0\) = 0[\s\S]*THEN MAX\(u\.primary_person_id\)/);
  assert.doesNotMatch(sql, /projectFinancialSchedules|serializePublic|financial-projection\.ts/);
});

test("v8 financial report aggregate parity accepts exact redacted fixture and rejects count/cents/property-once/former leakage drift", async () => {
  const fake = new AuditFake();
  const expected = expectedFor(fake);
  const exact = await runDatabaseAudit(fake, { asOfDate: "2026-08-16", expected });
  assert.equal(exact.passed, true);
  assert.equal(exact.financialReport.some((row) => row.propertyKey === "p1"), false);
  assert.equal(JSON.stringify(exact).includes("p1"), false);
  assert.equal(JSON.stringify(exact).includes("property_id"), false);
  const financialCall = fake.calls.find((call) => call.text === DATABASE_AUDIT_SQL.financialReportV8);
  assert.deepEqual(financialCall?.values, ["2026-08-16"]);

  const drift = new AuditFake();
  drift.financialReportValues = drift.financialReportValues.map((row) => row.property_id === "p1"
    ? { ...row, known_count: 2, known_cents: 86000, not_applicable_count: 1, not_applicable_cents: 100, property_once_count: 1, former_tenancy_leakage_count: 1 }
    : row);
  const rejected = await runDatabaseAudit(drift, { asOfDate: "2026-08-16", expected: expectedFor(new AuditFake()) });
  assert.equal(rejected.passed, false);
  assert.ok(rejected.blockingReasons.includes("financial_report_property_known_count_mismatch"));
  assert.ok(rejected.blockingReasons.includes("financial_report_property_known_cents_mismatch"));
  assert.ok(rejected.blockingReasons.includes("financial_report_property_not_applicable_count_mismatch"));
  assert.ok(rejected.blockingReasons.includes("financial_report_property_not_applicable_cents_mismatch"));
  assert.ok(rejected.blockingReasons.includes("financial_report_property_property_once_count_mismatch"));
  assert.ok(rejected.blockingReasons.includes("financial_report_former_tenancy_leakage"));
});

test("v8 financial report retains an explicit zero-control row for a property with no schedules", async () => {
  const fake = new AuditFake();
  fake.financialReportValues.push({
    ...fake.financialReportValues[1],
    property_id: "p2",
    source_row_count: 0,
    known_count: 0,
    known_cents: 0,
  });
  const result = await runDatabaseAudit(fake, { asOfDate: "2026-08-16", expected: expectedFor(fake) });
  assert.equal(result.passed, true);
  assert.equal(result.financialReport.filter((row) => row.propertyKey !== "portfolio").length, 2);
  assert.equal(JSON.stringify(result).includes("p2"), false);
});

test("unknown amount count is diagnostic and does not double-count its semantic bucket", async () => {
  const fake = new AuditFake();
  fake.financialReportValues = fake.financialReportValues.map((row) => ({
    ...row,
    known_count: 0,
    known_cents: 0,
    uncertain_count: 1,
    uncertain_cents: 0,
    unknown_amount_count: 1,
    unknown_amount_cents: 0,
  }));
  const result = await runDatabaseAudit(fake, { asOfDate: "2026-08-16", expected: expectedFor(fake) });
  assert.equal(result.passed, true);
  assert.equal(result.financialReport.find((row) => row.propertyKey === "portfolio")?.unknownAmountCount, 1);
});

test("financial report conservation is enforced even when expected TS controls are absent", async () => {
  const fake = new AuditFake();
  fake.financialReportValues = fake.financialReportValues.map((row) => row.property_id == null
    ? { ...row, source_row_count: 2 }
    : row);
  const expected = expectedFor(fake);
  delete expected.financialReport;
  const result = await runDatabaseAudit(fake, { asOfDate: "2026-08-16", expected });
  assert.equal(result.passed, false);
  assert.ok(result.blockingReasons.includes("financial_report_bucket_conservation_failed"));
});

test("allocation and ledger invariant SQL covers parent, scope, amount, reversal, and void semantics", () => {
  assert.match(DATABASE_AUDIT_SQL.allocationInvariants, /allocation_payment_missing/);
  assert.match(DATABASE_AUDIT_SQL.allocationInvariants, /allocation_charge_missing/);
  assert.match(DATABASE_AUDIT_SQL.allocationInvariants, /allocation_property_mismatch/);
  assert.match(DATABASE_AUDIT_SQL.allocationInvariants, /allocation_tenancy_mismatch/);
  assert.match(DATABASE_AUDIT_SQL.allocationInvariants, /allocations_exceed_payment/);
  assert.match(DATABASE_AUDIT_SQL.allocationInvariants, /allocations_exceed_charge/);
  assert.match(DATABASE_AUDIT_SQL.allocationInvariants, /allocation_payment_reversed/);
  assert.match(DATABASE_AUDIT_SQL.allocationInvariants, /allocation_payment_voided/);
  assert.match(DATABASE_AUDIT_SQL.ledgerInvariants, /reversal_target_missing/);
  assert.match(DATABASE_AUDIT_SQL.ledgerInvariants, /reversal_of_reversal/);
  assert.match(DATABASE_AUDIT_SQL.ledgerInvariants, /reversal_payload_mismatch/);
  assert.match(DATABASE_AUDIT_SQL.ledgerInvariants, /reversal_of_non_posted/);
  assert.match(DATABASE_AUDIT_SQL.ledgerInvariants, /transaction_reversed_twice/);
  assert.match(DATABASE_AUDIT_SQL.ledgerInvariants, /adjustment_direction_missing/);
  assert.equal([DATABASE_AUDIT_SQL.allocationInvariants, DATABASE_AUDIT_SQL.ledgerInvariants].every((sql) => /^\s*SELECT/i.test(sql)), true);
});

test("restricted archive audit reads metadata only and proves payload/binary parity", async () => {
  const fake = new AuditFake();
  assert.doesNotMatch(DATABASE_AUDIT_SQL.sourcePayloadMetadata, /\bpayload\b/i);
  assert.doesNotMatch(DATABASE_AUDIT_SQL.sourcePayloadMetadata, /storage_key/i);
  assert.doesNotMatch(DATABASE_AUDIT_SQL.sourceBinaryMetadata, /storage_key/i);
  const result = await runDatabaseAudit(fake, { asOfDate: "2026-08-16", expected: expectedFor(fake) });
  assert.equal(result.passed, true);
  assert.equal(result.restrictedSourcePayloadParity.actualCount, 1);
  assert.equal(result.restrictedSourcePayloadParity.actualDistinctSourceCount, 1);
  assert.equal(result.restrictedSourcePayloadParity.actualDistinctVersionCount, 1);
  assert.equal(result.restrictedSourcePayloadParity.duplicateVersionRows, 0);
  assert.equal(result.restrictedSourcePayloadParity.conflictingSourceCount, 0);
  assert.equal(result.restrictedSourceBinaryParity.actualCount, 1);
  assert.equal(result.restrictedSourceBinaryParity.actualVerifiedCount, 1);
  assert.equal(result.restrictedSourceBinaryParity.actualMissingCount, 0);
  assert.equal(result.restrictedSourceBinaryParity.actualMismatchCount, 0);
  assert.equal(result.restrictedSourceBinaryParity.descriptorDigestActual.length, 64);
  assert.equal(JSON.stringify(result).includes("source_collection"), false);
  assert.equal(JSON.stringify(result).includes("source_id"), false);
  assert.equal(JSON.stringify(result).includes("storage_key"), false);
});

test("required audit controls include both restricted payload and binary expectations", async () => {
  const fake = new AuditFake();
  const expected = expectedFor(fake);
  delete expected.restrictedSourcePayloads;
  delete expected.restrictedSourceBinaries;
  const result = await runDatabaseAudit(fake, { asOfDate: "2026-08-16", expected });
  assert.equal(result.passed, false);
  assert.ok(result.blockingReasons.includes("expected_restricted_source_payloads_not_supplied"));
  assert.ok(result.blockingReasons.includes("expected_restricted_source_binaries_not_supplied"));
});

test("restricted archive audit catches version conflicts, duplicate rows, bad checksums, and binary verification drift", async () => {
  const fake = new AuditFake();
  fake.sourcePayloadValues = [
    { system: "rent_manager", source_collection: "tenants", source_id: "t1", checksum_sha256: "c".repeat(64), import_run_id: "run-1" },
    { system: "rent_manager", source_collection: "tenants", source_id: "t1", checksum_sha256: "c".repeat(64), import_run_id: "run-1" },
    { system: "rent_manager", source_collection: "tenants", source_id: "t1", checksum_sha256: "e".repeat(64), import_run_id: "run-1" },
    { system: "rent_manager", source_collection: "tenants", source_id: "t2", checksum_sha256: "not-a-sha", import_run_id: "run-1" },
  ];
  fake.sourceBinaryValues = [{
    system: "rent_manager",
    source_collection: "documents",
    source_id: "d1",
    checksum_sha256: "not-a-sha",
    import_run_id: "run-1",
    size_bytes: -1,
    content_type: "application/pdf",
    verification_status: "mismatch",
  }];
  const expected = expectedFor(new AuditFake());
  const result = await runDatabaseAudit(fake, { asOfDate: "2026-08-16", expected });
  assert.equal(result.passed, false);
  assert.ok(result.blockingReasons.includes("restricted_source_payload_integrity_or_parity_failed"));
  assert.ok(result.blockingReasons.includes("restricted_source_binary_integrity_or_parity_failed"));
  assert.equal(result.restrictedSourcePayloadParity.duplicateVersionRows, 1);
  assert.equal(result.restrictedSourcePayloadParity.conflictingSourceCount, 1);
  assert.equal(result.restrictedSourcePayloadParity.invalidChecksumCount, 1);
  assert.equal(result.restrictedSourcePayloadParity.missingCount, 0);
  assert.equal(result.restrictedSourcePayloadParity.unexpectedCount, 2);
  assert.equal(result.restrictedSourcePayloadParity.changedCount, 1);
  assert.equal(result.restrictedSourceBinaryParity.actualMismatchCount, 1);
  assert.equal(result.restrictedSourceBinaryParity.invalidChecksumCount, 1);
  assert.equal(result.restrictedSourceBinaryParity.actualInvalidStatusCount, 0);
});

test("restricted binary descriptor parity detects size/content/status drift even when checksum is unchanged", async () => {
  const fake = new AuditFake();
  const expected = expectedFor(fake);
  fake.sourceBinaryValues = [{ ...fake.sourceBinaryValues[0], size_bytes: 13, content_type: "application/octet-stream" }];
  const result = await runDatabaseAudit(fake, { asOfDate: "2026-08-16", expected });
  assert.equal(result.passed, false);
  assert.ok(result.blockingReasons.includes("restricted_source_binary_integrity_or_parity_failed"));
  assert.notEqual(result.restrictedSourceBinaryParity.descriptorDigestExpected, result.restrictedSourceBinaryParity.descriptorDigestActual);
  assert.equal(result.restrictedSourceBinaryParity.changedCount, 0);
});
