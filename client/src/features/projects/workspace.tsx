import { cloneElement, isValidElement, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from "react";
import { Archive, CalendarDays, Check, CircleAlert, FolderKanban, ListChecks, LoaderCircle, Pencil, Plus, Search, WalletCards, X } from "lucide-react";
import { createProjectsApi, ProjectRevisionConflictError } from "./api";
import { formatInputValue, formatMoney, parseMoneyInput } from "./money";
import { PendingProjectCommandError, PendingProjectCommandStore } from "./pending-command";
import type {
  CostControlFormValues,
  ProjectCommandKind,
  ProjectCommandEnvelope,
  ProjectCostControl,
  ProjectDetail,
  ProjectFormValues,
  ProjectListFilters,
  ProjectScopeLine,
  ProjectStatus,
  ProjectSummary,
  ProjectTask,
  ProjectTaskStatus,
  ProjectType,
  ProjectWorkspaceEntity,
  ProjectWorkspaceProps,
  ProjectTab,
  ProjectsApi,
  ScopeLineFormValues,
  TaskFormValues,
} from "./types";
import { PROJECT_STATUSES, PROJECT_TASK_STATUSES, PROJECT_TYPES } from "@shared/projects";
import type { CompanyScope } from "@shared/company/scope";
import { Dialog } from "@/components/ui/dialog";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import "./projects.css";

type Tab = ProjectTab;
type EditorState =
  | { kind: "project"; mode: "create" | "edit"; project?: ProjectDetail }
  | { kind: "scope"; mode: "create" | "edit"; line?: ProjectScopeLine }
  | { kind: "task"; mode: "create" | "edit"; task?: ProjectTask }
  | { kind: "cost"; mode: "create" | "edit"; cost?: ProjectCostControl };

const STATUS_LABELS: Record<ProjectStatus, string> = { planning: "Planning", active: "Active", on_hold: "On hold", completed: "Completed", archived: "Archived" };
const TYPE_LABELS: Record<ProjectType, string> = { flip: "Flip", unit_turn: "Unit turn", rehab: "Rehab", common_area: "Common area", stabilization: "Stabilization", administrative: "Administrative" };
const TASK_STATUS_LABELS: Record<ProjectTaskStatus, string> = { not_started: "Not started", in_progress: "In progress", blocked: "Blocked", completed: "Completed", cancelled: "Cancelled" };

function labelFor(value: string | null | undefined): string { return value ? value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "—"; }
function dateLabel(value: string | null | undefined): string { if (!value) return "—"; const date = new Date(value.length === 10 ? `${value}T00:00:00` : value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date); }
function statusClass(status: string): string { return status === "active" || status === "completed" ? "is-positive" : status === "blocked" || status === "on_hold" ? "is-warning" : status === "archived" || status === "cancelled" ? "is-muted" : ""; }

function LoadingState({ label = "Loading projects…" }: { label?: string }) { return <div className="projects-state" role="status"><LoaderCircle size={18} className="projects-spin" /><span>{label}</span></div>; }
function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) { return <div className="projects-error" role="alert"><CircleAlert size={18} /><span>{message}</span>{onRetry && <button className="projects-button projects-button-secondary" onClick={onRetry}>Try again</button>}</div>; }
function EmptyState({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) { return <div className="projects-state projects-empty"><FolderKanban size={22} /><strong>{title}</strong>{action && onAction && <button className="projects-button projects-button-secondary" onClick={onAction}>{action}</button>}</div>; }
function StatusBadge({ status }: { status: string }) { return <span className={`projects-status ${statusClass(status)}`}>{labelFor(status)}</span>; }
function entityName(entities: readonly ProjectWorkspaceEntity[], id: string | undefined): string { return id ? entities.find((entity) => entity.id === id)?.name ?? "Entity unavailable" : "—"; }
function propertyName(entities: readonly ProjectWorkspaceEntity[], entityId: string | undefined, propertyId: string | undefined): string { if (!propertyId) return "—"; return entities.find((entity) => entity.id === entityId)?.properties.find((property) => property.id === propertyId)?.name ?? "Property unavailable"; }
function entityFor(entities: readonly ProjectWorkspaceEntity[], id: string): ProjectWorkspaceEntity | undefined { return entities.find((entity) => entity.id === id); }
function propertyFor(entities: readonly ProjectWorkspaceEntity[], entityId: string, id: string): ProjectWorkspaceEntity["properties"][number] | undefined { return entityFor(entities, entityId)?.properties.find((property) => property.id === id); }
function scopeForProject(organizationId: string, project: Pick<ProjectSummary, "legalEntityId" | "propertyId">): CompanyScope { return { organizationId: organizationId as CompanyScope["organizationId"], legalEntityId: project.legalEntityId, propertyId: project.propertyId }; }
function parseNonNegativeMoney(value: string, label: string): string | undefined { const parsed = value.trim() ? parseMoneyInput(value, label).cents : undefined; if (parsed !== undefined && BigInt(parsed) < BigInt(0)) throw new Error(`${label} cannot be negative.`); return parsed; }
function parseRequiredNonNegativeMoney(value: string, label: string): string { const parsed = parseNonNegativeMoney(value, label); if (parsed === undefined) throw new Error(`${label} is required.`); return parsed; }

function projectDefaults(project: ProjectDetail | undefined, entities: readonly ProjectWorkspaceEntity[]): ProjectFormValues {
  const entityId = project?.legalEntityId ?? entities[0]?.id ?? "";
  const firstProperty = entityFor(entities, entityId)?.properties[0];
  return { name: project?.name ?? "", description: project?.description ?? "", projectType: project?.projectType ?? "rehab", status: project?.status ?? "planning", legalEntityId: entityId, propertyId: project?.propertyId ?? firstProperty?.id ?? "", unitId: project?.unitId ?? "", startOn: project?.startOn ?? "", targetOn: project?.targetOn ?? "" };
}
function scopeDefaults(line: ProjectScopeLine | undefined): ScopeLineFormValues { return { description: line?.description ?? "", category: line?.category ?? "", unitLabel: line?.unitLabel ?? "", quantity: line?.quantity ?? "1", rate: line?.rateCents === undefined ? "" : formatInputValue(line.rateCents) }; }
function taskDefaults(task: ProjectTask | undefined): TaskFormValues { return { title: task?.title ?? "", description: task?.description ?? "", status: task?.status ?? "not_started", startsOn: task?.startsOn ?? "", dueOn: task?.dueOn ?? "", completedOn: task?.completedOn ?? "", dependencyTaskIds: [...(task?.dependencyTaskIds ?? [])] }; }
function costDefaults(cost: ProjectCostControl | undefined): CostControlFormValues { return { vendorName: cost?.vendorName ?? "", description: cost?.description ?? "", amount: cost?.amountCents === undefined ? "" : formatInputValue(cost.amountCents), incurredOn: cost?.incurredOn ?? new Date().toISOString().slice(0, 10), scopeItemId: cost?.scopeItemId ?? "" }; }

function DialogShell({ eyebrow, title, children, footer, onClose, labelledBy, saving }: { eyebrow: string; title: string; children: ReactNode; footer: ReactNode; onClose: () => void; labelledBy: string; saving: boolean }) {
  return <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}><DialogPrimitive.Portal><DialogPrimitive.Overlay className="projects-dialog-overlay" /><DialogPrimitive.Content className="projects-dialog" aria-labelledby={labelledBy} aria-busy={saving} onEscapeKeyDown={(event) => { if (saving) event.preventDefault(); }} onPointerDownOutside={(event) => { if (saving) event.preventDefault(); }}><header className="projects-dialog-header"><div><span className="projects-eyebrow">{eyebrow}</span><DialogPrimitive.Title asChild><h2 id={labelledBy}>{title}</h2></DialogPrimitive.Title></div><DialogPrimitive.Close className="projects-dialog-close" aria-label="Close"><X size={18} /><span className="projects-sr-only">Close</span></DialogPrimitive.Close></header><fieldset className="projects-dialog-fieldset" disabled={saving}>{children}</fieldset><footer className="projects-dialog-footer">{footer}</footer></DialogPrimitive.Content></DialogPrimitive.Portal></Dialog>;
}

function Conflict({ error, onReload }: { error: unknown; onReload: () => void }) { return error instanceof ProjectRevisionConflictError ? <div className="projects-conflict" role="alert"><CircleAlert size={18} /><div><strong>Revision conflict</strong><p>{error.message}</p><button className="projects-button projects-button-secondary" type="button" onClick={onReload}>Reload latest</button></div></div> : null; }
function MutationError({ error, fallback, onRetryPending }: { error: unknown; fallback: string; onRetryPending?: () => void }) { if (!error || error instanceof ProjectRevisionConflictError) return null; if (onRetryPending) return <div className="projects-error" role="alert"><CircleAlert size={18} /><span>{error instanceof Error ? error.message : fallback}</span><button className="projects-button projects-button-secondary" type="button" onClick={onRetryPending}>Retry pending save</button></div>; return <ErrorState message={error instanceof Error ? error.message : fallback} />; }
function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) { const fieldId = `projects-field-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`; const control = isValidElement(children) ? cloneElement(children as ReactElement<{ id?: string }>, { id: fieldId }) : children; return <div className={`projects-field ${wide ? "projects-field-wide" : ""}`}><label htmlFor={fieldId}>{label}</label>{control}</div>; }

function ProjectEditor({ mode, project, entities, error, saving, onClose, onSave, onReload, onRetryPending }: { mode: "create" | "edit"; project?: ProjectDetail; entities: readonly ProjectWorkspaceEntity[]; error?: unknown; saving: boolean; onClose: () => void; onSave: (values: ProjectFormValues) => void; onReload: () => void; onRetryPending?: () => void }) {
  const [values, setValues] = useState(() => projectDefaults(project, entities));
  const [formError, setFormError] = useState<string>();
  const selectedEntity = entityFor(entities, values.legalEntityId);
  const selectedProperty = propertyFor(entities, values.legalEntityId, values.propertyId);
  const update = <K extends keyof ProjectFormValues>(key: K, value: ProjectFormValues[K]) => setValues((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => { event.preventDefault(); if (!values.name.trim()) { setFormError("Project name is required."); return; } if (!values.legalEntityId || !selectedEntity) { setFormError("Choose an available legal entity."); return; } if (!values.propertyId || !selectedProperty) { setFormError("Choose an available property."); return; } setFormError(undefined); onSave(values); };
  return <DialogShell eyebrow="Projects" title={mode === "create" ? "New project" : "Edit project"} labelledBy="project-editor-title" onClose={onClose} saving={saving} footer={<><button type="button" className="projects-button projects-button-secondary" onClick={onClose} disabled={saving}>Cancel</button><button form="project-editor-form" type="submit" className="projects-button projects-button-primary" disabled={saving}>{saving ? "Saving…" : "Save project"}</button></>}><form id="project-editor-form" onSubmit={submit}><div className="projects-dialog-body"><Conflict error={error} onReload={onReload} /><MutationError error={error} fallback="Project could not be saved." onRetryPending={onRetryPending} />{formError && <ErrorState message={formError} />}<Field label="Name" wide><input autoFocus value={values.name} onChange={(event) => update("name", event.currentTarget.value)} /></Field><div className="projects-form-grid"><Field label="Legal entity"><select value={values.legalEntityId} onChange={(event) => { update("legalEntityId", event.currentTarget.value); update("propertyId", ""); update("unitId", ""); }}><option value="">Choose entity</option>{entities.map((entity) => <option value={entity.id} key={entity.id}>{entity.name}</option>)}</select></Field><Field label="Property"><select value={values.propertyId} onChange={(event) => { update("propertyId", event.currentTarget.value); update("unitId", ""); }} disabled={!selectedEntity}><option value="">Choose property</option>{selectedEntity?.properties.map((property) => <option value={property.id} key={property.id}>{property.name}</option>)}</select></Field><Field label="Unit (optional)"><select value={values.unitId} onChange={(event) => update("unitId", event.currentTarget.value)} disabled={!selectedProperty}><option value="">Whole property</option>{selectedProperty?.units.map((unit) => <option value={unit.id} key={unit.id}>{unit.unitNumber}</option>)}</select></Field><Field label="Type"><select value={values.projectType} onChange={(event) => update("projectType", event.currentTarget.value as ProjectType)}>{PROJECT_TYPES.map((type) => <option value={type} key={type}>{TYPE_LABELS[type]}</option>)}</select></Field><Field label="Status"><select value={values.status} onChange={(event) => update("status", event.currentTarget.value as ProjectStatus)}>{PROJECT_STATUSES.filter((status) => status !== "archived").map((status) => <option value={status} key={status}>{STATUS_LABELS[status]}</option>)}</select></Field><Field label="Start date"><input type="date" value={values.startOn} onChange={(event) => update("startOn", event.currentTarget.value)} /></Field><Field label="Target date"><input type="date" value={values.targetOn} onChange={(event) => update("targetOn", event.currentTarget.value)} /></Field></div><Field label="Description" wide><textarea rows={4} value={values.description} onChange={(event) => update("description", event.currentTarget.value)} /></Field></div></form></DialogShell>;
}

function ScopeEditor({ line, project, error, saving, onClose, onSave, onReload, onRetryPending }: { line?: ProjectScopeLine; project: ProjectDetail; error?: unknown; saving: boolean; onClose: () => void; onSave: (values: ScopeLineFormValues) => void; onReload: () => void; onRetryPending?: () => void }) {
  const [values, setValues] = useState(() => scopeDefaults(line));
  const [formError, setFormError] = useState<string>();
  const update = <K extends keyof ScopeLineFormValues>(key: K, value: ScopeLineFormValues[K]) => setValues((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => { event.preventDefault(); try { if (!values.description.trim()) throw new Error("Scope description is required."); parseRequiredNonNegativeMoney(values.rate, "Rate"); if (!/^\d+(?:\.\d{0,12})?$/.test(values.quantity.trim())) throw new Error("Quantity must be a non-negative decimal."); setFormError(undefined); onSave(values); } catch (nextError) { setFormError(nextError instanceof Error ? nextError.message : "Enter valid scope values."); } };
  return <DialogShell eyebrow="Scope & budget" title={line ? "Edit scope item" : "Add scope item"} labelledBy="scope-editor-title" onClose={onClose} saving={saving} footer={<><button type="button" className="projects-button projects-button-secondary" onClick={onClose} disabled={saving}>Cancel</button><button form="scope-editor-form" type="submit" className="projects-button projects-button-primary" disabled={saving}>{saving ? "Saving…" : "Save scope item"}</button></>}><form id="scope-editor-form" onSubmit={submit}><div className="projects-dialog-body"><Conflict error={error} onReload={onReload} /><MutationError error={error} fallback="Scope item could not be saved." onRetryPending={onRetryPending} />{formError && <ErrorState message={formError} />}<Field label="Description" wide><input autoFocus value={values.description} onChange={(event) => update("description", event.currentTarget.value)} /></Field><div className="projects-form-grid"><Field label="Category"><input value={values.category} onChange={(event) => update("category", event.currentTarget.value)} /></Field><Field label="Unit label"><input value={values.unitLabel} onChange={(event) => update("unitLabel", event.currentTarget.value)} /></Field><Field label="Quantity"><input inputMode="decimal" value={values.quantity} onChange={(event) => update("quantity", event.currentTarget.value)} /></Field><Field label="Rate"><input inputMode="decimal" value={values.rate} onChange={(event) => update("rate", event.currentTarget.value)} placeholder="0.00" /></Field></div></div></form></DialogShell>;
}

function TaskEditor({ task, project, error, saving, onClose, onSave, onReload, onRetryPending }: { task?: ProjectTask; project: ProjectDetail; error?: unknown; saving: boolean; onClose: () => void; onSave: (values: TaskFormValues) => void; onReload: () => void; onRetryPending?: () => void }) {
  const [values, setValues] = useState(() => taskDefaults(task));
  const [formError, setFormError] = useState<string>();
  const update = <K extends keyof TaskFormValues>(key: K, value: TaskFormValues[K]) => setValues((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => { event.preventDefault(); if (!values.title.trim()) { setFormError("Task title is required."); return; } if (values.status === "completed" && !values.completedOn) { setFormError("Completed tasks need a completion date."); return; } setFormError(undefined); onSave(values); };
  const dependencyOptions = project.tasks.filter((candidate) => !candidate.archivedAt && candidate.id !== task?.id);
  return <DialogShell eyebrow="Schedule" title={task ? "Edit task" : "Add task"} labelledBy="task-editor-title" onClose={onClose} saving={saving} footer={<><button type="button" className="projects-button projects-button-secondary" onClick={onClose} disabled={saving}>Cancel</button><button form="task-editor-form" type="submit" className="projects-button projects-button-primary" disabled={saving}>{saving ? "Saving…" : "Save task"}</button></>}><form id="task-editor-form" onSubmit={submit}><div className="projects-dialog-body"><Conflict error={error} onReload={onReload} /><MutationError error={error} fallback="Task could not be saved." onRetryPending={onRetryPending} />{formError && <ErrorState message={formError} />}<Field label="Title" wide><input autoFocus value={values.title} onChange={(event) => update("title", event.currentTarget.value)} /></Field><Field label="Description" wide><textarea rows={3} value={values.description} onChange={(event) => update("description", event.currentTarget.value)} /></Field><div className="projects-form-grid"><Field label="Status"><select value={values.status} onChange={(event) => update("status", event.currentTarget.value as ProjectTaskStatus)}>{PROJECT_TASK_STATUSES.map((status) => <option value={status} key={status}>{TASK_STATUS_LABELS[status]}</option>)}</select></Field><Field label="Starts"><input type="date" value={values.startsOn} onChange={(event) => update("startsOn", event.currentTarget.value)} /></Field><Field label="Due"><input type="date" value={values.dueOn} onChange={(event) => update("dueOn", event.currentTarget.value)} /></Field><Field label="Completed"><input type="date" value={values.completedOn} onChange={(event) => update("completedOn", event.currentTarget.value)} /></Field><Field label="Dependencies" wide><select multiple size={Math.min(5, Math.max(2, dependencyOptions.length))} value={values.dependencyTaskIds} onChange={(event) => update("dependencyTaskIds", Array.from(event.currentTarget.selectedOptions, (option) => option.value))}>{dependencyOptions.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.title}</option>)}</select></Field></div></div></form></DialogShell>;
}

function CostEditor({ cost, project, error, saving, onClose, onSave, onReload, onRetryPending }: { cost?: ProjectCostControl; project: ProjectDetail; error?: unknown; saving: boolean; onClose: () => void; onSave: (values: CostControlFormValues) => void; onReload: () => void; onRetryPending?: () => void }) {
  const [values, setValues] = useState(() => costDefaults(cost));
  const [formError, setFormError] = useState<string>();
  const update = <K extends keyof CostControlFormValues>(key: K, value: CostControlFormValues[K]) => setValues((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => { event.preventDefault(); try { if (!values.description.trim()) throw new Error("Cost description is required."); parseRequiredNonNegativeMoney(values.amount, "Amount"); if (!/^\d{4}-\d{2}-\d{2}$/.test(values.incurredOn)) throw new Error("Incurred date is required."); setFormError(undefined); onSave(values); } catch (nextError) { setFormError(nextError instanceof Error ? nextError.message : "Enter valid draft cost values."); } };
  return <DialogShell eyebrow="Costs" title={cost ? "Edit draft cost" : "Add draft cost"} labelledBy="cost-editor-title" onClose={onClose} saving={saving} footer={<><button type="button" className="projects-button projects-button-secondary" onClick={onClose} disabled={saving}>Cancel</button><button form="cost-editor-form" type="submit" className="projects-button projects-button-primary" disabled={saving}>{saving ? "Saving…" : "Save draft cost"}</button></>}><form id="cost-editor-form" onSubmit={submit}><div className="projects-dialog-body"><Conflict error={error} onReload={onReload} /><MutationError error={error} fallback="Draft cost could not be saved." onRetryPending={onRetryPending} />{formError && <ErrorState message={formError} />}<Field label="Description" wide><input autoFocus value={values.description} onChange={(event) => update("description", event.currentTarget.value)} /></Field><div className="projects-form-grid"><Field label="Vendor"><input value={values.vendorName} onChange={(event) => update("vendorName", event.currentTarget.value)} /></Field><Field label="Amount"><input inputMode="decimal" value={values.amount} onChange={(event) => update("amount", event.currentTarget.value)} placeholder="0.00" /></Field><Field label="Incurred date"><input type="date" value={values.incurredOn} onChange={(event) => update("incurredOn", event.currentTarget.value)} /></Field><Field label="Scope item"><select value={values.scopeItemId} onChange={(event) => update("scopeItemId", event.currentTarget.value)}><option value="">Unassigned</option>{project.scopeItems.filter((item) => !item.archivedAt).map((item) => <option value={item.id} key={item.id}>{item.description}</option>)}</select></Field></div></div></form></DialogShell>;
}

function MetricStrip({ project }: { project: ProjectDetail }) {
  const remaining = project.approvedBudgetCents !== null && project.postedActualCents !== null && project.postedActualCents !== undefined ? (BigInt(project.approvedBudgetCents) - BigInt(project.postedActualCents)).toString() : undefined;
  return <div className="projects-metrics"><div><span>Approved budget</span><strong>{formatMoney(project.approvedBudgetCents ?? undefined, project.currency)}</strong></div><div><span>QBO actual</span><strong>{formatMoney(project.postedActualCents ?? undefined, project.currency)}</strong></div><div><span>Remaining</span><strong>{formatMoney(remaining, project.currency)}</strong></div><div><span>Draft costs</span><strong>{formatMoney(project.draftCostCents, project.currency)}</strong></div></div>;
}

function actualForScope(project: ProjectDetail, scopeItemId: string): string | undefined { let total = BigInt(0); let found = false; for (const actual of project.postedActuals) if (actual.scopeItemId === scopeItemId) { total += BigInt(actual.amountCents); found = true; } return found ? total.toString() : undefined; }
function currentBudget(project: ProjectDetail) { return [...project.budgetVersions].sort((a, b) => b.versionNo - a.versionNo)[0]; }
function approvedForScope(project: ProjectDetail, scopeItemId: string): string | undefined { const version = project.budgetVersions.filter((candidate) => candidate.status === "approved").sort((a, b) => b.versionNo - a.versionNo)[0]; return version?.lines.find((item) => item.scopeItemId === scopeItemId)?.estimatedCents; }

function ScopeTable({ project, onAdd, onEdit, onArchive, onApprove, readOnly }: { project: ProjectDetail; onAdd: () => void; onEdit: (line: ProjectScopeLine) => void; onArchive: (line: ProjectScopeLine) => void; onApprove: () => void; readOnly: boolean }) {
  const lines = project.scopeItems.filter((line) => !line.archivedAt);
  const budget = currentBudget(project);
  const showApprove = !readOnly && lines.length > 0;
  return <section className="projects-panel"><div className="projects-panel-heading"><div><h3>Scope & budget</h3><div className="projects-budget-state">{budget ? `Budget v${budget.versionNo}: ${labelFor(budget.status)}` : "No budget version"}</div></div><div className="projects-panel-actions">{!readOnly && <button className="projects-button projects-button-secondary" onClick={onAdd}><Plus size={16} />Add scope item</button>}{showApprove && <button className="projects-button projects-button-primary" onClick={onApprove}>{budget?.status === "approved" ? "Approve new budget" : "Approve budget"}</button>}{readOnly && <span className="projects-readonly-label">Read-only</span>}</div></div>{lines.length === 0 ? <EmptyState title="No scope items" action={readOnly ? undefined : "Add scope item"} onAction={readOnly ? undefined : onAdd} /> : <div className="projects-table-wrap"><table className="projects-table"><thead><tr><th>Scope</th><th>Category</th><th>Qty</th><th className="projects-number">Estimate</th><th className="projects-number">Approved</th><th className="projects-number">QBO actual</th>{!readOnly && <th><span className="projects-sr-only">Actions</span></th>}</tr></thead><tbody>{lines.map((line) => <tr key={line.id}><td><strong>{line.description}</strong>{line.unitLabel && <small className="projects-table-subline">{line.unitLabel}</small>}</td><td>{line.category || "—"}</td><td>{line.quantity}</td><td className="projects-number">{formatMoney(line.estimatedCents, project.currency)}</td><td className="projects-number">{formatMoney(approvedForScope(project, line.id), project.currency)}</td><td className="projects-number">{formatMoney(actualForScope(project, line.id), project.currency)}{actualForScope(project, line.id) !== undefined && <small className="projects-source">QBO</small>}</td>{!readOnly && <td className="projects-row-actions"><button className="projects-link-button" onClick={() => onEdit(line)}>Edit</button><button className="projects-link-button projects-link-danger" onClick={() => onArchive(line)}>Archive</button></td>}</tr>)}</tbody></table></div>}{project.budgetVersions.length > 0 && <div className="projects-budget-history"><div className="projects-budget-history-heading"><h4>Budget history</h4></div>{[...project.budgetVersions].sort((a, b) => b.versionNo - a.versionNo).map((version) => <details key={version.id} className="projects-budget-version"><summary><span>Budget v{version.versionNo}</span><StatusBadge status={version.status} /><strong>{formatMoney(version.totalEstimatedCents, project.currency)}</strong></summary><div className="projects-budget-version-body"><table className="projects-table"><thead><tr><th>Line</th><th className="projects-number">Total</th></tr></thead><tbody>{version.lines.map((line) => <tr key={line.id}><td>{line.description}</td><td className="projects-number">{formatMoney(line.estimatedCents, project.currency)}</td></tr>)}</tbody></table></div></details>)}</div>}</section>;
}

function ScheduleTable({ project, onAdd, onEdit, onArchive, readOnly }: { project: ProjectDetail; onAdd: () => void; onEdit: (task: ProjectTask) => void; onArchive: (task: ProjectTask) => void; readOnly: boolean }) {
  const tasks = project.tasks.filter((task) => !task.archivedAt);
  return <section className="projects-panel"><div className="projects-panel-heading"><h3>Schedule</h3><div className="projects-panel-actions">{!readOnly && <button className="projects-button projects-button-secondary" onClick={onAdd}><Plus size={16} />Add task</button>}{readOnly && <span className="projects-readonly-label">Read-only</span>}</div></div>{tasks.length === 0 ? <EmptyState title="No tasks" action={readOnly ? undefined : "Add task"} onAction={readOnly ? undefined : onAdd} /> : <div className="projects-table-wrap"><table className="projects-table"><thead><tr><th>Task</th><th>Status</th><th>Starts</th><th>Due</th><th>Dependencies</th>{!readOnly && <th><span className="projects-sr-only">Actions</span></th>}</tr></thead><tbody>{tasks.map((task) => <tr key={task.id}><td><strong>{task.title}</strong>{task.description && <small className="projects-table-subline">{task.description}</small>}</td><td><StatusBadge status={task.status} /></td><td>{dateLabel(task.startsOn)}</td><td>{dateLabel(task.dueOn)}</td><td>{task.dependencyTaskIds.length ? `${task.dependencyTaskIds.length} task${task.dependencyTaskIds.length === 1 ? "" : "s"}` : "—"}</td>{!readOnly && <td className="projects-row-actions"><button className="projects-link-button" onClick={() => onEdit(task)}>Edit</button><button className="projects-link-button projects-link-danger" onClick={() => onArchive(task)}>Archive</button></td>}</tr>)}</tbody></table></div>}</section>;
}

function CostsTable({ project, onAdd, onEdit, onArchive, readOnly }: { project: ProjectDetail; onAdd: () => void; onEdit: (cost: ProjectCostControl) => void; onArchive: (cost: ProjectCostControl) => void; readOnly: boolean }) {
  const costs = project.draftCosts.filter((cost) => !cost.archivedAt);
  return <section className="projects-panel"><div className="projects-panel-heading"><h3>Costs</h3><div className="projects-panel-actions">{!readOnly && <button className="projects-button projects-button-secondary" onClick={onAdd}><Plus size={16} />Add draft cost</button>}{readOnly && <span className="projects-readonly-label">Read-only</span>}</div></div>{costs.length === 0 ? <EmptyState title="No draft costs" action={readOnly ? undefined : "Add draft cost"} onAction={readOnly ? undefined : onAdd} /> : <div className="projects-table-wrap"><table className="projects-table"><thead><tr><th>Description</th><th>Vendor</th><th>Incurred</th><th>Scope item</th><th className="projects-number">Draft amount</th>{!readOnly && <th><span className="projects-sr-only">Actions</span></th>}</tr></thead><tbody>{costs.map((cost) => <tr key={cost.id}><td><strong>{cost.description}</strong></td><td>{cost.vendorName || "—"}</td><td>{dateLabel(cost.incurredOn)}</td><td>{project.scopeItems.find((item) => item.id === cost.scopeItemId)?.description ?? "Unassigned"}</td><td className="projects-number">{formatMoney(cost.amountCents, project.currency)}</td>{!readOnly && <td className="projects-row-actions"><button className="projects-link-button" onClick={() => onEdit(cost)}>Edit</button><button className="projects-link-button projects-link-danger" onClick={() => onArchive(cost)}>Archive</button></td>}</tr>)}</tbody></table></div>}</section>;
}

function DetailView({ project, entities, tab, onTab, onEdit, onArchive, onAddScope, onEditScope, onArchiveScope, onApproveBudget, onAddTask, onEditTask, onArchiveTask, onAddCost, onEditCost, onArchiveCost }: { project: ProjectDetail; entities: readonly ProjectWorkspaceEntity[]; tab: Tab; onTab: (tab: Tab) => void; onEdit: () => void; onArchive: () => void; onAddScope: () => void; onEditScope: (line: ProjectScopeLine) => void; onArchiveScope: (line: ProjectScopeLine) => void; onApproveBudget: () => void; onAddTask: () => void; onEditTask: (task: ProjectTask) => void; onArchiveTask: (task: ProjectTask) => void; onAddCost: () => void; onEditCost: (cost: ProjectCostControl) => void; onArchiveCost: (cost: ProjectCostControl) => void }) {
  const tabs: [Tab, string][] = [["overview", "Overview"], ["scope", "Scope & Budget"], ["schedule", "Schedule"], ["costs", "Costs"]];
  const readOnly = project.status === "archived";
  return <div className="projects-detail"><header className="projects-detail-header"><div><span className="projects-eyebrow">{propertyName(entities, project.legalEntityId, project.propertyId)}</span><h2>{project.name}</h2><div className="projects-detail-meta"><StatusBadge status={project.status} /><span>{TYPE_LABELS[project.projectType]}</span><span>{entityName(entities, project.legalEntityId)}</span><span>{project.currency}</span></div></div><div className="projects-detail-actions"><button className="projects-button projects-button-secondary" onClick={onEdit} disabled={readOnly}><Pencil size={16} />Edit</button>{!readOnly && <button className="projects-button projects-button-danger" onClick={onArchive}><Archive size={16} />Archive</button>}</div></header><MetricStrip project={project} /><nav className="projects-tabs" aria-label="Project sections">{tabs.map(([value, label]) => <button key={value} className={tab === value ? "is-active" : ""} aria-current={tab === value ? "page" : undefined} onClick={() => onTab(value)}>{label}</button>)}</nav>{tab === "overview" && <div className="projects-overview-grid"><section className="projects-panel"><div className="projects-panel-heading"><div><h3>Project overview</h3></div></div><dl className="projects-definition-list"><div><dt>Start date</dt><dd>{dateLabel(project.startOn)}</dd></div><div><dt>Target date</dt><dd>{dateLabel(project.targetOn)}</dd></div><div><dt>Last updated</dt><dd>{dateLabel(project.updatedAt)}</dd></div><div><dt>Unit</dt><dd>{project.unitId ? entities.find((entity) => entity.id === project.legalEntityId)?.properties.find((property) => property.id === project.propertyId)?.units.find((unit) => unit.id === project.unitId)?.unitNumber ?? "Unit unavailable" : "Whole property"}</dd></div></dl>{project.description && <p className="projects-description">{project.description}</p>}</section><section className="projects-panel"><div className="projects-panel-heading"><div><h3>Work at a glance</h3></div></div><div className="projects-glance-list"><div><ListChecks size={18} /><span>Tasks</span><strong>{project.taskCount}</strong></div><div><CalendarDays size={18} /><span>Target</span><strong>{dateLabel(project.targetOn)}</strong></div><div><WalletCards size={18} /><span>Draft costs</span><strong>{project.draftCosts.length}</strong></div></div></section></div>}{tab === "scope" && <ScopeTable project={project} readOnly={readOnly} onAdd={onAddScope} onEdit={onEditScope} onArchive={onArchiveScope} onApprove={onApproveBudget} />}{tab === "schedule" && <ScheduleTable project={project} readOnly={readOnly} onAdd={onAddTask} onEdit={onEditTask} onArchive={onArchiveTask} />}{tab === "costs" && <CostsTable project={project} readOnly={readOnly} onAdd={onAddCost} onEdit={onEditCost} onArchive={onArchiveCost} />}</div>;
}

export function ProjectWorkspace({ organizationId, organizationName, entities = [], api: apiProp, initialProjectId, onNavigate, activeTab, onTabChange }: ProjectWorkspaceProps) {
  const api = useMemo<ProjectsApi>(() => apiProp ?? createProjectsApi(), [apiProp]);
  const [filters, setFilters] = useState<ProjectListFilters>({ status: "all", search: "" });
  const [searchInput, setSearchInput] = useState("");
  const [projects, setProjects] = useState<readonly ProjectSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string>();
  const [selectedId, setSelectedId] = useState<string | undefined>(initialProjectId);
  const [project, setProject] = useState<ProjectDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [localTab, setLocalTab] = useState<Tab>("overview");
  const tab = activeTab ?? localTab;
  const setTab = (next: Tab) => { setLocalTab(next); onTabChange?.(next); };
  const [editor, setEditor] = useState<EditorState>();
  const [mutationError, setMutationError] = useState<unknown>();
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string>();
  const pendingCommandsRef = useRef<PendingProjectCommandStore>();
  if (!pendingCommandsRef.current) pendingCommandsRef.current = new PendingProjectCommandStore();

  const listScope = JSON.stringify({ organizationId, filters });
  const currentListScope = useRef(listScope);
  currentListScope.current = listScope;
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const currentSelection = useRef(selectedId);
  currentSelection.current = selectedId;

  const loadProjects = useCallback(async (signal?: AbortSignal) => {
    if (currentListScope.current !== listScope) return;
    const generation = ++listGeneration.current;
    const current = () => !signal?.aborted && generation === listGeneration.current && currentListScope.current === listScope;
    if (!organizationId) { setProjects([]); setNextCursor(null); setListLoading(false); return; }
    setListLoading(true); setListError(undefined);
    try {
      const page = await api.listProjects(organizationId, filters, signal);
      if (!current()) return;
      setProjects(page.items); setNextCursor(page.nextCursor);
    } catch (error) {
      if (!current()) return;
      setListError(error instanceof Error ? error.message : "Projects could not be loaded.");
    } finally { if (current()) setListLoading(false); }
  }, [api, filters, organizationId, listScope]);
  const loadMoreProjects = useCallback(async () => {
    if (!organizationId || !nextCursor || loadingMore) return;
    const generation = listGeneration.current;
    setLoadingMore(true); setListError(undefined);
    try {
      const page = await api.listProjects(organizationId, { ...filters, cursor: nextCursor });
      if (generation !== listGeneration.current || currentListScope.current !== listScope) return;
      setProjects(current => [...current, ...page.items.filter(item => !current.some(existing => existing.id === item.id))]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (generation === listGeneration.current && currentListScope.current === listScope) setListError(error instanceof Error ? error.message : "More projects could not be loaded.");
    } finally { setLoadingMore(false); }
  }, [api, filters, loadingMore, nextCursor, organizationId, listScope]);
  const refreshCurrentList = useRef(loadProjects);
  refreshCurrentList.current = loadProjects;
  useEffect(() => { const controller = new AbortController(); void loadProjects(controller.signal); return () => controller.abort(); }, [loadProjects]);
  useEffect(() => { setSelectedId(initialProjectId); }, [initialProjectId]);
  useEffect(() => { if (!selectedId && projects.length) setSelectedId(projects[0]?.id); }, [projects, selectedId]);
  const loadProject = useCallback(async (id: string, signal?: AbortSignal): Promise<ProjectDetail | undefined> => {
    if (currentSelection.current !== id) return undefined;
    const generation = ++detailGeneration.current;
    const current = () => !signal?.aborted && generation === detailGeneration.current && currentSelection.current === id;
    setDetailLoading(true); setDetailError(undefined);
    try {
      const nextProject = await api.getProject(organizationId, id, signal);
      if (!current()) return undefined;
      setProject(nextProject); return nextProject;
    } catch (error) {
      if (!current()) return undefined;
      setProject(undefined); setDetailError(error instanceof Error ? error.message : "Project could not be loaded.");
      return undefined;
    } finally { if (current()) setDetailLoading(false); }
  }, [api, organizationId]);
  useEffect(() => { if (!selectedId || !organizationId) { setProject(undefined); return; } const controller = new AbortController(); void loadProject(selectedId, controller.signal); return () => controller.abort(); }, [loadProject, organizationId, selectedId]);

  const selectProject = (id: string) => { setSelectedId(id); setLocalTab("overview"); setNotice(undefined); onNavigate?.(id); };
  const clearSelection = () => { setSelectedId(undefined); setProject(undefined); onNavigate?.(); };
  const closeEditor = () => { setEditor(undefined); setMutationError(undefined); };
  const executeCommand = async (kind: ProjectCommandKind, envelope: ProjectCommandEnvelope<unknown>) => {
    if (saving) return undefined;
    setSaving(true);
    setMutationError(undefined);
    setNotice(undefined);
    try {
      const result = await api.sendCommand(organizationId, kind, envelope);
      pendingCommandsRef.current!.resolve();
      await refreshCurrentList.current();
      if (currentSelection.current) await loadProject(currentSelection.current);
      return result;
    } catch (error) {
      pendingCommandsRef.current!.clearForError(error);
      setMutationError(error);
      setNotice(pendingCommandsRef.current!.getPending() ? "Save outcome unknown. Retry the pending save before changing its values." : undefined);
      return undefined;
    } finally {
      setSaving(false);
    }
  };
  const runCommand = async <TPayload,>(kind: ProjectCommandKind, scope: CompanyScope, payload: TPayload, expectedRevision?: number) => {
    if (saving) return undefined;
    let envelope: ProjectCommandEnvelope<TPayload>;
    try {
      envelope = pendingCommandsRef.current!.getOrCreate(kind, scope, payload, expectedRevision);
    } catch (error) {
      setMutationError(error);
      setNotice(error instanceof PendingProjectCommandError ? "Retry the pending save before changing its values." : undefined);
      return undefined;
    }
    return executeCommand(kind, envelope);
  };
  const retryPendingCommand = async () => {
    const pending = pendingCommandsRef.current!.getPending();
    if (!pending) return undefined;
    const result = await executeCommand(pending.kind, pending.envelope);
    if (result !== undefined) {
      const affectedId = result.project?.id ?? result.receipt?.affectedRecordIds[0];
      setEditor(undefined);
      setMutationError(undefined);
      setNotice("Save completed.");
      if (pending.kind === "project.archive") clearSelection();
      else if (pending.kind === "project.create" && affectedId) selectProject(affectedId);
    }
    return result;
  };

  const saveProject = async (values: ProjectFormValues) => { if (editor?.kind !== "project") return; const create = editor.mode === "create"; const scope = { organizationId: organizationId as CompanyScope["organizationId"], legalEntityId: values.legalEntityId, propertyId: values.propertyId } as CompanyScope; const payload = create ? { propertyId: values.propertyId, unitId: values.unitId || null, name: values.name.trim(), projectType: values.projectType, description: values.description.trim() || null, status: values.status, startOn: values.startOn || null, targetOn: values.targetOn || null, currency: entityFor(entities, values.legalEntityId)?.currency } : { projectId: editor.project!.id, name: values.name.trim(), projectType: values.projectType, description: values.description.trim() || null, status: values.status, unitId: values.unitId || null, startOn: values.startOn || null, targetOn: values.targetOn || null }; const result = await runCommand(create ? "project.create" : "project.update", scope, payload, create ? undefined : editor.project?.recordRevision); if (result !== undefined) { setEditor(undefined); setMutationError(undefined); setNotice(create ? "Project saved." : "Project saved."); const createdId = create ? result.project?.id ?? result.receipt?.affectedRecordIds[0] : result.project?.id; if (createdId) selectProject(createdId); } };
  const saveScope = async (values: ScopeLineFormValues) => { if (editor?.kind !== "scope" || !project) return; const scope = scopeForProject(organizationId, project); const base = { description: values.description.trim(), category: values.category.trim() || null, unitLabel: values.unitLabel.trim() || null, quantity: values.quantity.trim(), rateCents: parseRequiredNonNegativeMoney(values.rate, "Rate") }; const create = editor.mode === "create"; const payload = create ? { projectId: project.id, ...base } : { scopeItemId: editor.line!.id, ...base }; const result = await runCommand(create ? "project.scope_item.create" : "project.scope_item.update", scope, payload, project.recordRevision); if (result !== undefined) { setEditor(undefined); setMutationError(undefined); setNotice("Scope item saved."); } };
  const saveTask = async (values: TaskFormValues) => { if (editor?.kind !== "task" || !project) return; const scope = scopeForProject(organizationId, project); const base = { title: values.title.trim(), description: values.description.trim() || null, status: values.status, startsOn: values.startsOn || null, dueOn: values.dueOn || null, completedOn: values.completedOn || null, dependencyTaskIds: [...values.dependencyTaskIds] }; const create = editor.mode === "create"; const payload = create ? { projectId: project.id, ...base } : { taskId: editor.task!.id, ...base }; const result = await runCommand(create ? "project.task.create" : "project.task.update", scope, payload, project.recordRevision); if (result !== undefined) { setEditor(undefined); setMutationError(undefined); setNotice("Task saved."); } };
  const saveCost = async (values: CostControlFormValues) => { if (editor?.kind !== "cost" || !project) return; const scope = scopeForProject(organizationId, project); const base = { scopeItemId: values.scopeItemId || null, vendorName: values.vendorName.trim() || null, description: values.description.trim(), amountCents: parseRequiredNonNegativeMoney(values.amount, "Amount"), incurredOn: values.incurredOn }; const create = editor.mode === "create"; const payload = create ? { projectId: project.id, ...base } : { draftCostId: editor.cost!.id, ...base }; const result = await runCommand(create ? "project.draft_cost.create" : "project.draft_cost.update", scope, payload, project.recordRevision); if (result !== undefined) { setEditor(undefined); setMutationError(undefined); setNotice("Draft cost saved."); } };
  const approveBudget = async () => { if (!project || project.status === "archived") return; if (typeof window !== "undefined" && !window.confirm("Approve a new budget version from the current scope?")) return; const scope = scopeForProject(organizationId, project); const result = await runCommand("project.budget.approve", scope, { projectId: project.id, notes: null }, project.recordRevision); if (result !== undefined) { setMutationError(undefined); setNotice("Budget version approved."); } };
  const archive = async (kind: "project.archive" | "project.scope_item.archive" | "project.task.archive" | "project.draft_cost.archive", record: ProjectDetail | ProjectScopeLine | ProjectTask | ProjectCostControl) => { if (!project) return; if (typeof window !== "undefined" && !window.confirm("Archive this record?")) return; const scope = scopeForProject(organizationId, project); const payload = kind === "project.archive" ? { projectId: project.id } : kind === "project.scope_item.archive" ? { scopeItemId: record.id } : kind === "project.task.archive" ? { taskId: record.id } : { draftCostId: record.id }; const result = await runCommand(kind, scope, payload, project.recordRevision); if (result !== undefined) { setMutationError(undefined); setNotice(kind === "project.archive" ? "Project archived." : "Record archived."); if (kind === "project.archive") clearSelection(); } };

  if (!organizationId) return <section className="projects-workspace"><EmptyState title="Company access is not configured." /></section>;
  return <section className="projects-workspace" aria-label="Projects workspace"><header className="projects-page-header"><h1>Projects</h1><button className="projects-button projects-button-primary" onClick={() => { setMutationError(undefined); setEditor({ kind: "project", mode: "create" }); }} disabled={!entities.length}><Plus size={17} />New project</button></header><div className="projects-layout"><aside className="projects-list-pane" aria-label="Project list"><div className="projects-list-toolbar"><label className="projects-search"><Search size={16} /><span className="projects-sr-only">Search projects</span><input value={searchInput} placeholder="Search projects" onChange={(event) => { const next = event.currentTarget.value; setSearchInput(next); setFilters((current) => ({ ...current, search: next })); }} /></label><label className="projects-filter"><span className="projects-sr-only">Project status</span><select value={filters.status ?? "all"} onChange={(event) => { const status = event.currentTarget.value as ProjectListFilters["status"]; setFilters((current) => ({ ...current, status })); }}><option value="all">All projects</option><option value="planning">Planning</option><option value="active">Active</option><option value="on_hold">On hold</option><option value="completed">Completed</option><option value="archived">Archived</option></select></label></div>{listLoading ? <LoadingState /> : listError ? <ErrorState message={listError} onRetry={() => void loadProjects()} /> : projects.length === 0 ? <EmptyState title={filters.search ? "No matching projects" : "No projects"} action={filters.search ? "Clear search" : entities.length ? "New project" : undefined} onAction={filters.search ? () => { setSearchInput(""); setFilters((current) => ({ ...current, search: "" })); } : entities.length ? () => setEditor({ kind: "project", mode: "create" }) : undefined} /> : <div className="projects-list" role="list">{projects.map((item) => <button role="listitem" key={item.id} className={`projects-list-row ${selectedId === item.id ? "is-selected" : ""}`} onClick={() => selectProject(item.id)}><span className="projects-list-row-main"><strong>{item.name}</strong><small>{propertyName(entities, item.legalEntityId, item.propertyId)}</small></span><span className="projects-list-row-side"><StatusBadge status={item.status} /><small>{dateLabel(item.targetOn)}</small></span></button>)}{nextCursor && <button className="projects-load-more" type="button" onClick={() => void loadMoreProjects()} disabled={loadingMore}>{loadingMore ? "Loading…" : "Load more projects"}</button>}</div>}</aside><div className="projects-main" aria-live="polite">{notice && <div className="projects-notice" role="status"><Check size={16} />{notice}<button className="projects-icon-button" onClick={() => setNotice(undefined)} aria-label="Dismiss"><X size={15} /></button></div>}{!saving && pendingCommandsRef.current!.getPending() && <div className="projects-pending-notice" role="alert"><CircleAlert size={16} /><span>A save has an unknown outcome.</span><button className="projects-button projects-button-secondary" type="button" onClick={() => void retryPendingCommand()} disabled={saving}>Retry pending save</button></div>}{mutationError !== undefined && !editor && <MutationError error={mutationError} fallback="Project could not be saved." onRetryPending={pendingCommandsRef.current!.getPending() ? () => void retryPendingCommand() : undefined} />}{detailLoading ? <LoadingState label="Loading project…" /> : detailError ? <ErrorState message={detailError} onRetry={() => selectedId && void loadProject(selectedId)} /> : project ? <DetailView project={project} entities={entities} tab={tab} onTab={setTab} onEdit={() => { setMutationError(undefined); setEditor({ kind: "project", mode: "edit", project }); }} onArchive={() => void archive("project.archive", project)} onAddScope={() => { setMutationError(undefined); setEditor({ kind: "scope", mode: "create" }); }} onEditScope={(line) => { setMutationError(undefined); setEditor({ kind: "scope", mode: "edit", line }); }} onArchiveScope={(line) => void archive("project.scope_item.archive", line)} onAddTask={() => { setMutationError(undefined); setEditor({ kind: "task", mode: "create" }); }} onEditTask={(task) => { setMutationError(undefined); setEditor({ kind: "task", mode: "edit", task }); }} onArchiveTask={(task) => void archive("project.task.archive", task)} onApproveBudget={() => void approveBudget()} onAddCost={() => { setMutationError(undefined); setEditor({ kind: "cost", mode: "create" }); }} onEditCost={(cost) => { setMutationError(undefined); setEditor({ kind: "cost", mode: "edit", cost }); }} onArchiveCost={(cost) => void archive("project.draft_cost.archive", cost)} /> : selectedId ? <EmptyState title="Project unavailable" action="Refresh" onAction={() => { void loadProjects(); if (selectedId) void loadProject(selectedId); }} /> : <div className="projects-main-empty"><FolderKanban size={30} /><h2>Select a project</h2><p>Choose a project from the list to review work, costs and completion.</p></div>}</div></div>{editor?.kind === "project" && <ProjectEditor mode={editor.mode} project={editor.project} entities={entities} error={mutationError} saving={saving} onClose={closeEditor} onSave={(values) => void saveProject(values)} onReload={async () => { const latest = editor.project ? await loadProject(editor.project.id) : undefined; if (latest) setEditor((current) => current?.kind === "project" ? { ...current, project: latest } : current); setMutationError(undefined); }} onRetryPending={pendingCommandsRef.current!.getPending() ? () => void retryPendingCommand() : undefined} />}{editor?.kind === "scope" && project && <ScopeEditor line={editor.line} project={project} error={mutationError} saving={saving} onClose={closeEditor} onSave={(values) => void saveScope(values)} onReload={async () => { await loadProject(project.id); setMutationError(undefined); }} onRetryPending={pendingCommandsRef.current!.getPending() ? () => void retryPendingCommand() : undefined} />}{editor?.kind === "task" && project && <TaskEditor task={editor.task} project={project} error={mutationError} saving={saving} onClose={closeEditor} onSave={(values) => void saveTask(values)} onReload={async () => { await loadProject(project.id); setMutationError(undefined); }} onRetryPending={pendingCommandsRef.current!.getPending() ? () => void retryPendingCommand() : undefined} />}{editor?.kind === "cost" && project && <CostEditor cost={editor.cost} project={project} error={mutationError} saving={saving} onClose={closeEditor} onSave={(values) => void saveCost(values)} onReload={async () => { await loadProject(project.id); setMutationError(undefined); }} onRetryPending={pendingCommandsRef.current!.getPending() ? () => void retryPendingCommand() : undefined} />}</section>;
}

export default ProjectWorkspace;
