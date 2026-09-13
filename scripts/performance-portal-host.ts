import express from 'express';
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createTenantQa } from './tenant-local-qa';
import { runTenantFlow } from './tenant-flow-qa';
import { performanceNetwork } from './performance-network';
import { createPageShell, publicAssets } from '../server/static-assets';

if(process.env.NODE_ENV==='production')throw new Error('Synthetic localhost performance host only');
const publicDir=resolve(process.env.RENT_OPS_PERFORMANCE_PUBLIC_DIR??'dist/public');
const optimized=process.env.RENT_OPS_PERFORMANCE_OPTIMIZED==='1';
const shell=optimized?createPageShell(publicDir):undefined;
const results=process.env.RENT_OPS_PERFORMANCE_RESULTS_FILE;
const qa=await createTenantQa({publicDir,assets:optimized?publicAssets(publicDir):undefined,
  setupApp(app){app.use(performanceNetwork());app.get('/performance-probe.js',(_req,res)=>res.type('js').send(readFileSync(resolve('scripts/performance-probe.js'),'utf8')));
    app.post('/performance-result',express.json({limit:'100kb'}),(req,res)=>{if(results&&Number.isFinite(req.body?.ready)&&/^[a-f0-9]{64}$/.test(req.body?.textHash??'')){mkdirSync(dirname(results),{recursive:true});appendFileSync(results,JSON.stringify(req.body)+'\n');}res.status(204).end();});},
  transformHtml(html,url){return (shell?shell(url):html).replace('<head>','<head><script src="/performance-probe.js"></script>');},
});
await runTenantFlow(qa,{serve:true,untilBilling:true,port:Number(process.env.RENT_OPS_PERFORMANCE_PORT??4194)});
