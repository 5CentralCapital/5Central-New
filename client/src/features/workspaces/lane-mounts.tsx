import type { ComponentType } from "react";
import { AccountingEntry } from "../accounting/entry";
import type { AccountingView } from "../rent-ops/workspace/workspace-state";
import { ReviewQueueEntry as ReviewQueue } from "../review-cases/entry";
import { IntakeResultsEntry as IntakeResults } from "../intake/entry";
import { CompanyDocumentsEntry as CompanyDocuments } from "../company-documents/entry";
import { ForecastingEntry as Forecasting } from "../forecasting/workspace";
import type { ForecastTab } from "../forecasting/params";

/** Mount points the manager shell uses for company workspaces. */
export interface LaneEntryProps {
  readonly identity: string;
  readonly organizationId?: string;
  readonly onNavigate: (organizationId: string) => void;
  readonly propertyId?: string;
}

export function ReviewQueueEntry({ organizationId, propertyId }: LaneEntryProps) {
  return <ReviewQueue organizationId={organizationId} propertyId={propertyId ?? null} />;
}

export function IntakeResultsEntry({ organizationId, propertyId }: LaneEntryProps) {
  return <IntakeResults organizationId={organizationId} propertyId={propertyId ?? null} />;
}

export function CompanyDocumentsEntry({ organizationId, propertyId }: LaneEntryProps) {
  return <CompanyDocuments organizationId={organizationId} propertyId={propertyId ?? null} />;
}

export function ForecastingEntry({ identity, organizationId, onNavigate, scenarioId, legalEntityId, propertyId, tab, onTabChange }: LaneEntryProps & {
  readonly scenarioId?: string;
  readonly legalEntityId?: string;
  readonly tab?: string;
  readonly onTabChange: (tab: string, scenarioId?: string) => void;
}) {
  const location = { tab: (tab ?? "cash") as ForecastTab, ...(scenarioId ? { scenarioId } : {}), ...(propertyId ? { propertyId } : {}), ...(legalEntityId ? { entityId: legalEntityId } : {}) };
  return <Forecasting identity={identity} organizationId={organizationId} location={location}
    onNavigate={next => onTabChange(next.tab, next.scenarioId)} onOrganizationChange={onNavigate} />;
}

export const AccountingEntryWithView = AccountingEntry as ComponentType<Parameters<typeof AccountingEntry>[0] & { view?: AccountingView }>;
