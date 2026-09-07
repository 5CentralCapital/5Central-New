import { randomUUID, createHash } from 'node:crypto';
import type { TenantIdentity } from '../../../shared/tenant-portal-contracts';
import { tenantCheckoutSchema, type TenantPaymentsView, type TenantCheckoutResult } from '../../../shared/tenant-payment-contracts';
import type { RentOpsRepository, RentOpsLedgerTransaction } from '../../../shared/rent-ops-contracts';
import type { RentOpsQueryExecutor } from '../repositories/postgres';
import { PostgresTenantPaymentStore, type TenantPaymentStore } from './store';
import { businessDate, eligibleCharges, exactPaymentTenancy, payableAccount, TenantPaymentError, type TenantPayment, type ProcessorEvent } from './model';
import { stripeProvider, type PaymentProvider } from './provider';
export class TenantPaymentService {
  constructor(readonly store:TenantPaymentStore, readonly provider?:PaymentProvider, readonly now=()=>new Date()) {}
  async list(identity:TenantIdentity):Promise<TenantPaymentsView> {
    const snapshot=await this.store.snapshot(), payments=await this.store.list(identity.tenancyId);
    const account=payableAccount(snapshot,identity,payments,this.now());
    return {available:!!this.provider,...(!this.provider?{reason:'stripe_not_configured' as const}:{}),accounts:[account],payments:payments.map(({id,tenancyId,amountCents,currency,status,createdAt,postedOn})=>({id,tenancyId,amountCents,currency,status,createdAt,postedOn}))};
  }
  async checkout(identity:TenantIdentity, raw:unknown):Promise<TenantCheckoutResult> {
    if(!this.provider) throw new TenantPaymentError('stripe_not_configured',503);
    const input=tenantCheckoutSchema.safeParse(raw); if(!input.success) throw new TenantPaymentError('invalid_payment_request',400);
    if(input.data.tenancyId!==identity.tenancyId) throw new TenantPaymentError('tenant_account_unavailable',403);
    const payment=await this.store.transaction(async store=>{
      await store.lockTenancy(identity.tenancyId);
      const snapshot=await store.snapshot(); const {tenancy}=exactPaymentTenancy(snapshot,identity);
      const existing=await store.findByRequest(identity.id,input.data.requestId);
      if(existing) {if(existing.amountCents!==input.data.amountCents || existing.tenancyId!==identity.tenancyId) throw new TenantPaymentError('request_id_conflict'); return existing;}
      const account=payableAccount(snapshot,identity,await store.list(identity.tenancyId),this.now());
      if(!account.available || input.data.amountCents>account.payableCents) throw new TenantPaymentError(account.reason??'amount_exceeds_payable_balance');
      const now=this.now(); const p:TenantPayment={id:`tp_${randomUUID()}`,accountId:identity.id,personId:identity.personId,tenancyId:identity.tenancyId,propertyId:tenancy.propertyId,unitId:tenancy.unitId,requestId:input.data.requestId,amountCents:input.data.amountCents,currency:'usd',status:'creating',expiresAt:new Date(now.getTime()+35*60000).toISOString(),createdAt:now.toISOString(),updatedAt:now.toISOString(),currentLedgerCents:0,ledgerRevision:0}; await store.insert(p); return p;
    });
    if(payment.expiresAt<=this.now().toISOString()) throw new TenantPaymentError('payment_request_expired');
    if(payment.checkoutUrl && payment.status==='pending') return {id:payment.id,checkoutUrl:payment.checkoutUrl,status:'pending'};
    if(payment.status!=='creating' || payment.expiresAt<=this.now().toISOString()) throw new TenantPaymentError('payment_request_expired');
    // Keep an uncertain provider failure reserved; retry uses the same Stripe key.
    const session=await this.provider.createCheckout(payment);
    await this.store.transaction(async store=>{await store.lockTenancy(payment.tenancyId); const p=await store.findByRequest(identity.id,payment.requestId); if(!p) throw new Error('payment_missing'); p.checkoutSessionId=session.id;p.checkoutUrl=session.url;p.paymentIntentId??=session.paymentIntentId;if(p.status==='creating')p.status='pending';p.updatedAt=this.now().toISOString();await store.save(p);});
    return {id:payment.id,checkoutUrl:session.url,status:'pending'};
  }
  async webhook(body:Buffer,signature:string) {if(!this.provider) throw new TenantPaymentError('stripe_not_configured',503); let event:ProcessorEvent;try{event=await this.provider.verify(body,signature);}catch{throw new TenantPaymentError('invalid_signature',400);} return this.process(event);}
  async process(event:ProcessorEvent) {
    if(!this.provider || event.live!==this.provider.live) throw new TenantPaymentError('processor_mode_mismatch',400);
    return this.store.transaction(async store=>{
      const initial=await store.findForEvent(event);
      if(initial) await store.lockTenancy(initial.tenancyId);
      if(await store.hasEvent(event.id)) return;
      const p=initial && await store.findForEvent(event); let outcome:'processed'|'ignored'|'review_required'='ignored';
      if(p && event.state!=='ignored') {
        if(p.status==='review_required') {await store.receipt({id:event.id,eventType:event.type,paymentId:p.id,providerCreatedAt:event.created,outcome:'review_required',receivedAt:this.now().toISOString()});return;}

        const mismatch=(event.paymentId && event.paymentId!==p.id)||(p.paymentIntentId && event.paymentIntentId && p.paymentIntentId!==event.paymentIntentId)||(p.checkoutSessionId && event.checkoutSessionId && p.checkoutSessionId!==event.checkoutSessionId);
        const invalidAdjustment=event.adjustment && (!Number.isSafeInteger(event.adjustment.amountCents) || event.adjustment.amountCents<=0 || event.adjustment.amountCents>p.amountCents);
        if(mismatch || invalidAdjustment || (event.state==='success' && (event.amountCents!==p.amountCents || event.currency!=='usd'))) {p.status='review_required';outcome='review_required';}
        else {
          p.paymentIntentId??=event.paymentIntentId;p.checkoutSessionId??=event.checkoutSessionId;outcome='processed';
          if(event.adjustment) { const a=event.adjustment; const old=(await store.adjustments(p.id)).find(x=>x.providerObjectId===a.providerObjectId); if(Number.isSafeInteger(a.amountCents)&&a.amountCents>0&&a.amountCents<=p.amountCents && (!old || (!old.terminal && old.providerCreatedAt<=event.created))) await store.adjustment({...a,paymentId:p.id,providerCreatedAt:event.created}); }
          if(event.state==='success' && !p.postedOn) p.postedOn=businessDate(this.now());
          if(p.postedOn) {
            const adjustments=await store.adjustments(p.id);const refund=adjustments.filter(a=>a.kind==='refund'&&a.active).reduce((s,a)=>s+a.amountCents,0);const disputed=adjustments.some(a=>a.kind==='dispute'&&a.active);const target=disputed?0:Math.max(0,p.amountCents-refund);
            await this.reconcile(store,p,target);
            p.status=disputed?'disputed':refund>=p.amountCents?'refunded':refund>0?'partially_refunded':'posted';
          } else if(event.state==='processing') p.status='processing'; else if(event.state==='failed'||event.state==='cancelled') p.status=event.state;
        }
        p.updatedAt=this.now().toISOString();await store.save(p);
      }
      await store.receipt({id:event.id,eventType:event.type,paymentId:p?.id,providerCreatedAt:event.created,outcome,receivedAt:this.now().toISOString()});
    });
  }
  private async reconcile(store:TenantPaymentStore,p:TenantPayment,target:number) {
    if(target===p.currentLedgerCents) return;
    const date=businessDate(this.now()); const base={propertyId:p.propertyId,unitId:p.unitId,tenancyId:p.tenancyId,personId:p.personId,category:'other' as const,categoryKnowledge:'manual' as const,status:'posted' as const,postedOn:date,payer:'tenant' as const,payerKnowledge:'manual' as const,dueOn:null,dueOnKnowledge:'unknown' as const,chargeDefinitionId:null,chargeDefinitionLinkKnowledge:'unknown' as const,paymentMethod:null,paymentMethodKnowledge:'unknown' as const,propertyLinkKnowledge:'manual' as const,unitLinkKnowledge:'manual' as const,tenancyLinkKnowledge:'manual' as const,personLinkKnowledge:'manual' as const,amountKnowledge:'known' as const,postedOnKnowledge:'manual' as const,statusKnowledge:'manual' as const,descriptionKnowledge:'manual' as const};
    if(p.currentLedgerId) await store.appendLedger({...base,id:`${p.id}_rev_${p.ledgerRevision}`,kind:'reversal',amountCents:p.currentLedgerCents,reversalOfId:p.currentLedgerId,description:'Processor payment adjustment'});
    p.ledgerRevision++;p.currentLedgerId=undefined;p.currentLedgerCents=target;
    if(!target)return;
    const id=`${p.id}_ledger_${p.ledgerRevision}`;const charges=eligibleCharges(await store.snapshot(),p.tenancyId,date);
    const ledger:RentOpsLedgerTransaction={...base,id,kind:'payment',amountCents:target,description:'Stripe tenant payment',allocationMode:'allocation_single'};await store.appendLedger(ledger);p.currentLedgerId=id;
    let remaining=target;for(const {transaction,openCents} of charges){const amount=Math.min(remaining,openCents);if(!amount)break;await store.appendAllocation({id:`tpa_${createHash('sha256').update(`${id}:${transaction.id}`).digest('hex')}`,paymentTransactionId:id,chargeTransactionId:transaction.id,amountCents:amount,allocatedOn:date,paymentLinkKnowledge:'manual',chargeLinkKnowledge:'manual',amountKnowledge:'known',allocatedOnKnowledge:'manual'});remaining-=amount;}
  }
}
export function createTenantPaymentService(options:{executor:RentOpsQueryExecutor;rentOpsRepository:RentOpsRepository;env:NodeJS.ProcessEnv}) {return new TenantPaymentService(new PostgresTenantPaymentStore(options.executor,options.rentOpsRepository),stripeProvider(options.env));}
