import { z } from "zod";
import {
  APPLICATION_STATUSES,
  HAP_CONTRACT_STATUSES,
  LISTING_STATES,
  OCCUPANCY_STATES,
  READINESS_STATES,
} from "./rent-ops-contracts";

/** Canonical report keys are the stable identifiers used by the catalog. */
export const REPORT_KEYS = [
  "rent-roll",
  "occupancy",
  "scheduled-income",
  "collected-income",
  "scheduled-vs-collected",
  "delinquency",
  "tenant-ledger",
  "lease-expiration",
  "security-deposit",
  "applicant-pipeline",
  "hap",
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];
export const ReportKeySchema = z.enum(REPORT_KEYS);

/** MCP/REST aliases remain accepted by discovery and execution surfaces. */
export const MCP_REPORT_KEYS = [
  "rent-roll",
  "occupancy",
  "scheduled-income",
  "collected-income",
  "scheduled-vs-collected",
  "delinquency",
  "tenant-ledger",
  "lease-expirations",
  "deposits",
  "applicant-pipeline",
  "hap",
] as const;
export type McpReportKey = (typeof MCP_REPORT_KEYS)[number];
export const McpReportSchema = z.enum(MCP_REPORT_KEYS);

export const REPORT_KEY_ALIASES: Readonly<Record<McpReportKey, ReportKey>> = {
  "rent-roll": "rent-roll",
  occupancy: "occupancy",
  "scheduled-income": "scheduled-income",
  "collected-income": "collected-income",
  "scheduled-vs-collected": "scheduled-vs-collected",
  delinquency: "delinquency",
  "tenant-ledger": "tenant-ledger",
  "lease-expirations": "lease-expiration",
  deposits: "security-deposit",
  "applicant-pipeline": "applicant-pipeline",
  hap: "hap",
};

export const REPORT_FILTER_KINDS = ["date", "month", "select", "multi_select", "text", "reference"] as const;
export type ReportFilterKind = (typeof REPORT_FILTER_KINDS)[number];

/** Canonical wire names already accepted by rentOpsFiltersSchema. */
export const REPORT_FILTER_NAMES = [
  "propertyScope",
  "propertyId",
  "propertyIds",
  "unitId",
  "tenancyId",
  "personId",
  "asOfDate",
  "fromDate",
  "toDate",
  "month",
  "occupancy",
  "readiness",
  "listing",
  "balanceStatus",
  "tenantStatus",
  "status",
  "search",
] as const;
export type ReportFilterName = (typeof REPORT_FILTER_NAMES)[number];
export const ReportFilterNameSchema = z.enum(REPORT_FILTER_NAMES);

export const REPORT_FILTER_REFERENCES = ["property", "unit", "tenancy", "person"] as const;
export type ReportFilterReference = (typeof REPORT_FILTER_REFERENCES)[number];

export const REPORT_FILTER_DATE_MODES = ["as_of", "report_month", "activity_range"] as const;
export type ReportFilterDateMode = (typeof REPORT_FILTER_DATE_MODES)[number];

export const ReportFilterOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
}).strict();
export type ReportFilterOption = z.infer<typeof ReportFilterOptionSchema>;

export const ReportFilterDateSemanticsSchema = z.object({
  mode: z.enum(REPORT_FILTER_DATE_MODES),
  inclusive: z.boolean().optional(),
  pairedWith: ReportFilterNameSchema.optional(),
  lookaheadDays: z.number().int().positive().optional(),
}).strict();
export type ReportFilterDateSemantics = z.infer<typeof ReportFilterDateSemanticsSchema>;

/**
 * A serializable field definition shared by the report catalog, browser and
 * Codex. Reference fields identify the lookup family; their values are
 * populated from the authorized report context rather than this metadata.
 */
export const ReportFilterDefinitionSchema = z.object({
  name: ReportFilterNameSchema,
  kind: z.enum(REPORT_FILTER_KINDS),
  label: z.string().min(1),
  options: z.array(ReportFilterOptionSchema).min(1).optional(),
  reference: z.enum(REPORT_FILTER_REFERENCES).optional(),
  multiple: z.boolean().optional(),
  acceptedAliases: z.array(z.string().regex(/^[a-z][A-Za-z0-9]*$/)).min(1).optional(),
  default: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  dateSemantics: ReportFilterDateSemanticsSchema.optional(),
  exclusiveGroup: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
}).strict().superRefine((definition, context) => {
  if (["select", "multi_select"].includes(definition.kind) && !definition.options) {
    context.addIssue({ code: "custom", message: "Choice filters require options." });
  }
  if (definition.kind === "reference" && !definition.reference) {
    context.addIssue({ code: "custom", message: "Reference filters require a reference family." });
  }
  if (definition.kind !== "reference" && definition.reference) {
    context.addIssue({ code: "custom", message: "Only reference filters may declare a reference family." });
  }
  if (!["date", "month"].includes(definition.kind) && definition.dateSemantics) {
    context.addIssue({ code: "custom", message: "Date semantics are only valid for date and month filters." });
  }
  if (["date", "month"].includes(definition.kind) && !definition.dateSemantics) {
    context.addIssue({ code: "custom", message: "Date and month filters require date semantics." });
  }
  if (!["multi_select", "reference"].includes(definition.kind) && definition.multiple) {
    context.addIssue({ code: "custom", message: "Only multi-select and reference filters may be marked multiple." });
  }
});
export type ReportFilterDefinition = z.infer<typeof ReportFilterDefinitionSchema>;

export const ReportFilterDefinitionsSchema = z.array(ReportFilterDefinitionSchema).min(1).superRefine((definitions, context) => {
  const names = new Set<string>();
  definitions.forEach((definition, index) => {
    if (names.has(definition.name)) {
      context.addIssue({ code: "custom", path: [index, "name"], message: "Filter names must be unique within a report." });
    }
    names.add(definition.name);
    if (definition.default === undefined || !definition.options) return;
    const values = new Set(definition.options.map((item) => item.value));
    const defaults = Array.isArray(definition.default) ? definition.default : [definition.default];
    defaults.forEach((value) => {
      if (!values.has(value)) context.addIssue({ code: "custom", path: [index, "default"], message: `Default ${value} is not a declared option.` });
    });
  });
});

const option = (value: string, label: string): ReportFilterOption => ({ value, label });
const options = (values: readonly string[], labels: Record<string, string> = {}): ReportFilterOption[] => values.map((value) => option(value, labels[value] ?? value));

const propertyScope = (): ReportFilterDefinition[] => [
  {
    name: "propertyScope",
    kind: "select",
    label: "Property scope",
    options: [option("active", "Active portfolio"), option("all", "All properties")],
    default: "active",
  },
  {
    name: "propertyIds",
    kind: "reference",
    reference: "property",
    multiple: true,
    label: "Properties",
    acceptedAliases: ["propertyId"],
  },
];

const unit = (): ReportFilterDefinition => ({ name: "unitId", kind: "reference", reference: "unit", label: "Unit" });
const tenancy = (): ReportFilterDefinition => ({ name: "tenancyId", kind: "reference", reference: "tenancy", label: "Tenancy" });
const person = (): ReportFilterDefinition => ({ name: "personId", kind: "reference", reference: "person", label: "Tenant" });
const asOf = (label = "As of date", lookaheadDays?: number): ReportFilterDefinition => ({ name: "asOfDate", kind: "date", label, dateSemantics: { mode: "as_of", inclusive: true, ...(lookaheadDays ? { lookaheadDays } : {}) } });
const month = (exclusiveGroup = "report_period"): ReportFilterDefinition => ({ name: "month", kind: "month", label: "Report month", dateSemantics: { mode: "report_month" }, exclusiveGroup });
const fromDate = (exclusiveGroup = "report_period"): ReportFilterDefinition => ({ name: "fromDate", kind: "date", label: "Activity from", dateSemantics: { mode: "activity_range", inclusive: true, pairedWith: "toDate" }, exclusiveGroup });
const toDate = (exclusiveGroup = "report_period"): ReportFilterDefinition => ({ name: "toDate", kind: "date", label: "Activity through", dateSemantics: { mode: "activity_range", inclusive: true, pairedWith: "fromDate" }, exclusiveGroup });
const tenantStatus = (): ReportFilterDefinition => ({
  name: "tenantStatus",
  kind: "select",
  label: "Tenant status",
  options: options(["all", "current", "former", "future", "unknown"], {
    all: "All tenant statuses",
    current: "Current",
    former: "Former",
    future: "Future",
    unknown: "Unknown",
  }),
  default: "current",
});
const search = (): ReportFilterDefinition => ({ name: "search", kind: "text", label: "Search" });
const multi = (name: ReportFilterName, label: string, values: readonly string[], labels: Record<string, string> = {}): ReportFilterDefinition => ({ name, kind: "multi_select", label, options: options(values, labels) });
const select = (name: ReportFilterName, label: string, values: readonly string[], labels: Record<string, string> = {}): ReportFilterDefinition => ({ name, kind: "select", label, options: options(values, labels) });

const balanceStatus = (values: readonly string[] = ["all", "due", "credit", "zero", "unverified"], defaultValue = "all"): ReportFilterDefinition => ({
  ...select("balanceStatus", "Balance status", values, {
  all: "All balances",
  due: "Due",
  credit: "Credit",
  zero: "Zero",
  unverified: "Unverified",
  }),
  default: defaultValue,
});

const reportFilters: Readonly<Record<ReportKey, readonly ReportFilterDefinition[]>> = {
  "rent-roll": [
    ...propertyScope(), asOf(), unit(),
    { ...multi("occupancy", "Occupancy", OCCUPANCY_STATES, { current: "Current", future_preleased: "Future preleased", vacant: "Vacant", unknown: "Unknown" }), default: ["current"] },
    multi("readiness", "Readiness", READINESS_STATES, { ready: "Ready", not_ready: "Not ready", off_market: "Off market" }),
    multi("listing", "Listing", LISTING_STATES, { listed: "Listed", unlisted: "Unlisted", off_market: "Off market" }),
    balanceStatus(), search(),
  ],
  occupancy: [
    ...propertyScope(), asOf(), unit(),
    { ...multi("occupancy", "Occupancy", OCCUPANCY_STATES, { current: "Current", future_preleased: "Future preleased", vacant: "Vacant", unknown: "Unknown" }), default: ["vacant"] },
    multi("readiness", "Readiness", READINESS_STATES, { ready: "Ready", not_ready: "Not ready", off_market: "Off market" }),
    multi("listing", "Listing", LISTING_STATES, { listed: "Listed", unlisted: "Unlisted", off_market: "Off market" }),
  ],
  "scheduled-income": [
    ...propertyScope(), asOf(), month(), unit(), tenantStatus(), search(),
  ],
  "collected-income": [
    ...propertyScope(), asOf(), month(), fromDate(), toDate(), unit(), tenancy(), person(), tenantStatus(), search(),
  ],
  "scheduled-vs-collected": [
    ...propertyScope(), asOf(), month(), unit(), tenantStatus(), search(),
  ],
  delinquency: [
    ...propertyScope(), asOf(), unit(), tenantStatus(), balanceStatus(["all", "due", "credit", "zero"], "due"), search(),
  ],
  "tenant-ledger": [
    ...propertyScope(), asOf(), fromDate("ledger_period"), toDate("ledger_period"), unit(), tenancy(), person(), tenantStatus(),
  ],
  "lease-expiration": [
    ...propertyScope(), asOf("As of date", 90), tenantStatus(), multi("status", "Lease action status", ["expiring", "month_to_month", "not_due"], { expiring: "Expiring within 90 days", month_to_month: "Month to month", not_due: "Not due" }), search(),
  ],
  "security-deposit": [
    ...propertyScope(), asOf(), unit(), tenantStatus(), search(),
  ],
  "applicant-pipeline": [
    ...propertyScope(), asOf(), multi("status", "Application status", APPLICATION_STATUSES, {
      complete: "Complete",
      in_progress: "In progress",
      awaiting_payment: "Awaiting payment",
      draft: "Draft",
      submitted: "Submitted",
      missing_information: "Missing information",
      under_review: "Under review",
      approved: "Approved",
      declined: "Declined",
      withdrawn: "Withdrawn",
      converted: "Converted",
    }), search(),
  ],
  hap: [
    ...propertyScope(), asOf(), month(), tenantStatus(), multi("status", "HAP contract status", HAP_CONTRACT_STATUSES.filter((status) => status !== "pending"), { active: "Active", ended: "Ended", exception: "Exception" }), search(),
  ],
};

function canonicalReportKey(value: string): ReportKey | undefined {
  if ((REPORT_KEYS as readonly string[]).includes(value)) return value as ReportKey;
  return Object.hasOwn(REPORT_KEY_ALIASES, value) ? REPORT_KEY_ALIASES[value as McpReportKey] : undefined;
}

/** Returns an independently validated copy of the report's filter metadata. */
export function getReportFilterDefinition(reportKey: string): ReportFilterDefinition[] | undefined {
  const canonical = canonicalReportKey(reportKey);
  if (!canonical) return undefined;
  return ReportFilterDefinitionsSchema.parse(reportFilters[canonical]);
}

/** Validated definitions used while constructing the catalog. */
export function getAllReportFilterDefinitions(): Readonly<Record<ReportKey, readonly ReportFilterDefinition[]>> {
  const copy = {} as Record<ReportKey, readonly ReportFilterDefinition[]>;
  for (const reportKey of REPORT_KEYS) copy[reportKey] = getReportFilterDefinition(reportKey)!;
  return copy;
}
