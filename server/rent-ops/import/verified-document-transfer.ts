import { createHash } from "node:crypto";
import { RentOpsInvariantError } from "../domain/invariants";
import type { RentOpsQueryExecutor } from "../repositories/postgres";
import { prepareVerifiedImportedDocument, type VerifiedDocumentArchiveInput } from "../services/service";
import type { ContentAddressedObjectStore } from "../storage";
import type { RestrictedVerifiedDocumentTransfer, RestrictedVerifiedDocumentTransferResult } from "./persistence-importer";

const normalize = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value ?? "");

/** Uses only the caller's import transaction. The importer owns object-binding persistence. */
export class ProductionRestrictedVerifiedDocumentTransfer implements RestrictedVerifiedDocumentTransfer {
  constructor(private readonly importerStorage: ContentAddressedObjectStore, private readonly now: () => Date = () => new Date()) {}

  async transferVerifiedDocument(input: VerifiedDocumentArchiveInput, executor: RentOpsQueryExecutor): Promise<RestrictedVerifiedDocumentTransferResult> {
    if (!(input.bytes instanceof Uint8Array) || input.stream !== undefined || input.bytes.byteLength !== input.sizeBytes || !input.checksumSha256 || createHash("sha256").update(input.bytes).digest("hex") !== input.checksumSha256.toLowerCase()) {
      throw new RentOpsInvariantError("Imported document source binary differs from approved bytes");
    }
    const result = await prepareVerifiedImportedDocument(this.importerStorage, input, this.now);
    const { document, binding } = result;
    // Re-verification must retain the original persisted timestamp on an exact replay.
    const existing = await executor.query<Record<string, unknown>>(
      "SELECT o.*, d.uploaded_at FROM rent_ops_document_objects o JOIN rent_ops_documents d ON d.id = o.document_id WHERE o.document_id = $1", [document.id],
    );
    if (existing.rows.length > 1) throw new RentOpsInvariantError("Imported document binding is ambiguous");
    const prior = existing.rows[0];
    if (prior) {
      const expected = {
        document_id: binding.documentId, binding_kind: binding.bindingKind, source_binary_id: binding.sourceBinaryId,
        import_run_id: binding.importRunId, source_system: binding.sourceSystem, source_collection: binding.sourceCollection,
        backend: binding.backend, logical_key: binding.logicalKey, checksum_sha256: binding.checksumSha256,
        size_bytes: binding.sizeBytes, immutable_generation: binding.immutableGeneration, immutable_version: binding.immutableVersion,
      };
      if (!Object.entries(expected).every(([key, value]) => normalize(prior[key]) === normalize(value))) throw new RentOpsInvariantError("Imported document immutable binding conflict");
      const verifiedAt = normalize(prior.verified_at);
      const uploadedAt = normalize(prior.uploaded_at);
      if (!Number.isFinite(Date.parse(verifiedAt)) || !Number.isFinite(Date.parse(uploadedAt))) throw new RentOpsInvariantError("Imported document persisted timestamp is invalid");
      binding.verifiedAt = verifiedAt;
      document.verifiedAt = verifiedAt;
      document.uploadedAt = uploadedAt;
    }
    // Source reconciliation follows in the importer. Preserve existing provenance here.
    const columns = ["id", "property_id", "unit_id", "person_id", "tenancy_id", "application_id", "type", "type_knowledge", "state", "state_knowledge", "file_name", "mime_type", "size_bytes", "checksum_sha256", "storage_key", "uploaded_at", "verified_at", "availability", "storage_key_knowledge"];
    const values = [document.id, document.propertyId, document.unitId, document.personId, document.tenancyId, document.applicationId, document.type, document.typeKnowledge, document.state, document.stateKnowledge, document.fileName, document.mimeType, document.sizeBytes, document.checksumSha256, document.storageKey, document.uploadedAt, document.verifiedAt, document.availability, document.storageKeyKnowledge].map(value => value ?? null);
    await executor.query(`INSERT INTO rent_ops_documents (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")}) ON CONFLICT (id) DO UPDATE SET ${columns.slice(1).map(column => `${column} = EXCLUDED.${column}`).join(", ")}`, values);
    return result;
  }
}
