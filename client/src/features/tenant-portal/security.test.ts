import test from 'node:test';
import assert from 'node:assert/strict';
import { TenantPortalClient, trustedCheckoutUrl } from './api';
import { activationUrl, consumeActivationLink, centsFromAmount } from './link';

const token = 'a'.repeat(48);
const session = { csrfToken: 'c'.repeat(48), account: { id: 'tenant-1', status: 'active', personId: 'person-1', tenancyId: 'tenancy-1', email: 'resident@example.test' } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test('activation fragment is removed before validation and never enters a query', () => {
  const calls: unknown[][] = [];
  const history = { replaceState: (...args: unknown[]) => { calls.push(args); } };
  assert.deepEqual(consumeActivationLink({ hash: `#activate=${token}`, pathname: '/tenant', search: '?payment=return' }, history), { token, invalid: false });
  assert.deepEqual(calls[0], [null, '', '/tenant?payment=return']);
  assert.deepEqual(consumeActivationLink({ hash: `#activate=${token}&activate=${token}`, pathname: '/tenant', search: '' }, history), { invalid: true });
  assert.equal(calls.length, 2);
  assert.equal(activationUrl(`/tenant#activate=${token}`, 'https://portal.example.test'), `https://portal.example.test/tenant#activate=${token}`);
  for (const path of [`https://evil.example/tenant#activate=${token}`, `/tenant?activate=${token}`, `/admin#activate=${token}`]) assert.throws(() => activationUrl(path, 'https://portal.example.test'));
});

test('tenant writes require their own restored CSRF and clear it after expired session', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const responses = [json(session), json({ ok: true }), json({}, 401)];
  const client = new TenantPortalClient((async (path: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: String(path), init }); return responses.shift()!;
  }) as typeof fetch);
  await assert.rejects(client.request('/api/tenant/auth/logout', {}));
  assert.equal(calls.length, 0);
  await client.restore();
  await client.request('/api/tenant/payments/checkout', { amountCents: 100 });
  assert.equal(new Headers(calls[1].init?.headers).get('x-tenant-csrf'), session.csrfToken);
  assert.equal(calls[1].init?.credentials, 'include');
  assert.equal(calls[1].init?.cache, 'no-store');
  await assert.rejects(client.request('/api/tenant/home'));
  await assert.rejects(client.request('/api/tenant/auth/logout', {}));
  assert.equal(calls.length, 3);
  await assert.rejects(client.request('/api/rent-ops/snapshot'));
});

test('malformed session cannot authorize writes and failed logout retains retry capability', async () => {
  const responses = [json({ ...session, csrfToken: 'short' }), json(session), json({}, 503), json({ ok: true })];
  const client = new TenantPortalClient((async () => responses.shift()!) as typeof fetch);
  await assert.rejects(client.restore());
  await assert.rejects(client.request('/api/tenant/auth/logout', {}));
  await client.restore();
  await assert.rejects(client.logout());
  await client.logout();
  await assert.rejects(client.request('/api/tenant/auth/logout', {}));
});

test('payment redirects accept only HTTPS Stripe checkout and cents are exact', () => {
  assert.equal(trustedCheckoutUrl('https://checkout.stripe.com/c/pay/test'), 'https://checkout.stripe.com/c/pay/test');
  for (const url of ['http://checkout.stripe.com/x', 'https://checkout.stripe.com.evil.test/x', 'https://user@checkout.stripe.com/x', 'https://checkout.stripe.com:444/x', 'javascript:alert(1)']) assert.throws(() => trustedCheckoutUrl(url));
  assert.equal(centsFromAmount('1234.56'), 123456);
  assert.equal(centsFromAmount('0.01'), 1);
  for (const value of ['0', '-1', '1.001', '1e2', 'Infinity', '9007199254740991.99']) assert.equal(centsFromAmount(value), undefined);
});

test('password change adopts the rotated session CSRF for the next write', async () => {
  const rotated = 'r'.repeat(48);
  const responses = [json(session), json({ ...session, csrfToken: rotated }), json({ ok: true })];
  const tokens: Array<string | null> = [];
  const client = new TenantPortalClient((async (_path: unknown, init?: RequestInit) => {
    tokens.push(new Headers(init?.headers).get('x-tenant-csrf')); return responses.shift()!;
  }) as typeof fetch);
  await client.restore();
  await client.changePassword('old-password-123', 'new-password-123');
  await client.logout();
  assert.deepEqual(tokens, [null, session.csrfToken, rotated]);
});
