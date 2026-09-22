import assert from 'node:assert/strict';
import test from 'node:test';
import {fetchLeasePdf,leasePdfPath,MAX_LEASE_BYTES} from './lease-pdf';
const signal=new AbortController().signal;
test('lease viewer uses encoded protected path, cookies and exact original bytes',async()=>{
 const bytes=new TextEncoder().encode('%PDF-1.7\noriginal');
 const received=await fetchLeasePdf('lease:/one',signal,async(input,init)=>{assert.equal(input,'/api/tenant/lease-files/lease%3A%2Fone/download');assert.equal(init?.credentials,'same-origin');assert.equal(init?.cache,'no-store');assert.equal(init?.redirect,'error');return new Response(bytes,{headers:{'content-type':'application/pdf'}});});assert.deepEqual(received,bytes);
 assert.equal(leasePdfPath('https://evil.test'),'/api/tenant/lease-files/https%3A%2F%2Fevil.test/download');
});
test('lease viewer rejects expired/denied sessions, HTML masquerades and oversized responses',async()=>{
 for(const response of [new Response('',{status:401}),new Response('',{status:404}),new Response('<html/>',{headers:{'content-type':'application/pdf'}}),new Response('%PDF-1.7',{headers:{'content-type':'text/html'}}),new Response('%PDF-1.7',{headers:{'content-type':'application/pdf','content-length':String(MAX_LEASE_BYTES+1)}})])await assert.rejects(fetchLeasePdf('own',signal,async()=>response));
});
