/** Private operator input only. No delivery adapter, activation token, or production ID derivation. */
import {provisionTargetFingerprint,verifiedImportReceiptHash} from './export-provisioning-crosswalk';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,lstat,realpath,mkdtemp,rm,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,basename,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import type {RentOpsSnapshot,RentOpsDocument} from '../shared/rent-ops-contracts';
import {isTenantLeaseFile} from '../server/rent-ops/tenant-portal/lease-files';
import {eligibleTenantTenancies} from '../server/rent-ops/tenant-portal/presentation';
import type {TenantAccountRecord} from '../server/rent-ops/tenant-portal/store';
export interface LeaseCandidate {packageRelativePath:string;sourceTenantId:number;sourceLeaseId:number;propertyId:number;unitId:number;packageSizeBytes:number;packageSha256:string;sourceSha256:string;sourceSizeBytes:number;portalImportCandidate:boolean;reviewState:string}
export interface RosterRow {tenantId:number;primaryContactId:number|null;primaryEmail:string|null;status:string;leases:{leaseId:number;unitId:number;propertyId:number}[];dateActiveLeaseIds:number[];provisioningBlockers:string[]}
export interface PrivateManifest {eligibleFiles:LeaseCandidate[];heldAccounts:{sourceTenantId:number}[]}
const sourceMatches=(value:string|undefined,id:number,prefix:string)=>value===String(id)||value===`${prefix}:${id}`;
function unique<T>(items:T[],label:string):T {if(items.length!==1)throw new Error(`Exact ${label} binding unavailable`);return items[0];}
export function resolveProvisioning(snapshot:RentOpsSnapshot,row:RosterRow) {
 const person=unique(snapshot.people.filter(p=>p.source?.system==='rent_manager'&&sourceMatches(p.source.sourceId,row.tenantId,'tenant')),'source account');
 const contact=snapshot.sourceRecords.filter(s=>s.system==='rent_manager'&&s.entityType==='person'&&s.sourceId===`contact:${row.primaryContactId}`&&s.targetId===person.id);

 const email=row.primaryEmail?.trim().toLowerCase();
 if(email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!row.primaryContactId||contact.length!==1))throw new Error('Exact primary email/contact unavailable');
 if(email && person.email?.trim().toLowerCase()!==email)throw new Error('Primary email differs from imported source');
 const eligible=eligibleTenantTenancies(snapshot);
 const leaseIds=row.status==='future'?row.leases.map(l=>l.leaseId):row.dateActiveLeaseIds;
 let matches=snapshot.tenancies.filter(t=>t.primaryPersonId===person.id&&t.source?.system==='rent_manager'&&leaseIds.some(id=>sourceMatches(t.source?.sourceId,id,'lease'))&&eligible.some(e=>e.tenancyId===t.id));
 let sourceScope: {propertyId:number;unitId:number}|undefined;
 if(!leaseIds.length&&row.status==='future'){
   matches=snapshot.tenancies.filter(t=>t.primaryPersonId===person.id&&t.source?.system==='rent_manager'&&t.source.sourceId===`tenant:${row.tenantId}`&&t.status==='future'&&eligible.some(e=>e.tenancyId===t.id));
   const raw=snapshot.sourceRecords.find(r=>r.system==='rent_manager'&&r.entityType==='person'&&sourceMatches(r.sourceId,row.tenantId,'tenant'))?.rawMetadata;
   const propertyId=Number(raw?.PropertyID??raw?.propertyId),unitId=Number(raw?.UnitID??raw?.unitId);
   if(matches.length!==1||!Number.isSafeInteger(propertyId)||propertyId<=0||!Number.isSafeInteger(unitId)||unitId<=0)return {person,tenancy:null,email:email??null,hold:'unresolved_future_tenancy' as const};
   sourceScope={propertyId,unitId};
 }
 const tenancy=unique(matches,'eligible tenancy');
 const sourceLease=sourceScope??unique(row.leases.filter(l=>sourceMatches(tenancy.source?.sourceId,l.leaseId,'lease')),'source lease');
 if(!snapshot.properties.some(p=>p.id===tenancy.propertyId&&p.source?.system==='rent_manager'&&sourceMatches(p.source.sourceId,sourceLease.propertyId,'property'))||!snapshot.units.some(u=>u.id===tenancy.unitId&&u.source?.system==='rent_manager'&&sourceMatches(u.source.sourceId,sourceLease.unitId,'unit')))throw new Error('Lease property/unit source mismatch');
 return {person,tenancy,email:email??null};
}
export async function verifiedLeaseBytes(root:string,file:LeaseCandidate):Promise<Buffer>{
 if(!file.portalImportCandidate||file.reviewState!=='reviewed_signed_lease_import_candidate'||file.packageSha256!==file.sourceSha256||file.packageSizeBytes!==file.sourceSizeBytes)throw new Error('Lease review or byte manifest inconsistent');
 if(!/^files\/[A-Za-z0-9_.-]+\.pdf$/.test(file.packageRelativePath))throw new Error('Lease package path invalid');
 const path=resolve(root,file.packageRelativePath),base=await realpath(root);if((await lstat(path)).isSymbolicLink()||!(await realpath(path)).startsWith(base+sep))throw new Error('Lease path escapes private package');
 if(!Number.isSafeInteger(file.packageSizeBytes)||file.packageSizeBytes<1||file.packageSizeBytes>50*1024*1024)throw new Error('Lease manifest size is invalid');
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await handle.stat();if(!stat.isFile()||stat.size!==file.packageSizeBytes)throw new Error('Lease file size is invalid');const bytes=await handle.readFile();if(bytes.length!==file.packageSizeBytes||createHash('sha256').update(bytes).digest('hex')!==file.packageSha256||!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw new Error('Lease bytes fail manifest verification');return bytes;}finally{await handle.close();}
}
export interface ProvisioningDependencies {
 snapshot():Promise<RentOpsSnapshot>;accounts():Promise<TenantAccountRecord[]>;
 createPending(input:{id:string;email:string;personId:string;tenancyId:string}):Promise<void>;
 upload(tenancyId:string,input:{fileName:string;mimeType:string;bytes:Buffer;sizeBytes:number},actor:string):Promise<RentOpsDocument>;
 verifyDocument(id:string,sha:string,size:number):Promise<void>;
}
export async function provisionImportedTenants(input:{manifest:PrivateManifest;roster:RosterRow[];packageRoot:string;actor:string;apply:boolean},deps:ProvisioningDependencies){
 const snapshot=await deps.snapshot(),accounts=await deps.accounts();const held=new Set(input.manifest.heldAccounts.map(r=>r.sourceTenantId));
 const planned=[];const files=[];const plannedEmails=new Set<string>();const plannedTenancies=new Set<string>();
 // Preflight every source binding and every byte before any writes.
 for(const row of input.roster){const binding=resolveProvisioning(snapshot,row);if(!binding.email||!binding.tenancy){planned.push({row,binding,existing:undefined});continue;}
 if(plannedEmails.has(binding.email)||plannedTenancies.has(binding.tenancy.id))throw new Error('Roster repeats an email or tenancy; review required');plannedEmails.add(binding.email);plannedTenancies.add(binding.tenancy.id);
 const existing=accounts.filter(a=>a.tenancyId===binding.tenancy.id||a.email===binding.email);
 if(existing.some(a=>a.tenancyId!==binding.tenancy.id||a.personId!==binding.person.id||a.email!==binding.email)||existing.length>1)throw new Error('Existing account conflicts with exact source binding');
 planned.push({row,binding,existing:existing[0]});
 }
 for(const file of input.manifest.eligibleFiles){if(held.has(file.sourceTenantId))throw new Error('Held account appears in eligible lease files');const plan=unique(planned.filter(p=>p.row.tenantId===file.sourceTenantId),'lease account');

 const {tenancy}=plan.binding;if(!tenancy)throw new Error('Reviewed lease has no exact tenancy');if(!sourceMatches(tenancy.source?.sourceId,file.sourceLeaseId,'lease'))throw new Error('Lease file source tenancy mismatch');
 const sourceLease=plan.row.leases.find(l=>l.leaseId===file.sourceLeaseId);if(sourceLease?.propertyId!==file.propertyId||sourceLease?.unitId!==file.unitId)throw new Error('Lease file property/unit mismatch');
 const bytes=await verifiedLeaseBytes(input.packageRoot,file);
 const existing=snapshot.documents.filter(d=>d.tenancyId===tenancy.id&&d.personId===tenancy.primaryPersonId&&d.propertyId===tenancy.propertyId&&d.unitId===tenancy.unitId&&isTenantLeaseFile(d,{id:'operator-preflight',email:plan.binding.email??'',personId:tenancy.primaryPersonId,tenancyId:tenancy.id,status:'active'},tenancy)&&d.checksumSha256===file.packageSha256&&d.sizeBytes===bytes.length);
 if(existing.length>1)throw new Error('Duplicate lease binding requires review');if(existing[0])await deps.verifyDocument(existing[0].id,file.packageSha256,bytes.length);files.push({file,tenancy,bytes,existing:existing[0]});
 }
 if(input.apply){if(!input.actor.trim())throw new Error('Verified manager actor required');for(const p of planned){if(!p.binding.email||!p.binding.tenancy||p.existing)continue;await deps.createPending({id:`tenant-account-${randomUUID()}`,email:p.binding.email,personId:p.binding.person.id,tenancyId:p.binding.tenancy.id});}
 for(const f of files){const doc=f.existing??await deps.upload(f.tenancy.id,{fileName:basename(f.file.packageRelativePath),mimeType:'application/pdf',bytes:f.bytes,sizeBytes:f.bytes.length},input.actor);if(!f.existing)await deps.verifyDocument(doc.id,f.file.packageSha256,f.bytes.length);}}
 return {mode:input.apply?'applied':'prepared',accountsToCreate:planned.filter(p=>!!p.binding.email&&!!p.binding.tenancy&&!p.existing).length,accountsPreserved:planned.filter(p=>p.existing).length,missingEmailHolds:planned.filter(p=>!p.binding.email).length,unresolvedTenancyHolds:planned.filter(p=>!p.binding.tenancy).length,leaseReviewHolds:held.size,leaseFiles:files.length,leaseFilesAlreadyBound:files.filter(f=>f.existing).length,emailsSent:0,activationTokensCreated:0};
}

export async function extractPrivateLeasePackage(archive:string){
 const root=await mkdtemp(resolve(tmpdir(),'rent-ops-lease-provision-'));
 try{const run=promisify(execFile);const {stdout}=await run('tar',['-tzf',archive]);if(stdout.trim().split('\n').some(p=>!/^files\/[A-Za-z0-9_.-]+\.pdf$/.test(p)&&!['manifest.json','checksums.sha256'].includes(p)))throw new Error('Unexpected private archive member');const verbose=await run('tar',['-tvzf',archive]);if(verbose.stdout.trim().split('\n').some(line=>!line.startsWith('-')))throw new Error('Private archive must contain regular files only');await run('tar',['-xzf',archive,'--no-same-owner','--no-same-permissions','-C',root]);return root;}catch(error){await rm(root,{recursive:true,force:true});throw error;}
}
export async function loadProvisioningSnapshot(repo:{getSnapshot():Promise<RentOpsSnapshot>},crosswalkPath:string,binding:{targetFingerprint:string;importReceiptSha256:string}){
 const snapshot=await repo.getSnapshot();
 const artifact=JSON.parse(await readFile(crosswalkPath,'utf8')) as {kind:string;rows:RentOpsSnapshot['sourceRecords'];targetFingerprint:string;importReceiptSha256:string};
 if(artifact.kind!=='private_production_source_identity_crosswalk_v1'||!Array.isArray(artifact.rows)||artifact.targetFingerprint!==binding.targetFingerprint||artifact.importReceiptSha256!==binding.importReceiptSha256)throw new Error('Private source crosswalk artifact required');
 // Exported separately with a read-only source role. Runtime role never reads restricted tables.
 snapshot.sourceRecords=artifact.rows;
 return snapshot;
}
export async function runOperator(){
 const args=process.argv.slice(2),apply=args.includes('--apply');
 const crosswalkPath=process.env.RENT_OPS_PROVISION_CROSSWALK;
 const manifestPath=process.env.RENT_OPS_LEASE_MANIFEST,rosterPath=process.env.RENT_OPS_PROVISION_ROSTER,packageRoot=process.env.RENT_OPS_LEASE_PACKAGE_ROOT;
 if(!manifestPath||!rosterPath||!packageRoot)throw new Error('Private manifest, roster and extracted package paths required');
 const manifest=JSON.parse(await readFile(manifestPath,'utf8')) as PrivateManifest;
 const roster=(JSON.parse(await readFile(rosterPath,'utf8')) as {rows:RosterRow[]}).rows;
 if(args.includes('--verify-files')){for(const file of manifest.eligibleFiles)await verifiedLeaseBytes(packageRoot,file);console.log(JSON.stringify({state:'files_verified_offline',files:manifest.eligibleFiles.length,heldAccounts:manifest.heldAccounts.length,writes:0,emailsSent:0}));return;}
 if(!crosswalkPath)throw new Error('Production-source crosswalk export required; runtime cannot read restricted source tables');
 if(process.env.RENT_OPS_SOURCE_IDENTITY_DATABASE_URL||process.env.RENT_OPS_SOURCE_AUDIT_DATABASE_URL||process.env.RENT_OPS_DATABASE_URL)throw new Error('Source-role credentials must not enter the web-role provisioner process');
 if(apply && process.env.RENT_OPS_PROVISION_APPROVAL!=='two-imports-audited-schema25-approved')throw new Error('Explicit post-import provisioning approval required');
 const {createRentOpsRuntimeDatabase}=await import('../server/rent-ops/runtime-database');
 const {PostgresRentOpsRepository}=await import('../server/rent-ops/repositories/postgres');
 const {PostgresTenantAccountStore}=await import('../server/rent-ops/tenant-portal/store');
 const receiptPath=process.env.RENT_OPS_PROVISION_IMPORT_RECEIPT;if(!receiptPath)throw new Error('Audited import receipt path required');
 const crosswalkBinding={targetFingerprint:provisionTargetFingerprint(process.env.RENT_OPS_RUNTIME_DATABASE_URL??''),importReceiptSha256:await verifiedImportReceiptHash(receiptPath)};
 const db=await createRentOpsRuntimeDatabase();
 try{
  const schema=await db.query<{version:number}>('SELECT MAX(version)::int AS version FROM rent_ops_schema_migrations');if(schema.rows[0]?.version!==25)throw new Error('Reviewed schema25 required; no migration is applied by this operator');
  const repo=new PostgresRentOpsRepository(db),store=new PostgresTenantAccountStore(db);
  let service:import('../server/rent-ops/services/service').RentOpsService|undefined;
  const ensureService=async()=>{if(service)return service;const {createConfiguredRentOpsWebObjectStores}=await import('../server/rent-ops/storage/production-store');const stores=await createConfiguredRentOpsWebObjectStores();const {RentOpsService}=await import('../server/rent-ops/services/service');service=new RentOpsService(repo,()=>new Date(),undefined,undefined,false,{...stores,allowEphemeralDocumentBindings:false});return service;};
  const result=await provisionImportedTenants({manifest,roster,packageRoot,actor:process.env.RENT_OPS_PROVISION_MANAGER_SUBJECT??'',apply},{snapshot:()=>loadProvisioningSnapshot(repo,crosswalkPath,crosswalkBinding),accounts:()=>store.list(),
   createPending:async value=>{await db.query(`INSERT INTO rent_ops_tenant_accounts(id,email,person_id,tenancy_id,status,activation_token_hash,invitation_expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,'pending',NULL,NULL,NOW(),NOW()) ON CONFLICT DO NOTHING`,[value.id,value.email,value.personId,value.tenancyId]);const actual=await store.getByEmail(value.email);if(!actual||actual.personId!==value.personId||actual.tenancyId!==value.tenancyId)throw new Error('Account write verification failed');if(actual.id===value.id&&(actual.status!=='pending'||actual.passwordHash!==null||actual.activationTokenHash!==null||actual.invitationExpiresAt!==null))throw new Error('Inactive no-token account verification failed');},
   upload:async(id,input,actor)=>(await ensureService()).saveManagerLeaseFile(id,input,actor),
   verifyDocument:async(id,sha,size)=>{const opened=await (await ensureService()).openVerifiedDocument(id);const hash=createHash('sha256');let total=0;for await(const bytes of opened.stream){hash.update(bytes);total+=bytes.length;}if(total!==size||hash.digest('hex')!==sha)throw new Error('Durable lease readback mismatch');}
  });console.log(JSON.stringify(result));
 }finally{await db.close();}
}
async function launchOperator(){const archive=process.env.RENT_OPS_LEASE_ARCHIVE;if(!archive)return runOperator();const root=await extractPrivateLeasePackage(archive);try{process.env.RENT_OPS_LEASE_PACKAGE_ROOT=root;await runOperator();}finally{await rm(root,{recursive:true,force:true});}}
if(process.argv[1]&&resolve(process.argv[1])===resolve('scripts/provision-imported-tenants.ts'))launchOperator().catch(()=>{console.error('Provisioning stopped. No credential or tenant data emitted; inspect private state before retrying.');process.exitCode=1;});
