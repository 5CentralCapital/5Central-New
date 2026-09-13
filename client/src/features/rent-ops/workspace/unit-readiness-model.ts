import type { AdminUnitView, ApiFilters, ReportRow, ViewFilters } from '../types';
import { readReportValue } from './report-model';

export const READINESS_OPTIONS = [['ready', 'Ready'], ['not_ready', 'Not ready'], ['off_market', 'Off market']] as const;
export function unitReadinessQuery(filters: ViewFilters): ApiFilters {
  return { propertyScope: filters.propertyScope, ...(filters.propertyIds?.length ? { propertyIds: [...filters.propertyIds].sort() } : filters.propertyId !== 'all' ? { propertyId: filters.propertyId } : {}), asOfDate: filters.asOfDate, tenantStatus: 'all' };
}
export function unitOccupancyMap(rows: ReportRow[] = []): Map<string, string> {
  return new Map(rows.flatMap(row => { const id = readReportValue(row, 'unitId'); const occupancy = readReportValue(row, 'occupancy'); return typeof id === 'string' && typeof occupancy === 'string' ? [[id, occupancy] as const] : []; }));
}
export function unitReadinessDisplay(unit: AdminUnitView, occupancy?: string): { label: string; status: string } {
  if (occupancy === 'current') return { label: 'Occupied', status: 'current' };
  if (!occupancy) return { label: 'Checking occupancy', status: 'unknown' };
  const option = !['unknown', 'ambiguous', 'inferred'].includes(unit.readinessKnowledge ?? '') && READINESS_OPTIONS.find(([key]) => key === unit.readiness);
  return option ? { label: option[1], status: option[0] } : { label: 'Not recorded', status: 'unknown' };
}
export function unitReadinessPayload(unit: AdminUnitView, readiness: string) {
  if (!unit.id || !Number.isSafeInteger(unit.recordRevision) || (unit.recordRevision ?? 0) < 1) throw new Error('Refresh the unit before changing readiness.');
  if (!READINESS_OPTIONS.some(([key]) => key === readiness)) throw new Error('Choose a readiness option.');
  return { id: unit.id, revision: unit.recordRevision!, readiness };
}
