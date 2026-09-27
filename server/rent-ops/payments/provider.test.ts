import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import type { TenantPayment } from './model';
import { stripeProvider } from './provider';

const env = {
  STRIPE_SECRET_KEY: 'sk_test_adapter',
  STRIPE_WEBHOOK_SECRET: 'whsec_adapter',
  RENT_OPS_PUBLIC_APP_URL: 'https://example.com',
};

const payment: TenantPayment = {
  id: 'tp_adapter', accountId: 'account', personId: 'person', tenancyId: 'tenancy',
  propertyId: 'property', unitId: 'unit', requestId: 'request', amountCents: 10000,
  currency: 'usd', status: 'pending', checkoutSessionId: 'cs_adapter',
  paymentIntentId: 'pi_adapter', expiresAt: '2026-09-07T11:00:00.000Z',
  createdAt: '2026-09-07T10:00:00.000Z', updatedAt: '2026-09-07T10:00:00.000Z',
  currentLedgerCents: 0, ledgerRevision: 0,
};

function stripeAdapter(intentStatus: string | null) {
  const calls: string[] = [];
  const client = {
    checkout: {
      sessions: {
        async create() { throw new Error('unused'); },
        async retrieve(id: string, params: unknown) {
          calls.push(`session:${id}:${JSON.stringify(params)}`);
          return {
            id: 'cs_adapter', status: 'expired', payment_status: 'unpaid', payment_intent: intentStatus ? 'pi_adapter' : null,
            livemode: false, amount_total: 10000, currency: 'usd',
          };
        },
      },
    },
    paymentIntents: {
      async retrieve(id: string) {
        calls.push(`intent:${id}`);
        return intentStatus ? {
          id: 'pi_adapter', status: intentStatus, created: 1, livemode: false, amount: 10000,
          amount_received: intentStatus === 'succeeded' ? 10000 : 0, currency: 'usd', metadata: { tenantPaymentId: payment.id },
        } : null;
      },
    },
    webhooks: { constructEvent() { throw new Error('unused'); } },
  } as unknown as Stripe;
  return { client, calls };
}

test('expired checkout does not release while a PaymentIntent is nonterminal', async () => {
  for (const status of ['requires_action', 'requires_confirmation', 'requires_capture', 'processing']) {
    const adapter = stripeAdapter(status);
    const provider = stripeProvider(env, adapter.client)!;
    const result = await provider.reconcile!(payment);
    assert.equal(result.state, status === 'processing' ? 'processing' : 'unknown', status);
    if (status === 'processing') assert.ok(result.event, status);
    else assert.equal(result.event, undefined, status);
    assert.deepEqual(adapter.calls, ['session:cs_adapter:{"expand":["payment_intent"]}', 'intent:pi_adapter'], status);
  }
});

test('expired checkout is terminal unpaid only with no PaymentIntent or a canceled one', async () => {
  const noIntent = stripeAdapter(null);
  const noIntentResult = await stripeProvider(env, noIntent.client)!.reconcile!(payment);
  assert.equal(noIntentResult.state, 'terminal_unpaid');
  assert.equal(noIntentResult.event?.type, 'checkout.session.expired');

  const canceled = stripeAdapter('canceled');
  const canceledResult = await stripeProvider(env, canceled.client)!.reconcile!(payment);
  assert.equal(canceledResult.state, 'terminal_unpaid');
  assert.equal(canceledResult.event?.type, 'payment_intent.canceled');
});

test('reconciliation preserves paid truth when the PaymentIntent was created earlier', async () => {
  const adapter = stripeAdapter('succeeded');
  const provider = stripeProvider(env, adapter.client)!;
  const result = await provider.reconcile!(payment);
  assert.equal(result.state, 'paid');
  assert.ok(result.event);
  assert.equal(result.event.created, 1);
  assert.equal(result.event.type, 'payment_intent.succeeded');
});
