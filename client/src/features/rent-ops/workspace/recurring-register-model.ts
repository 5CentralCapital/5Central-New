import type { AdminRecurringScheduleView, OperationalScheduleRegister } from '../types';

export const recurringRegisterViews = [
  ['current', 'Current charges'], ['history', 'Historical charges'], ['future', 'Future charges'],
  ['unit-default', 'Unit defaults'], ['property-default', 'Property defaults'], ['review', 'Needs review'], ['all', 'All schedules'],
] as const;
export type RecurringRegisterView = typeof recurringRegisterViews[number][0];

export function recurringRegisterQueryKey(identity: string, propertyScope: string, propertyId: string, asOfDate: string) {
  return ['rent-ops-workspace', 'recurring', identity, propertyScope, propertyId, asOfDate] as const;
}

export function selectRecurringRegisterRows(rows: AdminRecurringScheduleView[], metadata: OperationalScheduleRegister, view: RecurringRegisterView) {
  const current = new Set(metadata.currentScheduleIds);
  const historical = new Set(metadata.historicalScheduleIds);
  const future = new Set(metadata.futureScheduleIds);
  const unitDefaults = new Set(metadata.unitDefaultScheduleIds);
  const propertyDefaults = new Set(metadata.propertyDefaultScheduleIds);
  const review = new Set(metadata.reviewScheduleIds);
  return rows.map(row => {
    const id = row.id ?? '';
    const displayStatus = review.has(id) ? 'Needs review' : current.has(id) ? 'Current' : historical.has(id) ? 'Historical' : future.has(id) ? 'Future' : unitDefaults.has(id) ? 'Unit default' : propertyDefaults.has(id) ? 'Property default' : 'Needs review';
    const selected = view === 'all' || (view === 'current' && current.has(id)) || (view === 'history' && historical.has(id)) || (view === 'future' && future.has(id)) || (view === 'unit-default' && unitDefaults.has(id)) || (view === 'property-default' && propertyDefaults.has(id)) || (view === 'review' && displayStatus === 'Needs review');
    return { ...row, displayStatus, selected, canChange: current.has(id) && !review.has(id) && row.lineageState === 'valid' && row.canScheduleSuccessor === true };
  }).filter(row => row.selected);
}
