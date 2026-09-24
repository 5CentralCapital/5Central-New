import { formatLongDate, formatTableDate, formatTimestamp } from "../../lib/rent-ops-formatters";
import { WORK_ORDER_CATEGORY_LABELS, type WorkOrderCategory, type WorkOrderEvent, type WorkOrderPriority, type WorkOrderStatus, type WorkOrderSummary } from "@shared/work-orders";

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

/** "short" for lists and tables ("Jun 1" this year), "long" for fields and headings ("Sep 24, 2026"). */
export function dateLabel(value: string | null | undefined, style: "short" | "long" = "short"): string {
  if (!value) return "—";
  return (style === "long" ? formatLongDate(value) : formatTableDate(value)) ?? "—";
}

/** Activity timestamps without seconds. */
export function timestampLabel(value: string): string {
  return formatTimestamp(value) ?? "—";
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

const ACTION_LABELS: Readonly<Record<string, (details: Record<string, unknown>) => string>> = {
  vendor_assigned: details => { const vendor = details.vendorAssignment as { name?: unknown } | null | undefined; return typeof vendor?.name === "string" ? `Vendor assigned: ${vendor.name}` : "Vendor assigned"; },
  vendor_cleared: () => "Vendor removed",
  cost_linked: () => "QBO bill line linked as actual cost",
  cost_unlinked: () => "QBO bill line released",
  manual_actual_set: () => "Manual actual cost recorded",
  manual_actual_cleared: () => "Manual actual cost cleared",
  attachment_linked: () => "Document attached",
  attachment_unlinked: () => "Document removed",
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
      const action = typeof event.details.action === "string" ? event.details.action : undefined;
      if (action && ACTION_LABELS[action]) return ACTION_LABELS[action]!(event.details);
      const fields = Array.isArray(event.details.fields) ? Array.from(new Set((event.details.fields as unknown[]).map(field => FIELD_LABELS[String(field)] ?? String(field)))) : [];
      return fields.length ? `Updated ${fields.join(", ")}` : "Details updated";
    }
  }
}

/** Scheduled work in date order with a heading per day; unscheduled work falls back to its target date. */
export function scheduleOrder<T extends Pick<WorkOrderSummary, "scheduledOn" | "targetOn" | "reference">>(items: readonly T[]): { item: T; heading: string | undefined }[] {
  const dated = [...items].map(item => ({ item, on: item.scheduledOn ?? item.targetOn })).sort((left, right) => left.on.localeCompare(right.on) || left.item.reference.localeCompare(right.item.reference));
  let previous = "";
  return dated.map(({ item, on }) => { const heading = on !== previous ? `${item.scheduledOn ? "" : "Target "}${dateLabel(on, "long")}` : undefined; previous = on; return { item, heading }; });
}

