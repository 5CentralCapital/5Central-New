import assert from "node:assert/strict";
import test from "node:test";
import { createTenantAccessNotifier } from "./delivery";
import { InMemoryTenantAccountStore } from "./test-store";
import { bootstrapAdministrator } from "../../admin-bootstrap";

test("tenant email is opt-in and uses distinct issuance keys without exposing secret",async()=>{
 assert.equal(createTenantAccessNotifier({}),undefined);
 const requests:RequestInit[]=[];
 const notify=createTenantAccessNotifier({RENT_OPS_TENANT_EMAIL_ENABLED:"true",RENT_OPS_MAGIC_LINK_WEBHOOK_URL:"https://delivery.example.test",RENT_OPS_PUBLIC_APP_URL:"https://portal.example.test",RENT_OPS_MAGIC_LINK_WEBHOOK_SECRET:"synthetic-secret-12345"},async(_url,init)=>{requests.push(init!);return new Response("",{status:202});})!;
 for(const issuanceId of ["one","two"]) await notify({issuanceId,accountId:"account",email:"synthetic@example.test",token:"opaque",expiresAt:"2026-09-08T00:00:00Z",purpose:"password_reset"});
 assert.notEqual((requests[0].headers as Record<string,string>)["Idempotency-Key"],(requests[1].headers as Record<string,string>)["Idempotency-Key"]);
 assert.match(String(requests[0].body),/tenant#activate=opaque/);
 assert.doesNotMatch(String(requests[0].body),/synthetic-secret/);
});

test("recovery preserves working credentials; failure clears only its own token; reset is one-use",async()=>{
 const store=new InMemoryTenantAccountStore(); const now="2026-09-07T00:00:00Z",expires="2026-09-08T00:00:00Z";
 await store.create({id:"a",email:"a@example.test",personId:"p",tenancyId:"t",tokenHash:"first",expiresAt:expires,now});
 const active=(await store.consumeActivation("first","old-hash",now))!;
 await store.issueRecovery("a","reset",expires,now);
 assert.equal((await store.getById("a"))!.passwordHash,"old-hash");
 assert.equal((await store.getById("a"))!.sessionVersion,active.sessionVersion);
 await store.issueRecovery("a","newer",expires,now); await store.invalidateToken("a","reset");
 assert.equal((await store.getById("a"))!.activationTokenHash,"newer");
 const reset=(await store.consumeActivation("newer","new-hash",now))!;
 assert.equal(reset.sessionVersion,active.sessionVersion+1);
 assert.equal(await store.consumeActivation("newer","replay",now),undefined);
 await store.issueRecovery("a","expired",now,now);
 assert.equal(await store.consumeActivation("expired","bad",expires),undefined);
});

test("admin bootstrap rejects weak input and never overwrites existing accounts",async()=>{
 let sql=""; let values:unknown[]=[];
 const database={query:async(query:string,args:unknown[])=>{sql=query;values=args;return {rows:[]};}};
 await assert.rejects(bootstrapAdministrator(database as never,{email:"admin@example.test",password:"short"},async()=>"hash"),/16 to 128/);
 await assert.rejects(bootstrapAdministrator(database as never,{email:"admin@example.test",password:"synthetic-long-password"},async()=>"hash"),/already exists/);
 assert.match(sql,/ON CONFLICT DO NOTHING/); assert.doesNotMatch(sql,/UPDATE/); assert.equal(values[2],"hash");
});

test("direct Gmail refreshes authorized credentials and sends MIME through official endpoint",async()=>{
 const calls:Array<{url:string;init:RequestInit}>=[];
 const notify=createTenantAccessNotifier({RENT_OPS_TENANT_EMAIL_ENABLED:"true",RENT_OPS_TENANT_EMAIL_PROVIDER:"gmail",RENT_OPS_GMAIL_FROM:"sender@example.test",RENT_OPS_GMAIL_CLIENT_ID:"synthetic-client",RENT_OPS_GMAIL_CLIENT_SECRET:"synthetic-secret",RENT_OPS_GMAIL_REFRESH_TOKEN:"synthetic-refresh",RENT_OPS_PUBLIC_APP_URL:"https://portal.example.test"},async(url,init)=>{calls.push({url:String(url),init:init!});return Response.json(calls.length===1?{access_token:"synthetic-access"}:{id:"accepted-message"});})!;
 const input={issuanceId:"synthetic-issue",accountId:"account",email:"resident@example.test",token:"a".repeat(43),expiresAt:"2026-09-08T00:00:00Z",purpose:"invitation" as const};
 await notify(input);
 assert.equal(calls[0].url,"https://oauth2.googleapis.com/token");
 assert.equal(calls[1].url,"https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
 const mime=Buffer.from(JSON.parse(String(calls[1].init.body)).raw,"base64url").toString();
 assert.match(mime,/To: <resident@example.test>/); assert.doesNotMatch(mime,/synthetic-secret|synthetic-refresh/);
 await assert.rejects(notify({...input,email:"resident@example.test\r\nBcc: other@example.test"}),/Invalid/);
});

test("Gmail accepts a managed credential supplier without manual refresh credentials",async()=>{
 const {createGmailTenantNotifier}=await import("./gmail-delivery");
 let supplied=0; const urls:string[]=[];
 const notify=createGmailTenantNotifier({RENT_OPS_GMAIL_FROM:"sender@example.test",RENT_OPS_PUBLIC_APP_URL:"https://portal.example.test"},async(url,init)=>{urls.push(String(url));assert.equal((init?.headers as Record<string,string>).Authorization,"Bearer managed-synthetic");return Response.json({id:"accepted"});},async()=>{supplied++;return "managed-synthetic";});
 await notify({issuanceId:"managed-issue",accountId:"account",email:"recipient@example.test",token:"a".repeat(43),expiresAt:"2026-09-08T00:00:00Z",purpose:"password_reset"});
 assert.equal(supplied,1);assert.deepEqual(urls,["https://gmail.googleapis.com/gmail/v1/users/me/messages/send"]);
});

test("managed Gmail proxy receives no app-supplied bearer credential",async()=>{
 const {createGmailTenantNotifier}=await import("./gmail-delivery");
 const notify=createGmailTenantNotifier({RENT_OPS_GMAIL_FROM:"sender@example.test",RENT_OPS_PUBLIC_APP_URL:"https://portal.example.test"},async(_url,init)=>{assert.equal((init?.headers as Record<string,string>).Authorization,undefined);return Response.json({id:"accepted"});},async()=>"managed-proxy",true);
 await notify({issuanceId:"managed-issue",accountId:"account",email:"recipient@example.test",token:"a".repeat(43),expiresAt:"2026-09-08T00:00:00Z",purpose:"invitation"});
});
