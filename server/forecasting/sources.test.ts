import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticCompanyDatabase, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { depositsHeld } from "./sources";

const { propertyId, unitId } = SYNTHETIC_COMPANY;

test("opening deposits exclude and flag deposits with no receipt date or no held amount instead of counting them as zero", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    const { db, executor } = fixture;
    await db.query("INSERT INTO rent_ops_people(id,first_name,last_name) VALUES ('src-person-1','Example','Resident')");
    await db.query("INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,created_at) VALUES ('src-tenancy-1',$1,$2,'src-person-1','current',now())", [propertyId, unitId]);
    const deposit = (id: string, amount: number, receivedOn: string, status = "held", disposedOn: string | null = null) => db.query(
      "INSERT INTO rent_ops_security_deposits(id,property_id,unit_id,tenancy_id,person_id,type,amount_held_cents,received_on,disposition_status,disposed_on) VALUES ($1,$2,$3,'src-tenancy-1','src-person-1','security',$4,$5,$6,$7)",
      [id, propertyId, unitId, amount, receivedOn, status, disposedOn]);
    await deposit("src-deposit-1", 100000, "2026-01-05");
    await deposit("src-deposit-2", 50000, "2026-02-01", "returned", "2027-01-15");
    const complete = await depositsHeld(executor, [propertyId], "2026-12-27");
    assert.deepEqual([complete.amountCents, complete.state], ["150000", "sourced"]);

    await db.query("INSERT INTO rent_ops_security_deposits(id,property_id,unit_id,tenancy_id,person_id,type,amount_held_cents,received_on,disposition_status) VALUES ('src-deposit-3',$1,$2,'src-tenancy-1','src-person-1','security',70000,NULL,'held')", [propertyId, unitId]);
    const undated = await depositsHeld(executor, [propertyId], "2026-12-27");
    assert.equal(undated.amountCents, "150000");
    assert.equal(undated.state, "partial");
    assert.match(undated.note ?? "", /1 held deposit\(s\) have no receipt date/);
  } finally {
    await fixture.close();
  }
});
