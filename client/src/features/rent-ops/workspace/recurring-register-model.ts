import type { AdminRecurringScheduleView, OperationalScheduleRegister } from '../types';
import { UNCONFIRMED_LABEL } from '@shared/review-cases/display-labels';

export const recurringRegisterViews = [
  ['current', 'Current charges'], ['history', 'Historical charges'], ['future', 'Future charges'],
  ['unit-default', 'Unit defaults'], ['property-default', 'Property defaults'], ['review', UNCONFIRMED_LABEL], ['all', 'All schedules'],
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
    // A schedule the server flagged for review, or one it did not classify, is unconfirmed.
    const unconfirmed = review.has(id) || !(current.has(id) || historical.has(id) || future.has(id) || unitDefaults.has(id) || propertyDefaults.has(id));
    const displayStatus = unconfirmed ? UNCONFIRMED_LABEL : current.has(id) ? 'Current' : historical.has(id) ? 'Historical' : future.has(id) ? 'Future' : unitDefaults.has(id) ? 'Unit default' : 'Property default';
    const selected = view === 'all' || (view === 'current' && current.has(id)) || (view === 'history' && historical.has(id)) || (view === 'future' && future.has(id)) || (view === 'unit-default' && unitDefaults.has(id)) || (view === 'property-default' && propertyDefaults.has(id)) || (view === 'review' && unconfirmed);
    return { ...row, displayStatus, selected, canChange: current.has(id) && !review.has(id) && row.lineageState === 'valid' && row.canScheduleSuccessor === true };
  }).filter(row => row.selected);
}
