/** Separate private read-only source-role process. Never run inside the web process. */
import {readFile,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {resolve} from 'node:path';
import {createRentOpsRuntimeDatabase} from '../server/rent-ops/runtime-database';
import type {RentOpsQueryExecutor} from '../server/rent-ops/repositories/postgres';
export function provisionTargetFingerprint(connectionString:string){const url=new URL(connectionString);if(!['postgres:','postgresql:'].includes(url.protocol))throw Error('Database URL required');return createHash('sha256').update(JSON.stringify({host:url.hostname.toLowerCase().replace(/-pooler(?=\.)/,''),port:url.port||'5432',database:decodeURIComponent(url.pathname)})).digest('hex');}
export async function verifiedImportReceiptHash(path:string){const bytes=await readFile(path);const receipt=JSON.parse(bytes.toString());if(receipt.summary?.committed!==true||receipt.postcommitAudit?.passed!==true)throw Error('Committed audited import receipt required');return createHash('sha256').update(bytes).digest('hex');}
export async function exportSourceIdentityCrosswalk(db:RentOpsQueryExecutor){
 if(!db.transaction)throw Error('Pinned read-only transaction required');return db.transaction(async reader=>{
  const rows=(await reader.query(`SELECT id,system,entity_type AS "entityType",source_id AS "sourceId",target_id AS "targetId",imported_at AS "importedAt" FROM rent_ops_source_records WHERE system='rent_manager' AND entity_type IN ('person','tenancy','property','unit') ORDER BY entity_type,source_id`)).rows;
  return {kind:'private_production_source_identity_crosswalk_v1',rows};
 },{readOnly:true});
}
async function main(){const url=process.env.RENT_OPS_SOURCE_IDENTITY_DATABASE_URL,out=process.env.RENT_OPS_PROVISION_CROSSWALK,receipt=process.env.RENT_OPS_PROVISION_IMPORT_RECEIPT;if(!url||!receipt||!out||!out.startsWith('/'))throw Error('Ephemeral read-only source URL and absolute private output path required');
 const db=await createRentOpsRuntimeDatabase({env:{...process.env,RENT_OPS_RUNTIME_DATABASE_URL:url}});try{const artifact={...await exportSourceIdentityCrosswalk(db),targetFingerprint:provisionTargetFingerprint(url),importReceiptSha256:await verifiedImportReceiptHash(receipt)};await writeFile(out,JSON.stringify(artifact),{mode:0o600,flag:'wx'});console.log(JSON.stringify({state:'private_crosswalk_exported',rows:artifact.rows.length,databaseWrites:0}));}finally{await db.close();}}
if(process.argv[1]&&resolve(process.argv[1])===resolve('scripts/export-provisioning-crosswalk.ts'))main().catch(()=>{console.error('Private source crosswalk export stopped; no credentials emitted.');process.exitCode=1;});
