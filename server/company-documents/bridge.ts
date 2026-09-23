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
  await repository.saveDocument(document);
  if (!repository.saveDocumentObjectBinding) throw new Error("Verified 5Central Ops document binding is unavailable.");
  await repository.saveDocumentObjectBinding({ ...input.binding, documentId });

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
