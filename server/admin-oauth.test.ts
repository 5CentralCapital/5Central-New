import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import session from "express-session";
import { once } from "node:events";
import { ADMIN_OAUTH_SUBJECT, ADMIN_OAUTH_CALLBACK, ADMIN_OAUTH_ISSUER, managerOAuthAllowed, consumeOAuthPending, registerManagerOAuthRoutes } from "./admin-oauth";
const env = { RENT_OPS_ADMIN_OAUTH_CLIENT_ID: "synthetic-client", RENT_OPS_ADMIN_EMAIL: "michael@5central.capital", RENT_OPS_OAUTH_ADMIN_SUBJECTS: ADMIN_OAUTH_SUBJECT };
test("state is expiring and one-use, allowlist is exact", () => {
 const s={rentOpsOAuthPending:{state:"opaque-state",verifier:"verifier",expiresAt:100}};
 assert.equal(consumeOAuthPending(s,"wrong",1),undefined);assert.equal(consumeOAuthPending(s,"opaque-state",1),undefined);
 const expired={rentOpsOAuthPending:{state:"opaque-state",verifier:"verifier",expiresAt:100}};assert.equal(consumeOAuthPending(expired,"opaque-state",100),undefined);
 assert.equal(managerOAuthAllowed(env,ADMIN_OAUTH_SUBJECT),true);assert.equal(managerOAuthAllowed(env,"google-oauth2|other"),false);assert.equal(managerOAuthAllowed({...env,RENT_OPS_ADMIN_EMAIL:"other@example.test"},ADMIN_OAUTH_SUBJECT),false);
});
async function fixture(options: { scopes?: string[]; subject?: string; admin?: boolean } = {}) {
 const app=express();app.use(session({secret:"synthetic-test-session-secret",resave:false,saveUninitialized:false}));let exchanges=0;
 registerManagerOAuthRoutes(app,{env,csrfToken:()=>"synthetic-csrf",limit:()=>0,discover:async()=>{},getAdmin:async()=>({id:"admin",email:"michael@5central.capital",role:options.admin===false?"investor":"admin"}),verify:async(_t,c)=>{assert.equal(c.issuer,ADMIN_OAUTH_ISSUER);return {subject:options.subject??ADMIN_OAUTH_SUBJECT,scopes:options.scopes??["rent-ops:read"]};},fetcher:async(_url,init)=>{exchanges++;const body=init?.body as URLSearchParams;assert.equal(body.get("redirect_uri"),ADMIN_OAUTH_CALLBACK);assert.ok(body.get("code_verifier")!.length>=43);assert.equal(body.get("client_secret"),null);return Response.json({access_token:"synthetic-token",token_type:"Bearer"});}});
 app.get("/test-session",(req,res)=>res.json({admin:req.session.rentOpsAdminUserId,subject:req.session.rentOpsOAuthSubject,pending:!!req.session.rentOpsOAuthPending}));
 const server=app.listen(0,"127.0.0.1");await once(server,"listening");const base=`http://127.0.0.1:${(server.address() as any).port}`;
 return {base,exchanges:()=>exchanges,close:()=>new Promise<void>(r=>server.close(()=>r()))};
}
test("PKCE callback rotates session, pins redirect and refuses callback replay",async()=>{const f=await fixture();try{
 const start=await fetch(`${f.base}/api/rent-ops/auth/oauth/start?returnTo=https://evil.test`,{redirect:"manual"});const cookie=start.headers.get("set-cookie")!.split(";")[0];const url=new URL(start.headers.get("location")!);assert.equal(url.searchParams.get("code_challenge_method"),"S256");assert.equal(url.searchParams.get("redirect_uri"),ADMIN_OAUTH_CALLBACK);assert.equal(url.searchParams.has("code_verifier"),false);
 const callback=`${f.base}/api/rent-ops/auth/oauth/callback?state=${url.searchParams.get("state")}&code=synthetic`;
 const done=await fetch(callback,{headers:{cookie},redirect:"manual"});assert.equal(done.headers.get("location"),"https://5-central-new.replit.app/ops");const rotated=done.headers.get("set-cookie")!.split(";")[0];assert.notEqual(rotated,cookie);const state=await (await fetch(`${f.base}/test-session`,{headers:{cookie:rotated}})).json();assert.equal(state.admin,"admin");assert.equal(state.subject,ADMIN_OAUTH_SUBJECT);assert.equal(state.pending,false);
 const replay=await fetch(callback,{headers:{cookie:rotated},redirect:"manual"});assert.match(replay.headers.get("location")!,/login=failed/);assert.equal(f.exchanges(),1);
 }finally{await f.close();}});
for(const value of [{scopes:[]},{subject:"google-oauth2|wrong"},{admin:false}])test(`rejects missing scope, wrong subject or nonadmin ${JSON.stringify(value)}`,async()=>{const f=await fixture(value);try{const start=await fetch(`${f.base}/api/rent-ops/auth/oauth/start`,{redirect:"manual"});const cookie=start.headers.get("set-cookie")!.split(";")[0];const state=new URL(start.headers.get("location")!).searchParams.get("state");const result=await fetch(`${f.base}/api/rent-ops/auth/oauth/callback?state=${state}&code=x`,{headers:{cookie},redirect:"manual"});assert.match(result.headers.get("location")!,/login=failed/);}finally{await f.close();}});
