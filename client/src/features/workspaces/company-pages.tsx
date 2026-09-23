import { useState, type ReactNode } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { PEOPLE_ROLES, type CompanySettings } from "@shared/workspaces/contracts";
import { EntityLink, RecordLink } from "../rent-ops/workspace/entity-link";
import type { Transparency } from "../rent-ops/workspace/top-navigation";
import { workspacesApi } from "./api";
import { formatIsoDate, humanize } from "./format";
import { Badge, CompanyGate, ErrorState, Loading, Section, Segmented, StatePanel } from "./page";
import { qboStatusLabel } from "./models";

interface CompanyPageProps { identity: string; organizationId?: string; asOfDate: string; onOrganization: (organizationId: string) => void }

/** Company › Entities & ownership: legal entities, dated property assignments and QuickBooks state. */
export function EntitiesPage({ identity, organizationId, asOfDate, onOrganization, onOpenAccounting }: CompanyPageProps & { onOpenAccounting: (organizationId: string) => void }) {
  return <CompanyGate identity={identity} organizationId={organizationId} onOrganization={onOrganization} loadingLabel="Loading entities…">
    {(organization, selector) => <EntitiesContent identity={identity} organizationId={organization.id} asOfDate={asOfDate} selector={selector} onOpenAccounting={() => onOpenAccounting(organization.id)} />}
  </CompanyGate>;
}

function EntitiesContent({ identity, organizationId, asOfDate, selector, onOpenAccounting }: { identity: string; organizationId: string; asOfDate: string; selector: ReactNode; onOpenAccounting: () => void }) {
  const [showPast, setShowPast] = useState(false);
  const directory = useQuery({ queryKey: ["rent-ops-workspace", "entities", identity, organizationId, asOfDate], queryFn: ({ signal }) => workspacesApi.entities(organizationId, asOfDate, signal), staleTime: 60_000, retry: false });
  if (directory.error) return <ErrorState error={directory.error} onRetry={() => void directory.refetch()} />;
  if (!directory.data) return <Loading label="Loading entities…" />;
  const { entities, unmappedProperties } = directory.data;
  return <div className="ws-page">
    <div className="ws-toolbar">{selector}<label className="ws-check"><input type="checkbox" checked={showPast} onChange={event => setShowPast(event.currentTarget.checked)} />Show past assignments</label></div>
    {!entities.length ? <StatePanel title="No entities" message="Your access does not include a whole legal entity." /> : entities.map(entity => {
      const production = entity.qbo.find(binding => binding.environment === "production") ?? entity.qbo[0];
      const status = qboStatusLabel(production);
      const properties = entity.properties.filter(property => showPast || property.current);
      return <Section key={entity.id} id={`entity-${entity.id}`} title={entity.name} count={humanize(entity.entityType)}
        actions={<><Badge tone={status.tone}>QuickBooks: {status.label}</Badge><button type="button" className="ws-link" onClick={onOpenAccounting}>Accounting</button></>}>
        {properties.length ? <table className="ws-table">
          <thead><tr><th scope="col">Property</th><th scope="col">From</th><th scope="col">Until</th><th scope="col">Status</th></tr></thead>
          <tbody>{properties.map(property => <tr key={`${property.propertyId}:${property.effectiveFrom}`}>
            <td><RecordLink kind="property" recordId={property.propertyId}>{property.propertyName ?? property.propertyId}</RecordLink></td>
            <td>{formatIsoDate(property.effectiveFrom)}</td>
            <td>{property.effectiveUntil ? formatIsoDate(property.effectiveUntil) : "Open"}</td>
            <td>{property.current ? "Current" : property.effectiveFrom > asOfDate ? "Scheduled" : "Ended"}</td>
          </tr>)}</tbody>
        </table> : <p className="ws-note">No properties assigned{showPast ? "" : " on this date"}.</p>}
        {production?.companyName && <details className="ws-details"><summary>QuickBooks company</summary><p>{production.companyName}{production.realmId ? ` · Realm ${production.realmId}` : ""}{production.confirmedAt ? ` · Confirmed ${formatIsoDate(production.confirmedAt)}` : ""}</p></details>}
      </Section>;
    })}
    {unmappedProperties.length > 0 && <Section title="Properties without an entity" id="entities-unmapped" count={unmappedProperties.length}>
      <ul className="ws-list">{unmappedProperties.map(property => <li key={property.propertyId}><RecordLink kind="property" recordId={property.propertyId}>{property.propertyName ?? property.propertyId}</RecordLink></li>)}</ul>
    </Section>}
  </div>;
}

/** Company › People & vendors: company contacts with dated roles, plus QuickBooks vendors. */
export function PeoplePage({ identity, organizationId, asOfDate, onOrganization }: CompanyPageProps) {
  return <CompanyGate identity={identity} organizationId={organizationId} onOrganization={onOrganization} loadingLabel="Loading people…">
    {(organization, selector) => <PeopleContent identity={identity} organizationId={organization.id} asOfDate={asOfDate} selector={selector} />}
  </CompanyGate>;
}

function PeopleContent({ identity, organizationId, asOfDate, selector }: { identity: string; organizationId: string; asOfDate: string; selector: ReactNode }) {
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("");
  const [view, setView] = useState<"contacts" | "vendors">("contacts");
  const people = useInfiniteQuery({
    queryKey: ["rent-ops-workspace", "people", identity, organizationId, search.trim(), role, asOfDate],
    queryFn: ({ pageParam, signal }) => workspacesApi.people(organizationId, { search: search.trim() || undefined, role: role || undefined, cursor: pageParam, asOf: asOfDate }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
    staleTime: 30_000, retry: false,
  });
  const contacts = people.data?.pages.flatMap(page => page.contacts) ?? [];
  const vendors = people.data?.pages[0]?.vendors ?? [];
  return <div className="ws-page">
    <div className="ws-toolbar">
      {selector}
      <Segmented label="Directory" value={view} onChange={setView} options={[["contacts", "Contacts"], ["vendors", "QuickBooks vendors"]]} />
      <label className="ws-search"><Search size={14} aria-hidden="true" /><input aria-label="Search people" placeholder="Search names" value={search} onChange={event => setSearch(event.currentTarget.value)} /></label>
      {view === "contacts" && <label className="ws-field">Role<select value={role} onChange={event => setRole(event.currentTarget.value)}><option value="">All roles</option>{PEOPLE_ROLES.map(item => <option key={item} value={item}>{humanize(item)}</option>)}</select></label>}
    </div>
    {people.error ? <ErrorState error={people.error} onRetry={() => void people.refetch()} /> : !people.data ? <Loading label="Loading people…" />
      : view === "contacts" ? (contacts.length ? <>
        <table className="ws-table">
          <thead><tr><th scope="col">Name</th><th scope="col">Roles</th><th scope="col">Rental record</th></tr></thead>
          <tbody>{contacts.map(contact => <tr key={contact.id}>
            <td>{contact.displayName}</td>
            <td>{contact.roles.length ? contact.roles.map(item => `${humanize(item.role)}${item.legalEntityName ? ` · ${item.legalEntityName}` : ""}${item.effectiveUntil && item.effectiveUntil <= asOfDate ? " (ended)" : ""}`).join("; ") : "—"}</td>
            <td>{contact.rentOpsPersonId ? <EntityLink personId={contact.rentOpsPersonId}>Open tenant record</EntityLink> : "—"}</td>
          </tr>)}</tbody>
        </table>
        {people.hasNextPage && <button type="button" className="rm-button" disabled={people.isFetchingNextPage} onClick={() => void people.fetchNextPage()}>{people.isFetchingNextPage ? "Loading…" : "Show more"}</button>}
      </> : <StatePanel title="No contacts" message={search || role ? "No contacts match these filters." : "Company contacts appear here once they are recorded."} />)
      : vendors.length ? <>
        <table className="ws-table">
          <thead><tr><th scope="col">Vendor</th><th scope="col">Entity</th><th scope="col">Status</th></tr></thead>
          <tbody>{vendors.map(vendor => <tr key={`${vendor.legalEntityName}:${vendor.providerObjectId}`}><td>{vendor.displayName}</td><td>{vendor.legalEntityName}</td><td>{vendor.active ? "Active" : "Inactive"}</td></tr>)}</tbody>
        </table>
        {people.data.pages[0]?.vendorsTruncated && <p className="ws-note">Showing the first 100 vendors. Search to narrow the list.</p>}
      </> : <StatePanel title="No QuickBooks vendors" message="Vendors appear after a QuickBooks company is connected and synced." />}
  </div>;
}

/** Company › Settings: appearance, integration status and read-only access. */
export function SettingsPage({ identity, organizationId, asOfDate, onOrganization, transparency, onTransparency, onOpenAccounting, onOpenTime }: CompanyPageProps & {
  transparency: Transparency; onTransparency: (value: Transparency) => void; onOpenAccounting: (organizationId: string) => void; onOpenTime: (organizationId: string) => void;
}) {
  void asOfDate;
  return <div className="ws-page">
    <Section title="Appearance" id="settings-appearance">
      <div className="ws-toolbar"><Segmented label="Transparency" value={transparency} onChange={onTransparency} options={[["system", "System"], ["reduced", "Reduced"]]} /></div>
    </Section>
    <CompanyGate identity={identity} organizationId={organizationId} onOrganization={onOrganization} loadingLabel="Loading settings…">
      {(organization, selector) => <SettingsContent identity={identity} organizationId={organization.id} selector={selector} onOpenAccounting={() => onOpenAccounting(organization.id)} onOpenTime={() => onOpenTime(organization.id)} />}
    </CompanyGate>
  </div>;
}

function SettingsContent({ identity, organizationId, selector, onOpenAccounting, onOpenTime }: { identity: string; organizationId: string; selector: ReactNode; onOpenAccounting: () => void; onOpenTime: () => void }) {
  const settings = useQuery({ queryKey: ["rent-ops-workspace", "company-settings", identity, organizationId], queryFn: ({ signal }) => workspacesApi.settings(organizationId, signal), staleTime: 60_000, retry: false });
  if (settings.error) return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  if (!settings.data) return <Loading label="Loading settings…" />;
  const data: CompanySettings = settings.data;
  return <>
    {selector && <div className="ws-toolbar">{selector}</div>}
    <Section title="Integrations" id="settings-integrations" actions={<><button type="button" className="ws-link" onClick={onOpenAccounting}>QuickBooks</button><button type="button" className="ws-link" onClick={onOpenTime}>Time</button></>}>
      {data.qbo.length || data.time.length ? <table className="ws-table">
        <thead><tr><th scope="col">Service</th><th scope="col">Entity</th><th scope="col">Status</th></tr></thead>
        <tbody>
          {data.qbo.map(binding => { const status = qboStatusLabel(binding); return <tr key={`qbo:${binding.legalEntityName}:${binding.environment}`}><td>QuickBooks Online</td><td>{binding.legalEntityName}</td><td><Badge tone={status.tone}>{status.label}</Badge></td></tr>; })}
          {data.time.map(connection => <tr key={`time:${connection.legalEntityName}:${connection.environment}:${connection.connectedAt}`}><td>QuickBooks Time</td><td>{connection.legalEntityName}</td><td><Badge tone={connection.status === "active" ? "positive" : connection.status === "needs_reconnect" ? "warning" : "critical"}>{connection.status === "active" ? "Connected" : connection.status === "needs_reconnect" ? "Reconnect needed" : "Disconnected"}{connection.environment === "sandbox" ? " · Sandbox" : ""}</Badge></td></tr>)}
        </tbody>
      </table> : <StatePanel title="No integrations connected" message="Connect QuickBooks from Accounting to sync books for an entity." action={{ label: "Open Accounting", onClick: onOpenAccounting }} />}
    </Section>
    <Section title="Access" id="settings-access" count={data.grants.length || undefined}>
      {data.grants.length ? <table className="ws-table">
        <thead><tr><th scope="col">User</th><th scope="col">Role</th><th scope="col">Scope</th><th scope="col">Since</th></tr></thead>
        <tbody>{data.grants.map(grant => <tr key={`${grant.actorId}:${grant.role}:${grant.legalEntityName}:${grant.propertyName}`}>
          <td>{grant.actorId}</td><td>{humanize(grant.role)}</td>
          <td>{grant.propertyName ? `${grant.legalEntityName} · ${grant.propertyName}` : grant.legalEntityName ?? "Whole company"}</td>
          <td>{formatIsoDate(grant.createdAt)}</td>
        </tr>)}</tbody>
      </table> : <p className="ws-note">Access lists are visible to company-wide administrators.</p>}
    </Section>
  </>;
}
