import Stripe from 'stripe';
import type { ProcessorEvent, TenantPayment } from './model';
export interface ProviderReconciliation { state: 'paid' | 'terminal_unpaid' | 'processing' | 'unknown'; event?: ProcessorEvent }
export interface PaymentProvider { live: boolean; createCheckout(payment: TenantPayment): Promise<{id:string;url:string;paymentIntentId?:string}>; verify(body: Buffer, signature: string): ProcessorEvent | Promise<ProcessorEvent>; reconcile?(payment: TenantPayment): Promise<ProviderReconciliation> }
const id = (value: unknown): string | undefined => typeof value === 'string' ? value : value && typeof value === 'object' && 'id' in value ? String(value.id) : undefined;
export function normalizeStripeEvent(event: Stripe.Event): ProcessorEvent {
  const o = event.data.object as unknown as Record<string, any>;
  const result: ProcessorEvent = { id:event.id,type:event.type,created:event.created,live:event.livemode,state:'ignored',paymentId:o.metadata?.tenantPaymentId,paymentIntentId:id(o.payment_intent) };
  if (event.type.startsWith('checkout.session.')) {
    result.checkoutSessionId=o.id; result.amountCents=o.amount_total; result.currency=o.currency;
    if (event.type==='checkout.session.expired') result.state='cancelled';
    if (event.type==='checkout.session.completed') result.state=o.payment_status==='paid'?'success':'processing';
    if (event.type==='checkout.session.async_payment_succeeded') result.state='success';
    if (event.type==='checkout.session.async_payment_failed') result.state='failed';
  } else if (event.type.startsWith('payment_intent.')) {
    result.paymentIntentId=o.id; result.amountCents=event.type==='payment_intent.succeeded'?o.amount_received:o.amount; result.currency=o.currency;
    if(event.type==='payment_intent.succeeded') result.state='success';
    if(event.type==='payment_intent.processing') result.state='processing';
    if(event.type==='payment_intent.payment_failed') result.state='failed';
    if(event.type==='payment_intent.canceled') result.state='cancelled';
  } else if (['refund.created','refund.updated'].includes(event.type) && o.status==='succeeded') {
    result.state='adjustment'; result.adjustment={providerObjectId:o.id,kind:'refund',amountCents:o.amount,active:true,terminal:true};
  } else if (event.type.startsWith('charge.dispute.')) {
    // A dispute is a hold until Stripe confirms a win. Never credit on an open dispute.
    const terminal = ['won','lost','warning_closed'].includes(o.status);
    result.state='adjustment'; result.adjustment={providerObjectId:o.id,kind:'dispute',amountCents:o.amount,active:!terminal,terminal};
  }
  return result;
}
export function stripeProvider(env: NodeJS.ProcessEnv): PaymentProvider | undefined {
  const key=env.STRIPE_SECRET_KEY, secret=env.STRIPE_WEBHOOK_SECRET, origin=env.TENANT_PORTAL_ORIGIN || env.RENT_OPS_PUBLIC_APP_URL;
  if(!key || !/^sk_(test|live)_/.test(key) || !secret?.startsWith('whsec_') || !origin) return;
  let url:URL;try{url=new URL(origin);}catch{return;}
  if(url.username || url.password) return; if(url.protocol!=='https:' && !(env.NODE_ENV!=='production' && ['localhost','127.0.0.1'].includes(url.hostname))) return;
  const stripe=new Stripe(key);
  const reconciliationEvent = (payment: TenantPayment, object: Record<string, any>, state: ProcessorEvent['state'], type: string, ids: { checkoutSessionId?: string; paymentIntentId?: string }): ProcessorEvent => {
    const objectId = typeof object.id === 'string' ? object.id : 'unknown';
    const status = typeof object.status === 'string' ? object.status : state;
    const created = Number.isSafeInteger(object.created) && object.created > 0 ? object.created : Math.floor(Date.now() / 1000);
    const metadataPaymentId = typeof object.metadata?.tenantPaymentId === 'string' ? object.metadata.tenantPaymentId : undefined;
    return {
      id: `reconcile:${payment.id}:${objectId}:${status}:${state}`,
      type,
      created,
      live: object.livemode === true,
      state,
      ...(metadataPaymentId ? { paymentId: metadataPaymentId } : {}),
      ...(ids.paymentIntentId ? { paymentIntentId: ids.paymentIntentId } : {}),
      ...(ids.checkoutSessionId ? { checkoutSessionId: ids.checkoutSessionId } : {}),
      ...(object.amount_received !== undefined || object.amount !== undefined || object.amount_total !== undefined ? { amountCents: Number(object.amount_received ?? object.amount_total ?? object.amount) } : {}),
      ...(typeof object.currency === 'string' ? { currency: object.currency } : {}),
    };
  };
  const paymentIntentTruth = (payment: TenantPayment, intent: Stripe.PaymentIntent, checkoutSessionId?: string): ProviderReconciliation => {
    const ids = { paymentIntentId: intent.id, ...(checkoutSessionId ? { checkoutSessionId } : {}) };
    if (intent.status === 'succeeded') return { state: 'paid', event: reconciliationEvent(payment, intent as unknown as Record<string, any>, 'success', 'payment_intent.succeeded', ids) };
    if (intent.status === 'canceled') return { state: 'terminal_unpaid', event: reconciliationEvent(payment, intent as unknown as Record<string, any>, 'cancelled', 'payment_intent.canceled', ids) };
    if (intent.status === 'processing') return { state: 'processing', event: reconciliationEvent(payment, intent as unknown as Record<string, any>, 'processing', 'payment_intent.processing', ids) };
    return { state: 'unknown' };
  };
  return {live:key.startsWith('sk_live_'), async createCheckout(payment) {
    const session=await stripe.checkout.sessions.create({mode:'payment',payment_method_types:['card','us_bank_account'],client_reference_id:payment.id,metadata:{tenantPaymentId:payment.id},payment_intent_data:{metadata:{tenantPaymentId:payment.id}},line_items:[{quantity:1,price_data:{currency:'usd',unit_amount:payment.amountCents,product_data:{name:'Tenant account payment'}}}],success_url:`${url.origin}/tenant?payment=returned`,cancel_url:`${url.origin}/tenant?payment=cancelled`,expires_at:Math.floor(new Date(payment.expiresAt).getTime()/1000)}, {idempotencyKey:payment.id});
    if(!session.url) throw new Error('checkout_url_missing'); return {id:session.id,url:session.url,paymentIntentId:id(session.payment_intent)};
  }, async verify(body,signature) {const event=normalizeStripeEvent(stripe.webhooks.constructEvent(body,signature,secret)); if(event.state==='adjustment' && !event.paymentId && event.paymentIntentId) {const intent=await stripe.paymentIntents.retrieve(event.paymentIntentId);event.paymentId=intent.metadata.tenantPaymentId;}return event;}, async reconcile(payment) {
    try {
      if (payment.checkoutSessionId) {
        const session = await stripe.checkout.sessions.retrieve(payment.checkoutSessionId, { expand: ['payment_intent'] });
        const intent = typeof session.payment_intent === 'string'
          ? await stripe.paymentIntents.retrieve(session.payment_intent)
          : session.payment_intent && typeof session.payment_intent !== 'string' ? session.payment_intent as Stripe.PaymentIntent : undefined;
        if (session.payment_status === 'paid' || intent?.status === 'succeeded') {
          const object = (intent ?? session) as unknown as Record<string, any>;
          return { state: 'paid', event: reconciliationEvent(payment, object, 'success', 'payment_intent.succeeded', { checkoutSessionId: session.id, ...(intent ? { paymentIntentId: intent.id } : {}) }) };
        }
        if (intent) {
          const intentTruth = paymentIntentTruth(payment, intent, session.id);
          // A processing PaymentIntent is not safe to release even when the
          // Checkout Session has expired locally. Only a terminal canceled
          // intent, or an expired session with no live intent, is unpaid.
          if (intentTruth.state !== 'unknown') return intentTruth;
        }
        if (session.status === 'expired') {
          return { state: 'terminal_unpaid', event: reconciliationEvent(payment, session as unknown as Record<string, any>, 'cancelled', 'checkout.session.expired', { checkoutSessionId: session.id, ...(intent ? { paymentIntentId: intent.id } : {}) }) };
        }
        return { state: 'unknown' };
      }
      if (payment.paymentIntentId) return paymentIntentTruth(payment, await stripe.paymentIntents.retrieve(payment.paymentIntentId));
    } catch {
      // A timeout, provider outage, or deleted object does not establish an
      // unpaid terminal state. Keep the reservation visible and blocked.
      return { state: 'unknown' };
    }
    return { state: 'unknown' };
  } };
}
