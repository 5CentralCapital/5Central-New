import assert from 'node:assert/strict';
import test from 'node:test';
import {canonicalJson,sha256} from '../export/hash';
import type {ExportPayload} from '../export/types';
import {deriveFinancialProtocol,type FinancialProtocolPlan} from './financial-protocol';
const artifact='a'.repeat(64);
const tenant={sourceId:'tenant:7',TenantID:7,Status:'Current'};
const payment={sourceId:'payment:9',AccountID:7,TransactionType:'Payment',Amount:100};
const payload={tenants:[tenant],payments:[payment],charges:[{sourceId:'charge:2',TransactionType:'Charge'}],credits:[{sourceId:'credit:3',TransactionType:'Credit'}]} as unknown as ExportPayload;
const plan:FinancialProtocolPlan={version:'rm-recorded-ledger-protocol/v1',primaryEvidence:[{url:'https://example.test/synthetic-protocol',sha256:'b'.repeat(64)}],reviewHolds:[{tenantSourceId:'tenant:7',reason:'assistance_responsibility_unverified',evidenceCollection:'payments',evidenceSourceId:'payment:9',evidenceRecordSha256:sha256(canonicalJson(payment))}]};
test('protocol translation binds exact endpoint types and review evidence without altering raw records',()=>{
 const before=canonicalJson(payload);const result=deriveFinancialProtocol(payload,artifact,plan);
 assert.equal(canonicalJson(payload),before);
 assert.equal(result.financialSemanticCrosswalk.entries.filter(x=>x.semanticKind==='ledger_status').length,3);
 assert.equal(result.financialReviewHolds[0].artifactSha256,artifact);
 assert.match(result.financialReviewHolds[0].sourceReference,/payload\/payments\/0;sha256=/);
 assert.equal(result.financialReviewHolds[0].reason,'assistance_responsibility_unverified');
 const unknown=deriveFinancialProtocol({...payload,charges:[{sourceId:'x',TransactionType:'PendingCharge'}]} as ExportPayload,artifact,{...plan,reviewHolds:[]});
 assert.equal(unknown.financialSemanticCrosswalk.entries.some(x=>x.sourceCollection==='charges'),false);
});
test('review evidence rejects changed bytes, wrong account, duplicate hold and missing evidence',()=>{
 for(const changed of [
  {...plan,reviewHolds:[{...plan.reviewHolds[0],evidenceRecordSha256:'c'.repeat(64)}]},
  {...plan,reviewHolds:[...plan.reviewHolds,...plan.reviewHolds]},
  {...plan,reviewHolds:[{...plan.reviewHolds[0],evidenceSourceId:'missing'}]},
  {...plan,primaryEvidence:[]},
 ])assert.throws(()=>deriveFinancialProtocol(payload,artifact,changed));
 const other={...payment,AccountID:8};
 assert.throws(()=>deriveFinancialProtocol({...payload,payments:[other]} as ExportPayload,artifact,{...plan,reviewHolds:[{...plan.reviewHolds[0],evidenceRecordSha256:sha256(canonicalJson(other))}]}));
});

test('reviewed category mapping requires exact source ID and complete definition hash',()=>{
 const definition={sourceId:'2',ChargeTypeID:2,Name:'RC',Description:'Rent Charge'};
 const source={...payload,chargeTypeRecords:[definition]} as ExportPayload;
 const entry={chargeTypeSourceId:'2',evidenceRecordSha256:sha256(canonicalJson(definition)),category:'base_rent' as const};
 const result=deriveFinancialProtocol(source,artifact,{...plan,chargeCategories:[entry]});
 assert.equal(result.financialSemanticCrosswalk.entries.find(x=>x.semanticKind==='charge_category')?.targetValue,'base_rent');
 assert.equal(deriveFinancialProtocol(source,artifact,plan).financialSemanticCrosswalk.entries.some(x=>x.semanticKind==='charge_category'),false);
 assert.throws(()=>deriveFinancialProtocol({...source,chargeTypeRecords:[{...definition,Description:'Changed'}]} as ExportPayload,artifact,{...plan,chargeCategories:[entry]}));
 assert.throws(()=>deriveFinancialProtocol(source,artifact,{...plan,chargeCategories:[entry,entry]}));
 assert.throws(()=>deriveFinancialProtocol(source,artifact,{...plan,chargeCategories:[{...entry,chargeTypeSourceId:'3'}]}));
});
