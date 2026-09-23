import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CompanyContextOrganization } from "@shared/company/context";
import { projectListResponseSchema } from "@shared/projects/contracts";
import { downloadRentOpsDocument, loadRentOpsWorkspaceCollection } from "../rent-ops/api";
import { rentOpsAuthClient } from "../rent-ops/auth";
import type { AdminSnapshot } from "../rent-ops/types";
import { EntityLink, RecordLink } from "../rent-ops/workspace/entity-link";
import { workspacesApi } from "./api";
import { formatCentsText, formatIsoDate, humanize, opensInline } from "./format";
import { Badge, ErrorState, Loading, Section, StatePanel, propertyEntity, selectOrganization, useCompanyContext } from "./page";
import { useOpenWorkOrders } from "./work-data";

/** The property's company and entity; property tabs show a clear state when either is missing. */
function usePropertyCompany(identity: string, propertyId: string, organizationId?: string): { organization?: CompanyContextOrganization; legalEntityId?: string; loading: boolean; error: unknown } {
  const context = useCompanyContext(identity);
  const organizations = context.data?.organizations ?? [];
  const organization = selectOrganization(organizations, organizationId)
    ?? organizations.find(candidate => candidate.entities.some(entity => entity.properties.some(property => property.id === propertyId)));
  return { organization, legalEntityId: propertyEntity(organization, propertyId), loading: context.isLoading, error: context.error };
}

const unmapped = <StatePanel title="Not assigned to a company" message="Assign this property to a legal entity to see its company records." />;

/** Property record › Projects. */
export function PropertyProjectsTab({ identity, propertyId, organizationId, onOpenProject, onNewProject }: {
  identity: string; propertyId: string; organizationId?: string; onOpenProject: (organizationId: string, projectId: string) => void; onNewProject: (organizationId: string) => void;
}) {
  const company = usePropertyCompany(identity, propertyId, organizationId);
  const projects = useQuery({
    queryKey: ["rent-ops-workspace", "property-projects", identity, company.organization?.id ?? "", company.legalEntityId ?? "", propertyId],
    enabled: Boolean(company.organization && company.legalEntityId), staleTime: 30_000, retry: false,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ legalEntityId: company.legalEntityId!, propertyId, limit: "100" });
      const response = await rentOpsAuthClient.request(`/api/company/${encodeURIComponent(company.organization!.id)}/projects?${params}`, { signal });
      if (!response.ok) throw new Error(response.status === 403 ? "Your company access does not include this property's projects." : "Projects could not be loaded.");
      return projectListResponseSchema.parse(await response.json());
    },
  });
  if (company.error) return <ErrorState error={company.error} />;
  if (company.loading) return <Loading label="Loading projects…" />;
  if (!company.organization || !company.legalEntityId) return unmapped;
  if (projects.error) return <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />;
  if (!projects.data) return <Loading label="Loading projects…" />;
  const organization = company.organization;
  return <Section title="Projects" id="property-projects" count={projects.data.items.length} actions={<button type="button" className="rm-button" onClick={() => onNewProject(organization.id)}>Open projects</button>}>
    {!projects.data.items.length ? <StatePanel title="No projects" message="Projects for this property appear here." /> : <table className="ws-table">
      <thead><tr><th scope="col">Project</th><th scope="col">Status</th><th scope="col">Target</th><th scope="col" className="number">Approved budget</th><th scope="col" className="number">Posted costs</th></tr></thead>
      <tbody>{projects.data.items.map(project => <tr key={project.id}>
        <td><button type="button" className="ws-link" onClick={() => onOpenProject(organization.id, project.id)}>{project.name}</button></td>
        <td>{humanize(project.status)}</td>
        <td>{formatIsoDate(project.targetOn)}</td>
        <td className="number">{project.approvedBudgetCents === null ? "Not approved" : formatCentsText(project.approvedBudgetCents, project.currency)}</td>
        <td className="number">{formatCentsText(project.postedActualCents, project.currency)}</td>
      </tr>)}</tbody>
    </table>}
  </Section>;
}

/** Property record › Work orders. */
export function PropertyWorkOrdersTab({ identity, propertyId, organizationId, onOpenWorkOrder }: {
  identity: string; propertyId: string; organizationId?: string; onOpenWorkOrder: (organizationId: string, workOrderId?: string) => void;
}) {
  const company = usePropertyCompany(identity, propertyId, organizationId);
  const work = useOpenWorkOrders(identity, company.legalEntityId ? company.organization?.id : undefined, company.legalEntityId ? { legalEntityId: company.legalEntityId, propertyId } : undefined, true);
  if (company.error) return <ErrorState error={company.error} />;
  if (company.loading) return <Loading label="Loading work orders…" />;
  if (!company.organization || !company.legalEntityId) return unmapped;
  if (work.error) return <ErrorState error={work.error} onRetry={() => void work.refetch()} />;
  if (!work.data) return <Loading label="Loading work orders…" />;
  const organization = company.organization;
  const open = work.data.items.filter(item => item.status !== "completed" && item.status !== "canceled");
  const closed = work.data.items.filter(item => item.status === "completed").slice(0, 25);
  const table = (items: typeof open) => <table className="ws-table">
    <thead><tr><th scope="col">Work order</th><th scope="col">Unit</th><th scope="col">Priority</th><th scope="col">Status</th><th scope="col">Scheduled</th></tr></thead>
    <tbody>{items.map(item => <tr key={item.id}>
      <td><button type="button" className="ws-link" onClick={() => onOpenWorkOrder(organization.id, item.id)}>{item.title}</button></td>
      <td>{item.unitId ? <RecordLink kind="unit" recordId={item.unitId}>{item.unitNumber ?? "Unit"}</RecordLink> : "Common area"}</td>
      <td>{item.priority === "emergency" || item.priority === "high" ? <Badge tone={item.priority === "emergency" ? "critical" : "warning"}>{humanize(item.priority)}</Badge> : humanize(item.priority)}</td>
      <td>{humanize(item.status)}</td>
      <td>{item.completedOn ? `Done ${formatIsoDate(item.completedOn)}` : formatIsoDate(item.scheduledOn)}</td>
    </tr>)}</tbody>
  </table>;
  return <>
    <Section title="Open work" id="property-work-open" count={open.length} actions={<button type="button" className="rm-button" onClick={() => onOpenWorkOrder(organization.id)}>Open work orders</button>}>
      {open.length ? table(open) : <StatePanel title="No open work" message="Open work orders for this property appear here." />}
    </Section>
    {closed.length > 0 && <Section title="Recently completed" id="property-work-closed" count={closed.length}>{table(closed)}</Section>}
  </>;
}

/** Property record › Documents: rental documents for the property and company documents linked to it. */
export function PropertyDocumentsTab({ identity, propertyId, organizationId, snapshot, asOfDate }: { identity: string; propertyId: string; organizationId?: string; snapshot: AdminSnapshot; asOfDate: string }) {
  const company = usePropertyCompany(identity, propertyId, organizationId);
  const rental = useQuery({
    queryKey: ["rent-ops-workspace", "collection", "documents", identity, "property", propertyId, asOfDate],
    queryFn: ({ signal }) => loadRentOpsWorkspaceCollection("documents", { propertyScope: "all", propertyId, asOfDate }, signal),
    staleTime: 60_000, retry: false,
  });
  const companyDocuments = useQuery({
    queryKey: ["rent-ops-workspace", "property-documents", identity, company.organization?.id ?? "", propertyId],
    queryFn: ({ signal }) => workspacesApi.propertyDocuments(company.organization!.id, { asOf: asOfDate, propertyIds: [propertyId] }, signal),
    enabled: Boolean(company.organization), staleTime: 60_000, retry: false,
  });
  const [downloadError, setDownloadError] = useState<string>();
  const openDocument = async (documentId: string, fileName: string) => {
    setDownloadError(undefined);
    try {
      const blob = await downloadRentOpsDocument(documentId);
      const url = URL.createObjectURL(blob);
      if (opensInline(blob.type)) window.open(url, "_blank", "noopener");
      else { const anchor = window.document.createElement("a"); anchor.href = url; anchor.download = fileName; anchor.click(); }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) {
      setDownloadError(cause instanceof Error ? cause.message : "Secure document download is unavailable.");
    }
  };
  const people = new Map(snapshot.snapshot.people.map(person => [person.id, person]));
  const rentalRows = (rental.data ?? []).filter(document => document.propertyId === propertyId);
  return <>
    <Section title="Tenant and lease documents" id="property-docs-rental" count={rental.data ? rentalRows.length : undefined}>
      {downloadError && <p className="ws-note" role="alert">{downloadError}</p>}
      {rental.error ? <ErrorState error={rental.error} onRetry={() => void rental.refetch()} /> : !rental.data ? <Loading label="Loading documents…" />
        : !rentalRows.length ? <StatePanel title="No tenant documents" message="Leases and tenant files for this property appear here." />
        : <table className="ws-table">
          <thead><tr><th scope="col">File</th><th scope="col">Type</th><th scope="col">Tenant</th><th scope="col">Uploaded</th></tr></thead>
          <tbody>{rentalRows.map(document => { const person = document.personId ? people.get(document.personId) : undefined; return <tr key={document.id}>
            <td>{document.id && document.downloadAvailable ? <button type="button" className="ws-link" onClick={() => void openDocument(document.id!, document.fileName ?? "document")}>{document.fileName ?? "Document"}</button> : document.fileName ?? "Document"}</td>
            <td>{humanize(document.type)}</td>
            <td>{person ? <EntityLink personId={person.id} tab="documents">{[person.firstName, person.lastName].filter(Boolean).join(" ") || "Tenant"}</EntityLink> : "—"}</td>
            <td>{formatIsoDate(document.uploadedAt)}</td>
          </tr>; })}</tbody>
        </table>}
    </Section>
    <Section title="Company documents" id="property-docs-company" count={companyDocuments.data?.documents.length}>
      {!company.organization ? (company.loading ? <Loading label="Loading company documents…" /> : unmapped)
        : companyDocuments.error ? <ErrorState error={companyDocuments.error} onRetry={() => void companyDocuments.refetch()} />
        : !companyDocuments.data ? <Loading label="Loading company documents…" />
        : !companyDocuments.data.documents.length ? <StatePanel title="No company documents" message="Insurance, loan and contract documents linked to this property appear here." />
        : <table className="ws-table">
          <thead><tr><th scope="col">Title</th><th scope="col">Kind</th><th scope="col">Dated</th><th scope="col">File</th></tr></thead>
          <tbody>{companyDocuments.data.documents.map(document => <tr key={document.id}><td>{document.title}</td><td>{humanize(document.kind)}</td><td>{formatIsoDate(document.documentDate)}</td><td>{document.fileName}</td></tr>)}</tbody>
        </table>}
    </Section>
  </>;
}
