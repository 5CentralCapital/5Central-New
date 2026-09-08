import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { ensureRentOpsSchema } from "../persistence";
import { PostgresRentOpsRepository } from "../repositories/postgres";
import { PostgresTenantPaymentStore } from "../payments/store";
import { createRentOpsPoolExecutor, RentOpsRetryableConflict } from "../runtime-database";
const connectionString=process.env.RENT_OPS_QA_POSTGRES_URL;
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return{promise,resolve};};

test("real PostgreSQL person tuple fence rejects stale manual/Stripe snapshots in both lock orders", {skip:!connectionString}, async()=>{
 const parsed=new URL(connectionString!);assert.equal(parsed.hostname,"127.0.0.1");assert.equal(parsed.port,"55439");
 const pool=new pg.Pool({connectionString}); const db=createRentOpsPoolExecutor(pool as any);
 try {
  await ensureRentOpsSchema({apply:true,executor:async sql=>{await pool.query(sql);}});
  await pool.query("INSERT INTO rent_ops_people(id,first_name,last_name) VALUES('lock-person','QA','Fence')");
  const before=(await pool.query("SELECT to_jsonb(p) AS row FROM rent_ops_people p WHERE id='lock-person'")).rows[0].row;
  const repo=new PostgresRentOpsRepository(db);(repo as any).ready=true;
  const stripe=new PostgresTenantPaymentStore(db);
  for(const firstKind of ["manual","stripe"]){
    const locked=deferred(),release=deferred(),secondSnapshot=deferred();
    const first=firstKind==="manual" ? repo.transaction(async()=>{locked.resolve();await release.promise;},{lockAccountPersonId:"lock-person"}) : stripe.transaction(async store=>{await store.lockAccount("lock-person");locked.resolve();await release.promise;});
    await locked.promise;
    const second=db.transaction!(async executor=>{
      await executor.query("SELECT count(*) FROM rent_ops_activity_events");secondSnapshot.resolve();
      if(firstKind==="manual") await new PostgresTenantPaymentStore(executor,undefined,true).lockAccount("lock-person");
      else await (new PostgresRentOpsRepository(executor) as any).lockRowsForOperation({lockAccountPersonId:"lock-person"});
    });
    const rejection=assert.rejects(second,error=>error instanceof RentOpsRetryableConflict && error.status===409);
    await secondSnapshot.promise;release.resolve();await first;await rejection;
    await stripe.transaction(async store=>{await store.lockAccount("lock-person");});
  }
  const after=(await pool.query("SELECT to_jsonb(p) AS row FROM rent_ops_people p WHERE id='lock-person'")).rows[0].row;
  assert.deepEqual(after,before);
 }finally{await db.close();}
});
