import { z } from "zod";

/**
 * Read models for the manager workspace pages that combine rental and company
 * data. Money is exact signed cents as a decimal string. A null amount is
 * unknown — never zero — and `complete: false` marks totals that exclude
 * unknown contributors.
 */
const cents = z.string().regex(/^(0|-?[1-9]\d{0,18})$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoMonth = z.string().regex(/^\d{4}-\d{2}$/);

export const workspaceRecordLinkSchema = z.object({
  kind: z.enum(["tenant", "unit", "property", "project", "work_order", "settlement", "report"]),
  id: z.string().min(1).max(200),
  /** Tenant record tab or report key used by the browser to open the record. */
  view: z.string().max(80).optional(),
}).strict();
export type WorkspaceRecordLink = z.infer<typeof workspaceRecordLinkSchema>;

export const financialMeasureRecordSchema = z.object({
  label: z.string().max(240),
  detail: z.string().max(240).nullable(),
  date: isoDate.nullable(),
  amountCents: cents.nullable(),
  link: workspaceRecordLinkSchema.nullable(),
  /** Source-system references (for example QBO IDs) shown only in record detail. */
  sourceReferences: z.array(z.string().max(200)).max(20),
}).strict();
export type FinancialMeasureRecord = z.infer<typeof financialMeasureRecordSchema>;

export const FINANCIAL_MEASURE_KEYS = [
  "scheduled_rent", "scheduled_other_charges", "charges_posted", "tenant_collections", "subsidy_collections", "other_collections",
  "arrears", "deposits_held", "pm_gross_collections", "pm_fees", "pm_expenses", "owner_remittances", "manager_held_funds",
  "project_spending_posted", "project_costs_recorded",
] as const;
export type FinancialMeasureKey = (typeof FINANCIAL_MEASURE_KEYS)[number];

export const financialMeasureSchema = z.object({
  key: z.enum(FINANCIAL_MEASURE_KEYS),
  label: z.string().max(120),
  group: z.enum(["rental", "collections", "balances", "manager", "projects"]),
  /** Short statement of what is counted and on which date basis. */
  basis: z.string().max(240),
  state: z.enum(["available", "unavailable"]),
  /** Why the measure is unavailable (no company mapping, no PM statements, …). */
  unavailableReason: z.string().max(240).nullable(),
  amountCents: cents.nullable(),
  complete: z.boolean(),
  unknownCount: z.number().int().min(0),
  recordCount: z.number().int().min(0),
  records: z.array(financialMeasureRecordSchema).max(200),
  /** Report that lists the same contributing rows, when one exists. */
  report: z.string().max(80).nullable(),
}).strict();
export type FinancialMeasure = z.infer<typeof financialMeasureSchema>;

export const propertyFinancialsSchema = z.object({
  propertyId: z.string().min(1).max(160),
  propertyName: z.string().max(240),
  period: z.object({ month: isoMonth, from: isoDate, to: isoDate, asOf: isoDate }).strict(),
  currency: z.literal("USD"),
  company: z.object({
    organizationId: z.string().uuid(),
    legalEntityId: z.string().uuid().nullable(),
    legalEntityName: z.string().nullable(),
  }).strict().nullable(),
  measures: z.array(financialMeasureSchema),
}).strict();
export type PropertyFinancials = z.infer<typeof propertyFinancialsSchema>;

export const propertyPerformanceRowSchema = z.object({
  propertyId: z.string().min(1).max(160),
  propertyName: z.string().max(240),
  state: z.string().max(40).nullable(),
  unitCount: z.number().int().min(0),
  occupiedUnits: z.number().int().min(0),
  unknownOccupancyUnits: z.number().int().min(0),
  scheduledRentCents: cents.nullable(),
  scheduledRentComplete: z.boolean(),
  collectedCents: cents.nullable(),
  collectedComplete: z.boolean(),
  arrearsCents: cents.nullable(),
  arrearsComplete: z.boolean(),
  /** Null when the property is not mapped to an authorized company entity. */
  openWorkOrders: z.number().int().min(0).nullable(),
  activeProjects: z.number().int().min(0).nullable(),
  projectEstimateCents: cents.nullable(),
  projectPostedCents: cents.nullable(),
  /** False when QuickBooks coverage is partial: the posted amount is then a minimum. */
  projectPostedComplete: z.boolean(),
  legalEntityName: z.string().nullable(),
}).strict();
export type PropertyPerformanceRow = z.infer<typeof propertyPerformanceRowSchema>;

export const propertyPerformanceSchema = z.object({
  period: z.object({ month: isoMonth, asOf: isoDate }).strict(),
  companyAvailable: z.boolean(),
  rows: z.array(propertyPerformanceRowSchema).max(1000),
}).strict();
export type PropertyPerformance = z.infer<typeof propertyPerformanceSchema>;

const qboBindingSchema = z.object({
  environment: z.enum(["sandbox", "production"]),
  status: z.enum(["not_connected", "connected", "ready", "needs_reconnect", "revoked"]),
  companyName: z.string().nullable(),
  realmId: z.string().nullable(),
  confirmedAt: z.string().nullable(),
}).strict();

export const entityDirectorySchema = z.object({
  entities: z.array(z.object({
    id: z.string().uuid(),
    name: z.string(),
    entityType: z.string(),
    currency: z.string(),
    qbo: z.array(qboBindingSchema),
    properties: z.array(z.object({
      propertyId: z.string(),
      propertyName: z.string().nullable(),
      effectiveFrom: isoDate,
      effectiveUntil: isoDate.nullable(),
      current: z.boolean(),
    }).strict()),
  }).strict()).max(500),
  unmappedProperties: z.array(z.object({ propertyId: z.string(), propertyName: z.string().nullable() }).strict()).max(1000),
}).strict();
export type EntityDirectory = z.infer<typeof entityDirectorySchema>;

export const PEOPLE_ROLES = ["owner", "investor", "vendor", "employee", "tenant", "property_manager", "lender", "agency", "professional"] as const;
export const peopleDirectorySchema = z.object({
  contacts: z.array(z.object({
    id: z.string().uuid(),
    kind: z.enum(["person", "organization"]),
    displayName: z.string(),
    rentOpsPersonId: z.string().nullable(),
    roles: z.array(z.object({ role: z.enum(PEOPLE_ROLES), legalEntityName: z.string().nullable(), effectiveFrom: isoDate, effectiveUntil: isoDate.nullable() }).strict()),
  }).strict()).max(100),
  nextCursor: z.string().nullable(),
  vendors: z.array(z.object({
    legalEntityName: z.string(),
    displayName: z.string(),
    active: z.boolean(),
    providerObjectId: z.string(),
  }).strict()).max(100),
  vendorsTruncated: z.boolean(),
}).strict();
export type PeopleDirectory = z.infer<typeof peopleDirectorySchema>;

export const companySettingsSchema = z.object({
  organization: z.object({ id: z.string().uuid(), name: z.string() }).strict(),
  grants: z.array(z.object({
    actorId: z.string(),
    role: z.string(),
    legalEntityName: z.string().nullable(),
    propertyName: z.string().nullable(),
    createdAt: z.string(),
  }).strict()).max(500),
  qbo: z.array(qboBindingSchema.extend({ legalEntityName: z.string() })).max(500),
  time: z.array(z.object({ legalEntityName: z.string(), environment: z.enum(["sandbox", "production"]), status: z.enum(["active", "revoked", "needs_reconnect"]), connectedAt: z.string().nullable() }).strict()).max(500),
}).strict();
export type CompanySettings = z.infer<typeof companySettingsSchema>;

export const propertyDocumentsSchema = z.object({
  documents: z.array(z.object({
    id: z.string(),
    propertyId: z.string(),
    propertyName: z.string().nullable(),
    kind: z.string(),
    title: z.string(),
    documentDate: isoDate.nullable(),
    fileName: z.string(),
    uploadedAt: z.string(),
  }).strict()).max(500),
  truncated: z.boolean(),
}).strict();
export type PropertyDocuments = z.infer<typeof propertyDocumentsSchema>;

export const costLibrarySchema = z.object({
  items: z.array(z.object({
    source: z.enum(["template", "completed_project"]),
    sourceId: z.string().uuid(),
    sourceName: z.string(),
    projectType: z.string(),
    description: z.string(),
    category: z.string().nullable(),
    unitLabel: z.string().nullable(),
    /** Decimal quantity as text; never converted through floating point. */
    quantity: z.string(),
    rateCents: cents,
    estimatedCents: cents.nullable(),
    currency: z.string(),
    propertyName: z.string().nullable(),
    /** Last change to a completed project; templates have none. */
    updatedOn: isoDate.nullable(),
  }).strict()).max(200),
  nextCursor: z.string().nullable(),
}).strict();
export type CostLibrary = z.infer<typeof costLibrarySchema>;

export const dashboardCompanySchema = z.object({
  asOf: isoDate,
  obligations: z.object({
    items: z.array(z.object({
      obligationId: z.string().uuid(),
      accountId: z.string().uuid(),
      accountName: z.string(),
      instrumentName: z.string(),
      dueOn: isoDate,
      currency: z.string(),
      expectedCents: cents.nullable(),
      knownMinimumCents: cents,
      paidCents: cents,
      amountComplete: z.boolean(),
    }).strict()).max(50),
    truncated: z.boolean(),
  }).strict(),
  maturities: z.array(z.object({
    instrumentId: z.string().uuid(),
    accountId: z.string().uuid(),
    accountName: z.string(),
    instrumentName: z.string(),
    maturityOn: isoDate,
    currency: z.string(),
    outstandingPrincipalCents: cents.nullable(),
    balloonCents: cents.nullable(),
  }).strict()).max(50),
  reviewCases: z.object({
    available: z.boolean(),
    openCount: z.number().int().min(0),
    topReasons: z.array(z.object({ reasonCode: z.string(), count: z.number().int().min(0), highMaterialityCount: z.number().int().min(0) }).strict()).max(10),
  }).strict(),
  workDue: z.object({
    items: z.array(z.object({
      id: z.string().uuid(),
      title: z.string(),
      propertyId: z.string(),
      propertyName: z.string().nullable(),
      unitId: z.string().nullable(),
      unitNumber: z.string().nullable(),
      priority: z.string(),
      status: z.string(),
      scheduledOn: isoDate.nullable(),
      reportedOn: isoDate,
      overdue: z.boolean(),
    }).strict()).max(50),
    openCount: z.number().int().min(0),
  }).strict(),
}).strict();
export type DashboardCompany = z.infer<typeof dashboardCompanySchema>;
