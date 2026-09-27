import { useState, type FormEvent, type ReactNode } from "react";
import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QboCustomerLedger } from "@shared/accounting/receivables";
import type { TenantSourceResolution } from "@shared/accounting/tenant-source-resolution";
import { AccountingApiError, accountingApi } from "../../accounting/api";
import type { AccountingApi, AccountingConnection } from "../../accounting/types";
import {
  agingRows,
  coverageDisplay,
  customerLedgerRows,
  customerOptionLabel,
  filterCustomers,
  ledgerTotals,
  openItemRows,
  verificationDisplay,
  type LedgerTone,
  type QboTarget,
} from "../../accounting/customer-ledger";
import type { CompanyContext } from "@shared/company/context";
import { rentOpsAuthClient } from "../auth";
import type { AdminSnapshot, AdminTenancyView, TenantView } from "../types";
import { isCurrentTenancy, resolveTenantContext } from "./tenant-model";
import { formatLongDate } from "../../../lib/rent-ops-formatters";

/*
 * The tenancy's QuickBooks customer ledger, read from the verified receivables
 * mirror (never from QuickBooks during the request). It sits beside the
 * RM-imported 5Central Ops ledger and never alters or merges with it. Linking
 * writes only the local identity map; nothing is written to QuickBooks.
 */

const QUERY_ROOT = "rent-ops-qbo-ledger";

/** Same query as review-cases' useCompanyContext (shared cache key), without its stylesheet side effect. */
function useCompanyContext() {
  return useQuery({
    queryKey: ["company-context", "lane-c"],
    queryFn: async ({ signal }): Promise<CompanyContext> => {
      const response = await rentOpsAuthClient.request("/api/company/context", { signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("Company records could not be loaded.");
      return response.json();
    },
    staleTime: 30_000,
    retry: false,
  });
}

function toneClass(tone: LedgerTone): string {
  return tone === "good" ? "rm-status rm-status-good" : "rm-status rm-status-warning";
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function tenancyLabel(tenancy: AdminTenancyView, snapshot: AdminSnapshot): string {
  const property = snapshot.snapshot.properties.find(candidate => candidate.id === tenancy.propertyId)?.name ?? "Property unknown";
  const unit = snapshot.snapshot.units.find(candidate => candidate.id === tenancy.unitId)?.unitNumber;
  const moveIn = tenancy.actualMoveInOn ?? tenancy.plannedMoveInOn;
  const status = isCurrentTenancy(tenancy, snapshot.summary.asOfDate) ? "current" : tenancy.status ?? "past";
  return `${property}${unit ? ` · Unit ${unit}` : ""}${moveIn ? ` · from ${formatLongDate(moveIn) ?? moveIn}` : ""} (${status})`;
}

function Notice({ tone, title, children }: { tone: "info" | "warning" | "error" | "notice"; title: string; children?: ReactNode }) {
  return <div className={`rm-${tone}`} role={tone === "error" ? "alert" : "status"}><div><strong>{title}</strong>{children}</div></div>;
}

function sourceEntityLabel(source: TenantSourceResolution): string {
  return source.ownership.effectiveLegalEntityName
    ?? source.qbo.binding?.providerCompanyName
    ?? "the historical legal entity";
}

function sourceTarget(source: TenantSourceResolution, organization: CompanyContext["organizations"][number] | undefined): QboTarget | null {
  const scope = source.qbo.scope;
  if (!scope || (source.currentState !== "linked" && source.currentState !== "unlinked")) return null;
  return {
    organizationId: scope.organizationId,
    organizationName: organization?.name ?? scope.organizationId,
    legalEntityId: scope.legalEntityId,
    entityName: sourceEntityLabel(source),
    canLink: organization?.role === "owner" || organization?.role === "admin" || organization?.role === "finance",
  };
}

function sourceConnections(source: TenantSourceResolution): readonly AccountingConnection[] {
  const scope = source.qbo.scope;
  const connection = source.qbo.connection;
  if (!scope || !connection || (connection.state !== "active" && connection.state !== "needs_reconnect") || !connection.readCapabilityEnabled) return [];
  return [{
    scope,
    name: source.qbo.binding?.providerCompanyName ?? "QuickBooks Online",
    status: connection.state === "needs_reconnect" ? "needs_reconnect" : "ready",
    version: 1,
    accessTokenExpiresAt: "",
    refreshTokenExpiresAt: null,
    refreshTokenHardExpiresAt: null,
    updatedAt: connection.updatedAt ?? "",
  }];
}

function LocalHistoryNotice({ source }: { source: TenantSourceResolution }) {
  const hasHistoricalQboLink = source.qbo.customerLink !== null;
  return <Notice tone={hasHistoricalQboLink ? "warning" : "info"} title={hasHistoricalQboLink ? "QuickBooks connection needs attention" : "Historical records remain in R-ops"}>{" "}{hasHistoricalQboLink ? "A historical QuickBooks customer link exists, but QuickBooks can't be read right now. Use the Ledger tab meanwhile." : "This tenancy's history is on the Ledger and Deposits tabs."}</Notice>;
}

function SourceReasons({ source }: { source: TenantSourceResolution }) {
  return source.reasons.length > 0 ? <ul>{source.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : null;
}

function sourceNotFound(error: unknown): boolean {
  return error instanceof AccountingApiError && error.status === 404 && error.code === "accounting_not_found";
}

function isResolvedHistoricalOwner(source: TenantSourceResolution): boolean {
  return source.ownership.state === "resolved"
    && source.ownership.coverageComplete
    && source.ownership.effectiveLegalEntityId !== null
    && source.ownership.periods.some(period => period.overlapsTenancy);
}

function isLinkedDatesMissingSource(source: TenantSourceResolution): boolean {
  return source.ownership.state === "linked_dates_missing"
    && !source.ownership.coverageComplete
    && source.ownership.effectiveLegalEntityId === null
    && source.qbo.customerLink !== null
    && source.qbo.scope !== null
    && source.qbo.customerLink.legalEntityId === source.qbo.scope.legalEntityId;
}

function canUseLinkedDatesMissingSource(sources: readonly TenantSourceResolution[]): boolean {
  const candidates = sources.filter(isLinkedDatesMissingSource);
  if (candidates.length !== 1) return false;
  const candidate = candidates[0]!;

  // Missing dates cannot distinguish an old link from another organization's
  // mapped ownership history. Require this linked source to be the only
  // organization with ownership evidence or an existing QBO customer link.
  return sources.every(source => source === candidate || (
    source.ownership.state !== "review"
    && source.currentState !== "ownership_review"
    && source.ownership.periods.length === 0
    && source.ownership.effectiveLegalEntityId === null
    && source.qbo.customerLink === null
    && source.currentState !== "linked"
  ));
}

function sourceReviewReasons(sources: readonly TenantSourceResolution[]): readonly string[] {
  const reasons = new Set(sources.flatMap(source => source.reasons));
  if (sources.some(isLinkedDatesMissingSource) && !canUseLinkedDatesMissingSource(sources)) {
    reasons.add("Another organization's mapped ownership history or existing QuickBooks link prevents confirmation of this tenancy's historical owner.");
  }
  if (sources.filter(isResolvedHistoricalOwner).length > 1) {
    reasons.add("More than one accounting organization returned a fully covered historical owner for this tenancy; review ownership before selecting a QuickBooks company.");
  }
  if (reasons.size === 0) reasons.add("The historical accounting owner could not be resolved to one QuickBooks company; review ownership before selecting a QuickBooks company.");
  return Array.from(reasons).slice(0, 10);
}

export function TenantQuickBooksPanel({ tenant, snapshot, readOnly = false, api = accountingApi }: { tenant: TenantView; snapshot: AdminSnapshot; readOnly?: boolean; api?: AccountingApi }) {
  const context = resolveTenantContext(tenant, snapshot);
  const tenancies = context.tenancies.filter((tenancy): tenancy is AdminTenancyView & { id: string } => Boolean(tenancy.id));
  const [tenancyId, setTenancyId] = useState(() => context.currentTenancy?.id ?? tenancies[0]?.id ?? "");
  const tenancy = tenancies.find(candidate => candidate.id === tenancyId);
  const company = useCompanyContext();
  const organizations = company.data?.organizations ?? [];
  const sourceQueries = useQueries({
    queries: organizations.map(organization => ({
      queryKey: [QUERY_ROOT, "source-resolution", organization.id, tenancy?.id],
      queryFn: ({ signal }: { signal: AbortSignal }) => api.tenancySourceResolution(organization.id, { tenancyId: tenancy!.id }, signal),
      enabled: Boolean(tenancy?.id), staleTime: 30_000, retry: false,
    })),
  });
  const sourceData = sourceQueries.flatMap(query => query.data ? [query.data] : []);
  const allSourceQueriesFetched = sourceQueries.length > 0 && sourceQueries.every(query => query.isFetched);
  const resolvedSources = sourceData.filter(isResolvedHistoricalOwner);
  const linkedDatesMissingSources = sourceData.filter(isLinkedDatesMissingSource);
  const linkedDatesMissingAllowed = canUseLinkedDatesMissingSource(sourceData);
  const sourceSelection = !allSourceQueriesFetched
    ? { kind: "pending" as const }
    : linkedDatesMissingSources.length > 0
      ? linkedDatesMissingAllowed
        ? { kind: "linked_dates_missing" as const, source: linkedDatesMissingSources[0]! }
        : { kind: "ownership_review" as const, reasons: sourceReviewReasons(sourceData) }
      : resolvedSources.length === 1
      ? { kind: "resolved" as const, source: resolvedSources[0]! }
      : sourceData.length === 0
        ? { kind: "unassigned" as const }
        : { kind: "ownership_review" as const, reasons: sourceReviewReasons(sourceData) };
  const resolution = sourceSelection.kind === "resolved" || sourceSelection.kind === "linked_dates_missing" ? sourceSelection.source : undefined;
  const sourceError = sourceQueries.find(query => query.error && !sourceNotFound(query.error))?.error ?? null;
  const sourceQueryForRetry = sourceQueries.find(query => query.error && !sourceNotFound(query.error)) ?? sourceQueries[0];
  const target = resolution ? sourceTarget(resolution, company.data?.organizations.find(candidate => candidate.id === resolution.qbo.scope?.organizationId)) : null;
  const connections = resolution ? sourceConnections(resolution) : [];
  const environment = resolution?.qbo.environment ?? null;
  const sourceConnectionReady = Boolean(resolution && (resolution.qbo.connection?.state === "active" || resolution.qbo.connection?.state === "needs_reconnect") && resolution.qbo.connection.readCapabilityEnabled);

  const picker = tenancies.length > 1 && <div className="rm-ledger-filters"><label>Tenancy<select value={tenancyId} onChange={event => setTenancyId(event.target.value)}>{tenancies.map(candidate => <option key={candidate.id} value={candidate.id}>{tenancyLabel(candidate, snapshot)}</option>)}</select></label></div>;

  let body: ReactNode;
  if (!tenancy) body = <div className="rm-empty"><p>No tenancy is linked to this tenant, so there is no QuickBooks customer history to show.</p></div>;
  else if (company.error) body = <Notice tone="error" title="Company records could not be loaded.">{" "}<button type="button" className="rm-button" onClick={() => void company.refetch()}>Try again</button></Notice>;
  else if (!company.data) body = <div className="rm-empty" role="status"><p>Loading QuickBooks access…</p></div>;
  else if (organizations.length === 0) body = <Notice tone="notice" title="QuickBooks source is not assigned">{" "}No QuickBooks company is set up yet. The Ledger tab has this tenancy's history.</Notice>;
  else if (sourceError) body = <Notice tone="error" title={messageOf(sourceError, "The tenancy accounting source could not be resolved.")}>{" "}<button type="button" className="rm-button" onClick={() => void sourceQueryForRetry?.refetch()}>Try again</button></Notice>;
  else if (sourceSelection.kind === "unassigned") body = <Notice tone="notice" title="QuickBooks source is not assigned">{" "}No QuickBooks company covers this tenancy's dates. The Ledger tab has its history.</Notice>;
  else if (sourceSelection.kind === "pending") body = <div className="rm-empty" role="status"><p>Resolving the historical accounting source…</p></div>;
  else if (sourceSelection.kind === "ownership_review") body = <Notice tone="warning" title="Historical QuickBooks ownership needs review">{" "}QuickBooks history is hidden until the property's owner for these dates is confirmed. The local R-ops history remains available on the Ledger tab.<ul>{sourceSelection.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></Notice>;
  else if (sourceSelection.kind === "resolved" || sourceSelection.kind === "linked_dates_missing") {
    const source = sourceSelection.source;
    const linkedDatesMissing = sourceSelection.kind === "linked_dates_missing";
    if (source.currentState === "local_history_available") body = <>{linkedDatesMissing && <LinkedDatesMissingNotice source={source} />}<LocalHistoryNotice source={source} /></>;
    else if (source.currentState === "ownership_review") body = <Notice tone="warning" title="Historical QuickBooks ownership needs review">{" "}QuickBooks history is hidden until the property's owner for these dates is confirmed. The local R-ops history remains available on the Ledger tab.<SourceReasons source={source} /></Notice>;
    else if (source.currentState === "not_connected" || !sourceConnectionReady || !target) body = <>{linkedDatesMissing && <LinkedDatesMissingNotice source={source} />}<Notice tone="notice" title={`QuickBooks is not connected for ${sourceEntityLabel(source)}`}>{" "}The Ledger tab has this tenancy's history.</Notice></>;
    else body = <>{linkedDatesMissing && <LinkedDatesMissingNotice source={source} />}{source.qbo.connection?.state === "needs_reconnect" && <Notice tone="warning" title="QuickBooks needs to be reconnected">{" "}Showing the last synced copy for {target.entityName}.</Notice>}<TenancyLedger key={`${tenancy.id}:${environment}`} api={api} target={target} tenancyId={tenancy.id} environment={environment!} connections={connections} readOnly={readOnly} canCreateCustomerLink={source.currentState === "unlinked" && source.qbo.customerLink === null} sourceDateWarningShown={linkedDatesMissing} /></>;
  }

  return <div className="rm-tenant-tab-content"><section className="rm-panel rm-tenant-panel rops-qbo">{picker}{body}</section></div>;
}

function LinkedDatesMissingNotice({ source }: { source: TenantSourceResolution }) {
  const missingDates: string[] = [];
  if (source.tenancy.startOn === null) missingDates.push("Move-in date missing.");
  const openEndedStatus = source.tenancy.status === "current" || source.tenancy.status === "notice" || source.tenancy.status === "future";
  if (source.tenancy.endOn === null && !openEndedStatus) missingDates.push("Move-out/end date missing.");
  const detail = missingDates.length > 0
    ? `${missingDates.join(" ")} Add the missing date${missingDates.length === 1 ? "" : "s"} to confirm ownership.`
    : "The existing QuickBooks ledger is shown read-only while tenancy dates are checked. Add the missing dates to confirm ownership.";
  return <Notice tone="warning" title="Tenancy dates need confirmation">{" "}This tenancy has an existing QuickBooks customer link. {detail}</Notice>;
}

function TenancyLedger({ api, target, tenancyId, environment, connections, readOnly, canCreateCustomerLink, sourceDateWarningShown }: { api: AccountingApi; target: QboTarget; tenancyId: string; environment: "sandbox" | "production"; connections: readonly AccountingConnection[]; readOnly: boolean; canCreateCustomerLink: boolean; sourceDateWarningShown: boolean }) {
  const ledger = useInfiniteQuery({
    queryKey: [QUERY_ROOT, "tenancy-ledger", target.organizationId, tenancyId, environment],
    queryFn: ({ pageParam, signal }) => api.tenancyLedger(target.organizationId, { tenancyId, environment, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page?.page.nextCursor ?? undefined,
    staleTime: 30_000, retry: false,
  });
  const pages = ledger.data?.pages ?? [];
  if (ledger.isPending) return <div className="rm-empty" role="status"><p>Loading the QuickBooks customer ledger…</p></div>;
  if (ledger.error && pages.length === 0) return <Notice tone="error" title={messageOf(ledger.error, "The QuickBooks customer ledger could not be loaded.")}>{" "}<button type="button" className="rm-button" onClick={() => void ledger.refetch()}>Try again</button></Notice>;
  const first = pages[0];
  if (first === null || first === undefined) {
    return canCreateCustomerLink
      ? <AutoLinkThenPick api={api} target={target} tenancyId={tenancyId} environment={environment} connections={connections} readOnly={readOnly} />
      : <Notice tone="warning" title="The existing QuickBooks customer link could not be read">{" "}No new or replacement customer link is available from this screen. Review the linked customer and tenancy ownership before making changes.</Notice>;
  }
  const entries = pages.flatMap(page => page?.entries ?? []);
  return <LedgerView ledger={first} entries={entries} ownershipWarning={sourceDateWarningShown ? undefined : first.ownershipWarning} hasMore={ledger.hasNextPage} loadingMore={ledger.isFetchingNextPage} pageError={ledger.error} onMore={() => void ledger.fetchNextPage()} onReload={() => void ledger.refetch()} />;
}

function Stat({ label, children, tone }: { label: string; children: ReactNode; tone?: LedgerTone }) {
  return <div className={`rops-qbo-stat${tone && tone !== "good" ? ` is-${tone}` : ""}`}><dt>{label}</dt><dd>{children}</dd></div>;
}

function LedgerView({ ledger, entries, ownershipWarning, hasMore, loadingMore, pageError, onMore, onReload }: { ledger: QboCustomerLedger; entries: QboCustomerLedger["entries"]; ownershipWarning?: string; hasMore: boolean; loadingMore: boolean; pageError: unknown; onMore: () => void; onReload: () => void }) {
  const coverage = coverageDisplay(ledger.coverage, new Date());
  const verification = verificationDisplay(ledger.verification);
  const rows = customerLedgerRows(entries);
  const totals = ledgerTotals(ledger, coverage.amountsKnown);
  const ending = totals[totals.length - 1]!;
  const aging = agingRows(ledger.aging);
  const open = openItemRows(ledger.openItems);
  const status = verification.tone !== "good" ? verification : coverage.tone !== "good" ? { tone: coverage.tone, label: coverage.tone === "error" ? "Not read yet" : ledger.coverage.status === "partial" ? "Partial history" : "Out of date" } : { tone: "good" as const, label: "Matches QuickBooks" };
  const agingShown = aging && open.length > 0 ? aging.filter(item => item.amount !== "$0.00") : [];
  return <>
    {ownershipWarning && <Notice tone="warning" title="Tenancy dates need confirmation">{" "}{ownershipWarning}</Notice>}
    <dl className="rops-qbo-summary">
      <Stat label="QuickBooks customer"><strong>{ledger.customer.displayName ?? "Name not mirrored"}</strong><small>#{ledger.customer.objectId}{ledger.customer.active === false ? " · inactive" : ""}</small></Stat>
      <Stat label="Balance" tone={!coverage.amountsKnown ? "warning" : verification.tone}><strong className="rm-amount">{ending.amount}</strong></Stat>
      <Stat label="Status" tone={status.tone}><span className={toneClass(status.tone)}>{status.label}</span><small>Synced {coverage.asOfLabel}</small></Stat>
    </dl>
    {coverage.tone !== "good" && <Notice tone={coverage.tone === "error" ? "error" : "warning"} title={coverage.title}>{coverage.reasons.length > 0 && <ul>{coverage.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}</Notice>}
    {verification.tone === "error" && <Notice tone="error" title="The mirrored history does not match QuickBooks">{" "}{verification.detail}</Notice>}

    {rows.length === 0
      ? <p className="rops-qbo-empty">{coverage.amountsKnown ? "No QuickBooks invoices or payments for this customer yet." : "QuickBooks documents have not been read for this customer yet."}</p>
      : <section className="rops-qbo-section" aria-label="QuickBooks documents">
        <h4>Documents</h4>
        <div className="rm-table-wrap"><table className="rm-table rm-ledger-table">
          <caption className="sr-only">QuickBooks customer documents with running balance</caption>
          <thead><tr><th scope="col">Date</th><th scope="col">Type</th><th scope="col">Number</th><th scope="col" className="rm-align-right">Amount</th><th scope="col" className="rm-align-right">Applied</th><th scope="col" className="rm-align-right">Open</th><th scope="col" className="rm-align-right">Balance</th></tr></thead>
          <tbody>{rows.map(row => <tr key={row.key}><td>{row.date}</td><td>{row.type}{row.voided && <> <span className="rm-status rm-status-muted">Voided</span></>}</td><td className="rm-reference">{row.number}</td><td className="rm-align-right rm-amount">{row.amount}</td><td className="rm-align-right rm-amount">{row.applied}</td><td className="rm-align-right rm-amount">{row.open}</td><td className="rm-align-right rm-amount">{row.balance}</td></tr>)}</tbody>
          {!hasMore && <tfoot><tr><th scope="row" colSpan={6}>Ending balance</th><td className="rm-align-right rm-amount"><strong>{ending.amount}</strong></td></tr></tfoot>}
        </table></div>
        {hasMore && <div className="rm-ledger-toolbar"><span>{entries.length} of {ledger.page.total} documents</span><button type="button" className="rm-button" disabled={loadingMore} onClick={onMore}>{loadingMore ? "Loading…" : "Load more"}</button></div>}
        {pageError !== null && pageError !== undefined && <Notice tone="error" title={messageOf(pageError, "More documents could not be loaded.")}>{" "}<button type="button" className="rm-button" onClick={onReload}>Reload from the first page</button></Notice>}
        <dl className="rops-qbo-totals">{totals.slice(0, -1).map(item => <Stat key={item.label} label={item.label}>{<span className="rm-amount">{item.amount}</span>}</Stat>)}</dl>
      </section>}

    {open.length > 0 && <section className="rops-qbo-section" aria-label="QuickBooks open items">
      <h4>Open items</h4>
      {agingShown.length > 0 && <dl className="rops-qbo-totals">{agingShown.map(item => <Stat key={item.label} label={item.label}><span className="rm-amount">{item.amount}</span></Stat>)}</dl>}
      <div className="rm-table-wrap"><table className="rm-table">
        <caption className="sr-only">QuickBooks open items</caption>
        <thead><tr><th scope="col">Type</th><th scope="col">Number</th><th scope="col">Date</th><th scope="col">Due</th><th scope="col" className="rm-align-right">Open</th><th scope="col">Past due</th></tr></thead>
        <tbody>{open.map(item => <tr key={item.key}><td>{item.type}</td><td className="rm-reference">{item.number}</td><td>{item.date}</td><td>{item.due}</td><td className="rm-align-right rm-amount">{item.open}</td><td>{item.pastDue}</td></tr>)}</tbody>
      </table></div>
    </section>}
  </>;
}

/**
 * Links matching tenants automatically (name and address both match one
 * QuickBooks customer). Runs once per company per session; the manual picker
 * shows only when this tenancy still has no unique match.
 */
function AutoLinkThenPick({ api, target, tenancyId, environment, connections, readOnly }: { api: AccountingApi; target: QboTarget; tenancyId: string; environment: "sandbox" | "production"; connections: readonly AccountingConnection[]; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const enabled = target.canLink && !readOnly;
  const auto = useQuery({
    queryKey: [QUERY_ROOT, "auto-link", target.organizationId, target.legalEntityId, environment],
    queryFn: async ({ signal }) => {
      const result = await api.autoLinkTenancyCustomers(target.organizationId, { environment, legalEntityId: target.legalEntityId }, signal);
      if (result.linkedTenancyIds.length) await queryClient.invalidateQueries({ queryKey: [QUERY_ROOT] , predicate: query => query.queryKey[1] !== "auto-link" });
      return result;
    },
    enabled, staleTime: Infinity, gcTime: Infinity, retry: false,
  });
  if (enabled && auto.isPending) return <div className="rm-empty" role="status"><p>Looking for this tenant's QuickBooks customer…</p></div>;
  return <LinkCustomer api={api} target={target} tenancyId={tenancyId} connections={connections} readOnly={readOnly} />;
}

function LinkCustomer({ api, target, tenancyId, connections, readOnly }: { api: AccountingApi; target: QboTarget; tenancyId: string; connections: readonly AccountingConnection[]; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const [realmId, setRealmId] = useState(connections[0]?.scope.realmId ?? "");
  const connection = connections.find(candidate => candidate.scope.realmId === realmId) ?? connections[0];
  const scope = connection?.scope;
  const [search, setSearch] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const canLink = target.canLink && !readOnly && Boolean(scope);
  const customers = useQuery({
    queryKey: [QUERY_ROOT, "customers", target.organizationId, scope?.legalEntityId, scope?.environment, scope?.realmId],
    queryFn: ({ signal }) => api.listMirrors(target.organizationId, scope!, "customers", signal),
    enabled: canLink, staleTime: 60_000, retry: false,
  });
  const matches = filterCustomers(customers.data ?? [], search);
  const selected = customers.data?.find(customer => customer.providerObjectId === customerId);

  async function link(event: FormEvent) {
    event.preventDefault();
    if (!scope || !selected) return;
    if (!confirming) { setConfirming(true); return; }
    setSaving(true); setError(null);
    try {
      await api.linkTenancyCustomer(target.organizationId, { scope, tenancyId, customerId: selected.providerObjectId });
      await queryClient.invalidateQueries({ queryKey: [QUERY_ROOT, "tenancy-ledger", target.organizationId, tenancyId] });
      await queryClient.invalidateQueries({ queryKey: [QUERY_ROOT, "source-resolution", target.organizationId, tenancyId] });
    } catch (caught) {
      setError(caught); setConfirming(false);
    } finally { setSaving(false); }
  }

  const heading = <Notice tone="info" title="No matching QuickBooks customer">{" "}No QuickBooks customer matched this tenant's name and address. Pick one below to link it.</Notice>;
  if (!canLink) return <>{heading}<p className="rm-muted">{readOnly ? "Linking is unavailable while viewing sample or read-only data." : "An owner, admin or finance user can link this tenancy to its QuickBooks customer."}</p></>;
  return <>{heading}
    <form className="rm-ledger-filters" onSubmit={event => void link(event)} aria-busy={saving}>
      {connections.length > 1 && <label>QuickBooks company<select value={realmId} onChange={event => { setRealmId(event.target.value); setCustomerId(""); setConfirming(false); }}>{connections.map(candidate => <option key={candidate.scope.realmId} value={candidate.scope.realmId}>{candidate.name}</option>)}</select></label>}
      <label>Find customer<input type="search" value={search} placeholder="Name or QuickBooks number" onChange={event => { setSearch(event.target.value); setConfirming(false); }} /></label>
      <label>QuickBooks customer<select value={customerId} disabled={!customers.data} onChange={event => { setCustomerId(event.target.value); setConfirming(false); }}>
        <option value="">{customers.isPending ? "Loading customers…" : matches.length ? "Choose a customer" : "No matching customers"}</option>
        {selected && !matches.includes(selected) && <option value={selected.providerObjectId}>{customerOptionLabel(selected)}</option>}
        {matches.map(customer => <option key={customer.providerObjectId} value={customer.providerObjectId}>{customerOptionLabel(customer)}</option>)}
      </select></label>
      <div className="rm-row-actions">
        <button type="submit" className="rm-button rm-button-primary" disabled={!selected || saving}>{saving ? "Linking…" : confirming ? "Confirm link" : "Link customer"}</button>
        {confirming && !saving && <button type="button" className="rm-button" onClick={() => setConfirming(false)}>Cancel</button>}
      </div>
    </form>
    {customers.error && <Notice tone="error" title={messageOf(customers.error, "QuickBooks customers could not be loaded.")}>{" "}<button type="button" className="rm-button" onClick={() => void customers.refetch()}>Try again</button></Notice>}
    {confirming && selected && <Notice tone="warning" title={`Link ${selected.displayName} to this tenancy?`}>{" "}The link is recorded in 5Central Ops only and cannot be changed here afterwards. A QuickBooks customer can belong to one tenancy. Nothing is written to QuickBooks.</Notice>}
    {error !== null && <Notice tone="error" title={messageOf(error, "The QuickBooks customer could not be linked.")} />}
  </>;
}
