import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRentOpsMcpServer } from './tools';
import { verifyOAuthToken, READ_SCOPE, WRITE_SCOPE, type OAuthConfig } from './oauth';
import { RentOpsService } from '../services/service';
import { createSyntheticRentOpsRepository } from '../fixtures/synthetic';
const config: OAuthConfig = {issuer:'https://auth.example.test',resource:'https://app.example.test/mcp',introspectionEndpoint:'https://auth.example.test/introspect',introspectionClientId:'test',introspectionClientSecret:'test',adminSubjects:['admin']};
const valid = {active:true,iss:config.issuer,aud:config.resource,exp:Date.now()/1000+60,sub:'admin',scope:READ_SCOPE};
test('OAuth rejects wrong audience, issuer, subject, expiry, scope and revoked tokens',async () => {
  for (const patch of [{active:false},{aud:'other'},{iss:'other'},{sub:'tenant'},{exp:1},{scope:WRITE_SCOPE}]) await assert.rejects(verifyOAuthToken('token',config,async () => new Response(JSON.stringify({...valid,...patch}))));
  assert.equal((await verifyOAuthToken('token',config,async () => new Response(JSON.stringify(valid)))).subject,'admin');
});
async function connect(scopes: string[]) {
  const repository = createSyntheticRentOpsRepository(); const service = new RentOpsService(repository);
  const server = createRentOpsMcpServer(service,{subject:'admin',scopes},config.resource);
  const client = new Client({name:'test',version:'1'}); const [a,b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  return {repository,service,client,close:async () => {await client.close();await server.close();}};
}
test('MCP advertises annotated tools and prevents read-scope writes',async () => {
  const ctx=await connect([READ_SCOPE]); try {
    const tools=await ctx.client.listTools(); assert.equal(tools.tools.length,14);
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
  const tools=await client.listTools();const tool=tools.tools.find(t=>t.name==='get_prospect')!;assert.equal(tool.annotations?.readOnlyHint,true);assert.equal(tools.tools.length,14);
 }finally{await client.close();await server.close();}
});
