import { z } from "zod";
import { isoDateSchema, isoTimestampSchema } from "./dates";
import { currencyCodeSchema } from "./identifiers";
import { legalEntityIdSchema, organizationIdSchema, propertyReferenceIdSchema, recordIdSchema, revisionSchema } from "./identifiers";
import type { IsoDate } from "./dates";
import type { LegalEntityId } from "./identifiers";

const text = (max: number) => z.string().trim().min(1).max(max);
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();

export const propertySetupAddressSchema = z.object({
  line1: text(200),
  line2: z.string().trim().max(100).nullable().optional(),
  city: text(100),
  state: z.string().trim().length(2).transform(value => value.toUpperCase()),
  postalCode: text(20),
}).strict();
export type PropertySetupAddress = z.infer<typeof propertySetupAddressSchema>;

export const PROPERTY_SETUP_TYPES = ["multifamily", "single_family", "other"] as const;
export const propertySetupTypeSchema = z.enum(PROPERTY_SETUP_TYPES);
export type PropertySetupType = (typeof PROPERTY_SETUP_TYPES)[number];

export const PROPERTY_SETUP_STATES = ["active", "archived"] as const;
export const propertySetupStateSchema = z.enum(PROPERTY_SETUP_STATES);
export type PropertySetupState = (typeof PROPERTY_SETUP_STATES)[number];

export const PROPERTY_ASSOCIATION_TYPES = ["legal", "planned"] as const;
export const propertyAssociationTypeSchema = z.enum(PROPERTY_ASSOCIATION_TYPES);
export type PropertyAssociationType = (typeof PROPERTY_ASSOCIATION_TYPES)[number];

export const PROPERTY_PLAN_STATUSES = ["planned", "converted", "cancelled"] as const;
export const propertyPlanStatusSchema = z.enum(PROPERTY_PLAN_STATUSES);
export type PropertyPlanStatus = (typeof PROPERTY_PLAN_STATUSES)[number];

/**
 * A setup command intentionally accepts no caller supplied property ID. The
 * server creates the canonical ID and commits the property plus either its
 * legal-entity period or its separate planning association together. Planned
 * setup never creates a legal period, so it cannot expose an unacquired
 * property through the normal company context.
 */
export const propertySetupPayloadSchema = z.object({
  name: text(200),
  slug: z.string().trim().min(1).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must use lowercase letters, numbers, and hyphens"),
  address: propertySetupAddressSchema,
  propertyType: propertySetupTypeSchema,
  state: propertySetupStateSchema.default("active"),
  operatingContact: nullableText(160),
  associationType: propertyAssociationTypeSchema.default("legal"),
  effectiveFrom: isoDateSchema.optional(),
  assignmentStartOn: isoDateSchema.optional(),
  notes: nullableText(4_000),
}).strict().superRefine((value, context) => {
  if (value.associationType === "legal") {
    if (value.effectiveFrom === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveFrom"], message: "A legal-entity mapping start date is required" });
    if (value.assignmentStartOn !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ["assignmentStartOn"], message: "Planning assignment date is only valid for a planned property" });
    if (value.notes !== undefined && value.notes !== null) context.addIssue({ code: z.ZodIssueCode.custom, path: ["notes"], message: "Planning notes are only valid for a planned property" });
  } else {
    if (value.assignmentStartOn === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ["assignmentStartOn"], message: "A planning assignment start date is required" });
    if (value.effectiveFrom !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveFrom"], message: "A legal-entity mapping date is only valid for an acquired property" });
  }
});
export type PropertySetupPayload = z.output<typeof propertySetupPayloadSchema>;

export const propertyPlanConvertPayloadSchema = z.object({
  planId: recordIdSchema,
  effectiveFrom: isoDateSchema,
}).strict();
export type PropertyPlanConvertPayload = z.output<typeof propertyPlanConvertPayloadSchema>;

export const PROPERTY_COMMAND_KINDS = ["property.setup", "property.plan.convert"] as const;
export type PropertyCommandKind = (typeof PROPERTY_COMMAND_KINDS)[number];
export const propertyCommandPayloadSchemas = {
  "property.setup": propertySetupPayloadSchema,
  "property.plan.convert": propertyPlanConvertPayloadSchema,
} as const;

export interface PropertySetupScope {
  readonly organizationId: string;
  readonly legalEntityId: LegalEntityId;
}

/** Used by adapters that need to assert a legal-entity-only setup scope. */
export const propertySetupScopeSchema = z.object({
  organizationId: z.string().min(1).max(160),
  legalEntityId: legalEntityIdSchema,
}).strict();

export type PropertySetupEffectiveFrom = IsoDate;

export const plannedPropertyPlanSchema = z.object({
  id: recordIdSchema,
  organizationId: organizationIdSchema,
  legalEntityId: legalEntityIdSchema,
  propertyId: propertyReferenceIdSchema,
  propertyName: text(200),
  legalEntityName: text(200),
  currency: currencyCodeSchema,
  assignmentStartOn: isoDateSchema,
  status: propertyPlanStatusSchema,
  notes: z.string().trim().max(4_000).nullable(),
  recordRevision: revisionSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).strict();
export type PlannedPropertyPlan = z.infer<typeof plannedPropertyPlanSchema>;

export const plannedPropertyPlanListSchema = z.object({
  items: z.array(plannedPropertyPlanSchema).max(10_000),
}).strict();
export type PlannedPropertyPlanList = z.infer<typeof plannedPropertyPlanListSchema>;
