import { useEffect, useId, useMemo, useRef, useState } from "react";
import { RefreshCw, Unplug } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { AccountingApi, AccountingConnection, AccountingEnvironment, AccountingMirrorKind, AccountingPendingBinding, AccountingScope, AccountingWorkspaceEntity, AccountingWorkspaceProps } from "./types";
import { accountingApi } from "./api";
import "./accounting.css";

const mirrorTabs: readonly [AccountingMirrorKind, string][] = [["accounts", "Accounts"], ["vendors", "Vendors"], ["customers", "Customers"], ["employees", "Employees"]];

function ErrorBox({ error, retry }: { readonly error: unknown; readonly retry?: () => void }) {
  return <div className="accounting-message is-error" role="alert">{error instanceof Error ? error.message : "Accounting records could not be loaded."}{retry && <button className="accounting-button" onClick={retry}>Try again</button>}</div>;
}

function dateLabel(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function centsLabel(value: string, currency: string): string {
  try {
    const amount = BigInt(value); const negative = amount < BigInt(0); const absolute = (negative ? -amount : amount).toString().padStart(3, "0");
    return `${negative ? "-" : ""}${currency} ${absolute.slice(0, -2)}.${absolute.slice(-2)}`;
  } catch { return `${currency} —`; }
}

function legalEntityOptions(entities: readonly AccountingWorkspaceEntity[] | undefined): readonly AccountingWorkspaceEntity[] { return entities ?? []; }

function environmentLabel(environment: AccountingEnvironment | null | undefined): string {
  return environment === "production" ? "Production" : environment === "sandbox" ? "Sandbox" : "Not configured";
}

function EnvironmentBadge({ environment }: { readonly environment: AccountingEnvironment | null | undefined }) {
  if (!environment) return null;
  return <span className={`accounting-environment is-${environment}`} title={`QuickBooks ${environmentLabel(environment)} environment`}>{environmentLabel(environment)}</span>;
}

function DisconnectDialog({ connection, entityName, saving, error, onCancel, onConfirm }: { readonly connection: AccountingConnection; readonly entityName: string; readonly saving: boolean; readonly error: unknown; readonly onCancel: () => void; readonly onConfirm: () => void }) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape" && !saving) onCancel(); };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onCancel, saving]);
  return <div className="rm-dialog-backdrop accounting-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !saving) onCancel(); }}>
    <section className="rm-dialog accounting-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-busy={saving}>
      <div className="rm-dialog-header accounting-dialog-header"><h2 id={titleId}>Disconnect QuickBooks?</h2></div>
      <div className="accounting-dialog-body">
        <p>This disconnects <strong>{connection.name}</strong> ({environmentLabel(connection.scope.environment)}) from {entityName}.</p>
        <ul>
          <li>R-ops asks Intuit to revoke its access. Nothing inside QuickBooks is changed or deleted.</li>
          <li>Record refreshes stop until you reconnect. Records already copied into R-ops stay stored here.</li>
          <li>If Intuit can't confirm the disconnect, the connection is kept so you can try again.</li>
          <li>You can reconnect the same QuickBooks company at any time.</li>
        </ul>
        {error !== null && <div className="accounting-message is-error" role="alert">{error instanceof Error ? error.message : "QuickBooks could not be disconnected."}</div>}
      </div>
      <div className="rm-dialog-footer accounting-dialog-footer">
        <button ref={cancelRef} type="button" className="accounting-button" disabled={saving} onClick={onCancel}>Cancel</button>
        <button type="button" className="accounting-button accounting-button-danger rm-button-danger" disabled={saving} onClick={onConfirm}>{saving ? "Disconnecting…" : "Disconnect QuickBooks"}</button>
      </div>
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
    <div className="accounting-card-header"><h2>{reconnect ? "Reconnect QuickBooks" : "Connect QuickBooks"}</h2><EnvironmentBadge environment={environment} /></div>
    <div className="accounting-card-body accounting-form">
      {reconnect && <p className="accounting-meta">QuickBooks is disconnected for this legal entity. Reconnect to resume record refreshes.</p>}
      <button className="accounting-button accounting-button-primary" disabled={starting} onClick={() => void connect()}>{starting ? "Opening QuickBooks…" : reconnect ? "Reconnect QuickBooks" : "Connect QuickBooks"}</button>
      {error !== null && <div className="accounting-message is-error" role="alert">{error instanceof Error ? error.message : "QuickBooks setup could not be started."}</div>}
      <p className="accounting-meta">By connecting, you agree to the <a href="/legal/eula" target="_blank" rel="noopener noreferrer">End-User License Agreement</a> and <a href="/legal/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>. Need help? <a href="mailto:michael@5central.capital?subject=Rent%20Ops%20QuickBooks%20support">Contact support</a>.</p>
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

function ConnectionList({ connections, selected, onSelect }: { readonly connections: readonly AccountingConnection[]; readonly selected: AccountingConnection | null; readonly onSelect: (connection: AccountingConnection) => void }) {
  if (!connections.length) return null;
  return <div className="accounting-card"><div className="accounting-card-header"><h2>Connections</h2></div>{connections.map(connection => <button type="button" className="accounting-connection" key={`${connection.scope.environment}:${connection.scope.realmId}`} aria-pressed={selected?.scope.realmId === connection.scope.realmId} onClick={() => onSelect(connection)}><strong>{connection.name}</strong><EnvironmentBadge environment={connection.scope.environment} /><span className={`accounting-status ${connection.status === "ready" ? "" : "is-muted"}`}>{connection.status === "ready" ? "Ready" : "Connected"}</span></button>)}</div>;
}

function MirrorTable({ items, kind }: { readonly items: readonly { displayName: string; active: boolean; providerUpdatedAt: string | null }[]; readonly kind: AccountingMirrorKind }) {
  if (!items.length) return <div className="accounting-empty"><strong>No {kind} mirrored yet</strong><span>Run a source sync after the connection is ready.</span></div>;
  return <div className="accounting-table-wrap"><table className="accounting-table"><thead><tr><th>Name</th><th>Status</th><th>Updated</th></tr></thead><tbody>{items.map(item => <tr key={`${item.displayName}:${item.providerUpdatedAt}`}><td>{item.displayName}</td><td>{item.active ? "Active" : "Inactive"}</td><td>{dateLabel(item.providerUpdatedAt)}</td></tr>)}</tbody></table></div>;
}

function TransactionTable({ api, organizationId, scope }: { readonly api: AccountingApi; readonly organizationId: string; readonly scope: AccountingScope }) {
  const query = useQuery({ queryKey: ["accounting", "transactions", scope], queryFn: ({ signal }) => api.listTransactions(organizationId, scope, signal), staleTime: 20_000 });
  if (query.isLoading) return <div className="accounting-empty">Loading transactions…</div>;
  if (query.error) return <ErrorBox error={query.error} retry={() => void query.refetch()} />;
  const page = query.data;
  if (!page?.items.length) return <div className="accounting-empty"><strong>No mirrored transactions</strong><span>Run a source sync to load the current source records.</span></div>;
  return <><div className="accounting-meta" role="status">Coverage: {page.coverage.status} · {page.coverage.evidence}</div><div className="accounting-table-wrap"><table className="accounting-table"><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Status</th><th>Settlement</th></tr></thead><tbody>{page.items.map(item => <tr key={`${item.source.objectType}:${item.source.objectId}:${item.source.lineId ?? ""}:${item.source.version}`}><td>{item.postedOn ?? "—"}</td><td>{item.transactionType}</td><td>{centsLabel(item.amountCents, item.currency)}</td><td>{item.postingState}</td><td>{item.settlement.state}</td></tr>)}</tbody></table></div></>;
}

export function AccountingWorkspace({ organizationId, organizationName, entities, api = accountingApi }: AccountingWorkspaceProps) {
  const entityOptions = legalEntityOptions(entities);
  const [legalEntityId, setLegalEntityId] = useState(() => {
    const pendingEntityId = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("qboEntity");
    return entityOptions.find(entity => entity.id === pendingEntityId)?.id ?? entityOptions[0]?.id ?? "";
  });
  const [selectedRealmId, setSelectedRealmId] = useState<string | null>(null);
  const [tab, setTab] = useState<AccountingMirrorKind | "transactions">("accounts");
  const [message, setMessage] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<unknown>(null);
  const [disconnectedEntities, setDisconnectedEntities] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingId, setPendingId] = useState<string | null>(() => typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("qboPending"));
  const configuration = useQuery({ queryKey: ["accounting", "configuration", organizationId, legalEntityId], queryFn: ({ signal }) => api.getConfiguration(organizationId, legalEntityId, signal), enabled: Boolean(legalEntityId), staleTime: 30_000 });
  const environment = configuration.data?.environment ?? null;
  const connections = useQuery({ queryKey: ["accounting", "connections", organizationId, legalEntityId, environment], queryFn: ({ signal }) => api.listConnections(organizationId, legalEntityId, environment!, signal), enabled: Boolean(legalEntityId && environment), staleTime: 20_000 });
  const pending = useQuery({ queryKey: ["accounting", "pending", organizationId, legalEntityId, pendingId], queryFn: ({ signal }) => api.getPendingBinding(organizationId, legalEntityId, pendingId!, signal), enabled: Boolean(legalEntityId && pendingId), retry: false });
  useEffect(() => { if (!connections.data?.length) { setSelectedRealmId(null); return; } if (!connections.data.some(connection => connection.scope.realmId === selectedRealmId)) setSelectedRealmId(connections.data[0]!.scope.realmId); }, [connections.data, selectedRealmId]);
  const selectedConnection = connections.data?.find(connection => connection.scope.realmId === selectedRealmId) ?? connections.data?.[0] ?? null;
  const scope = useMemo<AccountingScope | null>(() => selectedConnection?.scope ?? null, [selectedConnection]);
  const mirrors = useQuery({ queryKey: ["accounting", "mirrors", scope, tab], queryFn: ({ signal }) => api.listMirrors(organizationId, scope!, tab as AccountingMirrorKind, signal), enabled: Boolean(scope && tab !== "transactions"), staleTime: 20_000 });
  const selectedEntity = entityOptions.find(entity => entity.id === legalEntityId);
  const clearPending = async () => {
    setPendingId(null);
    const url = new URL(window.location.href); url.searchParams.delete("qboPending"); url.searchParams.delete("qboEntity"); window.history.replaceState(window.history.state, "", url.toString());
    await connections.refetch();
  };
  async function sync() {
    if (!scope) return;
    setSyncing(true); setMessage(null);
    try { const result = await api.sync(organizationId, scope); setMessage(result.status === "complete" ? "QuickBooks records refreshed." : "QuickBooks records refreshed with some streams needing review."); await connections.refetch(); await mirrors.refetch(); }
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
      setMessage(result.providerOutcome === "already_revoked" ? "QuickBooks was already disconnected at Intuit. R-ops cleared its connection." : "QuickBooks disconnected. Reconnect to resume record refreshes.");
      await connections.refetch();
    } catch (error) { setDisconnectError(error); }
    finally { setDisconnecting(false); }
  }
  return <div className="accounting-workspace">
    <header className="accounting-toolbar"><div><h1>Accounting</h1><p>{organizationName ?? "Company"}</p></div><div className="accounting-actions"><EnvironmentBadge environment={environment} />{scope && <button className="accounting-button accounting-button-primary" disabled={syncing || disconnecting} onClick={() => void sync()}><RefreshCw size={14} />{syncing ? "Refreshing…" : "Refresh records"}</button>}{selectedConnection && <button className="accounting-button accounting-button-danger rm-button-danger" disabled={syncing || disconnecting} onClick={() => { setDisconnectError(null); setDisconnectOpen(true); }}><Unplug size={14} />Disconnect QuickBooks</button>}</div></header>
    <div className="accounting-selectors"><label>Legal entity<select value={legalEntityId} onChange={event => { setLegalEntityId(event.currentTarget.value); setTab("accounts"); }}>{entityOptions.map(entity => <option key={entity.id} value={entity.id}>{entity.name}</option>)}</select></label><label>QuickBooks environment<span className="accounting-meta">{environmentLabel(environment)}</span></label><label>Currency<span className="accounting-meta">{selectedEntity?.currency ?? "—"}</span></label></div>
    {message && <div className="accounting-message" role="status">{message}</div>}
    {connections.error && <ErrorBox error={connections.error} retry={() => void connections.refetch()} />}
    <div className="accounting-grid"><aside className="accounting-sidebar">{pending.data && selectedEntity && <PendingBindingCard api={api} organizationId={organizationId} legalEntityId={legalEntityId} entityName={selectedEntity.name} pending={pending.data} onConfirmed={clearPending} />}{pending.error && <ErrorBox error={pending.error} retry={() => void pending.refetch()} />}{!connections.isLoading && <ConnectionList connections={connections.data ?? []} selected={selectedConnection} onSelect={connection => setSelectedRealmId(connection.scope.realmId)} />}{!selectedConnection && !pending.data && configuration.data?.configured && legalEntityId && <ConnectCard api={api} organizationId={organizationId} legalEntityId={legalEntityId} environment={environment} reconnect={disconnectedEntities.has(legalEntityId)} />}{configuration.data && !configuration.data.configured && <div className="accounting-card"><div className="accounting-card-header"><h2>QuickBooks is not configured</h2></div><div className="accounting-card-body">QuickBooks connection isn't available.</div></div>}</aside><main className="accounting-main">{scope ? <><nav className="accounting-tabs" aria-label="Accounting records">{[...mirrorTabs, ["transactions", "Transactions"] as const].map(([value, label]) => <button type="button" className={`accounting-tab ${tab === value ? "is-selected" : ""}`} key={value} onClick={() => setTab(value)}>{label}</button>)}</nav>{tab === "transactions" ? <TransactionTable api={api} organizationId={organizationId} scope={scope} /> : mirrors.isLoading ? <div className="accounting-empty">Loading {tab}…</div> : mirrors.error ? <ErrorBox error={mirrors.error} retry={() => void mirrors.refetch()} /> : <MirrorTable items={mirrors.data ?? []} kind={tab} />}</> : <div className="accounting-empty"><strong>{configuration.data?.configured && !connections.isLoading && !connections.data?.length ? "QuickBooks is not connected for this legal entity." : "Choose a QuickBooks connection."}</strong>{configuration.data?.configured && !connections.isLoading && !connections.data?.length && <span>Use {disconnectedEntities.has(legalEntityId) ? "Reconnect" : "Connect"} QuickBooks to link a company.</span>}</div>}</main></div>
    {disconnectOpen && selectedConnection && <DisconnectDialog connection={selectedConnection} entityName={selectedEntity?.name ?? "this legal entity"} saving={disconnecting} error={disconnectError} onCancel={() => setDisconnectOpen(false)} onConfirm={() => void disconnect()} />}
    <p className="accounting-meta accounting-support">QuickBooks connection help: <a href="mailto:michael@5central.capital?subject=Rent%20Ops%20QuickBooks%20support">Contact support</a> · <a href="/legal/eula" target="_blank" rel="noopener noreferrer">EULA</a> · <a href="/legal/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a></p>
  </div>;
}
