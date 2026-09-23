import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Search, X } from "lucide-react";
import type { CompanyContextOrganization } from "@shared/company/context";
import type { ReportEntry, ReportReferenceKind, ReportReferenceOption, ReportRunRequest, ReportingFilterDefinition } from "@shared/reporting";
import { workspaceToday } from "../rent-ops/workspace/workspace-date";
import { reportingApi } from "./api";
import type { ReportingApi } from "./types";
import {
  availableProperties, availableUnits, buildReportRunRequest, initialSetupState, isFinancialBasis, isLocalReference, runnableScenarios,
  serverReferenceKind, visibleSetupFilters, withEntities, withProperties, type ReportSetupError, type ReportSetupState,
} from "./setup-model";

interface SetupProps {
  readonly entry: ReportEntry;
  readonly organization: CompanyContextOrganization;
  readonly onRun: (request: ReportRunRequest, labels: Readonly<Record<string, string>>) => void;
  readonly running: boolean;
  readonly initialRequest?: ReportRunRequest;
  readonly api?: Pick<ReportingApi, "references" | "forecastScenarios">;
  readonly today?: string;
}

type Option = { readonly value: string; readonly label: string; readonly detail?: string | null };

function Field({ label, error, children, wide }: { label: string; error?: string; children: (id: string) => ReactNode; wide?: boolean }) {
  const id = useId();
  return <div className={`reporting-field${wide ? " is-wide" : ""}`}><label htmlFor={id}>{label}</label>{children(id)}{error && <span className="reporting-field-error" role="alert">{error}</span>}</div>;
}

/** Multi-select with type-to-filter; checkboxes carry the real selection state. */
function ChoiceList({ id, label, options, selected, onChange, multiple = true, emptyLabel, loading, onSearch, onMore, reason, onLabel }: {
  id: string; label: string; options: readonly Option[]; selected: readonly string[]; onChange: (values: string[]) => void; multiple?: boolean;
  emptyLabel: string; loading?: boolean; onSearch?: (search: string) => void; onMore?: () => void; reason?: string | null;
  /** Remembers display names for the applied-filter summary; IDs are never shown. */
  onLabel?: (value: string, label: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const known = useRef(new Map<string, string>());
  for (const option of options) known.current.set(option.value, option.label);
  const visible = onSearch || !search.trim() ? options : options.filter(option => `${option.label} ${option.detail ?? ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const summary = selected.length === 0 ? emptyLabel : selected.length === 1 ? known.current.get(selected[0]!) ?? "1 selected" : `${selected.length} selected`;
  const toggle = (value: string) => {
    onLabel?.(value, known.current.get(value) ?? value);
    if (!multiple) { onChange(selected[0] === value ? [] : [value]); setOpen(false); return; }
    onChange(selected.includes(value) ? selected.filter(item => item !== value) : [...selected, value]);
  };
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild><button id={id} type="button" className="reporting-choice-trigger" aria-haspopup="listbox" aria-expanded={open}><span className={selected.length ? "" : "is-placeholder"}>{summary}</span><ChevronDown size={15} aria-hidden="true" /></button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="reporting-choice-popover" align="start" sideOffset={6} collisionPadding={12}>
      <div className="reporting-choice-search"><Search size={15} aria-hidden="true" /><input aria-label={`Search ${label.toLowerCase()}`} placeholder="Search" value={search} autoFocus onChange={event => { setSearch(event.currentTarget.value); onSearch?.(event.currentTarget.value); }} /></div>
      <div className="reporting-choice-list" role="listbox" aria-label={label} aria-multiselectable={multiple}>
        {visible.map(option => {
          const checked = selected.includes(option.value);
          return <div key={option.value} role="option" aria-selected={checked} className={`reporting-choice-option${checked ? " is-selected" : ""}`} tabIndex={0} onClick={() => toggle(option.value)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(option.value); } }}>
            <span className="reporting-choice-check" aria-hidden="true">{checked && <Check size={14} />}</span><span className="reporting-choice-label">{option.label}{option.detail && <small>{option.detail}</small>}</span>
          </div>;
        })}
        {!visible.length && <div className="reporting-choice-empty">{loading ? "Loading…" : reason ?? "No matches"}</div>}
      </div>
      <div className="reporting-choice-footer">
        {onMore && <button type="button" className="reporting-quiet-button" onClick={onMore}>Show more</button>}
        {selected.length > 0 && <button type="button" className="reporting-quiet-button" onClick={() => onChange([])}><X size={14} aria-hidden="true" />Clear</button>}
      </div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}

/** Server-backed reference choices, scoped to the principal's grants and selected entities. */
function ReferenceChoice({ id, filter, kind, organizationId, entityIds, value, onChange, api, onLabel }: {
  id: string; filter: ReportingFilterDefinition; kind: ReportReferenceKind; organizationId: string; entityIds: readonly string[];
  value: unknown; onChange: (value: unknown) => void; api: Pick<ReportingApi, "references">; onLabel?: (value: string, label: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [extra, setExtra] = useState<{ items: ReportReferenceOption[]; cursor: string | null; loaded: boolean }>({ items: [], cursor: null, loaded: false });
  useEffect(() => { const timer = setTimeout(() => setDebounced(search), 200); return () => clearTimeout(timer); }, [search]);
  const query = useQuery({
    queryKey: ["company-reporting", "references", organizationId, kind, debounced, entityIds.join(",")],
    queryFn: ({ signal }) => api.references(organizationId, kind, { search: debounced, legalEntityIds: entityIds }, signal),
    staleTime: 30_000, retry: false,
  });
  useEffect(() => { setExtra({ items: [], cursor: null, loaded: false }); }, [query.data]);
  const options = [...(query.data?.items ?? []), ...extra.items];
  const nextCursor = extra.loaded ? extra.cursor : query.data?.nextCursor ?? null;
  const more = async () => {
    if (!nextCursor) return;
    const page = await api.references(organizationId, kind, { search: debounced, cursor: nextCursor, legalEntityIds: entityIds });
    setExtra(current => ({ items: [...current.items, ...page.items], cursor: page.nextCursor, loaded: true }));
  };
  const selected = Array.isArray(value) ? value.map(String) : typeof value === "string" && value ? [value] : [];
  return <ChoiceList id={id} label={filter.label} options={options} selected={selected} multiple={filter.multiple} emptyLabel={filter.multiple ? "All" : "Any"}
    loading={query.isLoading} reason={query.error ? "Choices could not be loaded." : query.data?.reason ?? null} onSearch={setSearch} onMore={nextCursor ? () => void more() : undefined} onLabel={onLabel}
    onChange={values => onChange(filter.multiple ? values : values[0] ?? "")} />;
}

function FilterControl({ id, filter, value, onChange, organization, state, api, onLabel }: { id: string; filter: ReportingFilterDefinition; value: unknown; onChange: (value: unknown) => void; organization: CompanyContextOrganization; state: ReportSetupState; api: Pick<ReportingApi, "references">; onLabel: (value: string, label: string) => void }) {
  const referenceKind = serverReferenceKind(filter);
  if (referenceKind) return <ReferenceChoice id={id} filter={filter} kind={referenceKind} organizationId={organization.id} entityIds={state.entityIds} value={value} onChange={onChange} api={api} onLabel={onLabel} />;
  if (isLocalReference(filter)) {
    const options = filter.reference === "unit" ? availableUnits(organization, state.entityIds, state.propertyIds) : availableProperties(organization, state.entityIds);
    const selected = Array.isArray(value) ? value.map(String) : typeof value === "string" && value ? [value] : [];
    return <ChoiceList id={id} label={filter.label} options={options} selected={selected} multiple={filter.multiple} emptyLabel={filter.multiple ? "All" : "Any"} reason="No choices for this scope" onLabel={onLabel} onChange={values => onChange(filter.multiple ? values : values[0] ?? "")} />;
  }
  if (filter.kind === "date") return <input id={id} type="date" value={typeof value === "string" ? value : ""} onChange={event => onChange(event.currentTarget.value)} />;
  if (filter.kind === "month") return <input id={id} type="month" value={typeof value === "string" ? value : ""} onChange={event => onChange(event.currentTarget.value)} />;
  if (filter.kind === "boolean") return <input id={id} type="checkbox" checked={value === true} onChange={event => onChange(event.currentTarget.checked)} />;
  if (filter.options && (filter.multiple || filter.kind === "multi_select")) {
    const selected = Array.isArray(value) ? value.map(String) : [];
    return <ChoiceList id={id} label={filter.label} options={filter.options} selected={selected} emptyLabel="All" onChange={onChange} />;
  }
  if (filter.options) return <select id={id} value={typeof value === "string" ? value : ""} onChange={event => onChange(event.currentTarget.value)}>{filter.default === undefined && <option value="">Any</option>}{filter.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
  if (filter.kind === "money" || filter.kind === "number") return <input id={id} inputMode="decimal" value={typeof value === "string" ? value : ""} onChange={event => onChange(event.currentTarget.value)} />;
  return <input id={id} type={filter.name === "search" ? "search" : "text"} value={typeof value === "string" ? value : ""} onChange={event => onChange(event.currentTarget.value)} />;
}

function ScenarioControl({ id, organizationId, value, onChange, api }: { id: string; organizationId: string; value: string; onChange: (value: string) => void; api: Pick<ReportingApi, "forecastScenarios"> }) {
  const scenarios = useQuery({ queryKey: ["company-reporting", "forecast-scenarios", organizationId], queryFn: ({ signal }) => api.forecastScenarios(organizationId, signal), staleTime: 30_000, retry: false });
  const runnable = runnableScenarios(scenarios.data ?? []);
  if (scenarios.isLoading) return <span className="reporting-inline-note" role="status">Loading scenarios…</span>;
  if (scenarios.error) return <span className="reporting-inline-note">Scenarios could not be loaded.</span>;
  if (!runnable.length) return <span className="reporting-inline-note">No scenarios yet</span>;
  return <select id={id} value={value} onChange={event => onChange(event.currentTarget.value)}><option value="">Choose a scenario</option>{runnable.map(scenario => <option key={scenario.scenarioId} value={scenario.scenarioId}>{scenario.name}</option>)}</select>;
}

function EliminationControl({ id, organizationId, value, onChange, api }: { id: string; organizationId: string; value: string; onChange: (value: string) => void; api: Pick<ReportingApi, "references"> }) {
  const versions = useQuery({ queryKey: ["company-reporting", "references", organizationId, "elimination_version"], queryFn: ({ signal }) => api.references(organizationId, "elimination_version", {}, signal), staleTime: 30_000, retry: false });
  const items = versions.data?.items ?? [];
  return <select id={id} value={value} onChange={event => onChange(event.currentTarget.value)} disabled={versions.isLoading}>
    <option value="">No eliminations</option>
    {items.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
  </select>;
}

export function ReportSetup({ entry, organization, onRun, running, initialRequest, api = reportingApi, today = workspaceToday() }: SetupProps) {
  const [state, setState] = useState<ReportSetupState>(() => initialSetupState(entry, organization, today, initialRequest));
  const [errors, setErrors] = useState<readonly ReportSetupError[]>([]);
  const labels = useRef<Record<string, string>>({});
  const scenarios = useQuery({ queryKey: ["company-reporting", "forecast-scenarios", organization.id], queryFn: ({ signal }) => api.forecastScenarios(organization.id, signal), staleTime: 30_000, retry: false, enabled: entry.setup.forecastScenario });
  const filters = useMemo(() => visibleSetupFilters(entry), [entry]);
  const errorFor = (field: string) => errors.find(error => error.field === field)?.message;
  const update = (name: string, value: unknown) => setState(current => ({ ...current, filters: { ...current.filters, [name]: value } }));
  const financial = isFinancialBasis(entry);
  const bases = entry.basis.filter(value => value === "cash" || value === "accrual");
  const entityOptions = organization.entities.map(entity => ({ value: entity.id, label: entity.name }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = buildReportRunRequest(entry, organization, state, scenarios.data ?? []);
    if (!result.ok) { setErrors(result.errors); return; }
    setErrors([]);
    onRun(result.request, { ...labels.current });
  };
  const reset = () => { setState(initialSetupState(entry, organization, today)); setErrors([]); };
  const general = errors.filter(error => !["legalEntityIds", "period", "currency", "forecast", ...filters.map(filter => filter.name)].includes(error.field));
  return <form className="reporting-setup" onSubmit={submit} aria-label={`${entry.title} setup`} noValidate>
    <div className="reporting-setup-grid">
      <fieldset>
        <legend>Scope</legend>
        {entry.setup.entityScope === "exactly_one"
          ? <Field label="Legal entity" error={errorFor("legalEntityIds")}>{id => <select id={id} value={state.entityIds[0] ?? ""} onChange={event => setState(current => withEntities(current, organization, event.currentTarget.value ? [event.currentTarget.value] : []))}><option value="">Choose a legal entity</option>{entityOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>}</Field>
          : <Field label="Legal entities" error={errorFor("legalEntityIds")}>{id => <ChoiceList id={id} label="Legal entities" options={entityOptions} selected={state.entityIds} emptyLabel={entry.setup.entityScope === "optional" ? "All authorized" : "Choose"} onChange={values => setState(current => withEntities(current, organization, values))} />}</Field>}
        {entry.setup.propertyScope && <Field label="Properties">{id => <ChoiceList id={id} label="Properties" options={availableProperties(organization, state.entityIds)} selected={state.propertyIds} emptyLabel="All in scope" reason="No properties for these entities" onChange={values => setState(current => withProperties(current, organization, values))} />}</Field>}
      </fieldset>
      <fieldset>
        <legend>Period</legend>
        {entry.period === "custom" && <div className="reporting-segmented" role="radiogroup" aria-label="Period type">
          {(["range", "as_of"] as const).map(mode => <button key={mode} type="button" role="radio" aria-checked={state.customMode === mode} className={state.customMode === mode ? "is-selected" : ""} onClick={() => setState(current => ({ ...current, customMode: mode }))}>{mode === "range" ? "Date range" : "As of"}</button>)}
        </div>}
        {(entry.period === "range" || (entry.period === "custom" && state.customMode === "range")) && <>
          <Field label="From">{id => <input id={id} type="date" value={state.from} onChange={event => setState(current => ({ ...current, from: event.currentTarget.value }))} />}</Field>
          <Field label="Through" error={errorFor("period")}>{id => <input id={id} type="date" value={state.through} onChange={event => setState(current => ({ ...current, through: event.currentTarget.value }))} />}</Field>
        </>}
        {(entry.period === "as_of" || (entry.period === "custom" && state.customMode === "as_of")) && <Field label="As of" error={errorFor("period")}>{id => <input id={id} type="date" value={state.asOf} onChange={event => setState(current => ({ ...current, asOf: event.currentTarget.value }))} />}</Field>}
        {entry.period === "month" && <Field label="Month" error={errorFor("period")}>{id => <input id={id} type="month" value={state.month} onChange={event => setState(current => ({ ...current, month: event.currentTarget.value }))} />}</Field>}
        {financial && <>
          {bases.length > 1 ? <div className="reporting-field"><span className="reporting-field-label" id={`${entry.id}-basis`}>Basis</span><div className="reporting-segmented" role="radiogroup" aria-labelledby={`${entry.id}-basis`}>{bases.map(value => <button key={value} type="button" role="radio" aria-checked={state.basis === value} className={state.basis === value ? "is-selected" : ""} onClick={() => setState(current => ({ ...current, basis: value }))}>{value === "cash" ? "Cash" : "Accrual"}</button>)}</div></div> : <p className="reporting-inline-note">{bases[0] === "accrual" ? "Accrual basis" : "Cash basis"}</p>}
          <Field label="Currency" error={errorFor("currency")}>{id => <input id={id} value={state.currency} maxLength={3} autoComplete="off" onChange={event => setState(current => ({ ...current, currency: event.currentTarget.value.toUpperCase() }))} />}</Field>
        </>}
      </fieldset>
      {(filters.length > 0 || entry.setup.forecastScenario || entry.setup.consolidation) && <fieldset>
        <legend>{entry.setup.forecastScenario ? "Scenario" : entry.setup.consolidation ? "Consolidation" : "Filters"}</legend>
        {entry.setup.forecastScenario && <Field label="Forecast scenario" error={errorFor("forecast")}>{id => <ScenarioControl id={id} organizationId={organization.id} value={state.scenarioId} onChange={value => setState(current => ({ ...current, scenarioId: value }))} api={api} />}</Field>}
        {entry.setup.consolidation && <Field label="Intercompany eliminations">{id => <EliminationControl id={id} organizationId={organization.id} value={state.eliminationVersion} onChange={value => setState(current => ({ ...current, eliminationVersion: value }))} api={api} />}</Field>}
        {filters.map(filter => <Field key={filter.name} label={filter.label} error={errorFor(filter.name)}>{id => <FilterControl id={id} filter={filter} value={state.filters[filter.name]} onChange={value => update(filter.name, value)} organization={organization} state={state} api={api} onLabel={(value, label) => { labels.current[`${filter.name}:${value}`] = label; }} />}</Field>)}
      </fieldset>}
    </div>
    {general.length > 0 && <div className="reporting-error" role="alert">{general.map(error => <p key={`${error.field}:${error.message}`}>{error.message}</p>)}</div>}
    <div className="reporting-setup-actions">
      <button className="reporting-primary" type="submit" disabled={running}>{running ? "Running…" : "Run Report"}</button>
      <button className="reporting-quiet-button" type="button" onClick={reset} disabled={running}>Reset</button>
    </div>
  </form>;
}
