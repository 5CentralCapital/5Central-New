import React from "react";
import { useMemo, useState, type FormEvent } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { FORECAST_SCENARIO_KINDS, FORECAST_SCENARIO_KIND_LABELS, type ForecastScenarioKind, type ForecastScenarioSummary, type ForecastSnapshotMeta } from "@shared/forecasting/contracts";
import { FORECAST_MODEL_VERSION } from "@shared/forecasting/result";
import { formatInputValue, parseMoneyInput } from "../projects/money";
import { forecastApi } from "./api";
import { LineChart } from "./charts";
import { dateLabel, money, moneyWhole, nextMonday } from "./format";
import { Dialog, EmptyState, Field, Notice } from "./ui";

export const STATE_LABELS = { draft: "Draft", approved: "Approved", archived: "Archived" } as const;
export function stateClass(state: string): string {
  return state === "approved" ? "rm-status rm-status--success" : state === "archived" ? "rm-status rm-status--unknown" : "rm-status fc-status--draft";
}

type Command = (kind: "forecast.scenario.create" | "forecast.scenario.update" | "forecast.scenario.archive" | "forecast.scenario.approve", payload: Record<string, unknown>, expectedRevision?: number) => Promise<string | undefined>;

/** A snapshot is current when it ran the scenario's current assumptions and settings with the current model. */
export function snapshotIsCurrent(scenario: Pick<ForecastScenarioSummary, "currentAssumptionVersion" | "parametersSha256">, snapshot: Pick<ForecastSnapshotMeta, "assumptionVersion" | "parametersSha256" | "modelVersion"> | null | undefined): boolean {
  return Boolean(snapshot && snapshot.assumptionVersion === scenario.currentAssumptionVersion && snapshot.parametersSha256 === scenario.parametersSha256 && snapshot.modelVersion === FORECAST_MODEL_VERSION);
}

/** Why the latest snapshot cannot be approved, or undefined when it can. */
export function approvalBlocker(scenario: ForecastScenarioSummary | undefined): string | undefined {
  const latest = scenario?.latestSnapshot;
  if (!scenario || !latest) return "Save a snapshot first.";
  if (latest.assumptionVersion !== scenario.currentAssumptionVersion) return "Save a snapshot of the current assumptions first.";
  if (latest.parametersSha256 !== scenario.parametersSha256) return "Scenario settings changed. Save a new snapshot first.";
  if (latest.modelVersion !== FORECAST_MODEL_VERSION) return "Save a snapshot with the current model first.";
  if (!latest.checksPassed) return "The latest snapshot has failed checks.";
  return undefined;
}

/** Preferred default: an approved base, then any base, then the most recently updated active scenario. */
export function defaultScenario(scenarios: readonly ForecastScenarioSummary[]): ForecastScenarioSummary | undefined {
  const active = scenarios.filter(item => item.state !== "archived");
  return active.find(item => item.kind === "base" && item.state === "approved") ?? active.find(item => item.kind === "base") ?? active[0];
}

/** Default comparison: base, downside and upside when they exist. */
export function defaultComparison(scenarios: readonly ForecastScenarioSummary[]): string[] {
  const withSnapshots = scenarios.filter(item => item.state !== "archived" && item.latestSnapshot);
  const byKind = (kind: string): string | undefined => withSnapshots.find(item => item.kind === kind)?.id;
  const preferred = ["base", "downside", "upside"].map(byKind).filter((id): id is string => typeof id === "string");
  return (preferred.length >= 2 ? preferred : withSnapshots.slice(0, 3).map(item => item.id)).slice(0, 3);
}

export function ScenariosView({ organizationId, scenarios, selected, onSelect, command }: {
  organizationId: string; scenarios: readonly ForecastScenarioSummary[]; selected?: ForecastScenarioSummary;
  onSelect: (scenarioId: string) => void; command: Command;
}) {
  const [dialog, setDialog] = useState<null | { kind: "create"; base?: ForecastScenarioSummary } | { kind: "edit" } | { kind: "approve" } | { kind: "archive" }>(null);
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [compareB, setCompareB] = useState<string>("");
  const [showArchived, setShowArchived] = useState(false);
  const visible = scenarios.filter(item => showArchived || item.state !== "archived");
  const comparison = chosen ?? defaultComparison(scenarios);
  const toneOrder = ["ink", "gold", "muted"] as const;
  const snapshots = useQueries({
    queries: comparison.map(id => {
      const snapshotId = scenarios.find(item => item.id === id)?.latestSnapshot?.id;
      return { queryKey: ["forecasting", "snapshot", organizationId, snapshotId], queryFn: ({ signal }: { signal: AbortSignal }) => forecastApi.snapshot(organizationId, snapshotId!, signal), enabled: Boolean(snapshotId), staleTime: 300_000, retry: false };
    }),
  });
  const loaded = comparison.map((id, index) => ({ scenario: scenarios.find(item => item.id === id)!, run: snapshots[index]?.data })).filter(item => item.scenario && item.run);
  const weeks = loaded[0]?.run?.result.weeks ?? [];
  const selectedSnapshot = selected?.latestSnapshot?.id;
  const compare = useQuery({
    queryKey: ["forecasting", "compare", organizationId, selectedSnapshot, compareB],
    queryFn: ({ signal }) => forecastApi.compare(organizationId, selectedSnapshot!, compareB, signal),
    enabled: Boolean(selectedSnapshot && compareB && compareB !== selectedSnapshot), retry: false, staleTime: 300_000,
  });
  const approveHint = approvalBlocker(selected);
  const canApprove = Boolean(selected && selected.state !== "archived" && !approveHint);
  const toggle = (id: string) => setChosen(current => {
    const base = current ?? comparison;
    return base.includes(id) ? base.filter(item => item !== id) : [...base, id].slice(-3);
  });
  return <div className="fc-view">
    <div className="fc-toolbar">
      <h2 className="fc-view-title">Scenarios</h2>
      <span className="fc-spacer" />
      <label className="fc-check"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.currentTarget.checked)} />Show archived</label>
      <button type="button" className="rm-button" onClick={() => setDialog({ kind: "create" })}><Plus size={15} aria-hidden="true" />New Scenario</button>
    </div>
    {visible.length === 0 ? <EmptyState title="No scenarios" message="Create a base scenario to project cash, income and debt." /> :
      <div className="fc-scroll" role="region" aria-label="Scenarios" tabIndex={0}>
        <table className="rm-table fc-table">
          <thead><tr><th scope="col"><span className="fc-sr-only">Compare</span></th><th scope="col">Scenario</th><th scope="col">Kind</th><th scope="col">State</th><th scope="col" className="fc-num">Version</th><th scope="col">Latest snapshot</th><th scope="col">Weeks from</th></tr></thead>
          <tbody>{visible.map(item => <tr key={item.id} className={item.id === selected?.id ? "fc-row--selected" : undefined}>
            <td><input type="checkbox" aria-label={`Compare ${item.name}`} checked={comparison.includes(item.id)} disabled={!item.latestSnapshot} onChange={() => toggle(item.id)} /></td>
            <th scope="row"><button type="button" className="fc-link" onClick={() => onSelect(item.id)} aria-current={item.id === selected?.id ? "true" : undefined}>{item.name}</button></th>
            <td>{FORECAST_SCENARIO_KIND_LABELS[item.kind]}</td>
            <td><span className={stateClass(item.state)}>{STATE_LABELS[item.state]}</span></td>
            <td className="fc-num">{item.currentAssumptionVersion}</td>
            <td>{item.latestSnapshot ? <>{dateLabel(item.latestSnapshot.createdAt.slice(0, 10), "long")} · v{item.latestSnapshot.assumptionVersion}{!snapshotIsCurrent(item, item.latestSnapshot) && <span className="rm-status rm-status--unknown fc-tag">Stale</span>}{!item.latestSnapshot.checksPassed && <span className="rm-status rm-status--error fc-tag">Checks failed</span>}{item.latestSnapshot.completeness === "partial" && <span className="rm-status rm-status--warning fc-tag">Incomplete opening</span>}</> : <span className="fc-muted">None</span>}</td>
            <td>{dateLabel(item.startDate, "long")}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    {selected && <div className="fc-actions" role="group" aria-label={`Actions for ${selected.name}`}>
      <button type="button" className="rm-button" onClick={() => setDialog({ kind: "create", base: selected })}>Duplicate</button>
      <button type="button" className="rm-button" disabled={selected.state === "archived"} onClick={() => setDialog({ kind: "edit" })}>Edit Settings</button>
      <button type="button" className="rm-button" disabled={!canApprove} title={approveHint} onClick={() => setDialog({ kind: "approve" })}>Approve</button>
      <button type="button" className="rm-button rm-button--ghost" disabled={selected.state === "archived"} onClick={() => setDialog({ kind: "archive" })}>Archive</button>
      {approveHint && selected.state !== "archived" && <span className="fc-muted">{approveHint}</span>}
    </div>}
    {loaded.length >= 1 && weeks.length > 0 && <>
      <LineChart title="Available cash by scenario" periods={weeks.map(week => ({ key: week.key, label: week.start }))}
        series={loaded.map((item, index) => ({ id: item.scenario.id, label: item.run!.result.summary.openingCashKnown === false ? `${item.scenario.name} (relative)` : item.scenario.name, tone: toneOrder[index % 3]!, values: weeks.map(week => item.run!.result.weeks.find(row => row.key === week.key)?.availableClosingCents ?? null) }))}
        floorCents={loaded[0]!.run!.result.scenario.reserveFloorCents} />
      <div className="fc-scroll" role="region" aria-label="Scenario comparison" tabIndex={0}>
        <table className="rm-table fc-table">
          <caption className="fc-table-caption">Comparison of latest snapshots</caption>
          <thead><tr><th scope="col">Measure</th>{loaded.map(item => <th key={item.scenario.id} scope="col" className="fc-num">{item.scenario.name}</th>)}</tr></thead>
          <tbody>
            <tr><th scope="row">Lowest available cash</th>{loaded.map(item => <td key={item.scenario.id} className="fc-num">{moneyWhole(item.run!.result.summary.minAvailableCashCents, item.run!.result.currency)}</td>)}</tr>
            <tr><th scope="row">Weeks below floor</th>{loaded.map(item => <td key={item.scenario.id} className="fc-num">{item.run!.result.summary.weeksBelowFloor ?? "Unknown"}</td>)}</tr>
            <tr><th scope="row">Ending cash</th>{loaded.map(item => <td key={item.scenario.id} className="fc-num">{moneyWhole(item.run!.result.summary.endingCashCents, item.run!.result.currency)}</td>)}</tr>
            <tr><th scope="row">Total NOI</th>{loaded.map(item => <td key={item.scenario.id} className="fc-num">{moneyWhole(item.run!.result.summary.totalNoiCents, item.run!.result.currency)}</td>)}</tr>
            <tr><th scope="row">Net income</th>{loaded.map(item => <td key={item.scenario.id} className="fc-num">{moneyWhole(item.run!.result.summary.totalNetIncomeCents, item.run!.result.currency)}</td>)}</tr>
            <tr><th scope="row">Opening cash</th>{loaded.map(item => <td key={item.scenario.id} className="fc-num">{item.run!.result.summary.openingCashKnown === false ? "Unknown" : "Known"}</td>)}</tr>
            <tr><th scope="row">Opening position</th>{loaded.map(item => <td key={item.scenario.id} className="fc-num">{item.run!.result.completeness === "complete" ? "Complete" : "Incomplete"}</td>)}</tr>
          </tbody>
        </table>
      </div>
    </>}
    {selected?.latestSnapshot && <section className="fc-editor-section" aria-labelledby="fc-compare-heading">
      <div className="fc-section-heading"><h3 id="fc-compare-heading">What changed</h3>
        <label className="fc-inline-field">{selected.name} against <select value={compareB} onChange={event => setCompareB(event.currentTarget.value)}>
          <option value="">Choose a scenario</option>
          {scenarios.filter(item => item.latestSnapshot && item.id !== selected.id).map(item => <option key={item.id} value={item.latestSnapshot!.id}>{item.name}</option>)}
        </select></label></div>
      <Notice error={compare.error} onRetry={() => void compare.refetch()} />
      {compare.data && <>
        <table className="rm-table fc-table fc-table--compact">
          <caption className="fc-table-caption">Changed assumptions{compare.data.assumptionChangesTruncated ? " (first 500)" : ""}</caption>
          <thead><tr><th scope="col">Assumption</th><th scope="col">{compare.data.a.scenarioName}</th><th scope="col">{compare.data.b.scenarioName}</th></tr></thead>
          <tbody>{compare.data.assumptionChanges.length === 0 ? <tr><td colSpan={3} className="fc-muted">Same assumptions.</td></tr> : compare.data.assumptionChanges.slice(0, 50).map(change => <tr key={change.path}>
            <th scope="row"><code>{change.path}</code></th><td>{JSON.stringify(change.before)}</td><td>{JSON.stringify(change.after)}</td></tr>)}</tbody>
        </table>
        <table className="rm-table fc-table fc-table--compact">
          <caption className="fc-table-caption">Largest contributing events ({compare.data.contributingEventCount} differ)</caption>
          <thead><tr><th scope="col">Date</th><th scope="col">Event</th><th scope="col" className="fc-num">Cash difference</th><th scope="col" className="fc-num">Income difference</th></tr></thead>
          <tbody>{compare.data.contributingEvents.map(event => <tr key={event.eventId}><td>{dateLabel(event.date)}</td><td>{event.label}</td>
            <td className="fc-num">{money(event.deltaCashCents)}</td><td className="fc-num">{money(event.deltaIncomeCents)}</td></tr>)}</tbody>
        </table>
      </>}
    </section>}
    {dialog?.kind === "create" && <ScenarioDialog mode="create" base={dialog.base} scenarios={scenarios} onClose={() => setDialog(null)}
      onSubmit={async payload => { const id = await command("forecast.scenario.create", payload); setDialog(null); if (id) onSelect(id); }} />}
    {dialog?.kind === "edit" && selected && <ScenarioDialog mode="edit" current={selected} scenarios={scenarios} onClose={() => setDialog(null)}
      onSubmit={async payload => { await command("forecast.scenario.update", { scenarioId: selected.id, ...payload }, selected.recordRevision); setDialog(null); }} />}
    {dialog?.kind === "approve" && selected?.latestSnapshot && <ApproveDialog scenario={selected} snapshot={selected.latestSnapshot} onClose={() => setDialog(null)}
      onConfirm={async reason => { await command("forecast.scenario.approve", { scenarioId: selected.id, snapshotId: selected.latestSnapshot!.id, ...(reason === null ? {} : { acknowledgeIncompleteOpening: true, reason }) }, selected.recordRevision); setDialog(null); }} />}
    {dialog?.kind === "archive" && selected && <ConfirmDialog title={`Archive ${selected.name}`} message="Archived scenarios keep every version and snapshot but can no longer change." submitLabel="Archive" destructive
      onClose={() => setDialog(null)} onConfirm={async () => { await command("forecast.scenario.archive", { scenarioId: selected.id }, selected.recordRevision); setDialog(null); }} />}
  </div>;
}

/** Approval pins the snapshot; unknown opening cash needs a recorded reason. */
export function ApproveDialog({ scenario, snapshot, onClose, onConfirm }: { scenario: ForecastScenarioSummary; snapshot: ForecastSnapshotMeta; onClose: () => void; onConfirm: (reason: string | null) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const cashUnknown = !snapshot.openingCashKnown;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (cashUnknown && !reason.trim()) { setError(new Error("Give a reason for approving without opening cash.")); return; }
    setSaving(true); setError(undefined);
    try { await onConfirm(cashUnknown ? reason.trim() : null); } catch (problem) { setError(problem); setSaving(false); }
  };
  return <Dialog title={`Approve ${scenario.name}`} onClose={onClose} onSubmit={submit} saving={saving} submitLabel="Approve">
    <Notice error={error} />
    <p className="fc-dialog-note">Approval pins the snapshot from {dateLabel(snapshot.createdAt.slice(0, 10), "long")} (version {snapshot.assumptionVersion}). Editing assumptions or settings later returns the scenario to draft.</p>
    {cashUnknown && <>
      <p className="fc-dialog-note">Opening cash is unknown, so cash balances in this snapshot are relative movements and the reserve floor cannot be tested.</p>
      <Field label="Reason for approving without opening cash" wide><textarea data-autofocus rows={3} maxLength={1000} value={reason} onChange={event => setReason(event.currentTarget.value)} /></Field>
    </>}
  </Dialog>;
}

function ConfirmDialog({ title, message, submitLabel, destructive = false, onClose, onConfirm }: { title: string; message: string; submitLabel: string; destructive?: boolean; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(undefined);
    try { await onConfirm(); } catch (problem) { setError(problem); setSaving(false); }
  };
  return <Dialog title={title} onClose={onClose} onSubmit={submit} saving={saving} submitLabel={submitLabel} destructive={destructive}>
    <Notice error={error} /><p className="fc-dialog-note">{message}</p>
  </Dialog>;
}

function ScenarioDialog({ mode, base, current, scenarios, onClose, onSubmit }: {
  mode: "create" | "edit"; base?: ForecastScenarioSummary; current?: ForecastScenarioSummary; scenarios: readonly ForecastScenarioSummary[];
  onClose: () => void; onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const source = current ?? base;
  const [name, setName] = useState(current?.name ?? (base ? `${base.name} copy` : ""));
  const [kind, setKind] = useState<ForecastScenarioKind>(current?.kind ?? (base ? "custom" : "base"));
  const [startDate, setStartDate] = useState(source?.startDate ?? nextMonday());
  const [weeks, setWeeks] = useState(String(source?.horizonWeeks ?? 13));
  const [months, setMonths] = useState(String(source?.horizonMonths ?? 36));
  const [floor, setFloor] = useState(source ? formatInputValue(source.reserveFloorCents) : "0.00");
  const [baseId, setBaseId] = useState(base?.id ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const candidates = useMemo(() => scenarios.filter(item => item.state !== "archived"), [scenarios]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (!name.trim()) throw new Error("Name the scenario.");
      if (new Date(`${startDate}T12:00:00Z`).getUTCDay() !== 1) throw new Error("Forecast weeks start on a Monday; choose a Monday.");
      const horizonWeeks = Number(weeks); const horizonMonths = Number(months);
      if (!Number.isInteger(horizonWeeks) || horizonWeeks < 1 || horizonWeeks > 104) throw new Error("Weeks must be between 1 and 104.");
      if (!Number.isInteger(horizonMonths) || horizonMonths < 1 || horizonMonths > 360) throw new Error("Months must be between 1 and 360.");
      const reserveFloorCents = parseMoneyInput(floor, "Reserve floor").cents;
      if (reserveFloorCents.startsWith("-")) throw new Error("Reserve floor cannot be negative.");
      setSaving(true); setError(undefined);
      const payload: Record<string, unknown> = { name: name.trim(), kind, startDate, horizonWeeks, horizonMonths, reserveFloorCents };
      if (mode === "create" && baseId) payload.baseScenarioId = baseId;
      if (mode === "edit" && current) {
        for (const [key, value] of Object.entries({ name: current.name, kind: current.kind, startDate: current.startDate, horizonWeeks: current.horizonWeeks, horizonMonths: current.horizonMonths, reserveFloorCents: current.reserveFloorCents })) {
          if (payload[key] === value) delete payload[key];
        }
        if (!Object.keys(payload).length) { onClose(); return; }
      }
      await onSubmit(payload);
    } catch (problem) { setError(problem); setSaving(false); }
  };
  return <Dialog title={mode === "edit" ? "Scenario settings" : base ? `Duplicate ${base.name}` : "New scenario"} onClose={onClose} onSubmit={submit} saving={saving} submitLabel={mode === "edit" ? "Save Settings" : "Create Scenario"}>
    <Notice error={error} />
    <div className="rm-form-grid">
      <Field label="Name" wide><input data-autofocus value={name} maxLength={160} onChange={event => setName(event.currentTarget.value)} placeholder="Downside – slower lease-up" /></Field>
      <Field label="Kind"><select value={kind} onChange={event => setKind(event.currentTarget.value as ForecastScenarioKind)}>{FORECAST_SCENARIO_KINDS.map(value => <option key={value} value={value}>{FORECAST_SCENARIO_KIND_LABELS[value]}</option>)}</select></Field>
      <Field label="First week (Monday)"><input type="date" value={startDate} onChange={event => setStartDate(event.currentTarget.value)} /></Field>
      <Field label="Weeks"><input inputMode="numeric" value={weeks} onChange={event => setWeeks(event.currentTarget.value)} /></Field>
      <Field label="Months"><input inputMode="numeric" value={months} onChange={event => setMonths(event.currentTarget.value)} /></Field>
      <Field label="Reserve floor"><input inputMode="decimal" value={floor} onChange={event => setFloor(event.currentTarget.value)} /></Field>
      {mode === "create" && <Field label="Start from"><select value={baseId} onChange={event => setBaseId(event.currentTarget.value)}>
        <option value="">Empty assumptions</option>{candidates.map(item => <option key={item.id} value={item.id}>{item.name} (version {item.currentAssumptionVersion})</option>)}</select></Field>}
    </div>
  </Dialog>;
}
