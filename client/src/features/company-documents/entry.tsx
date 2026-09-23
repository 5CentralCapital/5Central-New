import { CompanyGate, entityForProperty } from "../review-cases/company-context";
import { CompanyDocumentsWorkspace } from "./workspace";
import type { CompanyDocumentLinkOption } from "./types";

type LinkId = CompanyDocumentLinkOption["id"];

/** Navigation mount point (no required props): company documents for the signed-in manager's company. */
export function CompanyDocumentsEntry({ organizationId, propertyId }: { organizationId?: string; propertyId?: string | null } = {}) {
  return <CompanyGate organizationId={organizationId} loadingLabel="Loading documents…">
    {organization => {
      const legalEntityId = entityForProperty(organization, propertyId);
      // Links offered for new files: the company's legal entities and properties from the authorized context.
      const linkOptions: CompanyDocumentLinkOption[] = organization.entities.flatMap(entity => legalEntityId && entity.id !== legalEntityId ? [] : [
        { kind: "legal_entity" as const, id: entity.id as LinkId, label: entity.name },
        ...entity.properties.filter(property => !propertyId || property.id === propertyId).map(property => ({ kind: "property" as const, id: property.id as LinkId, label: property.name })),
      ]);
      return <CompanyDocumentsWorkspace key={`${organization.id}:${propertyId ?? ""}`} organizationId={organization.id} organizationName={organization.name}
        legalEntityId={legalEntityId} propertyId={legalEntityId ? propertyId ?? undefined : undefined} linkOptions={linkOptions} />;
    }}
  </CompanyGate>;
}

export default CompanyDocumentsEntry;
