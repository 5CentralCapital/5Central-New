import assert from "node:assert/strict";
import test from "node:test";
import { emptyRentOpsSnapshot, type RentOpsApplicationHistorySnapshot, type RentOpsRecordChange, type RentOpsRecurringChargeSchedule } from "../../../shared/rent-ops-contracts";
import { ensureRentOpsSchema, rentOpsMigrationSql, RENT_OPS_REQUIRED_TABLES, RENT_OPS_RUNTIME_REQUIRED_TABLES } from "../persistence";
import { createPostgresRentOpsRepository, RentOpsTablesMissingError, type RentOpsQueryExecutor } from "./postgres";

class FakeExecutor implements RentOpsQueryExecutor {
  readonly calls: Array<{ text: string; values?: unknown[] }> = [];
  readonly rowsByTable = new Map<string, Record<string, unknown>[]>();
  readonly inserted = new Map<string, { columns: string[]; values: unknown[] }>();
  constructor(private readonly present = true, private readonly forbiddenPrivilege = false) {}
  async transaction<T>(work: (executor: RentOpsQueryExecutor) => Promise<T>): Promise<T> {
    return work(this);
  }
  async query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.calls.push({ text, values });
    if (text.includes("information_schema.tables")) return { rows: (this.present ? [...RENT_OPS_RUNTIME_REQUIRED_TABLES] : []).map((table_name) => ({ table_name })) as T[] };
    if (text.includes("has_table_privilege")) {
      const forbidden = (values?.[0] as string[] | undefined) ?? [];
      return { rows: forbidden.map((table_name) => ({ table_name, can_select: this.forbiddenPrivilege, can_insert: false, can_update: false, can_delete: false })) as T[] };
    }
    if (text.includes("FOR UPDATE")) return { rows: [{ id: values?.[0] }] as T[] };
    if (text.startsWith("UPDATE rent_ops_") && text.includes("record_revision") && text.includes("RETURNING id")) return { rows: [{ id: values?.at(-2) }] as T[] };
    const selectExisting = text.match(/^SELECT (.+) FROM (rent_ops_[a-z_]+) WHERE id = \$1/);
    if (selectExisting) {
      const entry = this.inserted.get(selectExisting[2]);
      if (!entry || entry.values[0] !== values?.[0]) return { rows: [] };
      const columns = selectExisting[1].split(", ");
      return { rows: [Object.fromEntries(columns.map((column, index) => [column, entry.values[index]])) as T] };
    }
    const appById = text.includes("FROM rent_ops_applications WHERE id = $1");
    if (appById) return { rows: this.rowsByTable.get("rent_ops_applications")?.filter((row) => row.id === values?.[0]) as T[] ?? [] };
    const table = text.match(/^SELECT \* FROM (rent_ops_[a-z_]+)/)?.[1];
    if (table) return { rows: (this.rowsByTable.get(table) ?? []) as T[] };
    const insert = text.match(/^INSERT INTO (rent_ops_[a-z_]+) \(([^)]+)\)/);
    if (insert && !this.inserted.has(insert[1])) {
      this.inserted.set(insert[1], { columns: insert[2].split(", "), values: values ?? [] });
      if (text.includes("RETURNING id")) return { rows: [{ id: values?.[0] }] as T[] };
    }
    return { rows: [] };
  }
}

class RecurringScheduleExecutor extends FakeExecutor {
  private readonly schedules: Array<Record<string, unknown>>;
  failRecordChange = false;

  constructor(predecessor: Record<string, unknown>) {
    super();
    this.schedules = [predecessor];
  }

  get scheduleRows(): readonly Record<string, unknown>[] {
    return this.schedules;
  }

  override async transaction<T>(work: (executor: RentOpsQueryExecutor) => Promise<T>): Promise<T> {
    const schedulesBefore = this.schedules.map((row) => ({ ...row }));
    const insertedBefore = new Map(this.inserted);
    try {
      return await work(this);
    } catch (error) {
      this.schedules.splice(0, this.schedules.length, ...schedulesBefore);
      this.inserted.clear();
      for (const [table, entry] of insertedBefore) this.inserted.set(table, entry);
      throw error;
    }
  }

  override async query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
    if (this.failRecordChange && text.startsWith("INSERT INTO rent_ops_record_changes")) throw new Error("synthetic_record_change_insert_failed");
    if (text.includes("FROM rent_ops_recurring_charge_schedules") || text.startsWith("INSERT INTO rent_ops_recurring_charge_schedules")) {
      this.calls.push({ text, values });
      if (text.startsWith("SELECT")) {
        const id = values?.[0];
        const rows = text.includes("supersedes_id = $1")
          ? this.schedules.filter((row) => row.supersedes_id === id)
          : this.schedules.filter((row) => row.id === id);
        return { rows: rows as T[] };
      }
      const insert = text.match(/^INSERT INTO rent_ops_recurring_charge_schedules \(([^)]+)\)/);
      if (insert) {
        const columns = insert[1].split(", ");
        const row = Object.fromEntries(columns.map((column, index) => [column, values?.[index]]));
        const existing = this.schedules.find((candidate) => candidate.id === row.id);
        if (!existing) {
          this.schedules.push(row);
          return text.includes("RETURNING id") ? { rows: [{ id: row.id }] as T[] } : { rows: [] as T[] };
        }
        return { rows: [] as T[] };
      }
    }
    return super.query(text, values);
  }
}

class HistoryForeignKeyOrderExecutor extends FakeExecutor {
  private historyDocumentsInserted = false;

  override async query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
    if (text.startsWith("INSERT INTO rent_ops_application_requirement_occurrences")) {
      assert.equal(this.historyDocumentsInserted, true, "history documents must precede requirements with the document FK");
    }
    if (text.startsWith("INSERT INTO rent_ops_application_history_documents")) this.historyDocumentsInserted = true;
    return super.query(text, values);
  }
}

function recurringScheduleFixture(overrides: Partial<RentOpsRecurringChargeSchedule> = {}): RentOpsRecurringChargeSchedule {
  return {
    id: "schedule-root",
    source: { system: "rent_manager", entityType: "recurring_schedule", sourceId: "rs-1" },
    scopeType: "tenant",
    scopeId: "person-1",
    scopeTypeKnowledge: "source",
    scopeLinkKnowledge: "exact",
    chargeDefinitionId: "definition-1",
    chargeDefinitionKey: "ct-1",
    tenancyId: "tenancy-1",
    personId: "person-1",
    propertyId: "property-1",
    unitId: "unit-1",
    category: "base_rent",
    categoryKnowledge: "source",
    description: null,
    descriptionKnowledge: "unknown",
    amountCents: null,
    amountKnowledge: "unknown",
    effectiveFrom: null,
    effectiveFromKnowledge: "unknown_open_start",
    effectiveTo: null,
    active: null,
    activeKnowledge: "unknown",
    sourceConfidence: "confirmed",
    chargeDefinitionKnowledge: "exact",
    chargeDefinitionLinkKnowledge: "exact",
    sourceArtifactSha256: "a".repeat(64),
    artifactObservationOn: "2026-08-17",
    lineageRootId: "schedule-root",
    lineageRootOrigin: "artifact",
    versionOrigin: "artifact",
    supersedesId: null,
    versionAction: "root",
    recordRevision: 1,
    ...overrides,
  };
}

function recurringRow(schedule: RentOpsRecurringChargeSchedule): Record<string, unknown> {
  return {
    id: schedule.id,
    record_revision: schedule.recordRevision,
    source_system: schedule.source?.system ?? null,
    source_id: schedule.source?.sourceId ?? null,
    scope_type: schedule.scopeType,
    scope_id: schedule.scopeId,
    scope_type_knowledge: schedule.scopeTypeKnowledge,
    scope_link_knowledge: schedule.scopeLinkKnowledge,
    charge_definition_id: schedule.chargeDefinitionId,
    charge_definition_key: schedule.chargeDefinitionKey,
    tenancy_id: schedule.tenancyId,
    person_id: schedule.personId,
    property_id: schedule.propertyId,
    unit_id: schedule.unitId,
    category: schedule.category,
    category_knowledge: schedule.categoryKnowledge,
    description: schedule.description,
    description_knowledge: schedule.descriptionKnowledge,
    amount_cents: schedule.amountCents,
    amount_knowledge: schedule.amountKnowledge,
    effective_from: schedule.effectiveFrom,
    effective_from_knowledge: schedule.effectiveFromKnowledge,
    effective_to: schedule.effectiveTo,
    active: schedule.active,
    active_knowledge: schedule.activeKnowledge,
    source_confidence: schedule.sourceConfidence,
    charge_definition_knowledge: schedule.chargeDefinitionKnowledge,
    charge_definition_link_knowledge: schedule.chargeDefinitionLinkKnowledge,
    source_artifact_sha256: schedule.sourceArtifactSha256,
    artifact_observation_on: schedule.artifactObservationOn,
    lineage_root_id: schedule.lineageRootId,
    lineage_root_origin: schedule.lineageRootOrigin,
    version_origin: schedule.versionOrigin,
    supersedes_id: schedule.supersedesId,
    version_action: schedule.versionAction,
  };
}

function recurringChange(targetId: string, revision = 2): RentOpsRecordChange {
  return {
    id: `change:${targetId}:${revision}`,
    entityType: "recurring_schedule",
    targetId,
    revision,
    origin: "admin",
    actorSubject: "admin-test",
    occurredAt: "2026-08-17T12:00:00.000Z",
    changedFields: ["effectiveFrom", "versionAction"],
  };
}

test("Postgres repository fails closed when the explicit migration has not created all tables", async () => {
  const repository = createPostgresRentOpsRepository(new FakeExecutor(false));
  await assert.rejects(() => repository.getSnapshot(), (error: unknown) => error instanceof RentOpsTablesMissingError && error.missingTables.length === RENT_OPS_RUNTIME_REQUIRED_TABLES.length);
});

test("Postgres row mapping preserves half baths, JSON, booleans, dates, household members, and application internals", async () => {
  const executor = new FakeExecutor();
  executor.rowsByTable.set("rent_ops_properties", [{ id: "p1", name: "Synthetic", slug: "synthetic", address_line1: "1 Example Way", city: "Sampleton", state: "ZZ", postal_code: "00001", property_type: "multifamily", state_status: "active" }]);
  executor.rowsByTable.set("rent_ops_units", [{ id: "u1", property_id: "p1", unit_number: "1A", bathrooms: "1.5", readiness: "ready", listing: "listed", amenities: '["washer"]' }]);
  executor.rowsByTable.set("rent_ops_people", [{ id: "person1", first_name: "Synthetic", last_name: "Resident", archived: false }]);
  executor.rowsByTable.set("rent_ops_applications", [{ id: "app1", source_type: "public_portal", status: "draft", email: "app@example.test", first_name: "Synthetic", last_name: "Applicant", resume_token_hash: "hash", resume_token_expires_at: new Date("2026-08-17T00:00:00.000Z"), rental_history: '{"currentAddress":"1 Example Way"}', created_at: new Date("2026-08-16T00:00:00.000Z"), updated_at: new Date("2026-08-16T00:00:00.000Z") }]);
  executor.rowsByTable.set("rent_ops_application_household_members", [{ id: "member1", application_id: "app1", first_name: "Member", last_name: "One", is_minor: true }]);
  executor.rowsByTable.set("rent_ops_charge_definitions", [{ id: "charge-definition-1", record_revision: 1, source_system: "rent_manager", source_id: "ct-1", source_artifact_sha256: null, artifact_observation_on: null, display_name: null, display_name_knowledge: "unknown", category: null, category_knowledge: "unknown", active: null, active_knowledge: "unknown" }]);
  executor.rowsByTable.set("rent_ops_recurring_charge_schedules", [{ id: "schedule-null-financials", record_revision: 1, source_system: "rent_manager", source_id: "rs-1", scope_type: "unit", scope_id: "u1", scope_type_knowledge: "exact", scope_link_knowledge: "exact", charge_definition_id: "charge-definition-1", charge_definition_key: null, tenancy_id: null, person_id: null, property_id: "p1", unit_id: "u1", category: null, category_knowledge: "unknown", description: null, description_knowledge: "unknown", amount_cents: null, amount_knowledge: "unknown", effective_from: null, effective_from_knowledge: "unknown_open_start", effective_to: null, active: null, active_knowledge: "unknown", source_confidence: "confirmed", charge_definition_knowledge: "exact", charge_definition_link_knowledge: "exact", source_artifact_sha256: null, artifact_observation_on: null, lineage_root_id: "schedule-null-financials", lineage_root_origin: "artifact", version_origin: "artifact", supersedes_id: null, version_action: "root" }]);
  executor.rowsByTable.set("rent_ops_ledger_transactions", [{ id: "ledger-null-financials", source_system: "rent_manager", source_id: "lt-1", property_id: "p1", unit_id: null, tenancy_id: null, person_id: null, kind: "payment", category: null, category_knowledge: "unknown", status: null, amount_cents: null, posted_on: null, due_on: null, payment_method: null, payment_method_knowledge: "unknown", description: null, reversal_of_id: null, payer: null, payer_knowledge: "unknown", adjustment_direction: null, property_link_knowledge: "exact", unit_link_knowledge: "unknown", tenancy_link_knowledge: "unknown", person_link_knowledge: "unknown", amount_knowledge: "unknown", posted_on_knowledge: "unknown", due_on_knowledge: "unknown", description_knowledge: "unknown", status_knowledge: "unknown", allocation_mode: null, charge_definition_id: null, charge_definition_link_knowledge: "unknown", source_artifact_sha256: null, artifact_observation_on: null }]);
  executor.rowsByTable.set("rent_ops_payment_allocations", [{ id: "allocation-null-financials", source_system: "rent_manager", source_id: "pa-1", payment_transaction_id: null, charge_transaction_id: null, amount_cents: null, allocated_on: null, payment_link_knowledge: "unknown", charge_link_knowledge: "unknown", amount_knowledge: "unknown", allocated_on_knowledge: "unknown" }]);
  const snapshot = await createPostgresRentOpsRepository(executor).getSnapshot();
  assert.equal(snapshot.units[0].bathrooms, 1.5);
  assert.deepEqual(snapshot.units[0].amenities, ["washer"]);
  assert.equal(snapshot.applicationHouseholdMembers[0].isMinor, true);
  assert.equal(snapshot.applications[0].resumeTokenHash, "hash");
  assert.equal(snapshot.applications[0].rentalHistory?.currentAddress, "1 Example Way");
  assert.equal(snapshot.chargeDefinitions[0].displayName, null);
  assert.equal(snapshot.chargeDefinitions[0].active, null);
  assert.equal(snapshot.recurringSchedules[0].amountCents, null);
  assert.equal(snapshot.recurringSchedules[0].effectiveFrom, null);
  assert.equal(snapshot.recurringSchedules[0].active, null);
  assert.equal(snapshot.recurringSchedules[0].versionOrigin, "artifact");
  assert.equal(snapshot.ledgerTransactions[0].amountCents, null);
  assert.equal(snapshot.ledgerTransactions[0].postedOn, null);
  assert.equal(snapshot.ledgerTransactions[0].description, null);
  assert.equal(snapshot.ledgerTransactions[0].paymentMethod, null);
  assert.equal(snapshot.ledgerTransactions[0].payer, null);
  assert.equal(snapshot.paymentAllocations[0].amountCents, null);
  assert.equal(snapshot.paymentAllocations[0].allocatedOn, null);
});

test("Postgres application-history writes insert linked documents before requirement occurrences", async () => {
  const history: RentOpsApplicationHistorySnapshot = {
    prospects: [],
    applications: [{
      id: "history-app-1",
      source: { system: "rent_manager", entityType: "application_history", sourceId: "app-1" },
      prospectId: null,
      prospectLinkKnowledge: null,
      personId: null,
      personLinkKnowledge: null,
      firstName: null,
      lastName: null,
      email: null,
      phone: null,
      status: null,
      statusKnowledge: "unknown",
      submittedOn: null,
      submittedOnKnowledge: "unknown",
      createdOn: null,
      createdOnKnowledge: "unknown",
      updatedOn: null,
      updatedOnKnowledge: "unknown",
      recordRevision: 1,
    }],
    interests: [],
    participants: [],
    requirements: [{
      id: "history-requirement-1",
      source: { system: "rent_manager", entityType: "application_requirement", sourceId: "requirement-1" },
      applicationId: "history-app-1",
      applicationLinkKnowledge: "exact",
      key: null,
      label: null,
      status: null,
      statusKnowledge: "unknown",
      requestedOn: null,
      requestedOnKnowledge: "unknown",
      resolvedOn: null,
      resolvedOnKnowledge: "unknown",
      documentId: "history-document-1",
      documentLinkKnowledge: "exact",
      origin: "source",
      recordRevision: 1,
    }],
    templates: [],
    templateSections: [],
    templateFields: [],
    answers: [],
    documents: [{
      id: "history-document-1",
      source: { system: "rent_manager", entityType: "application_document", sourceId: "document-1" },
      applicationId: "history-app-1",
      applicationLinkKnowledge: "exact",
      type: null,
      typeKnowledge: "unknown",
      state: null,
      stateKnowledge: "unknown",
      fileName: null,
      mimeType: null,
      metadataSizeBytes: null,
      metadataChecksumSha256: null,
      availability: "metadata",
      recordRevision: 1,
    }],
    activities: [],
    blockers: [],
    unknownRestricted: {
      restrictedAnswerCount: 0,
      unmappedAnswerCount: 0,
      missingAnswerApplications: 0,
      metadataOnlyDocumentCount: 1,
      unavailableDocumentCount: 0,
      unlinkedActivityCount: 0,
      unlinkedInterestCount: 0,
    },
  };

  const executor = new HistoryForeignKeyOrderExecutor();
  await createPostgresRentOpsRepository(executor).saveApplicationHistory(history);
  const documentInsert = executor.calls.findIndex((call) => call.text.startsWith("INSERT INTO rent_ops_application_history_documents"));
  const requirementInsert = executor.calls.findIndex((call) => call.text.startsWith("INSERT INTO rent_ops_application_requirement_occurrences"));
  assert.ok(documentInsert >= 0);
  assert.ok(requirementInsert > documentInsert);
});

test("runtime readiness fails closed when a runtime identity can see a restricted table", async () => {
  const repository = createPostgresRentOpsRepository(new FakeExecutor(true, true));
  await assert.rejects(() => repository.getSnapshot(), /forbidden table privilege/);
});

test("Postgres append-only ledger retry is idempotent for identical payloads and rejects conflicts", async () => {
  const executor = new FakeExecutor();
  const repository = createPostgresRentOpsRepository(executor);
  const transaction = { id: "ledger1", propertyId: "p1", kind: "charge" as const, category: "base_rent" as const, status: "posted" as const, amountCents: 100000, postedOn: "2026-08-01" as const, description: "Rent" };
  await repository.saveLedgerTransaction(transaction);
  await repository.saveLedgerTransaction(transaction);
  await assert.rejects(() => repository.saveLedgerTransaction({ ...transaction, description: "Changed" }), /append-only/i);
  assert.equal(executor.calls.filter((call) => call.text.startsWith("INSERT INTO rent_ops_ledger_transactions")).length, 3);
});

test("Postgres recurring schedules persist the complete v8 row append-only", async () => {
  const executor = new FakeExecutor();
  const repository = createPostgresRentOpsRepository(executor);
  const root = recurringScheduleFixture();
  await repository.saveRecurringSchedule(root);
  await repository.saveRecurringSchedule(root);
  await assert.rejects(() => repository.saveRecurringSchedule({ ...root, description: "changed" }), /append-only|conflicts|immutable/i);
  const inserts = executor.calls.filter((call) => call.text.startsWith("INSERT INTO rent_ops_recurring_charge_schedules"));
  assert.equal(inserts.length, 3);
  assert.match(inserts[0].text, /scope_type_knowledge/);
  assert.match(inserts[0].text, /amount_knowledge/);
  assert.match(inserts[0].text, /artifact_observation_on/);
  assert.match(inserts[0].text, /lineage_root_origin/);
  assert.doesNotMatch(inserts[0].text, /DO UPDATE/);
});

test("Postgres artifact recurring roots reject half or empty source identity pairs", async () => {
  for (const source of [
    { system: "rent_manager", entityType: "recurring_schedule", sourceId: "" },
    { system: "", entityType: "recurring_schedule", sourceId: "schedule-source" },
  ] as const) {
    const executor = new FakeExecutor();
    const repository = createPostgresRentOpsRepository(executor);
    await assert.rejects(
      () => repository.saveRecurringSchedule(recurringScheduleFixture({ source: source as never })),
      /artifact provenance/i,
    );
    assert.equal(executor.calls.some((call) => call.text.startsWith("INSERT INTO rent_ops_recurring_charge_schedules")), false);
  }
});

test("Postgres manual recurring root writes its required change row atomically and retries immutably", async () => {
  const root = recurringScheduleFixture({
    id: "manual-atomic-root",
    source: undefined,
    sourceArtifactSha256: null,
    artifactObservationOn: null,
    lineageRootId: "manual-atomic-root",
    lineageRootOrigin: "manual",
    versionOrigin: "manual",
    effectiveFrom: "2026-08-17",
    effectiveFromKnowledge: "manual",
  });
  const change: RentOpsRecordChange = {
    id: "change:manual-atomic-root:1",
    entityType: "recurring_schedule",
    targetId: root.id,
    revision: 1,
    origin: "admin",
    actorSubject: "admin-root-test",
    occurredAt: "2026-08-17T12:00:00.000Z",
    changedFields: ["amountCents"],
  };
  const executor = new RecurringScheduleExecutor(recurringRow(recurringScheduleFixture()));
  const repository = createPostgresRentOpsRepository(executor);
  const saved = await repository.saveRecurringScheduleRoot!({ schedule: root, change });
  assert.equal(saved.id, root.id);
  const retried = await repository.saveRecurringScheduleRoot!({ schedule: root, change });
  assert.equal(retried.id, root.id);
  assert.equal(executor.scheduleRows.filter((row) => row.id === root.id).length, 1);
  assert.equal(executor.calls.filter((call) => call.text.startsWith("INSERT INTO rent_ops_record_changes")).length, 2);

  const failingExecutor = new RecurringScheduleExecutor(recurringRow(recurringScheduleFixture()));
  failingExecutor.failRecordChange = true;
  const failingRepository = createPostgresRentOpsRepository(failingExecutor);
  await assert.rejects(() => failingRepository.saveRecurringScheduleRoot!({ schedule: root, change }), /synthetic_record_change_insert_failed/);
  assert.equal(failingExecutor.scheduleRows.some((row) => row.id === root.id), false);
});

test("Postgres recurring successor locks predecessor, appends one branch, retries identically, and rejects conflicts", async () => {
  const root = recurringScheduleFixture();
  const executor = new RecurringScheduleExecutor(recurringRow(root));
  const repository = createPostgresRentOpsRepository(executor);
  const successor = recurringScheduleFixture({
    id: "schedule-successor",
    source: undefined,
    effectiveFrom: "2026-09-01",
    effectiveFromKnowledge: "manual",
    supersedesId: root.id,
    versionOrigin: "manual",
    versionAction: "replace",
    recordRevision: 2,
  });
  const omissionExecutor = new RecurringScheduleExecutor(recurringRow(root));
  const omissionRepository = createPostgresRentOpsRepository(omissionExecutor);
  await assert.rejects(
    () => Reflect.apply(omissionRepository.saveRecurringScheduleSuccessor!, omissionRepository, [{ predecessorId: root.id, successor, expectedRevision: 1 }]),
    /authenticated change record/i,
  );
  assert.equal(omissionExecutor.scheduleRows.length, 1, "an unaudited direct successor must not append");
  const change: RentOpsRecordChange = {
    id: "change:schedule-successor:2",
    entityType: "recurring_schedule",
    targetId: successor.id,
    revision: 2,
    origin: "admin",
    actorSubject: "admin-test",
    occurredAt: "2026-08-17T12:00:00.000Z",
    changedFields: ["effectiveFrom", "versionAction"],
  };
  const saved = await repository.saveRecurringScheduleSuccessor!({ predecessorId: root.id, successor, expectedRevision: 1, change });
  assert.equal(saved.id, successor.id);
  const replay = await repository.saveRecurringScheduleSuccessor!({ predecessorId: root.id, successor, expectedRevision: 1, change });
  assert.equal(replay.id, successor.id);
  assert.equal(executor.inserted.has("rent_ops_record_changes"), true);
  const changeInsertCount = executor.calls.filter((call) => call.text.startsWith("INSERT INTO rent_ops_record_changes")).length;
  assert.equal(changeInsertCount, 2, "an identical replay may retry the immutable change insert, but must no-op after exact compare");
  await assert.rejects(
    () => repository.saveRecurringScheduleSuccessor!({ predecessorId: root.id, successor: { ...successor, effectiveFrom: "2026-10-01" }, expectedRevision: 1, change }),
    /branch already exists|different payload/i,
  );
  await assert.rejects(
    () => repository.saveRecurringScheduleSuccessor!({ predecessorId: root.id, successor: { ...successor, id: "schedule-forged-source", source: root.source }, expectedRevision: 1, change: recurringChange("schedule-forged-source") }),
    /provenance is invalid/i,
  );
  await assert.rejects(
    () => repository.saveRecurringScheduleSuccessor!({ predecessorId: root.id, successor, expectedRevision: 0, change }),
    /revision is stale/i,
  );
  const manualRoot = recurringScheduleFixture({ id: "manual-root", source: undefined, lineageRootId: "manual-root", lineageRootOrigin: "manual", versionOrigin: "manual", sourceArtifactSha256: null, artifactObservationOn: null });
  const manualExecutor = new RecurringScheduleExecutor(recurringRow(manualRoot));
  const manualRepository = createPostgresRentOpsRepository(manualExecutor);
  const manualSuccessor = recurringScheduleFixture({ id: "manual-successor", source: undefined, lineageRootId: "manual-root", lineageRootOrigin: "manual", versionOrigin: "manual", sourceArtifactSha256: null, artifactObservationOn: null, supersedesId: "manual-root", versionAction: "end", effectiveFrom: "2026-09-01", effectiveFromKnowledge: "manual", effectiveTo: "2026-09-01", active: false, activeKnowledge: "manual", amountCents: null, amountKnowledge: "unknown", recordRevision: 2 });
  const manualSaved = await manualRepository.saveRecurringScheduleSuccessor!({ predecessorId: "manual-root", successor: manualSuccessor, expectedRevision: 1, change: recurringChange(manualSuccessor.id) });
  assert.equal(manualSaved.id, manualSuccessor.id);
  const manualInsert = manualExecutor.calls.find((call) => call.text.startsWith("INSERT INTO rent_ops_recurring_charge_schedules") && call.values?.[0] === manualSuccessor.id);
  assert.equal(manualInsert?.values?.includes(null), true);
  const sql = manualExecutor.calls.map((call) => call.text).join("\n");
  assert.match(sql, /FROM rent_ops_recurring_charge_schedules WHERE id = \$1 FOR UPDATE/);
  assert.match(sql, /WHERE supersedes_id = \$1 FOR UPDATE/);
  assert.doesNotMatch(sql, /UPDATE rent_ops_recurring_charge_schedules/);

  const failingExecutor = new RecurringScheduleExecutor(recurringRow(root));
  failingExecutor.failRecordChange = true;
  const failingRepository = createPostgresRentOpsRepository(failingExecutor);
  await assert.rejects(
    () => failingRepository.saveRecurringScheduleSuccessor!({ predecessorId: root.id, successor, expectedRevision: 1, change }),
    /synthetic_record_change_insert_failed/,
  );
  assert.equal(failingExecutor.scheduleRows.some((row) => row.id === successor.id), false, "a failed change row must roll back the successor insert");
});

test("Postgres successor guards inherited semantic fields, terminal shape, and predecessor end boundary", async () => {
  const boundedRoot = recurringScheduleFixture({ id: "bounded-root", lineageRootId: "bounded-root", effectiveTo: "2026-09-30" });
  const executor = new RecurringScheduleExecutor(recurringRow(boundedRoot));
  const repository = createPostgresRentOpsRepository(executor);
  const successor = recurringScheduleFixture({ id: "bounded-successor", source: undefined, supersedesId: boundedRoot.id, lineageRootId: boundedRoot.id, versionOrigin: "manual", versionAction: "replace", effectiveFrom: "2026-10-01", effectiveFromKnowledge: "manual", recordRevision: 2 });
  await assert.rejects(() => repository.saveRecurringScheduleSuccessor!({ predecessorId: boundedRoot.id, successor, expectedRevision: 1, change: recurringChange(successor.id) }), /starts after predecessor end/i);
  await assert.rejects(() => repository.saveRecurringScheduleSuccessor!({ predecessorId: boundedRoot.id, successor: { ...successor, id: "bounded-description", effectiveFrom: "2026-09-01", description: "forged" }, expectedRevision: 1, change: recurringChange("bounded-description") }), /immutable fields/i);

  const openRoot = recurringScheduleFixture({ id: "open-root", lineageRootId: "open-root" });
  const openExecutor = new RecurringScheduleExecutor(recurringRow(openRoot));
  const openRepository = createPostgresRentOpsRepository(openExecutor);
  const forgedEnd = recurringScheduleFixture({ id: "forged-end", source: undefined, supersedesId: openRoot.id, lineageRootId: openRoot.id, versionOrigin: "manual", versionAction: "end", effectiveFrom: "2026-09-01", effectiveFromKnowledge: "manual", effectiveTo: null, amountCents: null, amountKnowledge: "unknown", active: true, activeKnowledge: "manual", recordRevision: 2 });
  await assert.rejects(() => openRepository.saveRecurringScheduleSuccessor!({ predecessorId: openRoot.id, successor: forgedEnd, expectedRevision: 1, change: recurringChange(forgedEnd.id) }), /terminal/i);
});

test("Postgres business transactions lock application inventory and ledger rows before invariant checks", async () => {
  const executor = new FakeExecutor();
  const repository = createPostgresRentOpsRepository(executor);
  await repository.transaction(async () => "locked", { lockApplicationId: "application-1", lockTransactionIds: ["charge-1", "payment-1", "charge-1"] });
  const lockSql = executor.calls.filter((call) => call.text.includes("FOR UPDATE")).map((call) => call.text).join("\n");
  assert.match(lockSql, /FROM rent_ops_applications WHERE id = \$1 FOR UPDATE/);
  assert.match(lockSql, /FROM rent_ops_ledger_transactions WHERE id = ANY\(\$1::varchar\[\]\) FOR UPDATE/);
});

test("Postgres record patches lock the target, compare revision, and reject provenance columns", async () => {
  const executor = new FakeExecutor();
  const repository = createPostgresRentOpsRepository(executor);
  await repository.transaction(async (inner) => {
    await inner.applyRecordPatch!({ entityType: "property", targetId: "property-1", expectedRevision: 1, nextRevision: 2, values: { name: "Operator name", name_knowledge: "manual" } });
    await inner.saveRecordChange!({ id: "change:property-1:2", entityType: "property", targetId: "property-1", revision: 2, origin: "admin", actorSubject: "admin-1", occurredAt: "2026-08-17T12:00:00.000Z", changedFields: ["name", "nameKnowledge"] });
  }, { lockRecord: { entityType: "property", targetId: "property-1" } });
  const sql = executor.calls.map((call) => call.text).join("\n");
  assert.match(sql, /SELECT id FROM rent_ops_properties WHERE id = \$1 FOR UPDATE/);
  assert.match(sql, /UPDATE rent_ops_properties SET name = \$1, name_knowledge = \$2, record_revision = \$3 WHERE id = \$4 AND record_revision = \$5 RETURNING id/);
  assert.match(sql, /INSERT INTO rent_ops_record_changes/);
  await assert.rejects(
    () => repository.applyRecordPatch!({ entityType: "property", targetId: "property-1", expectedRevision: 2, nextRevision: 3, values: { source_id: "forged" } }),
    /positive allowlist/i,
  );
});

test("Postgres patch transactions lock tenancy and lease sibling sets before invariant checks", async () => {
  const executor = new FakeExecutor();
  const repository = createPostgresRentOpsRepository(executor);
  await repository.transaction(async () => "locked", { lockRecord: { entityType: "tenancy", targetId: "tenancy-1" }, lockTenancySiblings: true, lockTenancyUnitIds: ["unit-new", "unit-new"] });
  await repository.transaction(async () => "locked", { lockRecord: { entityType: "lease_term", targetId: "lease-1" }, lockLeaseSiblings: true, lockLeaseTenancyIds: ["tenancy-new"] });
  const lockSql = executor.calls.filter((call) => call.text.includes("FOR UPDATE")).map((call) => call.text).join("\n");
  assert.match(lockSql, /FROM rent_ops_tenancies WHERE unit_id = \(SELECT unit_id FROM rent_ops_tenancies WHERE id = \$1\) OR unit_id = ANY\(\$2::varchar\[\]\) ORDER BY unit_id, id FOR UPDATE/);
  assert.match(lockSql, /FROM rent_ops_tenancies WHERE id = \(SELECT tenancy_id FROM rent_ops_lease_terms WHERE id = \$1\) OR id = ANY\(\$2::varchar\[\]\) ORDER BY id FOR UPDATE/);
  assert.match(lockSql, /FROM rent_ops_lease_terms WHERE tenancy_id = \(SELECT tenancy_id FROM rent_ops_lease_terms WHERE id = \$1\) OR tenancy_id = ANY\(\$2::varchar\[\]\) ORDER BY tenancy_id, id FOR UPDATE/);
  assert.deepEqual(executor.calls.find((call) => call.text.includes("rent_ops_tenancies WHERE unit_id"))?.values?.[1], ["unit-new"]);
  assert.deepEqual(executor.calls.find((call) => call.text.includes("rent_ops_lease_terms WHERE id = $1) OR id"))?.values?.[1], ["tenancy-new"]);
});

test("Postgres admin creates are atomic insert-only conflicts and never update an existing ID", async () => {
  const executor = new FakeExecutor();
  const repository = createPostgresRentOpsRepository(executor);
  const property = { id: "property-create", name: "First", slug: "first", address: { line1: "1 Way", city: "Town", state: "ZZ", postalCode: "00001" }, propertyType: "multifamily" as const, state: "active" as const };
  await repository.saveProperty(property);
  await assert.rejects(() => repository.saveProperty({ ...property, name: "Attempted overwrite" }), /already exists|PATCH/i);
  assert.equal(executor.calls.some((call) => call.text.startsWith("UPDATE rent_ops_properties")), false);
});

test("migration is explicit, versioned, and dry-runs without a database executor", async () => {
  const sql = rentOpsMigrationSql();
  assert.match(sql, /rent_ops_schema_meta/);
  assert.match(sql, /rent_ops_ledger_transactions/);
  assert.match(sql, /adjustment_direction/);
  const dryRun = await ensureRentOpsSchema();
  assert.equal(dryRun.mode, "dry_run");
  assert.ok(dryRun.statementCount >= RENT_OPS_REQUIRED_TABLES.length);
  const statements: string[] = [];
  const applied = await ensureRentOpsSchema({ apply: true, executor: async (statement) => { statements.push(statement); } });
  assert.equal(applied.mode, "applied");
  assert.equal(statements.length, applied.statementCount);
});


test("charge definition catalog reads only its table and preserves snapshot mapping and order", async () => {
  const executor = new FakeExecutor();
  executor.rowsByTable.set("rent_ops_charge_definitions", [
    { id: "definition-z", record_revision: 3, display_name: null, display_name_knowledge: "unknown", category: null, category_knowledge: "unknown", active: null, active_knowledge: "unknown" },
    { id: "definition-a", record_revision: 1, display_name: "Rent", display_name_knowledge: "manual", category: "base_rent", category_knowledge: "manual", active: true, active_knowledge: "manual" },
  ]);
  const repository = createPostgresRentOpsRepository(executor);
  const expected = (await repository.getSnapshot()).chargeDefinitions;
  executor.calls.length = 0;
  assert.deepEqual(await repository.getChargeDefinitions(), expected);
  assert.deepEqual(executor.calls.map(call => call.text), ["SELECT * FROM rent_ops_charge_definitions"]);
  assert.deepEqual(expected.map(row => row.id), ["definition-z", "definition-a"]);
});
