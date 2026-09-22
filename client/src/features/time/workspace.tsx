import { useEffect, useMemo, useState, type FormEvent } from "react";
import { LoaderCircle, RefreshCw, RotateCcw, Save, Search, UploadCloud } from "lucide-react";
import { timeEntryTypeSchema, type TimeConnectionScope, type TimeEntry, type TimeEnvironment } from "@shared/time";
import { commandEnvelope, scopeFromFilters, timeApi } from "./api";
import type { TimeApi, TimeConnectionSummary, TimeContactOption, TimeProjectOption, TimeWorkspaceEntity, TimeWorkspaceProps } from "./types";
import "./time.css";

function label(value: string | null | undefined): string {
  return value ? value.replace(/_/g, " ").replace(/\b\w/g, letter => letter.toUpperCase()) : "—";
}

function dateLabel(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value.includes("T") ? value : `${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function dateTimeLabel(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function durationLabel(seconds: number): string {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

function moneyCents(value: string | null, currency: string | null): string {
  if (value === null) return "—";
  const cents = BigInt(value);
  const negative = cents < 0;
  const absolute = (negative ? -cents : cents).toString().padStart(3, "0");
  return `${negative ? "-" : ""}${currency ?? "—"} ${absolute.slice(0, -2)}.${absolute.slice(-2)}`;
}

function localInput(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function durationBetween(start: string, end: string, startChoice: string, endChoice: string): number | null {
  const first = fixedIso(start, startChoice).iso;
  const second = fixedIso(end, endChoice).iso;
  if (!first || !second) return null;
  const seconds = Math.round((Date.parse(second) - Date.parse(first)) / 1_000);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function badgeClass(value: string): string {
  if (["approved", "mapped", "complete"].includes(value)) return "time-badge is-positive";
  if (["rejected", "overlap", "invalid_duration", "multiple_active", "unmapped_employee", "unmapped_jobcode"].includes(value)) return "time-badge is-warning";
  return "time-badge";
}

function Message({ message, error }: { message: string | null; error: string | null }) {
  if (!message && !error) return null;
  return <div className={`time-message ${error ? "is-error" : "is-success"}`} role={error ? "alert" : "status"}>{error ?? message}</div>;
}

function scopeFor(organizationId: string, legalEntityId: string, environment: TimeEnvironment, providerCompanyId: string): TimeConnectionScope {
  return scopeFromFilters(organizationId, { legalEntityId, environment, providerCompanyId });
}

function centsFromText(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+(?:\.\d{0,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  return (BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"))).toString();
}

function dollarsFromCents(value: string | null | undefined): string {
  if (!value) return "";
  const negative = value.startsWith("-");
  const absolute = (negative ? value.slice(1) : value).padStart(3, "0");
  return `${negative ? "-" : ""}${absolute.slice(0, -2)}.${absolute.slice(-2)}`;
}

function offsetLabel(minutes: number): string {
  const sign = minutes >= 0 ? "+" : "-";
  const absolute = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

function fixedIso(value: string, choice: string): { iso: string | null; minutes: number | null; name: string | null } {
  if (!value) return { iso: null, minutes: null, name: null };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { iso: null, minutes: null, name: null };
  const minutes = choice === "device" ? -date.getTimezoneOffset() : Number(choice);
  if (!Number.isFinite(minutes)) return { iso: null, minutes: null, name: null };
  return { iso: `${value}:00${offsetLabel(minutes).replace("UTC", "")}`, minutes, name: choice === "device" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "fixed_offset" };
}

type TimeWorkspaceData = {
  readonly items: readonly TimeEntry[];
  readonly nextCursor: string | null;
  readonly coverage: readonly import("@shared/time").TimeCoverage[];
  readonly users: Awaited<ReturnType<TimeApi["listUsers"]>>;
  readonly jobcodes: Awaited<ReturnType<TimeApi["listJobcodes"]>>;
  readonly employeeMappings: Awaited<ReturnType<TimeApi["listEmployeeMappings"]>>;
  readonly jobcodeMappings: Awaited<ReturnType<TimeApi["listJobcodeMappings"]>>;
  readonly connections: readonly TimeConnectionSummary[];
  readonly contacts: readonly TimeContactOption[];
  readonly projects: readonly TimeProjectOption[];
};

export function TimeWorkspace({ organizationId, organizationName, entities = [], api = timeApi }: TimeWorkspaceProps) {
  const [legalEntityId, setLegalEntityId] = useState(entities[0]?.id ?? "");
  const [environment, setEnvironment] = useState<TimeEnvironment>("production");
  const [providerCompanyId, setProviderCompanyId] = useState("");
  const [reviewState, setReviewState] = useState<TimeEntry["reviewState"] | "all">("needs_review");
  const [mappingStatus, setMappingStatus] = useState<TimeEntry["mappingStatus"] | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const scope = useMemo(() => providerCompanyId.trim() && legalEntityId ? scopeFor(organizationId, legalEntityId, environment, providerCompanyId.trim()) : null, [environment, legalEntityId, organizationId, providerCompanyId]);
  const entriesQuery = useMemo(() => ({
    legalEntityId,
    environment,
    providerCompanyId: providerCompanyId.trim(),
    reviewState: reviewState === "all" ? undefined : reviewState,
    mappingStatus: mappingStatus === "all" ? undefined : mappingStatus,
    limit: 100,
  }), [environment, legalEntityId, mappingStatus, providerCompanyId, reviewState]);
  const [data, setData] = useState<TimeWorkspaceData | null>(null);

  async function load(signal?: AbortSignal): Promise<void> {
    if (!legalEntityId) { setData(null); return; }
    const [connections, contacts, projects] = await Promise.all([
      api.listConnections(organizationId, legalEntityId, undefined, signal),
      api.listContacts(organizationId, signal),
      api.listProjects(organizationId, legalEntityId, signal),
    ]);
    const environmentConnections = connections.filter(connection => connection.scope.environment === environment);
    const selectedConnection = environmentConnections.find(connection => connection.scope.providerCompanyId === providerCompanyId) ?? environmentConnections[0];
    if (!selectedConnection) {
      setProviderCompanyId("");
      setData({ items: [], nextCursor: null, coverage: [], users: [], jobcodes: [], employeeMappings: [], jobcodeMappings: [], connections, contacts, projects });
      return;
    }
    if (selectedConnection.scope.providerCompanyId !== providerCompanyId) setProviderCompanyId(selectedConnection.scope.providerCompanyId);
    const selectedScope = scopeFor(organizationId, legalEntityId, environment, selectedConnection.scope.providerCompanyId);
    const [entries, users, jobcodes, employeeMappings, jobcodeMappings] = await Promise.all([
      api.listEntries(organizationId, entriesQuery, signal),
      api.listUsers(organizationId, selectedScope, signal),
      api.listJobcodes(organizationId, selectedScope, signal),
      api.listEmployeeMappings(organizationId, selectedScope, signal),
      api.listJobcodeMappings(organizationId, selectedScope, signal),
    ]);
    setData({ ...entries, users, jobcodes, employeeMappings, jobcodeMappings, connections, contacts, projects });
  }

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void load(controller.signal).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Employee time records could not be loaded."); });
    return () => controller.abort();
    // The request is intentionally restarted when the named company selectors change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environment, legalEntityId, providerCompanyId, entriesQuery.reviewState, entriesQuery.mappingStatus]);

  const entries = data?.items ?? [];
  const selected = entries.find(entry => entry.id === selectedId) ?? entries[0] ?? null;
  useEffect(() => { if (selected && selected.id !== selectedId) setSelectedId(selected.id); }, [selected, selectedId]);

  async function execute(kind: string, payload: Record<string, unknown>): Promise<void> {
    if (!scope) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const receipt = await api.sendCommand(organizationId, kind, commandEnvelope(scope, payload));
      setNotice(receipt.validationOutcomes.find(item => item.severity === "info")?.message ?? "Saved in R-ops.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The action could not be confirmed.");
    } finally { setSaving(false); }
  }

  async function refresh(): Promise<void> {
    setError(null); setNotice(null);
    try { await load(); setNotice("Time records refreshed."); } catch (reason) { setError(reason instanceof Error ? reason.message : "Employee time records could not be loaded."); }
  }

  async function sync(): Promise<void> {
    if (!scope) return;
    setSyncing(true); setError(null); setNotice(null);
    try {
      const result = await api.sync(organizationId, scope);
      await load();
      setNotice(result.conflicts.length ? `Sync finished with ${result.conflicts.length} records needing review.` : `Sync finished: ${result.status === "partial" ? "some records remain to be fetched" : "all available records are current"}.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Time records could not be synced."); } finally { setSyncing(false); }
  }

  async function connect(): Promise<void> {
    if (!legalEntityId || connecting) return;
    setConnecting(true); setError(null); setNotice(null);
    try {
      const selectedConnection = data?.connections.find(connection => connection.scope.environment === environment && connection.scope.providerCompanyId === providerCompanyId);
      const result = await api.beginConnection(organizationId, legalEntityId, selectedConnection?.scope.providerCompanyId);
      setEnvironment(result.environment);
      globalThis.location.assign(result.authorizationUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "QuickBooks Time setup could not be started.");
      setConnecting(false);
    }
  }

  const selectedConnection = data?.connections.find(connection => connection.scope.environment === environment && connection.scope.providerCompanyId === providerCompanyId);
  const connectionOptions = (data?.connections ?? []).filter(connection => connection.scope.environment === environment);
  const connectLabel = selectedConnection?.status === "needs_reconnect" || selectedConnection?.status === "revoked" ? "Reconnect QuickBooks Time" : "Connect QuickBooks Time";

  return <section className="time-workspace" aria-labelledby="time-workspace-title">
    <header className="time-toolbar">
      <div><h1 id="time-workspace-title">{organizationName ?? "Company"} employee time</h1></div>
      <div className="time-actions"><button type="button" className="time-button time-button-secondary" onClick={() => void connect()} disabled={!legalEntityId || saving || syncing || connecting}>{connecting ? "Opening setup…" : connectLabel}</button><button type="button" className="time-button time-button-secondary" onClick={() => void refresh()} disabled={!scope || saving || syncing || connecting}><RefreshCw size={15} />Refresh</button><button type="button" className="time-button time-button-primary" onClick={() => void sync()} disabled={!scope || saving || syncing || connecting}><UploadCloud size={15} />{syncing ? "Syncing…" : "Sync provider records"}</button></div>
    </header>
    <div className="time-selector-bar">
      <label>Company<select aria-label="Company" value={organizationId} disabled><option value={organizationId}>{organizationName ?? organizationId}</option></select></label>
      <label>Legal entity<select aria-label="Legal entity" value={legalEntityId} onChange={event => setLegalEntityId(event.currentTarget.value)}><option value="">Select legal entity</option>{entities.map(entity => <option key={entity.id} value={entity.id}>{entity.name}</option>)}</select></label>
      <label>Provider environment<select aria-label="Provider environment" value={environment} onChange={event => setEnvironment(event.currentTarget.value as TimeEnvironment)}><option value="production">Production</option><option value="sandbox">Sandbox</option></select></label>
      <label>Time connection<select aria-label="Time connection" value={providerCompanyId} onChange={event => setProviderCompanyId(event.currentTarget.value)} disabled={!legalEntityId}><option value="">{legalEntityId ? "Select connection" : "Select legal entity first"}</option>{connectionOptions.map(connection => <option key={connection.scope.providerCompanyId} value={connection.scope.providerCompanyId}>{connection.name}{connection.status === "needs_reconnect" ? " · Needs reconnect" : connection.status === "revoked" ? " · Revoked" : ""}</option>)}</select></label>
    </div>
    <Message message={notice} error={error} />
    {!scope ? <div className="time-empty" role="status"><Search size={22} /><strong>{legalEntityId ? "Connect QuickBooks Time or select a connection." : "Select a legal entity."}</strong>{legalEntityId && <button type="button" className="time-button time-button-primary" onClick={() => void connect()} disabled={connecting}>{connecting ? "Opening setup…" : connectLabel}</button>}</div> : <div className="time-layout">
      <aside className="time-list-pane" aria-label="Time records">
        <div className="time-filter-bar"><label>Review<select aria-label="Review state" value={reviewState} onChange={event => setReviewState(event.currentTarget.value as typeof reviewState)}><option value="all">All review states</option><option value="needs_review">Needs review</option><option value="corrected">Corrected</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select></label><label>Mapping<select aria-label="Mapping status" value={mappingStatus} onChange={event => setMappingStatus(event.currentTarget.value as typeof mappingStatus)}><option value="all">All mappings</option><option value="unmapped_employee">Unmapped employee</option><option value="unmapped_jobcode">Unmapped jobcode</option><option value="mapped">Mapped</option></select></label></div>
        {entries.length === 0 ? <div className="time-empty time-empty-small">No time records match these filters.</div> : <div className="time-list">{entries.map(entry => <button type="button" key={entry.id} className={`time-list-row ${selected?.id === entry.id ? "is-selected" : ""}`} onClick={() => setSelectedId(entry.id)}><span className="time-list-row-top"><strong>{dateLabel(entry.date)}</strong><span className={badgeClass(entry.reviewState)}>{label(entry.reviewState)}</span></span><span>{entry.type === "manual" ? "Manual time" : entry.onTheClock ? "Clocked in" : `${dateTimeLabel(entry.start)} – ${dateTimeLabel(entry.end)}`}</span><small>{durationLabel(entry.durationSeconds)} · {label(entry.mappingStatus)}</small></button>)}</div>}
        {data?.coverage.length ? <div className="time-coverage"><span className="time-eyebrow">Coverage</span>{data.coverage.map(item => <div key={item.stream}><span>{label(item.stream)}</span><span className={badgeClass(item.status)}>{label(item.status)}</span></div>)}</div> : null}
      </aside>
      <main className="time-main">{selected ? <TimeDetail entry={selected} scope={scope} entities={entities} contacts={data?.contacts ?? []} projects={data?.projects ?? []} users={data?.users ?? []} jobcodes={data?.jobcodes ?? []} employeeMappings={data?.employeeMappings ?? []} jobcodeMappings={data?.jobcodeMappings ?? []} execute={execute} saving={saving} /> : <div className="time-empty">Choose a time record to review.</div>}</main>
    </div>}
  </section>;
}

function TimeDetail({ entry, scope, entities, contacts, projects, users, jobcodes, employeeMappings, jobcodeMappings, execute, saving }: { entry: TimeEntry; scope: TimeConnectionScope; entities: readonly TimeWorkspaceEntity[]; contacts: readonly TimeContactOption[]; projects: readonly TimeProjectOption[]; users: Awaited<ReturnType<TimeApi["listUsers"]>>; jobcodes: Awaited<ReturnType<TimeApi["listJobcodes"]>>; employeeMappings: Awaited<ReturnType<TimeApi["listEmployeeMappings"]>>; jobcodeMappings: Awaited<ReturnType<TimeApi["listJobcodeMappings"]>>; execute: (kind: string, payload: Record<string, unknown>) => Promise<void>; saving: boolean }) {
  const user = users.find(item => item.providerUserId === entry.providerUserId);
  const jobcode = jobcodes.find(item => item.providerJobcodeId === entry.providerJobcodeId);
  const employeeMapping = employeeMappings.find(item => item.providerUserId === entry.providerUserId && item.effectiveFrom <= entry.date && (item.effectiveTo === null || entry.date < item.effectiveTo));
  const jobcodeMapping = jobcodeMappings.find(item => item.providerJobcodeId === entry.providerJobcodeId);
  const [type, setType] = useState<"regular" | "manual">(entry.type);
  const [start, setStart] = useState(localInput(entry.start));
  const [end, setEnd] = useState(localInput(entry.end));
  const [date, setDate] = useState<string>(entry.date);
  const [hours, setHours] = useState(String(Math.floor(entry.durationSeconds / 3_600)));
  const [minutes, setMinutes] = useState(String(Math.floor((entry.durationSeconds % 3_600) / 60)));
  const [notes, setNotes] = useState(entry.notes);
  const [reason, setReason] = useState("");
  const [contactId, setContactId] = useState(employeeMapping?.contactId ?? "");
  const [rate, setRate] = useState(dollarsFromCents(employeeMapping?.hourlyRateCents));
  const [propertyId, setPropertyId] = useState(jobcodeMapping?.propertyId ?? "");
  const [projectId, setProjectId] = useState(jobcodeMapping?.projectId ?? "");
  const [costCode, setCostCode] = useState(jobcodeMapping?.costCode ?? "");
  const [activeUserId, setActiveUserId] = useState(entry.providerUserId);
  const [activeJobcodeId, setActiveJobcodeId] = useState(entry.providerJobcodeId);
  const [startOffset, setStartOffset] = useState("device");
  const [endOffset, setEndOffset] = useState("device");
  const deviceOffset = -new Date().getTimezoneOffset();
  const offsetChoices = Array.from(new Map([["device", `Device time (${offsetLabel(deviceOffset)})`], [String(deviceOffset), offsetLabel(deviceOffset)], ["-300", "UTC-05:00 (standard)"], ["-240", "UTC-04:00 (daylight)"], ["0", "UTC+00:00"]])).map(([value, text]) => ({ value, text }));

  useEffect(() => {
    setType(entry.type); setStart(localInput(entry.start)); setEnd(localInput(entry.end)); setDate(entry.date); setHours(String(Math.floor(entry.durationSeconds / 3_600))); setMinutes(String(Math.floor((entry.durationSeconds % 3_600) / 60))); setNotes(entry.notes); setReason(""); setStartOffset("device"); setEndOffset("device");
    setContactId(employeeMapping?.contactId ?? ""); setRate(dollarsFromCents(employeeMapping?.hourlyRateCents)); setPropertyId(jobcodeMapping?.propertyId ?? ""); setProjectId(jobcodeMapping?.projectId ?? ""); setCostCode(jobcodeMapping?.costCode ?? ""); setActiveUserId(entry.providerUserId); setActiveJobcodeId(entry.providerJobcodeId);
  }, [entry, employeeMapping?.contactId, employeeMapping?.hourlyRateCents, jobcodeMapping?.costCode, jobcodeMapping?.projectId, jobcodeMapping?.propertyId]);

  function correct(event: FormEvent): void {
    event.preventDefault();
    const startDetails = type === "regular" ? fixedIso(start, startOffset) : { iso: null, minutes: null, name: null };
    const endDetails = type === "regular" ? fixedIso(end, endOffset) : { iso: null, minutes: null, name: null };
    const startIso = startDetails.iso;
    const endIso = endDetails.iso;
    const calculated = type === "regular" && startIso && endIso ? durationBetween(start, end, startOffset, endOffset) : Number(hours) * 3_600 + Number(minutes) * 60;
    if (!reason.trim()) return;
    if (calculated === null || !Number.isInteger(calculated) || calculated < 0 || (type === "manual" && (!Number.isInteger(Number(minutes)) || Number(minutes) < 0 || Number(minutes) > 59))) return;
    void execute("time.correct_timesheet", { environment: scope.environment, providerCompanyId: scope.providerCompanyId, timesheetId: entry.id, expectedCorrectionRevision: entry.correctionRevision, type, start: startIso, end: endIso, date, durationSeconds: calculated, timezoneOffsetMinutes: type === "regular" ? startDetails.minutes : null, timezoneName: type === "regular" ? startDetails.name : null, notes, reason: reason.trim() });
  }

  const selectedEntity = entities.find(entity => entity.id === scope.legalEntityId);
  return <div className="time-detail">
    <header className="time-detail-head"><div><h2>{user?.displayName ?? "Employee unavailable"}</h2><p>{jobcode?.name ?? "Jobcode unavailable"} · {dateLabel(entry.date)} · {durationLabel(entry.durationSeconds)}</p></div><div className="time-detail-badges"><span className={badgeClass(entry.reviewState)}>{label(entry.reviewState)}</span><span className={badgeClass(entry.mappingStatus)}>{label(entry.mappingStatus)}</span>{entry.locked && <span className="time-badge">Provider locked</span>}</div></header>
    <div className="time-metrics"><div><span>Provider time</span><strong>{entry.onTheClock ? "Clocked in" : durationLabel(entry.durationSeconds)}</strong></div><div><span>Estimated labor</span><strong>{moneyCents(entry.estimatedLaborCostCents, entry.estimatedLaborCurrency)}</strong></div><div><span>Posted payroll</span><strong>{moneyCents(entry.postedPayrollCents, entry.postedPayrollCurrency)}</strong></div><div><span>Last provider change</span><strong>{dateTimeLabel(entry.lastModified)}</strong></div></div>
    <section className="time-card"><div className="time-card-header"><div><h3>Review</h3></div><div className="time-actions"><button type="button" className="time-button time-button-secondary" disabled={saving} onClick={() => void execute("time.review_timesheet", { environment: scope.environment, providerCompanyId: scope.providerCompanyId, timesheetId: entry.id, action: "request_review" })}><RotateCcw size={14} />Request review</button><button type="button" className="time-button time-button-danger" disabled={saving} onClick={() => void execute("time.review_timesheet", { environment: scope.environment, providerCompanyId: scope.providerCompanyId, timesheetId: entry.id, action: "reject", reason: reason.trim() || undefined })}>Reject</button><button type="button" className="time-button time-button-primary" disabled={saving} onClick={() => void execute("time.review_timesheet", { environment: scope.environment, providerCompanyId: scope.providerCompanyId, timesheetId: entry.id, action: "approve" })}>Approve</button></div></div></section>
    <section className="time-card"><div className="time-card-header"><div><h3>Correct time</h3><p>Saved in R-ops; provider payroll is unchanged.</p></div></div><form className="time-form" onSubmit={correct}><label>Entry type<select aria-label="Entry type" value={type} onChange={event => { const next = timeEntryTypeSchema.parse(event.currentTarget.value); setType(next); }}><option value="regular">Regular timestamp</option><option value="manual">Manual date and duration</option></select></label>{type === "regular" ? <><label>Start<input aria-label="Start timestamp" type="datetime-local" value={start} onChange={event => setStart(event.currentTarget.value)} /></label><label>Start time offset<select aria-label="Start time offset" value={startOffset} onChange={event => setStartOffset(event.currentTarget.value)}>{offsetChoices.map(choice => <option key={`start-${choice.value}`} value={choice.value}>{choice.text}</option>)}</select></label><label>End<input aria-label="End timestamp" type="datetime-local" value={end} onChange={event => setEnd(event.currentTarget.value)} /></label><label>End time offset<select aria-label="End time offset" value={endOffset} onChange={event => setEndOffset(event.currentTarget.value)}>{offsetChoices.map(choice => <option key={`end-${choice.value}`} value={choice.value}>{choice.text}</option>)}</select></label><div className="time-form-help">Choose an offset when daylight-saving time makes a local time ambiguous.</div></> : <><label>Date<input aria-label="Manual date" type="date" value={date} onChange={event => setDate(event.currentTarget.value)} /></label><label>Hours<input aria-label="Hours" inputMode="numeric" value={hours} onChange={event => setHours(event.currentTarget.value)} /></label><label>Minutes<input aria-label="Minutes" inputMode="numeric" value={minutes} onChange={event => setMinutes(event.currentTarget.value)} /></label></>}<label className="time-form-wide">Correction reason<textarea aria-label="Correction reason" value={reason} onChange={event => setReason(event.currentTarget.value)} minLength={1} required placeholder="Explain the correction" /></label><label className="time-form-wide">Notes<textarea aria-label="Time notes" value={notes} onChange={event => setNotes(event.currentTarget.value)} /></label><div className="time-form-actions"><button type="submit" className="time-button time-button-primary" disabled={saving || !reason.trim()}><Save size={14} />{saving ? "Saving…" : "Save correction"}</button></div></form></section>
    <section className="time-card"><div className="time-card-header"><div><h3>Mappings</h3><p>Approval requires an employee and jobcode mapping.</p></div></div><div className="time-form time-form-grid"><label>Provider employee<select aria-label="Provider employee" value={activeUserId} onChange={event => setActiveUserId(event.currentTarget.value)}>{users.map(item => <option key={item.providerUserId} value={item.providerUserId}>{item.displayName}</option>)}</select></label><label>R-ops contact<select aria-label="R-ops contact" value={contactId} onChange={event => setContactId(event.currentTarget.value)}><option value="">Select contact</option>{contacts.map(contact => <option key={contact.id} value={contact.id}>{contact.displayName}</option>)}</select></label><label>Hourly rate ({selectedEntity?.currency ?? "currency"})<input aria-label="Hourly rate" inputMode="decimal" value={rate} onChange={event => setRate(event.currentTarget.value)} placeholder="0.00" /></label><label>Provider jobcode<select aria-label="Provider jobcode" value={activeJobcodeId} onChange={event => setActiveJobcodeId(event.currentTarget.value)}>{jobcodes.map(item => <option key={item.providerJobcodeId} value={item.providerJobcodeId}>{item.name}</option>)}</select></label><label>Property<select aria-label="Property for jobcode" value={propertyId} onChange={event => setPropertyId(event.currentTarget.value)}><option value="">No property mapping</option>{selectedEntity?.properties.map(property => <option key={property.id} value={property.id}>{property.name}</option>)}</select></label><label>Project<select aria-label="Project for jobcode" value={projectId} onChange={event => setProjectId(event.currentTarget.value)}><option value="">No project mapping</option>{projects.filter(project => project.legalEntityId === scope.legalEntityId).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label>Cost code<input aria-label="Cost code" value={costCode} onChange={event => setCostCode(event.currentTarget.value)} placeholder="Optional" /></label><div className="time-form-actions time-form-wide"><button type="button" className="time-button time-button-secondary" disabled={saving || !contactId} onClick={() => void execute("time.map_employee", { environment: scope.environment, providerCompanyId: scope.providerCompanyId, providerUserId: activeUserId, contactId, effectiveFrom: entry.date, effectiveTo: null, hourlyRateCents: centsFromText(rate), currency: rate.trim() ? selectedEntity?.currency ?? null : null })}>Save employee mapping</button><button type="button" className="time-button time-button-secondary" disabled={saving} onClick={() => void execute("time.map_jobcode", { environment: scope.environment, providerCompanyId: scope.providerCompanyId, providerJobcodeId: activeJobcodeId, propertyId: propertyId || null, projectId: projectId || null, costCode: costCode.trim() || null })}>Save jobcode mapping</button></div></div></section>
  </div>;
}

export default TimeWorkspace;
