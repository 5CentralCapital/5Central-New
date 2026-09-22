import Stripe from 'stripe';
import type { ProcessorEvent, TenantPayment } from './model';
export interface PaymentProvider { live: boolean; createCheckout(payment: TenantPayment): Promise<{id:string;url:string;paymentIntentId?:string}>; verify(body: Buffer, signature: string): ProcessorEvent | Promise<ProcessorEvent> }
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
    result.state='adjustment'; result.adjustment={providerObjectId:o.id,kind:'dispute',amountCents:o.amount,active:o.status!=='won',terminal:['won','lost'].includes(o.status)};
  }
  return result;
}
export function stripeProvider(env: NodeJS.ProcessEnv): PaymentProvider | undefined {
  const key=env.STRIPE_SECRET_KEY, secret=env.STRIPE_WEBHOOK_SECRET, origin=env.TENANT_PORTAL_ORIGIN || env.RENT_OPS_PUBLIC_APP_URL;
  if(!key || !/^sk_(test|live)_/.test(key) || !secret?.startsWith('whsec_') || !origin) return;
  let url:URL;try{url=new URL(origin);}catch{return;}
  if(url.username || url.password) return; if(url.protocol!=='https:' && !(env.NODE_ENV!=='production' && ['localhost','127.0.0.1'].includes(url.hostname))) return;
  const stripe=new Stripe(key);
  return {live:key.startsWith('sk_live_'), async createCheckout(payment) {
    const session=await stripe.checkout.sessions.create({mode:'payment',payment_method_types:['card','us_bank_account'],client_reference_id:payment.id,metadata:{tenantPaymentId:payment.id},payment_intent_data:{metadata:{tenantPaymentId:payment.id}},line_items:[{quantity:1,price_data:{currency:'usd',unit_amount:payment.amountCents,product_data:{name:'Tenant account payment'}}}],success_url:`${url.origin}/tenant?payment=returned`,cancel_url:`${url.origin}/tenant?payment=cancelled`,expires_at:Math.floor(new Date(payment.expiresAt).getTime()/1000)}, {idempotencyKey:payment.id});
    if(!session.url) throw new Error('checkout_url_missing'); return {id:session.id,url:session.url,paymentIntentId:id(session.payment_intent)};
  }, async verify(body,signature) {const event=normalizeStripeEvent(stripe.webhooks.constructEvent(body,signature,secret)); if(event.state==='adjustment' && !event.paymentId && event.paymentIntentId) {const intent=await stripe.paymentIntents.retrieve(event.paymentIntentId);event.paymentId=intent.metadata.tenantPaymentId;}return event;} };
}
