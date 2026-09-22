import { legacyNumberToCents, parseCents, type MoneyCents } from "../../shared/company";
import type { IsoDate } from "../../shared/company";
import type {
  ReportColumn,
  ReportDrilldown,
  ReportMissingData,
  ReportRow,
  ReportSourceCoverage,
  ReportTotal,
  ReportingEngineContext,
  ReportingEngineResult,
} from "../../shared/reporting";
import { ReportingError } from "./errors";
import { sha256 } from "./utils";
import type { ReportingEngine } from "./registry";

/**
 * The source adapters intentionally share one row boundary.  A source may
 * return richer objects than a report needs, but all money values crossing
 * into a snapshot are canonical BIGINT cents strings and all row IDs remain
 * stable for replay and drilldown.
 */
export function canonicalSourceValue(value: unknown, key?: string): unknown {
  if (key?.endsWith("Cents")) {
    // New reporting ports already speak cents. A numeric money field is
    // accepted only as a legacy cents integer; treating it as dollars would
    // silently multiply every amount by 100.
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) throw new ReportingError("report_validation", `Numeric cents field ${key} is not a safe integer.`, 400);
      return parseCents(String(value));
    }
    if (typeof value === "string") return parseCents(value);
  }
  if (Array.isArray(value)) return value.map(item => canonicalSourceValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, canonicalSourceValue(item, name)]));
  }
  return value;
}

export function labelForField(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ").replace(/^./, value => value.toUpperCase());
}

export function reportColumns(specs: readonly { readonly id: string; readonly label: string; readonly type: ReportColumn["type"]; readonly sortable?: boolean; readonly filterable?: boolean; readonly sensitive?: boolean }[]): readonly ReportColumn[] {
  return specs.map(spec => ({ id: spec.id, label: spec.label, type: spec.type, sortable: spec.sortable ?? true, filterable: spec.filterable ?? true, sensitive: spec.sensitive ?? false }));
}

function fieldType(key: string, values: readonly unknown[]): ReportColumn["type"] {
  if (key.endsWith("Cents")) return "money";
  const sample = values.find(value => value !== null && value !== undefined);
  if (sample === undefined) return "text";
  if (typeof sample === "boolean") return "boolean";
  if (typeof sample === "number") return Number.isInteger(sample) ? "integer" : "decimal";
  if (typeof sample === "object") return "json";
  if (/date|on$/i.test(key)) return "date";
  if (/status|state|kind|type$/i.test(key)) return "status";
  return "text";
}

export function rowsFromRecords(
  reportId: string,
  records: readonly unknown[],
  options: { readonly rowId?: (record: unknown, index: number, values: Record<string, unknown>) => string; readonly columns?: readonly ReportColumn[] } = {},
): { readonly rows: ReportRow[]; readonly columns: ReportColumn[] } {
  const rows = records.map((record, index) => {
    const normalized = canonicalSourceValue(record);
    const allValues = normalized && typeof normalized === "object" && !Array.isArray(normalized)
      ? normalized as Record<string, unknown>
      : { value: normalized };
    const rowId = options.rowId?.(record, index, allValues) ?? `${reportId}:${sha256(allValues).slice(0, 32)}:${index}`;
    // A source row may carry provider IDs, raw links, or adapter diagnostics
    // needed for drilldown. Keep those in the immutable row identity, but do
    // not expose them as ordinary report columns when the engine supplied an
    // explicit display schema. This also makes every declared column present
    // (with null) for empty/partial rows.
    const values = options.columns
      ? Object.fromEntries(options.columns.map(column => [column.id, allValues[column.id] ?? null]))
      : allValues;
    return { rowId, values } satisfies ReportRow;
  });
  const keys = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row.values)) {
    if (/^[a-z][A-Za-z0-9_.-]{0,119}$/.test(key)) keys.add(key);
  }
  const columns = options.columns ? [...options.columns] : Array.from(keys).sort().map(key => ({
    id: key,
    label: labelForField(key),
    type: fieldType(key, rows.map(row => row.values[key])),
    sortable: key !== "raw",
    filterable: true,
    sensitive: false,
  } satisfies ReportColumn));
  return { rows, columns };
}

export function unavailable(reason: string, details: Record<string, unknown> = {}): never {
  throw new ReportingError("report_unavailable", reason, 409, details);
}

export function createUnavailableReportingEngine(input: { readonly key: string; readonly reportIds: readonly `${string}`[]; readonly reason: string; readonly dependency?: string }): ReportingEngine {
  return {
    key: input.key,
    reportIds: input.reportIds as ReportingEngine["reportIds"],
    ready: false,
    reason: input.reason,
    async run() {
      throw new ReportingError("report_unavailable", input.reason, 409, input.dependency ? { dependency: input.dependency } : {});
    },
  };
}

export function periodBounds(context: ReportingEngineContext): { readonly from: string | null; readonly through: string | null } {
  const period = context.request.period;
  if (period.mode === "as_of") return { from: period.asOfDate, through: period.asOfDate };
  if (period.mode === "range") return { from: period.fromDate, through: period.toDate };
  if (period.mode === "month") {
    const [year, month] = period.month.split("-").map(Number);
    const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { from: `${period.month}-01`, through: `${period.month}-${String(day).padStart(2, "0")}` };
  }
  return { from: period.fromDate ?? period.asOfDate ?? null, through: period.toDate ?? period.asOfDate ?? null };
}

export function sourceCoverage(
  context: ReportingEngineContext,
  input: {
    readonly source: string;
    readonly state: ReportSourceCoverage["state"];
    readonly evidence: ReportSourceCoverage["evidence"];
    readonly basis: ReportSourceCoverage["basis"];
    readonly watermark?: string | null;
    readonly coveredFrom?: string | null;
    readonly coveredThrough?: string | null;
    readonly rowCount: number;
    readonly reason?: string | null;
  },
): ReportSourceCoverage {
  return {
    source: input.source,
    state: input.state,
    evidence: input.evidence,
    basis: input.basis,
    watermark: input.watermark ?? null,
    observedAt: context.now,
    coveredFrom: (input.coveredFrom ?? periodBounds(context).from) as IsoDate | null,
    coveredThrough: (input.coveredThrough ?? periodBounds(context).through) as IsoDate | null,
    rowCount: input.rowCount,
    reason: input.reason ?? null,
  };
}

export function resultFromRecords(
  context: ReportingEngineContext,
  records: readonly unknown[],
  input: {
    readonly source: string;
    readonly basis: ReportSourceCoverage["basis"];
    readonly coverageState?: ReportSourceCoverage["state"];
    readonly evidence?: ReportSourceCoverage["evidence"];
    readonly watermark?: string | null;
    readonly reason?: string | null;
    readonly missingData?: readonly ReportMissingData[];
    readonly totals?: readonly ReportTotal[];
    readonly drilldowns?: readonly ReportDrilldown[];
    /** Deliberate display/export columns. Source identifiers can remain in
     * row metadata while the user-facing result shows named fields only. */
    readonly columns?: readonly ReportColumn[];
    readonly rowId?: (record: unknown, index: number, values: Record<string, unknown>) => string;
  },
): ReportingEngineResult {
  const { rows, columns } = rowsFromRecords(context.definition.id, records, { rowId: input.rowId, columns: input.columns });
  return {
    columns,
    rows,
    totals: input.totals ?? [],
    coverage: [sourceCoverage(context, { ...input, state: input.coverageState ?? "partial", evidence: input.evidence ?? "reproducible_snapshot", rowCount: rows.length })],
    missingData: input.missingData ?? [],
    drilldowns: input.drilldowns ?? [],
  };
}

export function asMoneyCents(value: unknown): MoneyCents | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return legacyNumberToCents(value);
  if (typeof value === "string") return parseCents(value);
  return null;
}
