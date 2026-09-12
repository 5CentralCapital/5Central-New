import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createRentManagerApiGetAdapter, RentManagerAdapterError } from "./adapter";
import { createRentManagerDocumentBinaryFetcher } from "./binary-fetcher";
import { createMemoryArchive, createRestrictedArchive, MemoryCheckpointStore } from "./archive";
import { assertNoCredentialShapedFields, assertReadOnlyRequest, InvalidInlineDocumentBinaryError, RentManagerExportCollector, RestrictedCredentialFieldError } from "./collector";
import { hashRecord } from "./hash";
import { normalizeRmRecord } from "./normalize";
import { createApplicationAnswerAttestation, normalizeHapStatusValue, normalizeRentManagerExport } from "./normalizer";
import { parseRentManagerExportCliArgs, redactedCliSummary } from "./cli";
import { redactIdentifier } from "./redaction";
import { createSyntheticRentManagerTransport, syntheticExportPayload } from "./fixtures";
import { RM_EXPORT_COLLECTIONS, SAFE_WEB_USER_FIELDS } from "./registry";
import type { CollectionDefinition, ExportArchive, ExportPayload, RentManagerRawRecord, RentManagerRequest, RentManagerResponse, RentManagerTransport } from "./types";
import type { RentManagerFinancialSemanticCrosswalk, RentManagerImportInput } from "../../../shared/rent-ops-contracts";

function fixtureTransport(records: Record<string, RentManagerRawRecord[]>, requests: RentManagerRequest[] = [], failures: Record<string, number[]> = {}): RentManagerTransport {
  const remaining = Object.fromEntries(Object.entries(failures).map(([key, values]) => [key, [...values]]));
  return {
    async request(request): Promise<RentManagerResponse> {
      requests.push(request);
      const queued = remaining[request.path];
      if (queued?.length) return { status: queued.shift()!, body: { error: "synthetic" } };
      const rows = request.path.includes("/SecurityDepositSummaries") ? records["/Tenants/{id}/SecurityDepositSummaries"]?.filter((row) => String(row.TenantID) === request.path.split("/")[2]) : records[request.path];
      if (!rows) return { status: 404, body: { error: "synthetic_missing" } };
      const page = Number(request.query.pagenumber ?? 1);
      const pageSize = Number(request.query.pagesize ?? 1000);
      const start = (page - 1) * pageSize;
      return { status: 200, headers: { "x-total-results": String(rows.length) }, body: { Data: rows.slice(start, start + pageSize) } };
    },
  };
}

const focusedRegistry: readonly CollectionDefinition[] = [
  { name: "properties", path: "/Properties", idFields: ["PropertyID"], entityType: "property", outputKey: "properties", required: true },
  { name: "tenants", path: "/Tenants", idFields: ["TenantID"], entityType: "person", outputKey: "tenants", required: true },
  { name: "contacts", path: "/Contacts", idFields: ["ContactID"], entityType: "contact", outputKey: "contacts", embeddedField: "PhoneNumbers", embeddedOutputKey: "phoneNumbers", embeddedEntityType: "phone", required: true },
  { name: "charges", path: "/Charges", idFields: ["ChargeID"], entityType: "ledger_transaction", sourceIdNamespace: "charge", outputKey: "charges", required: true },
  { name: "payments", path: "/Payments", idFields: ["PaymentID"], entityType: "ledger_transaction", sourceIdNamespace: "payment", embeddedField: "Allocations", embeddedOutputKey: "allocations", embeddedEntityType: "payment_allocation", outputKey: "payments", required: true },
  { name: "deposits", pathTemplate: "/Tenants/{sourceId}/SecurityDepositSummaries", parentCollection: "tenants", parentIdField: "TenantID", idFields: ["SecurityDepositSummaryID", "DepositID"], entityType: "deposit", outputKey: "deposits", kind: "per_parent", required: true },
  { name: "conversations", path: "/TextMessagingConversations", idFields: ["ConversationID", "TextMessagingConversationID"], entityType: "activity", sourceIdNamespace: "conversation", outputKey: "communications", required: true },
];

function countingArchive(): { archive: ExportArchive; counts: { pages: number; envelopes: number } } {
  const archive = createMemoryArchive();
  const counts = { pages: 0, envelopes: 0 };
  const writePage = archive.writePage.bind(archive);
  const writeEnvelope = archive.writeEnvelope.bind(archive);
  archive.writePage = async (...args) => {
    counts.pages += 1;
    return writePage(...args);
  };
  archive.writeEnvelope = async (...args) => {
    counts.envelopes += 1;
    return writeEnvelope(...args);
  };
  return { archive, counts };
}

test("collector rejects nested credential fields before writing a page or envelope", async () => {
  const registry: readonly CollectionDefinition[] = [
    { name: "properties", path: "/Properties", idFields: ["PropertyID"], entityType: "property", outputKey: "properties", required: true },
  ];
  const protectedValue = "synthetic-credential-value-that-must-not-appear";
  const logs: unknown[] = [];
  const { archive, counts } = countingArchive();
  const collector = new RentManagerExportCollector({
    transport: fixtureTransport({
      "/Properties": [{ PropertyID: 1, Nested: { Profiles: [{ accessToken: protectedValue }] } }],
    }),
    archive,
    registry,
    sleep: async () => undefined,
    logger: {
      info: (event, fields) => logs.push({ event, fields }),
      warn: (event, fields) => logs.push({ event, fields }),
    },
  });

  await assert.rejects(
    () => collector.collect(),
    (error: unknown) => error instanceof RestrictedCredentialFieldError && error.code === "credential_field_rejected" && error.message === "credential_field_rejected",
  );
  assert.deepEqual(counts, { pages: 0, envelopes: 0 });
  assert.equal(JSON.stringify(logs).includes(protectedValue), false);
  assert.equal(JSON.stringify(logs).includes("accessToken"), false);
});

test("collector rechecks resumed pages and distinguishes restricted facts from credentials", async () => {
  assert.doesNotThrow(() => assertNoCredentialShapedFields({ SSN: "synthetic", DateOfBirth: "2000-01-01", SecurityDeposit: { Amount: 500 } }));
  assert.throws(
    () => assertNoCredentialShapedFields({ rows: [{ profile: { connectionString: "synthetic" } }] }),
    (error: unknown) => error instanceof RestrictedCredentialFieldError && error.message === "credential_field_rejected",
  );

  const registry: readonly CollectionDefinition[] = [
    { name: "properties", path: "/Properties", idFields: ["PropertyID"], entityType: "property", outputKey: "properties", required: true },
  ];
  const { archive, counts } = countingArchive();
  await new RentManagerExportCollector({
    transport: fixtureTransport({ "/Properties": [{ PropertyID: 1 }] }),
    archive,
    registry,
    sleep: async () => undefined,
    runId: "credential-resume-test",
  }).collect();
  await archive.writePage("properties", 1, [{ PropertyID: 1, nested: [{ privateKey: "synthetic" }] }]);
  counts.pages = 0;
  counts.envelopes = 0;

  await assert.rejects(
    () => new RentManagerExportCollector({
      transport: fixtureTransport({ "/Properties": [] }),
      archive,
      registry,
      sleep: async () => undefined,
      runId: "credential-resume-test",
    }).collect(),
    (error: unknown) => error instanceof RestrictedCredentialFieldError && error.message === "credential_field_rejected",
  );
  assert.deepEqual(counts, { pages: 0, envelopes: 0 });
});

test("collector preserves provenance, embedded phone/allocation rows, and all-parent deposit rows", async () => {
  const requests: RentManagerRequest[] = [];
  const transport = fixtureTransport({
    "/Properties": [{ PropertyID: 1 }, { PropertyID: 2 }],
    "/Tenants": [{ TenantID: 10, Status: "Current" }, { TenantID: 20, Status: "Past" }],
    "/Contacts": [{ ContactID: 30, PhoneNumbers: [{ PhoneNumberID: 40, PhoneNumber: "synthetic" }] }],
    "/Charges": [{ ChargeID: 50, Amount: 100 }],
    "/Payments": [{ PaymentID: 60, Allocations: [{ AllocationID: 70, PaymentID: 60, ChargeID: 50, Amount: 100 }] }],
    "/Tenants/{id}/SecurityDepositSummaries": [{ SecurityDepositSummaryID: 81, TenantID: 10, AccountID: 10, Amount: 500 }, { SecurityDepositSummaryID: 82, TenantID: 20, AccountID: 20, Amount: 250 }],
    "/TextMessagingConversations": [{ ConversationID: 80, ParentID: 10, ParentType: "Tenant", ExternalPhoneNumber: "synthetic" }],
  }, requests);
  const result = await new RentManagerExportCollector({ transport, archive: createMemoryArchive(), registry: focusedRegistry, pageSize: 1, sleep: async () => undefined }).collect();
  assert.equal(result.envelope.payload.properties?.length, 2);
  assert.equal(result.envelope.payload.deposits?.length, 2);
  assert.equal(result.envelope.payload.phoneNumbers?.[0].sourceId, "phone_number:40");
  assert.equal(result.envelope.payload.allocations?.[0].sourceId, "payment_allocation:70");
  assert.equal(result.envelope.payload.allocations?.[0].paymentId, "payment:60");
  assert.equal(result.envelope.payload.allocations?.[0].chargeId, "charge:50");
  assert.equal(result.envelope.payload.deposits?.[0].sourceId, "81");
  assert.equal(result.envelope.payload.deposits?.[0].parentSourceId, "10");
  assert.equal(result.envelope.payload.deposits?.[0].tenantId, "10");
  assert.equal(result.envelope.payload.communications?.[0].sourceId, "conversation:80");
  assert.equal(result.manifest.exceptions.some((item) => item.code === "missing_source_id"), false);
  assert.ok(requests.every((request) => request.method === "GET"));
  assert.ok(requests.some((request) => request.path === "/Tenants/20/SecurityDepositSummaries"));
});

test("collector assigns composite IDs before coverage validation when RM omits deposit/conversation IDs", async () => {
  const registry: readonly CollectionDefinition[] = [
    { name: "tenants", path: "/Tenants", idFields: ["TenantID"], entityType: "person", outputKey: "tenants", required: true },
    { name: "tenantSecurityDeposits.current", pathTemplate: "/Tenants/{sourceId}/SecurityDepositSummaries", parentCollection: "tenants", parentIdField: "TenantID", idFields: ["SecurityDepositSummaryID", "DepositID"], entityType: "deposit", outputKey: "deposits", kind: "per_parent", required: true },
    { name: "textMessagingConversations", path: "/TextMessagingConversations", idFields: ["TextMessagingConversationID", "ConversationID"], entityType: "activity", sourceIdNamespace: "text_conversation", outputKey: "communications", required: true },
  ];
  const result = await new RentManagerExportCollector({
    transport: fixtureTransport({
      "/Tenants": [{ TenantID: 10 }, { TenantID: 20 }],
      "/Tenants/{id}/SecurityDepositSummaries": [
        { TenantID: 10, SecurityDepositTypeID: 1, ChargeTypeID: 2, PropertyID: 3, UnitID: 4, Amount: 500 },
        { TenantID: 20, SecurityDepositTypeID: 1, ChargeTypeID: 2, PropertyID: 3, UnitID: 5, Amount: 600 },
      ],
      "/TextMessagingConversations": [
        { ParentType: "Tenant", ParentID: 10, ExternalPhoneNumber: "(555) 010-0199", Body: "synthetic" },
      ],
    }),
    archive: createMemoryArchive(),
    registry,
    pageSize: 1,
    sleep: async () => undefined,
    runId: "composite-collector",
  }).collect();
  assert.equal(result.manifest.exceptions.some((item) => item.code === "missing_source_id"), false);
  assert.equal(result.manifest.complete, true);
  assert.equal(result.envelope.payload.deposits?.length, 2);
  assert.equal(result.envelope.payload.deposits?.every((row) => row.identityDerivedFromComposite === true), true);
  assert.equal(result.envelope.payload.communications?.[0].identityDerivedFromComposite, true);
  assert.match(String(result.envelope.payload.communications?.[0].sourceId), /^text_conversation:composite:[a-f0-9]{64}$/);
});

test("binary descriptors record verified byte size and use only an injected follow-up seam", async () => {
  const requests: RentManagerRequest[] = [];
  const fetches: string[] = [];
  const registry: readonly CollectionDefinition[] = [{ name: "documents", path: "/Documents", idFields: ["DocumentID"], entityType: "document", outputKey: "documents", documentMode: "binary_descriptor", required: true }];
  const result = await new RentManagerExportCollector({
    transport: fixtureTransport({ "/Documents": [{ DocumentID: 77, FileName: "lease.pdf", ContentType: "application/pdf" }] }, requests),
    archive: createMemoryArchive(),
    registry,
    sleep: async () => undefined,
    binaryFetcher: async ({ sourceId, record, definition }) => {
      fetches.push(`${sourceId}:${String(record.FileName)}:${definition.name}`);
      return new Uint8Array([1, 2, 3, 4]);
    },
  }).collect();
  const descriptor = result.envelope.documentBinaries[0];
  assert.deepEqual(fetches, ["77:lease.pdf:documents"]);
  assert.equal(requests.length, 1);
  assert.equal(descriptor?.binaryAvailable, true);
  assert.equal(descriptor?.descriptorOnly, false);
  assert.equal(descriptor?.sizeBytes, 4);
  assert.equal(descriptor?.availabilityReason, "archived");
  assert.match(descriptor?.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.match(descriptor?.archivePath ?? "", /^binaries\/[a-f0-9]{64}\.bin$/);
});

test("ordinary document content survives the canonical envelope unchanged", async () => {
  const registry: readonly CollectionDefinition[] = [
    { name: "documents", path: "/Documents", idFields: ["DocumentID"], entityType: "document", outputKey: "documents", documentMode: "metadata", required: true },
  ];
  const content = { text: "Synthetic application note", sections: [{ label: "One", value: 1 }] };
  const result = await new RentManagerExportCollector({
    transport: fixtureTransport({ "/Documents": [{ DocumentID: 77, content }] }),
    archive: createMemoryArchive(),
    registry,
    sleep: async () => undefined,
  }).collect();
  assert.deepEqual(result.envelope.payload.documents?.[0].content, content);
});

test("validated inline base64 moves to a verified binary with reconstruction metadata", async () => {
  const registry: readonly CollectionDefinition[] = [
    { name: "documents", path: "/Documents", idFields: ["DocumentID"], entityType: "document", outputKey: "documents", documentMode: "binary_descriptor", required: true },
  ];
  const result = await new RentManagerExportCollector({
    transport: fixtureTransport({ "/Documents": [{ DocumentID: 77, FileName: "synthetic.pdf", ContentType: "application/pdf", contentBase64: "JVBERi0x" }] }),
    archive: createMemoryArchive(),
    registry,
    sleep: async () => undefined,
  }).collect();
  assert.equal("contentBase64" in (result.envelope.payload.documents?.[0] ?? {}), false);
  assert.deepEqual(result.envelope.documentBinaries[0]?.inlineSources, [{ field: "contentBase64", encoding: "base64" }]);
  assert.equal(result.envelope.documentBinaries[0]?.sizeBytes, 6);
  assert.equal(result.envelope.documentBinaries[0]?.binaryAvailable, true);
});

test("unrecognized inline document encoding blocks without writing a page or envelope", async () => {
  const registry: readonly CollectionDefinition[] = [
    { name: "documents", path: "/Documents", idFields: ["DocumentID"], entityType: "document", outputKey: "documents", documentMode: "binary_descriptor", required: true },
  ];
  const { archive, counts } = countingArchive();
  await assert.rejects(
    () => new RentManagerExportCollector({
      transport: fixtureTransport({ "/Documents": [{ DocumentID: 77, contentBase64: "not-a-valid-inline-encoding" }] }),
      archive,
      registry,
      sleep: async () => undefined,
    }).collect(),
    (error: unknown) => error instanceof InvalidInlineDocumentBinaryError && error.message === "document_binary_encoding_rejected",
  );
  assert.deepEqual(counts, { pages: 0, envelopes: 0 });
});

test("document packets remain metadata while signable documents alone require binary evidence", async () => {
  const registry: readonly CollectionDefinition[] = [
    { name: "documentPackets", path: "/DocumentPackets", idFields: ["DocumentPacketID"], entityType: "document", sourceIdNamespace: "document_packet", outputKey: "documents", documentMode: "metadata", required: true },
    { name: "signableDocumentPackets", path: "/SignableDocumentPackets", idFields: ["SignableDocumentPacketID"], entityType: "document", sourceIdNamespace: "signable_document_packet", outputKey: "documents", documentMode: "metadata", required: true },
    { name: "signableDocuments", path: "/SignableDocuments", idFields: ["SignableDocumentID"], entityType: "document", sourceIdNamespace: "signable_document", outputKey: "documentBinaryDescriptors", documentMode: "binary_descriptor", required: true },
  ];
  const result = await new RentManagerExportCollector({
    transport: fixtureTransport({
      "/DocumentPackets": [{ DocumentPacketID: 1, CurrentFileID: 101 }],
      "/SignableDocumentPackets": [{ SignableDocumentPacketID: 2, OriginalFileID: 102 }],
      "/SignableDocuments": [{ SignableDocumentID: 3, CurrentFileID: 103, OriginalFileID: 104, FileName: "lease.pdf" }],
    }),
    archive: createMemoryArchive(),
    registry,
    sleep: async () => undefined,
    binaryFetcher: async () => new Uint8Array([1, 2, 3]),
    runId: "document-semantics",
  }).collect();
  assert.equal(result.manifest.complete, true);
  assert.equal(result.envelope.payload.documents?.length, 2);
  assert.equal(result.envelope.payload.documentBinaryDescriptors?.length, 1);
  assert.equal(result.envelope.documentBinaries.length, 1);
  assert.equal(result.envelope.documentBinaries[0]?.sizeBytes, 3);
  assert.equal(result.manifest.documentBinarySummary.metadataCount, 3);
  assert.equal(result.manifest.documentBinarySummary.fileDescriptorCount, 1);
  assert.equal(result.manifest.documentBinarySummary.packetMetadataCount, 2);
  assert.equal(result.manifest.documentBinarySummary.descriptorOnlyCount, 0);
  assert.equal(result.manifest.exceptions.some((item) => item.code === "binary_unavailable"), false);
});

test("resume removes stale history/packet identity gates and keeps the strict file summary", async () => {
  const archive = createMemoryArchive();
  const registry: readonly CollectionDefinition[] = [
    { name: "tenants", path: "/Tenants", idFields: ["TenantID"], entityType: "person", outputKey: "tenants", required: true },
    { name: "tenantHistory.current", pathTemplate: "/Tenants/{sourceId}/History", parentCollection: "tenants", parentIdField: "TenantID", idFields: ["HistoryID"], entityType: "activity", sourceIdNamespace: "history", outputKey: "histories", kind: "per_parent", required: true },
    { name: "documentPackets", path: "/DocumentPackets", idFields: ["DocumentPacketID"], entityType: "document", sourceIdNamespace: "document_packet", outputKey: "documents", documentMode: "metadata", required: true },
    { name: "signableDocumentPackets", path: "/SignableDocumentPackets", idFields: ["SignableDocumentPacketID"], entityType: "document", sourceIdNamespace: "signable_document_packet", outputKey: "documents", documentMode: "metadata", required: true },
    { name: "signableDocuments", path: "/SignableDocuments", idFields: ["SignableDocumentID"], entityType: "document", sourceIdNamespace: "signable_document", outputKey: "documentBinaryDescriptors", documentMode: "binary_descriptor", required: true },
  ];
  const first = await new RentManagerExportCollector({
    transport: fixtureTransport({
      "/Tenants": [{ TenantID: 10 }],
      "/Tenants/10/History": [{ HistoryID: 9, CreateDate: "2025-01-01", ParentType: "Tenant", ParentID: 10 }],
      "/DocumentPackets": [{ DocumentPacketID: 1 }],
      "/SignableDocumentPackets": [{ SignableDocumentPacketID: 2 }],
      "/SignableDocuments": [{ SignableDocumentID: 3, FileName: "lease.pdf" }],
    }),
    archive,
    registry,
    sleep: async () => undefined,
    runId: "resume-cleanup",
  }).collect();
  assert.equal(first.manifest.documentBinarySummary.metadataCount, 3);
  const checkpoint = await archive.readCheckpoint();
  assert.ok(checkpoint);
  checkpoint!.collections["tenantHistory.current"]!.exceptions.push({ code: "duplicate_source_id", collection: "tenantHistory.current", detail: "legacy_history_duplicate" });
  checkpoint!.collections.documentPackets!.exceptions.push({ code: "binary_unavailable", collection: "documentPackets", detail: "legacy_packet_gate" });
  checkpoint!.collections.signableDocumentPackets!.exceptions.push({ code: "binary_unavailable", collection: "signableDocumentPackets", detail: "legacy_packet_gate" });
  checkpoint!.documentBinaries = [
    ...(checkpoint!.documentBinaries ?? []),
    { sourceId: "document_packet:1", metadataAvailable: true, binaryAvailable: false, descriptorOnly: true, availabilityReason: "binary_not_exposed" },
    { sourceId: "signable_document_packet:2", metadataAvailable: true, binaryAvailable: false, descriptorOnly: true, availabilityReason: "binary_not_exposed" },
  ];
  await archive.writeCheckpoint(checkpoint!);
  const second = await new RentManagerExportCollector({
    transport: async () => { throw new Error("completed collection must not refetch on resume"); },
    archive,
    registry,
    sleep: async () => undefined,
    runId: "resume-cleanup",
  }).collect();
  assert.equal(second.manifest.exceptions.some((item) => item.code === "duplicate_source_id"), false);
  assert.equal(second.manifest.exceptions.filter((item) => item.code === "binary_unavailable").length, 1);
  assert.equal(second.envelope.documentBinaries.length, 1);
  assert.equal(second.manifest.documentBinarySummary.metadataCount, 3);
  assert.equal(second.manifest.documentBinarySummary.fileDescriptorCount, 1);
  assert.equal(second.manifest.documentBinarySummary.packetMetadataCount, 2);
  assert.equal(second.manifest.documentBinarySummary.descriptorOnlyCount, 1);
});

test("collector resumes from a page checkpoint after a transient collection failure", async () => {
  const archive = createMemoryArchive();
  const registry: readonly CollectionDefinition[] = [{ name: "properties", path: "/Properties", idFields: ["PropertyID"], entityType: "property", outputKey: "properties", required: true }];
  const first = fixtureTransport({ "/Properties": [{ PropertyID: 1 }, { PropertyID: 2 }] }, [], { "/Properties": [] });
  const firstResult = await new RentManagerExportCollector({ transport: first, archive, registry, pageSize: 1, maxPages: 1, sleep: async () => undefined, runId: "resume-test" }).collect();
  assert.equal(firstResult.checkpoint.complete, false);
  const second = fixtureTransport({ "/Properties": [{ PropertyID: 1 }, { PropertyID: 2 }] });
  const secondResult = await new RentManagerExportCollector({ transport: second, archive, registry, pageSize: 1, sleep: async () => undefined, runId: "resume-test" }).collect();
  assert.equal(secondResult.envelope.payload.properties?.length, 2);
  assert.equal(secondResult.checkpoint.complete, true);
});

test("resume revalidates an old missing-source gate after composite IDs are archived", async () => {
  const archive = createMemoryArchive();
  const registry: readonly CollectionDefinition[] = [
    { name: "tenants", path: "/Tenants", idFields: ["TenantID"], entityType: "person", outputKey: "tenants", required: true },
    { name: "tenantSecurityDeposits.current", pathTemplate: "/Tenants/{sourceId}/SecurityDepositSummaries", parentCollection: "tenants", parentIdField: "TenantID", idFields: ["SecurityDepositSummaryID", "DepositID"], entityType: "deposit", outputKey: "deposits", kind: "per_parent", required: true },
  ];
  const first = await new RentManagerExportCollector({
    transport: fixtureTransport({
      "/Tenants": [{ TenantID: 10 }],
      "/Tenants/{id}/SecurityDepositSummaries": [{ TenantID: 10, SecurityDepositTypeID: 1, ChargeTypeID: 2, PropertyID: 3, UnitID: 4 }],
    }),
    archive,
    registry,
    sleep: async () => undefined,
    runId: "resume-composite",
  }).collect();
  assert.equal(first.manifest.complete, true);
  const checkpoint = await archive.readCheckpoint();
  assert.ok(checkpoint);
  checkpoint!.collections["tenantSecurityDeposits.current"]!.exceptions.push({ code: "missing_source_id", collection: "tenantSecurityDeposits.current", detail: "legacy_checkpoint_gate" });
  await archive.writeCheckpoint(checkpoint!);
  const second = await new RentManagerExportCollector({
    transport: async () => { throw new Error("completed collection must not refetch on resume"); },
    archive,
    registry,
    sleep: async () => undefined,
    runId: "resume-composite",
  }).collect();
  assert.equal(second.manifest.complete, true);
  assert.equal(second.manifest.exceptions.some((item) => item.code === "missing_source_id"), false);
});

test("read-only boundary and adapter expose only GET with redacted transport shape", async () => {
  assert.throws(() => assertReadOnlyRequest({ method: "POST", path: "/Properties", query: {} }), /only permits GET/);
  assert.throws(() => assertReadOnlyRequest({ method: "GET", path: "/../secret", query: {} }), /only permits GET/);
  const seen: RentManagerRequest[] = [];
  const transport = createRentManagerApiGetAdapter(async (path, query) => {
    seen.push({ method: "GET", path, query: query as Record<string, string> });
    return { data: [{ PropertyID: 1 }], totalResults: 1 };
  });
  const response = await (transport as { request(request: RentManagerRequest): Promise<RentManagerResponse> }).request({ method: "GET", path: "/Properties", query: { pagesize: 1000, empty: undefined } });
  assert.equal(response.status, 200);
  assert.equal(response.headers?.["x-total-results"], "1");
  assert.deepEqual(seen[0].query, { pagesize: 1000 });
  await assert.rejects(() => (transport as { request(request: RentManagerRequest): Promise<RentManagerResponse> }).request({ method: "POST", path: "/Properties", query: {} }), RentManagerAdapterError);
});

test("adapter preserves canonical no-content responses and collector accepts only that empty shape", async () => {
  const transport = createRentManagerApiGetAdapter(async () => ({ data: null, totalResults: null }));
  const response = await (transport as { request(request: RentManagerRequest): Promise<RentManagerResponse> }).request({ method: "GET", path: "/Subsidies", query: {} });
  assert.equal(response.status, 204);
  const registry: CollectionDefinition[] = [{ name: "subsidies", path: "/Subsidies", idFields: ["SubsidyID"], entityType: "subsidy", outputKey: "subsidies", required: true }];
  const result = await new RentManagerExportCollector({ transport, archive: createMemoryArchive(), registry, sleep: async () => undefined, runId: "no-content-test" }).collect();
  assert.equal(result.manifest.complete, true);
  assert.equal(result.manifest.counts.subsidies, 0);
  assert.equal(result.manifest.collections[0]?.status, "empty");
});

test("production document binary fetcher uses verified detail/file seams without RM credentials", async () => {
  const detailRequests: RentManagerRequest[] = [];
  const fileRequests: Array<{ url: string; init?: RequestInit }> = [];
  const sleeps: number[] = [];
  let detailAttempts = 0;
  const transport: RentManagerTransport = {
    async request(request) {
      detailRequests.push(request);
      detailAttempts += 1;
      if (detailAttempts === 1) return { status: 429, headers: { "retry-after": "0" }, body: null };
      return {
        status: 200,
        body: { CurrentFile: { ContentType: "application/pdf", DownloadURL: "https://rm12filereader.rentmanager.com/file/opaque?EID=synthetic-eid&FKey=synthetic-key" } },
      };
    },
  };
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    fileRequests.push({ url, init });
    return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), { status: 200, headers: { "content-type": "application/pdf", "content-length": "6" } });
  };
  const fetcher = createRentManagerDocumentBinaryFetcher({ transport, fetchImpl, sleep: async (milliseconds) => { sleeps.push(milliseconds); }, now: () => 0, timeoutMs: 100, maxRetries: 2 });
  const bytes = await fetcher({ sourceId: "signable_document:77", record: { entityType: "document", sourceId: "signable_document:77", SignableDocumentID: 77 }, definition: { name: "signableDocuments", path: "/SignableDocuments", idFields: ["SignableDocumentID"], entityType: "document", sourceIdNamespace: "signable_document", outputKey: "documentBinaryDescriptors", documentMode: "binary_descriptor" } });
  assert.deepEqual(Array.from(bytes ?? []), [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
  assert.equal(detailRequests.length, 2);
  assert.equal(detailRequests[0]?.method, "GET");
  assert.equal(detailRequests[0]?.path, "/SignableDocuments/77");
  assert.deepEqual(detailRequests[0]?.query, { embeds: "CurrentFile" });
  assert.equal(detailRequests[0]?.headers, undefined);
  assert.equal(fileRequests.length, 1);
  assert.equal(fileRequests[0]?.init?.method, "GET");
  assert.equal(fileRequests[0]?.init?.redirect, "error");
  assert.equal(fileRequests[0]?.init?.headers, undefined);
  assert.ok(sleeps.some((milliseconds) => milliseconds >= 250));
});

test("production document binary fetcher enforces the signed reader boundary and payload integrity", async () => {
  const definition: CollectionDefinition = { name: "signableDocuments", path: "/SignableDocuments", idFields: ["SignableDocumentID"], entityType: "document", sourceIdNamespace: "signable_document", outputKey: "documentBinaryDescriptors", documentMode: "binary_descriptor" };
  const input = { sourceId: "signable_document:77", record: { entityType: "document", sourceId: "signable_document:77", SignableDocumentID: 77 }, definition };
  const responseTransport = (downloadUrl: string): RentManagerTransport => ({ request: async () => ({ status: 200, body: { CurrentFile: { ContentType: "application/pdf", DownloadURL: downloadUrl } } }) });
  await assert.rejects(() => createRentManagerDocumentBinaryFetcher({ transport: responseTransport("http://rm12filereader.rentmanager.com/file?EID=e&FKey=k"), fetchImpl: async () => new Response(), timeoutMs: 100 })(input), /binary_download_url_not_allowlisted/);
  await assert.rejects(() => createRentManagerDocumentBinaryFetcher({ transport: responseTransport("https://evil.example.test/file?EID=e&FKey=k"), fetchImpl: async () => new Response(), timeoutMs: 100 })(input), /binary_download_url_not_allowlisted/);
  await assert.rejects(() => createRentManagerDocumentBinaryFetcher({ transport: responseTransport("https://rm12filereader.rentmanager.com/file?EID=e&FKey=k&token=extra"), fetchImpl: async () => new Response(), timeoutMs: 100 })(input), /binary_download_url_query_invalid/);
  await assert.rejects(() => createRentManagerDocumentBinaryFetcher({ transport: responseTransport("https://rm12filereader.rentmanager.com/file?EID=e&FKey=k"), fetchImpl: async () => new Response("not a pdf", { status: 200, headers: { "content-type": "application/pdf" } }), timeoutMs: 100, maxRetries: 0 })(input), /binary_malformed/);
  await assert.rejects(() => createRentManagerDocumentBinaryFetcher({ transport: responseTransport("https://rm12filereader.rentmanager.com/file?EID=e&FKey=k"), fetchImpl: async () => new Response(new Uint8Array([0x25, 0x50]), { status: 200, headers: { "content-type": "application/pdf", "content-length": "999" } }), timeoutMs: 100, maxBytes: 10, maxRetries: 0 })(input), /binary_too_large/);
  await assert.rejects(() => createRentManagerDocumentBinaryFetcher({ transport: responseTransport("https://rm12filereader.rentmanager.com/file?EID=e&FKey=k"), fetchImpl: async () => ({ status: 200, headers: new Headers({ "content-type": "application/pdf" }), url: "https://evil.example.test/file", redirected: true, arrayBuffer: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]).buffer }), timeoutMs: 100, maxRetries: 0 })(input), /binary_redirect_rejected/);
});

test("restricted archive uses private directory/file modes and rejects unsafe page paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "rm-export-test-"));
  try {
    const archive = await createRestrictedArchive(root);
    await archive.writePage("properties", 1, [{ entityType: "property", sourceId: "1" }]);
    const rootStats = await stat(root);
    const pageStats = await stat(join(root, "pages", "properties-1.json"));
    assert.equal(rootStats.mode & 0o777, 0o700);
    assert.equal(pageStats.mode & 0o777, 0o600);
    await assert.rejects(() => archive.writePage("../escape", 1, []));
    const manifest = await readFile(join(root, "manifest.json")).catch(() => undefined);
    assert.equal(manifest, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizer resolves embedded facts, tenant contacts, namespaced allocations, and credits", () => {
  const payload: ExportPayload = {
    properties: [{ entityType: "property", sourceId: "p1", PropertyID: "p1", PropertyName: "Synthetic", Addresses: [{ Address: "1 Test Way", City: "Testville", State: "FL", PostalCode: "00001" }] }],
    units: [{ entityType: "unit", sourceId: "u1", UnitID: "u1", PropertyID: "p1", Bathrooms: 1.5, SquareFootage: 725, UnitType: { UnitTypeID: "ut1", Name: "One" }, MarketRent: [{ MarketRentID: "old", Amount: 900, FromDate: "2024-01-01" }, { MarketRentID: "current", Amount: 1000, FromDate: "2025-01-01" }] }],
    tenants: [{ entityType: "person", sourceId: "t1", TenantID: "t1", Status: "Current" }],
    contacts: [
      { entityType: "contact", sourceId: "primary", ContactID: "primary", TenantID: "t1", IsPrimary: true, ContactType: "Resident" },
      { entityType: "contact", sourceId: "secondary", ContactID: "secondary", ParentID: "t1", ParentType: "Tenant", IsPrimary: false, ContactType: "Other Occupant" },
      { entityType: "contact", sourceId: "vendor", ContactID: "vendor", ParentID: "v1", ParentType: "Vendor" },
    ],
    phoneNumbers: [{ entityType: "phone", sourceId: "secondary-phone", PhoneNumberID: "secondary-phone", ContactID: "secondary", PhoneNumber: "555-0199", IsPrimary: true }],
    leases: [{ entityType: "tenancy", sourceId: "l1", LeaseID: "l1", TenantID: "t1", PropertyID: "p1", UnitID: "u1", MoveInDate: "2025-01-01", DepartureDate: "2025-12-31" }],
    payments: [{ entityType: "ledger_transaction", sourceId: "60", PaymentID: "60", AccountID: "t1", Amount: 100, TransactionDate: "2025-02-01", Allocations: [{ AllocationID: "a1", PaymentID: "60", ChargeID: "50", Amount: 100, TransactionDate: "2025-02-01" }] }],
    charges: [{ entityType: "ledger_transaction", sourceId: "50", ChargeID: "50", AccountID: "t1", Amount: 100, TransactionDate: "2025-01-01" }],
    credits: [{ entityType: "ledger_transaction", sourceId: "c1", CreditID: "c1", AccountID: "t1", Amount: 10, TransactionDate: "2025-02-02" }],
    chargeTypeRecords: [{ entityType: "charge_type", sourceId: "ct1", ChargeTypeID: "ct1", Name: "Rent" }],
  };
  const normalized = normalizeRentManagerExport(payload);
  assert.equal((normalized.input.properties?.[0] as Record<string, unknown>).addressLine1, "1 Test Way");
  assert.equal((normalized.input.properties?.[0] as Record<string, unknown>).city, "Testville");
  assert.equal((normalized.input.units?.[0] as Record<string, unknown>).marketRent, 1000);
  assert.equal((normalized.input.units?.[0] as Record<string, unknown>).bathrooms, 1.5);
  assert.equal((normalized.input.units?.[0] as Record<string, unknown>).squareFeet, 725);
  assert.equal((normalized.input.leases?.[0] as Record<string, unknown>).status, undefined);
  assert.equal((normalized.input.leases?.[0] as Record<string, unknown>).expectedMoveOutOn, "2025-12-31");
  assert.equal((normalized.input.leases?.[0] as Record<string, unknown>).actualMoveOutOn, undefined);
  assert.equal(normalized.input.contacts?.length, 2);
  assert.deepEqual(normalized.input.contacts?.map((row) => row.ContactID), ["primary", "secondary"]);
  assert.equal(normalized.input.contacts?.[1].phone, "555-0199");
  assert.equal(normalized.input.allocations?.length, 1);
  assert.equal(normalized.input.allocations?.[0].sourceId, "payment_allocation:a1");
  assert.equal(normalized.input.allocations?.[0].paymentId, "payment:60");
  assert.equal(normalized.input.allocations?.[0].chargeId, "charge:50");
  assert.equal(normalized.input.credits?.length, 1);
  assert.equal(normalized.exceptions.some((item) => item.collection === "credits" && item.code === "incomplete_coverage"), false);
});

test("charge type categories require exact ChargeTypeID crosswalks and ignore rent-like prose", () => {
  const artifactSha256 = "a".repeat(64);
  const financialSemanticCrosswalk: RentManagerFinancialSemanticCrosswalk = {
    artifactSha256,
    normalization: "trim_lower_unicode_v1",
    entries: [
      { artifactSha256, sourceCollection: "chargeTypes", sourceField: "ChargeTypeID", semanticKind: "charge_category", normalization: "trim_lower_unicode_v1", normalizedValue: "rent-type", targetValue: "base_rent" },
      { artifactSha256, sourceCollection: "chargeTypes", sourceField: "IsActive", semanticKind: "charge_definition_active", normalization: "trim_lower_unicode_v1", normalizedValue: "false", targetValue: "false" },
    ],
  };
  const normalized = normalizeRentManagerExport({
    artifactSha256,
    financialSemanticCrosswalk,
    chargeTypeRecords: [
      { entityType: "charge_type", sourceId: "rent-type", ChargeTypeID: "rent-type", Name: "CODE-001", Description: "Monthly Rent", IsActive: false },
      { entityType: "charge_type", sourceId: "prose-only-type", ChargeTypeID: "prose-only-type", Name: "CODE-002", Description: "Monthly Rent" },
    ],
  });
  assert.equal(normalized.input.chargeTypes?.find((row) => row.sourceId === "rent-type")?.name, "CODE-001");
  assert.equal(normalized.input.chargeTypes?.find((row) => row.sourceId === "rent-type")?.category, "base_rent");
  assert.equal(normalized.input.chargeTypes?.find((row) => row.sourceId === "rent-type")?.active, false);
  assert.equal(normalized.input.chargeTypes?.find((row) => row.sourceId === "prose-only-type")?.category, null);
  assert.equal(normalized.input.chargeTypes?.find((row) => row.sourceId === "prose-only-type")?.categoryKnowledge, "unknown");
});

test("normalizer rejects zero/multiple/stale financial crosswalk claims without selecting the first object", () => {
  const artifactSha256 = "a".repeat(64);
  const valid: RentManagerFinancialSemanticCrosswalk = {
    artifactSha256,
    normalization: "trim_lower_unicode_v1",
    entries: [{ artifactSha256, sourceCollection: "recurringSchedules", sourceField: "EntityType", semanticKind: "recurring_scope", normalization: "trim_lower_unicode_v1", normalizedValue: "tenant", targetValue: "tenant" }],
  };
  const multiple = normalizeRentManagerExport({ artifactSha256, financialSemanticCrosswalk: [valid, valid], recurringSchedules: [{ RecurringChargeID: "r1", EntityKeyID: "t1", EntityType: "Tenant", Amount: 100 }] });
  assert.ok(multiple.exceptions.some((exception) => exception.detail.includes("crosswalk_exactly_one")));
  assert.ok(Array.isArray(multiple.input.financialSemanticCrosswalk));
  const stale = { ...valid, artifactSha256: "b".repeat(64), entries: valid.entries.map((entry) => ({ ...entry, artifactSha256: "b".repeat(64) })) };
  const staleResult = normalizeRentManagerExport({ artifactSha256, financialSemanticCrosswalk: [stale], recurringSchedules: [] });
  assert.ok(staleResult.exceptions.some((exception) => exception.detail.includes("artifact_not_approved")));
  const empty = normalizeRentManagerExport({ artifactSha256, financialSemanticCrosswalk: [], recurringSchedules: [] });
  assert.ok(empty.exceptions.some((exception) => exception.detail.includes("crosswalk_exactly_one")));
});

test("artifact lease move-in dates use exact tenant partitions, not status prose", () => {
  const artifactSha256 = "a".repeat(64);
  const financialSemanticCrosswalk: RentManagerFinancialSemanticCrosswalk = {
    artifactSha256,
    normalization: "trim_lower_unicode_v1",
    entries: [
      { artifactSha256, sourceCollection: "tenants.future", sourceField: "$partition", semanticKind: "tenancy_status", normalization: "trim_lower_unicode_v1", normalizedValue: "future", targetValue: "future" },
      { artifactSha256, sourceCollection: "tenants.current", sourceField: "$partition", semanticKind: "tenancy_status", normalization: "trim_lower_unicode_v1", normalizedValue: "current", targetValue: "current" },
    ],
  };
  const source = {
    artifactSha256,
    financialSemanticCrosswalk,
    properties: [{ PropertyID: "p1" }],
    units: [{ UnitID: "u1", PropertyID: "p1" }],
  };
  const unresolved = normalizeRentManagerExport({
    ...source,
    tenants: [{ TenantID: "t-unknown", Status: "inactive" }],
    leases: [{ LeaseID: "l-unknown", TenantID: "t-unknown", PropertyID: "p1", UnitID: "u1", Status: "inactive", MoveInDate: "2026-09-01" }],
  });
  const unresolvedLease = unresolved.input.leases?.[0] as Record<string, unknown>;
  assert.equal(unresolvedLease.actualMoveInOn, undefined);
  assert.equal(unresolvedLease.plannedMoveInOn, undefined);
  assert.ok(unresolved.exceptions.some((item) => item.detail === "move_in_date_status_not_explicit"));

  const explicit = normalizeRentManagerExport({
    ...source,
    tenants: [{ TenantID: "t-explicit", Status: "inactive" }],
    leases: [{ LeaseID: "l-explicit", TenantID: "t-explicit", PropertyID: "p1", UnitID: "u1", Status: "inactive", MoveInDate: "2026-09-01", ActualMoveInOn: "2026-08-01" }],
  });
  const explicitLease = explicit.input.leases?.[0] as Record<string, unknown>;
  assert.equal(explicitLease.actualMoveInOn, "2026-08-01");
  assert.equal(explicitLease.plannedMoveInOn, undefined);

  const future = normalizeRentManagerExport({
    ...source,
    tenants: [{ TenantID: "t-future", sourceCollection: "tenants.future", Status: "inactive" }],
    leases: [{ LeaseID: "l-future", TenantID: "t-future", PropertyID: "p1", UnitID: "u1", Status: "inactive", MoveInDate: "2026-10-01" }],
  });
  const futureLease = future.input.leases?.[0] as Record<string, unknown>;
  assert.equal(futureLease.plannedMoveInOn, "2026-10-01");
  assert.equal(futureLease.actualMoveInOn, undefined);
  assert.equal(future.exceptions.some((item) => item.detail === "move_in_date_status_not_explicit"), false);

  const current = normalizeRentManagerExport({
    ...source,
    tenants: [{ TenantID: "t-current", sourceCollection: "tenants.current", Status: "inactive" }],
    leases: [{ LeaseID: "l-current", TenantID: "t-current", PropertyID: "p1", UnitID: "u1", Status: "inactive", MoveInDate: "2026-01-01" }],
  });
  const currentLease = current.input.leases?.[0] as Record<string, unknown>;
  assert.equal(currentLease.actualMoveInOn, "2026-01-01");
  assert.equal(currentLease.plannedMoveInOn, undefined);
  assert.equal(current.exceptions.some((item) => item.detail === "move_in_date_status_not_explicit"), false);
});

test("HAP status crosswalk selection is exact-one and domain-bound regardless of row order", () => {
  const artifactSha256 = "a".repeat(64);
  const first = { artifactSha256, sourceCollection: "Subsidies" as const, sourceField: "Status", values: { active: "active" as const } };
  const conflicting = { ...first, values: { active: "ended" as const } };
  assert.deepEqual(normalizeHapStatusValue("Active", "contract", [first], artifactSha256, "Subsidies", "Status"), { value: "active", knowledge: "source" });
  assert.deepEqual(normalizeHapStatusValue("Active", "contract", [first, conflicting], artifactSha256, "Subsidies", "Status"), { knowledge: "unknown" });
  assert.deepEqual(normalizeHapStatusValue("Active", "contract", [conflicting, first], artifactSha256, "Subsidies", "Status"), { knowledge: "unknown" });
  const wrongDomain = { ...first, values: { active: "received" as const } };
  assert.deepEqual(normalizeHapStatusValue("Active", "contract", [wrongDomain], artifactSha256, "Subsidies", "Status"), { knowledge: "unknown" });
});

test("history identity is scoped by parent tenant and only same-parent duplicates are removed", async () => {
  const registry: readonly CollectionDefinition[] = [
    { name: "tenants.current", path: "/Tenants", query: { filters: "Status,eq,Current" }, idFields: ["TenantID"], entityType: "person", outputKey: "tenants", required: true },
    { name: "tenants.former", path: "/Tenants", query: { filters: "Status,eq,Past" }, idFields: ["TenantID"], entityType: "person", outputKey: "tenants", required: true },
    { name: "tenantHistory.current", pathTemplate: "/Tenants/{sourceId}/History", parentCollection: "tenants.current", parentIdField: "TenantID", idFields: ["HistoryID"], entityType: "activity", sourceIdNamespace: "history", outputKey: "histories", kind: "per_parent", required: true },
    { name: "tenantHistory.former", pathTemplate: "/Tenants/{sourceId}/History", parentCollection: "tenants.former", parentIdField: "TenantID", idFields: ["HistoryID"], entityType: "activity", sourceIdNamespace: "history", outputKey: "histories", kind: "per_parent", required: true },
  ];
  const transport: RentManagerTransport = {
    async request(request) {
      if (request.path === "/Tenants") {
        const current = String(request.query.filters ?? "").includes("Current");
        const rows = current ? [{ TenantID: 101, Status: "Current" }] : [{ TenantID: 202, Status: "Past" }];
        return { status: 200, headers: { "x-total-results": String(rows.length) }, body: { Data: rows } };
      }
      const tenantId = request.path.split("/")[2];
      const rows = tenantId === "101"
        ? [{ HistoryID: 9, CreateDate: "2025-01-01", TenantID: 101, ParentID: 101, ParentType: "Tenant", Subject: "same-parent-first" }, { HistoryID: 9, CreateDate: "2025-01-01", TenantID: 101, ParentID: 101, ParentType: "Tenant", Subject: "same-parent-duplicate" }, { HistoryID: 9, CreateDate: "2025-02-01", TenantID: 101, ParentID: 101, ParentType: "Tenant", Subject: "same-history-variant" }]
        : [{ HistoryID: 9, CreateDate: "2025-01-01", TenantID: 202, ParentID: 202, ParentType: "Tenant", Subject: "different-parent-valid" }];
      return { status: 200, headers: { "x-total-results": String(rows.length) }, body: { Data: rows } };
    },
  };
  const result = await new RentManagerExportCollector({ transport, archive: createMemoryArchive(), registry, sleep: async () => undefined, runId: "history-scope" }).collect();
  assert.equal(result.envelope.payload.histories?.length, 3);
  assert.deepEqual(result.envelope.payload.histories?.map((row) => row.sourceId).sort(), ["history:101:9:2025-01-01", "history:101:9:2025-02-01", "history:202:9:2025-01-01"]);
  assert.deepEqual((result.envelope.payload.histories?.[0] as Record<string, unknown>).historyIdentityFields, ["parentSourceId", "HistoryID", "CreateDate"]);
  assert.equal((result.envelope.payload.histories?.[0] as Record<string, unknown>).historyIdentitySource, "tenant_history_request_parent_history_id_date");
  assert.ok(result.manifest.exceptions.some((item) => item.code === "duplicate_source_id"));
  const normalized = normalizeRentManagerExport(result.envelope.payload);
  assert.equal(normalized.input.activities?.length, 3);
});

test("empty RM phone slots retain a stable parent and phone-type compound identity", () => {
  const definition: CollectionDefinition = { name: "contactPhoneNumbers", outputKey: "phoneNumbers", entityType: "phone", idFields: ["PhoneNumberID"], kind: "per_parent" };
  const first = normalizeRmRecord(definition, { entityType: "phone", sourceId: "", PhoneNumberTypeID: 6 }, { parentSourceId: "301" });
  const second = normalizeRmRecord(definition, { entityType: "phone", sourceId: "", PhoneNumberTypeID: 6 }, { parentSourceId: "301" });
  assert.equal(first.sourceId, "phone_slot:301:6");
  assert.equal(second.sourceId, first.sourceId);
});

test("deposit and conversation composite identities are deterministic, collision-safe, and PII-redacted", () => {
  const depositDefinition: CollectionDefinition = { name: "tenantSecurityDeposits.current", outputKey: "deposits", entityType: "deposit", idFields: ["SecurityDepositSummaryID", "DepositID"], kind: "per_parent" };
  const deposit = { entityType: "deposit", sourceId: "", AccountID: "tenant-parent", SecurityDepositTypeID: 11, ChargeTypeID: 22, PropertyID: 33, UnitID: 44 } as unknown as RentManagerRawRecord;
  const firstDeposit = normalizeRmRecord(depositDefinition, deposit, { parentSourceId: "tenant-parent" }) as Record<string, unknown>;
  const secondDeposit = normalizeRmRecord(depositDefinition, deposit, { parentSourceId: "tenant-parent" }) as Record<string, unknown>;
  const changedDeposit = normalizeRmRecord(depositDefinition, { ...deposit, UnitID: 45 }, { parentSourceId: "tenant-parent" }) as Record<string, unknown>;
  const missingUnitDeposit = normalizeRmRecord(depositDefinition, { ...deposit, UnitID: undefined }, { parentSourceId: "tenant-parent" }) as Record<string, unknown>;
  assert.equal(firstDeposit.sourceId, secondDeposit.sourceId);
  assert.notEqual(firstDeposit.sourceId, changedDeposit.sourceId);
  assert.notEqual(firstDeposit.sourceId, missingUnitDeposit.sourceId);
  assert.match(String(missingUnitDeposit.sourceId), /^deposit:composite:[a-f0-9]{64}$/);
  assert.equal(missingUnitDeposit.identityDerivedFromComposite, true);
  assert.match(String(firstDeposit.sourceId), /^deposit:composite:[a-f0-9]{64}$/);
  assert.equal(firstDeposit.identityDerivedFromComposite, true);
  assert.deepEqual(firstDeposit.identityDerivedFromCompositeFields, ["parentSourceId", "SecurityDepositTypeID", "ChargeTypeID", "PropertyID", "AccountID", "UnitID"]);

  const conversationDefinition: CollectionDefinition = { name: "textMessagingConversations", path: "/TextMessagingConversations", outputKey: "communications", entityType: "activity", sourceIdNamespace: "text_conversation", idFields: ["ConversationID"] };
  const conversation = { entityType: "activity", sourceId: "", ParentType: "Tenant", ParentID: 77, ExternalPhoneNumber: "(555) 010-0199" } as unknown as RentManagerRawRecord;
  const firstConversation = normalizeRmRecord(conversationDefinition, conversation) as Record<string, unknown>;
  const secondConversation = normalizeRmRecord(conversationDefinition, { ...conversation, ExternalPhoneNumber: "5550100199" }) as Record<string, unknown>;
  const parentOnly = normalizeRmRecord(conversationDefinition, { entityType: "activity", sourceId: "", ParentType: "Tenant", ParentID: 78 } as unknown as RentManagerRawRecord) as Record<string, unknown>;
  assert.equal(firstConversation.sourceId, secondConversation.sourceId);
  assert.notEqual(firstConversation.sourceId, parentOnly.sourceId);
  assert.match(String(firstConversation.sourceId), /^text_conversation:composite:[a-f0-9]{64}$/);
  assert.equal(firstConversation.identityPhoneComponentHashed, true);
  assert.equal(String(firstConversation.sourceId).includes("555"), false);
  assert.equal(String(firstConversation.sourceId).includes("0199"), false);
  assert.equal(parentOnly.identityDerivedFromComposite, true);
});

test("deposit composite identity uses the complete source tuple, a missing-unit sentinel, and order-independent uniqueness", () => {
  const rows = [
    { ParentID: 100, AccountID: 100, SecurityDepositTypeID: 1, ChargeTypeID: 2, PropertyID: 3, Amount: 500 },
    { ParentID: 200, AccountID: 200, SecurityDepositTypeID: 1, ChargeTypeID: 2, PropertyID: 3, UnitID: 9, Amount: 600 },
  ];
  const normalize = (deposits: typeof rows) => normalizeRentManagerExport({ deposits }).input.deposits ?? [];
  const first = normalize(rows);
  const permuted = normalize([...rows].reverse());
  assert.deepEqual(first.map((row) => row.sourceId).sort(), permuted.map((row) => row.sourceId).sort());
  const missingUnit = first.find((row) => (row as Record<string, unknown>).ParentID === 100) as Record<string, unknown>;
  assert.match(String(missingUnit.sourceId), /^deposit:composite:100\|1\|2\|3\|100\|__NO_UNIT__$/);
  assert.equal(missingUnit.unitId, undefined);
  assert.equal(missingUnit.unitLinkKnowledge, "unknown");
  assert.equal(missingUnit.depositCompositeIdentity, "deposit:composite:100|1|2|3|100|__NO_UNIT__");

  const collision = normalize([rows[0], { ...rows[0] }]);
  assert.equal(collision.every((row) => row.sourceId === undefined), true);
  const collisionResult = normalizeRentManagerExport({ deposits: [rows[0], { ...rows[0] }] });
  assert.equal(collisionResult.exceptions.filter((item) => item.code === "duplicate_source_id").length, 2);
});

test("the 108-row deposit shape remains exact-once with seven explicit unknown unit links", () => {
  const rows = Array.from({ length: 108 }, (_, index) => ({
    ParentID: 1000 + index,
    AccountID: 1000 + index,
    SecurityDepositTypeID: (index % 3) + 1,
    ChargeTypeID: (index % 5) + 1,
    PropertyID: (index % 7) + 1,
    ...(index >= 7 ? { UnitID: 2000 + index } : {}),
    Amount: 500 + index,
  }));
  const first = normalizeRentManagerExport({ deposits: rows });
  const reordered = normalizeRentManagerExport({ deposits: [...rows].reverse() });
  const firstDeposits = first.input.deposits ?? [];
  const reorderedDeposits = reordered.input.deposits ?? [];
  const firstIds = firstDeposits.map((row) => row.sourceId);
  assert.equal(firstDeposits.length, 108);
  assert.equal(new Set(firstIds).size, 108);
  assert.deepEqual(firstIds.sort(), reorderedDeposits.map((row) => row.sourceId).sort());
  assert.equal(firstDeposits.filter((row) => row.unitLinkKnowledge === "unknown").length, 7);
  assert.equal(firstDeposits.filter((row) => row.unitLinkKnowledge === "exact").length, 101);
  assert.equal(first.exceptions.some((item) => item.code === "duplicate_source_id"), false);
  assert.equal(reordered.exceptions.some((item) => item.code === "duplicate_source_id"), false);
});

test("tenant-history request provenance resolves missing ParentType without discarding Prospect-labeled rows", () => {
  const normalized = normalizeRentManagerExport({
    tenants: [{ TenantID: "tenant-1", FirstName: "Synthetic", LastName: "Tenant", Status: "Current" }],
    histories: [{ entityType: "activity", sourceId: "history:tenant-1:9", sourceCollection: "tenantHistory.current", _parentSourceId: "tenant-1", parentSourceId: "tenant-1", HistoryID: 9, EntityType: "Prospect", Subject: "Synthetic" }],
  });
  const history = normalized.input.activities?.[0] as Record<string, unknown>;
  assert.equal(history.tenantId, "tenant-1");
  assert.equal(history.verifiedParentType, "Tenant");
  assert.equal(history.verifiedParentSource, "tenant_history_request_parent");
  assert.equal(history.rmSubjectType, "Prospect");
  assert.equal(normalized.exceptions.some((item) => item.detail === "history_parent_missing" || item.detail === "history_parent_type_unrecognized"), false);
});

test("activity normalization accepts collector camelCase parent aliases and keeps source collections distinct", () => {
  const normalized = normalizeRentManagerExport({
    tenants: [{ TenantID: "tenant-1", FirstName: "Synthetic", LastName: "Tenant", Status: "Current" }],
    histories: [{ entityType: "activity", sourceId: "history:tenant-1:9", sourceCollection: "tenantHistory.current", _parentSourceId: "tenant-1", HistoryID: 9, EntityType: "Prospect" }],
    communications: [
      { entityType: "activity", sourceId: "shared:9", sourceCollection: "textMessagingConversations", parentType: "Tenant", parentId: "tenant-1", summary: "text" },
      { entityType: "activity", sourceId: "shared:9", sourceCollection: "incomingTexts", parentType: "Tenant", parentId: "tenant-1", summary: "incoming" },
    ],
  });
  assert.equal(normalized.input.activities?.length, 3);
  assert.equal(normalized.exceptions.some((item) => item.detail === "history_parent_missing" || item.detail === "history_parent_type_unrecognized"), false);
  assert.equal(normalized.exceptions.some((item) => item.detail === "activity_lease_parent_not_resolved"), false);
});

test("blank embedded property addresses are retained as source-empty warnings, not fabricated blockers", () => {
  const normalized = normalizeRentManagerExport({
    properties: [{ PropertyID: "p-empty", PropertyName: "Synthetic", Addresses: [{ AddressType: "Primary" }, { AddressType: "Billing" }] }],
  });
  const property = normalized.input.properties?.[0] as Record<string, unknown>;
  assert.equal(property.addressSourceStatus, "source_empty");
  assert.equal(property.addressSourceEmpty, true);
  assert.ok(normalized.exceptions.some((item) => item.code === "source_empty" && item.detail === "property_embedded_addresses_source_empty"));
  assert.equal(normalized.exceptions.some((item) => item.detail === "property_address_fields_not_returned_by_rm"), false);
});

test("recurring schedules preserve direct scope/date evidence without lease-date inference", () => {
  const payload: ExportPayload = {
    properties: [{ entityType: "property", sourceId: "p1", PropertyID: "p1", AddressLine1: "1 Test Way", City: "Testville", State: "FL", PostalCode: "00001" }],
    units: [{ entityType: "unit", sourceId: "u1", UnitID: "u1", PropertyID: "p1", UnitType: { Name: "One" }, MarketRent: 1000 }],
    tenants: [{ entityType: "person", sourceId: "t1", TenantID: "t1", Status: "Past" }],
    leases: [
      { entityType: "tenancy", sourceId: "old", LeaseID: "old", TenantID: "t1", PropertyID: "p1", UnitID: "u1", MoveInDate: "2023-01-01", DepartureDate: "2023-12-31" },
      { entityType: "tenancy", sourceId: "new", LeaseID: "new", TenantID: "t1", PropertyID: "p1", UnitID: "u1", MoveInDate: "2024-01-01", DepartureDate: "2024-12-31" },
    ],
    recurringSchedules: [{ entityType: "recurring_schedule", sourceId: "r1", RecurringChargeID: "r1", EntityKeyID: "t1", EntityType: "Tenant", FromDate: "2024-02-01", Amount: 1000 }],
  };
  const normalized = normalizeRentManagerExport(payload);
  assert.equal(normalized.input.recurringSchedules?.[0].leaseId, undefined);
  assert.equal(normalized.input.recurringSchedules?.[0].scopeType, "tenant");
  assert.equal(normalized.input.recurringSchedules?.[0].scopeId, "t1");
  assert.equal(normalized.input.recurringSchedules?.[0].effectiveFrom, "2024-02-01");
  assert.equal(normalized.input.recurringSchedules?.[0].effectiveTo, undefined);
  assert.equal(normalized.input.recurringSchedules?.[0].effectiveFromKnowledge, "source");
  assert.equal(normalized.exceptions.some((item) => item.detail === "recurring_lease_join_requires_verified_source"), false);
});

test("recurring schedules preserve unknown open starts and direct unit/property scopes", () => {
  const normalized = normalizeRentManagerExport({
    tenants: [{ TenantID: "t1", Status: "Current" }],
    recurringSchedules: [
      { RecurringChargeID: "unit-row", EntityKeyID: "u1", EntityType: "Unit", ToDate: "2026-12-31", Amount: 50 },
      { RecurringChargeID: "property-row", EntityKeyID: "p1", EntityType: "Property", FromDate: "2026-01-01", ToDate: "2026-12-31", Amount: 75 },
    ],
  });
  const unit = normalized.input.recurringSchedules?.[0] as Record<string, unknown>;
  const property = normalized.input.recurringSchedules?.[1] as Record<string, unknown>;
  assert.equal(unit.scopeType, "unit");
  assert.equal(unit.scopeId, "u1");
  assert.equal(unit.unitId, "u1");
  assert.equal(unit.tenantId, undefined);
  assert.equal(unit.effectiveFrom, undefined);
  assert.equal(unit.effectiveFromKnowledge, "unknown_open_start");
  assert.equal(unit.effectiveTo, "2026-12-31");
  assert.equal(property.scopeType, "property");
  assert.equal(property.scopeId, "p1");
  assert.equal(property.propertyId, "p1");
  assert.equal(property.effectiveFrom, "2026-01-01");
  assert.equal(property.effectiveTo, "2026-12-31");
});

test("ledger normalization resolves single-property receipts and retains proven shared receipts", () => {
  const normalized = normalizeRentManagerExport({
    properties: [
      { PropertyID: "p1", PropertyName: "One", AddressLine1: "1 Test Way", City: "Testville", State: "FL", PostalCode: "00001" },
      { PropertyID: "p2", PropertyName: "Two", AddressLine1: "2 Test Way", City: "Testville", State: "FL", PostalCode: "00001" },
    ],
    units: [
      { UnitID: "u1", PropertyID: "p1", UnitNumber: "1", UnitType: "One", MarketRent: 900 },
      { UnitID: "u2", PropertyID: "p2", UnitNumber: "1", UnitType: "One", MarketRent: 900 },
    ],
    tenants: [{ TenantID: "t1", FirstName: "Synthetic", LastName: "Tenant", Status: "Current" }],
    charges: [
      { ChargeID: "c1", AccountID: "t1", LeaseID: "l1", PropertyID: "p1", UnitID: "u1", Amount: 900, TransactionDate: "2025-01-01" },
      { ChargeID: "c2", AccountID: "t1", PropertyID: "p2", UnitID: "u2", Amount: 900, TransactionDate: "2025-01-01" },
    ],
    payments: [
      { PaymentID: "pay1", AccountID: "t1", LeaseID: "l1", Amount: 900, TransactionDate: "2025-01-02", Allocations: [{ AllocationID: "a1", PaymentID: "pay1", ChargeID: "c1", Amount: 900, TransactionDate: "2025-01-02" }] },
      { PaymentID: "pay2", AccountID: "t1", LeaseID: "l1", Amount: 900, TransactionDate: "2025-01-02", Allocations: [{ AllocationID: "a2", PaymentID: "pay2", ChargeID: "c1", Amount: 900, TransactionDate: "2025-01-02" }] },
      { PaymentID: "pay3", AccountID: "t1", LeaseID: "l1", PropertyID: "p2", Amount: 900, TransactionDate: "2025-01-02", Allocations: [{ AllocationID: "a3", PaymentID: "pay3", ChargeID: "c1", Amount: 900, TransactionDate: "2025-01-02" }] },
      { PaymentID: "pay4", AccountID: "t1", LeaseID: "l1", Amount: 1800, TransactionDate: "2025-01-02", Allocations: [{ AllocationID: "a4", PaymentID: "pay4", ChargeID: "c1", Amount: 900, TransactionDate: "2025-01-02" }, { AllocationID: "a5", PaymentID: "pay4", ChargeID: "c2", Amount: 900, TransactionDate: "2025-01-02" }] },
      { PaymentID: "pay5", AccountID: "t1", LeaseID: "l1", Amount: 900, TransactionDate: "2025-01-02" },
    ],
  });
  const byId = new Map((normalized.input.payments ?? []).map((row) => [String(row.PaymentID), row as Record<string, unknown>]));
  assert.equal(byId.get("pay1")?.propertyId, "p1");
  assert.equal(byId.get("pay2")?.propertyId, "p1");
  assert.equal(byId.get("pay3")?.propertyId, "p2");
  assert.equal(byId.get("pay4")?.propertyId, undefined);
  assert.equal(byId.get("pay5")?.propertyId, undefined);
  assert.ok(normalized.exceptions.some((item) => item.detail === "payment_property_conflicts_with_allocated_charge"));
  assert.equal(byId.get("pay4")?.allocationMode, "multi_property");
  assert.equal(normalized.exceptions.some((item) => item.detail === "payment_allocated_charges_span_multiple_properties"), false);
  assert.ok(normalized.exceptions.some((item) => item.detail === "payment_property_not_resolved_unallocated"));
  assert.equal(normalized.input.allocations?.length, 5);
});

test("recurring EntityType prevents Unit or Property keys from colliding with tenant IDs", () => {
  const normalized = normalizeRentManagerExport({
    properties: [{ PropertyID: "p1", PropertyName: "One", AddressLine1: "1 Test Way", City: "Testville", State: "FL", PostalCode: "00001" }],
    units: [{ UnitID: "1", PropertyID: "p1", UnitNumber: "1", UnitType: "One", MarketRent: 900 }],
    tenants: [{ TenantID: "1", FirstName: "Synthetic", LastName: "Tenant", Status: "Current" }],
    leases: [{ LeaseID: "l1", TenantID: "1", PropertyID: "p1", UnitID: "1", MoveInDate: "2025-01-01" }],
    recurringSchedules: [{ RecurringChargeID: "r1", EntityKeyID: "1", EntityType: "Unit", LeaseID: "l1", PropertyID: "p1", UnitID: "1", FromDate: "2025-01-01", Amount: 900 }],
  });
  const row = normalized.input.recurringSchedules?.[0] as Record<string, unknown>;
  assert.equal(row.tenantId, undefined);
  assert.equal(row.leaseId, undefined);
  assert.equal(normalized.exceptions.some((item) => item.detail === "recurring_entity_is_not_tenant"), false);
  assert.equal(normalized.exceptions.some((item) => item.detail === "recurring_lease_join_requires_verified_source"), false);
});

test("deposit dates remain unknown when RM omits a receipt date", () => {
  const normalized = normalizeRentManagerExport({
    properties: [{ PropertyID: "p1", PropertyName: "Synthetic", AddressLine1: "1 Test Way", City: "Testville", State: "FL", PostalCode: "00001" }],
    units: [{ UnitID: "u1", PropertyID: "p1", UnitNumber: "1", UnitType: "One", MarketRent: 900 }],
    tenants: [{ TenantID: "t1", FirstName: "Synthetic", LastName: "Tenant", Status: "Past" }],
    leases: [{ LeaseID: "l1", TenantID: "t1", PropertyID: "p1", UnitID: "u1", MoveInDate: "2025-01-01" }],
    charges: [{ ChargeID: "c1", AccountID: "t1", PropertyID: "p1", UnitID: "u1", Amount: 500, TransactionDate: "2025-01-02", Description: "Security deposit charge" }],
    deposits: [{ SecurityDepositSummaryID: "d1", TenantID: "t1", UnitID: "u1", Balance: 500, DepositType: "Security" }],
  });
  const deposit = normalized.input.deposits?.[0] as Record<string, unknown>;
  assert.equal(deposit.receivedOn, undefined);
  assert.equal(deposit.receivedOnKnowledge, "unknown");
  assert.ok(normalized.exceptions.some((item) => item.detail === "deposit_received_on_not_returned_by_rm"));
  assert.equal(normalized.exceptions.some((item) => item.detail === "deposit_received_on_substituted_from_charge_date_requires_verified_source"), false);
});

test("deposit type lookup joins exact IDs without exposing lookup IDs or choosing conflicts", () => {
  const deposit = { sourceId: "deposit-lookup", TenantID: "t1", PropertyID: "p1", UnitID: "u1", SecurityDepositTypeID: "sd1", Balance: 500, ReceivedDate: "2026-01-01" };
  const base = { tenants: [{ TenantID: "t1" }], deposits: [deposit] };
  const resolved = normalizeRentManagerExport({
    ...base,
    securityDepositTypeRecords: [{ SecurityDepositTypeID: "sd1", Name: "Security" }],
  });
  assert.equal((resolved.input.deposits?.[0] as Record<string, unknown>).type, "Security");
  const ambiguous = normalizeRentManagerExport({
    ...base,
    securityDepositTypeRecords: [{ SecurityDepositTypeID: "sd1", Name: "Security" }, { SecurityDepositTypeID: "sd1", Name: "Pet" }],
  });
  assert.equal((ambiguous.input.deposits?.[0] as Record<string, unknown>).type, undefined);
  assert.ok(ambiguous.exceptions.some((item) => item.detail === "deposit_type_lookup_ambiguous"));
  const reversed = normalizeRentManagerExport({
    ...base,
    securityDepositTypeRecords: [{ SecurityDepositTypeID: "sd1", Name: "Pet" }, { SecurityDepositTypeID: "sd1", Name: "Security" }],
  });
  assert.equal((reversed.input.deposits?.[0] as Record<string, unknown>).type, undefined);
});

test("verified application answer supplements populate supported profile fields and preserve rows", () => {
  const answerOne = { AnswerID: "answer-1", ApplicationID: "app1", FieldKey: "current_address", Value: "1 Applicant Way" };
  const answerTwo = { AnswerID: "answer-2", ApplicationID: "app1", FieldKey: "adults", Value: 2 };
  const normalized = normalizeRentManagerExport({
    properties: [{ PropertyID: "p1", PropertyName: "Synthetic", AddressLine1: "1 Test Way", City: "Testville", State: "FL", PostalCode: "00001" }],
    units: [{ UnitID: "u1", PropertyID: "p1", UnitNumber: "1", UnitType: "One", MarketRent: 900 }],
    tenants: [],
    contacts: [{ ContactID: "c1", ParentType: "Prospect", ParentID: "pr1", Email: "applicant@example.test", FirstName: "Applicant", LastName: "One" }],
    applications: [{ ProspectApplicationID: "app1", ProspectID: "pr1", ContactID: "c1", Status: "Submitted" }],
    prospects: [{ ProspectID: "pr1", ContactID: "c1", PropertyID: "p1", UnitID: "u1" }],
    applicationTemplates: [{ sourceCollection: "ProspectApplicationTemplateFields", FieldID: "field-1" }],
    applicationAnswerRecords: [
      { ...answerOne, attestation: createApplicationAnswerAttestation(answerOne, "synthetic-answer-run") },
      { ...answerTwo, attestation: createApplicationAnswerAttestation(answerTwo, "synthetic-answer-run") },
    ],
  });
  const application = normalized.input.applications?.[0] as Record<string, unknown>;
  assert.equal((application.rentalHistory as Record<string, unknown>)?.currentAddress, "1 Applicant Way");
  assert.deepEqual(application.householdSummary, { adults: 2 });
  assert.equal((normalized.input as RentManagerImportInput & { applicationAnswerRecords?: unknown[] }).applicationAnswerRecords?.length, 2);
  assert.equal(normalized.exceptions.some((item) => item.detail === "application_answer_source_not_verified"), false);
});

test("CLI parser requires a restricted archive outside the worktree", () => {
  const parsed = parseRentManagerExportCliArgs(["--archive-root", "/tmp/rm-export-synthetic", "--run-id", "synthetic", "--page-size", "1000"]);
  assert.equal(parsed.runId, "synthetic");
  assert.equal(parsed.pageSize, 1000);
  assert.equal(parsed.resume, true);
  assert.equal(parsed.fetchDocumentBinaries, true);
  assert.equal(parsed.archiveRoot, "/tmp/rm-export-synthetic");
  assert.equal(parseRentManagerExportCliArgs(["--archive-root", "/tmp/rm-export-synthetic", "--no-document-binaries"]).fetchDocumentBinaries, false);
});

test("pagination exhausts X-Total-Results, retries 429/5xx, and enforces throttle floors", async () => {
  const requests: RentManagerRequest[] = [];
  const sleeps: number[] = [];
  const registry: readonly CollectionDefinition[] = [{ name: "properties", path: "/Properties", idFields: ["PropertyID"], entityType: "property", outputKey: "properties", required: true }];
  const transport = fixtureTransport({ "/Properties": [
    { PropertyID: 1 }, { PropertyID: 2 }, { PropertyID: 3 }, { PropertyID: 4 }, { PropertyID: 5 },
  ] }, requests, { "/Properties": [429, 500] });
  const result = await new RentManagerExportCollector({ transport, archive: createMemoryArchive(), registry, pageSize: 2, sleep: async (milliseconds) => { sleeps.push(milliseconds); }, runId: "throttle-test" }).collect();
  assert.equal(result.coverage[0].pages, 3);
  assert.equal(result.coverage[0].received, 5);
  assert.equal(result.manifest.complete, true);
  assert.deepEqual(requests.map((request) => request.query.pagenumber), [1, 1, 1, 2, 3]);
  assert.ok(sleeps.some((milliseconds) => milliseconds >= 350));
  assert.ok(sleeps.some((milliseconds) => milliseconds >= 250));
});

test("rolling request cap is never raised above 60 requests per minute", async () => {
  const requests: RentManagerRequest[] = [];
  const sleeps: number[] = [];
  const registry: readonly CollectionDefinition[] = [{ name: "properties", path: "/Properties", idFields: ["PropertyID"], entityType: "property", outputKey: "properties", required: true }];
  const rows = Array.from({ length: 61 }, (_, index) => ({ PropertyID: index + 1 }));
  const result = await new RentManagerExportCollector({ transport: fixtureTransport({ "/Properties": rows }, requests), archive: createMemoryArchive(), registry, pageSize: 1, maxRequestsPerMinute: 60, sleep: async (milliseconds) => { sleeps.push(milliseconds); }, runId: "cap-test" }).collect();
  assert.equal(result.coverage[0].received, 61);
  assert.equal(requests.length, 61);
  // With the mandated 350ms spacing, the rolling-window wait is roughly
  // 39.3 seconds after the first 60 calls (not a full minute).
  assert.ok(sleeps.some((milliseconds) => milliseconds >= 30_000));
});

test("resume retains prior coverage exceptions instead of treating a partial run as clean", async () => {
  const archive = createMemoryArchive();
  const registry: readonly CollectionDefinition[] = [{ name: "properties", path: "/Properties", idFields: ["PropertyID"], entityType: "property", outputKey: "properties", required: true }];
  const firstRequests: RentManagerRequest[] = [];
  const first = fixtureTransport({ "/Properties": [{ PropertyID: 1 }, { PropertyID: 2 }] }, firstRequests);
  const firstResult = await new RentManagerExportCollector({ transport: first, archive, registry, pageSize: 1, maxPages: 1, sleep: async () => undefined, runId: "exception-resume" }).collect();
  assert.equal(firstResult.checkpoint.complete, false);
  assert.ok(firstResult.manifest.exceptions.some((exception) => exception.code === "pagination_incomplete"));
  const secondRequests: RentManagerRequest[] = [];
  const second = fixtureTransport({ "/Properties": [{ PropertyID: 1 }, { PropertyID: 2 }] }, secondRequests);
  const secondResult = await new RentManagerExportCollector({ transport: second, archive, registry, pageSize: 1, sleep: async () => undefined, runId: "exception-resume" }).collect();
  assert.deepEqual(secondRequests.map((request) => request.query.pagenumber), [2]);
  assert.equal(secondResult.envelope.payload.properties?.length, 2);
  assert.equal(secondResult.manifest.complete, true);
  assert.equal(secondResult.manifest.exceptions.some((exception) => exception.code === "pagination_incomplete"), false);
  const fresh = await new RentManagerExportCollector({ transport: fixtureTransport({ "/Properties": [{ PropertyID: 1 }, { PropertyID: 2 }] }), archive: createMemoryArchive(), registry, pageSize: 1, sleep: async () => undefined, runId: "fresh-resume-comparison" }).collect();
  assert.deepEqual(secondResult.checkpoint.collections.properties.hashes, fresh.checkpoint.collections.properties.hashes);
});

test("missing and duplicate explicit RM IDs make required coverage incomplete", async () => {
  const registry: readonly CollectionDefinition[] = [{ name: "properties", path: "/Properties", idFields: ["PropertyID"], entityType: "property", outputKey: "properties", required: true }];
  const transport = fixtureTransport({ "/Properties": [{ PropertyID: 1 }, { PropertyName: "no id" }, { PropertyID: 1 }] });
  const result = await new RentManagerExportCollector({ transport, archive: createMemoryArchive(), registry, sleep: async () => undefined }).collect();
  assert.equal(result.manifest.complete, false);
  assert.ok(result.manifest.exceptions.some((exception) => exception.code === "missing_source_id"));
  assert.ok(result.manifest.exceptions.some((exception) => exception.code === "duplicate_source_id"));
});

test("hashes are deterministic and source hashes are not double-hashed during redaction", () => {
  assert.equal(hashRecord({ b: 2, a: 1 }), hashRecord({ a: 1, b: 2 }));
  const sourceHash = redactIdentifier("PropertyID:1");
  const redacted = JSON.stringify({ sourceIdHash: sourceHash });
  assert.equal(redacted.includes(redactIdentifier(sourceHash)), false);
  assert.equal(sourceHash, redactIdentifier("PropertyID:1"));
});

test("restricted archive rejects symlink parents, symlink leaves, and permissive directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "rm-export-safety-"));
  const target = await mkdtemp(join(tmpdir(), "rm-export-target-"));
  try {
    const parentLink = join(root, "parent-link");
    await symlink(target, parentLink);
    await assert.rejects(() => createRestrictedArchive(join(parentLink, "archive")));
    const permissive = join(root, "permissive");
    await mkdir(permissive, { mode: 0o755 });
    await chmod(permissive, 0o755);
    await assert.rejects(() => createRestrictedArchive(permissive));
    const archiveRoot = join(root, "archive");
    const archive = await createRestrictedArchive(archiveRoot);
    const leaf = join(archiveRoot, "pages", "symlink-1.json");
    await symlink(join(target, "missing.json"), leaf);
    await assert.rejects(() => archive.writePage("symlink", 1, []));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("empty HAP collections do not infer a candidate from HAP-like prose", () => {
  const payload = syntheticExportPayload();
  payload.subsidies = [];
  payload.hap = [];
  payload.recurringSchedules = [{ entityType: "recurring_schedule", sourceId: "rec-hap", RecurringChargeID: "rec-hap", EntityKeyID: 201, EntityType: "Tenant", Amount: 100, Description: "HAP agency portion", StartDate: "2025-01-01" }];
  const normalized = normalizeRentManagerExport(payload);
  assert.equal(normalized.confidence.hap, "confirmed");
  assert.equal(normalized.exceptions.some((exception) => exception.collection === "hap" && exception.detail === "hap_candidate_missing_agency_tenant_obligations_and_dates"), false);
  assert.equal(JSON.stringify(normalized.exceptions).includes("tenant-201@example.test"), false);
  const unjoined = syntheticExportPayload();
  unjoined.hap = [{ entityType: "subsidy", sourceId: "hap-unjoined", SubsidyTenantID: 1602, TenantID: 201 }];
  const unjoinedResult = normalizeRentManagerExport(unjoined);
  assert.equal(unjoinedResult.confidence.hap, "blocked");
  assert.ok(unjoinedResult.exceptions.some((exception) => exception.detail === "hap_row_not_joined_to_subsidy_contract"));
});

test("full synthetic normalization maps communication and signable document classes exactly once", () => {
  const normalized = normalizeRentManagerExport(syntheticExportPayload());
  assert.equal(normalized.input.activities?.length, 5);
  assert.equal(normalized.input.documents?.length, 3);
  assert.equal(new Set(normalized.input.activities?.map((row) => String(row.sourceId))).size, 5);
  assert.equal(new Set(normalized.input.documents?.map((row) => String(row.sourceId))).size, 3);
  assert.equal(normalized.input.recurringSchedules?.length, 1);
  assert.equal(normalized.input.allocations?.length, 1);
  assert.equal(normalized.input.deposits?.length, 1);
  assert.equal(normalized.input.subsidies?.length, 1);
  assert.equal(normalized.input.credits?.length, 1);
  assert.equal(normalized.input.applications?.[0].webUserId, "501");
  assert.equal(normalized.input.applications?.[0].webUserAccountId, "502");
});

test("CLI summary contains counts/status only and never raw payload fields", async () => {
  const registry: readonly CollectionDefinition[] = [{ name: "properties", path: "/Properties", idFields: ["PropertyID"], entityType: "property", outputKey: "properties", required: true }];
  const result = await new RentManagerExportCollector({
    transport: fixtureTransport({ "/Properties": [{ PropertyID: 1, PropertyName: "Synthetic Secret", Email: "tenant-201@example.test" }] }),
    archive: createMemoryArchive(), registry, sleep: async () => undefined, runId: "summary-test",
  }).collect();
  const summary = redactedCliSummary(result);
  const encoded = JSON.stringify(summary);
  assert.equal(encoded.includes("Synthetic Secret"), false);
  assert.equal(encoded.includes("example.test"), false);
  assert.equal(typeof summary.complete, "boolean");
});

test("canonical registry runs all tenant partitions and documents explicit unsupported resources", async () => {
  const requests: RentManagerRequest[] = [];
  const result = await new RentManagerExportCollector({
    transport: createSyntheticRentManagerTransport({ onRequest: (request) => requests.push(request) }),
    archive: createMemoryArchive(), registry: RM_EXPORT_COLLECTIONS, sleep: async () => undefined, runId: "canonical-registry",
  }).collect();
  assert.equal(result.coverage.find((entry) => entry.name === "tenants.future")?.status, "empty");
  assert.equal(result.coverage.find((entry) => entry.name === "tenants.former")?.status, "empty");
  assert.equal(result.coverage.find((entry) => entry.name === "tenantHistory.future")?.status, "empty");
  assert.equal(result.coverage.find((entry) => entry.name === "tenantHistory.former")?.status, "empty");
  assert.ok(requests.some((request) => request.path === "/Contacts/301/PhoneNumbers"));
  assert.ok(result.coverage.find((entry) => entry.name === "households")?.exceptions.some((exception) => exception.code === "known_unsupported_endpoint"));
  assert.ok(result.coverage.find((entry) => entry.name === "allocations")?.exceptions.some((exception) => exception.code === "known_unsupported_endpoint"));
  for (const path of ["/WebUserAccounts", "/ProspectApplicationTemplates", "/ProspectApplicationTemplateFields", "/ProspectApplicationTemplateMajorSections", "/ProspectApplicationTemplateMinorSections", "/InterestedRentals", "/ApplicationSettings", "/ApplicationTemplates", "/HistoryNotes", "/HistoryEmails", "/TextMessagingConversations", "/UserDefinedFields"]) {
    assert.ok(RM_EXPORT_COLLECTIONS.some((definition) => definition.path === path), `missing canonical registry path ${path}`);
  }
  assert.equal(RM_EXPORT_COLLECTIONS.find((definition) => definition.name === "webUsers")?.outputKey, "webUsers");
  assert.equal(RM_EXPORT_COLLECTIONS.find((definition) => definition.name === "webUsers")?.query?.fields, SAFE_WEB_USER_FIELDS.join(","));
  assert.equal(SAFE_WEB_USER_FIELDS.some((field) => /password|passwd|pwd|secret|token|private.?key|authorization|connection.?string|database.?url/i.test(field)), false);
  assert.equal(requests.find((request) => request.path === "/WebUsers")?.query.fields, SAFE_WEB_USER_FIELDS.join(","));
  assert.equal(RM_EXPORT_COLLECTIONS.find((definition) => definition.name === "webUserAccounts")?.outputKey, "webUserAccounts");
  assert.equal(RM_EXPORT_COLLECTIONS.find((definition) => definition.name === "interestedRentals")?.outputKey, "interestedRentals");
  assert.equal(RM_EXPORT_COLLECTIONS.find((definition) => definition.name === "applicationSettings")?.outputKey, "applicationSettings");
  assert.deepEqual(RM_EXPORT_COLLECTIONS.find((definition) => definition.name === "prospectApplicationTemplateMajorSections")?.idFields[0], "ApplicationMajorSectionID");
  assert.deepEqual(RM_EXPORT_COLLECTIONS.find((definition) => definition.name === "prospectApplicationTemplateMinorSections")?.idFields[0], "ApplicationMinorSectionID");
  assert.deepEqual(RM_EXPORT_COLLECTIONS.find((definition) => definition.name === "applicationSettings")?.idFields[0], "ApplicationSettingsID");
  assert.equal(result.coverage.find((entry) => entry.name === "prospectApplicationTemplateMajorSections")?.received, 1);
  assert.equal(result.coverage.find((entry) => entry.name === "prospectApplicationTemplateMinorSections")?.received, 1);
  assert.equal(result.coverage.find((entry) => entry.name === "interestedRentals")?.received, 1);
  assert.equal(result.coverage.find((entry) => entry.name === "applicationSettings")?.received, 1);
  assert.deepEqual(RM_EXPORT_COLLECTIONS.find((definition) => definition.name === "properties")?.query, { embeds: "Addresses" });
  assert.deepEqual(RM_EXPORT_COLLECTIONS.find((definition) => definition.name === "units")?.query, { embeds: "UnitType,MarketRent,Amenities" });
  assert.deepEqual(RM_EXPORT_COLLECTIONS.find((definition) => definition.name === "tenants.current")?.query, { filters: "Status,eq,Current", embeds: "Contacts,PrimaryContact" });
  assert.deepEqual(RM_EXPORT_COLLECTIONS.find((definition) => definition.name === "payments")?.query, { embeds: "Allocations" });
  assert.deepEqual(RM_EXPORT_COLLECTIONS.find((definition) => definition.name === "prospects")?.query, { embeds: "Contacts,InterestedUnits" });
  assert.equal(result.coverage.find((entry) => entry.name === "applicationSummaries")?.status, "empty");
  assert.equal(result.coverage.find((entry) => entry.name === "prospectSubApplicantDetails")?.status, "empty");
  assert.equal(RM_EXPORT_COLLECTIONS.some((definition) => definition.path === "/TenantContacts"), false);
  assert.equal(RM_EXPORT_COLLECTIONS.some((definition) => definition.path === "/FileAttachments"), false);
});

// Keep TypeScript from erasing the raw-record import in isolated test builds.
void ({} as RentManagerRawRecord);
void ({} as MemoryCheckpointStore);

test("application web-account sentinel preserves raw source without inventing account identity", () => {
  const normalized = normalizeRentManagerExport({
    applications: [{ ProspectApplicationID: 1, WebUserAccountID: -1, AccountID: 502, ApplicationStatus: "Complete" }],
    webUserAccounts: [{ WebUserAccountID: 502, Email: "wrong@example.test" }, { WebUserAccountID: -1, Email: "sentinel@example.test" }],
  });
  const application = normalized.input.applications?.[0] as Record<string, unknown>;
  assert.equal(application.WebUserAccountID, -1);
  assert.equal(application.AccountID, 502);
  assert.equal(application.ApplicationStatus, "Complete");
  assert.equal(application.webUserAccountId, undefined);
  assert.equal(application.email, undefined);
  assert.ok(!normalized.exceptions.some((row) => row.detail === "application_web_user_or_account_not_resolved"));
});

test('payment reversal embed supplies reason only through exact PaymentID binding',()=>{
 const base={PaymentID:527,AccountID:1,Amount:820,TransactionDate:'2022-11-01T00:00:00',ReversalType:'ePay',ReversalDate:'2022-11-19T00:00:00'};
 const exact=normalizeRentManagerExport({payments:[{...base,PaymentReversal:{PaymentID:527,ReversalType:'ePay',ReversalDate:'2022-11-19T00:00:00',ReversalReason:'Overpaid'}}]});
 assert.equal((exact.input.payments![0] as Record<string,unknown>).ReversalReason,'Overpaid');
 const wrong=normalizeRentManagerExport({payments:[{...base,PaymentReversal:{PaymentID:999,ReversalReason:'Wrong account'}}]});
 assert.equal((wrong.input.payments![0] as Record<string,unknown>).ReversalReason,undefined);
});


test("exact CreditAllocation retains its AppliedCreditID parent without requiring or inventing a payment",()=>{
 const result=normalizeRentManagerExport({
  credits:[{CreditID:7,AccountID:1,Amount:100,TransactionDate:'2026-08-01'}],
  allocations:[
   {AllocationID:1,AllocationType:'CreditAllocation',AppliedCreditID:7,ChargeID:2,Amount:100,TransactionDate:'2026-08-02'},
   {AllocationID:2,AllocationType:'CreditAllocation',AppliedCreditID:8,ChargeID:2,Amount:100,TransactionDate:'2026-08-02'},
   {AllocationID:3,AllocationType:'DirectAllocation',AppliedCreditID:7,ChargeID:2,Amount:100,TransactionDate:'2026-08-02'},
  ],
 } as any);
 assert.equal(result.input.allocations?.length,1);
 assert.equal(result.input.allocations?.[0].sourceId,'payment_allocation:1');
 assert.equal(result.input.allocations?.[0].creditId,'credit:7');
 assert.equal(result.input.allocations?.[0].paymentId,undefined);
 assert.equal(result.input.payments?.length,0);
 assert.ok(result.exceptions.some(e=>e.detail==='allocation_parent_credit_not_resolved'));
 assert.ok(result.exceptions.some(e=>e.detail==='allocation_parent_payment_not_resolved'));
});

test("future generic RM move-out remains expected at the sealed observation on every replay",()=>{
 const payload=syntheticExportPayload();
 payload.leases=[{entityType:"tenancy",sourceId:"scheduled",LeaseID:"scheduled",TenantID:"t1",PropertyID:"p1",UnitID:"u1",MoveInDate:"2026-08-01",MoveOutDate:"2027-07-31",DepartureDate:"2027-07-31"},
 {entityType:"tenancy",sourceId:"historical",LeaseID:"historical",TenantID:"t1",PropertyID:"p1",UnitID:"u1",MoveInDate:"2025-01-01",MoveOutDate:"2026-06-30"}];
 for(const asOfDate of ["2026-09-07","2028-01-01"]){
  const result=normalizeRentManagerExport(payload,{artifactObservationOn:"2026-09-07",asOfDate});
  const [scheduled,historical]=result.input.leases as Array<Record<string,unknown>>;
  assert.equal(scheduled.actualMoveOutOn,undefined);
  assert.equal(scheduled.expectedMoveOutOn,"2027-07-31");
  assert.equal(scheduled.MoveOutDate,"2027-07-31");
  assert.equal(historical.actualMoveOutOn,"2026-06-30");
 }
});
