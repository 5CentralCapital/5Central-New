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
  /** Only a link to an already posted tenant charge; R-ops never posts one from a work order. */
  ledgerTransactionId: rentalReferenceSchema.nullable(),
  state: z.enum(["intent_only", "charge_linked"]),
}).strict();
export type WorkOrderChargeback = z.infer<typeof workOrderChargebackSchema>;

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
  entryPermitted: z.boolean(),
  currency: currencyCodeSchema,
  estimatedCostCents: nonNegativeWorkOrderCentsSchema.nullable(),
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

export const workOrderDetailSchema = workOrderSummarySchema.extend({
  description: z.string().nullable(),
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
  search: z.string().trim().max(200).optional(),
  openOnly: z.boolean().default(true),
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

export const WORK_ORDER_COMMAND_KINDS = [
  "work_order.create",
  "work_order.update",
  "work_order.status.change",
  "work_order.note.add",
  "work_order.project.link",
  "work_order.chargeback.set",
  "work_order.chargeback.clear",
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
} as const;

/** Commands that edit an existing record must carry the revision the caller read. */
export const WORK_ORDER_REVISIONED_COMMANDS: readonly WorkOrderCommandKind[] = [
  "work_order.update",
  "work_order.status.change",
  "work_order.project.link",
  "work_order.chargeback.set",
  "work_order.chargeback.clear",
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
});

export interface WorkOrderReadContext {
  readonly scope: CompanyScope;
}
