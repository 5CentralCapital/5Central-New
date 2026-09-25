import assert from "node:assert/strict";
import test from "node:test";
import { reportRunCompleteness, reportRunRequestSchema } from "../../../shared/reporting";
import { createAccountingServices } from "../../accounting";
import { loadAuthenticatedPrincipal } from "../../company/authorization";
import { createCompanyReportingPort } from "../../company/reporting-runtime";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY as fixture } from "../../company/testing/synthetic-database";

// Synthetic data only. These tests run the reporting ports against the full
// migration chain with the runtime role's real grants.
const restrictedActor = "restricted-report-actor";
const otherProperty = "demo-property-report-b";
const otherEntity = "20000000-0000-4000-8000-000000000009";

async function runtimeFixture() {
  const database = await createSyntheticCompanyDatabase();
  const { db } = database;
  await db.query("INSERT INTO rent_ops_properties(id,name,slug) VALUES ($1,'Demo property B','demo-property-report-b')", [otherProperty]);
  await db.query("INSERT INTO company_property_entity_periods(id,organization_id,legal_entity_id,property_id,effective_from) VALUES ('30000000-0000-4000-8000-000000000031',$1,$2,$3,'2020-01-01')", [fixture.organizationId, fixture.entityId, otherProperty]);
  await db.query("INSERT INTO company_access_grants(id,organization_id,actor_id,role,legal_entity_id,property_id) VALUES ('40000000-0000-4000-8000-000000000031',$1,$2,'admin',$3,$4)", [fixture.organizationId, restrictedActor, fixture.entityId, fixture.propertyId]);
  const executor = await createSyntheticRuntimeExecutor(db);
  const principalFor = (actorId: string = fixture.actorId) => loadAuthenticatedPrincipal(executor, { actorId, organizationId: fixture.organizationId, role: "admin" });
  const port = createCompanyReportingPort(executor, createAccountingServices(executor, { environment: {} }));
  return { database, db, port, principalFor };
}

const settlementColumns = "id,organization_id,legal_entity_id,property_id,manager_name,period_start,period_end,currency,opening_held_cents,gross_collections_cents,pm_fees_cents,pm_expenses_cents,other_deductions_cents,owner_remittance_cents,closing_held_cents,state,bank_settled_on,source_fingerprint";

test("owner statements select settlements overlapping the period and flag ones ending after it", async () => {
  const { database, db, port, principalFor } = await runtimeFixture();
  try {
    const insert = (id: string, start: string, end: string, amounts: number[]) => db.query(`INSERT INTO accounting_pm_settlements(${settlementColumns}) VALUES ($1,$2,$3,$4,'Example PM',$5,$6,'USD',$7,$8,$9,$10,$11,$12,$13,'reconciled',$6,$14)`, [id, fixture.organizationId, fixture.entityId, fixture.propertyId, start, end, ...amounts, "a".repeat(64)]);
    await insert("70000000-0000-4000-8000-000000000021", "2026-07-01", "2026-07-31", [0, 100000, 6000, 4000, 0, 90000, 0]);
    await insert("70000000-0000-4000-8000-000000000022", "2026-08-01", "2026-09-15", [0, 150000, 9000, 0, 0, 141000, 0]);
    const admin = await principalFor();
    const scope = { organizationId: fixture.organizationId, legalEntityIds: [fixture.entityId], propertyIds: [] };
    const statement = await port.run({ principal: admin }, reportRunRequestSchema.parse({ reportId: "rental-owner-statement", definitionVersion: "1", scope, filters: {}, period: { mode: "range", fromDate: "2026-07-01", toDate: "2026-08-31" }, basis: "mixed", currency: null }));
    assert.equal(statement.page.totalRows, 1);
    assert.equal(statement.page.totals.find(item => item.key === "gross_collections")?.amountCents, "100000");
    assert.ok(statement.page.totals.every(item => item.state === "partial"));
    assert.equal(statement.page.missingData.find(item => item.code === "pm_settlement_extends_past_period")?.count, 1);
    // Ending balances still use only statements that ended by the report date.
    const balances = await port.run({ principal: admin }, reportRunRequestSchema.parse({ reportId: "rental-owner-ending-balances", definitionVersion: "1", scope, filters: {}, period: { mode: "as_of", asOfDate: "2026-08-31" }, basis: "mixed", currency: null }));
    assert.deepEqual(balances.page.rows.map(row => row.values.balanceThrough), ["2026-07-31"]);
  } finally { await database.close(); }
});

test("property-limited principals never see entity-level reference names or vendors outside their projects", async () => {
  const { database, db, port, principalFor } = await runtimeFixture();
  try {
    await db.query(`INSERT INTO time_source_users(id,organization_id,legal_entity_id,environment,provider_company_id,provider_user_id,display_name,last_modified,provider_body,source_version,body_hash)
      VALUES ('73000000-0000-4000-8000-000000000001',$1,$2,'sandbox','co1','u1','Example Staffer',now(),'{}','1',$3)`, [fixture.organizationId, fixture.entityId, "a".repeat(64)]);
    await db.query("INSERT INTO company_contacts(id,organization_id,kind,display_name) VALUES ('75000000-0000-4000-8000-000000000001',$1,'person','Example Investor')", [fixture.organizationId]);
    await db.query("INSERT INTO company_investor_accounts(id,organization_id,contact_id,display_name) VALUES ('75000000-0000-4000-8000-000000000002',$1,'75000000-0000-4000-8000-000000000001','Example Investor')", [fixture.organizationId]);
    await db.query("INSERT INTO company_investor_instruments(id,organization_id,account_id,name,kind,legal_entity_id,currency,effective_from) VALUES ('75000000-0000-4000-8000-000000000003',$1,'75000000-0000-4000-8000-000000000002','Example note','private_loan',$2,'USD','2026-01-01')", [fixture.organizationId, fixture.entityId]);
    await db.query("INSERT INTO company_projects(id,organization_id,legal_entity_id,property_id,name,project_type,status,currency) VALUES ('72000000-0000-4000-8000-000000000001',$1,$2,$3,'Roof A','rehab','active','USD'),('72000000-0000-4000-8000-000000000002',$1,$2,$4,'Roof B','rehab','active','USD')", [fixture.organizationId, fixture.entityId, fixture.propertyId, otherProperty]);
    await db.query("INSERT INTO company_project_vendors(id,organization_id,name) VALUES ('74000000-0000-4000-8000-000000000001',$1,'Unrelated Vendor'),('74000000-0000-4000-8000-000000000002',$1,'Roof A Vendor'),('74000000-0000-4000-8000-000000000003',$1,'Roof B Bidder')", [fixture.organizationId]);
    await db.query("INSERT INTO company_project_commitments(id,organization_id,project_id,vendor_id,description,status,original_cents,committed_cents,currency) VALUES ('76000000-0000-4000-8000-000000000001',$1,'72000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000002','Roof','approved',1000,1000,'USD')", [fixture.organizationId]);
    await db.query("INSERT INTO company_project_bids(id,organization_id,project_id,vendor_id,amount_cents,currency) VALUES ('76000000-0000-4000-8000-000000000002',$1,'72000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000003',2000,'USD')", [fixture.organizationId]);
    const admin = await principalFor();
    const restricted = await principalFor(restrictedActor);
    const labels = async (principal: typeof admin, kind: string) => (await port.references({ principal }, { kind } as never)).items.map(item => item.label);
    assert.deepEqual(await labels(admin, "staff"), ["Example Staffer"]);
    assert.deepEqual(await labels(admin, "investor"), ["Example Investor"]);
    assert.deepEqual(await labels(admin, "vendor"), ["Roof A Vendor", "Roof B Bidder", "Unrelated Vendor"]);
    const staff = await port.references({ principal: restricted }, { kind: "staff" } as never);
    assert.deepEqual(staff.items, []);
    assert.equal(staff.reason, "This list needs access to a whole legal entity.");
    assert.deepEqual(await labels(restricted, "investor"), []);
    assert.deepEqual(await labels(restricted, "owner"), []);
    assert.deepEqual(await labels(restricted, "vendor"), ["Roof A Vendor"]);
    // An entity-scoped selection by an organization admin still lists its vendors only.
    assert.deepEqual((await port.references({ principal: admin }, { kind: "vendor", legalEntityIds: [fixture.entityId] } as never)).items.map(item => item.label), ["Roof A Vendor", "Roof B Bidder"]);
  } finally { await database.close(); }
});

test("lender package sections need one whole-entity run covering every selected entity", async () => {
  const { database, db, port, principalFor } = await runtimeFixture();
  try {
    await db.query("INSERT INTO company_legal_entities(id,organization_id,name,entity_type,currency) VALUES ($1,$2,'Second Example LLC','llc','USD')", [otherEntity, fixture.organizationId]);
    const admin = await principalFor();
    const period = { mode: "as_of", asOfDate: "2026-08-31" };
    const rentRoll = (legalEntityIds: string[], propertyIds: string[] = [], reportId = "rent-roll") => port.run({ principal: admin }, reportRunRequestSchema.parse({ reportId, definitionVersion: "1", scope: { organizationId: fixture.organizationId, legalEntityIds, propertyIds }, filters: { propertyScope: "all" }, period, basis: "operational", currency: null }));
    const lender = async (legalEntityIds: string[]) => {
      const run = await port.run({ principal: admin }, reportRunRequestSchema.parse({ reportId: "lender-management-package", definitionVersion: "1", scope: { organizationId: fixture.organizationId, legalEntityIds, propertyIds: [] }, filters: {}, period: { mode: "custom", fromDate: "2026-08-01", toDate: "2026-08-31" }, basis: "mixed", currency: null }));
      return run.page.rows.find(row => row.rowId === "lender-package:rent_roll")!.values;
    };
    // A property-limited run is not the entity section.
    await rentRoll([fixture.entityId], [], "delinquency");
    await rentRoll([fixture.entityId], [fixture.propertyId]);
    await rentRoll([otherEntity]);
    const propertyOnly = await lender([fixture.entityId]);
    assert.equal(propertyOnly.state, "unavailable");
    assert.match(String(propertyOnly.reason), /saved only for selected properties/);
    // Two single-entity runs do not make one package section for both entities.
    const first = await rentRoll([fixture.entityId]);
    const split = await lender([fixture.entityId, otherEntity]);
    assert.equal(split.state, "partial");
    assert.equal(split.reason, "No single Rent roll run covers every selected entity.");
    // The section links the run that covers both entities.
    const both = await rentRoll([fixture.entityId, otherEntity]);
    const covered = await lender([fixture.entityId, otherEntity]);
    assert.notEqual(covered.reason, "No single Rent roll run covers every selected entity.");
    assert.equal(covered.state, reportRunCompleteness(both.run) === "complete" ? "ready" : "partial");
    if (covered.state === "partial") assert.equal(covered.reason, "Rent roll has incomplete source coverage.");
    assert.notEqual(both.run.id, first.run.id);
  } finally { await database.close(); }
});
