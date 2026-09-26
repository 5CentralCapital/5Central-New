import type { CompanyDocument } from "../../shared/company-documents";
import type { RentOpsDocument, RentOpsDocumentObjectBinding } from "../../shared/rent-ops-contracts";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { PostgresRentOpsRepository } from "../rent-ops/repositories/postgres";

export interface RegisterVerifiedRentOpsDocumentInput {
  readonly executor: RentOpsQueryExecutor;
  readonly document: CompanyDocument;
  readonly binding: RentOpsDocumentObjectBinding;
  readonly legacyDocumentId?: string;
}

function legacyDocumentType(_document: CompanyDocument): RentOpsDocument["type"] { return "other"; }

function sameVerifiedObject(left: RentOpsDocumentObjectBinding, right: RentOpsDocumentObjectBinding): boolean {
  return left.backend === right.backend
    && left.logicalKey === right.logicalKey
    && left.checksumSha256 === right.checksumSha256
    && left.sizeBytes === right.sizeBytes
    && (left.immutableGeneration ?? null) === (right.immutableGeneration ?? null)
    && (left.immutableVersion ?? null) === (right.immutableVersion ?? null)
    && Date.parse(left.verifiedAt) === Date.parse(right.verifiedAt);
}

/** Bridge a verified company file into the existing 5Central Ops document
 * and immutable object-binding tables inside the caller's transaction. */
export async function registerVerifiedRentOpsDocument(input: RegisterVerifiedRentOpsDocumentInput): Promise<void> {
  const documentId = input.legacyDocumentId ?? input.document.id;
  const document: RentOpsDocument = {
    id: documentId,
    propertyId: input.document.context.propertyId,
    type: legacyDocumentType(input.document),
    typeKnowledge: "manual",
    state: "verified",
    stateKnowledge: "manual",
    fileName: input.document.source.fileName,
    mimeType: input.document.source.declaredContentType,
    sizeBytes: input.document.source.sizeBytes,
    checksumSha256: input.document.source.checksumSha256,
    storageKey: `documents/${input.document.source.checksumSha256}`,
    uploadedAt: input.document.uploadedAt,
    verifiedAt: input.document.source.verifiedAt,
    availability: "verified",
    storageKeyKnowledge: "source",
  };
  const repository = new PostgresRentOpsRepository(input.executor, true);
  await repository.assertReady();
  if (!repository.saveDocumentObjectBinding) throw new Error("Verified 5Central Ops document binding is unavailable.");
  // A retry can consume a freshly staged copy of an already verified company
  // document. Reuse the immutable compatibility row when it exists; the
  // company-document source IDs are scoped to company_documents and do not
  // have rows in rent_ops_source_binaries/import_runs.
  const legacyBinding: RentOpsDocumentObjectBinding = {
    documentId,
    bindingKind: "admin",
    backend: input.binding.backend,
    logicalKey: input.binding.logicalKey,
    checksumSha256: input.binding.checksumSha256,
    sizeBytes: input.binding.sizeBytes,
    ...(input.binding.immutableGeneration ? { immutableGeneration: input.binding.immutableGeneration } : {}),
    ...(input.binding.immutableVersion ? { immutableVersion: input.binding.immutableVersion } : {}),
    verifiedAt: input.binding.verifiedAt,
  };
  const existingDocument = await input.executor.query<Record<string, unknown>>(
    "SELECT property_id, state, availability, size_bytes, checksum_sha256, storage_key FROM rent_ops_documents WHERE id=$1 LIMIT 1",
    [documentId],
  );
  const existingRow = existingDocument.rows[0];
  if (existingRow) {
    const sameProperty = (existingRow.property_id ?? null) === (document.propertyId ?? null);
    const sameSize = Number(existingRow.size_bytes) === document.sizeBytes;
    const sameState = existingRow.state === "verified" && existingRow.availability === "verified";
    if (!sameProperty || !sameSize || existingRow.checksum_sha256 !== document.checksumSha256 || existingRow.storage_key !== document.storageKey || !sameState) {
      throw new Error("Existing 5Central Ops document conflicts with the verified company document.");
    }
  } else {
    await repository.saveDocument(document);
  }
  const existingBinding = await repository.getDocumentObjectBinding(documentId);
  if (existingBinding) {
    if (!sameVerifiedObject(existingBinding, legacyBinding)) throw new Error("Existing 5Central Ops document binding conflicts with the verified company object.");
  } else {
    await repository.saveDocumentObjectBinding(legacyBinding);
  }

  const contractLink = input.document.links.find(link => link.kind === "investor_contract");
  const versionLink = input.document.links.find(link => link.kind === "investor_contract_version");
  const contractId = input.document.context.investorContractId ?? contractLink?.id ?? versionLink?.id;
  const versionId = input.document.context.investorContractVersionId ?? versionLink?.versionId;
  if (contractId && versionId) {
    await input.executor.query(
      `INSERT INTO company_investor_contract_documents
        (organization_id, contract_id, contract_version_id, document_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (organization_id, contract_version_id, document_id) DO NOTHING`,
      [input.document.context.organizationId, contractId, versionId, documentId],
    );
  }
}
