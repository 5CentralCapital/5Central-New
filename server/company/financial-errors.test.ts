import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountingError } from '../accounting/errors';
import { QuickBooksIntegrationError } from '../integrations/quickbooks/errors';
import { publicFinancialError } from './financial-errors';

test('uncertain provider writes require reconciliation even when a provider marks the failure retryable', () => {
  const error = new QuickBooksIntegrationError('quickbooks_timeout', 'private provider response', { retryable: true, ambiguous: true });
  const visible = publicFinancialError(error)!;
  assert.equal(visible.status, 409);
  assert.equal(visible.retryable, false);
  assert.equal(visible.recovery, 'reconcile_operation');
  assert.equal(visible.code, 'quickbooks_ambiguous_write');
});

test('public errors omit provider messages, credentials, source bodies and causes', () => {
  const secret = 'synthetic-private-token-not-a-real-credential';
  for (const error of [
    new AccountingError('accounting_configuration', secret, { sourceBody: secret }),
    new QuickBooksIntegrationError('quickbooks_api', secret, { cause: new Error(secret), details: { token: secret } }),
  ]) assert.equal(JSON.stringify(publicFinancialError(error)).includes(secret), false);
});

test('allocation and connection failures communicate distinct recovery paths', () => {
  assert.equal(publicFinancialError(new AccountingError('accounting_allocation_exceeded', 'private'))?.recovery, 'refresh_record');
  assert.equal(publicFinancialError(new AccountingError('accounting_capability_disabled', 'private'))?.recovery, 'review_capability');
  assert.equal(publicFinancialError(new QuickBooksIntegrationError('quickbooks_unauthorized', 'private'))?.recovery, 'reconnect');
  assert.equal(publicFinancialError(new Error('ordinary error')), undefined);
});

test("a retryable token-store conflict asks for a retry, not a reconnect", () => {
  const retryable = publicFinancialError(new QuickBooksIntegrationError("quickbooks_token_store", "QuickBooks token refresh is already in progress", { retryable: true }));
  assert.equal(retryable?.recovery, "retry_same_operation");
  assert.equal(retryable?.retryable, true);
  const broken = publicFinancialError(new QuickBooksIntegrationError("quickbooks_token_store", "store unavailable"));
  assert.equal(broken?.recovery, "reconnect");
});

test("transient OAuth token failures ask for a retry, while a non-transient OAuth error asks for reconnect", () => {
  const throttled = publicFinancialError(new QuickBooksIntegrationError("quickbooks_oauth", "private", { status: 429, retryable: true, retryAfterMs: 90_000 }));
  assert.deepEqual(
    { status: throttled?.status, retryable: throttled?.retryable, recovery: throttled?.recovery },
    { status: 429, retryable: true, recovery: "retry_same_operation" },
  );
  const unavailable = publicFinancialError(new QuickBooksIntegrationError("quickbooks_oauth", "private", { status: 503, retryable: true }));
  assert.equal(unavailable?.recovery, "retry_same_operation");
  assert.equal(unavailable?.retryable, true);
  const invalid = publicFinancialError(new QuickBooksIntegrationError("quickbooks_oauth", "private", { status: 400, retryable: false }));
  assert.equal(invalid?.recovery, "reconnect");
});
