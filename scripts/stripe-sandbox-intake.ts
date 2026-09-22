/** One-use, loopback-only credential handoff. Never persists or prints submitted credentials. */
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const ORIGIN='http://127.0.0.1:4177';
const HOST='127.0.0.1:4177';
export function validIntakeKey(value: string) {return /^sk_test_[A-Za-z0-9]{8,512}$/.test(value);}
function same(a:string,b:string){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
export function createSandboxIntake() {
  const session=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
  let used=false;
  const server=createServer((req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('X-Frame-Options','DENY');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin');
    const fail=(status:number)=>{res.writeHead(status,{'Content-Type':'text/plain'});res.end('Local credential handoff unavailable.');};
    if(req.headers.host!==HOST || !['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??'')) {fail(403);return;}
    if(used) {fail(410);return;}
    if(req.method==='GET'&&req.url==='/') {
      res.setHeader('Set-Cookie',`qa_intake=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=300`);
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      res.end(`<!doctype html><html><head><title>Stripe sandbox setup</title></head><body><h1>Stripe sandbox setup</h1><form method="post" action="/launch" autocomplete="off"><input type="hidden" name="csrf" value="${csrf}"><label>Sandbox secret key <input type="password" name="key" required autocomplete="off" maxlength="520"></label><button type="submit">Start sandbox QA</button></form></body></html>`);return;
    }
    if(req.method!=='POST'||req.url!=='/launch'){fail(404);return;}
    const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('qa_intake='))?.slice(10)??'';
    if(req.headers.origin!==ORIGIN || !same(cookie,session) || req.headers['content-type']?.split(';')[0].trim()!=='application/x-www-form-urlencoded') {console.log('Credential intake validation:',JSON.stringify({originMatches:req.headers.origin===ORIGIN,originIsNull:req.headers.origin==='null',cookiePresent:Boolean(cookie),cookieMatches:same(cookie,session),contentTypeMatches:req.headers['content-type']?.split(';')[0].trim()==='application/x-www-form-urlencoded'}));fail(403);return;}
    let body='';let rejected=false;
    req.on('data',chunk=>{if(rejected)return;body+=chunk.toString();if(Buffer.byteLength(body)>2048){body='';rejected=true;fail(413);req.resume();}});
    req.on('end',()=>{
      if(rejected)return;
      const data=new URLSearchParams(body);body='';
      let key=data.get('key')??'';data.delete('key');
      if(used||!same(data.get('csrf')??'',csrf)||!validIntakeKey(key)){key='';fail(403);return;}
      used=true;
      const child=spawn(resolve('node_modules/.bin/tsx'),['--no-cache','scripts/stripe-sandbox-qa.ts'],{cwd:process.cwd(),env:{...process.env,STRIPE_SECRET_KEY:key,QA_STRIPE_SANDBOX:'1',TSX_DISABLE_CACHE:'1'},stdio:['ignore','pipe','pipe']});key='';
      child.once('spawn',()=>{
        res.setHeader('Set-Cookie','qa_intake=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        res.writeHead(200,{'Content-Type':'text/plain'});res.end('Sandbox launcher started. Account verification is in progress.');
        server.close();console.log('Credential handoff accepted. Sandbox launcher started; account verification pending.');
      });
      // Only emit recognized safe launcher status; never forward arbitrary child output.
      const consume=(chunk:Buffer)=>{
        const value=chunk.toString();
        if(value.includes('Stripe sandbox account verified: acct_1UDBUjGr5LUo8wLL'))console.log('Stripe sandbox account verified: acct_1UDBUjGr5LUo8wLL');
        const diagnostic=value.match(/Sandbox provider diagnostic: (\{[^\n]{1,300}\})/);
        if(diagnostic) { try { const d=JSON.parse(diagnostic[1]); if(Object.keys(d).sort().join(',')==='code,param,type' && Object.values(d).every(v=>typeof v==='string' && /^[A-Za-z0-9_.\[\]-]{1,80}$/.test(v))) console.log('Sandbox provider diagnostic:',JSON.stringify(d)); } catch {} }
        if(value.includes('TEST ONLY: http://127.0.0.1:4176/qa'))console.log('Sandbox QA ready: http://127.0.0.1:4176/qa');
      };
      child.stdout.on('data',consume);child.stderr.resume();
      child.once('error',()=>{if(!res.writableEnded)fail(500);console.error('Sandbox launcher could not start.');server.close();});
      child.once('exit',code=>{console.log(code===0?'Sandbox launcher stopped.':'Sandbox launcher stopped or account verification failed.');});
      process.once('SIGINT',()=>child.kill('SIGTERM'));process.once('SIGTERM',()=>child.kill('SIGTERM'));
    });
    req.on('error',()=>{body='';});
  });
  server.requestTimeout=10000;server.headersTimeout=10000;
  const expiry=setTimeout(()=>server.close(),300000);expiry.unref();server.once('close',()=>clearTimeout(expiry));
  return server;
}
if(process.argv[1]&&resolve(process.argv[1])===resolve('scripts/stripe-sandbox-intake.ts')){
  const server=createSandboxIntake();server.once('error',()=>{console.error('Local credential intake could not bind.');process.exitCode=1;});
  server.listen(4177,'127.0.0.1',()=>console.log(`Sandbox credential intake ready: ${ORIGIN}`));
}
