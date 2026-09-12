/** TEST ONLY. In-memory PostgreSQL, synthetic data, local mail sink, fake processor. */
import type {} from "../server/auth";
import express, { type RequestHandler } from "express";
import session from "express-session";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { ensureRentOpsSchema, rentOpsMigrationDefinitions } from "../server/rent-ops/persistence";
import { createRentOpsSecurityManifest, renderRentOpsSecuritySql } from "../server/rent-ops/security/deployment-security";
import { createPostgresRentOpsRepository, type RentOpsQueryExecutor } from "../server/rent-ops/repositories/postgres";
import { registerRentOpsRoutes } from "../server/rent-ops/routes";
import { registerRentOpsBillingRoutes } from "../server/rent-ops/billing/routes";
import { registerTenantPortalRoutes } from "../server/rent-ops/tenant-portal/routes";
import { hashTenantPassword } from "../server/rent-ops/tenant-portal/passwords";
import type { PaymentProvider } from "../server/rent-ops/payments/provider";
import { TenantPaymentService } from "../server/rent-ops/payments/service";
import { PostgresTenantPaymentStore } from "../server/rent-ops/payments/store";
import { registerTenantPaymentRoutes, registerTenantPaymentWebhook } from "../server/rent-ops/payments/routes";
import { createInMemoryObjectStore } from "../server/rent-ops/storage";
import { applicantPageSecurityHeaders, privatePortalHtml } from "../server/applicant-page-security";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function syntheticLeasePdf(): Buffer {
  const content='BT /F1 18 Tf 50 740 Td (TEST ONLY - Synthetic lease fixture) Tj 0 -30 Td /F1 12 Tf (No real tenancy or legal agreement.) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let pdf='%PDF-1.4\n'; const offsets=[0];
  objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${object}\nendobj\n`;});
  const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

export async function createTenantQa(options: { provider?: PaymentProvider } = {}) {
  if (options.provider?.live) throw new Error("Local QA refuses live payment providers");
  if (process.env.NODE_ENV === "production") throw new Error("Local QA cannot run in production");
  const db = new PGlite();
  await ensureRentOpsSchema({ apply: true, executor: async sql => { await db.exec(sql); } });
  // Apply the production privilege contract to this disposable in-memory DB.
  // These attestations describe synthetic fixtures only, never a deployment.
  const security = createRentOpsSecurityManifest("staging", {
    gates: { backupVerified: true, backupAttestation: "synthetic-disposable-qa", independentAuditVerified: true, independentAuditAttestation: "synthetic-qa-role-check", schemaChecksumSha256: rentOpsMigrationDefinitions().at(-1)!.checksum },
    roleAttestation: { runtimeRoleIsNotRestrictedTableOwner: true, runtimeRoleNoInherit: true, importerRoleIsDistinct: true, auditorRoleIsDistinct: true, auditorRoleNoInherit: true },
  });
  for (const role of [security.target.runtimeRole, security.target.importerRole, security.target.auditorRole]) await db.exec(`CREATE ROLE "${role}" NOINHERIT`);
  await db.exec(renderRentOpsSecuritySql(security, { mode: "apply" }).sql);
  await db.exec(`SET ROLE "${security.target.runtimeRole}"`);
  console.log('QA schema ready');
  const executor: RentOpsQueryExecutor = {
    query: async (text, values) => db.query(text, values),
    transaction: async work => db.transaction(async tx => work({ query: async (text, values) => tx.query(text, values) })).catch(error => { console.error('QA transaction:', error.message); throw error; }),
  };
  const repository = createPostgresRentOpsRepository(executor);
  const clock = { date: new Date() };
  const now = () => new Date(clock.date);
  const today = now().toISOString().slice(0,10);
  console.log('QA seeding');
  await repository.saveProperty({ id:'qa-property', name:'TEST ONLY — Example Homes', slug:'qa-example', address:{line1:'1 Synthetic Street',city:'Example',state:'FL',postalCode:'00000'}, propertyType:'multifamily',state:'active' });
  for(const n of [1,2,3]) await repository.saveUnit({id:`qa-unit-${n}`,propertyId:'qa-property',unitNumber:`TEST ${n}`,propertyLinkKnowledge:'manual',unitNumberKnowledge:'manual',readinessKnowledge:'manual',listingKnowledge:'manual',readiness:'ready',listing:'listed',marketRentCents:125000,defaultDepositCents:125000});
  await repository.saveChargeDefinition({id:'qa-base-rent',displayName:'TEST base rent',displayNameKnowledge:'manual',category:'base_rent',active:true,activeKnowledge:'manual',categoryKnowledge:'manual'});
  await repository.savePerson({id:'qa-other-person',firstName:'Other',lastName:'Synthetic',email:'other@example.test'});
  await repository.saveTenancy({id:'qa-other-tenancy',propertyId:'qa-property',unitId:'qa-unit-2',primaryPersonId:'qa-other-person',status:'current',propertyLinkKnowledge:'manual',unitLinkKnowledge:'manual',primaryPersonLinkKnowledge:'manual',statusKnowledge:'manual',actualMoveInKnowledge:'manual',actualMoveInOn:today,createdAt:now().toISOString()});
  await repository.saveHouseholdMembership({id:'qa-other-household',tenancyId:'qa-other-tenancy',personId:'qa-other-person',role:'primary',isFinanciallyResponsible:true,roleKnowledge:'manual',responsibilityKnowledge:'manual'});
  await db.query("INSERT INTO rent_ops_tenant_accounts (id,email,person_id,tenancy_id,status,password_hash,activated_at) VALUES ('qa-other','other@example.test','qa-other-person','qa-other-tenancy','active',$1,now())",[await hashTenantPassword('LocalQA-Only-2026')]);
  console.log('QA fixtures ready');
  const storage = createInMemoryObjectStore();
  const inbox: Array<Record<string, unknown>> = [];
  const control = { failMail:false, clock };
  const app = express();
  let testPaymentService: TenantPaymentService | undefined;
  registerTenantPaymentWebhook(app,{getService:()=>testPaymentService});
  app.use(express.json());
  app.use(session({secret:'synthetic-local-qa-session-only',resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:'lax'}}));
  app.use((_req,res,next)=>{res.set('Cache-Control','no-store'); next();});
  const requireAdmin: RequestHandler = (req,res,next) => {
    if(req.session.rentOpsAdminUserId!=='qa-manager') {res.sendStatus(401);return;}
    if(!['GET','HEAD','OPTIONS'].includes(req.method) && req.get('x-rent-ops-csrf')!==req.session.rentOpsCsrfToken) {res.sendStatus(403);return;}
    req.rentOpsAdminUser={id:'qa-manager',email:'manager@example.test',role:'admin',firstName:'Test',lastName:'Manager'} as any;next();
  };
  app.post('/api/rent-ops/auth/login',async(req,res)=>{
    if(req.body?.email!=='manager@example.test'||req.body?.password!=='LocalQA-Only-2026') {res.sendStatus(401);return;}
    await new Promise<void>((ok,no)=>req.session.regenerate(e=>e?no(e):ok()));
    req.session.rentOpsAdminUserId='qa-manager';req.session.rentOpsCsrfToken=randomUUID();
    res.json({user:{id:'qa-manager',email:'manager@example.test',role:'admin',firstName:'Test',lastName:'Manager'},csrfToken:req.session.rentOpsCsrfToken});
  });
  app.get('/api/rent-ops/auth/csrf',requireAdmin,(req,res)=>res.json({csrfToken:req.session.rentOpsCsrfToken}));
  app.get('/api/rent-ops/auth/session',requireAdmin,(req,res)=>res.json({user:req.rentOpsAdminUser,csrfToken:req.session.rentOpsCsrfToken}));
  app.post('/api/rent-ops/auth/logout',requireAdmin,(req,res)=>req.session.destroy(()=>res.json({message:'Signed out'})));
  const escape=(value:unknown)=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  app.get('/qa/inbox',(_req,res)=>res.type('html').send('<h1>TEST ONLY — Local email inbox</h1><p>No email was sent outside this process.</p>'+inbox.map(mail=>`<p>${escape(mail.email)} · ${escape(mail.purpose??'application resume')} · <a href="${mail.kind==='tenant'?'/tenant#activate=':'/apply#resume='}${encodeURIComponent(String(mail.token))}">Open test link</a></p>`).join('')));
  const portal = registerTenantPortalRoutes(app,{repository,database:executor,documentStorage:storage,requireAdmin,now,accessNotifier:async mail=>{if(control.failMail)throw new Error('Synthetic delivery failure');inbox.push({kind:'tenant',...mail});}});
  const provider: PaymentProvider = options.provider ?? {live:false,async createCheckout(payment:any){return{id:`cs_test_${payment.id}`,url:`https://checkout.stripe.com/c/pay/TEST_ONLY_${payment.id}`,paymentIntentId:`pi_test_${payment.id}`};},verify(body:Buffer,signature:string){if(signature!=='qa-local-signature')throw new Error('Invalid synthetic signature');return JSON.parse(body.toString());}};
  const service = new TenantPaymentService(new PostgresTenantPaymentStore(executor,repository),provider,now);
  testPaymentService=service;
  registerTenantPaymentRoutes(app,{service,requireTenant:portal.requireTenant,getTenantIdentity:portal.getTenantIdentity});
  registerRentOpsBillingRoutes(app,{executor,requireAdmin});
  registerRentOpsRoutes(app,{repository,requireAdmin,now,previewSource:'synthetic',documentStorage:storage,resumeTokenNotifier:async mail=>{if(control.failMail)throw new Error('Synthetic delivery failure');inbox.push({kind:'applicant',...mail});}});
  app.use(/^\/(?:tenant|apply)(?:\/|$)/,applicantPageSecurityHeaders);
  app.get('/qa',(_req,res)=>res.type('html').send(`<h1>TEST ONLY — Synthetic tenant workflow</h1>
    <p>No real tenants, emails, bank accounts, or charges. Data resets when this server restarts.</p>
    <p>Simulated business date: ${escape(now().toISOString().slice(0,10))}</p>
    <p>Manager: manager@example.test · Other resident: other@example.test · Password: LocalQA-Only-2026</p>
    <p>After the full flow runner: resident@example.test · Password: LocalQA-Reset-2026</p>
    <p><a href="/ops">Manager</a> · <a href="/apply">Application</a> · <a href="/tenant">Tenant</a> · <a href="/qa/inbox">Local test email inbox</a></p>
    <p>${options.provider ? "Payments use the explicitly injected Stripe sandbox provider. Test payment methods only." : "Payments use a local fake processor. Do not open its synthetic Stripe URL. Real card/bank Checkout is not verified here."}</p>`));
  app.use(express.static(resolve('dist/public'),{index:false}));
  app.get(/.*/,(req,res)=>res.type('html').send(privatePortalHtml(readFileSync(resolve('dist/public/index.html'),'utf8'),req.originalUrl)));
  const server = createServer(app);
  return {app,server,db,executor,repository,storage,inbox,control,service,today};
}
if (process.argv[1] && resolve(process.argv[1])===resolve('scripts/tenant-local-qa.ts')) {
  const qa=await createTenantQa();qa.server.listen(4176,'127.0.0.1',()=>console.log('TEST ONLY: http://127.0.0.1:4176/qa'));
}
