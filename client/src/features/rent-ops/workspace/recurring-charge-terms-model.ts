import { z } from 'zod';
import type { RecurringChargeTermsView } from '../../../../../shared/recurring-charge-terms';
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
const rowSchema = z.object({
  scheduleId: z.string().min(1).max(160), reviewRevision: z.number().int().nonnegative(), latestReviewRevision: z.number().int().nonnegative(), appliesFrom: date.nullable(),
  verifiedRateFrom: date.nullable(), rateFromKnowledge: z.enum(['verified', 'unknown']),
  leaseFrom: date.nullable(), leaseFromKnowledge: z.enum(['verified', 'unknown']),
  leaseThrough: date.nullable(), leaseThroughKnowledge: z.enum(['verified', 'unknown', 'month_to_month']),
  reviewedAt: z.string().datetime().nullable(),
}).superRefine((row, context) => {
  for (const [value, knowledge] of [[row.verifiedRateFrom, row.rateFromKnowledge], [row.leaseFrom, row.leaseFromKnowledge], [row.leaseThrough, row.leaseThroughKnowledge]]) {
    if ((knowledge === 'verified') !== (value !== null)) context.addIssue({ code: 'custom', message: 'Inconsistent term date' });
  }
});
export function decodeRecurringChargeTerms(payload: unknown, requestedIds: readonly string[]): RecurringChargeTermsView[] {
  const parsed = z.object({ rows: z.array(rowSchema) }).safeParse(payload);
  if (!parsed.success || new Set(parsed.data.rows.map(row => row.scheduleId)).size !== parsed.data.rows.length || parsed.data.rows.some(row => !requestedIds.includes(row.scheduleId))) throw new Error('Charge terms are unavailable.');
  return parsed.data.rows;
}
export function recurringChargeTermsQueryKey(identity: string, scheduleIds: readonly string[], asOfDate: string) {
  return ['rent-ops-workspace', 'recurring-charge-terms', identity, asOfDate, Array.from(new Set(scheduleIds)).sort()] as const;
}
export function chargeTermLabel(row: RecurringChargeTermsView | undefined, field: 'start' | 'through', state: 'loading' | 'ready' | 'error', scope?: string | null): string {
  if (field === 'through' && (scope === 'property' || scope === 'unit')) return 'Not applicable';
  if (state === 'loading') return 'Loading…';
  if (state === 'error') return 'Unavailable';
  if (field === 'start') return row?.rateFromKnowledge === 'verified' && row.verifiedRateFrom ? row.verifiedRateFrom : 'Unverified';
  return row?.leaseThroughKnowledge === 'month_to_month' ? 'Month to month' : row?.leaseThroughKnowledge === 'verified' && row.leaseThrough ? row.leaseThrough : 'Unverified';
}

/** Bound both record count and the encoded request URL, including escaped IDs. */
export function recurringChargeTermsRequests(ids: readonly string[], asOfDate: string): Array<{ ids: string[]; path: string }> {
  const pathFor = (batch: string[]) => `/api/rent-ops/recurring-charge-terms?${new URLSearchParams({ scheduleIds: batch.join(','), asOfDate })}`;
  const result: Array<{ ids: string[]; path: string }> = [];
  let batch: string[] = [];
  for (const id of ids) {
    if (batch.length && (batch.length === 200 || pathFor([...batch, id]).length > 6000)) {
      result.push({ ids: batch, path: pathFor(batch) });
      batch = [];
    }
    if (pathFor([id]).length > 6000) throw new Error('Charge terms are unavailable.');
    batch.push(id);
  }
  if (batch.length) result.push({ ids: batch, path: pathFor(batch) });
  return result;
}
