import { WORK_ORDER_STATUSES, type WorkOrderStatus } from "@shared/work-orders";

/** List views reachable from navigation and the status chips. */
export type WorkOrderView = "open" | "schedule" | "all" | WorkOrderStatus;
export const WORK_ORDER_VIEWS: readonly WorkOrderView[] = ["open", "schedule", ...WORK_ORDER_STATUSES, "all"];
export function isWorkOrderView(value: unknown): value is WorkOrderView {
  return typeof value === "string" && (WORK_ORDER_VIEWS as readonly string[]).includes(value);
}
