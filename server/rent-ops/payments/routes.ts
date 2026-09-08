import { RentOpsRetryableConflict } from "../runtime-database";
import express, { type Express, type Request, type RequestHandler, type Response } from 'express';
import type { TenantIdentity } from '../../../shared/tenant-portal-contracts';
import { TenantPaymentError } from './model';
import type { TenantPaymentService } from './service';
function failure(res:Response,error:unknown) {if(error instanceof RentOpsRetryableConflict){res.status(409).json({error:error.code,retryable:true});return;}const known=error instanceof TenantPaymentError;res.status(known?error.status:503).json({error:known?error.code:'payment_service_unavailable'});}
export function registerTenantPaymentWebhook(app:Express,options:{getService:()=>TenantPaymentService|undefined}) {
  app.post('/api/tenant/payments/webhook',express.raw({type:'application/json',limit:'1mb'}),async(req,res)=>{try{const service=options.getService();if(!service)throw new TenantPaymentError('payment_service_unavailable',503);const signature=req.get('stripe-signature');if(!signature||!Buffer.isBuffer(req.body))throw new TenantPaymentError('invalid_signature',400);await service.webhook(req.body,signature);res.json({received:true});}catch(error){failure(res,error);}});
}
export function registerTenantPaymentRoutes(app:Express,options:{service:TenantPaymentService;requireTenant:RequestHandler;getTenantIdentity:(req:Request)=>TenantIdentity|undefined}) {
  const identity=(req:Request)=>{const value=options.getTenantIdentity(req);if(!value)throw new TenantPaymentError('tenant_authentication_required',401);return value;};
  app.get('/api/tenant/payments',options.requireTenant,async(req,res)=>{try{res.set('Cache-Control','no-store');res.json(await options.service.list(identity(req)));}catch(error){failure(res,error);}});
  app.post('/api/tenant/payments/checkout',options.requireTenant,async(req,res)=>{try{res.set('Cache-Control','no-store');res.json(await options.service.checkout(identity(req),req.body));}catch(error){failure(res,error);}});
}
