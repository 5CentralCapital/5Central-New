import { CompanyGate, entityForProperty } from "../review-cases/company-context";
import { MraResults } from "./results";

/** Navigation mount point (no required props): read-only MRA results for the signed-in manager's company. */
export function IntakeResultsEntry({ organizationId, propertyId, onNavigate }: { organizationId?: string; propertyId?: string | null; onNavigate?: (organizationId: string) => void } = {}) {
  return <CompanyGate organizationId={organizationId} onOrganization={onNavigate} loadingLabel="Loading MRA results…">
    {organization => {
      const legalEntityId = entityForProperty(organization, propertyId);
      return <MraResults key={`${organization.id}:${propertyId ?? ""}`} organizationId={organization.id} organizationName={organization.name}
        legalEntityId={legalEntityId} propertyId={legalEntityId ? propertyId ?? undefined : undefined} />;
    }}
  </CompanyGate>;
}

export default IntakeResultsEntry;
