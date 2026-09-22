import assert from 'node:assert/strict';
import test from 'node:test';
import { reportRunRequestSchema } from '../../shared/reporting';
import { RENT_OPS_RUNTIME_REQUIRED_TABLES } from '../rent-ops/persistence';
import { createCompanyServices } from './services';
import { loadAuthenticatedPrincipal } from './authorization';
import { createSyntheticCompanyDatabase, SYNTHETIC_COMPANY as fixture } from './testing/synthetic-database';

test('company reports persist scoped rental snapshots and deny a revoked grant', async () => {
  const database = await createSyntheticCompanyDatabase();
  try {
    await database.db.query("INSERT INTO rent_ops_properties(id,name,slug) VALUES ('foreign-property','Outside company','outside-company')");
    await database.db.query("INSERT INTO rent_ops_units(id,property_id,unit_number) VALUES ('foreign-unit','foreign-property','9Z')");
    const laterEntity = '20000000-0000-4000-8000-000000000002';
    await database.db.query("INSERT INTO company_legal_entities(id,organization_id,name,entity_type,currency) VALUES ($1,$2,'Later Property LLC','llc','USD')", [laterEntity, fixture.organizationId]);
    await database.db.query("UPDATE company_property_entity_periods SET effective_until='2026-09-01' WHERE organization_id=$1 AND property_id=$2", [fixture.organizationId, fixture.propertyId]);
    await database.db.query("INSERT INTO company_property_entity_periods(id,organization_id,legal_entity_id,property_id,effective_from) VALUES ('30000000-0000-4000-8000-000000000002',$1,$2,$3,'2026-09-01')", [fixture.organizationId, laterEntity, fixture.propertyId]);
    await database.db.exec('CREATE ROLE reporting_runtime_test; GRANT USAGE ON SCHEMA public TO reporting_runtime_test');
    for (const table of RENT_OPS_RUNTIME_REQUIRED_TABLES) await database.db.exec(`GRANT SELECT ON ${table} TO reporting_runtime_test`);
    const reportTables = await database.db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'company_report_%'");
    for (const { table_name: table } of reportTables.rows) {
      assert.match(table, /^company_report_[a-z_]+$/);
      await database.db.exec(`GRANT SELECT,INSERT,UPDATE ON ${table} TO reporting_runtime_test`);
    }
    await database.db.exec('SET ROLE reporting_runtime_test');
    const services = createCompanyServices(database.executor, { accounting: { environment: {} }, time: { env: {} } });
    const principal = await loadAuthenticatedPrincipal(database.executor, { actorId: fixture.actorId, organizationId: fixture.organizationId, role: 'admin' });
    const request = reportRunRequestSchema.parse({
      reportId: 'occupancy', definitionVersion: '1',
      scope: { organizationId: fixture.organizationId, legalEntityIds: [fixture.entityId], propertyIds: [fixture.propertyId] },
      period: { mode: 'as_of', asOfDate: '2026-08-15' },
      filters: { propertyScope: 'all' }, basis: 'operational', currency: null,
    });
    const result = await services.reporting.run({ principal }, request);
    assert.equal(result.page.totalRows, 1);
    assert.ok(!JSON.stringify(result.page.rows).includes('foreign-unit'));
    const reopened = createCompanyServices(database.executor, { accounting: { environment: {} }, time: { env: {} } });
    const page = await reopened.reporting.page({ principal }, { runId: result.run.id, limit: 100 });
    assert.deepEqual(page.rows, JSON.parse(JSON.stringify(result.page.rows)));
    const laterPeriod = { mode: 'as_of', asOfDate: '2026-09-15' };
    await assert.rejects(() => services.reporting.run({ principal }, reportRunRequestSchema.parse({ ...request, period: laterPeriod })));
    const later = await services.reporting.run({ principal }, reportRunRequestSchema.parse({
      ...request, scope: { ...request.scope, legalEntityIds: [laterEntity] }, period: laterPeriod,
    }));
    assert.equal(later.page.totalRows, 1);
    await assert.rejects(() => services.reporting.run({ principal }, reportRunRequestSchema.parse({
      ...request, scope: { ...request.scope, propertyIds: ['foreign-property'] },
    })));
    await database.db.exec('RESET ROLE');
    await database.db.query('UPDATE company_access_grants SET revoked_at=now() WHERE organization_id=$1 AND actor_id=$2', [fixture.organizationId, fixture.actorId]);
    await database.db.exec('SET ROLE reporting_runtime_test');
    await assert.rejects(() => reopened.reporting.page({ principal }, { runId: result.run.id, limit: 100 }));
  } finally { await database.close(); }
});
