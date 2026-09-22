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
