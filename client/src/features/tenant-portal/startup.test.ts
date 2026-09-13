import assert from 'node:assert/strict';
import test from 'node:test';
import { preloadTenantSession, takeTenantStartup } from './startup';

test('tenant startup makes no request for token URLs and never shares a mounted account with a later visit', async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response('{}', { status: 401 }); };
  try {
    preloadTenantSession({ pathname: '/tenant', search: '', hash: '#activate=private' });
    preloadTenantSession({ pathname: '/tenant', search: '?activate=private', hash: '' });
    preloadTenantSession({ pathname: '/ops', search: '', hash: '' });
    assert.equal(requests, 0);
    assert.equal(takeTenantStartup().restoration, undefined);
    preloadTenantSession({ pathname: '/tenant', search: '', hash: '' });
    preloadTenantSession({ pathname: '/tenant', search: '', hash: '' });
    const first = takeTenantStartup();
    assert.equal(await first.restoration, null);
    assert.equal(requests, 1);
    const next = takeTenantStartup();
    assert.notEqual(first.client, next.client);
    assert.equal(next.restoration, undefined);
  } finally { globalThis.fetch = original; takeTenantStartup(); }
});
