import { WORK_ORDER_CATEGORY_LABELS, type WorkOrderCategory, type WorkOrderEvent, type WorkOrderPriority, type WorkOrderStatus } from "@shared/work-orders";

export const STATUS_LABELS: Readonly<Record<WorkOrderStatus, string>> = {
  new: "New", scheduled: "Scheduled", in_progress: "In progress", on_hold: "On hold", completed: "Completed", canceled: "Canceled",
};
export const PRIORITY_LABELS: Readonly<Record<WorkOrderPriority, string>> = { emergency: "Emergency", high: "High", normal: "Normal", low: "Low" };
export const categoryLabel = (category: WorkOrderCategory): string => WORK_ORDER_CATEGORY_LABELS[category];

/** Status capsules reuse the manager status classes; the label always carries the meaning. */
export function statusClass(status: WorkOrderStatus): string {
  switch (status) {
    case "completed": return "rm-status rm-status--success";
    case "on_hold": return "rm-status rm-status--warning";
    case "scheduled": return "rm-status wo-status--scheduled";
    case "in_progress": return "rm-status wo-status--active";
    default: return "rm-status rm-status--unknown";
  }
}

export function priorityClass(priority: WorkOrderPriority): string | null {
  if (priority === "emergency") return "rm-status rm-status--error";
  if (priority === "high") return "rm-status rm-status--warning";
  return null;
}

export function dateLabel(value: string | null | undefined, style: "short" | "long" = "short"): string {
  if (!value) return "—";
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", style === "long" ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" }).format(date);
}

export function timestampLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

/** Today in the company's operating time zone, as an ISO date. */
export function operatingToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const value = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

const FIELD_LABELS: Record<string, string> = {
  title: "title", description: "description", category: "category", priority: "priority", reportedOn: "reported date",
  scheduledOn: "scheduled date", assignedTo: "assignee", entryPermitted: "entry permission", estimatedCostCents: "estimate",
  unitId: "unit", tenancyId: "tenant", personId: "tenant",
};

/** One-line activity summary; notes are shown separately. */
export function eventSummary(event: WorkOrderEvent): string {
  switch (event.type) {
    case "created": return "Work order created";
    case "status_changed": return `${STATUS_LABELS[event.fromStatus ?? "new"]} → ${STATUS_LABELS[event.toStatus ?? "new"]}`;
    case "note": return "Note added";
    case "project_linked": return "Linked to a project";
    case "project_unlinked": return "Project link removed";
    case "chargeback_set": return event.details.ledgerTransactionId ? "Chargeback linked to a posted tenant charge" : "Chargeback intent recorded";
    case "chargeback_cleared": return "Chargeback cleared";
    case "updated": {
      const fields = Array.isArray(event.details.fields) ? Array.from(new Set((event.details.fields as unknown[]).map(field => FIELD_LABELS[String(field)] ?? String(field)))) : [];
      return fields.length ? `Updated ${fields.join(", ")}` : "Details updated";
    }
  }
}
