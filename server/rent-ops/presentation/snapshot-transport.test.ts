import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import express from 'express';import {gunzipSync,brotliDecompressSync} from 'node:zlib';import {compactAdminSnapshot,sendAdminSnapshot} from './snapshot-transport';import type {AdminDashboardView} from './dashboard';
function bundle():AdminDashboardView{
 // 20,000 ordinary history summaries model the measured production duplication.
 const activities=Array.from({length:20000},(_,i)=>({id:`activity-${i}`,type:'note',occurredAt:'2026-09-08T12:00:00.000Z',summary:'Synthetic operational history. '.repeat(35)}));
 const ledger=Array.from({length:10049},(_,i)=>({id:`ledger-${i}`,description:'Synthetic rent',amountCents:10000}));
 const reports={'tenant-ledger':ledger,'rent-roll':[]};
 return {generatedAt:'2026-09-08T12:00:00.000Z',summary:{},snapshot:{activityEvents:activities,ledgerTransactions:ledger,documents:[]} as any,reports,activities,documents:[],tenants:[],applicants:[],rentRoll:[],occupancy:[],scheduledIncome:[],collectedIncome:[],scheduledVsCollected:[],delinquency:[],ledger,leaseExpiration:[],depositLiability:[],hap:[]};
}
test('compact snapshot sends each duplicate once and negotiates equivalent identity/gzip over HTTP',async()=>{
 const original=bundle(),compact=compactAdminSnapshot(original);const originalSize=Buffer.byteLength(JSON.stringify(original)),compactSize=Buffer.byteLength(JSON.stringify(compact));assert.ok(originalSize>32*1024*1024);assert.ok(compactSize<32*1024*1024);
 assert.deepEqual(Object.keys(compact),['transportVersion','generatedAt','summary','snapshot','reports','tenants','applicants']);assert.equal(compact.snapshot?.activityEvents,original.activities);assert.equal(compact.reports['tenant-ledger'],original.ledger);
 const app=express();app.get('/',(req,res,next)=>{void sendAdminSnapshot(req,res,original).catch(next);});const server=await new Promise<http.Server>(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const request=(encoding?:string)=>new Promise<{body:Buffer,headers:http.IncomingHttpHeaders}>(resolve=>{http.get({host:'127.0.0.1',port:(server.address() as any).port,path:'/',headers:encoding?{'accept-encoding':encoding}:{}},res=>{const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({body:Buffer.concat(chunks),headers:res.headers}));});});
 try{const plain=await request();const compressed=await request('gzip');assert.equal(plain.headers['content-encoding'],undefined);assert.equal(compressed.headers['content-encoding'],'gzip');assert.equal(compressed.headers['cache-control'],'no-store');assert.match(String(compressed.headers.vary),/Accept-Encoding/);assert.deepEqual(gunzipSync(compressed.body),plain.body);assert.ok(compressed.body.length<plain.body.length);assert.deepEqual(JSON.parse(plain.body.toString()),JSON.parse(JSON.stringify(compact)));const refused=await request('br;q=0,gzip;q=0, identity;q=1');assert.equal(refused.headers['content-encoding'],undefined);assert.deepEqual(refused.body,plain.body);
  const brotli=await request('br,gzip');assert.equal(brotli.headers['content-encoding'],'br');assert.deepEqual(brotliDecompressSync(brotli.body),plain.body);assert.equal(brotli.headers['cache-control'],'no-store');
  const fallback=await request('br;q=0,gzip');assert.equal(fallback.headers['content-encoding'],'gzip');assert.deepEqual(gunzipSync(fallback.body),plain.body);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
