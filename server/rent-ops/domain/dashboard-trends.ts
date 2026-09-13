import type { RentOpsFilters, RentOpsSnapshot } from "../../../shared/rent-ops-contracts";
import { dashboardTrendsSchema, type DashboardTrends } from "../../../shared/rent-ops-dashboard";
import { addMonths, monthEnd, monthStart, nowIsoDate } from "./dates";
import { deriveDashboardLeasingPoint } from "./reports";
import { dashboardHistoricalSnapshot } from "./dashboard-history";

/** Twelve lightweight month-end reads from one immutable operational snapshot.
 * The final point is the selected as-of date, never an invented month-end forecast. */
export function deriveDashboardTrends(snapshot: RentOpsSnapshot, filters: RentOpsFilters = {}): DashboardTrends {
  const asOfDate = filters.asOfDate ?? nowIsoDate();
  const start = monthStart(asOfDate.slice(0, 7));
  return dashboardTrendsSchema.parse({
    asOfDate,
    months: Array.from({ length: 12 }, (_, i) => {
      const month = addMonths(start, i - 11).slice(0, 7);
      const date = i === 11 ? asOfDate : monthEnd(month);
      return { month, asOfDate: date, properties: deriveDashboardLeasingPoint(i < 11 ? dashboardHistoricalSnapshot(snapshot, date) : snapshot, { ...filters, asOfDate: date }, i < 11) };
    }),
  });
}
