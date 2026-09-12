import type { QueryClient } from '@tanstack/react-query';
import type { RentOpsWorkspaceDashboard } from '../api';
import type { RentOpsAuthSnapshot } from '../auth';
import type { ApiFilters, ReportRow } from '../types';
import { reportQueryKey } from './report-model';

/** Reuse the completed page read for an immediate report drilldown. The
 * caller supplies the current session; no stale session may refill its cache. */
export function seedWorkspaceDashboardReports(
  client: QueryClient,
  dashboard: RentOpsWorkspaceDashboard,
  filters: ApiFilters,
  identity: string,
  updatedAt: number,
  session: RentOpsAuthSnapshot,
): void {
  if (!identity || session.status !== 'authenticated' || session.user?.id !== identity || !Number.isFinite(updatedAt) || updatedAt <= 0) return;
  for (const report of ['rent-roll', 'delinquency'] as const) {
    const key = reportQueryKey(report, filters, identity);
    const current = client.getQueryState<ReportRow[]>(key);
    // An explicit invalidation or newer standalone read wins over a page cache.
    if (current?.isInvalidated || (current?.dataUpdatedAt ?? 0) >= updatedAt) continue;
    client.setQueryData(key, dashboard.reports[report], { updatedAt });
  }
}
