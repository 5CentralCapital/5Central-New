/** Private operator entrypoint. Never loaded by the published web application. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {createRequire} from 'node:module';
import {Client} from '@replit/object-storage';
import {canonicalJson,sha256} from '../server/rent-ops/export/hash';
import {createKeyedTargetIdFactory} from '../server/rent-ops/import/rm-mapper';
import {runRestrictedMigrationArchive} from '../server/rent-ops/import/migration-runner';
import {inspectDatabaseTarget,runDatabaseAudit} from '../server/rent-ops/import/database-audit';
import {captureRentOpsTargetState,assertEmptyRentOpsTargetState,assertIdenticalRentOpsTargetState} from '../server/rent-ops/import/target-state';
import {APPLY_RENT_OPS_PRODUCTION_PHRASE,KNOWN_LIVE_PRIMARY_FINGERPRINT} from '../server/rent-ops/import/persistence-importer';
import {ProductionRestrictedVerifiedDocumentTransfer} from '../server/rent-ops/import/verified-document-transfer';
import {createReplitManagedGcsObjectStores,type ManagedBucket} from '../server/rent-ops/storage/replit-managed-gcs';
import {rentOpsMigrationChecksumForVersion,RENT_OPS_SCHEMA_VERSION} from '../server/rent-ops/persistence';
async function secret(label:string):Promise<string>{
 if(!process.stdin.isTTY) throw Error('private_tty_required');
 process.stdout.write(label+': ');process.stdin.setRawMode(true);process.stdin.resume();
 return new Promise((resolve,reject)=>{let value='';const receive=(chunk:Buffer)=>{for(const c of chunk.toString('utf8')){if(c==='\u0003'){finish();reject(Error('operator_cancelled'));return}if(c==='\r'||c==='\n'){finish();resolve(value);return}if(c==='\u007f')value=value.slice(0,-1);else if(c>=' ')value+=c;if(value.length>8192){finish();reject(Error('secret_input_too_long'));return}}};const finish=()=>{process.stdin.off('data',receive);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n')};process.stdin.on('data',receive)});
}
let privateEvidenceRoot: string | undefined;
let operatorStage = "configuration";
async function main(){
 assert.equal(process.env.NODE_ENV,'production');
 const configPath=resolve(process.argv[2]??'');const c=JSON.parse(await readFile(configPath,'utf8'));assert.equal(c.targetClassification,'production');
 const root=dirname(configPath);const archive=resolve(root,c.archiveRoot);const out=resolve(root,c.evidenceRoot);await mkdir(out,{recursive:true,mode:0o700});privateEvidenceRoot=out;
 const save=(name:string,value:unknown)=>writeFile(join(out,name),JSON.stringify(value,null,2),{mode:0o600});
 const receiptBytes=await readFile(resolve(root,c.receiptPath));assert.equal(sha256(receiptBytes),c.receiptSha256);const receipt=JSON.parse(receiptBytes.toString());
 const tupleKeys=['sourceRunId','parentEnvelopeSha256','parentManifestSha256','supplementSha256','attestationSha256','rowSetSha256','derivativeEnvelopeSha256','derivativeManifestSha256'];
 const verifier=(input:any)=>{assert.equal(canonicalJson(Object.fromEntries(tupleKeys.map(k=>[k,input[k]]))),canonicalJson(receipt.tuple));return {verified:true,receiptId:receipt.receiptId}};
 operatorStage='private_credentials';
 const importerUrl=await secret('Paste ephemeral IMPORTER database URL');const auditorUrl=await secret('Paste ephemeral RAW AUDITOR database URL');const key=Buffer.from(await secret('Paste retained production target key (base64)'),'base64');assert(key.length>=32);
 const identity=createKeyedTargetIdFactory(key,{keyId:c.keyId,keyVersion:c.keyVersion});key.fill(0);
 const {Pool}=createRequire(import.meta.url)('pg');const importer=new Pool({connectionString:importerUrl,max:2});const auditor=new Pool({connectionString:auditorUrl,max:1});
 function executor(client:any):any{return {query:(sql:string,params:any[]=[])=>client.query(sql,params),transaction:async(fn:any,options:any={})=>{const tx=await client.connect();try{await tx.query(options.readOnly?'BEGIN READ ONLY':'BEGIN');await tx.query('SET LOCAL search_path TO public');const result=await fn({query:(sql:string,params:any[]=[])=>tx.query(sql,params)});await tx.query('COMMIT');return result}catch(e){await tx.query('ROLLBACK');throw e}finally{tx.release()}}}}
 const ex=executor(importer),auditEx=executor(auditor);
 try{
 operatorStage='target_preflight';
 const fingerprint=await inspectDatabaseTarget(ex);assert.equal(fingerprint.redactedFingerprint,c.expectedDatabaseFingerprint);assert.equal(fingerprint.migrationVersion,RENT_OPS_SCHEMA_VERSION);assert.equal(fingerprint.migrationChainValid,true);
 const checksum=rentOpsMigrationChecksumForVersion(RENT_OPS_SCHEMA_VERSION);assert.equal(fingerprint.migrationChecksum,checksum);assert.equal(c.backupAttestation.targetFingerprint,fingerprint.redactedFingerprint);
 const empty=await captureRentOpsTargetState(ex);assertEmptyRentOpsTargetState(empty);await save('empty-target.json',empty);
 const bucket=await (new Client({bucketId:c.bucketId}) as unknown as {getBucket():Promise<ManagedBucket>}).getBucket();
 let stores=await createReplitManagedGcsObjectStores({bucket,prefix:c.prefix});await save('managed-storage-readiness.json',stores.managedHostingReport);
 const now=new Date();await save('operator-start.json',{startedAt:now.toISOString(),fingerprint,identity:identity.identity,receiptSha256:c.receiptSha256});
 const options:any={archiveRoot:archive,executor:ex,parityAuditExecutor:auditEx,supplementReceiptVerifier:verifier,now,managedStorageReadiness:{profile:'replit-managed-gcs',probe:async()=>{stores=await createReplitManagedGcsObjectStores({bucket,prefix:c.prefix});return stores.managedHostingReport}},restrictedVerifiedDocumentTransfer:new ProductionRestrictedVerifiedDocumentTransfer(stores.importerStorage),restrictedDocumentOrphanSink:(e:any)=>save('document-orphan.json',e),importerOptions:{targetClassification:'production',targetIdFactory:identity.factory,targetIdentity:identity.identity,expectedDatabaseFingerprint:c.expectedDatabaseFingerprint,forbiddenDatabaseFingerprints:[KNOWN_LIVE_PRIMARY_FINGERPRINT],expectedMigrationChecksum:checksum,renderedMigrationChecksum:checksum,backupAttestation:c.backupAttestation}};
 operatorStage='source_dry_run';
 const dry=await runRestrictedMigrationArchive({...options,mode:'dry_run'});assert.equal(dry.report.blockingReasons.length,0);assert.equal(dry.summary?.errorCount,0);await save('dry-run.json',dry);
 let state1:any;
 for(let i=1;i<=2;i++){
 operatorStage='import_'+i;
 process.stdout.write('Starting production import '+i+'\n');
 const result=await runRestrictedMigrationArchive({...options,mode:'apply',importerOptions:{...options.importerOptions,affirmativeGate:{phrase:APPLY_RENT_OPS_PRODUCTION_PHRASE,nonce:'production-'+now.toISOString()+'-pass-'+i}}});await save('import-'+i+'.json',result);assert.equal(result.summary?.committed,true);assert.equal(result.postcommitAudit?.passed,true);
 operatorStage='audit_'+i;
 const ctx=result.databaseAuditContext;assert(ctx);const audit=await runDatabaseAudit(ex,{asOfDate:ctx.asOfDate,expected:ctx.expected,requireExpectedControls:true});await save('database-audit-'+i+'.json',audit);assert.equal(audit.passed,true);
 const state=await captureRentOpsTargetState(ex);await save('state-'+i+'.json',state);if(i===1)state1=state;else assertIdenticalRentOpsTargetState(state1,state);
 process.stdout.write('Production import '+i+' committed; parity and independent audit passed\n');
 }
 await save('complete.json',{twoImportsIdentical:true,rawParityPassed:true,independentAuditsPassed:true,stateSha256:state1.tablesSha256,restoreVerificationPending:true,completedAt:new Date().toISOString()});
 }finally{await importer.end();await auditor.end()}
}
main().catch(async(error:any)=>{
 const safe=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(value)?value:'redacted';
 if(privateEvidenceRoot)try{await writeFile(join(privateEvidenceRoot,'operator-error.json'),JSON.stringify({stage:operatorStage,at:new Date().toISOString(),name:safe(error?.name),code:safe(error?.code),reasons:Array.isArray(error?.reasons)?error.reasons.map(safe):[]},null,2),{mode:0o600})}catch{}
 process.stderr.write('Production operator stopped at '+operatorStage+'; inspect private evidence before retry.\n');process.exitCode=1
});
