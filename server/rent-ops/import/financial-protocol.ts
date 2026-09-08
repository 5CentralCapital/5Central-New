import {createFinancialSemanticCrosswalkEntry,CHARGE_CATEGORIES,type ChargeCategory,type RentManagerFinancialReviewHold} from '../../../shared/rent-ops-contracts';
import {deriveObservedFinancialCrosswalk} from '../export/observed-financial-crosswalk';
import type {ExportPayload} from '../export/types';
import {canonicalJson,sha256} from '../export/hash';
export interface FinancialProtocolPlan {
 version:'rm-recorded-ledger-protocol/v1';
 primaryEvidence: Array<{url:string;sha256:string}>;
 chargeCategories?: Array<{chargeTypeSourceId:string;evidenceRecordSha256:string;category:ChargeCategory}>;
 reviewHolds:Array<Omit<RentManagerFinancialReviewHold,'artifactSha256'|'sourceReference'>>;
}
const digest=(v:unknown)=>sha256(canonicalJson(v));
const check=(v:unknown)=>{if(!v)throw Error('financial_protocol_evidence_invalid')};
export function deriveFinancialProtocol(payload:ExportPayload,artifactSha256:string,plan:FinancialProtocolPlan){
 check(plan.version==='rm-recorded-ledger-protocol/v1'&&plan.primaryEvidence.length>0);
 for(const e of plan.primaryEvidence){const u=new URL(e.url);check(u.protocol==='https:'&&!u.username&&!u.password&&/^[a-f0-9]{64}$/.test(e.sha256));}
 const crosswalk=deriveObservedFinancialCrosswalk(payload,artifactSha256);
 for(const [collection,type] of [['charges','Charge'],['payments','Payment'],['credits','Credit']] as const){
  if((payload[collection]??[]).some(row=>row.TransactionType===type))crosswalk.entries.push(createFinancialSemanticCrosswalkEntry({artifactSha256,sourceCollection:collection,sourceField:'TransactionType',semanticKind:'ledger_status',normalization:'exact_v1',rawValue:type,targetValue:'posted'})!);
 }
 const categoryIds=new Set<string>();
 for(const entry of plan.chargeCategories??[]){
  check(!categoryIds.has(entry.chargeTypeSourceId)&&CHARGE_CATEGORIES.includes(entry.category));categoryIds.add(entry.chargeTypeSourceId);
  const matches=(payload.chargeTypeRecords??[]).filter(row=>String(row.sourceId)===entry.chargeTypeSourceId);check(matches.length===1);
  const row=matches[0];check(digest(row)===entry.evidenceRecordSha256&&String(row.ChargeTypeID)===entry.chargeTypeSourceId);
  crosswalk.entries.push(createFinancialSemanticCrosswalkEntry({artifactSha256,sourceCollection:'chargeTypes',sourceField:'ChargeTypeID',semanticKind:'charge_category',normalization:'exact_v1',rawValue:entry.chargeTypeSourceId,targetValue:entry.category})!);
 }
 const seen=new Set<string>();
 const financialReviewHolds=plan.reviewHolds.map(hold=>{
  check(hold.reason==='assistance_responsibility_unverified'&&!seen.has(hold.tenantSourceId));seen.add(hold.tenantSourceId);
  const tenant=(payload.tenants??[]).filter(t=>String(t.sourceId)===hold.tenantSourceId);check(tenant.length===1);
  check(hold.evidenceCollection==='tenants'||hold.evidenceCollection==='payments');
  const rows=payload[hold.evidenceCollection]??[];const matches=rows.map((row,index)=>({row,index})).filter(x=>String(x.row.sourceId)===hold.evidenceSourceId);check(matches.length===1);
  const {row,index}=matches[0];check(digest(row)===hold.evidenceRecordSha256);
  check(String(hold.evidenceCollection==='tenants'?row.TenantID:row.AccountID)===String(tenant[0].TenantID));
  return {...hold,artifactSha256,sourceReference:`export-envelope.json#/payload/${hold.evidenceCollection}/${index};sha256=${hold.evidenceRecordSha256}`};
 });
 return {financialSemanticCrosswalk:crosswalk,financialReviewHolds};
}
