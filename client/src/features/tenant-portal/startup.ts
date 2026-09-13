import { TenantPortalClient, type TenantSessionAccount } from './api';

interface TenantStartup { client: TenantPortalClient; restoration?: Promise<TenantSessionAccount | null>; }
let startup: TenantStartup | undefined;

/** Only plain account URLs start early; token-bearing links are consumed by
 * the portal before it makes any account request. No result survives mounting. */
export function preloadTenantSession(location: Pick<Location, 'pathname' | 'search' | 'hash'>): void {
  if (startup || location.pathname !== '/tenant' || location.search || location.hash) return;
  const client = new TenantPortalClient();
  const restoration = client.restore();
  void restoration.catch(() => undefined);
  startup = { client, restoration };
}

export function takeTenantStartup(): TenantStartup {
  const result = startup ?? { client: new TenantPortalClient() };
  startup = undefined;
  return result;
}
