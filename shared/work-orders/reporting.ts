import { z } from "zod";
import {
  canonicalUuidSchema,
  companyScopeSchema,
  currencyCodeSchema,
  isoDateSchema,
  legalEntityIdSchema,
  propertyReferenceIdSchema,
} from "../company";
import {
  WORK_ORDER_CATEGORIES,
  WORK_ORDER_PRIORITIES,
  nonNegativeWorkOrderCentsSchema,
  workOrderCategorySchema,
  workOrderIdSchema,
  workOrderPrioritySchema,
  workOrderStatusSchema,
  workOrderVendorSchema,
} from "./contracts";
import { WORK_ORDER_STATUSES } from "./transitions";

/**
 * Bounded, cursor-paged read used by the reporting engine. It exposes the
 * same scoped rows as the workspace list with the fields reports need:
 * aging, target date, estimated and actual cost, completion and vendor.
 */
export const workOrderReportQuerySchema = z.object({
  scope: companyScopeSchema,
  asOf: isoDateSchema.optional(),
  propertyIds: z.array(propertyReferenceIdSchema).min(1).max(200).optional(),
  statuses: z.array(workOrderStatusSchema).min(1).max(WORK_ORDER_STATUSES.length).optional(),
  priorities: z.array(workOrderPrioritySchema).min(1).max(WORK_ORDER_PRIORITIES.length).optional(),
  categories: z.array(workOrderCategorySchema).min(1).max(WORK_ORDER_CATEGORIES.length).optional(),
  assignee: z.string().trim().min(1).max(200).optional(),
  vendorId: canonicalUuidSchema.optional(),
  /** Inclusive window on the derived target (due) date. */
  dueFrom: isoDateSchema.optional(),
  dueThrough: isoDateSchema.optional(),
  reportedFrom: isoDateSchema.optional(),
  reportedThrough: isoDateSchema.optional(),
  limit: z.number().int().min(1).max(500).default(200),
  cursor: z.string().trim().min(1).max(512).optional(),
}).strict().superRefine((value, context) => {
  if (value.dueFrom && value.dueThrough && value.dueThrough < value.dueFrom) context.addIssue({ code: z.ZodIssueCode.custom, path: ["dueThrough"], message: "dueThrough must be on or after dueFrom" });
  if (value.reportedFrom && value.reportedThrough && value.reportedThrough < value.reportedFrom) context.addIssue({ code: z.ZodIssueCode.custom, path: ["reportedThrough"], message: "reportedThrough must be on or after reportedFrom" });
});
export type WorkOrderReportQuery = z.input<typeof workOrderReportQuerySchema>;
export type ParsedWorkOrderReportQuery = z.output<typeof workOrderReportQuerySchema>;

export const workOrderReportRowSchema = z.object({
  id: workOrderIdSchema,
  reference: z.string().regex(/^WO-[0-9A-F]{8}$/),
  legalEntityId: legalEntityIdSchema,
  propertyId: propertyReferenceIdSchema,
  propertyName: z.string().nullable(),
  unitId: z.string().nullable(),
  unitNumber: z.string().nullable(),
  projectId: canonicalUuidSchema.nullable(),
  title: z.string().min(1).max(200),
  category: workOrderCategorySchema,
  priority: workOrderPrioritySchema,
  status: workOrderStatusSchema,
  reportedOn: isoDateSchema,
  scheduledOn: isoDateSchema.nullable(),
  targetOn: isoDateSchema,
  completedOn: isoDateSchema.nullable(),
  agingDays: z.number().int().nonnegative(),
  overdue: z.boolean(),
  assignedTo: z.string().nullable(),
  vendor: workOrderVendorSchema.nullable(),
  currency: currencyCodeSchema,
  estimatedCostCents: nonNegativeWorkOrderCentsSchema.nullable(),
  /** QBO bill lines allocated to the work order (verified source identities). */
  linkedActualCents: nonNegativeWorkOrderCentsSchema,
  manualActualCents: nonNegativeWorkOrderCentsSchema.nullable(),
  actualCostState: z.enum(["verified", "manual", "none"]),
  completed: z.boolean(),
  daysToComplete: z.number().int().nonnegative().nullable(),
}).strict();
export type WorkOrderReportRow = z.infer<typeof workOrderReportRowSchema>;

export const workOrderReportPageSchema = z.object({
  asOf: isoDateSchema,
  items: z.array(workOrderReportRowSchema).max(500),
  nextCursor: z.string().min(1).max(512).nullable(),
}).strict();
export type WorkOrderReportPage = z.infer<typeof workOrderReportPageSchema>;
