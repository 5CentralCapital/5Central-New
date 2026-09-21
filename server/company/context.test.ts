import test from 'node:test';
import assert from 'node:assert/strict';
import { readCompanyContext } from './context';
import { createSyntheticCompanyDatabase, SYNTHETIC_COMPANY } from './testing/synthetic-database';

test('company directory respects paired, revoked and role-specific grants', async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    const { db, executor } = fixture;
    const c = SYNTHETIC_COMPANY;
    const context = await readCompanyContext(executor, c.actorId, 'admin');
    assert.equal(context.organizations.length, 1);
    assert.deepEqual(context.organizations[0].entities[0].properties[0].units, [{ id: c.unitId, unitNumber: '1A' }]);
    assert.deepEqual(await readCompanyContext(executor, 'unprovisioned-admin', 'admin'), { organizations: [] });
    assert.deepEqual(await readCompanyContext(executor, c.actorId, 'owner'), { organizations: [] });
    await db.query("INSERT INTO rent_ops_properties(id,name,slug) VALUES ('secret-property','Restricted property','restricted-property')");
    await db.query("INSERT INTO company_property_entity_periods(id,organization_id,legal_entity_id,property_id,effective_from) VALUES ('30000000-0000-4000-8000-000000000002',$1,$2,'secret-property','2020-01-01')", [c.organizationId,c.entityId]);
    await db.query("INSERT INTO company_access_grants(id,organization_id,actor_id,role,legal_entity_id,property_id) VALUES ('40000000-0000-4000-8000-000000000002',$1,'restricted','admin',$2,$3)", [c.organizationId,c.entityId,c.propertyId]);
    const limited = await readCompanyContext(executor, 'restricted', 'admin');
    assert.deepEqual(limited.organizations[0].entities[0].properties.map(p=>p.id), [c.propertyId]);
    await db.query("UPDATE company_access_grants SET revoked_at=now() WHERE actor_id='restricted'");
    assert.deepEqual(await readCompanyContext(executor, 'restricted', 'admin'), { organizations: [] });
    await db.query("UPDATE company_legal_entities SET archived_at=now() WHERE id=$1", [c.entityId]);
    assert.deepEqual((await readCompanyContext(executor, c.actorId, 'admin')).organizations[0].entities, []);
  } finally { await fixture.close(); }
});
