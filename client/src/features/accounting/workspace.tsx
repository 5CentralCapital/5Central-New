import { useEffect, useId, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ACCOUNTING_VIEWS, isAccountingView, type AccountingApi, type AccountingConnection, type AccountingEnvironment, type AccountingMirror, type AccountingMirrorKind, type AccountingPendingBinding, type AccountingPurposeMapping, type AccountingScope, type AccountingView, type AccountingWorkspaceEntity, type AccountingWorkspaceProps } from "./types";
import { accountingApi } from "./api";
import { dateLabel, dateTimeLabel, formatCents } from "./format";
import { BankingView, EmptyState, OverviewPanel, PayablesView, PeriodCloseView, PmSettlementsView, QuickBooksStatusLine, pickHealth, quickBooksStatus } from "./views";
import { RowMenu } from "../rent-ops/workspace/ops-ui";
import { FullGeneralLedger } from "./full-ledger";
import { FinancialDashboard } from "./dashboard";
import { shouldInvalidateAccountingQuery, waitForAccountingRefresh } from "./refresh";
import { transactionTotals } from "./transaction-totals";
import "./accounting.css";

const mirrorTabs: readonly [AccountingMirrorKind, string][] = [["accounts", "Accounts"], ["vendors", "Vendors"], ["customers", "Customers"], ["employees", "Employees"]];

function ErrorBox({ error, retry }: { readonly error: unknown; readonly retry?: () => void }) {
  return <div className="accounting-message is-error" role="alert">{error instanceof Error ? error.message : "Accounting records could not be loaded."}{retry && <button className="accounting-button" onClick={retry}>Try again</button>}</div>;
}


function legalEntityOptions(entities: readonly AccountingWorkspaceEntity[] | undefined): readonly AccountingWorkspaceEntity[] { return entities ?? []; }

function environmentLabel(environment: AccountingEnvironment | null | undefined): string {
  return environment === "production" ? "Production" : environment === "sandbox" ? "Sandbox" : "Not configured";
}


/** In-page confirmation (window.confirm is disabled in some viewers). Typing the company name enables Disconnect. */
function DisconnectDialog({ connection, entityName, saving, error, onCancel, onConfirm }: { readonly connection: AccountingConnection; readonly entityName: string; readonly saving: boolean; readonly error: unknown; readonly onCancel: () => void; readonly onConfirm: () => void }) {
  const titleId = useId();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === connection.name.trim();
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape" && !saving) onCancel(); };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onCancel, saving]);
  return <div className="rm-dialog-backdrop accounting-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !saving) onCancel(); }}>
    <section className="rm-dialog accounting-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-busy={saving}>
      <div className="rm-dialog-header accounting-dialog-header"><h2 id={titleId}>Disconnect QuickBooks?</h2></div>
      <form className="accounting-dialog-form" onSubmit={event => { event.preventDefault(); if (matches && !saving) onConfirm(); }}>
        <div className="accounting-dialog-body">
          <p>This disconnects the QuickBooks company <strong>{connection.name}</strong> ({environmentLabel(connection.scope.environment)}) from the legal entity <strong>{entityName}</strong>.</p>
          <ul>
            <li>5Central Ops asks Intuit to revoke its access. Nothing inside QuickBooks is changed or deleted.</li>
            <li>Record refreshes stop until you reconnect. Records already copied into 5Central Ops stay stored here.</li>
            <li>If Intuit can't confirm the disconnect, the connection is kept so you can try again.</li>
            <li>You can reconnect the same QuickBooks company at any time.</li>
          </ul>
          <label className="accounting-confirm-field" htmlFor={inputId}>Type <strong>{connection.name}</strong> to confirm</label>
          <input ref={inputRef} id={inputId} className="accounting-confirm-input" value={typed} autoComplete="off" spellCheck={false} disabled={saving} onChange={event => setTyped(event.currentTarget.value)} />
          {error !== null && <div className="accounting-message is-error" role="alert">{error instanceof Error ? error.message : "QuickBooks could not be disconnected."}</div>}
        </div>
        <div className="rm-dialog-footer accounting-dialog-footer">
          <button type="button" className="accounting-button" disabled={saving} onClick={onCancel}>Cancel</button>
          <button type="submit" className="accounting-button accounting-button-danger rm-button-danger" disabled={saving || !matches}>{saving ? "Disconnecting…" : "Disconnect QuickBooks"}</button>
        </div>
      </form>
    </section>
  </div>;
}

function ConnectCard({ api, organizationId, legalEntityId, environment, reconnect }: { readonly api: AccountingApi; readonly organizationId: string; readonly legalEntityId: string; readonly environment: AccountingEnvironment | null; readonly reconnect: boolean }) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function connect() {
    setStarting(true); setError(null);
    try { const result = await api.beginConnection(organizationId, legalEntityId); window.location.assign(result.authorizationUrl); }
    catch (caught) { setError(caught); setStarting(false); }
  }
  return <div className="accounting-card">
    <div className="accounting-card-header"><h2>{reconnect ? "Reconnect QuickBooks" : "Connect QuickBooks"}</h2>{environment && <span className="accounting-meta">{environmentLabel(environment)} environment</span>}</div>
    <div className="accounting-card-body accounting-form">
      {reconnect && <p className="accounting-meta">QuickBooks needs to be reconnected for this legal entity. Accounting access is paused until you reconnect.</p>}
      <button className="accounting-button accounting-button-primary" disabled={starting} onClick={() => void connect()}>{starting ? "Opening QuickBooks…" : reconnect ? "Reconnect QuickBooks" : "Connect QuickBooks"}</button>
      {error !== null && <div className="accounting-message is-error" role="alert">{error instanceof Error ? error.message : "QuickBooks setup could not be started."}</div>}
      <p className="accounting-meta">By connecting, you agree to the <a href="/legal/eula" target="_blank" rel="noopener noreferrer">End-User License Agreement</a> and <a href="/legal/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>. Need help? <a href="mailto:michael@5central.capital?subject=5Central%20Ops%20QuickBooks%20support">Contact support</a>.</p>
    </div>
  </div>;
}

function PendingBindingCard({ api, organizationId, legalEntityId, entityName, pending, onConfirmed }: { readonly api: AccountingApi; readonly organizationId: string; readonly legalEntityId: string; readonly entityName: string; readonly pending: AccountingPendingBinding; readonly onConfirmed: () => Promise<void> }) {
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const providerName = pending.providerCompanyName ?? pending.providerLegalName ?? "QuickBooks company";
  async function confirm() {
    setSaving(true); setError(null);
    try { await api.confirmConnection(organizationId, legalEntityId, pending.pendingId); await onConfirmed(); }
    catch (caught) { setError(caught); }
    finally { setSaving(false); }
  }
  return <div className="accounting-card accounting-pending-card">
    <div className="accounting-card-header"><h2>Confirm QuickBooks company</h2></div>
    <div className="accounting-card-body accounting-form">
      <div className="accounting-confirmation"><span>QuickBooks company</span><strong>{providerName}</strong>{pending.providerLegalName && pending.providerCompanyName && <small>{pending.providerLegalName}</small>}</div>
      <div className="accounting-confirmation"><span>Legal entity</span><strong>{entityName}</strong></div>
      <div className="accounting-confirmation"><span>Environment and currency</span><strong>{pending.scope.environment === "production" ? "Production" : "Sandbox"}{pending.homeCurrency ? ` · ${pending.homeCurrency}` : ""}</strong></div>
      <label className="accounting-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.currentTarget.checked)} /> <span>I confirm this is the QuickBooks company for {entityName}.</span></label>
      <button className="accounting-button accounting-button-primary" disabled={!confirmed || saving} onClick={() => void confirm()}>{saving ? "Saving connection…" : "Confirm company"}</button>
      {error !== null && <div className="accounting-message is-error" role="alert">{error instanceof Error ? error.message : "The connection could not be confirmed."}</div>}
    </div>
  </div>;
}

function MirrorTable({ items, kind }: { readonly items: readonly AccountingMirror[]; readonly kind: AccountingMirrorKind }) {
  if (!items.length) return <div className="accounting-empty"><strong>No {kind} mirrored yet</strong><span>Run a source sync after the connection is ready.</span></div>;
  return <div className="accounting-table-wrap"><table className="accounting-table"><thead><tr><th>Name</th><th>Status</th><th>Updated</th></tr></thead><tbody>{items.map(item => <tr key={`${item.displayName}:${item.providerUpdatedAt}`}><td>{item.displayName}</td><td>{item.active ? "Active" : "Inactive"}</td><td>{dateTimeLabel(item.providerUpdatedAt)}</td></tr>)}</tbody><tfoot><tr><th scope="row">{items.length} {kind}</th><td>{items.filter(item => item.active).length} active</td><td>{items.filter(item => !item.active).length} inactive</td></tr></tfoot></table></div>;
}

function PurposeMappingCard({ api, organizationId, scope, accounts, mappings, onSaved }: { readonly api: AccountingApi; readonly organizationId: string; readonly scope: AccountingScope; readonly accounts: readonly AccountingMirror[]; readonly mappings: readonly AccountingPurposeMapping[]; readonly onSaved: () => Promise<void> }) {
  const eligibleAccounts = accounts.filter(account => account.objectType === "Account" && account.accountType === "Other Current Asset" && account.active);
  const [accountId, setAccountId] = useState(eligibleAccounts[0]?.providerObjectId ?? "");
  const [effectiveFrom, setEffectiveFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [effectiveTo, setEffectiveTo] = useState("");
  const [reviewEvidence, setReviewEvidence] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!eligibleAccounts.some(account => account.providerObjectId === accountId)) setAccountId(eligibleAccounts[0]?.providerObjectId ?? "");
  }, [accountId, eligibleAccounts]);
  const selected = eligibleAccounts.find(account => account.providerObjectId === accountId) ?? null;
  async function save() {
    if (!selected) return;
    setSaving(true); setError(null);
    try {
      await api.mapCapitalizedCost(organizationId, { legalEntityId: scope.legalEntityId, scope, providerAccountId: selected.providerObjectId, accountSourceVersion: selected.version, effectiveFrom, ...(effectiveTo ? { effectiveTo } : {}), reviewEvidence });
      setReviewEvidence("");
      await onSaved();
    } catch (caught) { setError(caught); }
    finally { setSaving(false); }
  }
  return <section className="accounting-card accounting-purpose-card">
    <div className="accounting-card-header"><h2>Capitalized cost accounts</h2></div>
    <div className="accounting-card-body accounting-form">
      <p className="accounting-meta">Map a reviewed Other Current Asset account for a dated period. The exact mirrored account revision is recorded with the review; names and subtypes alone do not establish cost eligibility.</p>
      {eligibleAccounts.length === 0 ? <div className="accounting-empty"><strong>No eligible account mirror</strong><span>Refresh QuickBooks records, then review an Other Current Asset account.</span></div> : <>
        <label>QuickBooks account<select value={accountId} onChange={event => setAccountId(event.currentTarget.value)}>{eligibleAccounts.map(account => <option key={account.providerObjectId} value={account.providerObjectId}>{account.displayName} · {account.providerObjectId} · revision {account.version}</option>)}</select></label>
        <div className="accounting-form-row"><label>Effective from<input type="date" value={effectiveFrom} onChange={event => setEffectiveFrom(event.currentTarget.value)} /></label><label>Effective through (exclusive)<input type="date" value={effectiveTo} onChange={event => setEffectiveTo(event.currentTarget.value)} /></label></div>
        <label>Review evidence<textarea value={reviewEvidence} onChange={event => setReviewEvidence(event.currentTarget.value)} maxLength={1000} placeholder="Name the reviewed source or approval." /></label>
        <button type="button" className="accounting-button accounting-button-primary" disabled={saving || !selected || !effectiveFrom || !reviewEvidence.trim()} onClick={() => void save()}>{saving ? "Saving mapping…" : "Save capitalized cost mapping"}</button>
      </>}
      {error !== null && <div className="accounting-message is-error" role="alert">{error instanceof Error ? error.message : "The account mapping could not be saved."}</div>}
      <div className="accounting-purpose-list"><strong>Reviewed mappings</strong>{mappings.length === 0 ? <span className="accounting-meta">No reviewed mappings for this QuickBooks company.</span> : <ul>{mappings.map(mapping => <li key={mapping.id}><span>{mapping.providerAccountId} · revision {mapping.accountSourceVersion}</span><span>{mapping.effectiveFrom}{mapping.effectiveTo ? ` through ${mapping.effectiveTo} (exclusive)` : " onward"}</span><small>{mapping.reviewEvidence}</small></li>)}</ul>}</div>
    </div>
  </section>;
}

function TransactionTable({ api, organizationId, scope, onFullLedger }: { readonly api: AccountingApi; readonly organizationId: string; readonly scope: AccountingScope; readonly onFullLedger: () => void }) {
  const [cursors, setCursors] = useState<readonly string[]>([]);
  const cursor = cursors.at(-1);
  const query = useQuery({ queryKey: ["accounting", "transactions", organizationId, scope, cursor], queryFn: ({ signal }) => api.listTransactions(organizationId, scope, signal, cursor), staleTime: 20_000 });
  if (query.isLoading) return <div className="accounting-empty">Loading transactions…</div>;
  if (query.error) return <ErrorBox error={query.error} retry={() => void query.refetch()} />;
  const page = query.data;
  const totals = transactionTotals(page?.items ?? []);
  return <>
    <div className="accounting-list-heading"><span className="accounting-meta">{page?.items.length ?? 0} transaction lines shown</span><button className="accounting-button" onClick={onFullLedger}>Full general ledger</button></div>
    <p className="accounting-meta">Synced purchases, bills, bill payments and deposits. Open the general ledger for all QuickBooks activity.</p>
    {page?.coverage.status !== "complete" && <p className="accounting-message is-warning" role="status">The synced records are incomplete.{page?.coverage.reason ? ` ${page.coverage.reason}` : " Refresh records to load the latest activity."}</p>}
    {!page?.items.length ? <div className="accounting-empty"><strong>No supported transactions in this view</strong><span>Open the general ledger for complete QuickBooks activity, including journal entries.</span></div> : <div className="accounting-table-wrap"><table className="accounting-table" aria-label="Synced QuickBooks transactions">
      <thead><tr><th>Date</th><th>Type</th><th>Description</th><th className="is-number">Amount</th><th>Status</th><th>Settlement</th></tr></thead>
      <tbody>{page.items.map(item => <tr key={`${item.source.objectType}:${item.source.objectId}:${item.source.lineId ?? ""}:${item.source.version}`}><td>{dateLabel(item.postedOn)}</td><td>{item.transactionType}</td><td className="accounting-description">{item.description || "—"}</td><td className="is-number">{formatCents(item.amountCents, item.currency)}</td><td>{item.postingState}</td><td>{item.settlement.state === "unknown" ? "Unverified" : item.settlement.state}</td></tr>)}</tbody>
      <tfoot>{totals.map(total => <tr key={`${total.type}:${total.currency}:${total.state}`}><th scope="row" colSpan={3}>{cursors.length || page.nextCursor ? "Page" : "Shown"} total · {total.type} · {total.count} line{total.count === 1 ? "" : "s"}</th><td className="is-number">{formatCents(total.amountCents, total.currency)}</td><td>{total.state}</td><td>{total.currency}</td></tr>)}</tfoot>
    </table></div>}
    {(cursors.length > 0 || page?.nextCursor) && <nav className="accounting-pagination" aria-label="Transaction pages"><button className="accounting-button" disabled={!cursors.length} onClick={() => setCursors(cursors.slice(0, -1))}>Previous</button><span className="accounting-meta">Page {cursors.length + 1}</span><button className="accounting-button" disabled={!page?.nextCursor} onClick={() => page?.nextCursor && setCursors([...cursors, page.nextCursor])}>Next</button></nav>}
  </>;
}

function callbackErrorMessage(code: string): string {
  switch (code) {
    case "session_expired": return "Your 5Central Ops sign-in expired while QuickBooks was authorizing. Sign in again, then choose Connect QuickBooks.";
    case "accounting_conflict": return "That QuickBooks authorization link was already used or has expired. Start Connect QuickBooks again.";
    case "accounting_configuration": return "QuickBooks is not configured on this server. Contact support.";
    default: return "QuickBooks could not be connected. Start Connect QuickBooks again or contact support.";
  }
}

export function AccountingWorkspace({ organizationId, organizationName, entities, api = accountingApi, reportsApi, view: controlledView, onViewChange }: AccountingWorkspaceProps) {
  const entityOptions = legalEntityOptions(entities);
  const [legalEntityId, setLegalEntityId] = useState(() => {
    const pendingEntityId = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("qboEntity");
    return entityOptions.find(entity => entity.id === pendingEntityId)?.id ?? entityOptions[0]?.id ?? "";
  });
  const [internalView, setInternalView] = useState<AccountingView>(() => {
    const requested = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("acctView");
    return isAccountingView(requested) ? requested : "overview";
  });
  const view = controlledView ?? internalView;
  const setView = (next: AccountingView) => { if (onViewChange) onViewChange(next); else setInternalView(next); };
  const [selectedRealmId, setSelectedRealmId] = useState<string | null>(null);
  const [tab, setTab] = useState<AccountingMirrorKind | "transactions" | "general-ledger">("general-ledger");
  const [message, setMessage] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<unknown>(null);
  const [disconnectedEntities, setDisconnectedEntities] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingId, setPendingId] = useState<string | null>(() => typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("qboPending"));
  const [callbackError, setCallbackError] = useState<string | null>(() => typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("qboError"));
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!callbackError || typeof window === "undefined") return;
    const url = new URL(window.location.href); url.searchParams.delete("qboError"); window.history.replaceState(window.history.state, "", url.toString());
  }, [callbackError]);
  const configuration = useQuery({ queryKey: ["accounting", "configuration", organizationId, legalEntityId], queryFn: ({ signal }) => api.getConfiguration(organizationId, legalEntityId, signal), enabled: Boolean(legalEntityId), staleTime: 30_000 });
  const environment = configuration.data?.environment ?? null;
  const connections = useQuery({ queryKey: ["accounting", "connections", organizationId, legalEntityId, environment], queryFn: ({ signal }) => api.listConnections(organizationId, legalEntityId, environment!, signal), enabled: Boolean(legalEntityId && environment), staleTime: 20_000, refetchInterval: query => query.state.data?.some(connection => connection.status === "connected") ? 5_000 : false });
  const pending = useQuery({ queryKey: ["accounting", "pending", organizationId, legalEntityId, pendingId], queryFn: ({ signal }) => api.getPendingBinding(organizationId, legalEntityId, pendingId!, signal), enabled: Boolean(legalEntityId && pendingId), retry: false });
  useEffect(() => { if (!connections.data?.length) { setSelectedRealmId(null); return; } if (!connections.data.some(connection => connection.scope.realmId === selectedRealmId)) setSelectedRealmId(connections.data[0]!.scope.realmId); }, [connections.data, selectedRealmId]);
  const selectedConnection = connections.data?.find(connection => connection.scope.realmId === selectedRealmId) ?? connections.data?.[0] ?? null;
  const scope = useMemo<AccountingScope | null>(() => selectedConnection?.status === "needs_reconnect" ? null : selectedConnection?.scope ?? null, [selectedConnection]);
  const reportsReady = selectedConnection?.status === "ready";
  const mirrors = useQuery({ queryKey: ["accounting", "mirrors", scope, tab], queryFn: ({ signal }) => api.listMirrors(organizationId, scope!, tab as AccountingMirrorKind, signal), enabled: Boolean(scope && tab !== "transactions" && tab !== "general-ledger" && view === "transactions"), staleTime: 20_000 });
  const purposeMappings = useQuery({ queryKey: ["accounting", "purpose-mappings", scope], queryFn: ({ signal }) => api.listPurposeMappings(organizationId, scope!, undefined, signal), enabled: Boolean(scope && view === "transactions" && tab === "accounts"), staleTime: 20_000 });
  const health = useQuery({ queryKey: ["accounting", "health", organizationId, legalEntityId], queryFn: ({ signal }) => api.health(organizationId, legalEntityId, signal), enabled: Boolean(legalEntityId && selectedConnection && selectedConnection.status !== "needs_reconnect"), staleTime: 15_000, refetchInterval: 60_000 });
  const selectedEntity = entityOptions.find(entity => entity.id === legalEntityId);
  const currency = selectedEntity?.currency ?? "USD";
  const clearPending = async () => {
    setPendingId(null);
    setView("overview");
    const url = new URL(window.location.href); url.searchParams.delete("qboPending"); url.searchParams.delete("qboEntity"); url.searchParams.delete("qboConnected"); window.history.replaceState(window.history.state, "", url.toString());
    await connections.refetch();
  };
  async function sync() {
    if (!scope) return;
    setSyncing(true); setMessage(null);
    try {
      const result = await api.sync(organizationId, scope);
      const invalidateAccountingReads = () => queryClient.invalidateQueries({ queryKey: ["accounting"], predicate: query => shouldInvalidateAccountingQuery(query.queryKey) });
      // Health is safe to refresh immediately; it reports the queued job
      // without pretending that mirrored records are already current.
      await queryClient.invalidateQueries({ queryKey: ["accounting", "health"] });
      if (!result.jobId || !api.getJob) {
        await invalidateAccountingReads();
        setMessage(`${result.message} Currently available records were reloaded; refresh records again after the background sync completes to load the new records.`);
      } else {
        setMessage(`${result.message} Waiting for the background refresh to finish…`);
        let outcome: Awaited<ReturnType<typeof waitForAccountingRefresh>>;
        try {
          outcome = await waitForAccountingRefresh(() => api.getJob!(organizationId, result.jobId!));
        } catch {
          await invalidateAccountingReads();
          setMessage("QuickBooks refresh status could not be confirmed. Some records may have updated; check connection health and try again.");
          return;
        }
        if (outcome === "succeeded") {
          // The worker has finished, so active accounting reads can safely
          // refetch. Native ledger snapshots remain tied to their run cursor.
          await invalidateAccountingReads();
          setMessage("QuickBooks refresh completed. Mirrored accounting records reloaded.");
        } else if (outcome === "failed") {
          await invalidateAccountingReads();
          setMessage("QuickBooks refresh did not complete. Some records may have updated; check connection health and try again.");
        } else {
          await invalidateAccountingReads();
          setMessage("QuickBooks refresh is still running in the background. Currently available records were reloaded; refresh records again after it finishes to load the new records.");
        }
      }
    }
    catch (error) { setMessage(error instanceof Error ? error.message : "QuickBooks records could not be refreshed."); }
    finally { setSyncing(false); }
  }
  async function disconnect() {
    if (!selectedConnection) return;
    setDisconnecting(true); setDisconnectError(null);
    try {
      const result = await api.disconnect(organizationId, selectedConnection.scope);
      setDisconnectOpen(false);
      setDisconnectedEntities(current => new Set(current).add(selectedConnection.scope.legalEntityId));
      setMessage(result.providerOutcome === "already_revoked" ? "QuickBooks was already disconnected at Intuit. 5Central Ops cleared its connection." : "QuickBooks disconnected. Reconnect to resume record refreshes.");
      // Connections, health and mirrors all change; refetch every accounting read.
      await queryClient.invalidateQueries({ queryKey: ["accounting"] });
    } catch (error) { setDisconnectError(error); }
    finally { setDisconnecting(false); }
  }
  useEffect(() => { if (pendingId) setView("connections"); }, [pendingId]);
  const showConnect = Boolean(!pending.data && configuration.data?.configured && legalEntityId && (!selectedConnection || selectedConnection.status === "needs_reconnect"));
  const setup = <>{pending.data && selectedEntity && <PendingBindingCard api={api} organizationId={organizationId} legalEntityId={legalEntityId} entityName={selectedEntity.name} pending={pending.data} onConfirmed={clearPending} />}{pending.error && <ErrorBox error={pending.error} retry={() => void pending.refetch()} />}{showConnect && <ConnectCard api={api} organizationId={organizationId} legalEntityId={legalEntityId} environment={environment} reconnect={selectedConnection?.status === "needs_reconnect" || disconnectedEntities.has(legalEntityId)} />}{configuration.data && !configuration.data.configured && <div className="accounting-card"><div className="accounting-card-header"><h2>QuickBooks is not configured</h2></div><div className="accounting-card-body">QuickBooks connection isn't available.</div></div>}</>;
  const setupVisible = Boolean(pending.data || pending.error || showConnect || (configuration.data && !configuration.data.configured));
  const canDisconnect = Boolean(selectedConnection && selectedConnection.status !== "needs_reconnect");
  const canRefresh = Boolean(scope && view !== "overview" && view !== "banking");
  const status = quickBooksStatus({ environment, connection: selectedConnection, health: pickHealth(health.data?.items, selectedConnection?.scope.realmId), healthLoading: health.isLoading });
  const statusActions = (canRefresh || canDisconnect) ? <>
    {canRefresh && <button type="button" className="accounting-button" disabled={syncing || disconnecting} onClick={() => void sync()}><RefreshCw size={14} aria-hidden="true" />{syncing ? "Refreshing…" : "Refresh records"}</button>}
    {canDisconnect && <RowMenu label="QuickBooks connection actions" items={[{ label: "Disconnect QuickBooks…", danger: true, disabled: syncing || disconnecting, onSelect: () => { setDisconnectError(null); setDisconnectOpen(true); } }]} />}
  </> : undefined;
  const notConnected = <EmptyState title={selectedConnection?.status === "needs_reconnect" ? "QuickBooks needs to be reconnected" : "QuickBooks isn't connected"} detail={selectedConnection?.status === "needs_reconnect" ? "Reconnect to restore accounting access for this legal entity." : "Connect this legal entity's QuickBooks company to see its records."} action={{ label: "Open connections", onClick: () => setView("connections") }} />;
  const mirrorContent = scope ? <><nav className="accounting-tabs" aria-label="QuickBooks records">{[["general-ledger", "General ledger"] as const, ["transactions", "Synced transactions"] as const, ...mirrorTabs].map(([value, label]) => <button type="button" className={`accounting-tab ${tab === value ? "is-selected" : ""}`} aria-pressed={tab === value} key={value} onClick={() => setTab(value)}>{label}</button>)}</nav>{tab === "general-ledger" ? <FullGeneralLedger api={reportsApi} ready={reportsReady} key={`${organizationId}:${legalEntityId}:${selectedRealmId}`} organizationId={organizationId} legalEntityId={legalEntityId} currency={currency} /> : tab === "transactions" ? <TransactionTable onFullLedger={() => setTab("general-ledger")} key={`${organizationId}:${scope.legalEntityId}:${scope.environment}:${scope.realmId}`} api={api} organizationId={organizationId} scope={scope} /> : mirrors.isLoading ? <div className="accounting-empty">Loading {tab}…</div> : mirrors.error ? <ErrorBox error={mirrors.error} retry={() => void mirrors.refetch()} /> : <>{tab === "accounts" && <PurposeMappingCard api={api} organizationId={organizationId} scope={scope} accounts={mirrors.data ?? []} mappings={purposeMappings.data ?? []} onSaved={async () => { await purposeMappings.refetch(); }} />}<MirrorTable items={mirrors.data ?? []} kind={tab} /></>}</> : notConnected;
  return <div className="accounting-workspace">
    <header className="accounting-toolbar"><div><h1>Accounting</h1><p>{organizationName ?? "Company"}</p></div></header>
    <div className="accounting-selectors"><label>Company<select value={legalEntityId} onChange={event => { setLegalEntityId(event.currentTarget.value); setTab("general-ledger"); }}>{entityOptions.map(entity => <option key={entity.id} value={entity.id}>{entity.name}</option>)}</select></label>{(connections.data?.length ?? 0) > 1 && <label>QuickBooks company<select value={selectedConnection?.scope.realmId ?? ""} onChange={event => setSelectedRealmId(event.currentTarget.value)}>{connections.data!.map(connection => <option key={`${connection.scope.environment}:${connection.scope.realmId}`} value={connection.scope.realmId}>{connection.name}</option>)}</select></label>}<span className="accounting-meta">{selectedEntity?.currency ?? "—"}</span></div>
    <nav className="accounting-tabs accounting-view-tabs" aria-label="Accounting sections">{ACCOUNTING_VIEWS.map(item => <button type="button" key={item.value} className={`accounting-tab ${view === item.value ? "is-selected" : ""}`} aria-current={view === item.value ? "page" : undefined} onClick={() => setView(item.value)}>{item.label}</button>)}</nav>
    {legalEntityId && configuration.data?.configured && !connections.isLoading && <div className="accounting-status-row"><QuickBooksStatusLine status={status} actions={statusActions} /></div>}
    {message && <div className="accounting-message" role="status">{message}</div>}
    {callbackError && <div className="accounting-message" role="alert">{callbackErrorMessage(callbackError)} <button type="button" className="accounting-button" onClick={() => setCallbackError(null)}>Dismiss</button></div>}
    {configuration.error && <ErrorBox error={configuration.error} retry={() => void configuration.refetch()} />}
    {connections.error && <ErrorBox error={connections.error} retry={() => void connections.refetch()} />}
    {!legalEntityId ? <main className="accounting-main"><EmptyState title="No legal entity" detail="Add a legal entity to this company to use accounting." /></main>
      : view === "overview" ? <main className="accounting-main is-wide">{configuration.isLoading || connections.isLoading ? <div className="accounting-empty" role="status">Loading QuickBooks…</div> : <FinancialDashboard api={reportsApi} key={`${organizationId}:${legalEntityId}:${selectedRealmId}`} organizationId={organizationId} legalEntityId={legalEntityId} currency={currency} connected={Boolean(scope)} ready={reportsReady} onConnections={() => setView("connections")} />}</main>
      : view === "connections" ? <main className="accounting-main is-wide">{setupVisible && <div className="accounting-setup">{setup}</div>}<OverviewPanel api={api} organizationId={organizationId} legalEntityId={legalEntityId} currency={currency} realmId={selectedConnection?.scope.realmId ?? null} primaryAction={!setupVisible} onOpen={setView} /></main>
      : view === "transactions" ? <main className="accounting-main is-wide">{mirrorContent}</main>
      : <main className="accounting-main is-wide">
        {view === "bills" && (scope ? <PayablesView api={api} organizationId={organizationId} scope={scope} currency={currency} /> : notConnected)}
        {view === "banking" && <BankingView api={api} organizationId={organizationId} legalEntityId={legalEntityId} currency={currency} onOpen={setView} />}
        {view === "pm-settlements" && <PmSettlementsView api={api} organizationId={organizationId} legalEntityId={legalEntityId} />}
        {view === "close" && <PeriodCloseView api={api} organizationId={organizationId} legalEntityId={legalEntityId} currency={currency} />}
      </main>}
    {disconnectOpen && selectedConnection && <DisconnectDialog connection={selectedConnection} entityName={selectedEntity?.name ?? "this legal entity"} saving={disconnecting} error={disconnectError} onCancel={() => setDisconnectOpen(false)} onConfirm={() => void disconnect()} />}
    <p className="accounting-meta accounting-support">QuickBooks connection help: <a href="mailto:michael@5central.capital?subject=5Central%20Ops%20QuickBooks%20support">Contact support</a> · <a href="/legal/eula" target="_blank" rel="noopener noreferrer">EULA</a> · <a href="/legal/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a></p>
  </div>;
}
