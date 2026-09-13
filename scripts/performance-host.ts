/** Local, read-only performance host. No database, secrets, mail or processors. */
import express from 'express';
import { resolve } from 'node:path';
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { emptyRentOpsSnapshot, type RentOpsWorkspaceCollection } from '../shared/rent-ops-contracts';
import { assertValidSnapshot } from '../server/rent-ops/domain/invariants';
import { registerRentOpsRoutes } from '../server/rent-ops/routes';
import { SyntheticRentOpsRepository } from '../server/rent-ops/repositories/synthetic';
import { workspaceBootstrapCollections } from '../server/rent-ops/presentation/workspace-read';
import { applicantPageSecurityHeaders, privatePortalHtml } from '../server/applicant-page-security';
import { publicAssets, createPageShell } from '../server/static-assets';
import { performanceNetwork } from './performance-network';
import { performanceFixture } from './performance-fixture';

if (process.env.NODE_ENV === 'production') throw new Error('Performance host is local and synthetic only');
const fixture = performanceFixture(30,40,process.env.RENT_OPS_PERFORMANCE_SINGLE_MONTH === '1');
assertValidSnapshot(fixture);
const repository = new SyntheticRentOpsRepository(fixture);
Object.assign(repository, {
  getSnapshot: async () => structuredClone(fixture),
  getOperationalSnapshot: async () => structuredClone(fixture),
  getReportSnapshot: async () => structuredClone(fixture),
  getWorkspaceSnapshot: async () => {
    const result = emptyRentOpsSnapshot();
    for (const name of workspaceBootstrapCollections) Object.assign(result, {[name]: structuredClone(fixture[name])});
    return result;
  },
  getWorkspaceCollection: async (name: RentOpsWorkspaceCollection) => structuredClone(fixture[name]),
});
const app = express();
app.use(performanceNetwork());
const resultsFile = process.env.RENT_OPS_PERFORMANCE_RESULTS_FILE;
app.post('/performance-result',express.json({limit:'100kb'}),(req,res)=>{
  if(resultsFile && typeof req.body?.path==='string' && Number.isFinite(req.body?.ready) && /^[a-f0-9]{64}$/.test(req.body?.textHash??'')){
    mkdirSync(dirname(resultsFile),{recursive:true});appendFileSync(resultsFile,JSON.stringify(req.body)+'\n');
  }
  res.status(204).end();
});
app.use((req,res,next)=>{
  if (!['GET','HEAD'].includes(req.method)) { res.status(405).json({error:'Read-only synthetic benchmark'});return; }
  res.set('Cache-Control','no-store');next();
});
const admin = {id:'performance-manager',email:'performance@example.test',role:'admin',firstName:'Performance',lastName:'Fixture'};
app.get('/api/rent-ops/auth/session',(_req,res)=>res.json({user:admin,csrfToken:'performance-fixture-local-csrf-2026-only'}));
app.get('/api/rent-ops/auth/csrf',(_req,res)=>res.json({csrfToken:'performance-fixture-local-csrf-2026-only'}));
app.get('/api/auth/me',(_req,res)=>res.json({user:admin}));
app.get('/api/rent-ops/tenant-accounts',(_req,res)=>res.json({accounts:[],eligibleTenancies:[],deliveryAvailable:false}));
registerRentOpsRoutes(app,{repository,requireAdmin:(_req,_res,next)=>next(),now:()=>new Date('2026-08-15T12:00:00Z'),previewSource:'synthetic'});
app.use(/^\/apply(?:\/|$)/,applicantPageSecurityHeaders);
const publicDir = resolve(process.env.RENT_OPS_PERFORMANCE_PUBLIC_DIR ?? 'dist/public');
app.get('/performance-probe.js', (_req,res)=>res.type('js').send(readFileSync(resolve('scripts/performance-probe.js'),'utf8')));
const optimized = process.env.RENT_OPS_PERFORMANCE_OPTIMIZED === '1';
const pageShell = optimized ? createPageShell(publicDir) : (url:string)=>privatePortalHtml(readFileSync(resolve(publicDir,'index.html'),'utf8'),url);
app.use(optimized ? publicAssets(publicDir) : express.static(publicDir,{index:false}));
app.get(/.*/, (req,res)=>res.type('html').send(pageShell(req.originalUrl).replace('<head>','<head><script src="/performance-probe.js"></script>')));
const port = Number(process.env.RENT_OPS_PERFORMANCE_PORT ?? 4191);
app.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({origin:`http://127.0.0.1:${port}`,synthetic:true,readOnly:true,counts:Object.fromEntries(Object.entries(fixture).filter(([,value])=>Array.isArray(value)).map(([key,value])=>[key,(value as unknown[]).length]))})));
