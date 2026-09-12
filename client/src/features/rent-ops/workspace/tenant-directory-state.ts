import type { ViewFilters } from '../types';

export const DEFAULT_TENANT_DIRECTORY_STATUS = 'current';

/** Tenant browsing has its own selection; report and record navigation filters do not reset it. */
export function tenantDirectoryFilters(filters: ViewFilters, status = DEFAULT_TENANT_DIRECTORY_STATUS): ViewFilters {
  return { ...filters, status };
}
