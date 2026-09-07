import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "../export/hash";
import type { RentOpsQueryExecutor } from "../repositories/postgres";
import {
  auditRestrictedParityStream,
  auditPersistedRestrictedParity,
  createRestrictedParityPersistenceWriter,
  persistRestrictedParityObservation,
  readRestrictedParityAggregateControls,
  type RestrictedParityAggregateControls,
  type RestrictedParityPersistenceInput,
} from "./restricted-parity-persistence";
import { createRestrictedImportObservationFromChunks, type RestrictedParitySourceChunk } from "./restricted-parity";

type TableRow = Record<string, unknown>;

class InMemoryRestrictedExecutor implements RentOpsQueryExecutor {
  readonly observations = new Map<string, TableRow>();
  readonly collections = new Map<string, TableRow>();
  readonly rows = new Map<string, TableRow>();

  async query<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    if (text.includes("rent_ops_restricted_parity_observations")) {
      if (text.startsWith("INSERT")) {
        const row: TableRow = {
          id: values[0], version: values[1], source: values[2], source_run_id: values[3], import_run_id: values[4], observed_at: values[5], source_envelope_sha256: values[6], source_manifest_sha256: values[7], source_rows_sha256: values[8], collections_sha256: values[9], collection_occurrence_count: values[10], collection_occurrence_order_sha256: values[11], collection_occurrence_set_sha256: values[12], row_occurrence_count: values[13], row_occurrence_order_sha256: values[14], row_occurrence_set_sha256: values[15], source_identity_order_sha256: values[16], source_schema_version: values[17], source_registry_sha256: values[18], source_checkpoint_sha256: values[19], source_coverage_sha256: values[20], source_control_sha256: values[21],
        };
        if (this.observations.has(String(row.id))) return { rows: [] as T[] };
        this.observations.set(String(row.id), row);
        return { rows: [row as T] };
      }
      return { rows: [this.observations.get(String(values[0]))].filter(Boolean) as T[] };
    }
    if (text.includes("rent_ops_restricted_parity_collection_occurrences")) {
      if (text.startsWith("INSERT")) {
        const row: TableRow = { id: values[0], observation_id: values[1], occurrence_ordinal: values[2], path: values[3], present: values[4], row_count: values[5], ordered_rows_sha256: values[6], source_identity_rows_sha256: values[7] };
        if (this.collections.has(String(row.id))) return { rows: [] as T[] };
        this.collections.set(String(row.id), row);
        return { rows: [row as T] };
      }
      if (text.includes("WHERE id = $1")) return { rows: [this.collections.get(String(values[0]))].filter(Boolean) as T[] };
      const result = Array.from(this.collections.values()).filter((row) => row.observation_id === values[0]).sort((left, right) => Number(left.occurrence_ordinal) - Number(right.occurrence_ordinal));
      return { rows: result.slice(0, Number(values[1] ?? result.length)) as T[] };
    }
    if (text.includes("rent_ops_restricted_parity_row_occurrences")) {
      if (text.startsWith("INSERT")) {
        const row: TableRow = { id: values[0], observation_id: values[1], occurrence_ordinal: values[2], collection_occurrence_ordinal: values[3], collection_path: values[4], row_ordinal: values[5], system: values[6], source_collection: values[7], source_id: values[8], checksum_sha256: values[9], row_digest_sha256: values[10] };
        if (this.rows.has(String(row.id))) return { rows: [] as T[] };
        this.rows.set(String(row.id), row);
        return { rows: [row as T] };
      }
      if (text.includes("WHERE id = $1")) return { rows: [this.rows.get(String(values[0]))].filter(Boolean) as T[] };
      const result = Array.from(this.rows.values()).filter((row) => row.observation_id === values[0]).sort((left, right) => Number(left.occurrence_ordinal) - Number(right.occurrence_ordinal));
      return { rows: result.slice(0, Number(values[1] ?? result.length)) as T[] };
    }
    throw new Error("unexpected_query");
  }
}

class PayloadAuditExecutor extends InMemoryRestrictedExecutor {
  payloadRows: TableRow[] = [];

  override async query<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    if (text.includes("FROM rent_ops_source_payloads")) return { rows: this.payloadRows as T[] };
    return super.query<T>(text, values);
  }
}

function row(system: string, sourceCollection: string, sourceId: string, value: string) {
  const canonicalPayload = JSON.stringify({ sourceId, value });
  return { system, sourceCollection, sourceId, canonicalPayload, checksumSha256: sha256(canonicalPayload) };
}

function input(): { value: RestrictedParityPersistenceInput; chunks: readonly RestrictedParitySourceChunk[] } {
  const chunks: readonly RestrictedParitySourceChunk[] = [
    { path: "payload.contacts", present: true, rows: [row("rent_manager", "contacts", "contact-1", "same"), row("rent_manager", "contacts", "contact-1", "same")] },
    { path: "payload.contacts", present: true, rows: [row("rent_manager", "contacts", "contact-2", "second")] },
    { path: "payload.empty", present: true, rows: [] },
    { path: "payload.absent", present: false, rows: [] },
  ];
  const observation = createRestrictedImportObservationFromChunks({
    sourceEnvelopeSha256: "a".repeat(64),
    sourceRunId: "source-run-1",
    importRunId: "import-run-1",
    observedAt: "2026-08-17T12:00:00.000Z",
    sourceManifestSha256: "b".repeat(64),
    sourceChunks: chunks,
  });
  return {
    chunks,
    value: { observation, sourceManifestSha256: "b".repeat(64), sourceChunks: chunks },
  };
}

test("restricted parity persistence retains duplicate, ordered, empty, and absent occurrences", async () => {
  const fixture = input();
  const executor = new InMemoryRestrictedExecutor();
  const controls = await persistRestrictedParityObservation(executor, fixture.value);
  assert.equal(controls.collectionOccurrences.length, 4);
  assert.equal(controls.rowOccurrences.length, 3);
  assert.equal(controls.rowOccurrences[0]?.identitySha256, controls.rowOccurrences[1]?.identitySha256);
  assert.equal("sourceId" in controls.rowOccurrences[0]!, false);
  assert.equal(controls.collectionOccurrences[2]?.present, true);
  assert.equal(controls.collectionOccurrences[2]?.rowCount, 0);
  assert.equal(controls.collectionOccurrences[3]?.present, false);
  assert.equal(controls.collectionOccurrences[3]?.rowCount, 0);
  assert.equal(JSON.stringify(controls).includes("contact-1"), false);
  assert.equal(executor.rows.size, 3, "row occurrence storage must not deduplicate equal identities");
  assert.equal(executor.collections.size, 4, "collection occurrence storage must preserve repeated paths");
});

test("writer retries are insert-only and idempotent after exact conflict verification", async () => {
  const fixture = input();
  const executor = new InMemoryRestrictedExecutor();
  const writer = createRestrictedParityPersistenceWriter();
  const first = await writer(executor, fixture.value);
  const second = await writer(executor, fixture.value);
  assert.deepEqual(second, first);
});

test("bounded aggregate readback contains controls only and audits the database stream", async () => {
  const fixture = input();
  const executor = new InMemoryRestrictedExecutor();
  const expected = await persistRestrictedParityObservation(executor, fixture.value);
  const actual = await readRestrictedParityAggregateControls(executor, expected.observationId);
  const report = auditRestrictedParityStream({ expected: fixture.value, actual });
  assert.equal(report.passed, true);
  assert.deepEqual(report.blockingReasons, []);
  assert.equal(report.duplicateExpectedOccurrences, 1);
  assert.equal(report.duplicateActualOccurrences, 1);
  assert.equal(JSON.stringify(report).includes("contact-1"), false);
});

test("stream audit catches missing, extra, reorder, duplicate, and empty-vs-absent tampering", async () => {
  const fixture = input();
  const executor = new InMemoryRestrictedExecutor();
  const expected = await persistRestrictedParityObservation(executor, fixture.value);
  const tampered = (mutate: (copy: RestrictedParityAggregateControls) => void): ReturnType<typeof auditRestrictedParityStream> => {
    const copy: RestrictedParityAggregateControls = {
      ...expected,
      collectionOccurrences: expected.collectionOccurrences.map((value) => ({ ...value })),
      rowOccurrences: expected.rowOccurrences.map((value) => ({ ...value })),
    };
    mutate(copy);
    return auditRestrictedParityStream({ expected: fixture.value, actual: copy });
  };
  assert.ok(tampered((copy) => { (copy.rowOccurrences as Array<unknown>).splice(0, 1); }).blockingReasons.includes("restricted_parity_row_occurrence_count_mismatch"));
  assert.ok(tampered((copy) => { (copy.rowOccurrences as Array<unknown>).push({ ...copy.rowOccurrences[0]! }); }).blockingReasons.includes("restricted_parity_row_occurrence_count_mismatch"));
  assert.ok(tampered((copy) => { const rows = copy.rowOccurrences as Array<unknown>; [rows[0], rows[1]] = [rows[1], rows[0]]; }).blockingReasons.includes("restricted_parity_row_occurrence_order_mismatch"));
  assert.ok(tampered((copy) => { const rows = copy.rowOccurrences as Array<unknown>; rows[1] = { ...rows[1]!, checksumSha256: "c".repeat(64) }; }).blockingReasons.includes("restricted_parity_row_occurrence_order_mismatch"));
  assert.ok(tampered((copy) => { const collections = copy.collectionOccurrences as Array<Record<string, unknown>>; collections[2]!.present = false; }).blockingReasons.includes("restricted_parity_empty_presence_mismatch"));
});

test("source checksum binding fails before any persistence query", async () => {
  const fixture = input();
  const bad = { ...fixture.value, sourceChunks: [{ ...fixture.chunks[0]!, rows: [{ ...fixture.chunks[0]!.rows[0]!, checksumSha256: "d".repeat(64) }] }] };
  await assert.rejects(() => persistRestrictedParityObservation(new InMemoryRestrictedExecutor(), bad), /restricted_parity_source_checksum_binding_invalid/u);
});

test("postcommit restricted audit checks payload checksum/canonical binding without returning payload values", async () => {
  const fixture = input();
  const executor = new PayloadAuditExecutor();
  const controls = await persistRestrictedParityObservation(executor, fixture.value);
  const firstRow = fixture.chunks[0]!.rows[0]!;
  const payloadId = `rm-payload:${sha256(`rent_manager\u0000contacts\u0000contact-1\u0000${firstRow.checksumSha256}`)}`;
  const expectedPayload = { id: payloadId, system: "rent_manager", sourceCollection: "contacts", sourceId: "contact-1", checksumSha256: firstRow.checksumSha256, importRunId: "import-run-1", canonicalPayload: firstRow.canonicalPayload };
  executor.payloadRows = [{ id: payloadId, system: "rent_manager", source_collection: "contacts", source_id: "contact-1", checksum_sha256: firstRow.checksumSha256, import_run_id: "import-run-1", payload: firstRow.canonicalPayload }];
  const passed = await auditPersistedRestrictedParity(executor, { ...fixture.value, payloadBindings: [expectedPayload] });
  assert.equal(passed.passed, true);
  assert.equal(JSON.stringify(passed).includes(firstRow.canonicalPayload), false);
  executor.payloadRows[0]!.checksum_sha256 = "e".repeat(64);
  const tampered = await auditPersistedRestrictedParity(executor, { ...fixture.value, payloadBindings: [expectedPayload] });
  assert.equal(tampered.passed, false);
  assert.ok(tampered.blockingReasons.includes("restricted_parity_payload_binding_mismatch"));
  assert.equal(controls.observationId.length > 0, true);
});
