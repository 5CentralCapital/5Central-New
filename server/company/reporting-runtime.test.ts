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

import { createAccountingServices } from '../accounting';
import { createCompanyReportingPort } from './reporting-runtime';
import { createSyntheticRuntimeExecutor } from './testing/synthetic-database';
import type { ForecastReportingReadPort } from '../reporting';

const restrictedActor = 'restricted-report-actor';
const otherProperty = 'demo-property-report-b';

async function runtimeFixture() {
  const database = await createSyntheticCompanyDatabase();
  const { db } = database;
  await db.query("INSERT INTO rent_ops_properties(id,name,slug) VALUES ($1,'Demo property B','demo-property-report-b')", [otherProperty]);
  await db.query("INSERT INTO rent_ops_units(id,property_id,unit_number) VALUES ('demo-unit-report-b',$1,'1B')", [otherProperty]);
  await db.query("INSERT INTO company_property_entity_periods(id,organization_id,legal_entity_id,property_id,effective_from) VALUES ('30000000-0000-4000-8000-000000000031',$1,$2,$3,'2020-01-01')", [fixture.organizationId, fixture.entityId, otherProperty]);
  await db.query("INSERT INTO company_access_grants(id,organization_id,actor_id,role,legal_entity_id,property_id) VALUES ('40000000-0000-4000-8000-000000000031',$1,$2,'admin',$3,$4)", [fixture.organizationId, restrictedActor, fixture.entityId, fixture.propertyId]);
  await db.query("INSERT INTO rent_ops_people(id,first_name,last_name) VALUES ('report-person-a','Example','Resident'),('report-person-b','Other','Resident')");
  await db.query("INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,actual_move_in_on,created_at) VALUES ('report-tenancy-a',$1,$2,'report-person-a','current','2026-01-01',now()),('report-tenancy-b',$3,'demo-unit-report-b','report-person-b','current','2026-01-01',now())", [fixture.propertyId, fixture.unitId, otherProperty]);
  const executor = await createSyntheticRuntimeExecutor(db);
  const principalFor = (actorId: string = fixture.actorId) => loadAuthenticatedPrincipal(executor, { actorId, organizationId: fixture.organizationId, role: 'admin' });
  return { database, db, executor, principalFor };
}

const settlementColumns = 'id,organization_id,legal_entity_id,property_id,manager_name,period_start,period_end,currency,opening_held_cents,gross_collections_cents,pm_fees_cents,pm_expenses_cents,other_deductions_cents,owner_remittance_cents,closing_held_cents,state,bank_settled_on,source_fingerprint';

async function insertSettlement(db: Awaited<ReturnType<typeof runtimeFixture>>['db'], id: string, propertyId: string, start: string, end: string, amounts: [number, number, number, number, number, number, number]) {
  await db.query(`INSERT INTO accounting_pm_settlements(${settlementColumns}) VALUES ($1,$2,$3,$4,'Example PM',$5,$6,'USD',$7,$8,$9,$10,$11,$12,$13,'reconciled',$6,$14)`, [id, fixture.organizationId, fixture.entityId, propertyId, start, end, ...amounts, 'a'.repeat(64)]);
}

test('every report reports its runtime capability through the company runtime', async () => {
  const { database, db, executor, principalFor } = await runtimeFixture();
  try {
    const accounting = createAccountingServices(executor, { environment: {} });
    const port = createCompanyReportingPort(executor, accounting);
    const principal = await principalFor();
    const entries = await port.catalog({ principal });
    assert.equal(entries.length, 53);
    const status = Object.fromEntries(entries.map(entry => [entry.id, entry.runtimeStatus]));
    assert.equal(entries.filter(entry => entry.runtimeStatus === 'not_implemented').length, 0, 'every report has an engine');
    for (const entry of entries) assert.equal(entry.executable, entry.runtimeStatus === 'available', entry.id);
    for (const entry of entries.filter(item => item.runtimeStatus !== 'available')) assert.ok(entry.runtimeReason && entry.runtimeReason.length > 10, `${entry.id} needs an exact reason`);
    const available = ['delinquency', 'lease-expiration', 'rent-roll', 'security-deposit', 'tenant-ledger', 'occupancy', 'scheduled-income', 'scheduled-vs-collected', 'collected-income', 'hap', 'applicant-pipeline',
      'current-tenants', 'rent-paid', 'renters-insurance', 'tenant-vehicles', 'unit-listings', 'leasing-agent', 'completed-tasks', 'open-tasks', 'tasks-performance', 'vendor-details', 'work-orders',
      'contractor-exposure', 'project-performance', 'rehab-benchmark', 'investor-owner-activity', 'property-statement', 'lender-management-package'];
    for (const id of available) assert.equal(status[id], 'available', id);
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    for (const id of ['balance-sheet', 'cash-flow-statement', 'general-ledger', 'income-statement', 'income-statement-detailed', 'trial-balance']) assert.deepEqual([status[id], byId.get(id)?.runtimeReason], ['missing_data', 'Connect QuickBooks to run financial statements.'], id);
    for (const id of ['balance-sheet-by-fund-type', 'balance-sheet-consolidated', 'budget-vs-actual', 'general-ledger-consolidated', 'income-statement-by-unit', 'income-statement-consolidated', 'trial-balance-consolidated', 'portfolio-financials', 'property-t12', 'accounts-receivable', 'accounts-payable', 'cash-position']) assert.equal(status[id], 'missing_data', id);
    for (const id of ['cash-forecast-13-week', 'operating-growth-plan', 'debt-refinance', 'exit-scenarios']) assert.deepEqual([status[id], byId.get(id)?.runtimeReason], ['missing_data', 'No approved forecast scenario.'], id);
    assert.deepEqual([status['rental-owner-statement'], byId.get('rental-owner-ending-balances')?.runtimeReason], ['missing_data', 'No property-manager settlements are recorded yet.']);
    assert.deepEqual([status['work-sessions'], byId.get('work-sessions')?.runtimeReason], ['missing_data', 'Connect QuickBooks Time to report work sessions.']);
    assert.equal(Object.keys(status).length, 53);
    // Every catalog entry is served by the engine its definition names.
    const definitionsByEngine = new Map<string, string[]>();
    for (const entry of entries) definitionsByEngine.set(entry.engineKey, [...(definitionsByEngine.get(entry.engineKey) ?? []), entry.id]);
    assert.equal(definitionsByEngine.size, 14);
    await insertSettlement(db, '70000000-0000-4000-8000-000000000001', fixture.propertyId, '2026-07-01', '2026-07-31', [0, 100000, 6000, 4000, 0, 90000, 0]);
    const forecastPort: ForecastReportingReadPort = { async read() { throw new Error('not used'); } };
    const withForecast = createCompanyReportingPort(executor, accounting, { forecastPort: () => forecastPort });
    const refreshed = new Map((await withForecast.catalog({ principal })).map(entry => [entry.id, entry.runtimeStatus]));
    assert.equal(refreshed.get('rental-owner-statement'), 'available');
    assert.equal(refreshed.get('cash-forecast-13-week'), 'available');
  } finally { await database.close(); }
});

test('owner statements, property statements and work orders run through real grants', async () => {
  const { database, db, executor, principalFor } = await runtimeFixture();
  try {
    const port = createCompanyReportingPort(executor, createAccountingServices(executor, { environment: {} }));
    await insertSettlement(db, '70000000-0000-4000-8000-000000000011', fixture.propertyId, '2026-07-01', '2026-07-31', [0, 100000, 6000, 4000, 0, 85000, 5000]);
    await insertSettlement(db, '70000000-0000-4000-8000-000000000012', fixture.propertyId, '2026-08-01', '2026-08-31', [5000, 100000, 6000, 4000, 0, 95000, 0]);
    await insertSettlement(db, '70000000-0000-4000-8000-000000000013', otherProperty, '2026-08-01', '2026-08-31', [0, 50000, 3000, 0, 0, 47000, 0]);
    await db.query("INSERT INTO accounting_pm_settlement_lines(organization_id,settlement_id,line_number,kind,description,amount_cents) VALUES ($1,'70000000-0000-4000-8000-000000000012',1,'rent_receipt','Rent',100000),($1,'70000000-0000-4000-8000-000000000012',2,'pm_fee','Fee',6000),($1,'70000000-0000-4000-8000-000000000012',3,'pm_expense','Repair',4000),($1,'70000000-0000-4000-8000-000000000012',4,'owner_remittance','Draw',95000)", [fixture.organizationId]);
    const admin = await principalFor();
    const scope = { organizationId: fixture.organizationId, legalEntityIds: [fixture.entityId], propertyIds: [] };
    const statement = await port.run({ principal: admin }, reportRunRequestSchema.parse({ reportId: 'rental-owner-statement', definitionVersion: '1', scope, filters: {}, period: { mode: 'range', fromDate: '2026-07-01', toDate: '2026-08-31' }, basis: 'mixed', currency: null }));
    assert.equal(statement.page.totalRows, 3);
    const totals = Object.fromEntries(statement.page.totals.map(item => [item.key, item.amountCents]));
    assert.deepEqual(totals, { opening_held: '0', gross_collections: '250000', pm_fees: '15000', pm_expenses: '8000', other_deductions: '0', owner_remittance: '227000', closing_held: '0' });
    assert.equal(statement.page.missingData.length, 0);
    const drilldown = await port.drilldown({ principal: admin }, { runId: statement.run.id, rowId: 'owner-statement:70000000-0000-4000-8000-000000000012', limit: 10 });
    assert.equal(drilldown.items.length, 4);
    // A property-limited principal sees only its own property's settlements.
    const restricted = await principalFor(restrictedActor);
    const restrictedStatement = await port.run({ principal: restricted }, reportRunRequestSchema.parse({ reportId: 'rental-owner-statement', definitionVersion: '1', scope: { ...scope, propertyIds: [fixture.propertyId] }, filters: {}, period: { mode: 'range', fromDate: '2026-07-01', toDate: '2026-08-31' }, basis: 'mixed', currency: null }));
    assert.equal(restrictedStatement.page.totalRows, 2);
    await assert.rejects(() => port.run({ principal: restricted }, reportRunRequestSchema.parse({ reportId: 'rental-owner-statement', definitionVersion: '1', scope: { ...scope, propertyIds: [otherProperty] }, filters: {}, period: { mode: 'range', fromDate: '2026-07-01', toDate: '2026-08-31' }, basis: 'mixed', currency: null })));
    const balances = await port.run({ principal: admin }, reportRunRequestSchema.parse({ reportId: 'rental-owner-ending-balances', definitionVersion: '1', scope, filters: {}, period: { mode: 'as_of', asOfDate: '2026-08-15' }, basis: 'mixed', currency: null }));
    assert.equal(balances.page.totals.find(item => item.key === 'closing_held')?.amountCents, '5000');
    const property = await port.run({ principal: admin }, reportRunRequestSchema.parse({ reportId: 'property-statement', definitionVersion: '1', scope: { ...scope, propertyIds: [fixture.propertyId] }, filters: {}, period: { mode: 'range', fromDate: '2026-08-01', toDate: '2026-08-31' }, basis: 'cash', currency: 'USD' }));
    const propertyTotals = Object.fromEntries(property.page.totals.map(item => [item.key, item.amountCents]));
    assert.equal(propertyTotals.gross_collections, '100000');
    assert.equal(propertyTotals.owner_remittance, '95000');
    assert.equal(propertyTotals.net_to_owner, '90000');
    assert.equal(propertyTotals.rental_collections, null, 'no recorded receipts is unknown, not zero');
    assert.equal(propertyTotals.book_income, null, 'no QuickBooks connection is unknown, not zero');
    await db.query(`INSERT INTO company_work_orders(id,organization_id,legal_entity_id,property_id,unit_id,title,category,priority,status,reported_on,completed_on,assigned_to,currency,estimated_cost_cents,created_by,updated_by)
      VALUES ('71000000-0000-4000-8000-000000000001',$1,$2,$3,$4,'Leak','plumbing','high','new','2026-09-01',NULL,'Example Plumbing','USD',12000,'demo-admin','demo-admin'),
             ('71000000-0000-4000-8000-000000000002',$1,$2,$5,'demo-unit-report-b','Door','general','normal','completed','2026-08-20','2026-09-05',NULL,'USD',3000,'demo-admin','demo-admin')`, [fixture.organizationId, fixture.entityId, fixture.propertyId, fixture.unitId, otherProperty]);
    const workOrders = await port.run({ principal: admin }, reportRunRequestSchema.parse({ reportId: 'work-orders', definitionVersion: '1', scope: { ...scope, legalEntityIds: [] }, filters: {}, period: { mode: 'custom', asOfDate: '2026-09-03' }, basis: 'operational', currency: null }));
    assert.equal(workOrders.page.totalRows, 2);
    assert.equal(workOrders.page.totals[0]?.amountCents, '15000');
    await assert.rejects(() => port.run({ principal: restricted }, reportRunRequestSchema.parse({ reportId: 'work-orders', definitionVersion: '1', scope: { ...scope, legalEntityIds: [] }, filters: {}, period: { mode: 'custom', asOfDate: '2026-09-03' }, basis: 'operational', currency: null })), /Choose the legal entities or properties you can access/);
    const restrictedOrders = await port.run({ principal: restricted }, reportRunRequestSchema.parse({ reportId: 'work-orders', definitionVersion: '1', scope: { ...scope, propertyIds: [fixture.propertyId] }, filters: { status: ['new'] }, period: { mode: 'custom', asOfDate: '2026-09-03' }, basis: 'operational', currency: null }));
    assert.deepEqual(restrictedOrders.page.rows.map(row => row.values.title), ['Leak']);
  } finally { await database.close(); }
});

test('report references and the lender package are scoped to grants and frozen runs', async () => {
  const { database, db, executor, principalFor } = await runtimeFixture();
  try {
    const port = createCompanyReportingPort(executor, createAccountingServices(executor, { environment: {} }));
    await db.query("INSERT INTO company_projects(id,organization_id,legal_entity_id,property_id,name,project_type,status,currency) VALUES ('72000000-0000-4000-8000-000000000001',$1,$2,$3,'Roof A','rehab','active','USD'),('72000000-0000-4000-8000-000000000002',$1,$2,$4,'Roof B','rehab','active','USD')", [fixture.organizationId, fixture.entityId, fixture.propertyId, otherProperty]);
    const admin = await principalFor();
    const restricted = await principalFor(restrictedActor);
    const allProjects = await port.references({ principal: admin }, { kind: 'project' });
    assert.deepEqual(allProjects.items.map(item => item.label), ['Roof A', 'Roof B']);
    assert.deepEqual((await port.references({ principal: restricted }, { kind: 'project' })).items.map(item => item.label), ['Roof A']);
    const searched = await port.references({ principal: admin }, { kind: 'tenant', search: 'Other' });
    assert.deepEqual(searched.items.map(item => item.value), ['report-person-b']);
    assert.deepEqual((await port.references({ principal: restricted }, { kind: 'tenant' })).items.map(item => item.value), ['report-person-a']);
    const firstPage = await port.references({ principal: admin }, { kind: 'tenancy', limit: 1 });
    assert.equal(firstPage.items.length, 1);
    assert.ok(firstPage.nextCursor);
    const secondPage = await port.references({ principal: admin }, { kind: 'tenancy', limit: 1, cursor: firstPage.nextCursor });
    assert.notEqual(secondPage.items[0]?.value, firstPage.items[0]?.value);
    assert.equal((await port.references({ principal: admin }, { kind: 'account' })).reason, 'Connect QuickBooks to choose accounts.');
    const scope = { organizationId: fixture.organizationId, legalEntityIds: [fixture.entityId], propertyIds: [] };
    await port.run({ principal: admin }, reportRunRequestSchema.parse({ reportId: 'rent-roll', definitionVersion: '1', scope, filters: { propertyScope: 'all' }, period: { mode: 'as_of', asOfDate: '2026-08-31' }, basis: 'operational', currency: null }));
    const lender = await port.run({ principal: admin }, reportRunRequestSchema.parse({ reportId: 'lender-management-package', definitionVersion: '1', scope, filters: {}, period: { mode: 'custom', fromDate: '2026-08-01', toDate: '2026-08-31' }, basis: 'mixed', currency: null }));
    const sections = Object.fromEntries(lender.page.rows.map(row => [row.rowId, row.values.state]));
    assert.equal(sections['lender-package:rent_roll'], 'partial', 'a rent roll with partial coverage is not a ready section');
    assert.equal(sections['lender-package:balance_sheet'], 'unavailable');
    assert.equal(lender.page.coverage[0]?.state, 'partial');
    // Another actor cannot assemble a package from these runs.
    await assert.rejects(() => port.run({ principal: restricted }, reportRunRequestSchema.parse({ reportId: 'lender-management-package', definitionVersion: '1', scope, filters: {}, period: { mode: 'custom', fromDate: '2026-08-01', toDate: '2026-08-31' }, basis: 'mixed', currency: null })));
  } finally { await database.close(); }
});
