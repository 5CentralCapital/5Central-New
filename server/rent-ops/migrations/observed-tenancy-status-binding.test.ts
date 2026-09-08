import assert from 'node:assert/strict';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {ensureRentOpsSchema} from '../persistence';
test('financial crosswalk accepts exact observed Status and partition bindings, rejects unsupported bindings',async()=>{
 const db=new PGlite();try{
 await ensureRentOpsSchema({apply:true,query:sql=>db.query(sql),executor:async sql=>{await db.exec(sql)}});
 const insert=(id:string,collection:string,field:string)=>db.query("INSERT INTO rent_ops_financial_semantic_crosswalks(id,artifact_sha256,source_collection,source_field,semantic_kind,normalization,normalized_value,target_value) VALUES ($1,$2,$3,$4,'tenancy_status','trim_lower_unicode_v1','current','current')",[id,'a'.repeat(64),collection,field]);
 await insert('observed','tenants','Status');
 for(const collection of ['tenants.current','tenants.future','tenants.former'])await insert(collection,collection,'$partition');
 for(const [collection,field]of [['tenants','status'],['tenants','Unknown'],['unknown','Status']])await assert.rejects(insert(collection+field,collection,field),/rent_ops_financial_crosswalk_binding_check/);
 const count=await db.query('SELECT COUNT(*)::integer AS n FROM rent_ops_financial_semantic_crosswalks');assert.equal(count.rows[0].n,4);
 }finally{await db.close()}
});
