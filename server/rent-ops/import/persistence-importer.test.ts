import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RentManagerFinancialSemanticCrosswalk, RentManagerImportResult, RentOpsDocumentObjectBinding } from "../../../shared/rent-ops-contracts";
import { createRestrictedArchive } from "../export/archive";
import { RentManagerExportCollector } from "../export/collector";
import { createSyntheticRentManagerTransport, SYNTHETIC_HAP_ARTIFACT_SHA256, syntheticFinancialSemanticCrosswalk, syntheticHapStatusCrosswalk } from "../export/fixtures";
import { sha256 } from "../export/hash";
import { RM_EXPORT_COLLECTIONS } from "../export/registry";
import { mapRentManagerExport } from "./rm-mapper";
import { createKeyedTargetIdFactory } from "./rm-mapper";
import { runRestrictedMigrationArchiveOrchestration } from "./restricted-orchestration";
import {
  APPROVED_RM_NORMALIZER_ARTIFACT,
  APPLY_RENT_OPS_STAGING_PHRASE,
  APPLY_RENT_OPS_PRODUCTION_PHRASE,
  approvedArchiveEnvelopeSha256,
  KNOWN_LIVE_PRIMARY_FINGERPRINT,
  PersistenceImportPreconditionError,
  PersistenceImporter,
  type ApprovedPersistenceImportArtifact,
  type PersistenceImporterOptions,
} from "./persistence-importer";
import { createRestrictedImportObservationFromChunks } from "./restricted-parity";
import { RENT_OPS_REQUIRED_TABLES, RENT_OPS_SCHEMA_VERSION, rentOpsMigrationChecksumForVersion } from "../persistence";
import type { RentOpsQueryExecutor } from "../repositories/postgres";
import type { VerifiedDocumentArchiveInput } from "../services/service";

const TEST_TARGET_IDENTITY = { keyId: "importer-test-key", keyVersion: "v3-test" } as const;
const TEST_TARGET_FACTORY = createKeyedTargetIdFactory("importer-test-target-key-material", TEST_TARGET_IDENTITY).factory;
const SYNTHETIC_FINANCIAL_ARTIFACT_SHA256 = "f".repeat(64);
const SYNTHETIC_FINANCIAL_CROSSWALK: RentManagerFinancialSemanticCrosswalk = {
  artifactSha256: SYNTHETIC_FINANCIAL_ARTIFACT_SHA256,
  normalization: "trim_lower_unicode_v1",
  entries: [{
    artifactSha256: SYNTHETIC_FINANCIAL_ARTIFACT_SHA256,
    sourceCollection: "recurringSchedules",
    sourceField: "EntityType",
    semanticKind: "recurring_scope",
    normalization: "trim_lower_unicode_v1",
    normalizedValue: "tenant",
    targetValue: "tenant",
  }, {
    artifactSha256: SYNTHETIC_FINANCIAL_ARTIFACT_SHA256,
    sourceCollection: "chargeTypes",
    sourceField: "ChargeTypeID",
    semanticKind: "charge_category",
    normalization: "trim_lower_unicode_v1",
    normalizedValue: "ct-1",
    targetValue: "base_rent",
  }, {
    artifactSha256: SYNTHETIC_FINANCIAL_ARTIFACT_SHA256,
    sourceCollection: "chargeTypes",
    sourceField: "IsActive",
    semanticKind: "charge_definition_active",
    normalization: "trim_lower_unicode_v1",
    normalizedValue: "true",
    targetValue: "true",
  }],
};

export function mappedFixture(): RentManagerImportResult {
  return mapRentManagerExport({
    properties: [{ entityType: "property", sourceId: "p1", name: "Synthetic Property", slug: "synthetic-property", address: "1 Example Way", city: "Sampleton", state: "ZZ", postalCode: "00001" }],
    units: [{ entityType: "unit", sourceId: "u1", propertyId: "p1", unitNumber: "1A", bathrooms: 1.5, readiness: "ready", listing: "listed", rent: 850 }],
    tenants: [{ entityType: "tenant", sourceId: "t1", name: "Synthetic Resident", email: "resident@example.test" }],
    leases: [{ entityType: "lease", sourceId: "l1", propertyId: "p1", unitId: "u1", tenantId: "t1", status: "current", moveInDate: "2026-01-01" }],
    leaseTerms: [{ entityType: "lease_term", sourceId: "term1", leaseId: "l1", startDate: "2026-01-01", endDate: "2026-12-31", signed: true }],
    chargeTypes: [{ entityType: "charge_type", sourceId: "ct-1", name: "Synthetic Rent Type", active: true }],
    recurringSchedules: [{ entityType: "recurring_schedule", sourceId: "schedule1", scopeType: "tenant", scopeId: "t1", leaseId: "l1", ChargeTypeID: "ct-1", amount: 850, effectiveFrom: "2026-01-01", description: "Rent" }],
    charges: [{ entityType: "charge", sourceId: "c1", propertyId: "p1", unitId: "u1", leaseId: "l1", tenantId: "t1", ChargeTypeID: "ct-1", amount: 850, postedOn: "2026-08-01", dueOn: "2026-08-01", description: "Rent" }],
    payments: [{ entityType: "payment", sourceId: "pay1", propertyId: "p1", unitId: "u1", leaseId: "l1", tenantId: "t1", amount: 850, postedOn: "2026-08-02", paymentMethod: "zelle", description: "Rent payment" }],
    allocations: [{ entityType: "allocation", sourceId: "a1", paymentId: "pay1", chargeId: "c1", amount: 850, allocatedOn: "2026-08-02" }],
    deposits: [{ entityType: "deposit", sourceId: "d1", tenancyId: "l1", tenantId: "t1", unitId: "u1", amount: 850, receivedOn: "2026-08-01" }],
    subsidies: [{ entityType: "subsidy", sourceId: "hap1", tenancyId: "l1", unitId: "u1", agencyName: "Synthetic Agency", agencyObligationCents: 40000, tenantObligationCents: 45000, effectiveFrom: "2026-01-01" }],
    applications: [{ entityType: "application", sourceId: "app1", propertyId: "p1", unitId: "u1", firstName: "Synthetic", lastName: "Applicant", email: "applicant@example.test", status: "submitted", createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-02T12:00:00.000Z", submittedOn: "2026-08-01" }],
    documents: [{ entityType: "document", sourceId: "doc1", tenantId: "t1", fileName: "identity.pdf", mimeType: "application/pdf", binaryAvailable: false }],
    activities: [{ entityType: "activity", sourceId: "act1", tenantId: "t1", type: "note", summary: "Synthetic note", updatedAt: "2026-08-03T12:00:00.000Z" }],
  }, { now: new Date("2026-08-16T12:00:00.000Z"), mode: "apply", sourceManifestHash: SYNTHETIC_FINANCIAL_ARTIFACT_SHA256, fidelityVersion: 3, targetIdFactory: TEST_TARGET_FACTORY, targetIdentity: TEST_TARGET_IDENTITY, artifactSha256: SYNTHETIC_FINANCIAL_ARTIFACT_SHA256, financialSemanticCrosswalk: SYNTHETIC_FINANCIAL_CROSSWALK });
}

class MemoryExecutor implements RentOpsQueryExecutor {
  readonly queries: string[] = [];
  readonly transactions: number[] = [];
  failTable?: string;
  private readonly rows: Map<string, Map<string, Record<string, unknown>>>;
  private readonly allQueries: string[];

  constructor(rows?: Map<string, Map<string, Record<string, unknown>>>, allQueries: string[] = []) {
    this.rows = rows ?? new Map();
    this.allQueries = allQueries;
  }

  get statements(): readonly string[] {
    return this.allQueries;
  }

  private cloneRows(): Map<string, Map<string, Record<string, unknown>>> {
    const copy = new Map<string, Map<string, Record<string, unknown>>>();
    this.rows.forEach((tableRows, table) => {
      const tableCopy = new Map<string, Record<string, unknown>>();
      tableRows.forEach((row, id) => tableCopy.set(id, { ...row }));
      copy.set(table, tableCopy);
    });
    return copy;
  }

  private tableRows(table: string): Map<string, Record<string, unknown>> {
    const current = this.rows.get(table);
    if (current) return current;
    const created = new Map<string, Record<string, unknown>>();
    this.rows.set(table, created);
    return created;
  }

  async query<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    this.queries.push(text);
    this.allQueries.push(text);
    if (/information_schema\.tables/i.test(text)) return { rows: RENT_OPS_REQUIRED_TABLES.map((table_name) => ({ table_name })) as T[] };
    const restrictedTable = text.match(/FROM (rent_ops_restricted_parity_(?:observations|collection_occurrences|row_occurrences))/i)?.[1];
    if (restrictedTable) {
      const table = this.tableRows(restrictedTable);
      if (text.includes("WHERE observation_id = $1")) {
        const rows = Array.from(table.values()).filter((row) => row.observation_id === values[0]).sort((left, right) => Number(left.occurrence_ordinal) - Number(right.occurrence_ordinal));
        return { rows: rows.slice(0, Number(values[1] ?? rows.length)) as T[] };
      }
    }
    const documentBindingLookup = text.match(/FROM rent_ops_document_objects WHERE document_id = \$1/i);
    if (documentBindingLookup) {
      const row = Array.from(this.tableRows("rent_ops_document_objects").values()).find((candidate) => candidate.document_id === values[0]);
      const fields = text.match(/SELECT ([\s\S]+) FROM rent_ops_document_objects/i)?.[1]?.split(",").map((field) => field.trim()) ?? [];
      return { rows: row ? [Object.fromEntries(fields.map((field) => [field, row[field]])) as T] : [] };
    }
    if (/FROM rent_ops_source_payloads ORDER BY/i.test(text)) return { rows: Array.from(this.tableRows("rent_ops_source_payloads").values()) as T[] };
    const sourceLookup = text.match(/FROM rent_ops_source_records WHERE system = \$1 AND entity_type = \$2 AND source_id = \$3/i);
    const sourceBulkLookup = text.includes("FROM rent_ops_source_records WHERE (system, entity_type, source_id) IN (");
    if (sourceLookup || sourceBulkLookup) {
      const table = this.tableRows("rent_ops_source_records");
      const matching = sourceLookup
        ? Array.from(table.values()).filter((candidate) => candidate.system === values[0] && candidate.entity_type === values[1] && candidate.source_id === values[2])
        : Array.from({ length: Math.floor(values.length / 3) }, (_, index) => index).flatMap((index) => Array.from(table.values()).filter((candidate) => candidate.system === values[index * 3] && candidate.entity_type === values[index * 3 + 1] && candidate.source_id === values[index * 3 + 2]));
      return { rows: matching.map((row) => ({ id: row.id, system: row.system, entity_type: row.entity_type, source_id: row.source_id, target_id: row.target_id, checksum: row.checksum })) as T[] };
    }
    const sourceIds = text.match(/FROM rent_ops_source_records WHERE id = ANY\(\$1::varchar\[\]\)/i);
    if (sourceIds) {
      const table = this.tableRows("rent_ops_source_records");
      const wanted = new Set((values[0] as string[] | undefined) ?? []);
      return { rows: Array.from(table.values()).filter((row) => wanted.has(String(row.id))).map((row) => ({ id: row.id, system: row.system, entity_type: row.entity_type, source_id: row.source_id })) as T[] };
    }
    const importRunIds = text.match(/FROM rent_ops_import_runs WHERE id = ANY\(\$1::varchar\[\]\)/i);
    if (importRunIds) {
      const table = this.tableRows("rent_ops_import_runs");
      const wanted = new Set((values[0] as string[] | undefined) ?? []);
      return { rows: Array.from(table.values()).filter((row) => wanted.has(String(row.id))).map((row) => ({ id: row.id, system: row.system, source_manifest_hash: row.source_manifest_hash })) as T[] };
    }
    const selectAll = text.match(/SELECT \* FROM (rent_ops_[a-z_]+)/i);
    if (selectAll) return { rows: Array.from(this.tableRows(selectAll[1]).values()) as T[] };
    const selectById = text.match(/SELECT [\s\S]+ FROM (rent_ops_[a-z_]+) WHERE id = \$1/i);
    if (selectById) {
      const row = this.tableRows(selectById[1]).get(String(values[0]));
      return { rows: (row ? [row] : []) as T[] };
    }
    const insert = text.match(/INSERT INTO (rent_ops_[a-z_]+) \(([^)]+)\)/i);
    if (insert) {
      const tableName = insert[1];
      if (this.failTable === tableName) throw new Error("synthetic transaction failure");
      const columns = insert[2].split(",").map((column) => column.trim());
      const tupleCount = (text.match(/\([^)]+\)/g) ?? []).filter((tuple) => tuple.includes("$")).length;
      const rows = this.tableRows(tableName);
      for (let rowIndex = 0; rowIndex < Math.max(tupleCount, 1); rowIndex += 1) {
        const row: Record<string, unknown> = {};
        columns.forEach((column, columnIndex) => { row[column] = values[rowIndex * columns.length + columnIndex]; });
        rows.set(String(tableName === "rent_ops_document_objects" ? row.document_id : row.id), row);
      }
      const returning = text.match(/\bRETURNING\s+(.+)$/i);
      if (returning) {
        const fields = returning[1].split(",").map((field) => field.trim());
        const row = rows.get(String(values[0]));
        return { rows: row ? [Object.fromEntries(fields.map((field) => [field, row[field]])) as T] : [] };
      }
      return { rows: [] as T[] };
    }
    return { rows: [] as T[] };
  }

  async transaction<T>(work: (executor: RentOpsQueryExecutor) => Promise<T>): Promise<T> {
    this.transactions.push(1);
    const staged = new MemoryExecutor(this.cloneRows(), this.allQueries);
    staged.failTable = this.failTable;
    const transactionExecutor: RentOpsQueryExecutor = { query: staged.query.bind(staged) };
    const result = await work(transactionExecutor);
    this.rows.clear();
    staged.rows.forEach((tableRows, table) => this.rows.set(table, tableRows));
    return result;
  }

  businessFacts(): string {
    const serializable: Array<[string, Array<[string, Record<string, unknown>]>]> = [];
    Array.from(this.rows.keys()).sort().forEach((table) => {
      const tableRows = this.rows.get(table) as Map<string, Record<string, unknown>>;
      const rows: Array<[string, Record<string, unknown>]> = [];
      Array.from(tableRows.keys()).sort().forEach((id) => rows.push([id, tableRows.get(id) as Record<string, unknown>]));
      serializable.push([table, rows]);
    });
    return JSON.stringify(serializable);
  }
}

function applyOptions(nonce: string): PersistenceImporterOptions {
  const fingerprint = "a".repeat(16);
  const checksum = rentOpsMigrationChecksumForVersion(RENT_OPS_SCHEMA_VERSION);
  return {
    mode: "apply",
    targetClassification: "staging",
    expectedDatabaseFingerprint: fingerprint,
    forbiddenDatabaseFingerprints: [KNOWN_LIVE_PRIMARY_FINGERPRINT, "c".repeat(16)],
    actualDatabaseFingerprint: fingerprint,
    backupAttestation: { verified: true, attestationId: "synthetic-backup", targetFingerprint: fingerprint, verifiedAt: "2026-08-16T12:00:00.000Z" },
    expectedMigrationChecksum: checksum,
    renderedMigrationChecksum: checksum,
    affirmativeGate: { phrase: APPLY_RENT_OPS_STAGING_PHRASE, nonce },
    inspectDatabaseTarget: async () => ({ redactedFingerprint: fingerprint, migrationVersion: RENT_OPS_SCHEMA_VERSION, migrationChecksum: checksum, requiredTables: RENT_OPS_REQUIRED_TABLES.length, migrationChainValid: true }),
    targetIdFactory: TEST_TARGET_FACTORY,
    targetIdentity: TEST_TARGET_IDENTITY,
    testOnlyAllowUnprovenancedMappedResult: true,
  };
}

test("import dry-run is the default and performs zero executor calls", async () => {
  const executor = new MemoryExecutor();
  const result = await new PersistenceImporter().run(mappedFixture(), executor, {});
  assert.equal(result.mode, "dry_run");
  assert.equal(result.wouldWrite, false);
  assert.equal(result.committed, false);
  assert.equal(executor.queries.length, 0);
  assert.equal(executor.transactions.length, 0);
});

test("raw-input apply fails closed until an approved normalized result is supplied", async () => {
  const rawInput = {
    properties: [{ entityType: "property", sourceId: "raw-p1", name: "Raw Synthetic", address: "1 Example Way", city: "Sampleton", state: "ZZ", postalCode: "00001" }],
  };
  await assert.rejects(() => new PersistenceImporter().run(rawInput, new MemoryExecutor(), applyOptions("synthetic-raw-without-archive")), (error: unknown) => {
    assert.ok(error instanceof PersistenceImportPreconditionError);
    assert.ok(error.reasons.includes("normalization_required"));
    return true;
  });
});

test("restricted payload writer is not a substitute for normalization and never runs during dry-run", async () => {
  const rawInput = {
    properties: [{ entityType: "property", sourceId: "raw-p2", name: "Raw Synthetic", address: "2 Example Way", city: "Sampleton", state: "ZZ", postalCode: "00001" }],
  };
  const executor = new MemoryExecutor();
  let callbackCount = 0;
  let callbackInput: unknown;
  const restrictedSourcePayloadWriter = async (transactionExecutor: RentOpsQueryExecutor, context: { input: unknown }): Promise<void> => {
    callbackCount += 1;
    callbackInput = context.input;
    await transactionExecutor.query("INSERT INTO rent_ops_source_payloads (id) VALUES ($1)", ["payload:raw-p2"]);
  };
  const dryRun = await new PersistenceImporter().run(rawInput, executor, { mode: "dry_run", restrictedSourcePayloadWriter });
  assert.equal(dryRun.wouldWrite, false);
  assert.equal(callbackCount, 0);
  await assert.rejects(() => new PersistenceImporter().run(rawInput, executor, { ...applyOptions("synthetic-raw-with-archive"), restrictedSourcePayloadWriter }), (error: unknown) => {
    assert.ok(error instanceof PersistenceImportPreconditionError);
    assert.ok(error.reasons.includes("normalization_required"));
    return true;
  });
  assert.equal(callbackCount, 0);
  assert.equal(callbackInput, undefined);
  assert.equal(executor.businessFacts().includes("rent_ops_source_payloads"), false);
});

test("apply fails closed until every staging gate is explicit", async () => {
  await assert.rejects(() => new PersistenceImporter().run(mappedFixture(), undefined, { mode: "apply" }), (error: unknown) => {
    assert.ok(error instanceof PersistenceImportPreconditionError);
    assert.ok(error.reasons.includes("target_not_classified_staging"));
    assert.ok(error.reasons.includes("forbidden_database_fingerprint_policy_missing"));
    assert.ok(error.reasons.includes("verified_backup_attestation_missing"));
    assert.ok(error.reasons.includes("affirmative_apply_gate_missing"));
    return true;
  });
});

test("apply requires the rendered migration checksum in addition to the applied-schema inspection", async () => {
  const options = applyOptions("synthetic-missing-rendered-checksum");
  options.renderedMigrationChecksum = undefined;
  await assert.rejects(() => new PersistenceImporter().run(mappedFixture(), new MemoryExecutor(), options), (error: unknown) => {
    assert.ok(error instanceof PersistenceImportPreconditionError);
    assert.ok(error.reasons.includes("rendered_migration_checksum_missing_or_invalid"));
    return true;
  });
});

test("apply rejects an inspector-derived forbidden production fingerprint even when relabeled staging", async () => {
  const options = applyOptions("synthetic-production-rejection");
  const productionFingerprint = "d".repeat(16);
  options.forbiddenDatabaseFingerprints = [productionFingerprint, KNOWN_LIVE_PRIMARY_FINGERPRINT];
  options.expectedDatabaseFingerprint = productionFingerprint;
  options.actualDatabaseFingerprint = productionFingerprint;
  options.backupAttestation = { ...options.backupAttestation!, targetFingerprint: productionFingerprint };
  options.inspectDatabaseTarget = async () => ({
    redactedFingerprint: productionFingerprint,
    migrationVersion: 2,
    migrationChecksum: options.expectedMigrationChecksum!,
    requiredTables: RENT_OPS_REQUIRED_TABLES.length,
    migrationChainValid: true,
  });
  await assert.rejects(() => new PersistenceImporter().run(mappedFixture(), new MemoryExecutor(), options), (error: unknown) => {
    assert.ok(error instanceof PersistenceImportPreconditionError);
    assert.ok(error.reasons.includes("forbidden_database_fingerprint_rejected"));
    return true;
  });
});

test("synthetic mapped snapshot persists atomically and an identical gated run is idempotent", async () => {
  const executor = new MemoryExecutor();
  const importer = new PersistenceImporter();
  const fixture = mappedFixture();
  const drySummary = await importer.run(fixture, undefined, { testOnlyAllowUnprovenancedMappedResult: true });
  assert.deepEqual(drySummary.blockedReasons, []);
  const first = await importer.run(fixture, executor, applyOptions("synthetic-first"));
  assert.equal(first.committed, true);
  assert.equal(first.counts.properties, 1);
  assert.ok(first.counts.sourceRecords > first.counts.properties);
  const afterFirst = executor.businessFacts();
  const sourceRows = await executor.query<Record<string, unknown>>("SELECT * FROM rent_ops_source_records");
  assert.equal(sourceRows.rows.some((row) => String(row.raw_metadata ?? "").includes("resident@example.test")), false);
  assert.equal(sourceRows.rows.some((row) => String(row.raw_metadata ?? "").includes("Synthetic Resident")), false);
  const second = await importer.run(fixture, executor, applyOptions("synthetic-second"));
  assert.equal(second.committed, true);
  assert.equal(executor.businessFacts(), afterFirst);
  assert.equal(executor.transactions.length, 2);
});

test("a failed write rolls back the staged transaction and burns the one-time gate", async () => {
  const executor = new MemoryExecutor();
  executor.failTable = "rent_ops_security_deposits";
  const before = executor.businessFacts();
  await assert.rejects(() => new PersistenceImporter().run(mappedFixture(), executor, applyOptions("synthetic-rollback")), /transaction failed and was rolled back/);
  assert.equal(executor.businessFacts(), before);
  executor.failTable = undefined;
  await assert.rejects(() => new PersistenceImporter().run(mappedFixture(), executor, applyOptions("synthetic-rollback")), (error: unknown) => {
    assert.ok(error instanceof PersistenceImportPreconditionError);
    assert.ok(error.reasons.includes("affirmative_apply_gate_already_used"));
    return true;
  });
});

test("mutable source checksum changes update the target while append-only fact changes are blocked", async () => {
  const mutableExecutor = new MemoryExecutor();
  const importer = new PersistenceImporter();
  const initial = mappedFixture();
  await importer.run(initial, mutableExecutor, applyOptions("synthetic-mutable-initial"));
  const mutable = mappedFixture();
  const propertySource = mutable.sourceRecords.find((record) => record.entityType === "property");
  assert.ok(propertySource);
  propertySource.checksum = "e".repeat(64);
  mutable.snapshot.properties[0].name = "Synthetic Property Updated";
  const beforeMutable = mutableExecutor.businessFacts();
  const mutableResult = await importer.run(mutable, mutableExecutor, applyOptions("synthetic-mutable-update"));
  assert.equal(mutableResult.committed, true);
  assert.notEqual(mutableExecutor.businessFacts(), beforeMutable);

  const appendOnlyExecutor = new MemoryExecutor();
  await importer.run(initial, appendOnlyExecutor, applyOptions("synthetic-append-initial"));
  const appendOnly = mappedFixture();
  const ledgerSource = appendOnly.sourceRecords.find((record) => record.entityType === "ledger_transaction");
  assert.ok(ledgerSource);
  ledgerSource.checksum = "f".repeat(64);
  await assert.rejects(() => importer.run(appendOnly, appendOnlyExecutor, applyOptions("synthetic-append-change")), (error: unknown) => {
    assert.ok(error instanceof PersistenceImportPreconditionError);
    assert.ok(error.reasons.includes("append_only_source_record_conflict"));
    return true;
  });

  const runConflict = mappedFixture();
  await importer.run(runConflict, appendOnlyExecutor, applyOptions("synthetic-run-conflict-initial"));
  const changedRun = mappedFixture();
  changedRun.importRun.sourceManifestHash = "c".repeat(64);
  await assert.rejects(() => importer.run(changedRun, appendOnlyExecutor, applyOptions("synthetic-run-conflict-change")), (error: unknown) => {
    assert.ok(error instanceof PersistenceImportPreconditionError);
    assert.ok(error.reasons.includes("import_run_conflict"));
    return true;
  });
});

test("raw exporter envelopes remain dry-run-only until an approved normalizer is added", async () => {
  const importer = new PersistenceImporter();
  const envelope = { payload: { properties: [] }, sourceManifestHash: "a".repeat(64) };
  const executor = new MemoryExecutor();
  await assert.rejects(() => importer.run(envelope, executor, applyOptions("synthetic-envelope-block")), (error: unknown) => {
    assert.ok(error instanceof PersistenceImportPreconditionError);
    assert.ok(error.reasons.includes("normalization_required"));
    return true;
  });
  const dryRun = await importer.run(envelope, executor, {});
  assert.equal(dryRun.wouldWrite, false);
  assert.ok(dryRun.blockedReasons.includes("normalization_required"));
  const sourceRows = await executor.query<Record<string, unknown>>("SELECT * FROM rent_ops_source_records");
  assert.equal(sourceRows.rows.length, 0);
});

test("approved normalizer artifact keeps raw archive input on the restricted writer seam", async () => {
  const importer = new PersistenceImporter();
  const normalizedResult = mappedFixture();
  const sourceHash = normalizedResult.importRun.sourceManifestHash as string;
  const envelope = { version: "rm-export/v2", runId: "synthetic-run", source: { system: "rent_manager", transport: "injected", readOnly: true }, createdAt: "2026-08-16T12:00:00.000Z", payload: { properties: [] }, sourceManifestHash: sourceHash, archiveEnvelopeSha256: sourceHash, manifest: { archiveEnvelopeSha256: sourceHash, manifestSha256: "a".repeat(64) } };
  const artifact: ApprovedPersistenceImportArtifact = {
    artifactType: APPROVED_RM_NORMALIZER_ARTIFACT,
    normalizedResult,
    restrictedSourceInput: envelope,
    controls: {},
    provenance: {
      archiveEnvelopeSha256: sourceHash,
      manifestSha256: "a".repeat(64),
      normalizerVersion: "synthetic-normalizer/v1",
      normalizationReportSha256: "b".repeat(64),
      sourceRunId: "synthetic-run",
      registryHash: "c".repeat(64),
    },
  };
  const executor = new MemoryExecutor();
  await assert.rejects(() => importer.run(artifact, executor, applyOptions("synthetic-approved-normalizer-missing-writer")), (error: unknown) => {
    assert.ok(error instanceof PersistenceImportPreconditionError);
    assert.ok(error.reasons.includes("restricted_source_payload_persistence_missing"));
    return true;
  });
  let writerInput: unknown;
  const options = applyOptions("synthetic-approved-normalizer");
  options.restrictedSourcePayloadWriter = async (_transactionExecutor, context) => { writerInput = context.input; };
  const envelopeHash = approvedArchiveEnvelopeSha256(envelope);
  options.restrictedArchiveAuditReceipt = {
    version: "rm-restricted-archive-receipt/v1",
    sourceRunId: envelope.runId,
    envelopeSha256: envelopeHash,
    manifestSha256: "a".repeat(64),
    canonicalEnvelopeSha256: envelopeHash,
    canonicalManifestSha256: "a".repeat(64),
    checkpointSha256: "b".repeat(64),
    coverageSha256: "c".repeat(64),
    pageFileSetSha256: "d".repeat(64),
    pageFileCount: 0,
    binaryDescriptorDigestSha256: "e".repeat(64),
    fileSetSha256: "f".repeat(64),
  };
  options.restrictedParityPersistenceInput = {
    observation: createRestrictedImportObservationFromChunks({
      sourceEnvelopeSha256: envelopeHash,
      sourceRunId: envelope.runId,
      importRunId: normalizedResult.importRun.id,
      observedAt: normalizedResult.importRun.startedAt,
      sourceManifestSha256: "a".repeat(64),
      sourceChunks: [],
    }),
    sourceManifestSha256: "a".repeat(64),
    sourceChunks: [],
  };
  options.restrictedParityPersistenceWriter = async () => undefined;
  const committed = await importer.run(artifact, executor, options);
  assert.equal(committed.committed, true);
  assert.deepEqual(writerInput, envelope);
});

test("default archive orchestration performs two gated idempotent applies with independent audits", async () => {
  const parent = await mkdtemp(join(tmpdir(), "rent-ops-orchestration-"));
  await chmod(parent, 0o700);
  const archiveRoot = join(parent, "archive");
  const archive = await createRestrictedArchive(archiveRoot);
  // This fixture exercises generic two-run persistence orchestration, not the
  // independently approved v9 application supplement. Keep application case
  // collections out rather than weakening their required receipt/crosswalk
  // gate or fabricating an approval inside an unrelated test.
  const excludedCollections = new Set([
    "documentPackets",
    "signableDocumentPackets",
    "signableDocuments",
    "recurringSchedules",
    "recurringChargeSchedules",
    "prospects",
    "prospectApplications",
    "prospectApplicationTemplates",
    "prospectApplicationTemplateFields",
    "prospectApplicationTemplateMajorSections",
    "prospectApplicationTemplateMinorSections",
    "applicationTemplates",
    "interestedRentals",
    "applicationSettings",
    "prospectSubApplicantDetails",
    "applicationSummaries",
  ]);
  const registry = RM_EXPORT_COLLECTIONS.filter((definition) => !excludedCollections.has(definition.name));
  try {
    const exported = await new RentManagerExportCollector({
      transport: createSyntheticRentManagerTransport(),
      archive,
      registry,
      sleep: async () => undefined,
      runId: "orchestration-test",
    }).collect();
    // This synthetic archive carries a crosswalk explicitly bound to its
    // external artifact identity; no HAP status inference is permitted.
    exported.envelope.payload.artifactSha256 = SYNTHETIC_HAP_ARTIFACT_SHA256;
    exported.envelope.payload.hapStatusCrosswalk = syntheticHapStatusCrosswalk();
    exported.envelope.payload.financialSemanticCrosswalk = syntheticFinancialSemanticCrosswalk();
    exported.envelope.artifactObservationOn = "2026-08-17";
    exported.manifest.artifactObservationOn = "2026-08-17";
    exported.manifest.counts.hapStatusCrosswalk = 3;
    const envelopeHash = await archive.writeEnvelope(exported.envelope);
    exported.manifest.archiveEnvelopeSha256 = envelopeHash;
    await archive.writeManifest(exported.manifest);
    const executor = new MemoryExecutor();
    const firstGate = { phrase: APPLY_RENT_OPS_STAGING_PHRASE, nonce: "orchestration-first-nonce" };
    const secondGate = { phrase: APPLY_RENT_OPS_STAGING_PHRASE, nonce: "orchestration-second-nonce" };
    const audited: string[] = [];
    const result = await runRestrictedMigrationArchiveOrchestration({
      archiveRoot,
      executor,
      importerOptions: applyOptions(firstGate.nonce),
      firstApplyGate: firstGate,
      secondApplyGate: secondGate,
      now: new Date("2026-08-17T00:00:00.000Z"),
      audit: async ({ stage, result: runResult }) => {
        audited.push(stage);
        assert.equal(runResult.summary?.committed, true);
        return { passed: true };
      },
      digest: (runResult) => JSON.stringify({ report: runResult.report, summary: runResult.summary }),
    });
    assert.equal(result.identicalSecondRun, true);
    assert.deepEqual(audited, ["first_apply", "second_apply"]);
    // The wrapper captures the redacted target state before/after each apply
    // in read-only transactions, in addition to the two write transactions.
    assert.equal(executor.transactions.length, 6);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("large imports use deterministic bounded bulk statements while preserving all rows", async () => {
  const propertyCount = 250;
  const fixture = mapRentManagerExport({
    properties: Array.from({ length: propertyCount }, (_, index) => ({
      entityType: "property",
      sourceId: `property-${index + 1}`,
      name: `Synthetic Property ${index + 1}`,
      slug: `synthetic-property-${index + 1}`,
      address: `${index + 1} Example Way`,
      city: "Sampleton",
      state: "ZZ",
      postalCode: String(index + 1).padStart(5, "0"),
    })),
  }, { now: new Date("2026-08-16T12:00:00.000Z"), mode: "apply", sourceManifestHash: "1".repeat(64), fidelityVersion: 3, targetIdFactory: TEST_TARGET_FACTORY, targetIdentity: TEST_TARGET_IDENTITY, artifactSha256: SYNTHETIC_FINANCIAL_ARTIFACT_SHA256, financialSemanticCrosswalk: SYNTHETIC_FINANCIAL_CROSSWALK });
  const executor = new MemoryExecutor();
  const result = await new PersistenceImporter().run(fixture, executor, applyOptions("synthetic-bulk-import"));
  assert.equal(result.committed, true);
  assert.equal(result.counts.properties, propertyCount);
  const inserts = executor.statements.filter((statement) => /^INSERT INTO/i.test(statement));
  const sourcePreflight = executor.statements.filter((statement) => /FROM rent_ops_source_records WHERE/i.test(statement));
  assert.equal(inserts.length, 8);
  assert.equal(sourcePreflight.length, 6);
  assert.ok(executor.statements.length < 25);
  const persistedProperties = await executor.query<Record<string, unknown>>("SELECT * FROM rent_ops_properties");
  assert.equal(persistedProperties.rows.length, propertyCount);
});

test("append-only conflict preflight blocks before any bulk write", async () => {
  const executor = new MemoryExecutor();
  const importer = new PersistenceImporter();
  await importer.run(mappedFixture(), executor, applyOptions("synthetic-bulk-conflict-initial"));
  const insertsBefore = executor.statements.filter((statement) => /^INSERT INTO/i.test(statement)).length;
  const changed = mappedFixture();
  const ledgerSource = changed.sourceRecords.find((record) => record.entityType === "ledger_transaction");
  assert.ok(ledgerSource);
  ledgerSource.checksum = "9".repeat(64);
  await assert.rejects(() => importer.run(changed, executor, applyOptions("synthetic-bulk-conflict-change")), (error: unknown) => {
    assert.ok(error instanceof PersistenceImportPreconditionError);
    assert.ok(error.reasons.includes("append_only_source_record_conflict"));
    return true;
  });
  assert.equal(executor.statements.filter((statement) => /^INSERT INTO/i.test(statement)).length, insertsBefore);
});

function verifiedArchiveInput(fixture: RentManagerImportResult): { input: VerifiedDocumentArchiveInput; document: RentManagerImportResult["snapshot"]["documents"][number]; binding: RentOpsDocumentObjectBinding } {
  const document = fixture.snapshot.documents[0]!;
  const bytes = new TextEncoder().encode("restricted-import-binary");
  const checksumSha256 = sha256(bytes);
  const sourceBinaryId = "rm-binary:restricted-document-1";
  const verifiedAt = "2026-08-17T00:00:00.000Z";
  const input: VerifiedDocumentArchiveInput = {
    documentId: document.id,
    type: document.type,
    fileName: document.fileName,
    mimeType: document.mimeType,
    bytes,
    sizeBytes: bytes.byteLength,
    checksumSha256,
    ...(document.propertyId ? { propertyId: document.propertyId } : {}),
    ...(document.unitId ? { unitId: document.unitId } : {}),
    ...(document.personId ? { personId: document.personId } : {}),
    ...(document.tenancyId ? { tenancyId: document.tenancyId } : {}),
    ...(document.applicationId ? { applicationId: document.applicationId } : {}),
    sourceBinaryBinding: {
      bindingId: sourceBinaryId,
      sourceSystem: "rent_manager",
      sourceCollection: "documents",
      sourceIdHash: sha256("restricted-document-1"),
      importRunId: fixture.importRun.id,
    },
  };
  const transferredDocument = {
    ...document,
    state: "verified" as const,
    stateKnowledge: "source" as const,
    availability: "verified" as const,
    storageKeyKnowledge: "source" as const,
    sizeBytes: bytes.byteLength,
    checksumSha256,
    storageKey: `documents/${checksumSha256}`,
    uploadedAt: verifiedAt,
    verifiedAt,
  };
  const binding: RentOpsDocumentObjectBinding = {
    documentId: document.id,
    bindingKind: "import",
    sourceBinaryId,
    importRunId: fixture.importRun.id,
    sourceSystem: "rent_manager",
    sourceCollection: "documents",
    backend: "private-versioned-object-store",
    logicalKey: `sha256:${checksumSha256}`,
    checksumSha256,
    sizeBytes: bytes.byteLength,
    immutableVersion: "version-1",
    verifiedAt,
  };
  return { input, document: transferredDocument, binding };
}

test("restricted RM binary transfer binds the verified object and exact source binary in one importer transaction", async () => {
  const fixture = mappedFixture();
  const executor = new MemoryExecutor();
  const transfer = verifiedArchiveInput(fixture);
  let callbackExecutor: RentOpsQueryExecutor | undefined;
  const result = await new PersistenceImporter().run(fixture, executor, {
    ...applyOptions("restricted-transfer-transaction"),
    restrictedVerifiedDocumentInputs: [transfer.input],
    restrictedVerifiedDocumentTransfer: {
      transferVerifiedDocument: async (_input, transactionExecutor) => {
        callbackExecutor = transactionExecutor;
        return { document: transfer.document, binding: transfer.binding };
      },
    },
  });
  assert.equal(result.committed, true);
  assert.ok(callbackExecutor);
  const facts = executor.businessFacts();
  assert.match(facts, /rent_ops_document_objects/);
  assert.match(facts, /rm-binary:restricted-document-1/);
  assert.doesNotMatch(facts, /restricted-import-binary/);
  assert.equal(executor.transactions.length, 1);
});

test("restricted RM binary transfer failure rolls back DB rows and emits only redacted orphan evidence", async () => {
  const fixture = mappedFixture();
  const executor = new MemoryExecutor();
  const transfer = verifiedArchiveInput(fixture);
  let orphanEvidence: unknown;
  await assert.rejects(
    () => new PersistenceImporter().run(fixture, executor, {
      ...applyOptions("restricted-transfer-failure"),
      restrictedVerifiedDocumentInputs: [transfer.input],
      restrictedVerifiedDocumentTransfer: {
        transferVerifiedDocument: async () => { throw new Error("storage provider detail must not escape"); },
      },
      restrictedDocumentOrphanSink: (evidence) => { orphanEvidence = evidence; },
    }),
    (error: unknown) => error instanceof PersistenceImportPreconditionError && error.reasons.length === 1 && error.reasons[0] === "restricted_document_transfer_failed",
  );
  assert.equal(executor.transactions.length, 1);
  assert.equal(executor.businessFacts(), "[]");
  assert.ok(orphanEvidence);
  const redacted = JSON.stringify(orphanEvidence);
  assert.doesNotMatch(redacted, /rm-binary:restricted-document-1/);
  assert.doesNotMatch(redacted, /restricted-import-binary/);
  assert.match(redacted, /database_binding_failed/);
});

test("unknown money controls are scoped to their own ledger kind", async () => {
  const fixture = mappedFixture();
  const charge = fixture.snapshot.ledgerTransactions.find((row) => row.kind === "charge")!;
  charge.amountCents = null; charge.amountKnowledge = "unknown";
  fixture.exceptions.push({ code: "ledger_amount_unknown", severity: "warning", sourceId: charge.source!.sourceId, entityType: "ledger_transaction", message: "Synthetic source-absent charge amount" });
  const result = await new PersistenceImporter().run(fixture, undefined, { mode: "dry_run", controls: { unknownCounts: { charges: 1, payments: 0, credits: 0 } } });
  assert.equal(result.blockedReasons.some((reason) => reason.startsWith("control_unknown_money_mismatch")), false);
});

test("persistence validates present tenancy references alongside a source-absent unknown unit", async () => {
  const fixture = mappedFixture();
  const tenancy = fixture.snapshot.tenancies[0]; tenancy.unitId = ""; tenancy.unitLinkKnowledge = "unknown";
  const absent = await new PersistenceImporter().run(fixture, undefined, { mode: "dry_run", controls: {} });
  assert.equal(absent.blockedReasons.includes("orphan_tenancy"), false);
  tenancy.propertyId = "invalid-present-property";
  const invalid = await new PersistenceImporter().run(fixture, undefined, { mode: "dry_run", controls: {} });
  assert.equal(invalid.blockedReasons.includes("orphan_tenancy"), true);
});


test("production classification requires its exact phrase and retains fingerprint and backup gates", async () => {
 const options = {...applyOptions("synthetic-production-gate"), targetClassification: "production" as const};
 await assert.rejects(new PersistenceImporter().run(mappedFixture(),new MemoryExecutor(),options), (error: unknown)=>error instanceof PersistenceImportPreconditionError && error.reasons.includes("affirmative_apply_gate_missing"));
 options.affirmativeGate = {phrase:APPLY_RENT_OPS_PRODUCTION_PHRASE,nonce:"synthetic-production-gate-explicit"};
 const result=await new PersistenceImporter().run(mappedFixture(),new MemoryExecutor(),options);
 assert.equal(result.committed,true);
 for(const patch of [{expectedDatabaseFingerprint:"b".repeat(16)},{backupAttestation:undefined}]) {
  await assert.rejects(new PersistenceImporter().run(mappedFixture(),new MemoryExecutor(),{...options,...patch}),PersistenceImportPreconditionError);
 }
});
