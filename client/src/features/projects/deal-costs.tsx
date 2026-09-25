import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Archive, CircleAlert, Landmark, Pencil, Plus, Search, X } from "lucide-react";
import type { FinancialSourceReference } from "@shared/accounting/source";
import type { CostSourceLine, CostSourceLinePage } from "@shared/projects/source-lines";
import type {
  DealCostLane,
  DealCostSourceKind,
  DealFundingKind,
  DealReconciliationState,
  ProjectDealCost,
  ProjectDealCostReport,
  ProjectDealFunding,
} from "@shared/projects/deal-costs";
import type { ProjectDetail } from "./types";
import { formatTableDate } from "../../lib/rent-ops-formatters";
import { formatInputValue, formatMoney, formatQualifiedMoney, parseMoneyInput } from "./money";

const LANE_LABELS: Readonly<Record<string, string>> = {
  acquisition: "Acquisition",
  rehab: "Rehab",
  financing: "Financing",
  holding: "Holding",
  selling: "Selling",
  unallocated: "Needs allocation",
};
const FUNDING_LABELS: Readonly<Record<string, string>> = {
  deposit: "Deposit",
  loan_principal: "Loan principal",
  reserve: "Reserve",
  contribution: "Contribution",
  intercompany: "Intercompany",
  sale_proceeds: "Sale proceeds",
  settlement_clearing: "Settlement clearing",
};
const SOURCE_LABELS: Record<DealCostSourceKind, string> = { qbo: "QuickBooks", operational: "Operations record", manual: "Manual", estimate: "Estimate" };
const RECONCILIATION_LABELS: Record<DealReconciliationState, string> = { unreconciled: "Unreconciled", source_backed: "Source-backed", qbo_verified: "QBO verified", void: "Void" };
const SOURCE_KINDS: readonly DealCostSourceKind[] = ["manual", "estimate", "operational", "qbo"];

function dateLabel(value: string | null | undefined): string { return formatTableDate(value) ?? "—"; }
function label(value: string): string { return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function laneLabel(value: string): string { return LANE_LABELS[value] ?? label(value); }
function fundingLabel(value: string): string { return FUNDING_LABELS[value] ?? label(value); }
function sourceKey(source: FinancialSourceReference): string { return `${source.environment}:${source.realmId}:${source.objectType}:${source.objectId}:${source.lineId ?? ""}:${source.version}`; }
function optionalMoney(value: string, field: string): string | null {
  return value.trim() === "" ? null : parseMoneyInput(value, field).cents;
}
function requiredMoney(value: string, field: string): string {
  const parsed = optionalMoney(value, field);
  if (parsed === null) throw new Error(`${field} is required.`);
  return parsed;
}
function StatusPill({ children, tone = "muted" }: { children: string; tone?: "positive" | "warning" | "muted" }) {
  return <span className={`projects-deal-pill is-${tone}`}>{children}</span>;
}

function SourceStatus({ sourceKind, reconciliationState }: { sourceKind: DealCostSourceKind; reconciliationState: DealReconciliationState }) {
  const tone = reconciliationState === "qbo_verified" ? "positive" : reconciliationState === "source_backed" ? "warning" : "muted";
  return <span className="projects-deal-source-status"><StatusPill tone={tone}>{SOURCE_LABELS[sourceKind]}</StatusPill><StatusPill tone={tone}>{RECONCILIATION_LABELS[reconciliationState]}</StatusPill></span>;
}

function QboSourcePicker({ project, search, selected, onSelect, disabled }: { project: ProjectDetail; search: (query: { search?: string; cursor?: string; environment?: "sandbox" | "production"; realmId?: string }) => Promise<CostSourceLinePage>; selected?: CostSourceLine; onSelect: (line: CostSourceLine | undefined) => void; disabled: boolean }) {
  const scopes = useMemo(() => Array.from(new Map(project.qboProjectIdentities.filter(identity => identity.recordKind === "Project").map(identity => {
    const key = `${identity.environment}:${identity.realmId}`;
    return [key, { key, environment: identity.environment, realmId: identity.realmId }];
  })).values()), [project.qboProjectIdentities]);
  const [scopeKey, setScopeKey] = useState(() => scopes.length === 1 ? scopes[0]!.key : "");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<CostSourceLinePage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const selectedScope = scopes.find(scope => scope.key === scopeKey);
  const run = async (cursor?: string) => {
    if (!selectedScope) { setError("Link this project to QuickBooks before choosing a line."); return; }
    setLoading(true); setError(undefined);
    try {
      const next = await search({ search: query, cursor, environment: selectedScope.environment, realmId: selectedScope.realmId });
      setPage(cursor && page ? { items: [...page.items, ...next.items], nextCursor: next.nextCursor } : next);
    } catch (next) { setError(next instanceof Error ? next.message : "QuickBooks lines could not be loaded."); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (selectedScope) void run(); /* initial search only */ }, [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (scopes.length === 0) return <p className="projects-muted">Link the project to QuickBooks to choose a verified source line. You can save this as a manual or estimate row.</p>;
  return <div className="projects-deal-source-picker" aria-label="QuickBooks source line picker">
    <div className="projects-deal-form-grid">
      {scopes.length > 1 && <label className="projects-deal-field"><span>QuickBooks books</span><select value={scopeKey} onChange={(event) => { setScopeKey(event.currentTarget.value); setPage(undefined); onSelect(undefined); }} disabled={disabled}><option value="">Choose books</option>{scopes.map(scope => <option key={scope.key} value={scope.key}>{scope.environment === "production" ? "Live books" : "Test books"}</option>)}</select></label>}
      <label className="projects-deal-field projects-deal-search-field"><span>Search source lines</span><div className="projects-deal-search"><Search size={15} /><input value={query} placeholder="Description or document" onChange={(event) => setQuery(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void run(); } }} disabled={disabled} /><button type="button" className="projects-button projects-button-secondary" onClick={() => void run()} disabled={disabled || loading}>Search</button></div></label>
    </div>
    {error && <div className="projects-error" role="alert"><CircleAlert size={16} /><span>{error}</span></div>}
    {loading && !page ? <div className="projects-state" role="status">Loading QuickBooks lines…</div> : page && page.items.length === 0 ? <div className="projects-state projects-empty"><strong>No source lines found</strong></div> : page && <div className="projects-table-wrap projects-source-results"><table className="projects-table"><thead><tr><th><span className="projects-sr-only">Select</span></th><th>Line</th><th>Posted</th><th className="projects-number">Available</th></tr></thead><tbody>{page.items.map(item => <tr key={sourceKey(item.source)} className={selected && sourceKey(selected.source) === sourceKey(item.source) ? "is-selected" : undefined}><td><input type="radio" name="deal-cost-source-line" aria-label={item.description ?? item.transactionType} checked={Boolean(selected && sourceKey(selected.source) === sourceKey(item.source))} onChange={() => onSelect(item)} disabled={disabled} /></td><td><strong>{item.description ?? item.transactionType}</strong><small className="projects-table-subline">{item.transactionType}{item.direction === "credit" ? " · Cost refund" : ""}</small></td><td>{dateLabel(item.postedOn)}</td><td className="projects-number">{formatMoney(item.direction === "credit" ? `-${item.availableCents}` : item.availableCents, item.currency)}</td></tr>)}</tbody></table>{page.nextCursor && <button type="button" className="projects-load-more" onClick={() => void run(page.nextCursor!)} disabled={disabled || loading}>{loading ? "Loading…" : "Load more lines"}</button>}</div>}
    {selected && <p className="projects-deal-selected-source"><Landmark size={14} />Selected: {selected.description ?? selected.transactionType} · {dateLabel(selected.postedOn)}</p>}
  </div>;
}

function DialogFrame({ title, children, onClose, saving }: { title: string; children: ReactNode; onClose: () => void; saving: boolean }) {
  return <div className="projects-deal-dialog" role="dialog" aria-modal="true" aria-label={title}><div className="projects-deal-dialog-card"><header className="projects-deal-dialog-header"><div><span className="projects-eyebrow">Deal costs</span><h3>{title}</h3></div><button type="button" className="projects-icon-button" aria-label="Close" onClick={onClose} disabled={saving}><X size={18} /></button></header>{children}</div></div>;
}

export type CostFormValues = {
  lane: DealCostLane;
  description: string;
  vendorName: string;
  budgetCents: string;
  amountCents: string;
  forecastCents: string;
  paidCents: string;
  incurredOn: string;
  paidOn: string;
  prepaid: boolean;
  sourceKind: DealCostSourceKind;
  reconciliationState: DealReconciliationState;
  sourceEvidenceReference: string;
  settlementReference: string;
  settlementObservedOn: string;
};

function costFormDefaults(cost?: ProjectDealCost): CostFormValues {
  return {
    // New manual and estimate rows start unallocated because the server only
    // accepts rehab rows from the existing operations/QBO workflows.
    lane: cost?.lane ?? "unallocated", description: cost?.description ?? "", vendorName: cost?.vendorName ?? "",
    budgetCents: cost?.budgetCents === null || cost?.budgetCents === undefined ? "" : formatInputValue(cost.budgetCents),
    amountCents: cost?.amountCents === null || cost?.amountCents === undefined ? "" : formatInputValue(cost.amountCents),
    forecastCents: cost?.forecastCents === null || cost?.forecastCents === undefined ? "" : formatInputValue(cost.forecastCents),
    paidCents: cost?.paidCents === null || cost?.paidCents === undefined ? "" : formatInputValue(cost.paidCents),
    incurredOn: cost?.incurredOn ?? "", paidOn: cost?.paidOn ?? "", prepaid: cost?.prepaid ?? false,
    sourceKind: cost?.sourceKind ?? "manual", reconciliationState: cost?.reconciliationState ?? "unreconciled",
    // Do not surface opaque provider/source IDs as ordinary evidence text.
    // Existing references are retained by the update payload when unchanged.
    sourceEvidenceReference: "",
    settlementReference: "", settlementObservedOn: "",
  };
}

function positiveMoney(value: string, field: string): boolean {
  const cents = optionalMoney(value, field);
  return cents !== null && BigInt(cents) > BigInt(0);
}

function sourceAllowsRehab(sourceKind: DealCostSourceKind): boolean {
  return sourceKind === "qbo" || sourceKind === "operational";
}

function sourceKindAllowsRehabFallback(lane: DealCostLane, sourceKind: DealCostSourceKind): DealCostLane {
  return lane === "rehab" && !sourceAllowsRehab(sourceKind) ? "unallocated" : lane;
}

export interface DealCostPayloadInput {
  readonly projectId: string;
  readonly existing?: ProjectDealCost;
  readonly values: CostFormValues;
  readonly selectedSource?: CostSourceLine;
}

export function buildDealCostPayload({ projectId, existing, values, selectedSource }: DealCostPayloadInput): Record<string, unknown> {
  if (!values.description.trim()) throw new Error("Description is required.");
  const sourceKind = values.sourceKind;
  const existingQbo = existing?.sourceKind === "qbo";
  const reconciliationState = sourceKind === "qbo" ? "qbo_verified" : values.reconciliationState === "qbo_verified" ? "unreconciled" : values.reconciliationState;
  if (values.lane === "rehab" && !sourceAllowsRehab(sourceKind)) throw new Error("Rehab costs use the existing operations or QuickBooks workflow. Choose another lane or source kind.");
  if (sourceKind === "qbo" && !selectedSource && !existing?.source) throw new Error("Choose a QuickBooks source line.");
  if (values.paidCents.trim() && !values.paidOn) throw new Error("Paid costs need a paid date.");
  const paidCents = optionalMoney(values.paidCents, "Paid amount");
  const amountCents = optionalMoney(values.amountCents, "Incurred amount");
  const budgetCents = optionalMoney(values.budgetCents, "Budget");
  const forecastCents = optionalMoney(values.forecastCents, "Remaining forecast");
  if (budgetCents === null && amountCents === null && forecastCents === null) throw new Error("Add a budget, incurred amount or remaining forecast.");
  if (sourceKind === "estimate" && amountCents !== null && BigInt(amountCents) !== BigInt(0)) throw new Error("Estimates use remaining forecast; leave incurred at zero.");
  if (sourceKind === "estimate" && reconciliationState !== "unreconciled" && reconciliationState !== "void") throw new Error("Estimates stay unreconciled until they become actual source-backed costs.");
  const hasExistingSourceEvidence = Boolean(existing?.sourceRecordRef || existing?.sourceReferenceHash);
  const needsSourceEvidence = (sourceKind === "operational" || reconciliationState === "source_backed") && !hasExistingSourceEvidence;
  const paidChanged = existing !== undefined && existing.paidCents !== paidCents;
  const existingSettlementMatches = existing?.settlementProof !== null && existing?.settlementProof !== undefined && existing.settlementProof.amountCents === paidCents;
  const needsSettlementProof = paidCents !== null && BigInt(paidCents) > BigInt(0) && (!existingSettlementMatches || paidChanged);
  if (needsSourceEvidence && !values.sourceEvidenceReference.trim()) throw new Error("This source kind needs a source evidence reference.");
  if (needsSettlementProof && (!values.settlementReference.trim() || !values.settlementObservedOn)) throw new Error("Paid costs need separate settlement evidence and date.");
  const sourceRecordRef = needsSourceEvidence ? values.sourceEvidenceReference.trim() : existing?.sourceRecordRef ?? null;
  const settlementProof = needsSettlementProof
    ? { kind: "manual" as const, reference: values.settlementReference.trim(), observedOn: values.settlementObservedOn, amountCents: paidCents }
    : paidChanged ? null : existing?.settlementProof ?? null;
  return {
    ...(existing ? { dealCostId: existing.id } : { projectId }),
    ...(existingQbo ? {} : { lane: values.lane }),
    description: values.description.trim(),
    vendorName: values.vendorName.trim() || null,
    budgetCents,
    ...(existingQbo ? {} : { amountCents }),
    forecastCents,
    paidCents,
    incurredOn: values.incurredOn || null,
    paidOn: values.paidOn || null,
    prepaid: values.prepaid,
    ...(existingQbo ? {} : {
      sourceKind,
      reconciliationState,
      source: sourceKind === "qbo" ? selectedSource?.source ?? existing?.source ?? null : null,
      sourceRecordRef,
      sourceReferenceHash: existing?.sourceReferenceHash ?? null,
      settlementProof,
    }),
  };
}

function CostForm({ project, existing, laneOptions, saving, search, onSave, onClose }: { project: ProjectDetail; existing?: ProjectDealCost; laneOptions: readonly DealCostLane[]; saving: boolean; search?: (query: { search?: string; cursor?: string; environment?: "sandbox" | "production"; realmId?: string }) => Promise<CostSourceLinePage>; onSave: (payload: Record<string, unknown>) => Promise<void>; onClose: () => void }) {
  const [values, setValues] = useState(() => costFormDefaults(existing));
  const [selectedSource, setSelectedSource] = useState<CostSourceLine>();
  const [error, setError] = useState<string>();
  const update = <K extends keyof CostFormValues>(key: K, value: CostFormValues[K]) => setValues(current => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try { await onSave(buildDealCostPayload({ projectId: project.id, existing, values, selectedSource })); onClose(); }
    catch (next) { setError(next instanceof Error ? next.message : "Enter valid deal cost values."); }
  };
  const availableLanes = useMemo(() => Array.from(new Set([...laneOptions, ...(existing ? [existing.lane] : [])])).filter(lane => lane !== "rehab" || sourceAllowsRehab(values.sourceKind) || existing?.lane === "rehab"), [existing, laneOptions, values.sourceKind]);
  const showSourceEvidence = values.sourceKind === "operational" || values.reconciliationState === "source_backed";
  const showSettlementEvidence = (() => { try { return positiveMoney(values.paidCents, "Paid amount"); } catch { return false; } })();
  return <DialogFrame title={existing ? "Edit deal cost" : "Add deal cost"} onClose={onClose} saving={saving}><form className="projects-deal-form" onSubmit={(event) => void submit(event)}><div className="projects-deal-form-grid"><label className="projects-deal-field"><span>Lane</span><select value={values.lane} onChange={(event) => update("lane", event.currentTarget.value as DealCostLane)} disabled={saving || existing?.sourceKind === "qbo"}>{availableLanes.map(value => <option value={value} key={value}>{laneLabel(value)}</option>)}</select></label><label className="projects-deal-field"><span>Source kind</span><select value={values.sourceKind} onChange={(event) => { const sourceKind = event.currentTarget.value as DealCostSourceKind; setValues(current => ({ ...current, sourceKind, amountCents: sourceKind === "estimate" ? "" : current.amountCents, reconciliationState: sourceKind === "qbo" ? "qbo_verified" : sourceKind === "estimate" || current.reconciliationState === "qbo_verified" ? "unreconciled" : current.reconciliationState, lane: sourceKindAllowsRehabFallback(current.lane, sourceKind) })); }} disabled={saving || Boolean(existing)}>{SOURCE_KINDS.map(value => <option key={value} value={value}>{SOURCE_LABELS[value]}</option>)}</select></label><label className="projects-deal-field projects-deal-field-wide"><span>Description</span><input autoFocus value={values.description} onChange={(event) => update("description", event.currentTarget.value)} disabled={saving} /></label><label className="projects-deal-field"><span>Vendor</span><input value={values.vendorName} onChange={(event) => update("vendorName", event.currentTarget.value)} disabled={saving} /></label><label className="projects-deal-field"><span>Budget</span><input inputMode="decimal" placeholder="0.00" value={values.budgetCents} onChange={(event) => update("budgetCents", event.currentTarget.value)} disabled={saving} /></label><label className="projects-deal-field"><span>Incurred</span><input inputMode="decimal" placeholder="0.00" value={values.amountCents} onChange={(event) => update("amountCents", event.currentTarget.value)} disabled={saving || existing?.sourceKind === "qbo" || values.sourceKind === "estimate"} /></label><label className="projects-deal-field"><span>Remaining forecast</span><input inputMode="decimal" placeholder="0.00" value={values.forecastCents} onChange={(event) => update("forecastCents", event.currentTarget.value)} disabled={saving} /></label><label className="projects-deal-field"><span>Paid</span><input inputMode="decimal" placeholder="0.00" value={values.paidCents} onChange={(event) => update("paidCents", event.currentTarget.value)} disabled={saving} /></label><label className="projects-deal-field"><span>Incurred date</span><input type="date" value={values.incurredOn} onChange={(event) => update("incurredOn", event.currentTarget.value)} disabled={saving} /></label><label className="projects-deal-field"><span>Paid date</span><input type="date" value={values.paidOn} onChange={(event) => update("paidOn", event.currentTarget.value)} disabled={saving} /></label><label className="projects-deal-checkbox"><input type="checkbox" checked={values.prepaid} onChange={(event) => update("prepaid", event.currentTarget.checked)} disabled={saving} /><span>Prepaid</span></label>{showSourceEvidence && <label className="projects-deal-field projects-deal-field-wide"><span>Source evidence reference</span><input value={values.sourceEvidenceReference} onChange={(event) => update("sourceEvidenceReference", event.currentTarget.value)} disabled={saving} placeholder="Receipt, statement, operations record or document reference" /></label>}{showSettlementEvidence && <><label className="projects-deal-field"><span>Settlement proof reference</span><input value={values.settlementReference} onChange={(event) => update("settlementReference", event.currentTarget.value)} disabled={saving} placeholder="Payment or bank evidence" /></label><label className="projects-deal-field"><span>Settlement observed date</span><input type="date" value={values.settlementObservedOn} onChange={(event) => update("settlementObservedOn", event.currentTarget.value)} disabled={saving} /></label></>}{values.sourceKind !== "qbo" && <label className="projects-deal-field"><span>Reconciliation</span><select value={values.reconciliationState} onChange={(event) => update("reconciliationState", event.currentTarget.value as DealReconciliationState)} disabled={saving}><option value="unreconciled">Unreconciled</option><option value="source_backed">Source-backed</option><option value="void">Void</option></select></label>}</div>{values.sourceKind === "qbo" && !existing && search && <QboSourcePicker project={project} search={search} selected={selectedSource} onSelect={line => setSelectedSource(line)} disabled={saving} />}{values.sourceKind === "qbo" && !search && <p className="projects-description">QuickBooks source selection is unavailable here. Save this row as a manual or estimate until a source line can be selected.</p>}{error && <div className="projects-error" role="alert"><CircleAlert size={16} /><span>{error}</span></div>}<div className="projects-panel-actions"><button type="button" className="projects-button projects-button-secondary" onClick={onClose} disabled={saving}>Cancel</button><button type="submit" className="projects-button projects-button-primary" disabled={saving}>{saving ? "Saving…" : existing ? "Save deal cost" : "Add deal cost"}</button></div></form></DialogFrame>;
}

export type FundingFormValues = { fundingKind: DealFundingKind; description: string; amountCents: string; fundedOn: string; sourceKind: DealCostSourceKind; reconciliationState: DealReconciliationState; sourceEvidenceReference: string };
function fundingFormDefaults(funding?: ProjectDealFunding): FundingFormValues { return { fundingKind: funding?.fundingKind ?? "contribution", description: funding?.description ?? "", amountCents: funding?.amountCents ? formatInputValue(funding.amountCents) : "", fundedOn: funding?.fundedOn ?? "", sourceKind: funding?.sourceKind ?? "manual", reconciliationState: funding?.reconciliationState ?? "unreconciled", sourceEvidenceReference: "" }; }
export interface DealFundingPayloadInput { readonly projectId: string; readonly existing?: ProjectDealFunding; readonly values: FundingFormValues; }
export function buildDealFundingPayload({ projectId, existing, values }: DealFundingPayloadInput): Record<string, unknown> {
  if (!values.description.trim()) throw new Error("Description is required.");
  if (!values.fundedOn) throw new Error("Funded date is required.");
  const existingQbo = existing?.sourceKind === "qbo";
  if (values.sourceKind === "qbo" && !existingQbo) throw new Error("Funding QuickBooks source selection is not available yet. Save this as manual or operations funding.");
  const reconciliationState = values.sourceKind === "qbo" ? "qbo_verified" : values.reconciliationState === "qbo_verified" ? "unreconciled" : values.reconciliationState;
  const hasExistingSourceEvidence = Boolean(existing?.sourceRecordRef || existing?.sourceReferenceHash);
  const needsSourceEvidence = (values.sourceKind === "operational" || reconciliationState === "source_backed") && !hasExistingSourceEvidence;
  if (needsSourceEvidence && !values.sourceEvidenceReference.trim()) throw new Error("This funding source needs a source evidence reference.");
  const sourceRecordRef = needsSourceEvidence ? values.sourceEvidenceReference.trim() : existing?.sourceRecordRef ?? null;
  return {
    ...(existing ? { dealFundingId: existing.id } : { projectId }),
    fundingKind: values.fundingKind,
    description: values.description.trim(),
    ...(existingQbo ? {} : { amountCents: requiredMoney(values.amountCents, "Funding amount") }),
    fundedOn: values.fundedOn,
    ...(existingQbo ? {} : { sourceKind: values.sourceKind, reconciliationState, source: null, sourceRecordRef, sourceReferenceHash: existing?.sourceReferenceHash ?? null, settlementProof: existing?.settlementProof ?? null }),
  };
}
function FundingForm({ project, existing, saving, onSave, onClose }: { project: ProjectDetail; existing?: ProjectDealFunding; saving: boolean; onSave: (payload: Record<string, unknown>) => Promise<void>; onClose: () => void }) {
  const [values, setValues] = useState(() => fundingFormDefaults(existing));
  const [error, setError] = useState<string>();
  const update = <K extends keyof FundingFormValues>(key: K, value: FundingFormValues[K]) => setValues(current => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent) => { event.preventDefault(); try { await onSave(buildDealFundingPayload({ projectId: project.id, existing, values })); onClose(); } catch (next) { setError(next instanceof Error ? next.message : "Enter valid funding values."); } };
  const fundingSourceKinds = existing?.sourceKind === "qbo" ? ["qbo" as const] : SOURCE_KINDS.filter(value => value !== "qbo");
  const showSourceEvidence = values.sourceKind === "operational" || values.reconciliationState === "source_backed";
  return <DialogFrame title={existing ? "Edit funding" : "Add funding"} onClose={onClose} saving={saving}><form className="projects-deal-form" onSubmit={(event) => void submit(event)}><div className="projects-deal-form-grid"><label className="projects-deal-field"><span>Funding group</span><select value={values.fundingKind} onChange={(event) => update("fundingKind", event.currentTarget.value as DealFundingKind)} disabled={saving}>{Object.entries(FUNDING_LABELS).map(([value, name]) => <option value={value} key={value}>{name}</option>)}</select></label><label className="projects-deal-field"><span>Source kind</span><select value={values.sourceKind} onChange={(event) => { const sourceKind = event.currentTarget.value as DealCostSourceKind; update("sourceKind", sourceKind); if (sourceKind === "qbo") update("reconciliationState", "qbo_verified"); }} disabled={saving || Boolean(existing)}>{fundingSourceKinds.map(value => <option key={value} value={value}>{SOURCE_LABELS[value]}</option>)}</select></label><label className="projects-deal-field projects-deal-field-wide"><span>Description</span><input autoFocus value={values.description} onChange={(event) => update("description", event.currentTarget.value)} disabled={saving} /></label><label className="projects-deal-field"><span>Amount</span><input inputMode="decimal" placeholder="0.00" value={values.amountCents} onChange={(event) => update("amountCents", event.currentTarget.value)} disabled={saving || existing?.sourceKind === "qbo"} /></label><label className="projects-deal-field"><span>Funded date</span><input type="date" value={values.fundedOn} onChange={(event) => update("fundedOn", event.currentTarget.value)} disabled={saving} /> </label>{showSourceEvidence && <label className="projects-deal-field projects-deal-field-wide"><span>Source evidence reference</span><input value={values.sourceEvidenceReference} onChange={(event) => update("sourceEvidenceReference", event.currentTarget.value)} disabled={saving} placeholder="Statement, contribution record or approval note" /></label>}{values.sourceKind === "qbo" && <p className="projects-description">Funding does not have a QuickBooks source picker yet. Existing linked funding stays read-only; new funding can be saved as manual or operations funding.</p>}{values.sourceKind !== "qbo" && <label className="projects-deal-field"><span>Reconciliation</span><select value={values.reconciliationState} onChange={(event) => update("reconciliationState", event.currentTarget.value as DealReconciliationState)} disabled={saving}><option value="unreconciled">Unreconciled</option><option value="source_backed">Source-backed</option><option value="void">Void</option></select></label>}</div>{error && <div className="projects-error" role="alert"><CircleAlert size={16} /><span>{error}</span></div>}<div className="projects-panel-actions"><button type="button" className="projects-button projects-button-secondary" onClick={onClose} disabled={saving}>Cancel</button><button type="submit" className="projects-button projects-button-primary" disabled={saving}>{saving ? "Saving…" : existing ? "Save funding" : "Add funding"}</button></div></form></DialogFrame>;
}

function SaleForecastForm({ existing, saving, onSave, onClose }: { existing: ProjectDealCostReport["saleForecast"]; saving: boolean; onSave: (payload: Record<string, unknown>) => Promise<void>; onClose: () => void }) {
  const [gross, setGross] = useState(existing.grossProceedsCents === null ? "" : formatInputValue(existing.grossProceedsCents));
  const [saleOn, setSaleOn] = useState(existing.saleOn ?? "");
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => { event.preventDefault(); try { await onSave({ grossProceedsCents: requiredMoney(gross, "Projected gross sale"), saleOn: saleOn || null }); onClose(); } catch (next) { setError(next instanceof Error ? next.message : "Enter a valid sale forecast."); } };
  return <DialogFrame title="Edit sale forecast" onClose={onClose} saving={saving}><form className="projects-deal-form" onSubmit={(event) => void submit(event)}><div className="projects-deal-form-grid"><label className="projects-deal-field"><span>Projected gross sale</span><input autoFocus inputMode="decimal" placeholder="0.00" value={gross} onChange={(event) => setGross(event.currentTarget.value)} disabled={saving} /></label><label className="projects-deal-field"><span>Projected sale date</span><input type="date" value={saleOn} onChange={(event) => setSaleOn(event.currentTarget.value)} disabled={saving} /></label></div>{error && <div className="projects-error" role="alert"><CircleAlert size={16} /><span>{error}</span></div>}<div className="projects-panel-actions"><button type="button" className="projects-button projects-button-secondary" onClick={onClose} disabled={saving}>Cancel</button><button type="submit" className="projects-button projects-button-primary" disabled={saving}>{saving ? "Saving…" : "Save forecast"}</button></div></form></DialogFrame>;
}

export interface DealCostsPanelProps {
  readonly project: ProjectDetail;
  readonly report: ProjectDealCostReport;
  readonly readOnly: boolean;
  readonly saving: boolean;
  readonly searchQboLines?: (query: { search?: string; cursor?: string; environment?: "sandbox" | "production"; realmId?: string }) => Promise<CostSourceLinePage>;
  readonly onSaveCost: (payload: Record<string, unknown>) => Promise<void>;
  readonly onArchiveCost: (cost: ProjectDealCost) => Promise<void>;
  readonly onSaveFunding: (payload: Record<string, unknown>) => Promise<void>;
  readonly onArchiveFunding: (funding: ProjectDealFunding) => Promise<void>;
  readonly onSaveSaleForecast: (payload: Record<string, unknown>) => Promise<void>;
}

/** Existing rehab-budget rows are projected into this report for context. */
export function isDerivedRehabCost(project: ProjectDetail, cost: ProjectDealCost): boolean {
  return cost.lane === "rehab"
    && cost.sourceKind === "operational"
    && cost.source === null
    && cost.sourceRecordRef !== null
    && project.draftCosts.some(draft => String(draft.id) === String(cost.sourceRecordRef));
}

export function DealCostsPanel({ project, report, readOnly, saving, searchQboLines, onSaveCost, onArchiveCost, onSaveFunding, onArchiveFunding, onSaveSaleForecast }: DealCostsPanelProps) {
  const [costEditor, setCostEditor] = useState<ProjectDealCost | "new">();
  const [fundingEditor, setFundingEditor] = useState<ProjectDealFunding | "new">();
  const [saleEditing, setSaleEditing] = useState(false);
  const activeCosts = report.costs.filter(cost => cost.archivedAt === null && cost.reconciliationState !== "void");
  const activeFunding = report.funding.filter(funding => funding.archivedAt === null && funding.reconciliationState !== "void");
  const laneRows = report.byLane;
  const laneOptions = useMemo(() => laneRows.map((row) => row.lane), [laneRows]);
  const showCostActions = !readOnly && activeCosts.some(cost => !isDerivedRehabCost(project, cost));
  const archiveCost = async (cost: ProjectDealCost) => { if (typeof window !== "undefined" && !window.confirm("Archive this deal cost?")) return; await onArchiveCost(cost); };
  const archiveFunding = async (funding: ProjectDealFunding) => { if (typeof window !== "undefined" && !window.confirm("Archive this funding record?")) return; await onArchiveFunding(funding); };
  return <div className="projects-section-stack projects-deal-costs" aria-label="Deal costs">
    <section className="projects-panel projects-deal-hero"><div className="projects-panel-heading"><div><span className="projects-eyebrow">Whole-deal view</span><h3>Deal costs</h3><p className="projects-description">Acquisition, rehab, financing, holding, selling and any unallocated costs stay separate from project rehab budgets.</p></div><div className="projects-panel-actions">{!readOnly && <><button type="button" className="projects-button projects-button-secondary" onClick={() => setCostEditor("new")} disabled={saving}><Plus size={16} />Add cost</button><button type="button" className="projects-button projects-button-secondary" onClick={() => setFundingEditor("new")} disabled={saving}><Plus size={16} />Add funding</button></>}{readOnly && <span className="projects-readonly-label">Read-only</span>}</div></div><div className="projects-deal-coverage"><StatusPill tone={report.coverage.status === "complete" ? "positive" : report.coverage.status === "partial" ? "warning" : "muted"}>{report.coverage.status === "complete" ? "Complete coverage" : report.coverage.status === "partial" ? "Partial coverage" : "Coverage unavailable"}</StatusPill><span>{report.coverage.totalCostEntryCount} cost rows</span><span>{report.coverage.estimatedEntryCount} estimates</span><span>{report.coverage.qboVerifiedEntryCount} QBO verified</span></div>{report.coverage.warnings.length > 0 && <ul className="projects-warning-list">{report.coverage.warnings.map(warning => <li key={warning}><CircleAlert size={14} />{warning}</li>)}</ul>}</section>
    <section className="projects-panel"><div className="projects-panel-heading"><div><h3>Cost by lane</h3><p className="projects-muted">Amounts show only what is known. Partial rows are labelled.</p></div></div><div className="projects-table-wrap"><table className="projects-table projects-deal-lane-table"><thead><tr><th>Lane</th><th className="projects-number">Budget</th><th className="projects-number">Incurred</th><th className="projects-number">Paid</th><th>Prepaid</th><th className="projects-number">Remaining forecast</th><th className="projects-number">Final cost</th><th>Coverage</th></tr></thead><tbody>{laneRows.map(row => { const qualified = (value: string | null, field: "complete" | "partial" | "unavailable") => formatQualifiedMoney(value, field, report.currency); return <tr key={row.lane}><th scope="row">{laneLabel(row.lane)}</th><td className="projects-number">{qualified(row.budgetCents, row.coverage)}</td><td className="projects-number">{qualified(row.incurredCents, row.coverage)}</td><td className="projects-number">{qualified(row.paidCents, row.coverage)}</td><td className="projects-number">{qualified(row.prepaidCents, row.coverage)}</td><td className="projects-number">{qualified(row.remainingForecastCents, row.coverage)}</td><td className="projects-number">{qualified(row.finalCostCents, row.coverage)}</td><td><StatusPill tone={row.coverage === "complete" ? "positive" : row.coverage === "partial" ? "warning" : "muted"}>{label(row.coverage)}</StatusPill></td></tr>; })}</tbody><tfoot><tr><th scope="row">Deal total</th><td className="projects-number">{formatQualifiedMoney(report.totals.budgetCents, report.coverage.status, report.currency)}</td><td className="projects-number">{formatQualifiedMoney(report.totals.incurredCents, report.coverage.status, report.currency)}</td><td className="projects-number">{formatQualifiedMoney(report.totals.paidCents, report.coverage.status, report.currency)}</td><td className="projects-number">{formatQualifiedMoney(report.totals.prepaidCents, report.coverage.status, report.currency)}</td><td className="projects-number">{formatQualifiedMoney(report.totals.remainingForecastCents, report.coverage.status, report.currency)}</td><td className="projects-number">{formatQualifiedMoney(report.totals.finalCostCents, report.coverage.status, report.currency)}</td><td><StatusPill tone={report.coverage.status === "complete" ? "positive" : "warning"}>{label(report.coverage.status)}</StatusPill></td></tr></tfoot></table></div></section>
    <section className="projects-panel"><div className="projects-panel-heading"><div><h3>Deal cost entries</h3><p className="projects-muted">Source-backed and QBO verified rows remain visibly distinct.</p></div></div>{activeCosts.length === 0 ? <div className="projects-state projects-empty"><strong>No deal costs recorded</strong><span>Add a manual, estimate or verified source row.</span></div> : <div className="projects-table-wrap"><table className="projects-table"><thead><tr><th>Cost</th><th>Lane</th><th>Source</th><th>Incurred</th><th className="projects-number">Amount</th><th>Prepaid</th>{showCostActions && <th><span className="projects-sr-only">Actions</span></th>}</tr></thead><tbody>{activeCosts.map(cost => { const derived = isDerivedRehabCost(project, cost); return <tr key={cost.id}><td><strong>{cost.description}</strong>{cost.vendorName && <small className="projects-table-subline">{cost.vendorName}</small>}{derived && <small className="projects-table-subline">From rehab budget · read-only</small>}</td><td>{laneLabel(cost.lane)}</td><td><SourceStatus sourceKind={cost.sourceKind} reconciliationState={cost.reconciliationState} /></td><td>{dateLabel(cost.incurredOn)}</td><td className="projects-number">{formatMoney(cost.amountCents ?? undefined, report.currency)}</td><td>{cost.prepaid ? "Yes" : "No"}</td>{showCostActions && <td className="projects-row-actions">{derived ? <span className="projects-muted">Read-only</span> : <><button type="button" className="projects-link-button" onClick={() => setCostEditor(cost)} disabled={saving}><Pencil size={14} />Edit</button><button type="button" className="projects-link-button projects-link-danger" onClick={() => void archiveCost(cost)} disabled={saving}><Archive size={14} />Archive</button></>}</td>}</tr>; })}</tbody></table></div>}</section>
    <section className="projects-panel"><div className="projects-panel-heading"><div><h3>Funding</h3><p className="projects-muted">Funding is shown by source and never treated as available cash.</p></div></div><div className="projects-deal-funding-grid">{report.fundingTotals.map(row => <div className="projects-deal-funding-card" key={row.fundingKind}><span>{fundingLabel(row.fundingKind)}</span><strong>{row.amountCents === null ? "Unknown" : formatMoney(row.amountCents, report.currency)}</strong></div>)}</div>{activeFunding.length === 0 ? <div className="projects-state projects-empty"><strong>No funding recorded</strong></div> : <div className="projects-table-wrap"><table className="projects-table"><thead><tr><th>Funding</th><th>Group</th><th>Source</th><th>Date</th><th className="projects-number">Amount</th>{!readOnly && <th><span className="projects-sr-only">Actions</span></th>}</tr></thead><tbody>{activeFunding.map(funding => <tr key={funding.id}><td><strong>{funding.description}</strong></td><td>{fundingLabel(funding.fundingKind)}</td><td><SourceStatus sourceKind={funding.sourceKind} reconciliationState={funding.reconciliationState} /></td><td>{dateLabel(funding.fundedOn)}</td><td className="projects-number">{formatMoney(funding.amountCents, report.currency)}</td>{!readOnly && <td className="projects-row-actions"><button type="button" className="projects-link-button" onClick={() => setFundingEditor(funding)} disabled={saving}><Pencil size={14} />Edit</button><button type="button" className="projects-link-button projects-link-danger" onClick={() => void archiveFunding(funding)} disabled={saving}><Archive size={14} />Archive</button></td>}</tr>)}</tbody></table></div>}</section>
    <section className="projects-panel"><div className="projects-panel-heading"><div><h3>Sale forecast</h3><p className="projects-muted">Net sale proceeds are shown before loan payoff.</p></div>{!readOnly && <button type="button" className="projects-button projects-button-secondary" onClick={() => setSaleEditing(true)} disabled={saving}><Pencil size={16} />Edit forecast</button>}</div><dl className="projects-definition-list projects-deal-sale-grid"><div><dt>Projected gross sale</dt><dd>{formatQualifiedMoney(report.saleForecast.grossProceedsCents, report.saleForecast.grossProceedsCents === null ? "unavailable" : "complete", report.currency)}</dd></div><div><dt>Projected sale date</dt><dd>{dateLabel(report.saleForecast.saleOn)}</dd></div><div><dt>Net sale proceeds before loan payoff</dt><dd>{formatQualifiedMoney(report.saleForecast.netSaleProceedsCents, report.saleForecast.profitState === "complete" ? "complete" : "partial", report.currency)}</dd></div><div><dt>Projected profit</dt><dd>{report.saleForecast.projectedProfitCents === null ? <span className="projects-deal-withheld">Withheld until all cost lanes and the sale forecast are complete.</span> : formatMoney(report.saleForecast.projectedProfitCents, report.currency)}</dd></div></dl>{report.saleForecast.profitState !== "complete" && <div className="projects-deal-withheld-note"><CircleAlert size={16} /><span>Profit is withheld while coverage is {report.saleForecast.profitState === "unknown" ? "unavailable" : "partial"}. Loan payoff remains outside this net sale figure.</span></div>}</section>
    {costEditor && <CostForm project={project} existing={costEditor === "new" ? undefined : costEditor} laneOptions={laneOptions} saving={saving} search={searchQboLines} onSave={onSaveCost} onClose={() => setCostEditor(undefined)} />}
    {fundingEditor && <FundingForm project={project} existing={fundingEditor === "new" ? undefined : fundingEditor} saving={saving} onSave={onSaveFunding} onClose={() => setFundingEditor(undefined)} />}
    {saleEditing && <SaleForecastForm existing={report.saleForecast} saving={saving} onSave={onSaveSaleForecast} onClose={() => setSaleEditing(false)} />}
  </div>;
}
