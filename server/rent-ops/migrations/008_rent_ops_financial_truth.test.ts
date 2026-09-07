import assert from "node:assert/strict";
import test from "node:test";
import {
  CHARGE_CATEGORIES,
  FINANCIAL_SEMANTIC_KINDS,
  LEDGER_STATUSES,
  LEASE_TERM_STATUSES,
  PAYMENT_METHODS,
  RECURRING_SCOPE_TYPES,
  TENANCY_STATUSES,
  createFinancialSemanticCrosswalkEntry,
  type FinancialSemanticKind,
  validateFinancialSemanticCrosswalk,
} from "../../../shared/rent-ops-contracts";
import {
  RENT_OPS_SCHEMA_VERSION,
  ensureRentOpsSchema,
  rentOpsMigrationChecksumForVersion,
  renderRentOpsMigrationSqlForVersion,
  splitRentOpsSqlStatements,
} from "../persistence";

const V8_CHECKSUM = rentOpsMigrationChecksumForVersion(8);
const APPROVED_ARTIFACT_SHA256 = "a".repeat(64);
const EMPTY_REBUILD_ERROR = "rent_ops_v8_nonempty_financial_target_requires_empty_rebuild";

type FinancialRow = {
  id: string;
  category: string | null;
  categoryKnowledge?: string;
  amountCents: number | null;
  amountKnowledge?: string;
  scopeType: string | null;
  scopeId: string | null;
  lineageRootId?: string | null;
  lineageRootOrigin?: string | null;
  versionOrigin?: string | null;
  versionAction?: string | null;
  sourceArtifactSha256?: string | null;
  artifactObservationOn?: string | null;
};

type FinancialState = {
  migrationLedger: Map<number, string>;
  recurringSchedules: FinancialRow[];
  ledgerTransactions: Array<Record<string, unknown>>;
  paymentAllocations: Array<Record<string, unknown>>;
  chargeDefinitions: Array<Record<string, unknown>>;
  crosswalkEntries: Array<Record<string, unknown>>;
};

function cloneState(state: FinancialState): FinancialState {
  return {
    migrationLedger: new Map(state.migrationLedger),
    recurringSchedules: state.recurringSchedules.map((row) => ({ ...row })),
    ledgerTransactions: state.ledgerTransactions.map((row) => ({ ...row })),
    paymentAllocations: state.paymentAllocations.map((row) => ({ ...row })),
    chargeDefinitions: state.chargeDefinitions.map((row) => ({ ...row })),
    crosswalkEntries: state.crosswalkEntries.map((row) => ({ ...row })),
  };
}

function emptyState(): FinancialState {
  return {
    migrationLedger: new Map(),
    recurringSchedules: [],
    ledgerTransactions: [],
    paymentAllocations: [],
    chargeDefinitions: [],
    crosswalkEntries: [],
  };
}

/**
 * A deliberately narrow local executor. It models only the transaction,
 * migration-ledger, and v8 cutover guards needed by these acceptance tests;
 * it is an orchestration/order model rather than a PostgreSQL semantics
 * emulator, and it never opens a database connection or calls a live Rent
 * Manager system. Rendered SQL parity is tested separately below.
 */
class SyntheticMigrationExecutor {
  readonly calls: string[] = [];
  private state: FinancialState;
  private transactionSnapshot: FinancialState | undefined;

  constructor(initial: Partial<FinancialState> = {}) {
    this.state = {
      ...emptyState(),
      ...initial,
      migrationLedger: new Map(initial.migrationLedger ?? []),
      recurringSchedules: (initial.recurringSchedules ?? []).map((row) => ({ ...row })),
      ledgerTransactions: (initial.ledgerTransactions ?? []).map((row) => ({ ...row })),
      paymentAllocations: (initial.paymentAllocations ?? []).map((row) => ({ ...row })),
      chargeDefinitions: (initial.chargeDefinitions ?? []).map((row) => ({ ...row })),
      crosswalkEntries: (initial.crosswalkEntries ?? []).map((row) => ({ ...row })),
    };
  }

  get snapshot(): FinancialState {
    return cloneState(this.state);
  }

  get migrationLedger(): ReadonlyMap<number, string> {
    return this.state.migrationLedger;
  }

  seedV7RecurringRows(rows: readonly FinancialRow[]): void {
    this.state.recurringSchedules = rows.map((row) => ({ ...row }));
  }

  seedPostV8FinancialFacts(): void {
    this.state.chargeDefinitions = [{ id: "synthetic-definition", category: null, categoryKnowledge: "unknown" }];
    this.state.crosswalkEntries = [{ id: "synthetic-crosswalk", semanticKind: "recurring_scope", targetValue: "unit" }];
    this.state.recurringSchedules = [{
      id: "synthetic-v8-source",
      category: "base_rent",
      categoryKnowledge: "source",
      amountCents: 125000,
      amountKnowledge: "known",
      scopeType: "unit",
      scopeId: "synthetic-unit",
      lineageRootId: "synthetic-v8-source",
      lineageRootOrigin: "artifact",
      versionOrigin: "artifact",
      versionAction: "root",
      sourceArtifactSha256: APPROVED_ARTIFACT_SHA256,
      artifactObservationOn: "2026-08-16",
    }];
  }

  async execute(statement: string): Promise<void> {
    this.calls.push(statement);
    if (statement === "BEGIN") {
      if (this.transactionSnapshot) throw new Error("synthetic_nested_transaction");
      this.transactionSnapshot = cloneState(this.state);
      return;
    }
    if (statement === "ROLLBACK") {
      if (!this.transactionSnapshot) throw new Error("synthetic_rollback_without_transaction");
      this.state = cloneState(this.transactionSnapshot);
      this.transactionSnapshot = undefined;
      return;
    }
    if (statement === "COMMIT") {
      if (!this.transactionSnapshot) throw new Error("synthetic_commit_without_transaction");
      this.transactionSnapshot = undefined;
      return;
    }
    if (!this.transactionSnapshot) throw new Error("synthetic_statement_outside_transaction");

    if (statement.includes("rent_ops_v8_nonempty_financial_target_requires_empty_rebuild")) {
      const appliedV8Checksum = this.state.migrationLedger.get(8);
      if (appliedV8Checksum !== V8_CHECKSUM && this.hasFinancialRows()) throw new Error(EMPTY_REBUILD_ERROR);
      return;
    }

    const migrationInsert = statement.match(
      /INSERT\s+INTO\s+rent_ops_schema_migrations\s*\(version,\s*checksum_sha256\)\s*VALUES\s*\(\s*(\d+)\s*,\s*'([a-f0-9]{64})'\s*\)/i,
    );
    if (migrationInsert) {
      const version = Number(migrationInsert[1]);
      const checksum = migrationInsert[2];
      const prior = this.state.migrationLedger.get(version);
      // Mirrors the migration's conflict predicate: an identical checksum is
      // a no-op, while a changed checksum is never silently overwritten.
      if (prior === undefined) this.state.migrationLedger.set(version, checksum);
      return;
    }

    if (statement.includes("rent_ops_v8_post_insert_checksum_guard")) {
      const required = [...statement.matchAll(/version\s*=\s*(\d+)\s+AND\s+checksum_sha256\s*=\s*'([a-f0-9]{64})'/gi)];
      if (required.some(([, version, checksum]) => this.state.migrationLedger.get(Number(version)) !== checksum)) {
        throw new Error("rent_ops_migration_checksum_guard");
      }
    }
  }

  private hasFinancialRows(): boolean {
    return this.state.recurringSchedules.length > 0
      || this.state.ledgerTransactions.length > 0
      || this.state.paymentAllocations.length > 0
      || this.state.chargeDefinitions.length > 0
      || this.state.crosswalkEntries.length > 0;
  }
}

async function applySynthetic(executor: SyntheticMigrationExecutor) {
  return ensureRentOpsSchema({ apply: true, executor: executor.execute.bind(executor) });
}

test("pre-v8 financial rows fail with the stable empty-rebuild error and roll back without a v8 ledger", async () => {
  const seededRow: FinancialRow = {
    id: "synthetic-v7-recurring",
    category: "base_rent",
    amountCents: 100000,
    scopeType: "tenant",
    scopeId: "synthetic-tenant",
  };
  const executor = new SyntheticMigrationExecutor({ recurringSchedules: [seededRow] });
  const before = executor.snapshot;

  await assert.rejects(() => applySynthetic(executor), (error: unknown) => {
    assert.equal(error instanceof Error ? error.message : String(error), EMPTY_REBUILD_ERROR);
    return true;
  });

  assert.deepEqual(executor.snapshot, before);
  assert.equal(executor.migrationLedger.has(8), false);
  assert.equal(executor.calls[0], "BEGIN");
  assert.equal(executor.calls.at(-1), "ROLLBACK");
  assert.equal(executor.calls.includes("COMMIT"), false);
});

test("empty target accepts the first v8 apply and records the exact rendered checksum once", async () => {
  const executor = new SyntheticMigrationExecutor();
  const result = await applySynthetic(executor);

  assert.equal(result.mode, "applied");
  assert.equal(executor.migrationLedger.get(8), V8_CHECKSUM);
  assert.equal(executor.migrationLedger.size, RENT_OPS_SCHEMA_VERSION);
  assert.equal(executor.calls[0], "BEGIN");
  assert.equal(executor.calls.at(-1), "COMMIT");
  assert.equal(executor.calls.includes("ROLLBACK"), false);
});

test("an exact-checksum rerun on populated post-v8 facts is a no-op and passes", async () => {
  const executor = new SyntheticMigrationExecutor();
  await applySynthetic(executor);
  executor.seedPostV8FinancialFacts();
  const before = executor.snapshot;
  const callsBeforeRerun = executor.calls.length;

  const result = await applySynthetic(executor);

  assert.equal(result.mode, "applied");
  assert.equal(executor.migrationLedger.get(8), V8_CHECKSUM);
  assert.deepEqual(executor.snapshot, before);
  assert.equal(executor.calls.slice(callsBeforeRerun)[0], "BEGIN");
  assert.equal(executor.calls.at(-1), "COMMIT");
  assert.equal(executor.calls.slice(callsBeforeRerun).includes("ROLLBACK"), false);
});

type SourcePair = readonly [collection: string, field: string];
type SemanticMatrixRow = { sources: readonly SourcePair[]; targets: readonly string[] };

const APPROVED_SEMANTIC_MATRIX: Record<FinancialSemanticKind, SemanticMatrixRow> = {
  tenancy_status: {
    sources: [["tenants.current", "$partition"], ["tenants.future", "$partition"], ["tenants.former", "$partition"]],
    targets: TENANCY_STATUSES,
  },
  lease_status: {
    sources: [],
    targets: LEASE_TERM_STATUSES,
  },
  ledger_status: {
    sources: [],
    targets: LEDGER_STATUSES,
  },
  charge_category: {
    sources: [["chargeTypes", "ChargeTypeID"]],
    targets: CHARGE_CATEGORIES,
  },
  charge_definition_active: {
    sources: [["chargeTypes", "IsActive"]],
    targets: ["true", "false"],
  },
  recurring_active: {
    sources: [],
    targets: ["true", "false"],
  },
  recurring_scope: {
    sources: [["recurringSchedules", "EntityType"]],
    targets: RECURRING_SCOPE_TYPES,
  },
  payment_method: {
    sources: [],
    targets: PAYMENT_METHODS,
  },
  payer: {
    sources: [],
    targets: ["tenant", "agency", "owner", "unknown"],
  },
};

function sqlConstraintBody(rendered: string, constraintName: string, nextConstraintName?: string): string {
  const startMarker = `CONSTRAINT ${constraintName} CHECK (`;
  const start = rendered.indexOf(startMarker);
  assert.notEqual(start, -1, `${constraintName} is missing from rendered v8 SQL`);
  const end = nextConstraintName
    ? rendered.indexOf(`CONSTRAINT ${nextConstraintName} CHECK (`, start + startMarker.length)
    : rendered.indexOf("\n);", start + startMarker.length);
  assert.notEqual(end, -1, `${constraintName} has no bounded rendered body`);
  return rendered.slice(start + startMarker.length, end);
}

function renderedSourcePairs(body: string): Set<string> {
  const pairs = new Set<string>();
  const sqlList = (values: string): string[] => values.split(",").map((value) => value.trim().replace(/^'|'$/g, ""));
  for (const [, collection, field] of body.matchAll(/source_collection\s*=\s*'([^']+)'\s+AND\s+source_field\s*=\s*'([^']+)'/g)) {
    pairs.add(`${collection}\u0000${field}`);
  }
  for (const [, collections, field] of body.matchAll(/source_collection\s+IN\s*\(([^)]+)\)\s+AND\s+source_field\s*=\s*'([^']+)'/g)) {
    for (const collection of sqlList(collections)) {
      pairs.add(`${collection}\u0000${field}`);
    }
  }
  for (const [, collection, fields] of body.matchAll(/source_collection\s*=\s*'([^']+)'\s+AND\s+source_field\s+IN\s*\(([^)]+)\)/g)) {
    for (const field of sqlList(fields)) pairs.add(`${collection}\u0000${field}`);
  }
  for (const [, collections, fields] of body.matchAll(/source_collection\s+IN\s*\(([^)]+)\)\s+AND\s+source_field\s+IN\s*\(([^)]+)\)/g)) {
    for (const collection of sqlList(collections)) {
      for (const field of sqlList(fields)) pairs.add(`${collection}\u0000${field}`);
    }
  }
  return pairs;
}

function renderedTargetDomains(body: string): Map<FinancialSemanticKind, Set<string>> {
  const domains = new Map<FinancialSemanticKind, Set<string>>();
  for (const [, kind, values] of body.matchAll(/semantic_kind\s*=\s*'([^']+)'\s+AND\s+target_value\s+IN\s*\(([^)]+)\)/g)) {
    domains.set(kind as FinancialSemanticKind, new Set(values.split(",").map((value) => value.trim().replace(/^'|'$/g, ""))));
  }
  return domains;
}

test("approved TypeScript collection/field/target matrix exactly matches rendered v8 SQL constraints", () => {
  const rendered = renderRentOpsMigrationSqlForVersion(8);
  const sourceBody = sqlConstraintBody(rendered, "rent_ops_financial_crosswalk_binding_check", "rent_ops_financial_crosswalk_target_domain_check");
  const targetBody = sqlConstraintBody(rendered, "rent_ops_financial_crosswalk_target_domain_check");
  const sqlPairs = renderedSourcePairs(sourceBody);
  const expectedPairs = new Set(FINANCIAL_SEMANTIC_KINDS.flatMap((kind) => APPROVED_SEMANTIC_MATRIX[kind].sources.map(([collection, field]) => `${collection}\u0000${field}`)));
  assert.deepEqual([...sqlPairs].sort(), [...expectedPairs].sort());

  const sqlDomains = renderedTargetDomains(targetBody);
  for (const kind of FINANCIAL_SEMANTIC_KINDS) {
    const row = APPROVED_SEMANTIC_MATRIX[kind];
    const targetValues = sqlDomains.get(kind);
    assert.ok(targetValues, `rendered SQL target domain missing for ${kind}`);
    assert.deepEqual([...targetValues].sort(), [...row.targets].sort());

    for (const [sourceCollection, sourceField] of row.sources) {
      const entry = createFinancialSemanticCrosswalkEntry({
        artifactSha256: APPROVED_ARTIFACT_SHA256,
        sourceCollection,
        sourceField,
        semanticKind: kind,
        normalization: "exact_v1",
        rawValue: "synthetic-source-value",
        targetValue: row.targets[0],
      });
      assert.ok(entry);
      const validation = validateFinancialSemanticCrosswalk({ artifactSha256: APPROVED_ARTIFACT_SHA256, normalization: "exact_v1", entries: [entry] }, APPROVED_ARTIFACT_SHA256);
      assert.equal(validation.valid, true, `${kind}/${sourceCollection}/${sourceField} must remain approved in TypeScript`);
    }
  }
});

test("crosswalk near-misses and lowercase-SHA violations fail closed in TypeScript and rendered SQL", () => {
  const rendered = renderRentOpsMigrationSqlForVersion(8);
  assert.match(rendered, /artifact_sha256 varchar\(64\) NOT NULL CHECK \(artifact_sha256 ~ '\^\[a-f0-9\]\{64\}\$'\)/);

  const nearMisses = [
    {
      sourceCollection: "chargeTypes",
      sourceField: "Description",
      semanticKind: "lease_status" as const,
      targetValue: "executed",
      issueCode: "source_field_not_approved",
    },
    {
      sourceCollection: "recurringSchedules",
      sourceField: "Description",
      semanticKind: "recurring_active" as const,
      targetValue: "true",
      issueCode: "source_field_not_approved",
    },
    {
      sourceCollection: "recurringSchedules",
      sourceField: "Active",
      semanticKind: "recurring_active" as const,
      targetValue: "TRUE",
      issueCode: "target_value_out_of_domain",
    },
  ];
  for (const nearMiss of nearMisses) {
    const entry = createFinancialSemanticCrosswalkEntry({
      artifactSha256: APPROVED_ARTIFACT_SHA256,
      sourceCollection: nearMiss.sourceCollection,
      sourceField: nearMiss.sourceField,
      semanticKind: nearMiss.semanticKind,
      normalization: "exact_v1",
      rawValue: "synthetic-source-value",
      targetValue: nearMiss.targetValue,
    });
    assert.ok(entry);
    const result = validateFinancialSemanticCrosswalk({ artifactSha256: APPROVED_ARTIFACT_SHA256, normalization: "exact_v1", entries: [entry] }, APPROVED_ARTIFACT_SHA256);
    assert.equal(result.valid, false);
    assert.ok(result.issueCodes.includes(nearMiss.issueCode));
  }

  const uppercaseDigestEntry = createFinancialSemanticCrosswalkEntry({
    artifactSha256: APPROVED_ARTIFACT_SHA256.toUpperCase(),
    sourceCollection: "recurringSchedules",
    sourceField: "Active",
    semanticKind: "recurring_active",
    normalization: "exact_v1",
    rawValue: "active",
    targetValue: "true",
  });
  assert.ok(uppercaseDigestEntry);
  const uppercaseDigest = validateFinancialSemanticCrosswalk({
    artifactSha256: APPROVED_ARTIFACT_SHA256.toUpperCase(),
    normalization: "exact_v1",
    entries: [uppercaseDigestEntry],
  }, APPROVED_ARTIFACT_SHA256);
  assert.equal(uppercaseDigest.valid, false);
  assert.ok(uppercaseDigest.issueCodes.includes("artifact_digest_invalid"));
  assert.ok(uppercaseDigest.issueCodes.includes("artifact_not_approved"));
});

test("v8 source claims require an independently bound artifact while manual roots remain separate", () => {
  const rendered = renderRentOpsMigrationSqlForVersion(8);
  assert.match(rendered, /rent_ops_schedules_lineage_origin_check/);
  assert.match(rendered, /version_action IN \('root','replace','end'\)/);
  assert.match(rendered, /rent_ops_schedules_source_binding_check/);
  assert.match(rendered, /rent_ops_charge_definitions_source_binding_check/);
  assert.match(rendered, /rent_ops_ledger_source_binding_check/);
  assert.match(rendered, /lineage_root_origin IN \('artifact','manual'\)/);
  assert.match(rendered, /ALTER TABLE rent_ops_recurring_charge_schedules ALTER COLUMN lineage_root_origin SET NOT NULL/);
  assert.match(rendered, /source_artifact_sha256 ~ '\^\[a-f0-9\]\{64\}\$'/);
  assert.match(rendered, /length\(btrim\(source_system\)\) > 0/);
  assert.match(rendered, /length\(btrim\(source_id\)\) > 0/);
  assert.match(rendered, /length\(btrim\(NEW\.source_system\)\) = 0/);
  assert.match(rendered, /length\(btrim\(NEW\.source_id\)\) = 0/);
  assert.match(rendered, /artifact_observation_on IS NOT NULL/);
  assert.match(rendered, /lineage_root_origin = 'manual'[\s\S]*source_artifact_sha256 IS NULL/);
  assert.match(rendered, /DROP CONSTRAINT IF EXISTS rent_ops_schedules_effective_from_knowledge_check/);
  const definitionBindingStart = rendered.indexOf("CONSTRAINT rent_ops_charge_definitions_source_binding_check");
  const definitionBindingEnd = rendered.indexOf("CREATE UNIQUE INDEX", definitionBindingStart);
  assert.ok(definitionBindingStart >= 0 && definitionBindingEnd > definitionBindingStart);
  assert.doesNotMatch(rendered.slice(definitionBindingStart, definitionBindingEnd), /version_action|version_origin|lineage_root_origin/);
  const scheduleBindingStart = rendered.indexOf("ADD CONSTRAINT rent_ops_schedules_source_binding_check");
  const scheduleBindingEnd = rendered.indexOf("ALTER TABLE rent_ops_recurring_charge_schedules\n  DROP CONSTRAINT IF EXISTS rent_ops_schedules_self_predecessor_check", scheduleBindingStart);
  assert.ok(scheduleBindingStart >= 0 && scheduleBindingEnd > scheduleBindingStart);
  assert.match(rendered.slice(scheduleBindingStart, scheduleBindingEnd), /version_action IN \('replace','end'\)[\s\S]*version_origin = 'manual'[\s\S]*lineage_root_origin = 'artifact'/);
});

test("representative v7 recurring rows are not promoted from heuristic values", async () => {
  const executor = new SyntheticMigrationExecutor();
  const v7Rows: FinancialRow[] = [
    {
      id: "synthetic-v7-description-heuristic",
      category: "base_rent",
      amountCents: 110000,
      scopeType: "tenant",
      scopeId: "synthetic-tenant",
      lineageRootId: null,
      versionAction: null,
    },
    {
      id: "synthetic-v7-unknown-scope",
      category: null,
      amountCents: null,
      scopeType: null,
      scopeId: null,
      lineageRootId: null,
      versionAction: null,
    },
  ];
  executor.seedV7RecurringRows(v7Rows);
  const before = executor.snapshot;

  await assert.rejects(() => applySynthetic(executor), new RegExp(EMPTY_REBUILD_ERROR));

  assert.deepEqual(executor.snapshot.recurringSchedules, before.recurringSchedules);
  assert.equal(executor.snapshot.migrationLedger.has(8), false);
  assert.equal(executor.snapshot.chargeDefinitions.length, 0);
  assert.equal(executor.snapshot.crosswalkEntries.length, 0);
});

type SyntheticNullableValue = string | number | boolean | null | undefined;
type SyntheticV8Row = Record<string, SyntheticNullableValue>;

const FACT_KNOWN = new Set(["source", "manual"]);
const FACT_KNOWN_WITH_INFERRED = new Set(["source", "manual", "inferred"]);
const FACT_UNKNOWN = new Set(["unknown", "ambiguous"]);
const LINK_KNOWN = new Set(["exact", "manual"]);
const LINK_UNKNOWN = new Set(["unknown", "ambiguous"]);

function present(value: SyntheticNullableValue): boolean {
  return value !== null && value !== undefined;
}

function strictFactPair(value: SyntheticNullableValue, knowledge: SyntheticNullableValue, allowInferred = false): boolean {
  if (!present(knowledge)) return false;
  return present(value)
    ? (allowInferred ? FACT_KNOWN_WITH_INFERRED : FACT_KNOWN).has(String(knowledge))
    : FACT_UNKNOWN.has(String(knowledge));
}

function strictAmountPair(value: SyntheticNullableValue, knowledge: SyntheticNullableValue, positive: boolean): boolean {
  if (!present(knowledge)) return false;
  if (!present(value)) return knowledge === "unknown";
  return knowledge === "known" && typeof value === "number" && Number.isInteger(value) && (positive ? value > 0 : value >= 0);
}

function strictLinkPair(value: SyntheticNullableValue, knowledge: SyntheticNullableValue): boolean {
  if (!present(knowledge)) return false;
  return present(value) ? LINK_KNOWN.has(String(knowledge)) : LINK_UNKNOWN.has(String(knowledge));
}

function validArtifactBinding(row: SyntheticV8Row, sourceClaims: readonly string[]): boolean {
  const hasSourcePair = present(row.sourceSystem) || present(row.sourceId);
  if (hasSourcePair && (!present(row.sourceSystem) || !present(row.sourceId))) return false;
  const hasArtifact = present(row.sourceArtifactSha256) || present(row.artifactObservationOn);
  if (hasArtifact && (!present(row.sourceArtifactSha256) || !present(row.artifactObservationOn))) return false;
  if (hasSourcePair) {
    return hasArtifact
      && typeof row.sourceArtifactSha256 === "string"
      && /^[a-f0-9]{64}$/.test(row.sourceArtifactSha256);
  }
  return !hasArtifact && sourceClaims.every((knowledge) => knowledge !== "source" && knowledge !== "exact");
}

function validScheduleContract(row: SyntheticV8Row): boolean {
  const scopeValid = present(row.scopeType) || present(row.scopeId)
    ? present(row.scopeType) && ["tenant", "unit", "property"].includes(String(row.scopeType))
      && present(row.scopeId)
      && strictFactPair(row.scopeType, row.scopeTypeKnowledge)
      && LINK_KNOWN.has(String(row.scopeLinkKnowledge))
    : LINK_UNKNOWN.has(String(row.scopeLinkKnowledge)) && FACT_UNKNOWN.has(String(row.scopeTypeKnowledge));
  const dateValid = row.effectiveFromKnowledge === "unknown_open_start"
    ? !present(row.effectiveFrom)
    : present(row.effectiveFrom) && ["source", "manual"].includes(String(row.effectiveFromKnowledge));
  const rootActionValid = row.versionAction === "root"
    ? row.supersedesId == null && row.lineageRootId === row.id
    : ["replace", "end"].includes(String(row.versionAction)) && present(row.supersedesId) && present(row.effectiveFrom);
  const amountVersionValid = row.versionAction === "replace"
    ? present(row.amountCents) && row.amountCents > 0
    : row.versionAction !== "end" || !present(row.amountCents);
  const sourcePairAbsent = row.sourceSystem == null && row.sourceId == null;
  const artifactBoundaryPresent = present(row.sourceArtifactSha256) || present(row.artifactObservationOn);
  const validArtifactBoundary = present(row.sourceArtifactSha256)
    && typeof row.sourceArtifactSha256 === "string"
    && /^[a-f0-9]{64}$/.test(row.sourceArtifactSha256)
    && present(row.artifactObservationOn);
  const originValid = row.versionOrigin === "artifact"
    ? row.versionAction === "root"
      && row.lineageRootOrigin === "artifact"
      && validArtifactBinding(row, [String(row.categoryKnowledge), String(row.descriptionKnowledge), String(row.activeKnowledge), String(row.effectiveFromKnowledge)])
    : row.versionOrigin === "manual"
      && sourcePairAbsent
      && (row.lineageRootOrigin === "manual"
        ? !artifactBoundaryPresent
        : row.lineageRootOrigin === "artifact"
          && ["replace", "end"].includes(String(row.versionAction))
          && validArtifactBoundary);
  return strictFactPair(row.category, row.categoryKnowledge)
    && strictAmountPair(row.amountCents, row.amountKnowledge, true)
    && strictFactPair(row.description, row.descriptionKnowledge, true)
    && strictFactPair(row.active, row.activeKnowledge)
    && scopeValid
    && strictLinkPair(row.chargeDefinitionId, row.chargeDefinitionLinkKnowledge)
    && dateValid
    && row.lineageRootId != null
    && ["artifact", "manual"].includes(String(row.lineageRootOrigin))
    && ["root", "replace", "end"].includes(String(row.versionAction))
    && rootActionValid
    && amountVersionValid
    && originValid;
}

function validLedgerContract(row: SyntheticV8Row): boolean {
  const payerValid = row.payer == null
    ? FACT_UNKNOWN.has(String(row.payerKnowledge))
    : row.payer === "unknown"
      ? ["unknown", "ambiguous", "manual", "inferred"].includes(String(row.payerKnowledge))
      : ["tenant", "agency", "owner"].includes(String(row.payer)) && FACT_KNOWN.has(String(row.payerKnowledge));
  return strictFactPair(row.category, row.categoryKnowledge)
    && strictFactPair(row.status, row.statusKnowledge)
    && strictAmountPair(row.amountCents, row.amountKnowledge, false)
    && strictFactPair(row.postedOn, row.postedOnKnowledge)
    && strictFactPair(row.dueOn, row.dueOnKnowledge)
    && strictFactPair(row.paymentMethod, row.paymentMethodKnowledge)
    && payerValid
    && strictFactPair(row.description, row.descriptionKnowledge, true)
    && strictLinkPair(row.propertyId, row.propertyLinkKnowledge)
    && strictLinkPair(row.unitId, row.unitLinkKnowledge)
    && strictLinkPair(row.tenancyId, row.tenancyLinkKnowledge)
    && strictLinkPair(row.personId, row.personLinkKnowledge)
    && strictLinkPair(row.chargeDefinitionId, row.chargeDefinitionLinkKnowledge)
    && validArtifactBinding(row, [
      String(row.categoryKnowledge), String(row.statusKnowledge), String(row.postedOnKnowledge),
      String(row.paymentMethodKnowledge), String(row.payerKnowledge), String(row.descriptionKnowledge),
      String(row.propertyLinkKnowledge), String(row.unitLinkKnowledge), String(row.tenancyLinkKnowledge),
      String(row.personLinkKnowledge), String(row.chargeDefinitionLinkKnowledge),
    ]);
}

function validAllocationContract(row: SyntheticV8Row): boolean {
  return strictLinkPair(row.paymentTransactionId, row.paymentLinkKnowledge)
    && strictLinkPair(row.chargeTransactionId, row.chargeLinkKnowledge)
    && strictAmountPair(row.amountCents, row.amountKnowledge, true)
    && strictFactPair(row.allocatedOn, row.allocatedOnKnowledge);
}

function validChargeDefinitionContract(row: SyntheticV8Row): boolean {
  return strictFactPair(row.displayName, row.displayNameKnowledge, true)
    && strictFactPair(row.category, row.categoryKnowledge)
    && strictFactPair(row.active, row.activeKnowledge)
    && validArtifactBinding(row, [String(row.displayNameKnowledge), String(row.categoryKnowledge), String(row.activeKnowledge)]);
}

test("v8 SQL contracts reject all-null and partial-null value/knowledge pairs", () => {
  const rendered = renderRentOpsMigrationSqlForVersion(8);
  const requiredStrictChecks = [
    "rent_ops_charge_definitions_display_name_knowledge_check",
    "rent_ops_schedules_description_knowledge_check",
    "rent_ops_schedules_active_knowledge_check",
    "rent_ops_schedules_scope_knowledge_check",
    "rent_ops_schedules_charge_definition_knowledge_check",
    "rent_ops_schedules_effective_from_knowledge_v8_check",
    "rent_ops_ledger_status_knowledge_check",
    "rent_ops_ledger_posted_on_knowledge_check",
    "rent_ops_ledger_due_on_knowledge_check",
    "rent_ops_ledger_payment_method_knowledge_check",
    "rent_ops_ledger_payer_knowledge_check",
    "rent_ops_ledger_description_knowledge_check",
    "rent_ops_ledger_property_link_knowledge_check",
    "rent_ops_ledger_unit_link_knowledge_check",
    "rent_ops_ledger_tenancy_link_knowledge_check",
    "rent_ops_ledger_person_link_knowledge_check",
    "rent_ops_allocation_payment_link_knowledge_check",
    "rent_ops_allocation_charge_link_knowledge_check",
    "rent_ops_allocation_allocated_on_knowledge_check",
  ];
  for (const constraint of requiredStrictChecks) {
    const start = Math.max(
      rendered.indexOf(`ADD CONSTRAINT ${constraint} CHECK (`),
      rendered.indexOf(`CONSTRAINT ${constraint} CHECK (`),
    );
    assert.notEqual(start, -1, `${constraint} is missing from rendered v8 SQL`);
    const end = rendered.indexOf(");", start);
    assert.notEqual(end, -1, `${constraint} has no bounded body`);
    assert.match(rendered.slice(start, end), /IS NOT NULL/, `${constraint} must reject UNKNOWN CHECK results`);
  }

  const artifactSchedule: SyntheticV8Row = {
    id: "schedule-artifact", category: "base_rent", categoryKnowledge: "source",
    description: "Rent", descriptionKnowledge: "source", amountCents: 125000, amountKnowledge: "known",
    active: true, activeKnowledge: "source", scopeType: "unit", scopeId: "unit-1",
    scopeTypeKnowledge: "source", scopeLinkKnowledge: "exact", chargeDefinitionId: "definition-1",
    chargeDefinitionLinkKnowledge: "exact", effectiveFrom: "2026-08-01", effectiveFromKnowledge: "source",
    lineageRootId: "schedule-artifact", lineageRootOrigin: "artifact", versionAction: "root",
    versionOrigin: "artifact",
    sourceSystem: "rent_manager", sourceId: "schedule-1", sourceArtifactSha256: APPROVED_ARTIFACT_SHA256,
    artifactObservationOn: "2026-08-16",
  };
  const artifactUnknownSchedule: SyntheticV8Row = {
    ...artifactSchedule, category: null, categoryKnowledge: "unknown", description: null, descriptionKnowledge: "unknown",
    amountCents: null, amountKnowledge: "unknown", active: null, activeKnowledge: "unknown", scopeType: null,
    scopeId: null, scopeTypeKnowledge: "unknown", scopeLinkKnowledge: "unknown", chargeDefinitionId: null,
    chargeDefinitionLinkKnowledge: "unknown", effectiveFrom: null, effectiveFromKnowledge: "unknown_open_start",
  };
  const manualUnknownSchedule: SyntheticV8Row = {
    ...artifactUnknownSchedule, id: "schedule-manual", lineageRootId: "schedule-manual", lineageRootOrigin: "manual",
    versionOrigin: "manual", versionAction: "root", sourceSystem: null, sourceId: null, sourceArtifactSha256: null, artifactObservationOn: null,
  };
  const manualKnownSchedule: SyntheticV8Row = {
    ...manualUnknownSchedule, category: "recurring_fee", categoryKnowledge: "manual", description: "Pet fee",
    descriptionKnowledge: "manual", amountCents: 2500, amountKnowledge: "known", active: true, activeKnowledge: "manual",
    scopeType: "tenant", scopeId: "tenant-1", scopeTypeKnowledge: "manual", scopeLinkKnowledge: "manual",
    chargeDefinitionId: "definition-manual", chargeDefinitionLinkKnowledge: "manual", effectiveFrom: "2026-08-01",
    effectiveFromKnowledge: "manual",
  };
  for (const valid of [artifactSchedule, artifactUnknownSchedule, manualUnknownSchedule, manualKnownSchedule]) {
    assert.equal(validScheduleContract(valid), true, `intended schedule row should pass: ${valid.id}`);
  }
  const artifactManualReplace: SyntheticV8Row = {
    ...artifactSchedule,
    id: "schedule-artifact-replace",
    versionOrigin: "manual",
    versionAction: "replace",
    supersedesId: artifactSchedule.id,
    lineageRootId: artifactSchedule.id,
    sourceSystem: null,
    sourceId: null,
    effectiveFrom: "2026-09-01",
    effectiveFromKnowledge: "manual",
    sourceArtifactSha256: APPROVED_ARTIFACT_SHA256,
    artifactObservationOn: artifactSchedule.artifactObservationOn,
  };
  const artifactManualEnd: SyntheticV8Row = {
    ...artifactManualReplace,
    id: "schedule-artifact-end",
    versionAction: "end",
    supersedesId: artifactManualReplace.id,
    amountCents: null,
    amountKnowledge: "unknown",
  };
  const manualSuccessor: SyntheticV8Row = {
    ...manualKnownSchedule,
    id: "schedule-manual-end",
    versionOrigin: "manual",
    versionAction: "end",
    supersedesId: manualKnownSchedule.id,
    lineageRootId: manualKnownSchedule.id,
    effectiveFrom: "2026-09-01",
    effectiveFromKnowledge: "manual",
    amountCents: null,
    amountKnowledge: "unknown",
  };
  for (const valid of [artifactManualReplace, artifactManualEnd, manualSuccessor]) {
    assert.equal(validScheduleContract(valid), true, `intended successor row should pass: ${valid.id}`);
  }
  assert.equal(artifactManualReplace.sourceArtifactSha256, artifactSchedule.sourceArtifactSha256);
  assert.equal(artifactManualReplace.artifactObservationOn, artifactSchedule.artifactObservationOn);
  const forgedArtifactSuccessor = { ...artifactManualReplace, sourceArtifactSha256: "b".repeat(64) };
  assert.notEqual(forgedArtifactSuccessor.sourceArtifactSha256, artifactSchedule.sourceArtifactSha256);
  const invalidScheduleRows = [
    ["all-null category knowledge", { ...artifactSchedule, category: null, categoryKnowledge: null }],
    ["known category with null knowledge", { ...artifactSchedule, categoryKnowledge: null }],
    ["unknown category marked known", { ...artifactUnknownSchedule, categoryKnowledge: "source" }],
    ["scope id without scope type", { ...artifactUnknownSchedule, scopeId: "unit-1", scopeLinkKnowledge: "exact", scopeTypeKnowledge: "source" }],
    ["definition id with unknown link", { ...artifactSchedule, chargeDefinitionLinkKnowledge: "unknown" }],
    ["open date with null knowledge", { ...artifactUnknownSchedule, effectiveFromKnowledge: null }],
    ["manual root borrowing artifact", { ...manualKnownSchedule, sourceArtifactSha256: APPROVED_ARTIFACT_SHA256 }],
    ["artifact root missing source pair", { ...artifactSchedule, sourceSystem: null, sourceId: null }],
    ["artifact root mislabeled manual", { ...artifactSchedule, versionOrigin: "manual" }],
    ["manual successor missing inherited artifact boundary", { ...artifactManualReplace, sourceArtifactSha256: null, artifactObservationOn: null }],
    ["manual root mislabeled artifact", { ...manualKnownSchedule, versionOrigin: "artifact" }],
  ] as const;
  for (const [name, invalid] of invalidScheduleRows) assert.equal(validScheduleContract(invalid), false, name);

  const unknownLedger: SyntheticV8Row = {
    category: null, categoryKnowledge: "unknown", status: null, statusKnowledge: "unknown", amountCents: null,
    amountKnowledge: "unknown", postedOn: null, postedOnKnowledge: "unknown", dueOn: null, dueOnKnowledge: "unknown",
    paymentMethod: null, paymentMethodKnowledge: "unknown", payer: null, payerKnowledge: "unknown", description: null,
    descriptionKnowledge: "unknown", propertyId: null, propertyLinkKnowledge: "unknown", unitId: null,
    unitLinkKnowledge: "unknown", tenancyId: null, tenancyLinkKnowledge: "unknown", personId: null,
    personLinkKnowledge: "unknown", chargeDefinitionId: null, chargeDefinitionLinkKnowledge: "unknown",
    sourceSystem: null, sourceId: null, sourceArtifactSha256: null, artifactObservationOn: null,
  };
  const sourceLedger: SyntheticV8Row = {
    ...unknownLedger, category: "base_rent", categoryKnowledge: "source", status: "posted", statusKnowledge: "source",
    amountCents: 125000, amountKnowledge: "known", postedOn: "2026-08-01", postedOnKnowledge: "source",
    dueOn: "2026-08-01", dueOnKnowledge: "source", paymentMethod: "ach", paymentMethodKnowledge: "source",
    payer: "tenant", payerKnowledge: "source", description: "Rent", descriptionKnowledge: "source", propertyId: "p-1",
    propertyLinkKnowledge: "exact", unitId: "u-1", unitLinkKnowledge: "exact", tenancyId: "t-1",
    tenancyLinkKnowledge: "exact", personId: "person-1", personLinkKnowledge: "exact", chargeDefinitionId: "d-1",
    chargeDefinitionLinkKnowledge: "exact", sourceSystem: "rent_manager", sourceId: "ledger-1",
    sourceArtifactSha256: APPROVED_ARTIFACT_SHA256, artifactObservationOn: "2026-08-16",
  };
  const manualLedger: SyntheticV8Row = {
    ...sourceLedger, categoryKnowledge: "manual", statusKnowledge: "manual", postedOnKnowledge: "manual",
    dueOnKnowledge: "manual", paymentMethodKnowledge: "manual", payerKnowledge: "manual", descriptionKnowledge: "manual",
    propertyLinkKnowledge: "manual", unitLinkKnowledge: "manual", tenancyLinkKnowledge: "manual", personLinkKnowledge: "manual",
    chargeDefinitionLinkKnowledge: "manual", sourceSystem: null, sourceId: null, sourceArtifactSha256: null, artifactObservationOn: null,
  };
  for (const valid of [unknownLedger, sourceLedger, manualLedger]) assert.equal(validLedgerContract(valid), true);
  const invalidLedgerRows = [
    ["all-null status knowledge", { ...unknownLedger, statusKnowledge: null }],
    ["known status with null knowledge", { ...sourceLedger, statusKnowledge: null }],
    ["null amount marked known", { ...unknownLedger, amountKnowledge: "known" }],
    ["known amount with null knowledge", { ...sourceLedger, amountKnowledge: null }],
    ["known payment method with null knowledge", { ...sourceLedger, paymentMethodKnowledge: null }],
    ["null payer with null knowledge", { ...unknownLedger, payerKnowledge: null }],
    ["known link with unknown knowledge", { ...sourceLedger, propertyLinkKnowledge: "unknown" }],
    ["source ledger missing artifact", { ...sourceLedger, sourceArtifactSha256: null, artifactObservationOn: null }],
  ] as const;
  for (const [name, invalid] of invalidLedgerRows) assert.equal(validLedgerContract(invalid), false, name);

  const unknownAllocation: SyntheticV8Row = {
    paymentTransactionId: null, paymentLinkKnowledge: "unknown", chargeTransactionId: null, chargeLinkKnowledge: "unknown",
    amountCents: null, amountKnowledge: "unknown", allocatedOn: null, allocatedOnKnowledge: "unknown",
  };
  const manualAllocation: SyntheticV8Row = {
    paymentTransactionId: "payment-1", paymentLinkKnowledge: "manual", chargeTransactionId: "charge-1", chargeLinkKnowledge: "exact",
    amountCents: 5000, amountKnowledge: "known", allocatedOn: "2026-08-02", allocatedOnKnowledge: "manual",
  };
  assert.equal(validAllocationContract(unknownAllocation), true);
  assert.equal(validAllocationContract(manualAllocation), true);
  for (const invalid of [
    { ...unknownAllocation, paymentLinkKnowledge: null },
    { ...unknownAllocation, chargeTransactionId: "charge-1" },
    { ...unknownAllocation, amountKnowledge: "known" },
    { ...manualAllocation, allocatedOnKnowledge: null },
  ]) assert.equal(validAllocationContract(invalid), false);

  const artifactDefinition: SyntheticV8Row = {
    displayName: "Base rent", displayNameKnowledge: "source", category: "base_rent", categoryKnowledge: "source",
    active: true, activeKnowledge: "source", sourceSystem: "rent_manager", sourceId: "charge-type-1",
    sourceArtifactSha256: APPROVED_ARTIFACT_SHA256, artifactObservationOn: "2026-08-16",
  };
  const manualUnknownDefinition: SyntheticV8Row = {
    displayName: null, displayNameKnowledge: "unknown", category: null, categoryKnowledge: "unknown", active: null,
    activeKnowledge: "unknown", sourceSystem: null, sourceId: null, sourceArtifactSha256: null, artifactObservationOn: null,
  };
  assert.equal(validChargeDefinitionContract(artifactDefinition), true);
  assert.equal(validChargeDefinitionContract(manualUnknownDefinition), true);
  assert.equal(validChargeDefinitionContract({ ...manualUnknownDefinition, categoryKnowledge: null }), false);
  assert.equal(validChargeDefinitionContract({ ...artifactDefinition, sourceArtifactSha256: null }), false);
});

test("v8 lineage SQL keeps manual/artifact roots distinct and makes end terminal", () => {
  const rendered = renderRentOpsMigrationSqlForVersion(8);
  assert.match(rendered, /lineage_root_origin = 'manual'[\s\S]*source_system IS NULL[\s\S]*source_id IS NULL/);
  assert.match(rendered, /lineage_root_origin = 'artifact'[\s\S]*source_system IS NOT NULL[\s\S]*source_id IS NOT NULL/);
  assert.match(rendered, /IF predecessor\.version_action = 'end'[\s\S]*rent_ops_v8_successor_after_terminal_predecessor/);
  assert.match(rendered, /source_system IS NULL[\s\S]*source_artifact_sha256 IS NOT NULL[\s\S]*version_action IN \('replace','end'\)[\s\S]*version_origin = 'manual'[\s\S]*lineage_root_origin = 'artifact'/);
  assert.match(rendered, /NEW\.version_origin <> 'manual'[\s\S]*NEW\.source_system IS NOT NULL/);
  assert.match(rendered, /predecessor\.scope_type_knowledge IS DISTINCT FROM NEW\.scope_type_knowledge[\s\S]*predecessor\.description_knowledge IS DISTINCT FROM NEW\.description_knowledge/);
  assert.match(rendered, /NEW\.record_revision IS DISTINCT FROM predecessor\.record_revision \+ 1/);
  assert.match(rendered, /NEW\.version_action = 'end'[\s\S]*NEW\.amount_knowledge IS DISTINCT FROM 'unknown'[\s\S]*NEW\.active IS DISTINCT FROM false[\s\S]*NEW\.effective_to IS DISTINCT FROM NEW\.effective_from/);

  const sequenceAllowsSuccessor = (predecessorAction: string, successorAction: string): boolean =>
    predecessorAction !== "end" && ["replace", "end"].includes(successorAction);
  assert.equal(sequenceAllowsSuccessor("root", "end"), true);
  assert.equal(sequenceAllowsSuccessor("end", "replace"), false);
  assert.equal(sequenceAllowsSuccessor("end", "end"), false);
});

test("v8 rendered SQL splits cleanly and source-binding conjunctions are explicit", () => {
  const rendered = renderRentOpsMigrationSqlForVersion(8);
  const statements = splitRentOpsSqlStatements(rendered);
  assert.ok(statements.length > 100, "rendered v8 SQL should retain every ordered statement");
  assert.doesNotMatch(rendered, /source_id IS (?:NOT )?NULL\s+source_artifact_sha256/);
  assert.doesNotMatch(rendered, /source_system IS (?:NOT )?NULL\s+source_id IS (?:NOT )?NULL\s+source_artifact_sha256/);
  assert.ok(statements.some((statement) => statement.includes("rent_ops_v8_post_insert_checksum_guard")));
  assert.ok(statements.some((statement) => statement.includes("rent_ops_v8_successor_after_terminal_predecessor")));
});
