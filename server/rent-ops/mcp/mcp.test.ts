import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRentOpsMcpServer, type McpOperationalOptions } from './tools';
import { verifyOAuthToken, READ_SCOPE, WRITE_SCOPE, type OAuthConfig } from './oauth';
import { RentOpsService } from '../services/service';
import { createSyntheticRentOpsRepository } from '../fixtures/synthetic';
const config: OAuthConfig = {issuer:'https://auth.example.test',resource:'https://app.example.test/mcp',introspectionEndpoint:'https://auth.example.test/introspect',introspectionClientId:'test',introspectionClientSecret:'test',adminSubjects:['admin']};
const valid = {active:true,iss:config.issuer,aud:config.resource,exp:Date.now()/1000+60,sub:'admin',scope:READ_SCOPE};
test('OAuth rejects wrong audience, issuer, subject, expiry, scope and revoked tokens',async () => {
  for (const patch of [{active:false},{aud:'other'},{iss:'other'},{sub:'tenant'},{exp:1},{scope:WRITE_SCOPE}]) await assert.rejects(verifyOAuthToken('token',config,async () => new Response(JSON.stringify({...valid,...patch}))));
  assert.equal((await verifyOAuthToken('token',config,async () => new Response(JSON.stringify(valid)))).subject,'admin');
});
async function connect(scopes: string[], options: McpOperationalOptions = {}) {
  const repository = createSyntheticRentOpsRepository(); const service = new RentOpsService(repository);
  const server = createRentOpsMcpServer(service,{subject:'admin',scopes},config.resource,options);
  const client = new Client({name:'test',version:'1'}); const [a,b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  return {repository,service,client,close:async () => {await client.close();await server.close();}};
}
test('MCP advertises annotated tools and prevents read-scope writes',async () => {
  const ctx=await connect([READ_SCOPE]); try {
    const tools=await ctx.client.listTools(); assert.equal(tools.tools.length,26);
    for(const tool of tools.tools) assert.equal(tool.annotations?.openWorldHint,false);
    const person=(await ctx.service.snapshot()).people[0];
    const result=await ctx.client.callTool({name:'update_tenant_contact',arguments:{id:person.id,revision:person.recordRevision ?? 1,patch:{phone:'555-0100'}}});
    assert.equal(result.isError,true);
    assert.match(String(result._meta?.['mcp/www_authenticate']),/resource_metadata=.*error|error_description=.*resource_metadata/);
    const report=await ctx.client.callTool({name:'get_report',arguments:{report:'deposits',filters:{}}}); assert.notEqual(report.isError,true);
    const invalidReport=await ctx.client.callTool({name:'get_report',arguments:{report:'sql',filters:{}}}); assert.equal(invalidReport.isError,true);
    assert.notEqual((await ctx.service.snapshot()).people[0].phone,'555-0100');
  } finally {await ctx.close();}
});
test('MCP updates through audited domain and stale retries cannot overwrite',async () => {
  const ctx=await connect([READ_SCOPE,WRITE_SCOPE]); try {
    const person=(await ctx.service.snapshot()).people[0];
    const args={id:person.id,revision:person.recordRevision ?? 1,patch:{phone:'555-0100'}};
    const result=await ctx.client.callTool({name:'update_tenant_contact',arguments:args}); assert.notEqual(result.isError,true,JSON.stringify(result));
    assert.equal((await ctx.service.snapshot()).people[0].phone,'555-0100');
    const retry=await ctx.client.callTool({name:'update_tenant_contact',arguments:{...args,patch:{phone:'555-0200'}}}); assert.equal(retry.isError,true);
    assert.equal((await ctx.service.snapshot()).people[0].phone,'555-0100');
    const fetched=await ctx.client.callTool({name:'fetch',arguments:{id:`tenant/${person.id}`}}); assert.notEqual(fetched.isError,true);
  } finally {await ctx.close();}
});
test('MCP rejects untyped IDs and provenance fields cannot reach a mutation',async () => {
  const ctx=await connect([READ_SCOPE,WRITE_SCOPE]); try {
    const invalid=await ctx.client.callTool({name:'fetch',arguments:{id:'raw-untyped-id'}}); assert.equal(invalid.isError,true);
    const person=(await ctx.service.snapshot()).people[0];
    const result=await ctx.client.callTool({name:'update_tenant_contact',arguments:{id:person.id,revision:person.recordRevision ?? 1,patch:{phone:'555-9999',actorSubject:'attacker'}}});
    assert.equal(result.isError,true); assert.notEqual((await ctx.service.snapshot()).people[0].phone,'555-9999');
    const application=(await ctx.service.snapshot()).applications[0];
    if(application) {const read=await ctx.client.callTool({name:'get_application',arguments:{id:application.id}}); assert.equal(JSON.stringify(read).includes('profileAnswers'),false);}
  } finally {await ctx.close();}
});

test('Auth0 JWT validates signed RS256 exact claims and never accepts another algorithm or stale token', async () => {
  const { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } = await import('jose');
  const { verifyJwtToken } = await import('./oauth');
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); const key = createLocalJWKSet({keys:[{...jwk,kid:'test',alg:'RS256',use:'sig'}]});
  const now = Math.floor(Date.now()/1000);
  const claims = {iss:config.issuer,aud:config.resource,sub:'admin',iat:now,exp:now+300,scope:READ_SCOPE};
  const sign = (patch: Record<string,unknown>={}) => new SignJWT({...claims,...patch}).setProtectedHeader({alg:'RS256',kid:'test'}).sign(privateKey);
  assert.equal((await verifyJwtToken(await sign(),config,key)).subject,'admin');
  for (const patch of [{iss:'https://other.example'},{aud:'other'},{sub:'tenant'},{exp:now-1},{nbf:now+60},{scope:WRITE_SCOPE},{exp:now+1800},{iat:now-1000,exp:now+1}]) await assert.rejects(verifyJwtToken(await sign(patch),config,key));
  const wrong = await new SignJWT(claims).setProtectedHeader({alg:'HS256',kid:'test'}).sign(new TextEncoder().encode('synthetic-key-at-least-thirty-two-characters'));
  await assert.rejects(verifyJwtToken(wrong,config,key));
  const altered = (await sign()).split('.'); altered[1]=Buffer.from(JSON.stringify({...claims,sub:'tenant'})).toString('base64url');
  await assert.rejects(verifyJwtToken(altered.join('.'),config,key));
});

test('JWT issuer discovery pins issuer, PKCE and same-origin HTTPS signing keys', async () => {
  const { validateIssuer, oauthConfigFromEnv } = await import('./oauth');
  const jwtConfig = {...config,mode:'jwt' as const};
  const metadata = {issuer:config.issuer,authorization_endpoint:config.issuer+'/authorize',token_endpoint:config.issuer+'/token',jwks_uri:config.issuer+'/.well-known/jwks.json',code_challenge_methods_supported:['S256']};
  const fetcher = (patch:Record<string,unknown>={}) => (async () => new Response(JSON.stringify({...metadata,...patch}))) as typeof fetch;
  await validateIssuer(jwtConfig,fetcher());
  for(const patch of [{issuer:'https://other.test'},{jwks_uri:'https://other.test/keys'},{jwks_uri:'http://auth.example.test/keys'},{code_challenge_methods_supported:['plain']}]) await assert.rejects(validateIssuer({...jwtConfig},fetcher(patch)));
  const env = {RENT_OPS_MCP_ENABLED:'true',RENT_OPS_ADMIN_EMAIL:'admin@example.test',RENT_OPS_OAUTH_ISSUER:config.issuer,RENT_OPS_MCP_RESOURCE:config.resource,RENT_OPS_OAUTH_ADMIN_SUBJECTS:'admin'};
  assert.equal(oauthConfigFromEnv(env)?.mode,'jwt');
  assert.throws(()=>oauthConfigFromEnv({...env,RENT_OPS_OAUTH_TOKEN_MODE:'introspection'}));
});


test('imported prospect names are discoverable and exact reads contain only curated identity fields',async()=>{
 const repository=createSyntheticRentOpsRepository();const base=await repository.getSnapshot();
 const prospect={id:'prospect:rm:396',source:{system:'rent_manager',sourceId:'396'},recordRevision:3,firstName:'QA Prospect',lastName:'Discoverable',email:'qa@example.test',status:'submitted',statusKnowledge:'source',createdOn:'2026-08-01',createdOnKnowledge:'source',updatedOnKnowledge:'unknown',profileAnswers:{ssn:'123-45-6789'},ssn:'123-45-6789',resumeToken:'secret-token',documents:[{storageKey:'secret-key'}]};
 repository.getSnapshot=async()=>({...base,applicationHistory:{prospects:[prospect]} as any});
 const service=new RentOpsService(repository);const server=createRentOpsMcpServer(service,{subject:'admin',scopes:[READ_SCOPE]},config.resource);
 const client=new Client({name:'prospect-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 try{
  const search=await client.callTool({name:'search',arguments:{query:'QA Prospect Discoverable'}});assert.notEqual(search.isError,true);assert.match(JSON.stringify(search),/prospect\/prospect:rm:396/);
  const native=base.applications[0];assert.ok(native.firstName&&native.lastName);
  const applicationSearch=await client.callTool({name:'search',arguments:{query:`${native.firstName} ${native.lastName}`}});assert.match(JSON.stringify(applicationSearch),new RegExp(`application/${native.id}`));
  for(const name of ['fetch','get_prospect']){
   const result=await client.callTool({name,arguments:{id:name==='fetch'?'prospect/prospect:rm:396':'prospect:rm:396'}});assert.notEqual(result.isError,true);
   const value=(result.structuredContent as any).data;const record=name==='fetch'?JSON.parse(value.text):value;
   assert.equal(record.id,prospect.id);assert.equal(record.recordRevision,3);assert.equal(record.firstName,'QA Prospect');
   for(const forbidden of ['source','profileAnswers','ssn','resumeToken','documents'])assert.equal(forbidden in record,false);
   assert.ok(!JSON.stringify(result).includes('123-45-6789'));assert.ok(!JSON.stringify(result).includes('secret-token'));
  }
  assert.equal((await client.callTool({name:'get_prospect',arguments:{id:'missing'}})).isError,true);
  assert.equal((await client.callTool({name:'fetch',arguments:{id:'tenant/prospect:rm:396'}})).isError,true);
  const tools=await client.listTools();const tool=tools.tools.find(t=>t.name==='get_prospect')!;assert.equal(tool.annotations?.readOnlyHint,true);assert.equal(tools.tools.length,26);
 }finally{await client.close();await server.close();}
});

test('configuration tools enforce revisions, strict patches and write scopes',async()=>{
 const ctx=await connect([READ_SCOPE,WRITE_SCOPE]);try{
  const snapshot=await ctx.service.snapshot();
  for(const [name,row,patch] of [['property',snapshot.properties[0],{name:'Synthetic MCP property'}],['unit',snapshot.units[0],{marketRentCents:123456}],['tenancy',snapshot.tenancies[0],{noticeOn:'2026-09-08'}]] as const){
   const args={id:row.id,revision:row.recordRevision??1,patch};
   const result=await ctx.client.callTool({name:`update_${name}`,arguments:args});assert.notEqual(result.isError,true,JSON.stringify(result));
   const read=await ctx.client.callTool({name:`get_${name}`,arguments:{id:row.id}});const value=(read.structuredContent as any).data;
   for(const [key,expected] of Object.entries(patch))assert.deepEqual(value[key],expected);
   assert.equal((await ctx.client.callTool({name:`update_${name}`,arguments:args})).isError,true);
   assert.equal((await ctx.client.callTool({name:`update_${name}`,arguments:{...args,revision:value.recordRevision,patch:{source:{system:'forged'}}}})).isError,true);
  }
 }finally{await ctx.close();}
 const readonly=await connect([READ_SCOPE]);try{
  const tools=await readonly.client.listTools();for(const tool of tools.tools.filter(t=>t.annotations?.readOnlyHint===false))assert.equal(tool.annotations?.idempotentHint,false);
  const row=(await readonly.service.snapshot()).units[0];assert.equal((await readonly.client.callTool({name:'update_unit',arguments:{id:row.id,revision:1,patch:{readiness:'off_market'}}})).isError,true);
 }finally{await readonly.close();}
});

test('recurring tools expose curated records and reject missing IDs or invalid successor amounts',async()=>{
 const ctx=await connect([READ_SCOPE,WRITE_SCOPE]);try{
  const snapshot=await ctx.service.snapshot();const propertyId=snapshot.properties[0].id;
  for(const [name,args] of [['list_charge_definitions',{}],['list_recurring_schedules',{propertyId}]] as const){const result=await ctx.client.callTool({name,arguments:args});assert.notEqual(result.isError,true);const data=(result.structuredContent as any).data;assert.ok(Array.isArray(data));for(const row of data)assert.equal('source' in row,false);}
  assert.equal((await ctx.client.callTool({name:'get_recurring_schedule',arguments:{id:'missing'}})).isError,true);
  assert.equal((await ctx.client.callTool({name:'replace_recurring_schedule',arguments:{predecessorId:'missing',successorId:'qa:new',revision:1,effectiveFrom:'2026-10-01',amountCents:-1}})).isError,true);
  assert.equal((await ctx.client.callTool({name:'end_recurring_schedule',arguments:{predecessorId:'missing',successorId:'qa:new',revision:1,effectiveFrom:'2026-10-01'}})).isError,true);
 }finally{await ctx.close();}
});

test('recurring creation and replacement preserve history and prevent duplicate or stale overwrites',async()=>{
 const ctx=await connect([READ_SCOPE,WRITE_SCOPE]);try{
  const snapshot=await ctx.service.snapshot();const t=snapshot.tenancies[0];
  const args={id:'qa:mcp-schedule',billingFrequency:'monthly',scopeType:'tenant',scopeId:t.primaryPersonId,personId:t.primaryPersonId,tenancyId:t.id,propertyId:t.propertyId,unitId:t.unitId,chargeDefinitionId:'demo-charge-definition-utility-fee',category:'recurring_fee',description:'Synthetic schedule',amountCents:9900,effectiveFrom:'2027-01-01',active:true};
  const created=await ctx.client.callTool({name:'create_recurring_schedule',arguments:args});assert.notEqual(created.isError,true,JSON.stringify(created));
  assert.equal((await ctx.client.callTool({name:'create_recurring_schedule',arguments:args})).isError,true);
  const replace={predecessorId:args.id,successorId:'qa:mcp-successor',revision:1,effectiveFrom:'2027-02-01',amountCents:10900};
  const replaced=await ctx.client.callTool({name:'replace_recurring_schedule',arguments:replace});assert.notEqual(replaced.isError,true,JSON.stringify(replaced));
  assert.equal((await ctx.client.callTool({name:'replace_recurring_schedule',arguments:{...replace,successorId:'qa:mcp-conflict',amountCents:11900}})).isError,true);
  const after=await ctx.service.snapshot();assert.equal(after.recurringSchedules.find(x=>x.id===args.id)?.amountCents,9900);assert.equal(after.recurringSchedules.find(x=>x.id===replace.successorId)?.amountCents,10900);
  const successor=after.recurringSchedules.find(x=>x.id===replace.successorId)!;
  assert.notEqual((await ctx.client.callTool({name:'end_recurring_schedule',arguments:{predecessorId:successor.id,successorId:'qa:mcp-end',revision:successor.recordRevision??1,effectiveFrom:'2027-03-01'}})).isError,true);
 }finally{await ctx.close();}
});

test('manual payments replay without duplicate cash and charge definitions enforce revisions',async()=>{
 const ctx=await connect([READ_SCOPE,WRITE_SCOPE]);try{
  const definition={id:'qa:mcp-definition',displayName:'QA fee',category:'recurring_fee',active:true};
  const created=await ctx.client.callTool({name:'create_charge_definition',arguments:definition});assert.notEqual(created.isError,true,JSON.stringify(created));
  assert.notEqual((await ctx.client.callTool({name:'update_charge_definition',arguments:{id:definition.id,revision:1,patch:{displayName:'QA renamed'}}})).isError,true);
  assert.equal((await ctx.client.callTool({name:'update_charge_definition',arguments:{id:definition.id,revision:1,patch:{active:false}}})).isError,true);
  const tenancy=(await ctx.service.snapshot()).tenancies[0];
  const payment={id:'qa:mcp-payment',tenancyId:tenancy.id,amountCents:500,postedOn:'2026-09-08',paymentMethod:'cash',description:'Synthetic receipt',category:'unapplied_cash',allocations:[]};
  const first=await ctx.client.callTool({name:'record_manual_payment',arguments:payment});assert.notEqual(first.isError,true,JSON.stringify(first));
  const second=await ctx.client.callTool({name:'record_manual_payment',arguments:payment});assert.equal((second.structuredContent as any).data.replayed,true);
  assert.equal((await ctx.client.callTool({name:'record_manual_payment',arguments:{...payment,amountCents:600}})).isError,true);
  assert.equal((await ctx.service.snapshot()).ledgerTransactions.filter(x=>x.id===payment.id).length,1);
  assert.equal('source' in (first.structuredContent as any).data.payment,false);
 }finally{await ctx.close();}
});

test('optional account and billing adapters require write scopes and server-owned actor context',async()=>{
 const calls:Array<any>=[];
 const options={accountAdmin:{listForMcp:async()=>[{id:'qa:account',credentialRevision:4,passwordHash:'never-expose',tokenHash:'never-expose',activationPath:'/secret'}],grantForMcp:async(...args:any[])=>{calls.push(args);return {account:{id:'qa:account',credentialRevision:4}};},reissueForMcp:async(...args:any[])=>{calls.push(args);if(args[1]!==4)throw new Error('revision conflict');return {account:{id:'qa:account',credentialRevision:5}};},revokeForMcp:async(...args:any[])=>{calls.push(args);return {account:{id:'qa:account',credentialRevision:5}};},sendLinkForMcp:async(...args:any[])=>{calls.push(args);return {delivery:'accepted',replayed:false};}},billing:{preview:async()=>({previewToken:'a'.repeat(64),readyCents:500}),post:async(...args:any[])=>{calls.push(args);return {postedCount:1};}}} as unknown as McpOperationalOptions;
 const writes=[['grant_tenant_access',{requestId:'qa_request',email:'qa@example.test',personId:'qa:person',tenancyId:'qa:tenancy'}],['reissue_tenant_access',{id:'qa:account',credentialRevision:4}],['revoke_tenant_access',{id:'qa:account',credentialRevision:4}],['send_tenant_access_link',{id:'qa:account',requestId:'qa_request'}],['post_recurring_billing',{month:'2026-09',scope:{propertyId:'qa:property'},previewToken:'a'.repeat(64)}]] as const;
 const readonly=await connect([READ_SCOPE],options);try{for(const [name,args]of writes)assert.equal((await readonly.client.callTool({name,arguments:args})).isError,true);assert.equal(calls.length,0);}finally{await readonly.close();}
 const ctx=await connect([READ_SCOPE,WRITE_SCOPE],options);try{
  const accounts=await ctx.client.callTool({name:'list_tenant_accounts',arguments:{}});assert.equal(JSON.stringify(accounts).includes('never-expose'),false);assert.equal(JSON.stringify(accounts).includes('/secret'),false);
  const listed=await ctx.client.listTools();assert.equal(listed.tools.length,33);assert.equal(listed.tools.find(x=>x.name==='send_tenant_access_link')?.annotations?.openWorldHint,true);
  for(const [name,args]of writes)assert.notEqual((await ctx.client.callTool({name,arguments:args})).isError,true);
  for(const args of calls)assert.equal(args.at(-1).actorSubject??args[0].actorSubject,'oauth:admin');
  assert.equal((await ctx.client.callTool({name:'reissue_tenant_access',arguments:{id:'qa:account',credentialRevision:3}})).isError,true);
  assert.equal((await ctx.client.callTool({name:'post_recurring_billing',arguments:{month:'2026-09',scope:{},previewToken:'bad'}})).isError,true);
 }finally{await ctx.close();}
});
