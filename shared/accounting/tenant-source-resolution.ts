import { z } from "zod";
import {
  isoDateSchema,
  isoTimestampSchema,
  legalEntityIdSchema,
  organizationIdSchema,
  propertyReferenceIdSchema,
} from "../company";
import {
  financialSourceEnvironmentSchema,
  financialSourceScopeSchema,
} from "./source";

/** The source states a tenancy read may expose to a manager screen. */
export const TENANT_SOURCE_RESOLUTION_STATES = [
  "linked",
  "unlinked",
  "local_history_available",
  "not_connected",
  "ownership_review",
] as const;
export type TenantSourceResolutionState = (typeof TENANT_SOURCE_RESOLUTION_STATES)[number];
export const tenantSourceResolutionStateSchema = z.enum(TENANT_SOURCE_RESOLUTION_STATES);

export const TENANT_OWNERSHIP_STATES = ["resolved", "review"] as const;
export type TenantOwnershipState = (typeof TENANT_OWNERSHIP_STATES)[number];
export const tenantOwnershipStateSchema = z.enum(TENANT_OWNERSHIP_STATES);

export const TENANT_LOCAL_HISTORY_STATES = ["local_history_available", "local_history_unavailable"] as const;
export type TenantLocalHistoryState = (typeof TENANT_LOCAL_HISTORY_STATES)[number];
export const tenantLocalHistoryStateSchema = z.enum(TENANT_LOCAL_HISTORY_STATES);

export const TENANT_QBO_STATES = ["linked", "unlinked", "not_connected", "ownership_review"] as const;
export type TenantQboState = (typeof TENANT_QBO_STATES)[number];
export const tenantQboStateSchema = z.enum(TENANT_QBO_STATES);

export const TENANT_QBO_CONNECTION_STATES = ["active", "needs_reconnect", "revoked", "missing"] as const;
export type TenantQboConnectionState = (typeof TENANT_QBO_CONNECTION_STATES)[number];
export const tenantQboConnectionStateSchema = z.enum(TENANT_QBO_CONNECTION_STATES);

const tenantIdSchema = z.string().trim().min(1).max(160).regex(/^[^\u0000-\u001f\u007f]+$/);
const statusSchema = z.string().trim().min(1).max(80);
const reasonSchema = z.string().trim().min(1).max(500);

const tenancySchema = z.object({
  status: statusSchema.nullable(),
  propertyId: propertyReferenceIdSchema,
  unitId: z.string().trim().min(1).max(160),
  startOn: isoDateSchema.nullable(),
  endOn: isoDateSchema.nullable(),
}).strict();

const ownershipPeriodSchema = z.object({
  legalEntityId: legalEntityIdSchema,
  legalEntityName: z.string().trim().min(1).max(200),
  effectiveFrom: isoDateSchema,
  effectiveUntil: isoDateSchema.nullable(),
  overlapsTenancy: z.boolean(),
}).strict();

const qboBindingSchema = z.object({
  realmId: z.string().regex(/^\d{1,32}$/),
  providerCompanyName: z.string().trim().min(1).max(255).nullable(),
}).strict();

const qboConnectionSchema = z.object({
  state: tenantQboConnectionStateSchema,
  realmId: z.string().regex(/^\d{1,32}$/),
  readCapabilityEnabled: z.boolean(),
  updatedAt: isoTimestampSchema.nullable(),
}).strict();

const customerLinkSchema = z.object({
  customerObjectId: z.string().trim().min(1).max(200),
  legalEntityId: legalEntityIdSchema,
}).strict();

/**
 * Read-only source resolution for one Rent Ops tenancy.  Local history and
 * QuickBooks state are deliberately separate: a local record does not prove
 * that a QuickBooks company is connected or that a customer is linked.
 */
export const tenantSourceResolutionSchema = z.object({
  kind: z.literal("tenant_source_resolution"),
  organizationId: organizationIdSchema,
  tenancyId: tenantIdSchema,
  asOf: isoDateSchema,
  tenancy: tenancySchema,
  local: z.object({
    state: tenantLocalHistoryStateSchema,
    sourceSystem: z.literal("rent_ops"),
    ledgerEntryCount: z.number().int().nonnegative(),
  }).strict(),
  ownership: z.object({
    state: tenantOwnershipStateSchema,
    coverageComplete: z.boolean(),
    propertyName: z.string().trim().min(1).max(200).nullable(),
    periods: z.array(ownershipPeriodSchema).max(1_000),
    effectiveLegalEntityId: legalEntityIdSchema.nullable(),
    effectiveLegalEntityName: z.string().trim().min(1).max(200).nullable(),
  }).strict(),
  qbo: z.object({
    environment: financialSourceEnvironmentSchema,
    state: tenantQboStateSchema,
    scope: financialSourceScopeSchema.nullable(),
    binding: qboBindingSchema.nullable(),
    connection: qboConnectionSchema.nullable(),
    customerLink: customerLinkSchema.nullable(),
  }).strict(),
  currentState: tenantSourceResolutionStateSchema,
  reasons: z.array(reasonSchema).max(10),
}).strict();

export type TenantSourceResolution = z.infer<typeof tenantSourceResolutionSchema>;
