import { useState, type FormEvent, type ReactNode } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QboCustomerLedger } from "@shared/accounting/receivables";
import { accountingApi } from "../../accounting/api";
import type { AccountingApi, AccountingConnection } from "../../accounting/types";
import {
  agingRows,
  coverageDisplay,
  customerLedgerRows,
  customerOptionLabel,
  filterCustomers,
  ledgerTotals,
  openItemRows,
  qboConnectionState,
  qboTargetForProperty,
  verificationDisplay,
  type LedgerTone,
  type QboTarget,
} from "../../accounting/customer-ledger";
import type { CompanyContext } from "@shared/company/context";
import { rentOpsAuthClient } from "../auth";
import type { AdminSnapshot, AdminTenancyView, TenantView } from "../types";
import { isCurrentTenancy, resolveTenantContext } from "./tenant-model";
import { ListTotals } from "./list-totals";
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

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="rm-panel rm-tenant-panel"><div className="rm-panel-title"><h3>{title}</h3></div>{children}</section>;
}

function Field({ label, children, warning = false }: { label: string; children: ReactNode; warning?: boolean }) {
  return <div className={`rm-field${warning ? " rm-field-warning" : ""}`}><dt>{label}</dt><dd>{children}</dd></div>;
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

export function TenantQuickBooksPanel({ tenant, snapshot, readOnly = false, api = accountingApi }: { tenant: TenantView; snapshot: AdminSnapshot; readOnly?: boolean; api?: AccountingApi }) {
  const context = resolveTenantContext(tenant, snapshot);
  const tenancies = context.tenancies.filter((tenancy): tenancy is AdminTenancyView & { id: string } => Boolean(tenancy.id));
  const [tenancyId, setTenancyId] = useState(() => context.currentTenancy?.id ?? tenancies[0]?.id ?? "");
  const tenancy = tenancies.find(candidate => candidate.id === tenancyId);
  const company = useCompanyContext();
  const target = qboTargetForProperty(company.data, tenancy?.propertyId);
  const configuration = useQuery({
    queryKey: [QUERY_ROOT, "configuration", target?.organizationId, target?.legalEntityId],
    queryFn: ({ signal }) => api.getConfiguration(target!.organizationId, target!.legalEntityId, signal),
    enabled: Boolean(target), staleTime: 60_000, retry: false,
  });
  const environment = configuration.data?.environment ?? null;
  const connections = useQuery({
    queryKey: [QUERY_ROOT, "connections", target?.organizationId, target?.legalEntityId, environment],
    queryFn: ({ signal }) => api.listConnections(target!.organizationId, target!.legalEntityId, environment!, signal),
    enabled: Boolean(target && environment), staleTime: 30_000, retry: false,
  });
  // Null while the connection list for a configured environment is still loading.
  const state = !configuration.data || (configuration.data.configured && configuration.data.environment && !connections.data) ? null : qboConnectionState(configuration.data, connections.data ?? []);

  const intro = <p className="rm-muted">QuickBooks data, read-only. This is the tenancy's QuickBooks customer history from the verified QuickBooks mirror; it is shown separately from, and never combined with, the 5Central Ops ledger on the Ledger tab.</p>;
  const picker = tenancies.length > 1 && <div className="rm-ledger-filters"><label>Tenancy<select value={tenancyId} onChange={event => setTenancyId(event.target.value)}>{tenancies.map(candidate => <option key={candidate.id} value={candidate.id}>{tenancyLabel(candidate, snapshot)}</option>)}</select></label></div>;

  let body: ReactNode;
  if (!tenancy) body = <div className="rm-empty"><p>No tenancy is linked to this tenant, so there is no QuickBooks customer history to show.</p></div>;
  else if (company.error) body = <Notice tone="error" title="Company records could not be loaded.">{" "}<button type="button" className="rm-button" onClick={() => void company.refetch()}>Try again</button></Notice>;
  else if (!company.data) body = <div className="rm-empty" role="status"><p>Loading QuickBooks access…</p></div>;
  else if (!target) body = <Notice tone="notice" title="No legal entity for this property">{" "}This property is not assigned to a legal entity you can access, so its QuickBooks history cannot be shown.</Notice>;
  else if (configuration.error || connections.error) body = <Notice tone="error" title={messageOf(configuration.error ?? connections.error, "QuickBooks status could not be loaded.")}>{" "}<button type="button" className="rm-button" onClick={() => { void configuration.refetch(); void connections.refetch(); }}>Try again</button></Notice>;
  else if (!state) body = <div className="rm-empty" role="status"><p>Checking the QuickBooks connection…</p></div>;
  else if (state.kind === "not-configured") body = <Notice tone="notice" title="QuickBooks is not configured">{" "}QuickBooks is not set up on this server, so no QuickBooks history is available.</Notice>;
  else if (state.kind === "not-connected") body = <Notice tone="notice" title={`QuickBooks is not connected for ${target.entityName}`}>{" "}Connect QuickBooks for this legal entity under Accounting to see this tenancy's QuickBooks history. No QuickBooks balance is known until then.</Notice>;
  else body = <>{state.needsReconnect && <Notice tone="warning" title="QuickBooks needs to be reconnected">{" "}Refreshes are paused for {target.entityName}. The history below is the last mirrored copy and may be out of date.</Notice>}<TenancyLedger key={`${tenancy.id}:${state.environment}`} api={api} target={target} tenancyId={tenancy.id} environment={state.environment} connections={state.connections} readOnly={readOnly} /></>;

  return <div className="rm-tenant-tab-content"><Panel title="QuickBooks customer ledger">{intro}{picker}{body}</Panel></div>;
}

function TenancyLedger({ api, target, tenancyId, environment, connections, readOnly }: { api: AccountingApi; target: QboTarget; tenancyId: string; environment: "sandbox" | "production"; connections: readonly AccountingConnection[]; readOnly: boolean }) {
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
    return <LinkCustomer api={api} target={target} tenancyId={tenancyId} connections={connections} readOnly={readOnly} />;
  }
  const entries = pages.flatMap(page => page?.entries ?? []);
  return <LedgerView ledger={first} entries={entries} hasMore={ledger.hasNextPage} loadingMore={ledger.isFetchingNextPage} pageError={ledger.error} onMore={() => void ledger.fetchNextPage()} onReload={() => void ledger.refetch()} />;
}

function LedgerView({ ledger, entries, hasMore, loadingMore, pageError, onMore, onReload }: { ledger: QboCustomerLedger; entries: QboCustomerLedger["entries"]; hasMore: boolean; loadingMore: boolean; pageError: unknown; onMore: () => void; onReload: () => void }) {
  const coverage = coverageDisplay(ledger.coverage, new Date());
  const verification = verificationDisplay(ledger.verification);
  const rows = customerLedgerRows(entries);
  const totals = ledgerTotals(ledger, coverage.amountsKnown);
  const ending = totals[totals.length - 1]!;
  const aging = agingRows(ledger.aging);
  const open = openItemRows(ledger.openItems);
  return <>
    <dl className="rm-form-grid rm-detail-grid">
      <Field label="QuickBooks customer"><strong>{ledger.customer.displayName ?? "Name not mirrored"}</strong><small>QuickBooks #{ledger.customer.objectId}{ledger.customer.active === false ? " · inactive" : ""}</small></Field>
      <Field label="Balance from QuickBooks history" warning={!coverage.amountsKnown || verification.tone !== "good"}><strong className="rm-amount">{ending.amount}</strong>{ledger.asOf && <small>Through {formatLongDate(ledger.asOf) ?? ledger.asOf}</small>}</Field>
      <Field label="QuickBooks customer balance" warning={verification.tone !== "good"}><span className={toneClass(verification.tone)}>{verification.label}</span>{verification.detail && <small>{verification.detail}</small>}</Field>
      <Field label="Coverage" warning={coverage.tone !== "good"}><span className={toneClass(coverage.tone)}>{coverage.tone === "good" ? "Complete" : !coverage.amountsKnown ? "Not read" : ledger.coverage.status === "complete" ? "Out of date" : "Partial"}</span><small>As of {coverage.asOfLabel}</small></Field>
    </dl>
    {coverage.tone !== "good" && <Notice tone={coverage.tone === "error" ? "error" : "warning"} title={coverage.title}>{coverage.reasons.length > 0 && <ul>{coverage.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}</Notice>}
    {verification.tone === "error" && <Notice tone="error" title="The mirrored history does not match QuickBooks">{" "}{verification.detail}</Notice>}

    <h4>Documents</h4>
    {rows.length === 0 ? <div className="rm-empty"><p>{coverage.amountsKnown ? "QuickBooks has no receivable documents for this customer." : "No QuickBooks documents have been read for this customer yet."}</p></div> : <div className="rm-table-wrap"><table className="rm-table rm-ledger-table">
      <caption className="sr-only">QuickBooks customer documents with running balance</caption>
      <thead><tr><th scope="col">Date</th><th scope="col">Type</th><th scope="col">Number</th><th scope="col" className="rm-align-right">Amount</th><th scope="col" className="rm-align-right">Applied</th><th scope="col" className="rm-align-right">Open</th><th scope="col" className="rm-align-right">Balance</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.key}><td>{row.date}</td><td>{row.type}{row.voided && <> <span className="rm-status rm-status-muted">Voided</span></>}</td><td className="rm-reference">{row.number}</td><td className="rm-align-right rm-amount">{row.amount}</td><td className="rm-align-right rm-amount">{row.applied}</td><td className="rm-align-right rm-amount">{row.open}</td><td className="rm-align-right rm-amount">{row.balance}</td></tr>)}</tbody>
      {!hasMore && <tfoot><tr><th scope="row" colSpan={6}>Ending balance (complete history)</th><td className="rm-align-right rm-amount"><strong>{ending.amount}</strong></td></tr></tfoot>}
    </table></div>}
    <ListTotals totalCount={ledger.page.total} visibleCount={entries.length} itemLabel="QuickBooks document" />
    <div className="rm-ledger-toolbar"><span>{entries.length} of {ledger.page.total} document{ledger.page.total === 1 ? "" : "s"} shown</span>{hasMore && <button type="button" className="rm-button" disabled={loadingMore} onClick={onMore}>{loadingMore ? "Loading…" : "Load more"}</button>}</div>
    {pageError !== null && pageError !== undefined && <Notice tone="error" title={messageOf(pageError, "More documents could not be loaded.")}>{" "}<button type="button" className="rm-button" onClick={onReload}>Reload from the first page</button></Notice>}

    <div className="rm-summary-grid">
      <section aria-label="QuickBooks totals"><h4>Totals</h4><dl className="rm-form-grid rm-detail-grid">{totals.map(item => <Field key={item.label} label={item.label} warning={!coverage.amountsKnown}><span className="rm-amount">{item.amount}</span></Field>)}</dl></section>
      <section aria-label="QuickBooks aging"><h4>Aging</h4>{aging ? <dl className="rm-form-grid rm-detail-grid">{aging.map(item => <Field key={item.label} label={item.label}><span className="rm-amount">{item.amount}</span></Field>)}</dl> : <div className="rm-empty"><p>Aging is not available for an earlier as-of date; QuickBooks reports only today's open balances.</p></div>}</section>
    </div>
    <h4>Open items</h4>
    {open.length === 0 ? <div className="rm-empty"><p>{coverage.amountsKnown ? "QuickBooks shows no open invoices, unused credits or unapplied payments." : "Open items are unknown until QuickBooks receivables are read."}</p></div> : <div className="rm-table-wrap"><table className="rm-table">
      <caption className="sr-only">QuickBooks open items</caption>
      <thead><tr><th scope="col">Type</th><th scope="col">Number</th><th scope="col">Date</th><th scope="col">Due</th><th scope="col" className="rm-align-right">Open</th><th scope="col">Past due</th></tr></thead>
      <tbody>{open.map(item => <tr key={item.key}><td>{item.type}</td><td className="rm-reference">{item.number}</td><td>{item.date}</td><td>{item.due}</td><td className="rm-align-right rm-amount">{item.open}</td><td>{item.pastDue}</td></tr>)}</tbody>
    </table></div>}
    <ListTotals totalCount={open.length} itemLabel="open item" />
  </>;
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
    } catch (caught) {
      setError(caught); setConfirming(false);
    } finally { setSaving(false); }
  }

  const heading = <Notice tone="info" title="Not linked to a QuickBooks customer">{" "}This tenancy has no QuickBooks customer yet, so no QuickBooks history or balance is shown. The balance is unknown, not zero.</Notice>;
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
