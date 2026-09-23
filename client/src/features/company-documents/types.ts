import type { CompanyDocument, CompanyDocumentKind, CompanyDocumentLink, CompanyDocumentPage } from "@shared/company-documents";

export interface CompanyDocumentLinkOption extends CompanyDocumentLink {
  readonly label: string;
}

export interface CompanyDocumentListFilter {
  readonly legalEntityId?: string;
  readonly propertyId?: string;
  readonly projectId?: string;
  readonly investorContractId?: string;
  readonly kind?: CompanyDocumentKind;
  readonly cursor?: string;
}

export interface CompanyDocumentUploadInput {
  readonly kind: CompanyDocumentKind;
  readonly title: string;
  readonly description?: string | null;
  readonly documentDate?: string | null;
  readonly tags: readonly string[];
  readonly links: readonly CompanyDocumentLinkOption[];
  readonly context: { readonly legalEntityId?: string; readonly propertyId?: string; readonly projectId?: string; readonly investorContractId?: string; readonly investorContractVersionId?: string };
  readonly file: File;
}

export interface CompanyDocumentMetadataUpdateInput {
  readonly documentId: string;
  readonly expectedRevision: number;
  readonly title?: string;
  readonly description?: string | null;
  readonly documentDate?: string | null;
  readonly tags?: readonly string[];
  readonly links?: readonly CompanyDocumentLinkOption[];
}

export interface CompanyDocumentsApi {
  list(organizationId: string, filter?: CompanyDocumentListFilter, signal?: AbortSignal): Promise<CompanyDocumentPage>;
  get(organizationId: string, documentId: string, signal?: AbortSignal): Promise<CompanyDocument>;
  upload(organizationId: string, input: CompanyDocumentUploadInput, signal?: AbortSignal): Promise<CompanyDocument>;
  updateMetadata(organizationId: string, input: CompanyDocumentMetadataUpdateInput, signal?: AbortSignal): Promise<CompanyDocument>;
  archive(organizationId: string, document: Pick<CompanyDocument, "id" | "recordRevision">, signal?: AbortSignal): Promise<void>;
  download(organizationId: string, documentId: string, signal?: AbortSignal): Promise<Blob>;
}

export interface CompanyDocumentsWorkspaceProps {
  readonly organizationId: string;
  readonly organizationName?: string;
  readonly legalEntityId?: string;
  readonly propertyId?: string;
  readonly projectId?: string;
  readonly investorContractId?: string;
  readonly investorContractVersionId?: string;
  readonly linkOptions?: readonly CompanyDocumentLinkOption[];
  readonly api?: CompanyDocumentsApi;
}
