import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConnectorHealth, PmSettlementDetail, PmSettlementSummary, RentalPostingMethod } from "@shared/accounting/operations";
import { ageLabel, dateLabel, dateTimeLabel, formatCents, isPositiveCents, monthLabel, monthPeriod, newOperationId, sumCents } from "./format";
import type { AccountingApi, AccountingCommandEnvelope, AccountingPeriod, AccountingScope, AccountingView } from "./types";
import { AccountingApiError } from "./api";

const RmBanking = lazy(() => import("../rent-ops/workspace/rm-banking").then(module => ({ default: module.RmBanking })));

type Tone = "positive" | "neutral" | "warning" | "critical";

export function StatePill({ tone, children }: { readonly tone: Tone; readonly children: ReactNode }) {
  return <span className={`accounting-pill is-${tone}`}>{children}</span>;
}

/** Title 3 heading, one line, one action. */
export function EmptyState({ title, detail, action }: { readonly title: string; readonly detail: string; readonly action?: { readonly label: string; readonly onClick: () => void } }) {
  return <div className="accounting-empty" role="status"><h3>{title}</h3><span>{detail}</span>{action && <button type="button" className="accounting-button" onClick={action.onClick}>{action.label}</button>}</div>;
}

export function ErrorState({ error, retry }: { readonly error: unknown; readonly retry?: () => void }) {
  return <div className="accounting-empty" role="alert"><h3>Couldn't load this</h3><span>{error instanceof Error ? error.message : "Accounting records could not be loaded."}</span>{retry && <button type="button" className="accounting-button" onClick={retry}>Try again</button>}</div>;
}

function Loading({ label }: { readonly label: string }) {
  return <div className="accounting-empty" role="status"><span>{label}</span></div>;
}

/** Keeps one envelope per logical action so a retry after an uncertain response replays, never duplicates. */
function useCommand(api: AccountingApi, organizationId: string) {
  const pending = useRef(new Map<string, AccountingCommandEnvelope>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function run(kind: Parameters<AccountingApi["command"]>[1], scope: AccountingCommandEnvelope["scope"], payload: Record<string, unknown>, expectedRevision?: number) {
    const key = JSON.stringify([kind, scope, payload, expectedRevision ?? null]);
    const envelope = pending.current.get(key) ?? (() => {
      const operationId = newOperationId();
      const created: AccountingCommandEnvelope = { operationId, idempotencyKey: `web:${operationId}`, scope, payload, ...(expectedRevision === undefined ? {} : { expectedRevision }) };
      pending.current.set(key, created);
      return created;
    })();
    setBusy(true); setError(null);
    try {
      const receipt = await api.command(organizationId, kind, envelope);
      pending.current.delete(key);
      return receipt;
    } catch (caught) {
      if (!(caught instanceof AccountingApiError && caught.status === 0)) pending.current.delete(key);
      setError(caught);
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { run, busy, error, clearError: () => setError(null) };
}

const FRESHNESS: Readonly<Record<ConnectorHealth["freshness"], { label: string; tone: Tone }>> = {
  current: { label: "Current", tone: "positive" },
  stale: { label: "Out of date", tone: "warning" },
  never_synced: { label: "Not synced yet", tone: "neutral" },
  disconnected: { label: "QBO disconnected", tone: "critical" },
};

function HealthCard({ item }: { readonly item: ConnectorHealth }) {
  const freshness = FRESHNESS[item.freshness];
  const failing = item.jobs.dead > 0;
  return <section className="accounting-card accounting-health" aria-label={`${item.companyName ?? "QuickBooks"} health`}>
    <div className="accounting-card-header"><h3>{item.companyName ?? "QuickBooks Online"}</h3><StatePill tone={freshness.tone}>{freshness.label}</StatePill></div>
    <dl className="accounting-dl">
      <div><dt>Last change sync</dt><dd>{ageLabel(item.lagSeconds)}</dd></div>
      <div><dt>Coverage</dt><dd>{item.coverage.status === "complete" ? "Complete" : item.coverage.status === "partial" ? "Partial" : "Not available"}</dd></div>
      <div><dt>Open exceptions</dt><dd>{item.openSyncExceptions}</dd></div>
      <div><dt>Deletions to review</dt><dd>{item.activeTombstones}</dd></div>
      <div><dt>Background work</dt><dd>{item.jobs.running + item.jobs.queued + item.jobs.retry > 0 ? `${item.jobs.running + item.jobs.queued + item.jobs.retry} in progress` : "Idle"}{failing ? ` · ${item.jobs.dead} failed` : ""}</dd></div>
      <div><dt>Last webhook</dt><dd>{dateTimeLabel(item.lastWebhookAt)}</dd></div>
      {item.lastVerifiedFullReplayAt && <div><dt>Last full check</dt><dd>{dateTimeLabel(item.lastVerifiedFullReplayAt)}</dd></div>}
      {item.rateLimitedUntil && <div><dt>Paused by QuickBooks until</dt><dd>{dateTimeLabel(item.rateLimitedUntil)}</dd></div>}
    </dl>
    {item.coverage.status !== "complete" && item.coverage.reason && <p className="accounting-meta">{item.coverage.reason}</p>}
  </section>;
}

export function OverviewPanel({ api, organizationId, legalEntityId, currency, onOpen }: { readonly api: AccountingApi; readonly organizationId: string; readonly legalEntityId: string; readonly currency: string; readonly onOpen: (view: AccountingView) => void }) {
  const period = useMemo(() => monthPeriod(new Date(), -1), []);
  const health = useQuery({ queryKey: ["accounting", "health", organizationId, legalEntityId], queryFn: ({ signal }) => api.health(organizationId, legalEntityId, signal), staleTime: 15_000, refetchInterval: 60_000 });
  const close = useQuery({ queryKey: ["accounting", "close", organizationId, legalEntityId, period], queryFn: ({ signal }) => api.closeChecklist(organizationId, legalEntityId, period, signal), staleTime: 30_000 });
  const open = useQuery({ queryKey: ["accounting", "pm-open", organizationId, legalEntityId], queryFn: ({ signal }) => api.pmSettlements(organizationId, { legalEntityId, states: ["draft", "exception"] }, signal), staleTime: 30_000 });
  const awaiting = open.data?.items.filter(item => isPositiveCents(item.ownerRemittanceCents) && !item.bankSettledOn) ?? [];
  return <div className="accounting-overview">
    <section aria-labelledby="accounting-health-heading">
      <h2 id="accounting-health-heading" className="accounting-section-title">QuickBooks</h2>
      {health.isLoading ? <Loading label="Checking QuickBooks…" /> : health.error ? <ErrorState error={health.error} retry={() => void health.refetch()} /> : !health.data?.items.length
        ? <EmptyState title="QuickBooks isn't connected" detail="Connect this legal entity's QuickBooks company to mirror its records." />
        : <>
          {health.data.workers.active === 0 && <div className="accounting-message is-warning" role="status">The background worker isn't running. Refreshes wait until it starts.</div>}
          <div className="accounting-health-grid">{health.data.items.map(item => <HealthCard key={`${item.scope.environment}:${item.scope.realmId}`} item={item} />)}</div>
        </>}
    </section>
    <div className="accounting-summary-grid">
      <section className="accounting-card" aria-labelledby="accounting-clearing-heading">
        <div className="accounting-card-header"><h3 id="accounting-clearing-heading">PM clearing</h3></div>
        <div className="accounting-card-body">
          {open.isLoading ? <span className="accounting-meta">Loading…</span> : open.error ? <span className="accounting-meta" role="alert">Statements could not be loaded.</span> : open.data && open.data.items.length === 0
            ? <span className="accounting-meta">Every recorded statement is reconciled.</span>
            : <>
              <p className="accounting-figure">{formatCents(sumCents(awaiting.map(item => item.ownerRemittanceCents)), currency)}</p>
              <p className="accounting-meta">{awaiting.length} remittance{awaiting.length === 1 ? "" : "s"} awaiting a bank match · {open.data?.items.length ?? 0} open statement{open.data?.items.length === 1 ? "" : "s"}</p>
            </>}
          <button type="button" className="accounting-button" onClick={() => onOpen("pm-settlements")}>Open PM settlements</button>
        </div>
      </section>
      <section className="accounting-card" aria-labelledby="accounting-close-heading">
        <div className="accounting-card-header"><h3 id="accounting-close-heading">{monthLabel(period.periodStart)} close</h3></div>
        <div className="accounting-card-body">
          {close.isLoading ? <span className="accounting-meta">Loading…</span> : close.error ? <span className="accounting-meta" role="alert">Close status could not be loaded.</span> : close.data && <>
            <p className="accounting-figure">{close.data.completeCount} of {close.data.items.length}</p>
            <p className="accounting-meta">{close.data.items.filter(item => item.state === "blocked" || item.state === "attention").map(item => item.label).join(" · ") || "Ready to close"}</p>
          </>}
          <button type="button" className="accounting-button" onClick={() => onOpen("close")}>Open period close</button>
        </div>
      </section>
    </div>
  </div>;
}

export function PayablesView({ api, organizationId, scope, currency }: { readonly api: AccountingApi; readonly organizationId: string; readonly scope: AccountingScope; readonly currency: string }) {
  const [kind, setKind] = useState<"bills" | "payments">("bills");
  const [cursors, setCursors] = useState<readonly string[]>([]);
  const cursor = cursors.at(-1);
  const page = useQuery({ queryKey: ["accounting", "payables", scope, kind, cursor], queryFn: ({ signal }) => api.payables(organizationId, scope, kind, cursor, signal), staleTime: 20_000 });
  const choose = (next: "bills" | "payments") => { setKind(next); setCursors([]); };
  return <section aria-label="Bills and payments">
    <div className="accounting-segmented" role="group" aria-label="Show">
      {(["bills", "payments"] as const).map(value => <button type="button" key={value} aria-pressed={kind === value} className={kind === value ? "is-selected" : ""} onClick={() => choose(value)}>{value === "bills" ? "Bills" : "Bill payments"}</button>)}
    </div>
    {page.isLoading ? <Loading label="Loading…" /> : page.error ? <ErrorState error={page.error} retry={() => void page.refetch()} /> : !page.data?.items.length
      ? <EmptyState title={kind === "bills" ? "No bills mirrored" : "No bill payments mirrored"} detail="Records appear after the next QuickBooks sync." />
      : <>
        {page.data.coverage.status !== "complete" && <p className="accounting-meta" role="status">Coverage is partial; QuickBooks remains the record.{page.data.coverage.reason ? ` ${page.data.coverage.reason}` : ""}</p>}
        <div className="accounting-table-wrap"><table className="accounting-table" aria-label={kind === "bills" ? "Bills" : "Bill payments"}>
          <thead><tr><th>Date</th><th>Vendor</th><th>No.</th>{kind === "bills" && <th>Due</th>}<th className="is-number">Amount</th>{kind === "bills" && <th className="is-number">Open balance</th>}<th>Status</th></tr></thead>
          <tbody>{page.data.items.map(item => <tr key={`${item.objectId}:${item.version}`}>
            <td>{dateLabel(item.transactionDate)}</td><td>{item.vendorName ?? "—"}</td><td>{item.docNumber ?? "—"}</td>
            {kind === "bills" && <td>{dateLabel(item.dueDate)}</td>}
            <td className="is-number">{item.mirrored ? formatCents(item.amountCents, item.currency) : "Not mirrored"}</td>
            {kind === "bills" && <td className="is-number">{item.openBalanceCents === null ? "—" : formatCents(item.openBalanceCents, item.currency)}</td>}
            <td>{item.postingState === "voided" ? "Voided" : item.postingState === "posted" ? "Posted" : "Unknown"}</td>
          </tr>)}</tbody>
        </table></div>
        <nav className="accounting-pagination" aria-label="Pages">
          <button type="button" className="accounting-button" disabled={!cursors.length} onClick={() => setCursors(cursors.slice(0, -1))}>Previous</button>
          <button type="button" className="accounting-button" disabled={!page.data.nextCursor} onClick={() => page.data?.nextCursor && setCursors([...cursors, page.data.nextCursor])}>Next</button>
        </nav>
      </>}
    <p className="accounting-meta">Amounts are in {currency}. Pay and edit bills in QuickBooks.</p>
  </section>;
}

export function BankingView({ api, organizationId, legalEntityId, currency, onOpen }: { readonly api: AccountingApi; readonly organizationId: string; readonly legalEntityId: string; readonly currency: string; readonly onOpen: (view: AccountingView) => void }) {
  const open = useQuery({ queryKey: ["accounting", "pm-open", organizationId, legalEntityId], queryFn: ({ signal }) => api.pmSettlements(organizationId, { legalEntityId, states: ["draft", "exception"] }, signal), staleTime: 30_000 });
  const awaiting = open.data?.items.filter(item => isPositiveCents(item.ownerRemittanceCents) && !item.bankSettledOn) ?? [];
  return <div className="accounting-stack">
    <section className="accounting-card" aria-labelledby="accounting-rec-heading">
      <div className="accounting-card-header"><h3 id="accounting-rec-heading">Remittances awaiting a bank match</h3></div>
      {open.isLoading ? <Loading label="Loading…" /> : open.error ? <ErrorState error={open.error} retry={() => void open.refetch()} /> : awaiting.length === 0
        ? <div className="accounting-card-body"><span className="accounting-meta">No owner remittance is waiting for bank evidence.</span></div>
        : <div className="accounting-table-wrap is-flush"><table className="accounting-table" aria-label="Remittances awaiting a bank match">
          <thead><tr><th>Period</th><th>Property</th><th>Manager</th><th className="is-number">Remittance</th><th>Status</th></tr></thead>
          <tbody>{awaiting.map(item => <tr key={item.id}><td>{dateLabel(item.periodStart)} – {dateLabel(item.periodEnd)}</td><td>{item.propertyName ?? item.propertyId}</td><td>{item.managerName}</td><td className="is-number">{formatCents(item.ownerRemittanceCents, item.currency)}</td><td>{item.state === "exception" ? "Exception" : "Not reconciled"}</td></tr>)}</tbody>
        </table></div>}
      <div className="accounting-card-footer"><button type="button" className="accounting-button" onClick={() => onOpen("pm-settlements")}>Reconcile in PM settlements</button><span className="accounting-meta">Amounts in {currency}.</span></div>
    </section>
    <Suspense fallback={<Loading label="Loading bank accounts…" />}><RmBanking /></Suspense>
  </div>;
}

const KIND_LABEL: Readonly<Record<string, string>> = {
  rent_receipt: "Rent receipt", subsidy_receipt: "Subsidy receipt", deposit_receipt: "Deposit received", other_receipt: "Other receipt",
  pm_fee: "PM fee", pm_expense: "PM expense", other_deduction: "Other deduction", owner_remittance: "Owner remittance",
};

const SETTLEMENT_TONE: Readonly<Record<PmSettlementSummary["state"], Tone>> = { draft: "neutral", reconciled: "positive", exception: "critical" };
const SETTLEMENT_LABEL: Readonly<Record<PmSettlementSummary["state"], string>> = { draft: "Not reconciled", reconciled: "Reconciled", exception: "Exception" };

function GrossToNet({ detail }: { readonly detail: PmSettlementDetail }) {
  const g = detail.grossToNet;
  const c = (value: string) => formatCents(value, detail.currency);
  return <table className="accounting-table accounting-gross-net" aria-label="Gross to net">
    <tbody>
      <tr><th scope="row">Rent collected</th><td className="is-number">{c(g.collections.rentCents)}</td></tr>
      <tr><th scope="row">Subsidy collected</th><td className="is-number">{c(g.collections.subsidyCents)}</td></tr>
      <tr><th scope="row">Other collected</th><td className="is-number">{c(g.collections.otherCents)}</td></tr>
      <tr className="is-total"><th scope="row">Collections</th><td className="is-number">{c(g.operatingCollectionsCents)}</td></tr>
      {g.collections.depositCents !== "0" && <tr><th scope="row">Deposits received (held, not income)</th><td className="is-number">{c(g.collections.depositCents)}</td></tr>}
      <tr><th scope="row">PM fees</th><td className="is-number">{c(g.costs.feesCents)}</td></tr>
      <tr><th scope="row">PM expenses</th><td className="is-number">{c(g.costs.expensesCents)}</td></tr>
      {g.costs.otherDeductionsCents !== "0" && <tr><th scope="row">Other deductions</th><td className="is-number">{c(g.costs.otherDeductionsCents)}</td></tr>}
      <tr className="is-total"><th scope="row">PM costs</th><td className="is-number">{c(g.costs.totalCents)}</td></tr>
      <tr className="is-total"><th scope="row">Remitted to owner</th><td className="is-number">{c(g.remittedCents)}</td></tr>
      <tr><th scope="row">Held by manager</th><td className="is-number">{c(g.openingHeldCents)} → {c(g.closingHeldCents)}</td></tr>
    </tbody>
  </table>;
}

export function SettlementDetail({ api, organizationId, legalEntityId, settlementId, onChanged }: { readonly api: AccountingApi; readonly organizationId: string; readonly legalEntityId: string; readonly settlementId: string; readonly onChanged: () => void }) {
  const detail = useQuery({ queryKey: ["accounting", "pm-settlement", organizationId, settlementId], queryFn: ({ signal }) => api.pmSettlement(organizationId, legalEntityId, settlementId, signal) });
  const command = useCommand(api, organizationId);
  const [mode, setMode] = useState<"none" | "reconcile" | "exception">("none");
  const [bankReference, setBankReference] = useState("");
  const [bankDate, setBankDate] = useState("");
  const [reason, setReason] = useState("");
  const formId = useId();
  useEffect(() => { setMode("none"); command.clearError(); }, [settlementId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (detail.isLoading) return <Loading label="Loading statement…" />;
  if (detail.error || !detail.data) return <ErrorState error={detail.error} retry={() => void detail.refetch()} />;
  const item = detail.data;
  const scope = { organizationId, legalEntityId: item.legalEntityId };
  const done = async (ok: unknown) => { if (ok) { setMode("none"); setReason(""); await detail.refetch(); onChanged(); } };
  return <article className="accounting-detail" aria-labelledby={`${formId}-title`}>
    <header className="accounting-detail-header">
      <div><h2 id={`${formId}-title`}>{item.propertyName ?? item.propertyId}</h2><p className="accounting-meta">{item.managerName} · {dateLabel(item.periodStart)} – {dateLabel(item.periodEnd)}</p></div>
      <StatePill tone={SETTLEMENT_TONE[item.state]}>{SETTLEMENT_LABEL[item.state]}</StatePill>
    </header>
    {item.exceptionReason && <div className="accounting-message is-error" role="status">{item.exceptionReason}</div>}
    <GrossToNet detail={item} />
    <section aria-label="Differences">
      <h3 className="accounting-subhead">Differences</h3>
      {item.differences.length === 0 ? <p className="accounting-meta">None. Lines, header and held funds agree.</p>
        : <ul className="accounting-differences">{item.differences.map(difference => <li key={difference.code}><span>{difference.label}</span><strong>{difference.amountCents === null ? "—" : formatCents(difference.amountCents, item.currency)}</strong></li>)}</ul>}
    </section>
    {item.bankSettledOn && <p className="accounting-meta">Bank settled {dateLabel(item.bankSettledOn)}{item.bankObservationReference ? ` · ${item.bankObservationReference}` : ""}</p>}
    <div className="accounting-actions">
      {item.state !== "reconciled" && <button type="button" className="accounting-button accounting-button-primary" onClick={() => { setMode("reconcile"); setBankReference(item.bankObservationReference ?? ""); setBankDate(item.bankSettledOn ?? ""); }}>Reconcile</button>}
      {item.state !== "exception" && <button type="button" className="accounting-button" onClick={() => setMode("exception")}>Mark exception</button>}
      {item.state === "exception" && <button type="button" className="accounting-button" disabled={command.busy} onClick={() => void command.run("accounting.pm_settlement.exception.clear", scope, { settlementId: item.id }, item.recordRevision).then(done)}>Clear exception</button>}
    </div>
    {mode === "reconcile" && <form className="accounting-form accounting-inline-form" onSubmit={event => { event.preventDefault(); void command.run("accounting.pm_settlement.reconcile", scope, { settlementId: item.id, bankObservationReference: bankReference.trim() || null, bankSettledOn: bankDate || null }, item.recordRevision).then(done); }}>
      <label>Bank deposit reference<input value={bankReference} onChange={event => setBankReference(event.currentTarget.value)} maxLength={500} required={isPositiveCents(item.ownerRemittanceCents)} /></label>
      <label>Settled on<input type="date" value={bankDate} onChange={event => setBankDate(event.currentTarget.value)} required={isPositiveCents(item.ownerRemittanceCents)} /></label>
      <div className="accounting-actions"><button type="button" className="accounting-button" onClick={() => setMode("none")}>Cancel</button><button type="submit" className="accounting-button accounting-button-primary" disabled={command.busy}>{command.busy ? "Saving…" : "Save reconciliation"}</button></div>
    </form>}
    {mode === "exception" && <form className="accounting-form accounting-inline-form" onSubmit={event => { event.preventDefault(); void command.run("accounting.pm_settlement.exception.mark", scope, { settlementId: item.id, reason: reason.trim() }, item.recordRevision).then(done); }}>
      <label>Reason<textarea value={reason} onChange={event => setReason(event.currentTarget.value)} maxLength={1000} required rows={3} /></label>
      <div className="accounting-actions"><button type="button" className="accounting-button" onClick={() => setMode("none")}>Cancel</button><button type="submit" className="accounting-button accounting-button-primary" disabled={command.busy || !reason.trim()}>{command.busy ? "Saving…" : "Mark exception"}</button></div>
    </form>}
    {command.error !== null && <div className="accounting-message is-error" role="alert">{command.error instanceof Error ? command.error.message : "The change could not be saved."}</div>}
    <section aria-label="Statement lines">
      <h3 className="accounting-subhead">Statement lines</h3>
      <div className="accounting-table-wrap"><table className="accounting-table" aria-label="Statement lines">
        <thead><tr><th>Line</th><th>Kind</th><th>Description</th><th>Unit</th><th>Date</th><th className="is-number">Amount</th></tr></thead>
        <tbody>{item.lines.map(line => <tr key={line.lineNumber}><td>{line.lineNumber}{line.sourcePage ? <span className="accounting-meta"> · p.{line.sourcePage}</span> : null}</td><td>{KIND_LABEL[line.kind] ?? line.kind}</td><td>{line.description}</td><td>{line.unitId ?? "—"}</td><td>{dateLabel(line.occurredOn)}</td><td className="is-number">{formatCents(line.amountCents, item.currency)}</td></tr>)}</tbody>
      </table></div>
    </section>
  </article>;
}

export function PmSettlementsView({ api, organizationId, legalEntityId }: { readonly api: AccountingApi; readonly organizationId: string; readonly legalEntityId: string }) {
  const [state, setState] = useState<"all" | PmSettlementSummary["state"]>("all");
  const [cursors, setCursors] = useState<readonly string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const cursor = cursors.at(-1);
  const list = useQuery({ queryKey: ["accounting", "pm-list", organizationId, legalEntityId, state, cursor], queryFn: ({ signal }) => api.pmSettlements(organizationId, { legalEntityId, ...(state === "all" ? {} : { states: [state] }), ...(cursor ? { cursor } : {}) }, signal), staleTime: 20_000 });
  useEffect(() => { if (list.data?.items.length && !list.data.items.some(item => item.id === selected)) setSelected(list.data.items[0]!.id); }, [list.data, selected]);
  return <div className="accounting-split">
    <section className="accounting-split-list" aria-label="PM statements">
      <label className="accounting-filter">Status<select value={state} onChange={event => { setState(event.currentTarget.value as typeof state); setCursors([]); setSelected(null); }}>
        <option value="all">All</option><option value="draft">Not reconciled</option><option value="exception">Exception</option><option value="reconciled">Reconciled</option>
      </select></label>
      {list.isLoading ? <Loading label="Loading statements…" /> : list.error ? <ErrorState error={list.error} retry={() => void list.refetch()} /> : !list.data?.items.length
        ? <EmptyState title="No PM statements" detail="Manager statements recorded through intake appear here." />
        : <>
          <ul className="accounting-record-list">{list.data.items.map(item => <li key={item.id}><button type="button" aria-current={item.id === selected ? "true" : undefined} onClick={() => setSelected(item.id)}>
            <span className="accounting-record-title">{item.propertyName ?? item.propertyId}</span>
            <span className="accounting-meta">{monthLabel(item.periodStart)} · {item.managerName}</span>
            <span className="accounting-record-figures"><span>{formatCents(item.grossCollectionsCents, item.currency)} collected</span><StatePill tone={SETTLEMENT_TONE[item.state]}>{SETTLEMENT_LABEL[item.state]}</StatePill></span>
          </button></li>)}</ul>
          <nav className="accounting-pagination" aria-label="Pages">
            <button type="button" className="accounting-button" disabled={!cursors.length} onClick={() => setCursors(cursors.slice(0, -1))}>Previous</button>
            <button type="button" className="accounting-button" disabled={!list.data.nextCursor} onClick={() => list.data?.nextCursor && setCursors([...cursors, list.data.nextCursor])}>Next</button>
          </nav>
        </>}
    </section>
    <section className="accounting-split-detail" aria-live="polite">
      {selected && <SettlementDetail key={selected} api={api} organizationId={organizationId} legalEntityId={legalEntityId} settlementId={selected} onChanged={() => void queryClient.invalidateQueries({ queryKey: ["accounting"] })} />}
    </section>
  </div>;
}

const CLOSE_TONE: Readonly<Record<string, Tone>> = { complete: "positive", not_applicable: "neutral", attention: "warning", blocked: "critical" };
const CLOSE_LABEL: Readonly<Record<string, string>> = { complete: "Done", not_applicable: "Not needed", attention: "Needs attention", blocked: "Blocked" };
const METHOD_LABEL: Readonly<Record<RentalPostingMethod, string>> = { native_receivables: "Native QuickBooks receivables", summary_bridge: "Summary bridge", not_posted: "Not posted" };

function PostingMethodForm({ api, organizationId, legalEntityId, onSaved }: { readonly api: AccountingApi; readonly organizationId: string; readonly legalEntityId: string; readonly onSaved: () => void }) {
  const command = useCommand(api, organizationId);
  const [method, setMethod] = useState<RentalPostingMethod>("summary_bridge");
  const [from, setFrom] = useState("");
  const [cutoff, setCutoff] = useState("");
  const [bridge, setBridge] = useState("");
  const [verified, setVerified] = useState(false);
  const [reason, setReason] = useState("");
  return <form className="accounting-form accounting-inline-form" onSubmit={event => {
    event.preventDefault();
    void command.run("accounting.rental_posting_policy.set", { organizationId, legalEntityId }, {
      method, effectiveFrom: from, cutoffDate: cutoff || from, reason: reason.trim(), invoiceDeliveryVerified: verified, ...(bridge.trim() ? { openingBalanceBridgeReference: bridge.trim() } : {}),
    }).then(receipt => { if (receipt) onSaved(); });
  }}>
    <label>Method<select value={method} onChange={event => setMethod(event.currentTarget.value as RentalPostingMethod)}>{(Object.keys(METHOD_LABEL) as RentalPostingMethod[]).map(value => <option key={value} value={value}>{METHOD_LABEL[value]}</option>)}</select></label>
    <label>Starts<input type="date" value={from} onChange={event => setFrom(event.currentTarget.value)} required /></label>
    <label>Cutoff<input type="date" value={cutoff} onChange={event => setCutoff(event.currentTarget.value)} placeholder={from} /></label>
    <label>Opening balance bridge<input value={bridge} onChange={event => setBridge(event.currentTarget.value)} maxLength={240} /></label>
    {method === "native_receivables" && <label className="accounting-check"><input type="checkbox" checked={verified} onChange={event => setVerified(event.currentTarget.checked)} /> <span>QuickBooks invoice email to tenants is off</span></label>}
    <label>Reason<input value={reason} onChange={event => setReason(event.currentTarget.value)} maxLength={1000} required /></label>
    <div className="accounting-actions"><button type="submit" className="accounting-button accounting-button-primary" disabled={command.busy || !from || !reason.trim() || (method === "native_receivables" && !verified)}>{command.busy ? "Saving…" : "Save method"}</button></div>
    {command.error !== null && <div className="accounting-message is-error" role="alert">{command.error instanceof Error ? command.error.message : "The method could not be saved."}</div>}
  </form>;
}

export function PeriodCloseView({ api, organizationId, legalEntityId, currency }: { readonly api: AccountingApi; readonly organizationId: string; readonly legalEntityId: string; readonly currency: string }) {
  const [period, setPeriod] = useState<AccountingPeriod>(() => monthPeriod(new Date(), -1));
  const [editing, setEditing] = useState(false);
  const queryClient = useQueryClient();
  const checklist = useQuery({ queryKey: ["accounting", "close", organizationId, legalEntityId, period], queryFn: ({ signal }) => api.closeChecklist(organizationId, legalEntityId, period, signal), staleTime: 20_000 });
  const policies = useQuery({ queryKey: ["accounting", "policies", organizationId, legalEntityId], queryFn: ({ signal }) => api.postingPolicies(organizationId, legalEntityId, signal), staleTime: 60_000 });
  const bridge = useQuery({ queryKey: ["accounting", "bridge", organizationId, legalEntityId, period], queryFn: ({ signal }) => api.bridgePreview(organizationId, legalEntityId, period, signal), staleTime: 60_000 });
  const month = period.periodStart.slice(0, 7);
  const totals = bridge.data?.controlTotals;
  return <div className="accounting-stack">
    <label className="accounting-filter">Period<input type="month" value={month} onChange={event => { const value = event.currentTarget.value; if (/^\d{4}-\d{2}$/.test(value)) setPeriod(monthPeriod(new Date(`${value}-15T00:00:00Z`), 0)); }} /></label>
    <section className="accounting-card" aria-labelledby="accounting-checklist-heading">
      <div className="accounting-card-header"><h3 id="accounting-checklist-heading">{monthLabel(period.periodStart)}</h3>{checklist.data && <span className="accounting-meta">{checklist.data.completeCount} of {checklist.data.items.length} ready</span>}</div>
      {checklist.isLoading ? <Loading label="Checking…" /> : checklist.error ? <ErrorState error={checklist.error} retry={() => void checklist.refetch()} /> : <ul className="accounting-checklist">{checklist.data?.items.map(item => <li key={item.code}>
        <div><strong>{item.label}</strong><span className="accounting-meta">{item.detail}</span></div><StatePill tone={CLOSE_TONE[item.state] ?? "neutral"}>{CLOSE_LABEL[item.state] ?? item.state}</StatePill>
      </li>)}</ul>}
      <div className="accounting-card-footer"><span className="accounting-meta">Status only. Close the books in QuickBooks.</span></div>
    </section>
    <section className="accounting-card" aria-labelledby="accounting-method-heading">
      <div className="accounting-card-header"><h3 id="accounting-method-heading">Rental accounting method</h3><button type="button" className="accounting-button" aria-expanded={editing} onClick={() => setEditing(!editing)}>{editing ? "Close" : "Set method"}</button></div>
      {editing && <PostingMethodForm api={api} organizationId={organizationId} legalEntityId={legalEntityId} onSaved={() => { setEditing(false); void queryClient.invalidateQueries({ queryKey: ["accounting"] }); }} />}
      {policies.isLoading ? <Loading label="Loading…" /> : policies.error ? <ErrorState error={policies.error} retry={() => void policies.refetch()} /> : !policies.data?.length
        ? <div className="accounting-card-body"><span className="accounting-meta">No method set. Choose one before any rental activity is posted.</span></div>
        : <div className="accounting-table-wrap is-flush"><table className="accounting-table" aria-label="Rental accounting methods"><thead><tr><th>Method</th><th>From</th><th>Until</th><th>Cutoff</th><th>Approved</th></tr></thead>
          <tbody>{policies.data.map(policy => <tr key={policy.id}><td>{METHOD_LABEL[policy.method]}</td><td>{dateLabel(policy.effectiveFrom)}</td><td>{policy.effectiveUntil ? dateLabel(policy.effectiveUntil) : "Open"}</td><td>{dateLabel(policy.cutoffDate)}</td><td>{dateTimeLabel(policy.approvedAt)}</td></tr>)}</tbody></table></div>}
    </section>
    <section className="accounting-card" aria-labelledby="accounting-bridge-heading">
      <div className="accounting-card-header"><h3 id="accounting-bridge-heading">Summary bridge preview</h3>{bridge.data && <a className="accounting-button" href={api.bridgeCsvHref(organizationId, legalEntityId, period)} download>Export CSV</a>}</div>
      {bridge.isLoading ? <Loading label="Building preview…" /> : bridge.error ? <ErrorState error={bridge.error} retry={() => void bridge.refetch()} /> : bridge.data && totals && <>
        {bridge.data.reason && <div className={`accounting-message ${bridge.data.status === "ready" ? "" : "is-warning"}`} role="status">{bridge.data.reason}</div>}
        <table className="accounting-table accounting-gross-net" aria-label="Control totals"><tbody>
          <tr><th scope="row">Charges ({totals.chargeCount})</th><td className="is-number">{formatCents(totals.chargesCents, currency)}</td></tr>
          <tr><th scope="row">Credits</th><td className="is-number">{formatCents(totals.creditsCents, currency)}</td></tr>
          <tr><th scope="row">Tenant receipts</th><td className="is-number">{formatCents(totals.receipts.tenantCents, currency)}</td></tr>
          <tr><th scope="row">Subsidy receipts</th><td className="is-number">{formatCents(totals.receipts.subsidyCents, currency)}</td></tr>
          <tr><th scope="row">Other receipts</th><td className="is-number">{formatCents(totals.receipts.otherCents, currency)}</td></tr>
          <tr className="is-total"><th scope="row">Receipts ({totals.receipts.count})</th><td className="is-number">{formatCents(totals.receipts.totalCents, currency)}</td></tr>
          <tr><th scope="row">Deposits received</th><td className="is-number">{formatCents(totals.depositsReceivedCents, currency)}</td></tr>
          <tr><th scope="row">Deposits held at period end</th><td className="is-number">{formatCents(totals.depositsHeldAtEndCents, currency)}</td></tr>
          <tr className="is-total"><th scope="row">Change in receivables</th><td className="is-number">{formatCents(totals.netReceivableChangeCents, currency)}</td></tr>
        </tbody></table>
        {(totals.excludedVoidedCount + totals.excludedPendingCount + totals.excludedUnknownCount) > 0 && <p className="accounting-meta">Excluded: {totals.excludedVoidedCount} voided, {totals.excludedPendingCount} pending, {totals.excludedUnknownCount} with unknown values.</p>}
        <div className="accounting-card-footer"><span className="accounting-meta">Preview only. Nothing is posted to QuickBooks.</span></div>
      </>}
    </section>
  </div>;
}
