import { useQuery } from "@tanstack/react-query";
import type { FormValues, QuickAction } from "../rent-ops/form-payload";
import type { AdminSnapshot, ViewFilters } from "../rent-ops/types";
import { RecordLink } from "../rent-ops/workspace/entity-link";
import { DocumentsWorkspace } from "../rent-ops/workspace/documents-workspace";
import { selectedWorkspaceProperties, workspacePropertyMatches } from "../rent-ops/workspace/workspace-state";
import { workspacesApi } from "./api";
import { formatIsoDate, humanize } from "./format";
import { complianceRows } from "./models";
import { Badge, ErrorState, Loading, Section, StatePanel, selectOrganization, useCompanyContext } from "./page";

/** Properties › Documents & compliance: company documents by property, insurance currency, and tenant files. */
export function PropertyDocumentsPage({ identity, snapshot, filters, organizationId, onEdit, onChanged }: {
  identity: string; snapshot: AdminSnapshot; filters: ViewFilters; organizationId?: string;
  onEdit: (action: QuickAction, values?: FormValues) => void; onChanged: () => void;
}) {
  const context = useCompanyContext(identity);
  const organization = context.data ? selectOrganization(context.data.organizations, organizationId) : undefined;
  const propertyIds = selectedWorkspaceProperties(filters);
  const documents = useQuery({
    queryKey: ["rent-ops-workspace", "property-documents", identity, organization?.id ?? "", propertyIds],
    queryFn: ({ signal }) => workspacesApi.propertyDocuments(organization!.id, { asOf: filters.asOfDate, propertyIds }, signal),
    enabled: Boolean(organization), staleTime: 60_000, retry: false,
  });
  const properties = snapshot.snapshot.properties.filter(property => (filters.propertyScope === "all" || property.state === "active") && workspacePropertyMatches(filters, property.id));
  const rows = documents.data ? complianceRows(documents.data.documents, properties, filters.asOfDate) : [];
  return <div className="ws-page">
    <Section title="Company documents" id="property-docs-company" count={documents.data?.documents.length}>
      {!organization ? (context.isLoading ? <Loading label="Loading company documents…" /> : <StatePanel title="Choose a company" message="Company documents appear when a company is selected or you have access to one." />)
        : documents.error ? <ErrorState error={documents.error} onRetry={() => void documents.refetch()} />
        : !documents.data ? <Loading label="Loading company documents…" />
        : <table className="ws-table">
          <thead><tr><th scope="col">Property</th><th scope="col" className="number">Documents</th><th scope="col">Latest insurance document</th></tr></thead>
          <tbody>{rows.map(row => <tr key={row.propertyId}>
            <td><RecordLink kind="property" recordId={row.propertyId}>{row.propertyName}</RecordLink></td>
            <td className="number">{row.documentCount}</td>
            <td>{row.insuranceDated ? <>{formatIsoDate(row.insuranceDated)} {row.insuranceAgeDays !== null && row.insuranceAgeDays > 365 && <Badge tone="warning">Over a year old</Badge>}</> : <Badge tone="warning">None on file</Badge>}</td>
          </tr>)}</tbody>
        </table>}
      {documents.data && documents.data.documents.length > 0 && <details className="ws-details"><summary>All company documents</summary>
        <table className="ws-table">
          <thead><tr><th scope="col">Title</th><th scope="col">Property</th><th scope="col">Kind</th><th scope="col">Dated</th></tr></thead>
          <tbody>{documents.data.documents.map(document => <tr key={document.id}><td>{document.title}</td><td>{document.propertyName ?? "—"}</td><td>{humanize(document.kind)}</td><td>{formatIsoDate(document.documentDate)}</td></tr>)}</tbody>
        </table>
        {documents.data.truncated && <p className="ws-note">Showing the first 500 documents. Select properties to narrow the list.</p>}
      </details>}
    </Section>
    <Section title="Tenant documents and activity" id="property-docs-rental">
      <DocumentsWorkspace snapshot={snapshot} filters={filters} onEdit={onEdit} onChanged={onChanged} />
    </Section>
  </div>;
}
