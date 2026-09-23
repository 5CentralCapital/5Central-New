import { useQuery } from "@tanstack/react-query";
import type { WorkOrderSummary } from "@shared/work-orders";
import { workOrdersApi } from "../work-orders/api";

const PAGE_LIMIT = 5;

/**
 * Open work orders for a company (and optionally one property), read through
 * the same list endpoint as the work-order workspace. A property filter needs
 * its legal entity (company scopes pair them). At most five pages of
 * 100 are read; `truncated` says when more exist.
 */
export function useOpenWorkOrders(identity: string, organizationId: string | undefined, scope?: { legalEntityId: string; propertyId: string }, includeClosed = false) {
  return useQuery({
    queryKey: ["rent-ops-workspace", "work-orders-open", identity, organizationId ?? "", scope?.propertyId ?? "", includeClosed],
    enabled: !!organizationId,
    staleTime: 30_000, retry: false,
    queryFn: async ({ signal }): Promise<{ items: WorkOrderSummary[]; truncated: boolean }> => {
      const items: WorkOrderSummary[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < PAGE_LIMIT; page += 1) {
        const response = await workOrdersApi.list(organizationId!, { openOnly: !includeClosed, ...(scope ? { legalEntityId: scope.legalEntityId, propertyId: scope.propertyId } : {}), ...(cursor ? { cursor } : {}) }, signal);
        items.push(...response.items);
        if (!response.nextCursor) return { items, truncated: false };
        cursor = response.nextCursor;
      }
      return { items, truncated: true };
    },
  });
}
