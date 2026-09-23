import React from "react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  INVESTOR_FLOW_KINDS,
  OPENING_ITEM_KEYS,
  OPENING_ITEM_LABELS,
  RECURRENCES,
  UNIT_STATUSES,
  forecastAssumptionsSchema,
} from "@shared/forecasting/assumptions";
import type { ForecastScenarioDetail } from "@shared/forecasting/contracts";
import type { ForecastOpeningItem } from "@shared/forecasting/result";
import { formatInputValue, parseMoneyInput } from "../projects/money";
import { bpsToPercentInput, dateLabel, money, percentInputToBps, timestampLabel } from "./format";
import { Dialog, EmptyState, Field, Notice, errorText } from "./ui";

type Doc = Record<string, unknown>;
type Row = Record<string, unknown>;
export type FieldKind = "text" | "money" | "moneyOrUnknown" | "moneySigned" | "bps" | "int" | "date" | "dateOptional" | "bool" | "select" | "idList";
export interface FieldSpec {
  readonly path: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly options?: readonly { value: string; label: string }[];
  readonly optional?: boolean;
}
export interface SectionSpec {
  readonly key: string;
  readonly title: string;
  readonly idField: string;
  readonly fields: readonly FieldSpec[];
  readonly template: (doc: Doc, index: number) => Row;
}

const recurrence = RECURRENCES.map(value => ({ value, label: value === "once" ? "Once" : value[0]!.toUpperCase() + value.slice(1) }));
const ids = (doc: Doc, key: string, idField: string) => ((doc[key] as Row[] | undefined) ?? []).map(item => ({ value: String(item[idField]), label: String(item.name ?? item.label ?? item[idField]) }));

/** Section specs are data; one generic row editor renders them all. */
export function sectionSpecs(doc: Doc): readonly SectionSpec[] {
  const properties = ids(doc, "properties", "propertyId");
  const projects = ids(doc, "projects", "projectId");
  const loans = [...ids(doc, "loans", "id"), ...((doc.refinances as Row[] | undefined) ?? []).map(item => ({ value: String((item.newLoan as Row)?.id ?? ""), label: String((item.newLoan as Row)?.label ?? "") }))];
  const expenses = ids(doc, "expenses", "id");
  const cutoff = String(doc.actualsCutoff ?? "");
  const optionalProperty = [{ value: "", label: "All properties" }, ...properties];
  return [
    { key: "properties", title: "Properties", idField: "propertyId", template: (_doc, index) => ({ propertyId: `property-${index + 1}`, name: "New property", propertyManager: { managed: false, feeBps: 0, remittanceLagDays: 10 } }), fields: [
      { path: "propertyId", label: "ID", kind: "text" }, { path: "name", label: "Name", kind: "text" },
      { path: "propertyManager.managed", label: "Managed by a PM", kind: "bool" }, { path: "propertyManager.feeBps", label: "PM fee", kind: "bps" },
      { path: "propertyManager.remittanceLagDays", label: "Remittance lag (days)", kind: "int" },
      { path: "fixedAsset.costBasisCents", label: "Cost basis", kind: "money", optional: true }, { path: "fixedAsset.accumulatedDepreciationCents", label: "Accumulated depreciation", kind: "money", optional: true },
      { path: "fixedAsset.depreciableBasisCents", label: "Depreciable basis", kind: "money", optional: true }, { path: "fixedAsset.usefulLifeMonths", label: "Life (months)", kind: "int", optional: true },
      { path: "fixedAsset.placedInServiceOn", label: "In service", kind: "dateOptional", optional: true },
    ] },
    { key: "units", title: "Units and leases", idField: "unitId", template: (_doc, index) => ({ unitId: `unit-${index + 1}`, propertyId: properties[0]?.value ?? "", label: `Unit ${index + 1}`, status: "vacant", currentRentCents: "0", subsidyCents: "0", newLeaseSubsidyCents: "0", marketRentCents: "0" }), fields: [
      { path: "unitId", label: "ID", kind: "text" }, { path: "label", label: "Unit", kind: "text" }, { path: "propertyId", label: "Property", kind: "select", options: properties },
      { path: "status", label: "Status", kind: "select", options: UNIT_STATUSES.map(value => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })) },
      { path: "currentRentCents", label: "Current rent", kind: "money" }, { path: "subsidyCents", label: "Housing assistance", kind: "money" },
      { path: "marketRentCents", label: "Market rent", kind: "money" }, { path: "newLeaseSubsidyCents", label: "Assistance on new leases", kind: "money" },
      { path: "leaseEndOn", label: "Lease end", kind: "dateOptional" }, { path: "availableOn", label: "Ready on", kind: "dateOptional" },
      { path: "projectId", label: "Project", kind: "select", options: [{ value: "", label: "None" }, ...projects], optional: true },
      { path: "depositCents", label: "Deposit", kind: "money", optional: true },
    ] },
    { key: "expenses", title: "Operating costs", idField: "id", template: (_doc, index) => ({ id: `expense-${index + 1}`, label: "New cost", category: "other", amountCents: "0", frequency: "monthly", firstOn: cutoff, paymentLagDays: 0, annualGrowthBps: 0, paidFromEscrow: false, laborEstimate: false, retired: false }), fields: [
      { path: "id", label: "ID", kind: "text" }, { path: "label", label: "Cost", kind: "text" },
      { path: "category", label: "Category", kind: "select", options: EXPENSE_CATEGORIES.map(value => ({ value, label: EXPENSE_CATEGORY_LABELS[value] })) },
      { path: "propertyId", label: "Property", kind: "select", options: optionalProperty, optional: true },
      { path: "amountCents", label: "Amount", kind: "money" }, { path: "frequency", label: "Frequency", kind: "select", options: recurrence },
      { path: "firstOn", label: "First date", kind: "date" }, { path: "endOn", label: "End date", kind: "dateOptional" },
      { path: "paymentLagDays", label: "Pay after (days)", kind: "int" }, { path: "annualGrowthBps", label: "Annual growth", kind: "bps" },
      { path: "paidFromEscrow", label: "Paid from escrow", kind: "bool" }, { path: "laborEstimate", label: "Estimated labor", kind: "bool" }, { path: "retired", label: "Retired", kind: "bool" },
    ] },
    { key: "projects", title: "Projects", idField: "projectId", template: (_doc, index) => ({ projectId: `project-${index + 1}`, name: "New project", propertyId: properties[0]?.value ?? "", openingCipCents: "0", remainingCostCents: "0", laborEstimateCents: "0", costStartOn: cutoff, completionOn: cutoff, paymentLagDays: 30, retainageBps: 0, retainageReleaseDays: 30, usefulLifeMonths: 330, drawBps: 0, drawLagDays: 14, retired: false }), fields: [
      { path: "projectId", label: "ID", kind: "text" }, { path: "name", label: "Project", kind: "text" }, { path: "propertyId", label: "Property", kind: "select", options: properties },
      { path: "openingCipCents", label: "Spent to date", kind: "money" }, { path: "remainingCostCents", label: "Cost to complete", kind: "money" }, { path: "laborEstimateCents", label: "of which labor", kind: "money" },
      { path: "costStartOn", label: "Cost start", kind: "date" }, { path: "completionOn", label: "Completion", kind: "date" },
      { path: "paymentLagDays", label: "Pay after (days)", kind: "int" }, { path: "retainageBps", label: "Retainage", kind: "bps" }, { path: "retainageReleaseDays", label: "Retainage release (days)", kind: "int" },
      { path: "drawLoanId", label: "Draw loan", kind: "select", options: [{ value: "", label: "None" }, ...loans], optional: true }, { path: "drawBps", label: "Draw share", kind: "bps" }, { path: "drawLagDays", label: "Draw lag (days)", kind: "int" },
      { path: "retired", label: "Retired", kind: "bool" },
    ] },
    { key: "loans", title: "Loans", idField: "id", template: (_doc, index) => ({ id: `loan-${index + 1}`, label: "New loan", principalCents: null, annualRateBps: 0, dayCount: "30_360", paymentDay: 1, firstPaymentOn: cutoff, maturityOn: cutoff, escrowMonthlyCents: "0" }), fields: [
      { path: "id", label: "ID", kind: "text" }, { path: "label", label: "Loan", kind: "text" }, { path: "lender", label: "Lender", kind: "text", optional: true },
      { path: "principalCents", label: "Principal at cutoff", kind: "moneyOrUnknown" }, { path: "annualRateBps", label: "Rate", kind: "bps" },
      { path: "dayCount", label: "Day count", kind: "select", options: [{ value: "30_360", label: "30/360" }, { value: "actual_360", label: "Actual/360" }, { value: "actual_365", label: "Actual/365" }] },
      { path: "paymentDay", label: "Payment day", kind: "int" }, { path: "firstPaymentOn", label: "First payment", kind: "date" },
      { path: "interestOnlyUntil", label: "Interest only until", kind: "dateOptional" }, { path: "amortizationMonths", label: "Amortization (months)", kind: "int", optional: true },
      { path: "maturityOn", label: "Maturity", kind: "date" }, { path: "escrowMonthlyCents", label: "Monthly escrow", kind: "money" },
      { path: "propertyId", label: "Property", kind: "select", options: optionalProperty, optional: true },
    ] },
    { key: "refinances", title: "Refinances", idField: "id", template: (_doc, index) => ({ id: `refi-${index + 1}`, label: "New refinance", closeOn: cutoff, payoffLoanIds: [], closingCostsCents: "0", prepaymentCostsCents: "0", reserveCents: "0",
      newLoan: { id: `refi-loan-${index + 1}`, label: "New permanent loan", principalCents: "0", annualRateBps: 0, dayCount: "30_360", paymentDay: 1, firstPaymentOn: cutoff, maturityOn: cutoff, escrowMonthlyCents: "0" } }), fields: [
      { path: "id", label: "ID", kind: "text" }, { path: "label", label: "Refinance", kind: "text" }, { path: "closeOn", label: "Closing", kind: "date" },
      { path: "payoffLoanIds", label: "Pays off (loan IDs)", kind: "idList" }, { path: "newLoan.id", label: "New loan ID", kind: "text" },
      { path: "newLoan.principalCents", label: "Gross loan", kind: "money" }, { path: "newLoan.annualRateBps", label: "Rate", kind: "bps" },
      { path: "newLoan.firstPaymentOn", label: "First payment", kind: "date" }, { path: "newLoan.amortizationMonths", label: "Amortization (months)", kind: "int", optional: true },
      { path: "newLoan.maturityOn", label: "Maturity", kind: "date" }, { path: "closingCostsCents", label: "Closing costs", kind: "money" },
      { path: "prepaymentCostsCents", label: "Prepayment costs", kind: "money" }, { path: "reserveCents", label: "Reserves", kind: "money" },
    ] },
    { key: "sales", title: "Sales", idField: "id", template: (_doc, index) => ({ id: `sale-${index + 1}`, label: "New sale", propertyId: properties[0]?.value ?? "", closeOn: cutoff, priceCents: "0", sellingCostsCents: "0", payoffLoanIds: [], transferDeposits: true }), fields: [
      { path: "id", label: "ID", kind: "text" }, { path: "label", label: "Sale", kind: "text" }, { path: "propertyId", label: "Property", kind: "select", options: properties },
      { path: "closeOn", label: "Closing", kind: "date" }, { path: "priceCents", label: "Price", kind: "money" }, { path: "sellingCostsCents", label: "Selling costs", kind: "money" },
      { path: "payoffLoanIds", label: "Pays off (loan IDs)", kind: "idList" }, { path: "transferDeposits", label: "Transfer deposits", kind: "bool" },
    ] },
    { key: "investorFlows", title: "Investor payments", idField: "id", template: (_doc, index) => ({ id: `investor-${index + 1}`, label: "Distribution", kind: "distribution", amountCents: "0", frequency: "quarterly", firstOn: cutoff }), fields: [
      { path: "id", label: "ID", kind: "text" }, { path: "label", label: "Payment", kind: "text" },
      { path: "kind", label: "Kind", kind: "select", options: INVESTOR_FLOW_KINDS.map(value => ({ value, label: value.replace(/_/g, " ").replace(/^./, first => first.toUpperCase()) })) },
      { path: "amountCents", label: "Amount", kind: "money" }, { path: "frequency", label: "Frequency", kind: "select", options: recurrence },
      { path: "firstOn", label: "First date", kind: "date" }, { path: "endOn", label: "End date", kind: "dateOptional" },
    ] },
    { key: "timeActuals", title: "Approved time", idField: "id", template: (_doc, index) => ({ id: `time-${index + 1}`, workedOn: cutoff, amountCents: "0", sourceId: "manual", ...(projects[0] ? { projectId: projects[0].value } : { expenseId: expenses[0]?.value ?? "" }) }), fields: [
      { path: "id", label: "ID", kind: "text" }, { path: "workedOn", label: "Worked on", kind: "date" },
      { path: "projectId", label: "Project", kind: "select", options: [{ value: "", label: "None" }, ...projects], optional: true },
      { path: "expenseId", label: "Labor cost", kind: "select", options: [{ value: "", label: "None" }, ...expenses], optional: true },
      { path: "amountCents", label: "Amount", kind: "money" }, { path: "sourceId", label: "Source", kind: "text" },
    ] },
    { key: "ownerItems", title: "Owner planning (separate from company)", idField: "id", template: (_doc, index) => ({ id: `owner-${index + 1}`, label: "Owner item", amountCents: "0", frequency: "monthly", firstOn: cutoff }), fields: [
      { path: "id", label: "ID", kind: "text" }, { path: "label", label: "Item", kind: "text" }, { path: "amountCents", label: "Amount (+ in, − out)", kind: "moneySigned" },
      { path: "frequency", label: "Frequency", kind: "select", options: recurrence }, { path: "firstOn", label: "First date", kind: "date" }, { path: "endOn", label: "End date", kind: "dateOptional" },
    ] },
  ];
}

export const LEASING_FIELDS: readonly FieldSpec[] = [
  { path: "renewOnExpiry", label: "Tenants renew at lease end", kind: "bool" },
  { path: "renewalTermMonths", label: "Renewal term (months)", kind: "int" }, { path: "newLeaseTermMonths", label: "New lease term (months)", kind: "int" },
  { path: "makeReadyDays", label: "Make-ready (days)", kind: "int" }, { path: "vacancyDays", label: "Vacancy before new lease (days)", kind: "int" },
  { path: "annualRentGrowthBps", label: "Annual rent growth", kind: "bps" }, { path: "newLeaseConcessionCents", label: "New-lease concession", kind: "money" },
  { path: "collectionsBps", label: "Collected", kind: "bps" }, { path: "badDebtBps", label: "Bad debt", kind: "bps" },
  { path: "collectionLagDays", label: "Rent received after (days)", kind: "int" }, { path: "subsidyLagDays", label: "Assistance received after (days)", kind: "int" },
  { path: "depositMonths", label: "Deposit (months of rent)", kind: "int" }, { path: "depositReturnDays", label: "Deposit returned after (days)", kind: "int" },
];

export function getPath(row: Row, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value && typeof value === "object" ? (value as Row)[key] : undefined), row);
}

/** Immutable set; `undefined` removes the key and empty parent objects of optional groups. */
export function setPath(row: Row, path: string, value: unknown): Row {
  const [head, ...rest] = path.split(".");
  const next: Row = { ...row };
  if (!rest.length) {
    if (value === undefined) delete next[head!]; else next[head!] = value;
    return next;
  }
  const child = setPath((row[head!] as Row | undefined) ?? {}, rest.join("."), value);
  if (Object.keys(child).length === 0) delete next[head!]; else next[head!] = child;
  return next;
}

function FieldInput({ spec, value, onChange, label }: { spec: FieldSpec; value: unknown; onChange: (value: unknown) => void; label: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const display = (): string => {
    if (spec.kind === "money" || spec.kind === "moneySigned" || spec.kind === "moneyOrUnknown") return value === null || value === undefined ? "" : formatInputValue(String(value));
    if (spec.kind === "bps") return typeof value === "number" ? bpsToPercentInput(value) : "";
    if (spec.kind === "idList") return Array.isArray(value) ? value.join(", ") : "";
    return value === undefined || value === null ? "" : String(value);
  };
  const commit = (raw: string) => {
    setError(null);
    try {
      const trimmed = raw.trim();
      if (spec.kind === "money" || spec.kind === "moneySigned" || spec.kind === "moneyOrUnknown") {
        if (!trimmed) { onChange(spec.kind === "moneyOrUnknown" ? null : spec.optional ? undefined : "0"); return; }
        const cents = parseMoneyInput(trimmed, spec.label).cents;
        if (spec.kind !== "moneySigned" && cents.startsWith("-")) throw new Error(`${spec.label} cannot be negative.`);
        onChange(cents);
      } else if (spec.kind === "bps") {
        onChange(trimmed ? percentInputToBps(trimmed) : 0);
      } else if (spec.kind === "int") {
        if (!trimmed) { onChange(spec.optional ? undefined : 0); return; }
        if (!/^\d{1,5}$/.test(trimmed)) throw new Error(`${spec.label} must be a whole number.`);
        onChange(Number(trimmed));
      } else if (spec.kind === "idList") {
        onChange(trimmed ? trimmed.split(",").map(item => item.trim()).filter(Boolean) : []);
      } else {
        onChange(trimmed === "" && spec.optional ? undefined : trimmed);
      }
      setText(null);
    } catch (problem) { setError(errorText(problem)); }
  };
  if (spec.kind === "bool") return <input type="checkbox" aria-label={label} checked={value === true} onChange={event => onChange(event.currentTarget.checked)} />;
  if (spec.kind === "select") return <select aria-label={label} value={value === undefined || value === null ? "" : String(value)} onChange={event => onChange(event.currentTarget.value === "" && spec.optional ? undefined : event.currentTarget.value)}>
    {!spec.options?.some(option => option.value === (value ?? "")) && <option value={String(value ?? "")}>{String(value ?? "") || "Choose"}</option>}
    {spec.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>;
  if (spec.kind === "date" || spec.kind === "dateOptional") return <input type="date" aria-label={label} value={value ? String(value) : ""} onChange={event => onChange(event.currentTarget.value || (spec.kind === "dateOptional" ? undefined : ""))} />;
  const numeric = spec.kind === "money" || spec.kind === "moneySigned" || spec.kind === "moneyOrUnknown" || spec.kind === "bps" || spec.kind === "int";
  return <span className="fc-input-wrap">
    <input aria-label={label} aria-invalid={error ? true : undefined} inputMode={numeric ? "decimal" : undefined} className={numeric ? "fc-input-num" : undefined}
      value={text ?? display()} placeholder={spec.kind === "moneyOrUnknown" ? "Unknown" : spec.kind === "bps" ? "0.00" : undefined}
      onChange={event => setText(event.currentTarget.value)} onBlur={event => commit(event.currentTarget.value)}
      onKeyDown={event => { if (event.key === "Enter") commit(event.currentTarget.value); }} />
    {error && <span className="fc-field-error" role="alert">{error}</span>}
  </span>;
}

function RowSection({ spec, doc, onChange }: { spec: SectionSpec; doc: Doc; onChange: (rows: Row[]) => void }) {
  const rows = ((doc[spec.key] as Row[] | undefined) ?? []);
  return <section className="fc-editor-section" aria-labelledby={`fc-sec-${spec.key}`}>
    <div className="fc-section-heading">
      <h3 id={`fc-sec-${spec.key}`}>{spec.title}</h3>
      <button type="button" className="rm-button rm-button--small" onClick={() => onChange([...rows, spec.template(doc, rows.length)])}><Plus size={14} aria-hidden="true" />Add</button>
    </div>
    {rows.length === 0 ? <p className="fc-muted">None.</p> : <div className="fc-scroll" role="region" aria-label={spec.title} tabIndex={0}>
      <table className="rm-table fc-table fc-table--edit">
        <thead><tr>{spec.fields.map(field => <th key={field.path} scope="col">{field.label}</th>)}<th scope="col"><span className="fc-sr-only">Remove</span></th></tr></thead>
        <tbody>{rows.map((row, index) => <tr key={`${String(row[spec.idField])}-${index}`}>
          {spec.fields.map(field => <td key={field.path}><FieldInput spec={field} value={getPath(row, field.path)} label={`${field.label}, ${String(row[spec.idField] ?? index + 1)}`}
            onChange={value => onChange(rows.map((item, position) => (position === index ? setPath(item, field.path, value) : item)))} /></td>)}
          <td><button type="button" className="rm-button rm-button--icon rm-button--ghost" aria-label={`Remove ${String(row[spec.idField] ?? index + 1)}`} onClick={() => onChange(rows.filter((_, position) => position !== index))}><Trash2 size={15} /></button></td>
        </tr>)}</tbody>
      </table>
    </div>}
  </section>;
}

export type SaveCommand = (kind: "forecast.assumptions.save" | "forecast.override.set", payload: Record<string, unknown>, expectedRevision?: number) => Promise<unknown>;

/** Grouped editor over the full assumption document. Saving makes a new immutable version with a reason. */
export function AssumptionsView({ detail, opening, currency, onPreviewDraft, draftPreviewActive, save }: {
  detail: ForecastScenarioDetail;
  opening: readonly ForecastOpeningItem[];
  currency: string;
  onPreviewDraft: (draft: Doc | null) => void;
  draftPreviewActive: boolean;
  save: SaveCommand;
}) {
  const original = useMemo(() => (detail.assumptions ?? {}) as Doc, [detail.assumptions]);
  const [draft, setDraft] = useState<Doc>(original);
  const [dialog, setDialog] = useState<null | { kind: "save" } | { kind: "restore"; version: number } | { kind: "opening"; item: string; amount?: string } | { kind: "override" }>(null);
  useEffect(() => { setDraft(original); onPreviewDraft(null); }, [original, onPreviewDraft]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(original);
  const validation = useMemo(() => forecastAssumptionsSchema.safeParse(draft), [draft]);
  const issues = validation.success ? [] : validation.error.issues.slice(0, 5).map(issue => `${issue.path.join(".")}: ${issue.message}`);
  const specs = useMemo(() => sectionSpecs(draft), [draft]);
  const overrides = ((draft.overrides as Row[] | undefined) ?? []);
  const editable = detail.state !== "archived";
  if (!detail.assumptions) return <EmptyState title="No assumptions yet" message="This scenario has no saved assumption version." />;
  const leasing = (draft.leasing as Row | undefined) ?? {};
  return <div className="fc-view fc-editor">
    <div className="fc-editor-bar" role="toolbar" aria-label="Assumption actions">
      <span className="fc-muted">Version {detail.currentAssumptionVersion}{detail.versions[0] ? ` · ${detail.versions[0].authorId} · ${timestampLabel(detail.versions[0].createdAt)}` : ""}</span>
      <span className="fc-spacer" />
      {dirty && <span className="rm-status rm-status--warning">Unsaved changes</span>}
      <button type="button" className="rm-button" disabled={!dirty || !validation.success} aria-pressed={draftPreviewActive} onClick={() => onPreviewDraft(draftPreviewActive ? null : draft)}>{draftPreviewActive ? "Stop Preview" : "Preview Changes"}</button>
      <button type="button" className="rm-button" disabled={!dirty} onClick={() => { setDraft(original); onPreviewDraft(null); }}>Discard</button>
      <button type="button" className="rm-button" disabled={!dirty || !validation.success || !editable} onClick={() => setDialog({ kind: "save" })}>Save Version…</button>
    </div>
    {issues.length > 0 && <div className="fc-alert" role="alert"><span>Fix before saving: {issues.join("; ")}</span></div>}
    <section className="fc-editor-section" aria-labelledby="fc-sec-general">
      <h3 id="fc-sec-general">General</h3>
      <div className="rm-form-grid fc-form-grid">
        <Field label="Actuals cutoff" help="Opening balances are as of the end of this day"><FieldInput spec={{ path: "actualsCutoff", label: "Actuals cutoff", kind: "date" }} label="Actuals cutoff" value={draft.actualsCutoff} onChange={value => setDraft(current => setPath(current, "actualsCutoff", value))} /></Field>
        <Field label="Note" wide><FieldInput spec={{ path: "note", label: "Note", kind: "text", optional: true }} label="Note" value={draft.note} onChange={value => setDraft(current => setPath(current, "note", value))} /></Field>
      </div>
    </section>
    <section className="fc-editor-section" aria-labelledby="fc-sec-opening">
      <div className="fc-section-heading"><h3 id="fc-sec-opening">Opening position</h3></div>
      <table className="rm-table fc-table fc-table--compact">
        <thead><tr><th scope="col">Item</th><th scope="col">State</th><th scope="col" className="fc-num">Amount</th><th scope="col">As of</th><th scope="col">Source</th><th scope="col"><span className="fc-sr-only">Action</span></th></tr></thead>
        <tbody>{opening.filter(item => (OPENING_ITEM_KEYS as readonly string[]).includes(item.key)).map(item => <tr key={item.key}>
          <th scope="row">{item.label}{item.memo && <span className="fc-muted"> (disclosed)</span>}</th>
          <td><span className={item.state === "unknown" ? "rm-status rm-status--error" : item.state === "partial" ? "rm-status rm-status--warning" : item.state === "manual" ? "rm-status rm-status--unknown" : "rm-status rm-status--success"}>{item.state === "manual" ? "Approved override" : item.state[0]!.toUpperCase() + item.state.slice(1)}</span></td>
          <td className="fc-num">{item.amountCents === null ? "Unknown" : money(item.amountCents, currency)}</td>
          <td>{dateLabel(item.asOf, "long")}</td>
          <td className="fc-source">{item.source}{item.note ? ` ${item.note}` : ""}</td>
          <td>{editable && !item.memo && <button type="button" className="rm-button rm-button--small" disabled={dirty} onClick={() => setDialog({ kind: "opening", item: item.key, ...(item.amountCents ? { amount: item.amountCents } : {}) })}>Set Balance</button>}</td>
        </tr>)}</tbody>
      </table>
      {dirty && <p className="fc-footnote">Save or discard your edits before setting an opening balance.</p>}
    </section>
    <section className="fc-editor-section" aria-labelledby="fc-sec-overrides">
      <div className="fc-section-heading"><h3 id="fc-sec-overrides">Approved overrides</h3>
        {editable && <button type="button" className="rm-button rm-button--small" disabled={dirty} onClick={() => setDialog({ kind: "override" })}><Plus size={14} aria-hidden="true" />Add</button>}</div>
      {overrides.length === 0 ? <p className="fc-muted">None.</p> : <table className="rm-table fc-table fc-table--compact">
        <thead><tr><th scope="col">Override</th><th scope="col">Period</th><th scope="col" className="fc-num">Amount</th><th scope="col">Reason</th><th scope="col">Set by</th><th scope="col"><span className="fc-sr-only">Remove</span></th></tr></thead>
        <tbody>{overrides.map(item => <tr key={String(item.id)}>
          <th scope="row">{item.kind === "opening_balance" ? OPENING_ITEM_LABELS[item.item as keyof typeof OPENING_ITEM_LABELS] : item.kind === "unit_rent" ? `Rent · ${String(item.unitId)}` : `Cost · ${String(item.expenseId)}`}</th>
          <td>{item.kind === "opening_balance" ? dateLabel(String(item.asOf), "long") : String(item.month)}</td>
          <td className="fc-num">{money(String(item.amountCents), currency)}</td><td>{String(item.reason)}</td><td>{String(item.author)} · {dateLabel(String(item.setOn), "long")}</td>
          <td>{editable && <button type="button" className="rm-button rm-button--small rm-button--ghost" disabled={dirty} onClick={() => void save("forecast.override.set", { scenarioId: detail.id, removeOverrideId: String(item.id), reason: "Removed from the assumptions page" }, detail.recordRevision)}>Remove</button>}</td>
        </tr>)}</tbody>
      </table>}
    </section>
    <section className="fc-editor-section" aria-labelledby="fc-sec-leasing">
      <h3 id="fc-sec-leasing">Leasing and collections</h3>
      <div className="rm-form-grid fc-form-grid">
        {LEASING_FIELDS.map(field => <Field key={field.path} label={field.label}>
          <FieldInput spec={field} label={field.label} value={getPath(leasing, field.path)} onChange={value => setDraft(current => setPath(current, `leasing.${field.path}`, value))} />
        </Field>)}
      </div>
    </section>
    {specs.map(spec => <RowSection key={spec.key} spec={spec} doc={draft} onChange={rows => setDraft(current => ({ ...current, [spec.key]: rows }))} />)}
    <section className="fc-editor-section" aria-labelledby="fc-sec-history">
      <h3 id="fc-sec-history">Version history</h3>
      <table className="rm-table fc-table fc-table--compact">
        <thead><tr><th scope="col">Version</th><th scope="col">Saved</th><th scope="col">By</th><th scope="col">Reason</th><th scope="col"><span className="fc-sr-only">Restore</span></th></tr></thead>
        <tbody>{detail.versions.map(version => <tr key={version.version}>
          <th scope="row">{version.version}{version.version === detail.currentAssumptionVersion && <span className="rm-status rm-status--success fc-tag">Current</span>}</th>
          <td>{timestampLabel(version.createdAt)}</td><td>{version.authorId}</td><td>{version.reason}</td>
          <td>{editable && version.version !== detail.currentAssumptionVersion && <button type="button" className="rm-button rm-button--small" disabled={dirty} onClick={() => setDialog({ kind: "restore", version: version.version })}>Restore</button>}</td>
        </tr>)}</tbody>
      </table>
    </section>
    {dialog?.kind === "save" && <ReasonDialog title="Save assumptions" subtitle={`Creates version ${detail.currentAssumptionVersion + 1}. Earlier versions stay unchanged.`} submitLabel="Save Version"
      onClose={() => setDialog(null)} onSubmit={async reason => { await save("forecast.assumptions.save", { scenarioId: detail.id, assumptions: validation.success ? validation.data : draft, reason }, detail.recordRevision); onPreviewDraft(null); setDialog(null); }} />}
    {dialog?.kind === "restore" && <ReasonDialog title={`Restore version ${dialog.version}`} subtitle={`Saves version ${dialog.version} as version ${detail.currentAssumptionVersion + 1}; nothing is deleted.`} submitLabel="Restore"
      onClose={() => setDialog(null)} onSubmit={async reason => { await save("forecast.assumptions.save", { scenarioId: detail.id, fromVersion: dialog.version, reason }, detail.recordRevision); setDialog(null); }} />}
    {dialog?.kind === "opening" && <OpeningDialog item={dialog.item} initial={dialog.amount} cutoff={String(draft.actualsCutoff ?? "")} onClose={() => setDialog(null)}
      onSubmit={async (amountCents, asOf, reason) => { await save("forecast.override.set", { scenarioId: detail.id, reason, override: { id: `opening-${dialog.item}`, kind: "opening_balance", item: dialog.item, amountCents, asOf } }, detail.recordRevision); setDialog(null); }} />}
    {dialog?.kind === "override" && <OverrideDialog doc={draft} onClose={() => setDialog(null)}
      onSubmit={async (override, reason) => { await save("forecast.override.set", { scenarioId: detail.id, reason, override }, detail.recordRevision); setDialog(null); }} />}
  </div>;
}

function ReasonDialog({ title, subtitle, submitLabel, onClose, onSubmit }: { title: string; subtitle: string; submitLabel: string; onClose: () => void; onSubmit: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!reason.trim()) { setError(new Error("Give a reason for this change.")); return; }
    setSaving(true); setError(undefined);
    try { await onSubmit(reason.trim()); } catch (problem) { setError(problem); setSaving(false); }
  };
  return <Dialog title={title} subtitle={subtitle} onClose={onClose} onSubmit={submit} saving={saving} submitLabel={submitLabel}>
    <Notice error={error} />
    <Field label="Reason" wide><textarea data-autofocus rows={3} maxLength={1000} value={reason} onChange={event => setReason(event.currentTarget.value)} placeholder="What changed and why" /></Field>
  </Dialog>;
}

function OpeningDialog({ item, initial, cutoff, onClose, onSubmit }: { item: string; initial?: string; cutoff: string; onClose: () => void; onSubmit: (amountCents: string, asOf: string, reason: string) => Promise<void> }) {
  const [amount, setAmount] = useState(initial ? formatInputValue(initial) : "");
  const [asOf, setAsOf] = useState(cutoff);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const cents = parseMoneyInput(amount, "Amount").cents;
      if (!reason.trim()) throw new Error("Give the source of this balance.");
      setSaving(true); setError(undefined);
      await onSubmit(cents, asOf, reason.trim());
    } catch (problem) { setError(problem); setSaving(false); }
  };
  return <Dialog title={`Set ${OPENING_ITEM_LABELS[item as keyof typeof OPENING_ITEM_LABELS] ?? item}`} subtitle="An approved opening balance records who set it, when and why." onClose={onClose} onSubmit={submit} saving={saving} submitLabel="Save Balance">
    <Notice error={error} />
    <div className="rm-form-grid">
      <Field label="Amount"><input data-autofocus inputMode="decimal" value={amount} onChange={event => setAmount(event.currentTarget.value)} placeholder="0.00" /></Field>
      <Field label="As of"><input type="date" value={asOf} onChange={event => setAsOf(event.currentTarget.value)} /></Field>
      <Field label="Source and reason" wide><textarea rows={3} maxLength={1000} value={reason} onChange={event => setReason(event.currentTarget.value)} placeholder="Bank statement ending 12/27" /></Field>
    </div>
  </Dialog>;
}

function OverrideDialog({ doc, onClose, onSubmit }: { doc: Doc; onClose: () => void; onSubmit: (override: Record<string, unknown>, reason: string) => Promise<void> }) {
  const units = ((doc.units as Row[] | undefined) ?? []);
  const expenses = ((doc.expenses as Row[] | undefined) ?? []);
  const [kind, setKind] = useState<"unit_rent" | "expense_amount">(units.length ? "unit_rent" : "expense_amount");
  const [target, setTarget] = useState(String((kind === "unit_rent" ? units[0]?.unitId : expenses[0]?.id) ?? ""));
  const [month, setMonth] = useState(String(doc.actualsCutoff ?? "").slice(0, 7));
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const options = kind === "unit_rent" ? units.map(unit => ({ value: String(unit.unitId), label: String(unit.label) })) : expenses.map(expense => ({ value: String(expense.id), label: String(expense.label) }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const cents = parseMoneyInput(amount, "Amount").cents;
      if (cents.startsWith("-")) throw new Error("Amount cannot be negative.");
      if (!target) throw new Error("Choose what to override.");
      if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Choose a month.");
      if (!reason.trim()) throw new Error("Give a reason for this override.");
      setSaving(true); setError(undefined);
      const id = `${kind === "unit_rent" ? "rent" : "cost"}-${target}-${month}`.slice(0, 80);
      await onSubmit(kind === "unit_rent" ? { id, kind, unitId: target, month, amountCents: cents } : { id, kind, expenseId: target, month, amountCents: cents }, reason.trim());
    } catch (problem) { setError(problem); setSaving(false); }
  };
  return <Dialog title="Add override" subtitle="Replaces one driver for one month; the author, month and reason are kept." onClose={onClose} onSubmit={submit} saving={saving} submitLabel="Save Override">
    <Notice error={error} />
    <div className="rm-form-grid">
      <Field label="Override"><select data-autofocus value={kind} onChange={event => { const next = event.currentTarget.value as typeof kind; setKind(next); setTarget(String((next === "unit_rent" ? units[0]?.unitId : expenses[0]?.id) ?? "")); }}>
        <option value="unit_rent">Unit rent for a month</option><option value="expense_amount">Cost amount for a month</option></select></Field>
      <Field label={kind === "unit_rent" ? "Unit" : "Cost"}><select value={target} onChange={event => setTarget(event.currentTarget.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field>
      <Field label="Month"><input type="month" value={month} onChange={event => setMonth(event.currentTarget.value)} /></Field>
      <Field label="Amount"><input inputMode="decimal" value={amount} onChange={event => setAmount(event.currentTarget.value)} placeholder="0.00" /></Field>
      <Field label="Reason" wide><textarea rows={3} maxLength={1000} value={reason} onChange={event => setReason(event.currentTarget.value)} /></Field>
    </div>
  </Dialog>;
}
