import assert from 'node:assert/strict';
import test from 'node:test';
import { preloadApplicantOptions, takeApplicantOptions } from './startup';
import { loadApplicantPropertyOptions } from './api';

test('public startup omits credentials, skips resume links and retains response validation', async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (_path, options) => {
    requests++;
    assert.equal(options?.credentials, 'omit');
    assert.equal(options?.referrerPolicy, 'no-referrer');
    return new Response(JSON.stringify({ invalid: 'envelope' }), { status: 200 });
  };
  try {
    preloadApplicantOptions({ pathname: '/apply', search: '', hash: '#resume=private' });
    preloadApplicantOptions({ pathname: '/apply', search: '?resume=private', hash: '' });
    assert.equal(requests, 0);
    preloadApplicantOptions({ pathname: '/apply', search: '', hash: '' });
    await assert.rejects(loadApplicantPropertyOptions(), /Available homes could not be loaded/);
    assert.equal(requests, 1);
    assert.equal(takeApplicantOptions(), undefined);
  } finally { globalThis.fetch = original; takeApplicantOptions(); }
});
