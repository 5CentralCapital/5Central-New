/**
 * Work order lifecycle rules shared by the server command, UI and Codex.
 * Pure functions only: no storage, HTTP or UI imports.
 */
export const WORK_ORDER_STATUSES = ["new", "scheduled", "in_progress", "on_hold", "completed", "canceled"] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

export const WORK_ORDER_OPEN_STATUSES: readonly WorkOrderStatus[] = ["new", "scheduled", "in_progress", "on_hold"];
export const WORK_ORDER_TERMINAL_STATUSES: readonly WorkOrderStatus[] = ["completed", "canceled"];

/** Allowed next states. Terminal states can only be reopened, with a note. */
export const WORK_ORDER_TRANSITIONS: Readonly<Record<WorkOrderStatus, readonly WorkOrderStatus[]>> = Object.freeze({
  new: ["scheduled", "in_progress", "on_hold", "completed", "canceled"],
  scheduled: ["new", "in_progress", "on_hold", "completed", "canceled"],
  in_progress: ["scheduled", "on_hold", "completed", "canceled"],
  on_hold: ["scheduled", "in_progress", "completed", "canceled"],
  completed: ["in_progress"],
  canceled: ["new"],
});

export function isOpenWorkOrderStatus(status: WorkOrderStatus): boolean {
  return WORK_ORDER_OPEN_STATUSES.includes(status);
}

export function allowedWorkOrderTransitions(from: WorkOrderStatus): readonly WorkOrderStatus[] {
  return WORK_ORDER_TRANSITIONS[from];
}

/** A note explains holds, cancellations and every reopen of finished work. */
export function workOrderTransitionRequiresNote(from: WorkOrderStatus, to: WorkOrderStatus): boolean {
  return to === "on_hold" || to === "canceled" || WORK_ORDER_TERMINAL_STATUSES.includes(from);
}

export type WorkOrderTransitionProblem =
  | "same_status"
  | "transition_not_allowed"
  | "note_required"
  | "scheduled_date_required"
  | "completed_date_before_reported";

export interface WorkOrderTransitionInput {
  readonly from: WorkOrderStatus;
  readonly to: WorkOrderStatus;
  readonly note?: string | null;
  /** The scheduled date after this change (the stored value when the command omits one). */
  readonly scheduledOn?: string | null;
  readonly reportedOn: string;
  readonly completedOn?: string | null;
}

/** Returns the first rule the requested transition breaks, or null when it is valid. */
export function workOrderTransitionProblem(input: WorkOrderTransitionInput): WorkOrderTransitionProblem | null {
  if (input.from === input.to) return "same_status";
  if (!WORK_ORDER_TRANSITIONS[input.from].includes(input.to)) return "transition_not_allowed";
  if (workOrderTransitionRequiresNote(input.from, input.to) && !input.note?.trim()) return "note_required";
  if (input.to === "scheduled" && !input.scheduledOn) return "scheduled_date_required";
  if (input.to === "completed" && input.completedOn && input.completedOn < input.reportedOn) return "completed_date_before_reported";
  return null;
}

export const WORK_ORDER_TRANSITION_MESSAGES: Readonly<Record<WorkOrderTransitionProblem, string>> = Object.freeze({
  same_status: "The work order already has this status.",
  transition_not_allowed: "This status change is not allowed from the current status.",
  note_required: "Add a note explaining this status change.",
  scheduled_date_required: "Scheduling requires a scheduled date.",
  completed_date_before_reported: "The completed date cannot be before the reported date.",
});
