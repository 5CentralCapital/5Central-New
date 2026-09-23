import { useQuery } from "@tanstack/react-query";
import { loadRentOpsReport } from "../rent-ops/api";
import type { AdminSnapshot, ReportKey, ReportRow, ViewFilters } from "../rent-ops/types";
import { readReportValue, reportQueryFilters, reportQueryKey } from "../rent-ops/workspace/report-model";

import type { RentalRow } from "./models";
export type { RentalRow };

/** Report rows with names resolved from the loaded snapshot, keyed like the report pages (shared cache). */
export function useRentalReport(identity: string, key: ReportKey, filters: ViewFilters, period: { asOfDate: string; month?: string }, enabled = true) {
  const query = reportQueryFilters({ ...filters, search: "" }, key, period);
  return useQuery({
    queryKey: reportQueryKey(key, query, identity),
    queryFn: ({ signal }) => loadRentOpsReport(key, query, signal),
    enabled: enabled && !!identity && !!period.asOfDate,
    staleTime: 30_000, gcTime: 300_000, retry: false,
  });
}

/** Flatten report rows for grids; unknown values stay undefined/null. */
export function rentalRows(rows: readonly ReportRow[] | undefined, snapshot: AdminSnapshot, keys: readonly string[]): RentalRow[] | undefined {
  return rows?.map(row => Object.fromEntries(keys.map(key => [key, readReportValue(row, key, snapshot)])));
}

export function matchesSearch(row: RentalRow, search: string, keys: readonly string[]): boolean {
  const query = search.trim().toLocaleLowerCase();
  return !query || keys.some(key => String(row[key] ?? "").toLocaleLowerCase().includes(query));
}
