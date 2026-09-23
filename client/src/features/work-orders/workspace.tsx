import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, ChevronLeft, CircleAlert, DoorOpen, FileText, Link2, LoaderCircle, Plus, Search, Wrench, X } from "lucide-react";
import type { FinancialSourceReference } from "@shared/accounting/source";
import type { CostSourceLine } from "@shared/projects/source-lines";
import type { CompanyContextEntity } from "@shared/company/context";
import {
  WORK_ORDER_CATEGORIES,
  WORK_ORDER_PRIORITIES,
  workOrderTransitionRequiresNote,
  type WorkOrderCategory,
  type WorkOrderCommandKind,
  type WorkOrderDetail,
  type WorkOrderPriority,
  type WorkOrderStatus,
  type WorkOrderSummary,
} from "@shared/work-orders";
import { formatInputValue, formatMoney, parseMoneyInput } from "../projects/money";
import { WorkOrderApiError, revisionFrom, workOrderEnvelope, workOrdersApi, type WorkOrderCommandEnvelope } from "./api";
import { PRIORITY_LABELS, STATUS_LABELS, categoryLabel, dateLabel, eventSummary, operatingToday, priorityClass, scheduleOrder, statusClass, timestampLabel } from "./format";
import { PendingEnvelopes } from "./pending";
import "./work-orders.css";

import { WORK_ORDER_VIEWS, type WorkOrderView } from "./types";

export type { WorkOrderView };
const VIEW_LABELS: Record<WorkOrderView, string> = { open: "Open", schedule: "Schedule", all: "All", ...STATUS_LABELS };

export interface WorkOrdersWorkspaceProps {
  organizationId: string;
  entities: readonly CompanyContextEntity[];
  view: WorkOrderView;
  selectedId?: string;
  /** Changes each time the navigation asks for a new work order. */
  createRequest?: number;
  onSelect: (workOrderId: string | undefined, replace?: boolean) => void;
  onViewChange: (view: WorkOrderView) => void;
  onOpenProperty?: (propertyId: string) => void;
  onOpenUnit?: (unitId: string) => void;
  onOpenTenant?: (personId: string) => void;
}

let handledCreateRequest = 0;

type DialogState =
  | { kind: "create" }
  | { kind: "edit" }
  | { kind: "status"; to?: WorkOrderStatus }
  | { kind: "note" }
  | { kind: "chargeback" }
  | { kind: "vendor" }
  | { kind: "cost" }
  | { kind: "manual" }
  | { kind: "attachment" };

interface PropertyChoice { entityId: string; propertyId: string; name: string; units: { id: string; unitNumber: string }[] }

function propertyChoices(entities: readonly CompanyContextEntity[]): PropertyChoice[] {
  return entities.flatMap(entity => entity.properties.map(property => ({ entityId: entity.id, propertyId: property.id, name: property.name, units: property.units })))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function useDebounced<T>(value: T, delay = 250): T {
  const [current, setCurrent] = useState(value);
  useEffect(() => { const timer = window.setTimeout(() => setCurrent(value), delay); return () => window.clearTimeout(timer); }, [value, delay]);
  return current;
}

function StatusCapsule({ status }: { status: WorkOrderStatus }) {
  return <span className={statusClass(status)}>{STATUS_LABELS[status]}</span>;
}

function PriorityCapsule({ priority, always = false }: { priority: WorkOrderPriority; always?: boolean }) {
  const tone = priorityClass(priority);
  if (!tone && !always) return null;
  return <span className={tone ?? "rm-status rm-status--unknown"}>{PRIORITY_LABELS[priority]}</span>;
}

function Notice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return <div className="wo-alert" role="alert"><CircleAlert size={16} aria-hidden="true" /><span>{errorText(error, "Something went wrong.")}</span>{onRetry && <button type="button" className="rm-button rm-button--small" onClick={onRetry}>{error instanceof WorkOrderApiError && error.conflict ? "Reload" : "Try again"}</button>}</div>;
}

function Dialog({ title, subtitle, onClose, onSubmit, saving, submitLabel, children }: {
  title: string; subtitle?: string; onClose: () => void; onSubmit: (event: FormEvent) => void; saving: boolean; submitLabel: string; children: ReactNode;
}) {
  const titleId = `wo-dialog-${useId().replace(/:/g, "")}`;
  const formId = `${titleId}-form`;
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>("[data-autofocus], input, select, textarea");
    first?.focus();
    return () => previous?.focus?.();
  }, []);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape" && !saving) onClose(); };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onClose, saving]);
  return <div className="rm-dialog-backdrop wo-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <section ref={panel} className="rm-dialog wo-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={saving}>
      <div className="rm-dialog-header wo-dialog-header">
        <div><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <button type="button" className="rm-button rm-button--icon rm-button--ghost" aria-label="Close" onClick={onClose} disabled={saving}><X size={17} /></button>
      </div>
      <form id={formId} className="rm-dialog-body wo-dialog-body" onSubmit={onSubmit} noValidate>
        <fieldset className="wo-fieldset" disabled={saving}>{children}</fieldset>
      </form>
      <div className="rm-dialog-footer wo-dialog-footer">
        <button type="button" className="rm-button" onClick={onClose} disabled={saving}>Cancel</button>
        <button type="submit" form={formId} className="rm-button rm-button-primary" disabled={saving}>{saving ? <><LoaderCircle size={15} className="wo-spin" />Saving…</> : submitLabel}</button>
      </div>
    </section>
  </div>;
}

function Field({ label, children, wide = false, help }: { label: string; children: ReactNode; wide?: boolean; help?: string }) {
  return <label className={`rm-field${wide ? " rm-field--wide" : ""}`}><span className="rm-field-label">{label}</span>{children}{help && <span className="rm-field-help">{help}</span>}</label>;
}

interface EditValues {
  propertyKey: string; unitId: string; tenancyId: string; projectId: string; title: string; description: string;
  category: WorkOrderCategory; priority: WorkOrderPriority; reportedOn: string; scheduledOn: string; assignedTo: string;
  entryPermitted: boolean; estimate: string;
}

function editDefaults(detail: WorkOrderDetail | undefined, choices: readonly PropertyChoice[]): EditValues {
  const choice = detail ? choices.find(item => item.propertyId === detail.propertyId && item.entityId === detail.legalEntityId) : choices[0];
  return {
    propertyKey: choice ? `${choice.entityId}|${choice.propertyId}` : "",
    unitId: detail?.unitId ?? "", tenancyId: detail?.tenancyId ?? "", projectId: detail?.projectId ?? "",
    title: detail?.title ?? "", description: detail?.description ?? "", category: detail?.category ?? "general", priority: detail?.priority ?? "normal",
    reportedOn: detail?.reportedOn ?? operatingToday(), scheduledOn: detail?.scheduledOn ?? "", assignedTo: detail?.assignedTo ?? "",
    entryPermitted: detail?.entryPermitted ?? false, estimate: detail?.estimatedCostCents ? formatInputValue(detail.estimatedCostCents) : "",
  };
}

type Save = (kind: WorkOrderCommandKind, legalEntityId: string, payload: Record<string, unknown>, expectedRevision?: number) => Promise<number | undefined>;

function EditDialog({ organizationId, detail, choices, onClose, onSaved, save }: {
  organizationId: string; detail?: WorkOrderDetail; choices: readonly PropertyChoice[]; onClose: () => void; onSaved: (id: string) => void; save: Save;
}) {
  const [values, setValues] = useState(() => editDefaults(detail, choices));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const set = <K extends keyof EditValues>(key: K, value: EditValues[K]) => setValues(current => ({ ...current, [key]: value }));
  const [entityId, propertyId] = detail ? [detail.legalEntityId, detail.propertyId] : values.propertyKey.split("|");
  const choice = choices.find(item => item.entityId === entityId && item.propertyId === propertyId);
  const tenants = useQuery({
    queryKey: ["work-orders", "tenants", organizationId, entityId, propertyId],
    queryFn: ({ signal }) => workOrdersApi.tenantOptions(organizationId, entityId!, propertyId!, signal),
    enabled: Boolean(entityId && propertyId), staleTime: 30_000, retry: false,
  });
  const projects = useQuery({
    queryKey: ["work-orders", "projects", organizationId, entityId, propertyId],
    queryFn: ({ signal }) => workOrdersApi.projects(organizationId, entityId!, propertyId!, signal),
    enabled: Boolean(entityId && propertyId), staleTime: 30_000, retry: false,
  });
  const tenantChoices = (tenants.data ?? []).filter(item => !values.unitId || item.unitId === values.unitId);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    if (!values.title.trim()) { setError(new Error("Enter a title.")); return; }
    if (!entityId || !propertyId) { setError(new Error("Choose a property.")); return; }
    let estimatedCostCents: string | null = null;
    try {
      if (values.estimate.trim()) {
        estimatedCostCents = parseMoneyInput(values.estimate, "Estimated cost").cents;
        if (BigInt(estimatedCostCents) < BigInt(0)) throw new Error("Estimated cost cannot be negative.");
      }
    } catch (parseError) { setError(parseError); return; }
    const fields: Record<string, unknown> = {
      unitId: values.unitId || null, title: values.title.trim(),
      description: values.description.trim() || null, category: values.category, priority: values.priority, reportedOn: values.reportedOn,
      scheduledOn: values.scheduledOn || null, assignedTo: values.assignedTo.trim() || null, entryPermitted: values.entryPermitted, estimatedCostCents,
    };
    setSaving(true);
    try {
      if (!detail) {
        const payload: Record<string, unknown> = {
          propertyId, ...fields, ...(values.tenancyId ? { tenancyId: values.tenancyId } : {}),
          ...(values.projectId ? { projectId: values.projectId } : {}), ...(values.scheduledOn ? { status: "scheduled" } : {}),
        };
        await save("work_order.create", entityId, payload);
        onSaved("");
        return;
      }
      const original = editDefaults(detail, choices);
      const changed: Record<string, unknown> = { workOrderId: detail.id };
      const before: Record<string, unknown> = {
        unitId: detail.unitId, title: detail.title, description: detail.description,
        category: detail.category, priority: detail.priority, reportedOn: detail.reportedOn, scheduledOn: detail.scheduledOn,
        assignedTo: detail.assignedTo, entryPermitted: detail.entryPermitted, estimatedCostCents: detail.estimatedCostCents,
      };
      for (const [key, value] of Object.entries(fields)) if (before[key] !== value) changed[key] = value;
      // The server defaults a changed tenancy to its primary person and revalidates the link.
      if (values.tenancyId !== original.tenancyId || "unitId" in changed) changed.tenancyId = values.tenancyId || null;
      let revision: number | undefined = detail.recordRevision;
      if (Object.keys(changed).length > 1) revision = await save("work_order.update", detail.legalEntityId, changed, revision);
      if (values.projectId !== original.projectId) revision = await save("work_order.project.link", detail.legalEntityId, { workOrderId: detail.id, projectId: values.projectId || null }, revision);
      onSaved(detail.id);
    } catch (saveError) {
      setError(saveError);
    } finally {
      setSaving(false);
    }
  };
  return <Dialog title={detail ? "Edit work order" : "New work order"} subtitle={detail ? detail.reference : "Record the request; scheduling and status follow from here."} onClose={onClose} onSubmit={submit} saving={saving} submitLabel={detail ? "Save changes" : "Create work order"}>
    <Notice error={error} />
    <div className="rm-form-grid">
      <Field label="Title" wide><input data-autofocus value={values.title} maxLength={200} onChange={event => set("title", event.currentTarget.value)} placeholder="Leaking kitchen faucet" required /></Field>
      <Field label="Property">
        <select value={values.propertyKey} disabled={Boolean(detail)} onChange={event => { const propertyKey = event.currentTarget.value; setValues(current => ({ ...current, propertyKey, unitId: "", tenancyId: "", projectId: "" })); }}>
          {!choices.length && <option value="">No properties available</option>}
          {choices.map(item => <option key={`${item.entityId}|${item.propertyId}`} value={`${item.entityId}|${item.propertyId}`}>{item.name}</option>)}
        </select>
      </Field>
      <Field label="Unit">
        <select value={values.unitId} onChange={event => { const unitId = event.currentTarget.value; setValues(current => ({ ...current, unitId, tenancyId: "" })); }}>
          <option value="">Whole property</option>
          {choice?.units.map(unit => <option key={unit.id} value={unit.id}>Unit {unit.unitNumber}</option>)}
        </select>
      </Field>
      <Field label="Category">
        <select value={values.category} onChange={event => set("category", event.currentTarget.value as WorkOrderCategory)}>
          {WORK_ORDER_CATEGORIES.map(category => <option key={category} value={category}>{categoryLabel(category)}</option>)}
        </select>
      </Field>
      <Field label="Priority">
        <select value={values.priority} onChange={event => set("priority", event.currentTarget.value as WorkOrderPriority)}>
          {WORK_ORDER_PRIORITIES.map(priority => <option key={priority} value={priority}>{PRIORITY_LABELS[priority]}</option>)}
        </select>
      </Field>
      <Field label="Tenant">
        <select value={values.tenancyId} onChange={event => set("tenancyId", event.currentTarget.value)} disabled={tenants.isLoading}>
          <option value="">{tenants.isLoading ? "Loading tenants…" : "No tenant"}</option>
          {tenantChoices.map(item => <option key={item.tenancyId} value={item.tenancyId}>{item.personName}{item.unitNumber ? ` · ${item.unitNumber}` : ""}{item.status !== "current" ? ` (${item.status})` : ""}</option>)}
        </select>
      </Field>
      <Field label="Assigned to" help="Vendor or staff name">
        <input value={values.assignedTo} maxLength={200} onChange={event => set("assignedTo", event.currentTarget.value)} placeholder="Unassigned" />
      </Field>
      <Field label="Reported"><input type="date" value={values.reportedOn} onChange={event => set("reportedOn", event.currentTarget.value)} /></Field>
      <Field label="Scheduled" help={detail ? undefined : "A date schedules the work order"}><input type="date" value={values.scheduledOn} onChange={event => set("scheduledOn", event.currentTarget.value)} /></Field>
      <Field label="Estimated cost" help="Estimate only; nothing is billed or posted">
        <input inputMode="decimal" value={values.estimate} onChange={event => set("estimate", event.currentTarget.value)} placeholder="0.00" />
      </Field>
      <Field label="Project">
        <select value={values.projectId} onChange={event => set("projectId", event.currentTarget.value)} disabled={projects.isLoading}>
          <option value="">No project</option>
          {projects.data?.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </Field>
      <Field label="Description" wide><textarea rows={3} maxLength={4000} value={values.description} onChange={event => set("description", event.currentTarget.value)} placeholder="What was reported, where, and any access notes" /></Field>
      <label className="wo-check rm-field--wide"><input type="checkbox" checked={values.entryPermitted} onChange={event => set("entryPermitted", event.currentTarget.checked)} /><span>Tenant permits entry when not home</span></label>
    </div>
  </Dialog>;
}

function StatusDialog({ detail, initial, onClose, onSaved, save }: { detail: WorkOrderDetail; initial?: WorkOrderStatus; onClose: () => void; onSaved: () => void; save: Save }) {
  const [to, setTo] = useState<WorkOrderStatus | "">(initial ?? detail.allowedTransitions[0] ?? "");
  const [note, setNote] = useState("");
  const [scheduledOn, setScheduledOn] = useState(detail.scheduledOn ?? "");
  const [completedOn, setCompletedOn] = useState(operatingToday());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const noteRequired = to ? workOrderTransitionRequiresNote(detail.status, to) : false;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!to) return;
    if (noteRequired && !note.trim()) { setError(new Error("Add a note explaining this change.")); return; }
    if (to === "scheduled" && !scheduledOn) { setError(new Error("Choose a scheduled date.")); return; }
    setSaving(true); setError(undefined);
    try {
      await save("work_order.status.change", detail.legalEntityId, {
        workOrderId: detail.id, status: to, ...(note.trim() ? { note: note.trim() } : {}),
        ...(to === "scheduled" && scheduledOn ? { scheduledOn } : {}), ...(to === "completed" ? { completedOn } : {}),
      }, detail.recordRevision);
      onSaved();
    } catch (saveError) { setError(saveError); } finally { setSaving(false); }
  };
  return <Dialog title="Change status" subtitle={`${detail.reference} · currently ${STATUS_LABELS[detail.status]}`} onClose={onClose} onSubmit={submit} saving={saving} submitLabel={to ? `Mark ${STATUS_LABELS[to].toLowerCase()}` : "Save"}>
    <Notice error={error} />
    <fieldset className="wo-choice-group">
      <legend className="rm-field-label">New status</legend>
      <div className="wo-choices">
        {detail.allowedTransitions.map(status => <label key={status} className={`wo-choice${to === status ? " is-selected" : ""}`}>
          <input type="radio" name="wo-status" value={status} checked={to === status} onChange={() => { setTo(status); setError(undefined); }} />
          <StatusCapsule status={status} />
        </label>)}
      </div>
    </fieldset>
    <div className="rm-form-grid wo-status-fields">
      {to === "scheduled" && <Field label="Scheduled date"><input type="date" value={scheduledOn} onChange={event => setScheduledOn(event.currentTarget.value)} /></Field>}
      {to === "completed" && <Field label="Completed on" help="Completion does not record a payment or post costs."><input type="date" value={completedOn} min={detail.reportedOn} onChange={event => setCompletedOn(event.currentTarget.value)} /></Field>}
      <Field label={noteRequired ? "Note (required)" : "Note (optional)"} wide>
        <textarea rows={3} maxLength={4000} value={note} onChange={event => setNote(event.currentTarget.value)} placeholder={to === "on_hold" ? "What is this waiting on?" : to === "canceled" ? "Why is this canceled?" : "Add context for the history"} />
      </Field>
    </div>
  </Dialog>;
}

function NoteDialog({ detail, onClose, onSaved, save }: { detail: WorkOrderDetail; onClose: () => void; onSaved: () => void; save: Save }) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!note.trim()) { setError(new Error("Write a note first.")); return; }
    setSaving(true); setError(undefined);
    try { await save("work_order.note.add", detail.legalEntityId, { workOrderId: detail.id, note: note.trim() }); onSaved(); }
    catch (saveError) { setError(saveError); } finally { setSaving(false); }
  };
  return <Dialog title="Add note" subtitle={detail.reference} onClose={onClose} onSubmit={submit} saving={saving} submitLabel="Add note">
    <Notice error={error} />
    <Field label="Note" wide><textarea data-autofocus rows={4} maxLength={4000} value={note} onChange={event => setNote(event.currentTarget.value)} /></Field>
  </Dialog>;
}

function ChargebackDialog({ detail, onClose, onSaved, save }: { detail: WorkOrderDetail; onClose: () => void; onSaved: () => void; save: Save }) {
  const [amount, setAmount] = useState(detail.chargeback ? formatInputValue(detail.chargeback.amountCents) : "");
  const [description, setDescription] = useState(detail.chargeback?.description ?? "");
  const [ledgerTransactionId, setLedgerTransactionId] = useState(detail.chargeback?.ledgerTransactionId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    let amountCents: string;
    try {
      amountCents = parseMoneyInput(amount, "Amount").cents;
      if (BigInt(amountCents) <= BigInt(0)) throw new Error("Amount must be greater than zero.");
    } catch (parseError) { setError(parseError); return; }
    if (!description.trim()) { setError(new Error("Describe what the tenant is being charged for.")); return; }
    setSaving(true); setError(undefined);
    try {
      await save("work_order.chargeback.set", detail.legalEntityId, { workOrderId: detail.id, amountCents, description: description.trim(), ledgerTransactionId: ledgerTransactionId.trim() || null }, detail.recordRevision);
      onSaved();
    } catch (saveError) { setError(saveError); } finally { setSaving(false); }
  };
  return <Dialog title={detail.chargeback ? "Edit chargeback" : "Record chargeback"} subtitle={`Bill ${detail.personName ?? "the tenant"} for this work`} onClose={onClose} onSubmit={submit} saving={saving} submitLabel="Save chargeback">
    <Notice error={error} />
    <p className="wo-dialog-note">This records the intent to charge the tenant. It does not post a charge; post it from Payments &amp; billing and link it here.</p>
    <div className="rm-form-grid">
      <Field label="Amount"><input data-autofocus inputMode="decimal" value={amount} onChange={event => setAmount(event.currentTarget.value)} placeholder="0.00" /></Field>
      <Field label="Posted charge ID" help="Optional: an existing posted tenant charge"><input value={ledgerTransactionId} maxLength={160} onChange={event => setLedgerTransactionId(event.currentTarget.value)} placeholder="Not posted" /></Field>
      <Field label="Description" wide><input value={description} maxLength={300} onChange={event => setDescription(event.currentTarget.value)} placeholder="Damage beyond normal wear" /></Field>
    </div>
  </Dialog>;
}

function VendorDialog({ organizationId, detail, onClose, onSaved, save }: { organizationId: string; detail: WorkOrderDetail; onClose: () => void; onSaved: () => void; save: Save }) {
  const options = useQuery({ queryKey: ["work-orders", "vendors", organizationId, detail.legalEntityId], queryFn: ({ signal }) => workOrdersApi.vendorOptions(organizationId, detail.legalEntityId, signal), retry: false });
  const [choice, setChoice] = useState(detail.vendor ? `${detail.vendor.kind}|${detail.vendor.id}` : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const [kind, id] = choice ? choice.split("|") : [];
    setSaving(true); setError(undefined);
    try { await save("work_order.vendor.assign", detail.legalEntityId, { workOrderId: detail.id, vendor: kind && id ? { kind, id } : null }, detail.recordRevision); onSaved(); }
    catch (saveError) { setError(saveError); } finally { setSaving(false); }
  };
  return <Dialog title="Assign vendor" subtitle={detail.reference} onClose={onClose} onSubmit={submit} saving={saving} submitLabel="Save vendor">
    <Notice error={error ?? options.error} />
    <Field label="Vendor" wide><select data-autofocus value={choice} onChange={event => setChoice(event.currentTarget.value)} disabled={options.isLoading}>
      <option value="">{options.isLoading ? "Loading vendors…" : "No vendor"}</option>
      {(options.data ?? []).map(item => <option key={`${item.kind}|${item.id}`} value={`${item.kind}|${item.id}`}>{item.name}{item.kind === "project_vendor" ? " · Project vendor" : ""}</option>)}
    </select></Field>
  </Dialog>;
}

function lineKey(source: FinancialSourceReference): string { return `${source.realmId}|${source.objectType}|${source.objectId}|${source.lineId ?? ""}|${source.version}`; }

function CostLinkDialog({ organizationId, detail, onClose, onSaved, save }: { organizationId: string; detail: WorkOrderDetail; onClose: () => void; onSaved: () => void; save: Save }) {
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search, 300);
  const lines = useQuery({ queryKey: ["work-orders", "cost-lines", organizationId, detail.legalEntityId, debounced], queryFn: ({ signal }) => workOrdersApi.costLines(organizationId, detail.legalEntityId, debounced, undefined, signal), retry: false });
  const [selected, setSelected] = useState<CostSourceLine>();
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected) { setError(new Error("Choose a QBO bill line.")); return; }
    let amountCents: string;
    try {
      amountCents = parseMoneyInput(amount, "Amount").cents;
      if (BigInt(amountCents) <= BigInt(0)) throw new Error("Amount must be greater than zero.");
      if (BigInt(amountCents) > BigInt(selected.availableCents)) throw new Error("The amount exceeds the unallocated balance of this line.");
    } catch (parseError) { setError(parseError); return; }
    setSaving(true); setError(undefined);
    try { await save("work_order.cost.link", detail.legalEntityId, { workOrderId: detail.id, source: selected.source, amountCents }, detail.recordRevision); onSaved(); }
    catch (saveError) { setError(saveError); } finally { setSaving(false); }
  };
  return <Dialog title="Link QBO bill line" subtitle={detail.reference} onClose={onClose} onSubmit={submit} saving={saving} submitLabel="Link cost">
    <Notice error={error ?? lines.error} />
    <label className="rm-search wo-search"><Search size={14} aria-hidden="true" /><input data-autofocus type="search" aria-label="Search QBO lines" placeholder="Description or document" value={search} onChange={event => setSearch(event.currentTarget.value)} /></label>
    <div className="wo-line-picker" role="radiogroup" aria-label="QBO bill lines">
      {lines.isLoading ? <div className="wo-state" role="status"><LoaderCircle size={16} className="wo-spin" />Loading QBO lines…</div>
        : !(lines.data?.items.length) ? <div className="wo-state"><strong>No unallocated bill lines</strong></div>
        : lines.data.items.map(item => <label key={lineKey(item.source)} className={`wo-line-option${selected && lineKey(selected.source) === lineKey(item.source) ? " is-selected" : ""}`}>
          <input type="radio" name="wo-cost-line" checked={!!selected && lineKey(selected.source) === lineKey(item.source)} onChange={() => { setSelected(item); setAmount(formatInputValue(item.availableCents)); }} />
          <span className="wo-line-option-main"><strong>{item.description ?? item.transactionType}</strong><small>{item.transactionType} · {dateLabel(item.postedOn, "long")}</small></span>
          <span className="wo-amount">{formatMoney(item.availableCents, item.currency)}</span>
        </label>)}
    </div>
    <Field label="Amount"><input inputMode="decimal" value={amount} onChange={event => setAmount(event.currentTarget.value)} placeholder="0.00" /></Field>
  </Dialog>;
}

function ManualActualDialog({ detail, onClose, onSaved, save }: { detail: WorkOrderDetail; onClose: () => void; onSaved: () => void; save: Save }) {
  const [amount, setAmount] = useState(detail.manualActual ? formatInputValue(detail.manualActual.amountCents) : "");
  const [note, setNote] = useState(detail.manualActual?.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    let amountCents: string;
    try { amountCents = parseMoneyInput(amount, "Amount").cents; if (BigInt(amountCents) < BigInt(0)) throw new Error("Amount cannot be negative."); } catch (parseError) { setError(parseError); return; }
    setSaving(true); setError(undefined);
    try { await save("work_order.actual.set", detail.legalEntityId, { workOrderId: detail.id, amountCents, note: note.trim() || null }, detail.recordRevision); onSaved(); }
    catch (saveError) { setError(saveError); } finally { setSaving(false); }
  };
  return <Dialog title="Manual actual cost" subtitle={detail.reference} onClose={onClose} onSubmit={submit} saving={saving} submitLabel="Save actual">
    <Notice error={error} />
    <div className="rm-form-grid">
      <Field label="Amount"><input data-autofocus inputMode="decimal" value={amount} onChange={event => setAmount(event.currentTarget.value)} placeholder="0.00" /></Field>
      <Field label="Note"><input value={note} maxLength={500} onChange={event => setNote(event.currentTarget.value)} /></Field>
    </div>
  </Dialog>;
}

function AttachmentDialog({ organizationId, detail, onClose, onSaved, save }: { organizationId: string; detail: WorkOrderDetail; onClose: () => void; onSaved: () => void; save: Save }) {
  const documents = useQuery({ queryKey: ["work-orders", "documents", organizationId, detail.legalEntityId, detail.propertyId], queryFn: ({ signal }) => workOrdersApi.documentOptions(organizationId, detail.legalEntityId, detail.propertyId, signal), retry: false });
  const attached = new Set(detail.attachments.map(item => item.documentId));
  const available = (documents.data ?? []).filter(item => !attached.has(item.documentId));
  const [documentId, setDocumentId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!documentId) { setError(new Error("Choose a document.")); return; }
    setSaving(true); setError(undefined);
    try { await save("work_order.attachment.link", detail.legalEntityId, { workOrderId: detail.id, documentId }, detail.recordRevision); onSaved(); }
    catch (saveError) { setError(saveError); } finally { setSaving(false); }
  };
  return <Dialog title="Attach document" subtitle={detail.reference} onClose={onClose} onSubmit={submit} saving={saving} submitLabel="Attach">
    <Notice error={error ?? documents.error} />
    <Field label="Document" wide><select data-autofocus value={documentId} onChange={event => setDocumentId(event.currentTarget.value)} disabled={documents.isLoading}>
      <option value="">{documents.isLoading ? "Loading documents…" : available.length ? "Choose document" : "No documents available"}</option>
      {available.map(item => <option key={item.documentId} value={item.documentId}>{item.title}{item.documentDate ? ` · ${dateLabel(item.documentDate, "long")}` : ""}</option>)}
    </select></Field>
  </Dialog>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="wo-fact"><dt>{label}</dt><dd>{children}</dd></div>;
}

function Detail({ detail, onDialog, onClearChargeback, clearing, onBack, onOpenProperty, onOpenUnit, onOpenTenant, onQuickAction }: {
  detail: WorkOrderDetail; onDialog: (state: DialogState) => void; onClearChargeback: () => void; clearing: boolean; onBack: () => void;
  onQuickAction: (kind: WorkOrderCommandKind, payload: Record<string, unknown>) => void;
  onOpenProperty?: (id: string) => void; onOpenUnit?: (id: string) => void; onOpenTenant?: (id: string) => void;
}) {
  const headingId = `wo-title-${detail.id}`;
  const history = [...detail.history].reverse();
  const link = (label: string, onOpen: (() => void) | undefined) => onOpen ? <button type="button" className="wo-link" onClick={onOpen}>{label}</button> : <span>{label}</span>;
  return <article className="wo-detail" aria-labelledby={headingId}>
    <button type="button" className="rm-button rm-button--ghost wo-back" onClick={onBack}><ChevronLeft size={16} />All work orders</button>
    <header className="wo-detail-header">
      <div className="wo-detail-heading">
        <span className="wo-overline">{detail.reference} · {categoryLabel(detail.category)}</span>
        <h2 id={headingId}>{detail.title}</h2>
        <div className="wo-badges"><StatusCapsule status={detail.status} /><PriorityCapsule priority={detail.priority} always />{detail.entryPermitted && <span className="rm-status rm-status--unknown"><DoorOpen size={12} aria-hidden="true" />Entry OK</span>}</div>
        <p className="wo-location">
          {link(detail.propertyName ?? detail.propertyId, onOpenProperty ? () => onOpenProperty(detail.propertyId) : undefined)}
          {detail.unitId && <>{" · "}{link(`Unit ${detail.unitNumber ?? detail.unitId}`, onOpenUnit ? () => onOpenUnit(detail.unitId!) : undefined)}</>}
          {detail.personId && <>{" · "}{link(detail.personName ?? "Tenant", onOpenTenant ? () => onOpenTenant(detail.personId!) : undefined)}</>}
        </p>
      </div>
      <div className="wo-actions" role="group" aria-label="Work order actions">
        <button type="button" className="rm-button" onClick={() => onDialog({ kind: "status" })} disabled={!detail.allowedTransitions.length}><CalendarClock size={15} />Change status</button>
        <button type="button" className="rm-button" onClick={() => onDialog({ kind: "edit" })}>Edit</button>
        <button type="button" className="rm-button" onClick={() => onDialog({ kind: "note" })}>Add note</button>
      </div>
    </header>
    {detail.description && <p className="wo-description">{detail.description}</p>}
    <section className="wo-section" aria-label="Details">
      <dl className="wo-facts">
        <Fact label="Reported">{dateLabel(detail.reportedOn, "long")}</Fact>
        <Fact label="Scheduled">{dateLabel(detail.scheduledOn, "long")}</Fact>
        <Fact label="Completed">{dateLabel(detail.completedOn, "long")}</Fact>
        <Fact label="Target">{dateLabel(detail.targetOn, "long")}{detail.status !== "completed" && detail.status !== "canceled" && <span className="wo-muted"> · {detail.agingDays} {detail.agingDays === 1 ? "day" : "days"} open</span>}</Fact>
        <Fact label="Assigned to">{detail.assignedTo ?? <span className="wo-muted">Unassigned</span>}</Fact>
        <Fact label="Vendor"><span className="wo-fact-action">{detail.vendor?.name ?? <span className="wo-muted">None</span>}<button type="button" className="rm-button rm-button--small rm-button--ghost" onClick={() => onDialog({ kind: "vendor" })}>{detail.vendor ? "Change" : "Assign"}</button></span></Fact>
        <Fact label="Project">{detail.projectName ?? <span className="wo-muted">None</span>}</Fact>
      </dl>
    </section>
    <section className="wo-section" aria-labelledby={`${headingId}-cost`}>
      <div className="wo-section-heading">
        <h3 id={`${headingId}-cost`}>Cost</h3>
        <div className="wo-inline-actions">
          <button type="button" className="rm-button rm-button--small" onClick={() => onDialog({ kind: "cost" })}><Link2 size={13} />Link QBO bill</button>
          <button type="button" className="rm-button rm-button--small rm-button--ghost" onClick={() => onDialog({ kind: "manual" })}>{detail.manualActual ? "Edit manual actual" : "Manual actual"}</button>
        </div>
      </div>
      <dl className="wo-facts">
        <Fact label="Estimate">{detail.estimatedCostCents ? formatMoney(detail.estimatedCostCents, detail.currency) : <span className="wo-muted">None</span>}</Fact>
        <Fact label="QBO actual">{detail.actualCost.linkedLineCount ? formatMoney(detail.actualCost.linkedCents, detail.currency) : <span className="wo-muted">None linked</span>}</Fact>
        <Fact label="Manual actual">{detail.manualActual ? <span className="wo-fact-action">{formatMoney(detail.manualActual.amountCents, detail.currency)}<span className="rm-status rm-status--warning">Draft</span><button type="button" className="rm-button rm-button--small rm-button--ghost" onClick={() => onQuickAction("work_order.actual.set", { workOrderId: detail.id, amountCents: null })}>Clear</button></span> : <span className="wo-muted">None</span>}</Fact>
      </dl>
      {detail.costLines.length > 0 && <ul className="wo-cost-lines">{detail.costLines.map(line => <li key={lineKey(line.source)}>
        <span className="wo-line-option-main"><strong>{line.description ?? line.transactionType ?? "QBO line"}</strong><small>{line.transactionType ?? line.source.objectType} {line.source.objectId} · {dateLabel(line.postedOn, "long")}{line.validity === "stale" ? " · changed in QBO" : ""}</small></span>
        <span className="wo-amount">{formatMoney(line.allocatedCents, line.currency)}</span>
        <button type="button" className="rm-button rm-button--small rm-button--ghost" onClick={() => onQuickAction("work_order.cost.unlink", { workOrderId: detail.id, source: line.source })}>Release</button>
      </li>)}</ul>}
    </section>
    <section className="wo-section" aria-labelledby={`${headingId}-files`}>
      <div className="wo-section-heading"><h3 id={`${headingId}-files`}>Documents</h3><div className="wo-inline-actions"><button type="button" className="rm-button rm-button--small" onClick={() => onDialog({ kind: "attachment" })}><FileText size={13} />Attach</button></div></div>
      {detail.attachments.length ? <ul className="wo-cost-lines">{detail.attachments.map(item => <li key={item.documentId}>
        <span className="wo-line-option-main"><strong>{item.title}</strong><small>{item.kind.replace(/_/g, " ").replace(/^\w/, letter => letter.toUpperCase())}{item.documentDate ? ` · ${dateLabel(item.documentDate, "long")}` : ""}{item.available ? "" : " · archived"}</small></span>
        <button type="button" className="rm-button rm-button--small rm-button--ghost" onClick={() => onQuickAction("work_order.attachment.unlink", { workOrderId: detail.id, documentId: item.documentId })}>Remove</button>
      </li>)}</ul> : <p className="wo-muted wo-empty-line">No documents attached.</p>}
    </section>
    <section className="wo-section" aria-labelledby={`${headingId}-chargeback`}>
      <div className="wo-section-heading">
        <h3 id={`${headingId}-chargeback`}>Tenant chargeback</h3>
        {(detail.personId || detail.tenancyId) && <div className="wo-inline-actions">
          <button type="button" className="rm-button rm-button--small" onClick={() => onDialog({ kind: "chargeback" })}>{detail.chargeback ? "Edit" : "Record"}</button>
          {detail.chargeback && <button type="button" className="rm-button rm-button--small rm-button--ghost" onClick={onClearChargeback} disabled={clearing}>{clearing ? "Clearing…" : "Clear"}</button>}
        </div>}
      </div>
      {detail.chargeback ? <div className="wo-chargeback">
        <strong className="wo-amount">{formatMoney(detail.chargeback.amountCents, detail.currency)}</strong>
        <span>{detail.chargeback.description}</span>
        <span className={detail.chargeback.state === "charge_linked" ? "rm-status rm-status--success" : "rm-status rm-status--warning"}>{detail.chargeback.state === "charge_linked" ? `Posted charge ${detail.chargeback.ledgerTransactionId}` : "Intent only · not posted"}</span>
      </div> : <p className="wo-muted wo-empty-line">{detail.personId || detail.tenancyId ? "No chargeback recorded." : "Link a tenant to record a chargeback."}</p>}
    </section>
    <section className="wo-section" aria-labelledby={`${headingId}-activity`}>
      <div className="wo-section-heading"><h3 id={`${headingId}-activity`}>Activity</h3><span className="wo-muted">{detail.history.length} {detail.history.length === 1 ? "entry" : "entries"}</span></div>
      <ol className="wo-timeline">
        {history.map(event => <li key={event.id} className={`wo-event wo-event--${event.type}`}>
          <span className="wo-event-dot" aria-hidden="true" />
          <div className="wo-event-body">
            <span className="wo-event-summary">{eventSummary(event)}</span>
            {event.note && <p className="wo-event-note">{event.note}</p>}
            <span className="wo-event-meta">{timestampLabel(event.createdAt)} · {event.actorId}</span>
          </div>
        </li>)}
      </ol>
    </section>
  </article>;
}

/** Work orders list/detail workspace inside the existing manager shell. */
export function WorkOrdersWorkspace(props: WorkOrdersWorkspaceProps) {
  const { organizationId, entities, view, selectedId, createRequest, onSelect, onViewChange } = props;
  const client = useQueryClient();
  const choices = useMemo(() => propertyChoices(entities), [entities]);
  const [priority, setPriority] = useState<WorkOrderPriority | "">("");
  const [propertyKey, setPropertyKey] = useState("");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [clearing, setClearing] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
  const pending = useRef(new PendingEnvelopes<WorkOrderCommandEnvelope>());
  useEffect(() => {
    // The request counter outlives this component, so a request made while
    // navigating here opens the form once, even though the page just mounted.
    if (createRequest !== undefined && createRequest > handledCreateRequest) { handledCreateRequest = createRequest; setDialog({ kind: "create" }); }
  }, [createRequest]);

  const [filterEntityId, filterPropertyId] = propertyKey ? propertyKey.split("|") : [undefined, undefined];
  const listFilters = {
    openOnly: view === "open" || view === "schedule",
    ...(view === "schedule" ? { statuses: ["scheduled", "in_progress"] as WorkOrderStatus[] } : view !== "open" && view !== "all" ? { statuses: [view] } : {}),
    ...(priority ? { priority } : {}),
    ...(filterEntityId ? { legalEntityId: filterEntityId, propertyId: filterPropertyId } : {}),
    search: debouncedSearch,
  };
  const list = useQuery({
    queryKey: ["work-orders", "list", organizationId, listFilters],
    queryFn: ({ signal }) => workOrdersApi.list(organizationId, listFilters, signal),
    staleTime: 10_000, retry: false, placeholderData: previous => previous,
  });
  const items: readonly WorkOrderSummary[] = list.data?.items ?? [];
  useEffect(() => {
    if (!selectedId && !list.isPlaceholderData && items[0] && window.matchMedia?.("(min-width: 901px)").matches) onSelect(items[0].id, true);
  }, [selectedId, items, onSelect, list.isPlaceholderData]);
  const detail = useQuery({
    queryKey: ["work-orders", "detail", organizationId, selectedId],
    queryFn: ({ signal }) => workOrdersApi.get(organizationId, selectedId!, signal),
    enabled: Boolean(selectedId), retry: false,
  });

  const refresh = useCallback(async () => {
    await client.invalidateQueries({ queryKey: ["work-orders", "list", organizationId] });
    if (selectedId) await client.invalidateQueries({ queryKey: ["work-orders", "detail", organizationId, selectedId] });
  }, [client, organizationId, selectedId]);

  const save: Save = useCallback(async (kind, legalEntityId, payload, expectedRevision) => {
    const key = PendingEnvelopes.key(kind, payload, expectedRevision);
    const envelope = pending.current.envelopeFor(key, () => workOrderEnvelope(organizationId, legalEntityId, payload, expectedRevision));
    try {
      const receipt = await workOrdersApi.command(organizationId, kind, envelope);
      pending.current.settle(key);
      if (kind === "work_order.create") {
        const id = String(receipt.affectedRecordIds[0]);
        await client.invalidateQueries({ queryKey: ["work-orders", "list", organizationId] });
        onSelect(id);
      }
      return revisionFrom(receipt);
    } catch (error) {
      if (!(error instanceof WorkOrderApiError && error.uncertain)) pending.current.settle(key);
      if (error instanceof WorkOrderApiError && error.conflict) void refresh();
      throw error;
    }
  }, [client, onSelect, organizationId, refresh]);

  const closeDialog = useCallback(() => setDialog(null), []);
  const afterSave = useCallback(() => { setDialog(null); void refresh(); }, [refresh]);
  const quickAction = async (kind: WorkOrderCommandKind, payload: Record<string, unknown>) => {
    if (!detail.data) return;
    setActionError(undefined);
    try { await save(kind, detail.data.legalEntityId, payload, detail.data.recordRevision); await refresh(); }
    catch (error) { setActionError(error); }
  };
  const clearChargeback = async () => {
    if (!detail.data) return;
    setClearing(true); setActionError(undefined);
    try { await save("work_order.chargeback.clear", detail.data.legalEntityId, { workOrderId: detail.data.id }, detail.data.recordRevision); await refresh(); }
    catch (error) { setActionError(error); } finally { setClearing(false); }
  };

  const openCount = view === "open" ? items.length : undefined;
  const emergencyCount = items.filter(item => item.priority === "emergency" && (item.status !== "completed" && item.status !== "canceled")).length;
  const current = detail.data && detail.data.id === selectedId ? detail.data : undefined;

  return <div className="wo-workspace">
    <header className="wo-page-header">
      <div>
        <h1>Work orders</h1>
        <p className="wo-subtitle" aria-live="polite">{list.isLoading ? "Loading…" : openCount !== undefined ? `${openCount}${list.data?.nextCursor ? "+" : ""} open${emergencyCount ? ` · ${emergencyCount} emergency` : ""}` : `${items.length}${list.data?.nextCursor ? "+" : ""} ${VIEW_LABELS[view].toLowerCase()}`}</p>
      </div>
      <button type="button" className="rm-button rm-button-primary" onClick={() => setDialog({ kind: "create" })} disabled={!choices.length}><Plus size={15} />New work order</button>
    </header>
    <div className="wo-filters">
      <div className="wo-chips" role="group" aria-label="Status">
        {WORK_ORDER_VIEWS.map(item => <button key={item} type="button" aria-pressed={view === item} className={`wo-chip${view === item ? " is-selected" : ""}`} onClick={() => { onViewChange(item); }}>{VIEW_LABELS[item]}</button>)}
      </div>
      <div className="wo-filter-row">
        <label className="rm-search wo-search"><Search size={14} aria-hidden="true" /><input type="search" aria-label="Search work orders" placeholder="Title, unit, tenant, vendor or WO number" value={search} onChange={event => setSearch(event.currentTarget.value)} /></label>
        <label className="wo-select"><span className="wo-sr-only">Priority</span>
          <select aria-label="Priority" value={priority} onChange={event => setPriority(event.currentTarget.value as WorkOrderPriority | "")}>
            <option value="">All priorities</option>
            {WORK_ORDER_PRIORITIES.map(value => <option key={value} value={value}>{PRIORITY_LABELS[value]}</option>)}
          </select>
        </label>
        <label className="wo-select"><span className="wo-sr-only">Property</span>
          <select aria-label="Property" value={propertyKey} onChange={event => setPropertyKey(event.currentTarget.value)}>
            <option value="">All properties</option>
            {choices.map(item => <option key={`${item.entityId}|${item.propertyId}`} value={`${item.entityId}|${item.propertyId}`}>{item.name}</option>)}
          </select>
        </label>
      </div>
    </div>
    <div className={`rm-record-layout wo-layout${selectedId ? " is-detail" : ""}`}>
      <section className="rm-record-list wo-list" aria-label="Work orders">
        {list.error ? <Notice error={list.error} onRetry={() => void list.refetch()} />
          : list.isLoading ? <div className="wo-state" role="status"><LoaderCircle size={16} className="wo-spin" />Loading work orders…</div>
          : !items.length ? <div className="wo-state"><Wrench size={20} aria-hidden="true" /><strong>No work orders</strong><span>{search || priority || propertyKey ? "Nothing matches these filters." : view === "open" ? "Nothing open right now." : "Nothing in this view."}</span></div>
          : <div className="rm-record-list-items wo-list-items">
            {(view === "schedule" ? scheduleOrder(items) : items.map(item => ({ item, heading: undefined as string | undefined }))).map(({ item, heading }) => <Fragment key={item.id}>{heading && <h3 className="wo-day-heading">{heading}</h3>}<button key={item.id} type="button" className={`rm-record-list-item wo-list-item${item.id === selectedId ? " active" : ""}`} aria-current={item.id === selectedId ? "true" : undefined} onClick={() => onSelect(item.id)}>
              <span className="wo-list-item-top"><strong className="rm-record-list-item-title">{item.title}</strong><PriorityCapsule priority={item.priority} /></span>
              <span className="rm-record-list-item-meta">{item.propertyName ?? item.propertyId}{item.unitNumber ? ` · Unit ${item.unitNumber}` : ""}{item.personName ? ` · ${item.personName}` : ""}</span>
              <span className="wo-list-item-foot"><StatusCapsule status={item.status} /><small>{item.reference} · {item.status === "scheduled" && item.scheduledOn ? `Scheduled ${dateLabel(item.scheduledOn)}` : item.status === "completed" && item.completedOn ? `Done ${dateLabel(item.completedOn)}` : `Reported ${dateLabel(item.reportedOn)}`}{item.vendor ? ` · ${item.vendor.name}` : ""}</small></span>
            </button></Fragment>)}
          </div>}
      </section>
      <div className="rm-record-detail wo-detail-pane">
        <Notice error={actionError} />
        {!selectedId ? <div className="wo-state wo-detail-empty"><Wrench size={22} aria-hidden="true" /><span>Select a work order to see its details and history.</span></div>
          : detail.error ? <Notice error={detail.error} onRetry={() => void detail.refetch()} />
          : !current ? <div className="wo-state" role="status"><LoaderCircle size={16} className="wo-spin" />Loading work order…</div>
          : <Detail detail={current} onDialog={setDialog} onClearChargeback={() => void clearChargeback()} clearing={clearing} onBack={() => onSelect(undefined)} onOpenProperty={props.onOpenProperty} onOpenUnit={props.onOpenUnit} onOpenTenant={props.onOpenTenant} onQuickAction={(kind, payload) => void quickAction(kind, payload)} />}
      </div>
    </div>
    {dialog?.kind === "create" && <EditDialog organizationId={organizationId} choices={choices} onClose={closeDialog} onSaved={() => setDialog(null)} save={save} />}
    {dialog?.kind === "edit" && current && <EditDialog organizationId={organizationId} detail={current} choices={choices} onClose={closeDialog} onSaved={afterSave} save={save} />}
    {dialog?.kind === "status" && current && <StatusDialog detail={current} initial={dialog.to} onClose={closeDialog} onSaved={afterSave} save={save} />}
    {dialog?.kind === "note" && current && <NoteDialog detail={current} onClose={closeDialog} onSaved={afterSave} save={save} />}
    {dialog?.kind === "chargeback" && current && <ChargebackDialog detail={current} onClose={closeDialog} onSaved={afterSave} save={save} />}
    {dialog?.kind === "vendor" && current && <VendorDialog organizationId={organizationId} detail={current} onClose={closeDialog} onSaved={afterSave} save={save} />}
    {dialog?.kind === "cost" && current && <CostLinkDialog organizationId={organizationId} detail={current} onClose={closeDialog} onSaved={afterSave} save={save} />}
    {dialog?.kind === "manual" && current && <ManualActualDialog detail={current} onClose={closeDialog} onSaved={afterSave} save={save} />}
    {dialog?.kind === "attachment" && current && <AttachmentDialog organizationId={organizationId} detail={current} onClose={closeDialog} onSaved={afterSave} save={save} />}
  </div>;
}

export default WorkOrdersWorkspace;
