import assert from "node:assert/strict";
import test from "node:test";
import {
  auditRestrictedSourceParity,
  auditRestrictedSourceParityChunks,
  createRestrictedImportObservation,
  createRestrictedImportObservationFromChunks,
  createRestrictedParityCanary,
  findCredentialShapedFields,
  mapRestrictedEnvelopeToRows,
  runRestrictedParityCanary,
  type RestrictedImportObservation,
  type RestrictedParityChunkRow,
  type RestrictedParitySourceChunk,
  type RestrictedSourcePayloadRowLike,
} from "./restricted-parity";
import type { ExportEnvelope } from "../export/types";
import { canonicalJson, sha256 } from "../export/hash";

function canaryInput() {
  const canary = createRestrictedParityCanary();
  return {
    canary,
    input: {
      envelope: canary.envelope,
      observation: canary.observation,
      restrictedRows: canary.restrictedRows,
      projections: {
        normalizedSnapshot: canary.normalizedSnapshot,
        publicDto: canary.publicDto,
        adminDto: canary.adminDto,
        logSafeSummary: canary.logSafeSummary,
      },
      protectedCanary: { field: canary.protectedField, value: canary.protectedValue },
    },
  };
}

function mutableObservation(observation: RestrictedImportObservation): RestrictedImportObservation {
  return {
    ...observation,
    collections: observation.collections.map((collection) => ({ ...collection })),
  };
}

function mutableRows(rows: readonly RestrictedSourcePayloadRowLike[]): Array<Record<string, unknown>> {
  return rows.map((row) => ({ ...row, payload: row.payload && typeof row.payload === "object" ? structuredClone(row.payload) : row.payload }));
}

test("synthetic canary passes and keeps a protected field restricted", () => {
  const report = runRestrictedParityCanary();
  assert.equal(report.passed, true);
  assert.equal(report.rowChecks.expectedCount, 1);
  assert.equal(report.rowChecks.actualCount, 1);
  assert.equal(report.collectionChecks.presenceMismatchCount, 0);
  assert.equal(report.projectionChecks.protectedValueInRestrictedRows, true);
  assert.equal(report.projectionChecks.normalizedSnapshotLeak, false);
  assert.equal(report.projectionChecks.publicDtoLeak, false);
  assert.equal(report.projectionChecks.adminDtoLeak, false);
  assert.equal(report.projectionChecks.logSafeSummaryLeak, false);

  const { canary } = canaryInput();
  assert.equal(Object.isFrozen(canary.restrictedRows[0]), true);
  assert.equal(Object.isFrozen(canary.restrictedRows[0]?.payload), true);
  const reportJson = JSON.stringify(report);
  assert.equal(reportJson.includes(canary.protectedValue), false);
  assert.equal(JSON.stringify(canary.normalizedSnapshot).includes(canary.protectedValue), false);
  assert.equal(JSON.stringify(canary.publicDto).includes(canary.protectedValue), false);
  assert.equal(JSON.stringify(canary.adminDto).includes(canary.protectedValue), false);
  assert.equal(JSON.stringify(canary.logSafeSummary).includes(canary.protectedValue), false);

  const leaked = auditRestrictedSourceParity({
    ...canaryInput().input,
    projections: { publicDto: { redactedField: canary.protectedValue } },
  });
  assert.equal(leaked.passed, false);
  assert.equal(leaked.projectionChecks.publicDtoLeak, true);
});

test("observation preserves empty-vs-absent collections and ordered row evidence", () => {
  const { canary } = canaryInput();
  const observation = createRestrictedImportObservation(canary.envelope, {
    importRunId: "canary-import-20260817",
    observedAt: "2026-08-17T12:00:01.000Z",
    requiredCollectionPaths: ["payload.absentCollection"],
  });
  const rows = mapRestrictedEnvelopeToRows(canary.envelope, {
    importRunId: observation.importRunId,
    importedAt: observation.observedAt,
    requiredCollectionPaths: ["payload.absentCollection"],
  });
  const passing = auditRestrictedSourceParity({
    envelope: canary.envelope,
    observation,
    restrictedRows: rows,
    requiredCollectionPaths: ["payload.absentCollection"],
  });
  assert.equal(passing.passed, true);
  assert.equal(passing.collectionChecks.expectedCount, 4);

  const missingAbsentObservation = mutableObservation(observation);
  missingAbsentObservation.collections = missingAbsentObservation.collections.filter((collection) => collection.path !== "payload.absentCollection");
  const missingReport = auditRestrictedSourceParity({
    envelope: canary.envelope,
    observation: missingAbsentObservation,
    restrictedRows: rows,
    requiredCollectionPaths: ["payload.absentCollection"],
  });
  assert.equal(missingReport.passed, false);
  assert.ok(missingReport.blockingReasons.includes("collection_observation_missing"));

  const orderDrift = mutableObservation(observation);
  const properties = orderDrift.collections.find((collection) => collection.path === "payload.properties");
  assert.ok(properties);
  properties.orderedRowsSha256 = "0".repeat(64);
  const orderReport = auditRestrictedSourceParity({
    envelope: canary.envelope,
    observation: orderDrift,
    restrictedRows: rows,
    requiredCollectionPaths: ["payload.absentCollection"],
  });
  assert.equal(orderReport.passed, false);
  assert.ok(orderReport.blockingReasons.includes("collection_order_digest_mismatch"));
});

test("row parity catches missing, duplicate, unexpected, and altered restricted rows", () => {
  const { canary, input } = canaryInput();
  const missing = auditRestrictedSourceParity({ ...input, restrictedRows: [] });
  assert.equal(missing.passed, false);
  assert.ok(missing.blockingReasons.includes("restricted_row_missing"));

  const duplicate = auditRestrictedSourceParity({ ...input, restrictedRows: [...canary.restrictedRows, canary.restrictedRows[0]!] });
  assert.equal(duplicate.passed, false);
  assert.ok(duplicate.blockingReasons.includes("restricted_row_duplicate"));

  const alteredRows = mutableRows(canary.restrictedRows);
  alteredRows[0]!.sourceId = "property-canary-altered";
  const altered = auditRestrictedSourceParity({ ...input, restrictedRows: alteredRows });
  assert.equal(altered.passed, false);
  assert.ok(altered.blockingReasons.includes("restricted_row_missing"));
  assert.ok(altered.blockingReasons.includes("restricted_row_unexpected"));

  const tamperedRows = mutableRows(canary.restrictedRows);
  const tamperedPayload = tamperedRows[0]!.payload as Record<string, unknown>;
  tamperedPayload.Name = "Synthetic Changed";
  const tampered = auditRestrictedSourceParity({ ...input, restrictedRows: tamperedRows });
  assert.equal(tampered.passed, false);
  assert.ok(tampered.rowChecks.alteredCount > 0);
  assert.ok(tampered.blockingReasons.includes("restricted_row_altered") || tampered.blockingReasons.includes("restricted_row_shape_or_digest_invalid"));
});

test("full envelope and import observation digests are required", () => {
  const { canary, input } = canaryInput();
  const digestDrift = mutableObservation(canary.observation);
  digestDrift.sourceEnvelopeSha256 = "f".repeat(64);
  const report = auditRestrictedSourceParity({ ...input, observation: digestDrift });
  assert.equal(report.passed, false);
  assert.ok(report.blockingReasons.includes("source_envelope_digest_mismatch"));

  const withoutObservation = auditRestrictedSourceParity({ envelope: canary.envelope, restrictedRows: canary.restrictedRows });
  assert.equal(withoutObservation.passed, false);
  assert.ok(withoutObservation.blockingReasons.includes("import_observation_missing"));

  const wrongImportRows = mutableRows(canary.restrictedRows);
  wrongImportRows.forEach((row) => { row.importRunId = "different-import-observation"; });
  const wrongImport = auditRestrictedSourceParity({ ...input, restrictedRows: wrongImportRows });
  assert.equal(wrongImport.passed, false);
  assert.ok(wrongImport.blockingReasons.includes("restricted_row_import_observation_mismatch"));
});

test("credential-shaped fields are rejected without echoing their values", () => {
  const { canary, input } = canaryInput();
  const envelopeWithCredential = structuredClone(canary.envelope) as ExportEnvelope & { payload: Record<string, unknown> };
  (envelopeWithCredential.payload.properties as Array<Record<string, unknown>>)[0]!.accessToken = "synthetic-credential-shaped-value";
  assert.ok(findCredentialShapedFields(envelopeWithCredential).some((path) => path.includes("accessToken")));
  const report = auditRestrictedSourceParity({ ...input, envelope: envelopeWithCredential });
  assert.equal(report.passed, false);
  assert.ok(report.blockingReasons.includes("credential_shaped_field_detected"));
  assert.equal(JSON.stringify(report).includes("synthetic-credential-shaped-value"), false);
});

test("the adapter accepts the current SQL row shape without exposing payload values", () => {
  const { canary, input } = canaryInput();
  const row = canary.restrictedRows[0]!;
  const sqlShapedRow: RestrictedSourcePayloadRowLike = {
    id: row.id,
    system: row.system,
    source_collection: row.sourceCollection,
    source_id: row.sourceId,
    source_updated_at: row.sourceUpdatedAt,
    payload: JSON.parse(row.canonicalPayload),
    checksum_sha256: row.checksumSha256,
    import_run_id: row.importRunId,
  };
  const report = auditRestrictedSourceParity({ ...input, restrictedRows: [sqlShapedRow] });
  assert.equal(report.passed, true);
  assert.equal(JSON.stringify(report).includes(canary.protectedValue), false);
});

test("nested retention rows can be mapped once under an explicit policy", () => {
  const envelope = {
    version: "rm-export/v2" as const,
    runId: "nested-canary-run",
    source: { system: "rent_manager" as const, transport: "injected" as const, readOnly: true as const },
    createdAt: "2026-08-17T12:00:00.000Z",
    payload: {
      parents: [{ entityType: "parent", sourceId: "parent-canary-1", Children: [{ entityType: "child", sourceId: "child-canary-1", value: "synthetic-child" }] }],
    },
    documentBinaries: [],
  } as unknown as ExportEnvelope;
  const observation = createRestrictedImportObservation(envelope, { importRunId: "nested-import", observedAt: "2026-08-17T12:00:01.000Z", includeNestedRows: true });
  const rows = mapRestrictedEnvelopeToRows(envelope, { importRunId: observation.importRunId, includeNestedRows: true });
  assert.equal(rows.length, 2);
  const report = auditRestrictedSourceParity({ envelope, observation, restrictedRows: rows, includeNestedRows: true });
  assert.equal(report.passed, true);
  assert.equal(report.rowChecks.expectedCount, 2);
});

test("the full-archive chunk seam handles more than the canary row limit with aggregate-only state", () => {
  const totalRows = 26_001;
  const chunkSize = 257;
  const sourceRunId = "stream-canary-run";
  const importRunId = "stream-canary-import";
  const sourceEnvelopeSha256 = "a".repeat(64);
  const rowAt = (index: number): RestrictedParityChunkRow => {
    const sourceId = `synthetic-row-${index}`;
    const canonicalPayload = canonicalJson({ entityType: "synthetic", sourceId, ordinal: index });
    const checksumSha256 = sha256(canonicalPayload);
    return { system: "rent_manager", sourceCollection: "syntheticRows", sourceId, canonicalPayload, checksumSha256 };
  };
  function* rows(start: number, end: number): IterableIterator<RestrictedParityChunkRow> {
    for (let index = start; index < end; index += 1) yield rowAt(index);
  }
  function* chunks(): IterableIterator<RestrictedParitySourceChunk> {
    for (let start = 0; start < totalRows; start += chunkSize) {
      yield { path: "payload.syntheticRows", present: true, rows: rows(start, Math.min(totalRows, start + chunkSize)) };
    }
  }
  function* restrictedRows(): IterableIterator<RestrictedSourcePayloadRowLike> {
    for (let index = 0; index < totalRows; index += 1) {
      const row = rowAt(index);
      yield {
        id: `rm-payload:${sha256(`rent_manager\u0000syntheticRows\u0000${row.sourceId}\u0000${row.checksumSha256}`)}`,
        system: row.system,
        source_collection: row.sourceCollection,
        source_id: row.sourceId,
        canonicalPayload: row.canonicalPayload,
        checksum_sha256: row.checksumSha256,
        import_run_id: importRunId,
      };
    }
  }
  const observation = createRestrictedImportObservationFromChunks({
    sourceEnvelopeSha256,
    sourceRunId,
    importRunId,
    observedAt: "2026-08-17T12:00:01.000Z",
    sourceChunks: chunks(),
  });
  const report = auditRestrictedSourceParityChunks({
    sourceEnvelopeSha256,
    sourceRunId,
    sourceChunks: chunks(),
    restrictedRows: restrictedRows(),
    observation,
  });
  assert.equal(report.passed, true);
  assert.equal(report.rowChecks.expectedCount, totalRows);
  assert.equal(report.rowChecks.actualCount, totalRows);
  assert.equal(report.collectionChecks.expectedCount, 1);
  assert.equal(report.collectionChecks.orderedDigestMismatchCount, 0);
});
