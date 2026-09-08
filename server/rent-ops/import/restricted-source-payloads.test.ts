import assert from "node:assert/strict";
import test from "node:test";
import type { RentOpsQueryExecutor } from "../repositories/postgres";
import type { RestrictedSourcePayloadPersistenceContext } from "./persistence-importer";
import {
  createRestrictedSourcePayloadWriter,
  restrictedSourcePayloadControlSummary,
} from "./restricted-source-payloads";

class CaptureExecutor implements RentOpsQueryExecutor {
  readonly calls: Array<{ text: string; values: unknown[] }> = [];
  async query<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ text, values });
    if (text.includes("INSERT INTO rent_ops_source_payloads")) {
      return { rows: [{ id: values[0], system: values[1], source_collection: values[2], source_id: values[3], source_updated_at: values[4], checksum_sha256: values[6] } as T] };
    }
    if (text.includes("INSERT INTO rent_ops_source_binaries")) {
      return { rows: [{ id: values[0], system: values[1], source_collection: values[2], source_id: values[3], storage_key: values[5], checksum_sha256: values[6], size_bytes: values[7], content_type: values[8] } as T] };
    }
    return { rows: [] };
  }
}

class ConflictingExecutor extends CaptureExecutor {
  async query<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ text, values });
    if (text.startsWith("INSERT INTO rent_ops_source_payloads")) return { rows: [] };
    if (text.startsWith("SELECT id, system, source_collection")) {
      return { rows: [{ id: values[0], system: values[1], source_collection: values[2], source_id: values[3], source_updated_at: null, checksum_sha256: "f".repeat(64) } as T] };
    }
    return { rows: [] };
  }
}

function context(): RestrictedSourcePayloadPersistenceContext {
  return {
    input: {
      version: "rm-export/v2",
      payload: {
        properties: [{ sourceCollection: "properties", sourceId: "property:1", PropertyID: 1, Name: "Synthetic Property", UpdateDate: "2026-08-16T12:00:00.000Z" }],
        contacts: [{ sourceCollection: "contacts", sourceId: "contact:1", ContactID: 1, Email: "synthetic@example.test" }],
        documentBinaries: [{ sourceCollection: "signableDocuments", sourceId: "document:1", binaryAvailable: true, archivePath: "binaries/document-1.pdf", sha256: "a".repeat(64), sizeBytes: 12, contentType: "application/pdf" }],
      },
    },
    importRun: {
      id: "rm-import:synthetic",
      system: "rent_manager",
      startedAt: "2026-08-16T12:00:00.000Z",
      completedAt: "2026-08-16T12:00:00.000Z",
      mode: "apply",
      counts: {},
      exceptionCount: 0,
      status: "completed",
    },
    sourceRecords: [],
    sourceManifestHash: "b".repeat(64),
  };
}

test("restricted writer stores canonical payloads and verified binary bindings only in restricted tables", async () => {
  const executor = new CaptureExecutor();
  await createRestrictedSourcePayloadWriter()(executor, context());
  assert.equal(executor.calls.filter((call) => call.text.includes("rent_ops_source_payloads")).length, 3);
  assert.equal(executor.calls.filter((call) => call.text.includes("rent_ops_source_binaries")).length, 1);
  assert.ok(executor.calls.every((call) => !call.text.includes("rent_ops_source_records")));
  assert.ok(executor.calls.every((call) => !call.text.includes("rent_ops_people")));
  assert.match(String(executor.calls[0].values[5]), /^\{/u);
  assert.match(String(executor.calls[0].values[6]), /^[a-f0-9]{64}$/u);
});

test("CreateDate-only rows retain creation evidence without fabricating sourceUpdatedAt", async () => {
  const input = context();
  const property = (input.input as { payload: { properties: Array<Record<string, unknown>> } }).payload.properties[0];
  delete property.UpdateDate;
  property.CreateDate = "2026-08-01T12:00:00.000Z";
  const executor = new CaptureExecutor();
  await createRestrictedSourcePayloadWriter()(executor, input);
  const propertyInsert = executor.calls.find((call) => call.text.includes("INSERT INTO rent_ops_source_payloads") && call.values[2] === "properties");
  assert.ok(propertyInsert);
  assert.equal(propertyInsert.values[4], null);
  assert.match(String(propertyInsert.values[5]), /CreateDate/u);
  assert.match(String(propertyInsert.values[5]), /2026-08-01/u);
});

test("restricted control summary is deterministic and contains no raw values", () => {
  const first = restrictedSourcePayloadControlSummary(context());
  const second = restrictedSourcePayloadControlSummary(context());
  assert.deepEqual(first, second);
  assert.equal(first.payloadCount, 3);
  assert.equal(first.binaryCount, 1);
  assert.equal(first.collectionCounts.contacts, 1);
  const rendered = JSON.stringify(first);
  assert.equal(rendered.includes("synthetic@example.test"), false);
  assert.equal(rendered.includes("Synthetic Property"), false);
});

test("verified application status crosswalk is metadata, not a source payload collection", async () => {
  const input = context();
  const payload = (input.input as { payload: Record<string, unknown> }).payload;
  payload.applicationHistoryStatusCrosswalk = [{
    artifactSha256: "c".repeat(64),
    sourceCollection: "prospectApplications",
    sourceField: "status",
    sourceValue: "Submitted",
    targetStatus: "submitted",
  }];

  const summary = restrictedSourcePayloadControlSummary(input);
  assert.equal(summary.payloadCount, 3);
  assert.equal(summary.collectionCounts.applicationHistoryStatusCrosswalk, undefined);
  assert.deepEqual(summary.blockingReasons, []);

  const executor = new CaptureExecutor();
  await createRestrictedSourcePayloadWriter()(executor, input);
  assert.equal(executor.calls.filter((call) => call.text.includes("rent_ops_source_payloads")).length, 3);
  assert.ok(executor.calls.every((call) => !call.values.includes("Submitted")));
});

test("conflicting versions retain both restricted payload versions and expose an ambiguity blocker", async () => {
  const input = context();
  const payload = (input.input as { payload: { properties: unknown[] } }).payload;
  payload.properties.push({ sourceCollection: "properties", sourceId: "property:1", PropertyID: 1, Name: "Different" });
  const executor = new CaptureExecutor();
  await createRestrictedSourcePayloadWriter()(executor, input);
  assert.equal(executor.calls.filter((call) => call.text.includes("rent_ops_source_payloads")).length, 4);
  const summary = restrictedSourcePayloadControlSummary(input);
  assert.equal(summary.ambiguousIdentityCount, 1);
  assert.equal(summary.ambiguousVersionCount, 2);
  assert.deepEqual(summary.blockingReasons, ["restricted_source_payload_ambiguous_version"]);
  assert.equal(summary.ambiguityDigestSha256.length, 64);
});

test("binary bindings reject absolute or traversal storage paths", async () => {
  const input = context();
  const payload = (input.input as { payload: { documentBinaries: Array<Record<string, unknown>> } }).payload;
  payload.documentBinaries[0].archivePath = "../outside.pdf";
  await assert.rejects(() => createRestrictedSourcePayloadWriter()(new CaptureExecutor(), input), /restricted_source_binary_binding_invalid/u);
});

test("same binary version conflicts fail while distinct historical versions remain addressable", async () => {
  const input = context();
  const exportInput = input.input as {
    version: string;
    payload: Record<string, unknown>;
    documentBinaries?: Array<Record<string, unknown>>;
  };
  const descriptor = (exportInput.payload.documentBinaries as Array<Record<string, unknown>>)[0];
  delete exportInput.payload.documentBinaries;
  exportInput.documentBinaries = [descriptor, { ...descriptor, archivePath: "binaries/other-location.pdf" }];
  await assert.rejects(() => createRestrictedSourcePayloadWriter()(new CaptureExecutor(), input), /restricted_source_binary_version_conflict/u);

  exportInput.documentBinaries = [descriptor, { ...descriptor, sha256: "b".repeat(64), archivePath: "binaries/document-1-v2.pdf" }];
  const summary = restrictedSourcePayloadControlSummary(input);
  assert.equal(summary.binaryCount, 2);
  assert.equal(summary.versionSetSha256.length, 64);
});

test("insert-only source payload retries verify the existing conflict instead of silently accepting drift", async () => {
  await assert.rejects(
    () => createRestrictedSourcePayloadWriter()(new ConflictingExecutor(), context()),
    /restricted_source_payload_conflict/u,
  );
});


test("source-bound financial review holds are metadata, while actual source identities stay required",()=>{
 const input=context();const payload=(input.input as {payload:Record<string,unknown>}).payload;
 payload.financialReviewHolds=[{tenantSourceId:"7",reason:"assistance_responsibility_unverified",artifactSha256:"a".repeat(64),evidenceRecordSha256:"b".repeat(64),sourceReference:"export-envelope.json#/payload/tenants/0"}];
 const summary=restrictedSourcePayloadControlSummary(input);assert.equal(summary.payloadCount,3);assert.equal(summary.collectionCounts.financialReviewHolds,undefined);assert.deepEqual(summary.blockingReasons,[]);
 payload.actualSourceRows=[{Amount:1}];assert.throws(()=>restrictedSourcePayloadControlSummary(input),/restricted_source_identity_missing/);
});
