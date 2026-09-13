import { useQuery } from '@tanstack/react-query';
import { rentOpsAuthClient } from '../auth';
import { useRentOpsAuth } from '../auth-ui';
import { chargeTermLabel, decodeRecurringChargeTerms, recurringChargeTermsQueryKey, recurringChargeTermsRequests } from './recurring-charge-terms-model';

export function useRecurringChargeTerms(scheduleIds: Array<string | null | undefined>, asOfDate: string) {
  const auth = useRentOpsAuth();
  const ids = Array.from(new Set(scheduleIds.filter((id): id is string => Boolean(id)))).sort();
  const query = useQuery({
    queryKey: recurringChargeTermsQueryKey(auth.user?.id ?? '', ids, asOfDate),
    queryFn: async ({ signal }) => {
      const batches = recurringChargeTermsRequests(ids, asOfDate);
      const results = await Promise.all(batches.map(async batch => {
        const response = await rentOpsAuthClient.request(batch.path, { signal, headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('Charge terms are unavailable.');
        return decodeRecurringChargeTerms(await response.json(), batch.ids);
      }));
      return results.flat();
    },
    enabled: auth.status === 'authenticated' && Boolean(asOfDate) && ids.length > 0,
    staleTime: 60_000, gcTime: 300_000, retry: false,
  });
  const byId = new Map(query.data?.map(row => [row.scheduleId, row]));
  const state = query.error ? 'error' : query.data ? 'ready' : 'loading';
  return { ...query, label: (id: string | null | undefined, field: 'start' | 'through', scope?: string | null) => chargeTermLabel(id ? byId.get(id) : undefined, field, id ? state : 'ready', scope) };
}
