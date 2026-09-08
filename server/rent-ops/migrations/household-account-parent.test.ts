import assert from 'node:assert/strict';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {ensureRentOpsSchema} from '../persistence';

test('account-only household contact persists without invented tenancy and keeps parent/FK guards', async()=>{
 const db=new PGlite();
 try {
  await ensureRentOpsSchema({apply:true,query:sql=>db.query(sql),executor:async sql=>{await db.exec(sql)}});
  await db.query("INSERT INTO rent_ops_people (id,first_name,last_name) VALUES ('account','Account','Person'),('contact','Contact','Person')");
  await db.query("INSERT INTO rent_ops_household_memberships (id,account_person_id,person_id,role) VALUES ('member','account','contact',NULL)");
  const readback=await db.query("SELECT tenancy_id,application_id,account_person_id,role FROM rent_ops_household_memberships WHERE id='member'");
  assert.deepEqual(readback.rows,[{tenancy_id:null,application_id:null,account_person_id:'account',role:null}]);
  await assert.rejects(db.query("INSERT INTO rent_ops_household_memberships (id,person_id) VALUES ('orphan','contact')"),/rent_ops_household_memberships_parent/);
  await assert.rejects(db.query("INSERT INTO rent_ops_household_memberships (id,account_person_id,person_id) VALUES ('bad-account','missing','contact')"),/foreign key/);
  await assert.rejects(db.query("UPDATE rent_ops_household_memberships SET account_person_id=NULL WHERE id='member'"),/rent_ops_household_memberships_parent/);
  await ensureRentOpsSchema({apply:true,query:sql=>db.query(sql),executor:async sql=>{await db.exec(sql)}});
 }finally{await db.close()}
});
