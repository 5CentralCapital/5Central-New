/** Company documents use this ID namespace; older R-ops rental documents do not. */
export const COMPANY_DOCUMENT_ID_PREFIX = "company-document:";

/**
 * Investor references may point at a scoped company document or at an older
 * R-ops rental document. Each lives behind its own download route: the
 * company route only serves `company-document:` IDs, and the legacy route
 * refuses them.
 */
export function investorDocumentDownloadHref(organizationId: string, documentId: string, legalEntityId: string): string {
  if (!documentId.startsWith(COMPANY_DOCUMENT_ID_PREFIX)) return `/api/rent-ops/documents/${encodeURIComponent(documentId)}/download`;
  const params = new URLSearchParams({ legalEntityId });
  return `/api/company/${encodeURIComponent(organizationId)}/documents/${encodeURIComponent(documentId)}/download?${params.toString()}`;
}
