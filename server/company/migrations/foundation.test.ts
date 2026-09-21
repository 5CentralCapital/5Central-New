import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { ensureRentOpsSchema } from "../../rent-ops/persistence";

const orgA = "10000000-0000-4000-8000-000000000001";
const orgB = "10000000-0000-4000-8000-000000000002";
const entityA = "20000000-0000-4000-8000-000000000001";
const entityB = "20000000-0000-4000-8000-000000000002";
const uuid = (n: number) => `30000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

test("company foundation enforces entity scope, historical identity and dated property assignment", async (t) => {
  const db = new PGlite();
  try {
    await ensureRentOpsSchema({ apply: true, query: sql => db.query(sql), executor: async sql => { await db.exec(sql); } });
    await db.query("INSERT INTO company_organizations(id,name) VALUES ($1,'Example Company'),($2,'Other Company')", [orgA, orgB]);
    await db.query("INSERT INTO company_legal_entities(id,organization_id,name,entity_type,currency) VALUES ($1,$2,'Example LLC','llc','USD'),($3,$4,'Other LLC','llc','USD')", [entityA, orgA, entityB, orgB]);
    await db.exec("INSERT INTO rent_ops_properties(id,slug) VALUES ('legacy-property-7','example-property'); INSERT INTO rent_ops_people(id) VALUES ('legacy-person-9')");

    await t.test("new company records link to preserved rental IDs without replacing them", async () => {
      await db.query("INSERT INTO company_contacts(id,organization_id,kind,display_name,rent_ops_person_id) VALUES ($1,$2,'person','Example Contact','legacy-person-9')", [uuid(1), orgA]);
      const contact = await db.query<{ rent_ops_person_id: string }>("SELECT rent_ops_person_id FROM company_contacts WHERE id=$1", [uuid(1)]);
      assert.equal(contact.rows[0].rent_ops_person_id, "legacy-person-9");
      await assert.rejects(() => db.query("INSERT INTO company_contacts(id,organization_id,kind,display_name,rent_ops_person_id) VALUES ($1,$2,'organization','Invalid Organization','legacy-person-9')", [uuid(2), orgA]));
    });

    await t.test("same contact supports multiple roles but cannot reference another company's entity", async () => {
      for (const [n, role] of [[3, "investor"], [4, "vendor"]] as const) {
        await db.query("INSERT INTO company_contact_roles(id,organization_id,contact_id,legal_entity_id,role,effective_from) VALUES ($1,$2,$3,$4,$5,'2026-01-01')", [uuid(n), orgA, uuid(1), entityA, role]);
      }
      await assert.rejects(() => db.query("INSERT INTO company_contact_roles(id,organization_id,contact_id,legal_entity_id,role,effective_from) VALUES ($1,$2,$3,$4,'employee','2026-01-01')", [uuid(5), orgA, uuid(1), entityB]));
      await assert.rejects(() => db.query("INSERT INTO company_contact_roles(id,organization_id,contact_id,legal_entity_id,role,effective_from) VALUES ($1,$2,$3,$4,'employee','2026-01-01')", [uuid(6), orgB, uuid(1), entityB]));
      const result = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM company_contact_roles WHERE contact_id=$1", [uuid(1)]);
      assert.equal(result.rows[0].count, 2);
    });

    await t.test("property accounting periods cannot overlap, even across organizations", async () => {
      await db.query("INSERT INTO company_property_entity_periods(id,organization_id,legal_entity_id,property_id,effective_from,effective_until) VALUES($1,$2,$3,'legacy-property-7','2026-01-01','2026-07-01')", [uuid(10), orgA, entityA]);
      await assert.rejects(() => db.query("INSERT INTO company_property_entity_periods(id,organization_id,legal_entity_id,property_id,effective_from) VALUES($1,$2,$3,'legacy-property-7','2026-06-30')", [uuid(11), orgB, entityB]), /company_property_entity_period_overlap/);
      await db.query("INSERT INTO company_property_entity_periods(id,organization_id,legal_entity_id,property_id,effective_from) VALUES($1,$2,$3,'legacy-property-7','2026-07-01')", [uuid(12), orgB, entityB]);
      await assert.rejects(() => db.query("UPDATE company_property_entity_periods SET effective_until='2026-07-02' WHERE id=$1", [uuid(10)]), /company_property_entity_period_overlap/);
      const active = await db.query<{ legal_entity_id: string }>("SELECT legal_entity_id FROM company_property_entity_periods WHERE property_id=$1 AND daterange(effective_from,effective_until,'[)') @> $2::date", ["legacy-property-7", "2026-07-01"]);
      assert.deepEqual(active.rows.map(r => r.legal_entity_id), [entityB]);
    });

    await t.test("scope cannot be silently reassigned and history cannot be deleted", async () => {
      await assert.rejects(() => db.query("UPDATE company_contacts SET organization_id=$1 WHERE id=$2", [orgB, uuid(1)]), /company_identity_is_immutable/);
      await assert.rejects(() => db.query("DELETE FROM company_contacts WHERE id=$1", [uuid(1)]), /company_identity_delete_forbidden/);
      await db.query("UPDATE company_contacts SET display_name='Renamed Contact',record_revision=record_revision+1 WHERE id=$1 AND record_revision=1", [uuid(1)]);
      const stale = await db.query("UPDATE company_contacts SET display_name='Stale Overwrite',record_revision=record_revision+1 WHERE id=$1 AND record_revision=1 RETURNING id", [uuid(1)]);
      assert.equal(stale.rows.length, 0);
    });

    await t.test("access grants cannot expand their scope or reverse a revocation", async () => {
      const insert = (n: number, entity = entityA) => db.query("INSERT INTO company_access_grants(id,organization_id,actor_id,role,legal_entity_id,property_id) VALUES($1,$2,'example-principal','finance',$3,'legacy-property-7')", [uuid(n), orgA, entity]);
      await insert(30);
      await assert.rejects(() => insert(31));
      await assert.rejects(() => insert(32, entityB));
      await assert.rejects(() => db.query("UPDATE company_access_grants SET role='owner' WHERE id=$1", [uuid(30)]), /company_access_grant_is_immutable/);
      await assert.rejects(() => db.query("UPDATE company_access_grants SET property_id=NULL WHERE id=$1", [uuid(30)]), /company_access_grant_is_immutable/);
      await db.query("UPDATE company_access_grants SET revoked_at='2026-09-21T12:00:00Z' WHERE id=$1", [uuid(30)]);
      await assert.rejects(() => db.query("UPDATE company_access_grants SET revoked_at=NULL WHERE id=$1", [uuid(30)]), /company_access_grant_is_immutable/);
      await assert.rejects(() => db.query("DELETE FROM company_access_grants WHERE id=$1", [uuid(30)]), /company_command_history_delete_forbidden/);
      await insert(33);
    });

    await t.test("external identities stay unique within their provider realm and immutable", async () => {
      const insert = (n: number, realm: string, entity = entityA) => db.query("INSERT INTO company_external_identities(id,organization_id,legal_entity_id,provider,source_scope,record_kind,external_id,local_kind,local_id) VALUES($1,$2,$3,'qbo',$4,'Vendor','42','contact',$5)", [uuid(n), orgA, entity, realm, uuid(1)]);
      await insert(20, "sandbox-realm-one");
      await assert.rejects(() => insert(21, "sandbox-realm-one"));
      await insert(22, "sandbox-realm-two");
      await assert.rejects(() => insert(23, "sandbox-realm-three", entityB));
      await assert.rejects(() => db.query("UPDATE company_external_identities SET external_id='43' WHERE id=$1", [uuid(20)]), /company_identity_is_immutable/);
      await assert.rejects(() => db.query("DELETE FROM company_external_identities WHERE id=$1", [uuid(20)]), /company_identity_delete_forbidden/);
    });
  } finally {
    await db.close();
  }
});
