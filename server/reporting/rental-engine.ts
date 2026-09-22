import { legacyNumberToCents, parseCents } from "../../shared/company";
import { rentOpsFiltersSchema, type FixedReportName, type RentOpsFilters } from "../../shared/rent-ops-contracts";
import type { ReportColumn, ReportRow, ReportingEngineContext, ReportingEngineResult } from "../../shared/reporting";
import { ReportingError } from "./errors";
import { sha256 } from "./utils";

/** The accepted legacy report names are deliberately kept in one place. */
export const RENTAL_REPORT_IDS = [
  "rent-roll", "occupancy", "scheduled-income", "collected-income", "scheduled-vs-collected",
  "delinquency", "tenant-ledger", "lease-expiration", "security-deposit", "applicant-pipeline", "hap",
] as const satisfies readonly FixedReportName[];
export type RentalReportId = (typeof RENTAL_REPORT_IDS)[number];

export interface RentOpsReportReader {
  report(name: FixedReportName, filters?: RentOpsFilters, context?: ReportingEngineContext): Promise<unknown[]>;
}

function canonicalValue(value: unknown, key?: string): unknown {
  if (key?.endsWith("Cents")) {
    if (typeof value === "number") return legacyNumberToCents(value);
    if (typeof value === "string") return parseCents(value);
  }
  if (Array.isArray(value)) return value.map(item => canonicalValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, canonicalValue(item, name)]));
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value };
  return value as Record<string, unknown>;
}

function columnType(values: readonly unknown[], key: string): ReportColumn["type"] {
  if (key.endsWith("Cents")) return "money";
  const sample = values.find(value => value !== null && value !== undefined);
  if (sample === undefined) return "text";
  if (typeof sample === "boolean") return "boolean";
  if (typeof sample === "number") return Number.isInteger(sample) ? "integer" : "decimal";
  if (Array.isArray(sample) || typeof sample === "object") return "json";
  if (/date|on$/i.test(key)) return "date";
  if (/status|state|kind$/i.test(key)) return "status";
  return "text";
}

function labelFor(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ").replace(/^./, value => value.toUpperCase());
}

function rowValues(raw: unknown): Record<string, unknown> {
  const source = asRecord(canonicalValue(raw));
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (/^[a-z][A-Za-z0-9_.-]{0,119}$/.test(key)) values[key] = value;
    else values.raw = { ...(typeof values.raw === "object" && values.raw ? values.raw : {}), [key]: value };
  }
  return values;
}

function periodFilters(context: ReportingEngineContext): Record<string, unknown> {
  const period = context.request.period;
  if (period.mode === "as_of") return { asOfDate: period.asOfDate };
  if (period.mode === "range") return { fromDate: period.fromDate, toDate: period.toDate };
  if (period.mode === "month") return { month: period.month };
  return {
    ...(period.asOfDate ? { asOfDate: period.asOfDate } : {}),
    ...(period.fromDate ? { fromDate: period.fromDate } : {}),
    ...(period.toDate ? { toDate: period.toDate } : {}),
    ...(period.month ? { month: period.month } : {}),
  };
}

function requestFilters(context: ReportingEngineContext): RentOpsFilters {
  const filters: Record<string, unknown> = { ...context.request.filters, ...periodFilters(context) };
  if (context.request.scope.propertyIds.length && filters.propertyIds === undefined) filters.propertyIds = [...context.request.scope.propertyIds];
  if (context.request.scope.unitIds.length === 1 && filters.unitId === undefined) filters.unitId = context.request.scope.unitIds[0];
  if (context.request.scope.tenancyIds.length === 1 && filters.tenancyId === undefined) filters.tenancyId = context.request.scope.tenancyIds[0];
  if (context.request.scope.tenantIds.length === 1 && filters.personId === undefined) filters.personId = context.request.scope.tenantIds[0];
  if (context.request.scope.unitIds.length > 1 || context.request.scope.tenantIds.length > 1 || context.request.scope.tenancyIds.length > 1) {
    throw new ReportingError("report_unavailable", "This rental report requires a single unit, tenant, or tenancy scope; use its report-specific multi-reference filter when available", 409);
  }
  if (Array.isArray(filters.propertyIds) && context.request.scope.propertyIds.length && String(filters.propertyIds) !== String(context.request.scope.propertyIds)) {
    throw new ReportingError("report_validation", "Property scope and property filter must identify the same properties", 400);
  }
  return rentOpsFiltersSchema.parse(filters);
}

function toRows(reportId: RentalReportId, sourceRows: readonly unknown[]): { rows: ReportRow[]; columns: ReportColumn[] } {
  const rows = sourceRows.map((raw, index) => {
    const values = rowValues(raw);
    return { rowId: `${reportId}:${sha256(values).slice(0, 32)}:${index}`, values };
  });
  const keys = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row.values)) keys.add(key);
  const columns = Array.from(keys).sort().map(key => ({
    id: key,
    label: labelFor(key),
    type: columnType(rows.map(row => row.values[key]), key),
    sortable: true,
    filterable: true,
    sensitive: false,
  } satisfies ReportColumn));
  return { rows, columns };
}

/**
 * Adapter around the accepted Rent Operations report service. It preserves the
 * legacy derivations while converting every `*Cents` value to the versioned
 * string boundary before a run is snapshotted.
 */
export function createRentalReportingEngine(service: RentOpsReportReader) {
  return {
    key: "rental.operational",
    reportIds: RENTAL_REPORT_IDS,
    ready: true,
    async run(context: ReportingEngineContext): Promise<ReportingEngineResult> {
      const reportId = context.definition.id as RentalReportId;
      if (!RENTAL_REPORT_IDS.includes(reportId)) throw new ReportingError("report_unavailable", `Rental report ${context.definition.id} is not supported by this adapter`, 409);
      let sourceRows: unknown[];
      try {
        sourceRows = await service.report(reportId, requestFilters(context), context);
      } catch (error) {
        if (error instanceof ReportingError) throw error;
        throw new ReportingError("report_unavailable", "Rental operational records could not produce a verified report", 409, { reportId });
      }
      const { rows, columns } = toRows(reportId, sourceRows);
      const missingData = rows.length === 0 ? [{ code: "rental_empty_source", state: "unknown" as const, message: "The rental reader returned no rows and does not expose a source watermark proving a verified zero." }] : [];
      return {
        columns,
        rows,
        totals: [],
        coverage: [{
          source: "rental_operational_records",
          state: "partial",
          evidence: "reproducible_snapshot",
          basis: "operational",
          watermark: null,
          observedAt: context.now,
          coveredFrom: context.request.period.mode === "range" ? context.request.period.fromDate : null,
          coveredThrough: null,
          rowCount: rows.length,
          reason: "Legacy rental reader does not expose a source coverage watermark; requested period is retained in the immutable run.",
        }],
        missingData,
        drilldowns: [],
      };
    },
  } as const;
}
