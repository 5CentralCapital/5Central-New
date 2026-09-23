import React from "react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import type { CompanyContext } from "@shared/company/context";
import { FORECAST_SCENARIO_KIND_LABELS, type ForecastCommandKind, type ForecastRunSource } from "@shared/forecasting/contracts";
import { rentOpsAuthClient } from "../rent-ops/auth";
import { PendingEnvelopes } from "../work-orders/pending";
import { ForecastApiError, forecastApi, forecastEnvelope, type ForecastCommandEnvelope, type ForecastRunView } from "./api";
import { AssumptionsView } from "./assumptions-editor";
import { DrilldownSheet } from "./drilldown";
import { dateLabel } from "./format";
import { FORECAST_TABS, FORECAST_TAB_LABELS, type ForecastingLocation, type ForecastingNavigation, type ForecastTab } from "./params";
import { STATE_LABELS, ScenariosView, defaultScenario, snapshotIsCurrent, stateClass } from "./scenarios";
import { EmptyState, Notice } from "./ui";
import { BalanceView, CashView, DebtView, IncomeView } from "./views";
import "./forecasting.css";

export type { ForecastingLocation, ForecastingNavigation, ForecastingRoutePatch, ForecastTab } from "./params";
export { forecastingParams, forecastingRoutePatch, parseForecastingParams } from "./params";

export interface ForecastingWorkspaceProps {
  readonly organizationId: string;
  readonly location: ForecastingLocation;
  readonly onNavigate: (location: ForecastingLocation, replace?: boolean) => void;
}

export { defaultScenario } from "./scenarios";

function runLabel(run: ForecastRunView | undefined, draft: boolean): string {
  if (!run) return "Loading…";
  if (draft) return "Preview of unsaved changes";
  if (run.kind === "snapshot" && run.snapshot) return `Snapshot ${dateLabel(run.snapshot.createdAt.slice(0, 10), "long")} · version ${run.snapshot.assumptionVersion}${run.snapshot.label ? ` · ${run.snapshot.label}` : ""}`;
  return `Preview, not saved · version ${run.assumptionVersion ?? "—"}`;
}

/** Reporting → Forecasting workspace. */
export function ForecastingWorkspace({ organizationId, location, onNavigate }: ForecastingWorkspaceProps) {
  const client = useQueryClient();
  const pending = useRef(new PendingEnvelopes<ForecastCommandEnvelope>());
  const [drill, setDrill] = useState<{ line: string; period: string } | null>(null);
  const [draftPreview, setDraftPreview] = useState<Record<string, unknown> | null>(null);
  const [actionError, setActionError] = useState<unknown>();
  const [savingSnapshot, setSavingSnapshot] = useState(false);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const list = useQuery({ queryKey: ["forecasting", "list", organizationId], queryFn: ({ signal }) => forecastApi.list(organizationId, signal), staleTime: 15_000, retry: false });
  const scenarios = list.data?.items ?? [];
  const selected = (location.scenarioId ? scenarios.find(item => item.id === location.scenarioId) : undefined) ?? (location.scenarioId && list.isLoading ? undefined : defaultScenario(scenarios));
  useEffect(() => {
    if (selected && selected.id !== location.scenarioId) onNavigate({ ...location, scenarioId: selected.id }, true);
  }, [selected, location, onNavigate]);
  const detail = useQuery({
    queryKey: ["forecasting", "detail", organizationId, selected?.id],
    queryFn: ({ signal }) => forecastApi.get(organizationId, selected!.id, signal),
    enabled: Boolean(selected), retry: false, staleTime: 15_000,
  });
  const current = detail.data;
  // The current run is a snapshot of the current assumptions, settings and model; otherwise an unsaved preview.
  const snapshotId = current?.snapshots.find(item => snapshotIsCurrent(current, item))?.id;
  const run = useQuery({
    queryKey: ["forecasting", "run", organizationId, current?.id, snapshotId ?? `preview:${current?.currentAssumptionVersion}:${current?.parametersSha256}`],
    queryFn: ({ signal }) => snapshotId ? forecastApi.snapshot(organizationId, snapshotId, signal) : forecastApi.preview(organizationId, current!.id, { assumptionVersion: current!.currentAssumptionVersion }, signal),
    enabled: Boolean(current && current.currentAssumptionVersion > 0), retry: false, staleTime: 60_000,
  });
  const draftKey = useMemo(() => (draftPreview ? JSON.stringify(draftPreview) : null), [draftPreview]);
  const draftRun = useQuery({
    queryKey: ["forecasting", "draft", organizationId, current?.id, draftKey],
    queryFn: ({ signal }) => forecastApi.preview(organizationId, current!.id, { assumptions: draftPreview! }, signal),
    enabled: Boolean(current && draftPreview), retry: false, staleTime: 60_000,
  });
  const shown = draftPreview ? draftRun : run;
  const result = shown.data?.result;
  const source: ForecastRunSource | null = !current ? null : shown.data?.kind === "snapshot" && shown.data.snapshot ? { snapshotId: shown.data.snapshot.id } : draftPreview ? null : { scenarioId: current.id, assumptionVersion: current.currentAssumptionVersion };

  const refresh = useCallback(async () => {
    await client.invalidateQueries({ queryKey: ["forecasting", "list", organizationId] });
    await client.invalidateQueries({ queryKey: ["forecasting", "detail", organizationId] });
  }, [client, organizationId]);

  const command = useCallback(async (kind: ForecastCommandKind, payload: Record<string, unknown>, expectedRevision?: number): Promise<string | undefined> => {
    const key = PendingEnvelopes.key(kind, payload, expectedRevision);
    const envelope = pending.current.envelopeFor(key, () => forecastEnvelope(organizationId, payload, expectedRevision));
    try {
      const receipt = await forecastApi.command(organizationId, kind, envelope);
      pending.current.settle(key);
      await refresh();
      return receipt.affectedRecordIds[0] === undefined ? undefined : String(receipt.affectedRecordIds[0]);
    } catch (error) {
      if (!(error instanceof ForecastApiError && error.uncertain)) pending.current.settle(key);
      if (error instanceof ForecastApiError && error.conflict) void refresh();
      throw error;
    }
  }, [organizationId, refresh]);

  const onDrill = useCallback((line: string, period: string) => setDrill({ line, period }), []);
  const closeDrill = useCallback(() => setDrill(null), []);
  const setTab = (tab: ForecastTab) => { setDrill(null); onNavigate({ ...location, tab }); };
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!offset) return;
    event.preventDefault();
    const next = FORECAST_TABS[(index + offset + FORECAST_TABS.length) % FORECAST_TABS.length]!;
    setTab(next);
    tabRefs.current[next]?.focus();
  };
  const saveSnapshot = async () => {
    if (!current) return;
    setSavingSnapshot(true); setActionError(undefined);
    try { await command("forecast.snapshot.create", { scenarioId: current.id }); await client.invalidateQueries({ queryKey: ["forecasting", "run", organizationId, current.id] }); }
    catch (error) { setActionError(error); } finally { setSavingSnapshot(false); }
  };
  const onPreviewDraft = useCallback((draft: Record<string, unknown> | null) => setDraftPreview(draft), []);

  if (list.error) return <div className="fc-workspace"><EmptyState title="Forecasts unavailable" message={list.error instanceof Error ? list.error.message : "Forecasts could not be loaded."} action={<button type="button" className="rm-button" onClick={() => void list.refetch()}>Try Again</button>} /></div>;
  if (list.isLoading) return <div className="fc-workspace"><p className="fc-muted" role="status">Loading forecasts…</p></div>;
  const tab = location.tab;
  const failed = result?.checks.filter(check => !check.passed) ?? [];
  const noScenario = !selected;
  return <div className="fc-workspace">
    <header className="fc-header">
      <div className="fc-heading">
        <h1>Forecasting</h1>
        {selected && <p className="fc-subtitle">
          <span className={stateClass(selected.state)}>{STATE_LABELS[selected.state]}</span>
          <span>{FORECAST_SCENARIO_KIND_LABELS[selected.kind]}</span>
          <span>{runLabel(shown.data, Boolean(draftPreview))}</span>
        </p>}
      </div>
      {selected && <div className="fc-header-actions">
        <label className="fc-inline-field">Scenario
          <select value={selected.id} onChange={event => { setDraftPreview(null); setDrill(null); onNavigate({ ...location, scenarioId: event.currentTarget.value }); }}>
            {scenarios.filter(item => item.state !== "archived" || item.id === selected.id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <button type="button" className="rm-button rm-button-primary" onClick={() => void saveSnapshot()} disabled={savingSnapshot || selected.state === "archived" || Boolean(draftPreview) || !current}>
          {savingSnapshot ? <><LoaderCircle size={15} className="fc-spin" aria-hidden="true" />Saving…</> : "Save Snapshot"}
        </button>
      </div>}
    </header>
    {location.propertyId || location.entityId ? <p className="fc-footnote">Forecasts cover the whole company; property and entity filters do not apply here.</p> : null}
    <Notice error={actionError} onRetry={() => setActionError(undefined)} />
    {result && !result.opening.complete && <div className="fc-banner" role="status">
      <span><strong>Opening position incomplete:</strong> {result.opening.unknown.join(", ")}.</span>
      {tab !== "assumptions" && <button type="button" className="rm-button rm-button--small" onClick={() => setTab("assumptions")}>Set Balances</button>}
    </div>}
    {failed.length > 0 && <div className="fc-alert" role="alert"><span>Accounting checks failed: {failed.map(check => check.code.replace(/_/g, " ")).join(", ")}. Approval is blocked until they pass.</span></div>}
    {result && result.warnings.length > 0 && <details className="fc-details"><summary>{result.warnings.length} model {result.warnings.length === 1 ? "note" : "notes"}</summary>
      <ul className="fc-notes">{result.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}</ul></details>}
    <div className="fc-tabs" role="tablist" aria-label="Forecast views">
      {FORECAST_TABS.map((item, index) => <button key={item} ref={element => { tabRefs.current[item] = element; }} type="button" role="tab" id={`fc-tab-${item}`}
        aria-selected={tab === item} aria-controls="fc-tabpanel" tabIndex={tab === item ? 0 : -1} className={`fc-tab${tab === item ? " is-selected" : ""}`}
        onClick={() => setTab(item)} onKeyDown={event => onTabKey(event, index)}>{FORECAST_TAB_LABELS[item]}</button>)}
    </div>
    <section id="fc-tabpanel" role="tabpanel" aria-labelledby={`fc-tab-${tab}`} className={`fc-panel${drill ? " has-sheet" : ""}`}>
      {tab === "scenarios" ? <ScenariosView organizationId={organizationId} scenarios={scenarios} selected={selected}
          onSelect={scenarioId => { setDraftPreview(null); onNavigate({ ...location, scenarioId }); }}
          command={(kind, payload, revision) => command(kind, payload, revision)} />
        : noScenario ? <EmptyState title="No forecast scenarios" message="Create a base scenario to project cash, income and debt." action={<button type="button" className="rm-button rm-button-primary" onClick={() => setTab("scenarios")}>New Scenario</button>} />
        : detail.error ? <Notice error={detail.error} onRetry={() => void detail.refetch()} />
        : !current ? <p className="fc-muted" role="status">Loading scenario…</p>
        : tab === "assumptions" ? <AssumptionsView detail={current} opening={result?.opening.items ?? []} currency={current.currency} onPreviewDraft={onPreviewDraft} draftPreviewActive={Boolean(draftPreview)}
            save={async (kind, payload, revision) => { await command(kind, payload, revision); }} />
        : shown.error ? <EmptyState title="Forecast could not run" message={shown.error instanceof Error ? shown.error.message : "Check the assumptions."} action={<button type="button" className="rm-button" onClick={() => setTab("assumptions")}>Open Assumptions</button>} />
        : !result ? <p className="fc-muted" role="status">Running forecast…</p>
        : tab === "cash" ? <CashView result={result} onDrill={onDrill} />
        : tab === "income" ? <IncomeView result={result} onDrill={onDrill} />
        : tab === "balance" ? <BalanceView result={result} onDrill={onDrill} />
        : <DebtView result={result} onDrill={onDrill} />}
    </section>
    {drill && source && result && <DrilldownSheet organizationId={organizationId} source={source} line={drill.line} period={drill.period} currency={result.currency} onClose={closeDrill} />}
    {drill && !source && <div className="fc-sheet" role="status"><p className="fc-muted">Save the version to drill into unsaved changes.</p><button type="button" className="rm-button" onClick={closeDrill}>Close</button></div>}
  </div>;
}

/** Company selector entry point: Reporting → Forecasting. Every change, including a company switch, is one navigation. */
export function ForecastingEntry({ identity, organizationId, location, onNavigate }: {
  identity: string;
  organizationId?: string;
  location: ForecastingLocation;
  onNavigate: (location: ForecastingLocation, options: ForecastingNavigation) => void;
}) {
  const context = useQuery({
    queryKey: ["rent-ops-workspace", "company-context", identity],
    queryFn: async ({ signal }): Promise<CompanyContext> => {
      const response = await rentOpsAuthClient.request("/api/company/context", { signal });
      if (!response.ok) throw new Error("Company records could not be loaded.");
      return response.json();
    },
    staleTime: 30_000, retry: false,
  });
  const [chosen, setChosen] = useState<string | undefined>(organizationId);
  if (context.error) return <div className="rm-notice" role="alert">{context.error.message} <button type="button" className="rm-button" onClick={() => void context.refetch()}>Try Again</button></div>;
  if (!context.data) return <div className="rm-empty" role="status">Loading forecasts…</div>;
  const organizations = context.data.organizations;
  if (!organizations.length) return <div className="rm-empty">Company access needs setup.</div>;
  const active = organizations.find(item => item.id === (organizationId ?? chosen)) ?? (organizations.length === 1 ? organizations[0] : undefined);
  return <>
    {(organizations.length > 1 || !active) && <div className="rm-toolbar"><label>Company <select aria-label="Company" value={active?.id ?? ""} onChange={event => { const next = event.currentTarget.value; setChosen(next); onNavigate({ tab: location.tab }, { organizationId: next }); }}>
      <option value="" disabled>Select company</option>{organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label></div>}
    {active && <ForecastingWorkspace key={active.id} organizationId={active.id} location={location} onNavigate={(next, replace) => onNavigate(next, { replace: replace ?? false })} />}
  </>;
}
