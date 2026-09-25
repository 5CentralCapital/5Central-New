import { z } from "zod";
import {
  canonicalUuidSchema,
  centsSchema,
  centsToBigInt,
  companyScopeSchema,
  currencyCodeSchema,
  isoDateSchema,
  isoTimestampSchema,
  legalEntityIdSchema,
  propertyReferenceIdSchema,
  revisionSchema,
  type CompanyScope,
} from "../company";
import { financialSourceReferenceSchema } from "../accounting/source";
import { WORK_ORDER_STATUSES } from "./transitions";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };
export type WorkOrderId = Brand<string, "WorkOrderId">;
export const workOrderIdSchema = canonicalUuidSchema.transform((value) => value as WorkOrderId);

export const workOrderStatusSchema = z.enum(WORK_ORDER_STATUSES);

export const WORK_ORDER_CATEGORIES = ["plumbing", "electrical", "hvac", "appliance", "general", "turnover", "pest", "exterior", "other"] as const;
export type WorkOrderCategory = (typeof WORK_ORDER_CATEGORIES)[number];
export const workOrderCategorySchema = z.enum(WORK_ORDER_CATEGORIES);
export const WORK_ORDER_CATEGORY_LABELS: Readonly<Record<WorkOrderCategory, string>> = Object.freeze({
  plumbing: "Plumbing", electrical: "Electrical", hvac: "HVAC", appliance: "Appliance", general: "General",
  turnover: "Turnover / make-ready", pest: "Pest", exterior: "Exterior", other: "Other",
});

export const WORK_ORDER_PRIORITIES = ["emergency", "high", "normal", "low"] as const;
export type WorkOrderPriority = (typeof WORK_ORDER_PRIORITIES)[number];
export const workOrderPrioritySchema = z.enum(WORK_ORDER_PRIORITIES);

export const WORK_ORDER_EVENT_TYPES = ["created", "updated", "status_changed", "note", "project_linked", "project_unlinked", "chargeback_set", "chargeback_cleared"] as const;
export type WorkOrderEventType = (typeof WORK_ORDER_EVENT_TYPES)[number];

/** Existing rental IDs stay opaque; they are never coerced into UUIDs. */
const rentalReferenceSchema = z.string().min(1).max(160).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Reference ID cannot contain control characters");
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalNullableText = (max: number) => z.string().trim().max(max).nullable().optional()
  .transform((value) => (value === undefined ? undefined : value === null || value === "" ? null : value));
const nullableDate = isoDateSchema.nullable().optional();

export const nonNegativeWorkOrderCentsSchema = centsSchema.refine((value) => centsToBigInt(value) >= BigInt(0), "Expected non-negative signed BIGINT cents");
export const positiveWorkOrderCentsSchema = centsSchema.refine((value) => centsToBigInt(value) > BigInt(0), "Expected positive signed BIGINT cents");

/** Human-facing stable reference derived from the immutable UUID. */
export function workOrderReference(id: string): string {
  return `WO-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

export const workOrderChargebackSchema = z.object({
  amountCents: positiveWorkOrderCentsSchema,
  description: text(300),
  /** Only a link to an already posted tenant charge; 5Central Ops never posts one from a work order. */
  ledgerTransactionId: rentalReferenceSchema.nullable(),
  state: z.enum(["intent_only", "charge_linked"]),
}).strict();
export type WorkOrderChargeback = z.infer<typeof workOrderChargebackSchema>;

export const WORK_ORDER_VENDOR_KINDS = ["contact", "project_vendor"] as const;
export type WorkOrderVendorKind = (typeof WORK_ORDER_VENDOR_KINDS)[number];
/** A vendor is a company contact with the vendor role or a project vendor record. */
export const workOrderVendorSchema = z.object({
  kind: z.enum(WORK_ORDER_VENDOR_KINDS),
  id: canonicalUuidSchema,
  name: z.string().min(1).max(240),
}).strict();
export type WorkOrderVendor = z.infer<typeof workOrderVendorSchema>;

/** Response-time targets used for the derived target date and aging. */
export const WORK_ORDER_TARGET_DAYS: Readonly<Record<WorkOrderPriority, number>> = Object.freeze({ emergency: 1, high: 3, normal: 7, low: 14 });

/** Derived target date: reported date plus the priority response time. */
export function workOrderTargetOn(reportedOn: string, priority: WorkOrderPriority): string {
  const date = new Date(`${reportedOn}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + WORK_ORDER_TARGET_DAYS[priority]);
  return date.toISOString().slice(0, 10);
}

/** Days open as of a date, or days to complete for finished work. */
export function workOrderAgingDays(input: { reportedOn: string; completedOn: string | null; status: string }, asOf: string): number {
  const end = input.completedOn ?? asOf;
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${input.reportedOn}T00:00:00Z`)) / 86_400_000);
  return days < 0 ? 0 : days;
}

export const workOrderActualCostSchema = z.object({
  /** Sum of QBO bill lines allocated to this work order in the central allocation ledger. */
  linkedCents: nonNegativeWorkOrderCentsSchema,
  linkedLineCount: z.number().int().nonnegative(),
  /** Draft manual actual; operational only until a QBO line is linked. */
  manualCents: nonNegativeWorkOrderCentsSchema.nullable(),
  state: z.enum(["verified", "manual", "none"]),
}).strict();
export type WorkOrderActualCost = z.infer<typeof workOrderActualCostSchema>;

export const workOrderSummarySchema = z.object({
  id: workOrderIdSchema,
  reference: z.string().regex(/^WO-[0-9A-F]{8}$/),
  organizationId: canonicalUuidSchema,
  legalEntityId: legalEntityIdSchema,
  propertyId: propertyReferenceIdSchema,
  propertyName: z.string().nullable(),
  unitId: rentalReferenceSchema.nullable(),
  unitNumber: z.string().nullable(),
  tenancyId: rentalReferenceSchema.nullable(),
  personId: rentalReferenceSchema.nullable(),
  personName: z.string().nullable(),
  projectId: canonicalUuidSchema.nullable(),
  projectName: z.string().nullable(),
  title: text(200),
  category: workOrderCategorySchema,
  priority: workOrderPrioritySchema,
  status: workOrderStatusSchema,
  reportedOn: isoDateSchema,
  scheduledOn: isoDateSchema.nullable(),
  completedOn: isoDateSchema.nullable(),
  assignedTo: z.string().nullable(),
  vendor: workOrderVendorSchema.nullable(),
  targetOn: isoDateSchema,
  agingDays: z.number().int().nonnegative(),
  entryPermitted: z.boolean(),
  currency: currencyCodeSchema,
  estimatedCostCents: nonNegativeWorkOrderCentsSchema.nullable(),
  actualCost: workOrderActualCostSchema,
  chargeback: workOrderChargebackSchema.nullable(),
  recordRevision: revisionSchema,
  createdBy: z.string().min(1).max(160),
  updatedBy: z.string().min(1).max(160),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).strict();
export type WorkOrderSummary = z.infer<typeof workOrderSummarySchema>;

export const workOrderEventSchema = z.object({
  id: canonicalUuidSchema,
  type: z.enum(WORK_ORDER_EVENT_TYPES),
  fromStatus: workOrderStatusSchema.nullable(),
  toStatus: workOrderStatusSchema.nullable(),
  note: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  recordRevision: revisionSchema,
  actorId: z.string().min(1).max(160),
  createdAt: isoTimestampSchema,
}).strict();
export type WorkOrderEvent = z.infer<typeof workOrderEventSchema>;

export const workOrderAttachmentSchema = z.object({
  documentId: z.string().min(1).max(160),
  title: z.string().min(1).max(240),
  kind: z.string().min(1).max(80),
  documentDate: isoDateSchema.nullable(),
  available: z.boolean(),
  linkedAt: isoTimestampSchema,
  linkedBy: z.string().min(1).max(160),
}).strict();
export type WorkOrderAttachment = z.infer<typeof workOrderAttachmentSchema>;

export const workOrderCostLineSchema = z.object({
  source: financialSourceReferenceSchema,
  transactionType: z.string().max(120).nullable(),
  description: z.string().max(500).nullable(),
  postedOn: isoDateSchema.nullable(),
  currency: currencyCodeSchema,
  allocatedCents: nonNegativeWorkOrderCentsSchema,
  lineAmountCents: nonNegativeWorkOrderCentsSchema.nullable(),
  /** current: the mirror still proves the line; stale: the line changed or was voided. */
  validity: z.enum(["current", "stale"]),
}).strict();
export type WorkOrderCostLine = z.infer<typeof workOrderCostLineSchema>;

export const workOrderManualActualSchema = z.object({
  amountCents: nonNegativeWorkOrderCentsSchema,
  note: z.string().nullable(),
  setAt: isoTimestampSchema,
  setBy: z.string().min(1).max(160),
}).strict();

export const workOrderDetailSchema = workOrderSummarySchema.extend({
  description: z.string().nullable(),
  attachments: z.array(workOrderAttachmentSchema).max(200),
  costLines: z.array(workOrderCostLineSchema).max(200),
  manualActual: workOrderManualActualSchema.nullable(),
  allowedTransitions: z.array(workOrderStatusSchema).max(WORK_ORDER_STATUSES.length),
  history: z.array(workOrderEventSchema).max(10_000),
}).strict();
export type WorkOrderDetail = z.infer<typeof workOrderDetailSchema>;

export const workOrderListQuerySchema = z.object({
  scope: companyScopeSchema,
  unitId: rentalReferenceSchema.optional(),
  /** Explicit statuses take precedence over openOnly. */
  statuses: z.array(workOrderStatusSchema).min(1).max(WORK_ORDER_STATUSES.length).optional(),
  priorities: z.array(workOrderPrioritySchema).min(1).max(WORK_ORDER_PRIORITIES.length).optional(),
  categories: z.array(workOrderCategorySchema).min(1).max(WORK_ORDER_CATEGORIES.length).optional(),
  assignedTo: z.string().trim().min(1).max(200).optional(),
  vendorId: canonicalUuidSchema.optional(),
  /** Scheduled-date window, used by the schedule view. */
  scheduledFrom: isoDateSchema.optional(),
  scheduledThrough: isoDateSchema.optional(),
  search: z.string().trim().max(200).optional(),
  openOnly: z.boolean().default(true),
  /**
   * priority: most urgent first, newest reported first.
   * schedule: agenda order — scheduled date, or the target date when unscheduled — earliest first.
   */
  sort: z.enum(["priority", "schedule"]).default("priority").describe("priority (default) or schedule: earliest scheduled date, or target date when unscheduled, first"),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(512).optional(),
}).strict();
export type WorkOrderListQuery = z.input<typeof workOrderListQuerySchema>;
export type ParsedWorkOrderListQuery = z.output<typeof workOrderListQuerySchema>;

export const workOrderListResponseSchema = z.object({
  items: z.array(workOrderSummarySchema).max(100),
  nextCursor: z.string().min(1).max(512).nullable(),
}).strict();
export type WorkOrderListResponse = z.infer<typeof workOrderListResponseSchema>;

export const workOrderTenantOptionSchema = z.object({
  tenancyId: rentalReferenceSchema,
  personId: rentalReferenceSchema,
  personName: z.string(),
  unitId: rentalReferenceSchema.nullable(),
  unitNumber: z.string().nullable(),
  status: z.string(),
}).strict();
export type WorkOrderTenantOption = z.infer<typeof workOrderTenantOptionSchema>;
export const workOrderTenantOptionsResponseSchema = z.object({ items: z.array(workOrderTenantOptionSchema).max(500) }).strict();
export type WorkOrderTenantOptionsResponse = z.infer<typeof workOrderTenantOptionsResponseSchema>;

function assertDates(value: { reportedOn?: string | null; completedOn?: string | null }, context: z.RefinementCtx): void {
  if (value.reportedOn && value.completedOn && value.completedOn < value.reportedOn) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["completedOn"], message: "completedOn must be on or after reportedOn" });
  }
}

export const createWorkOrderPayloadSchema = z.object({
  propertyId: propertyReferenceIdSchema,
  unitId: rentalReferenceSchema.nullable().optional(),
  tenancyId: rentalReferenceSchema.nullable().optional(),
  personId: rentalReferenceSchema.nullable().optional(),
  projectId: canonicalUuidSchema.nullable().optional(),
  title: text(200),
  description: optionalNullableText(4_000),
  category: workOrderCategorySchema.default("general"),
  priority: workOrderPrioritySchema.default("normal"),
  status: z.enum(["new", "scheduled"]).default("new"),
  reportedOn: isoDateSchema.optional(),
  scheduledOn: nullableDate,
  assignedTo: optionalNullableText(200),
  entryPermitted: z.boolean().default(false),
  estimatedCostCents: nonNegativeWorkOrderCentsSchema.nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.status === "scheduled" && !value.scheduledOn) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["scheduledOn"], message: "Scheduled work orders require scheduledOn" });
  }
});
export type CreateWorkOrderPayload = z.output<typeof createWorkOrderPayloadSchema>;

export const updateWorkOrderPayloadSchema = z.object({
  workOrderId: workOrderIdSchema,
  unitId: rentalReferenceSchema.nullable().optional(),
  tenancyId: rentalReferenceSchema.nullable().optional(),
  personId: rentalReferenceSchema.nullable().optional(),
  title: text(200).optional(),
  description: optionalNullableText(4_000),
  category: workOrderCategorySchema.optional(),
  priority: workOrderPrioritySchema.optional(),
  reportedOn: isoDateSchema.optional(),
  scheduledOn: nullableDate,
  assignedTo: optionalNullableText(200),
  entryPermitted: z.boolean().optional(),
  estimatedCostCents: nonNegativeWorkOrderCentsSchema.nullable().optional(),
}).strict().superRefine((value, context) => {
  if (Object.keys(value).filter((key) => key !== "workOrderId").length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "At least one work order field is required" });
  }
});
export type UpdateWorkOrderPayload = z.output<typeof updateWorkOrderPayloadSchema>;

export const changeWorkOrderStatusPayloadSchema = z.object({
  workOrderId: workOrderIdSchema,
  status: workOrderStatusSchema,
  note: z.string().trim().min(1).max(4_000).optional(),
  scheduledOn: isoDateSchema.optional(),
  completedOn: isoDateSchema.optional(),
}).strict().superRefine(assertDates);
export type ChangeWorkOrderStatusPayload = z.output<typeof changeWorkOrderStatusPayloadSchema>;

export const addWorkOrderNotePayloadSchema = z.object({
  workOrderId: workOrderIdSchema,
  note: z.string().trim().min(1).max(4_000),
}).strict();
export type AddWorkOrderNotePayload = z.output<typeof addWorkOrderNotePayloadSchema>;

export const linkWorkOrderProjectPayloadSchema = z.object({
  workOrderId: workOrderIdSchema,
  /** null removes the link. */
  projectId: canonicalUuidSchema.nullable(),
}).strict();
export type LinkWorkOrderProjectPayload = z.output<typeof linkWorkOrderProjectPayloadSchema>;

export const setWorkOrderChargebackPayloadSchema = z.object({
  workOrderId: workOrderIdSchema,
  amountCents: positiveWorkOrderCentsSchema,
  description: text(300),
  /** Link an existing posted tenant charge. Omit to record intent only. */
  ledgerTransactionId: rentalReferenceSchema.nullable().optional(),
}).strict();
export type SetWorkOrderChargebackPayload = z.output<typeof setWorkOrderChargebackPayloadSchema>;

export const clearWorkOrderChargebackPayloadSchema = z.object({ workOrderId: workOrderIdSchema }).strict();
export type ClearWorkOrderChargebackPayload = z.output<typeof clearWorkOrderChargebackPayloadSchema>;

export const assignWorkOrderVendorPayloadSchema = z.object({
  workOrderId: workOrderIdSchema,
  /** null clears the vendor; the free-text assignee is unchanged. */
  vendor: z.object({ kind: z.enum(WORK_ORDER_VENDOR_KINDS), id: canonicalUuidSchema }).strict().nullable(),
}).strict();
export type AssignWorkOrderVendorPayload = z.output<typeof assignWorkOrderVendorPayloadSchema>;

export const linkWorkOrderCostPayloadSchema = z.object({
  workOrderId: workOrderIdSchema,
  source: financialSourceReferenceSchema,
  amountCents: positiveWorkOrderCentsSchema,
}).strict().superRefine((value, context) => {
  if (value.source.lineId === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ["source", "lineId"], message: "Link an exact QBO bill line" });
});
export type LinkWorkOrderCostPayload = z.output<typeof linkWorkOrderCostPayloadSchema>;

export const unlinkWorkOrderCostPayloadSchema = z.object({
  workOrderId: workOrderIdSchema,
  source: financialSourceReferenceSchema,
}).strict();
export type UnlinkWorkOrderCostPayload = z.output<typeof unlinkWorkOrderCostPayloadSchema>;

export const setWorkOrderManualActualPayloadSchema = z.object({
  workOrderId: workOrderIdSchema,
  /** null clears the draft manual actual. */
  amountCents: nonNegativeWorkOrderCentsSchema.nullable(),
  note: optionalNullableText(500),
}).strict();
export type SetWorkOrderManualActualPayload = z.output<typeof setWorkOrderManualActualPayloadSchema>;

export const workOrderAttachmentPayloadSchema = z.object({
  workOrderId: workOrderIdSchema,
  documentId: z.string().trim().min(1).max(160),
}).strict();
export type WorkOrderAttachmentPayload = z.output<typeof workOrderAttachmentPayloadSchema>;

export const WORK_ORDER_COMMAND_KINDS = [
  "work_order.create",
  "work_order.update",
  "work_order.status.change",
  "work_order.note.add",
  "work_order.project.link",
  "work_order.chargeback.set",
  "work_order.chargeback.clear",
  "work_order.vendor.assign",
  "work_order.cost.link",
  "work_order.cost.unlink",
  "work_order.actual.set",
  "work_order.attachment.link",
  "work_order.attachment.unlink",
] as const;
export type WorkOrderCommandKind = (typeof WORK_ORDER_COMMAND_KINDS)[number];

export const workOrderCommandPayloadSchemas = {
  "work_order.create": createWorkOrderPayloadSchema,
  "work_order.update": updateWorkOrderPayloadSchema,
  "work_order.status.change": changeWorkOrderStatusPayloadSchema,
  "work_order.note.add": addWorkOrderNotePayloadSchema,
  "work_order.project.link": linkWorkOrderProjectPayloadSchema,
  "work_order.chargeback.set": setWorkOrderChargebackPayloadSchema,
  "work_order.chargeback.clear": clearWorkOrderChargebackPayloadSchema,
  "work_order.vendor.assign": assignWorkOrderVendorPayloadSchema,
  "work_order.cost.link": linkWorkOrderCostPayloadSchema,
  "work_order.cost.unlink": unlinkWorkOrderCostPayloadSchema,
  "work_order.actual.set": setWorkOrderManualActualPayloadSchema,
  "work_order.attachment.link": workOrderAttachmentPayloadSchema,
  "work_order.attachment.unlink": workOrderAttachmentPayloadSchema,
} as const;

/** Commands that edit an existing record must carry the revision the caller read. */
export const WORK_ORDER_REVISIONED_COMMANDS: readonly WorkOrderCommandKind[] = [
  "work_order.update",
  "work_order.status.change",
  "work_order.project.link",
  "work_order.chargeback.set",
  "work_order.chargeback.clear",
  "work_order.vendor.assign",
  "work_order.cost.link",
  "work_order.cost.unlink",
  "work_order.actual.set",
  "work_order.attachment.link",
  "work_order.attachment.unlink",
];

/** Codex tool names; every tool calls the same shared command service as the browser. */
export const WORK_ORDER_MCP_TOOL_NAMES: Readonly<Record<WorkOrderCommandKind, string>> = Object.freeze({
  "work_order.create": "create_work_order",
  "work_order.update": "update_work_order",
  "work_order.status.change": "change_work_order_status",
  "work_order.note.add": "add_work_order_note",
  "work_order.project.link": "link_work_order_project",
  "work_order.chargeback.set": "set_work_order_chargeback",
  "work_order.chargeback.clear": "clear_work_order_chargeback",
  "work_order.vendor.assign": "assign_work_order_vendor",
  "work_order.cost.link": "link_work_order_cost",
  "work_order.cost.unlink": "unlink_work_order_cost",
  "work_order.actual.set": "set_work_order_manual_actual",
  "work_order.attachment.link": "link_work_order_attachment",
  "work_order.attachment.unlink": "unlink_work_order_attachment",
});

export const workOrderVendorOptionsResponseSchema = z.object({ items: z.array(workOrderVendorSchema.extend({ status: z.string().min(1).max(40) }).strict()).max(500) }).strict();
export type WorkOrderVendorOptionsResponse = z.infer<typeof workOrderVendorOptionsResponseSchema>;

export const workOrderDocumentOptionSchema = z.object({
  documentId: z.string().min(1).max(160),
  title: z.string().min(1).max(240),
  kind: z.string().min(1).max(80),
  documentDate: isoDateSchema.nullable(),
  propertyId: z.string().nullable(),
}).strict();
export const workOrderDocumentOptionsResponseSchema = z.object({ items: z.array(workOrderDocumentOptionSchema).max(200) }).strict();
export type WorkOrderDocumentOptionsResponse = z.infer<typeof workOrderDocumentOptionsResponseSchema>;

export interface WorkOrderReadContext {
  readonly scope: CompanyScope;
}
