import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import type { User } from "../../shared/schema";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY as company } from "../company/testing/synthetic-database";
import { seedRentalDemo } from "../company/testing/seed-rental-demo";
import { seedWorkOrderDemo } from "../company/testing/seed-work-orders";
import { createWorkOrderPort } from "../work-orders/port";
import { PostgresRentOpsRepository } from "../rent-ops/repositories/postgres";
import { RentOpsService } from "../rent-ops/services/service";
import { propertyFinancialsSchema, propertyPerformanceSchema, entityDirectorySchema, peopleDirectorySchema, companySettingsSchema, costLibrarySchema, dashboardCompanySchema, propertyDocumentsSchema, type FinancialMeasure } from "../../shared/workspaces/contracts";
import type { ProjectFinanceActual, ProjectFinanceCoverage, ProjectFinanceReadPort } from "../../shared/projects";
import { registerWorkspaceRoutes } from "./routes";
import { propertyReportFilters } from "./property-financials";

const MONTH = "2026-08";
const AS_OF = "2026-08-15";

/** A project finance read port the test controls: coverage and bound QuickBooks lines per project. */
function fakeFinance() {
  const state: { coverage: ProjectFinanceCoverage; actuals: ProjectFinanceActual[]; byProject: Map<string, ProjectFinanceCoverage> } = { coverage: "complete", actuals: [], byProject: new Map() };
  const port: ProjectFinanceReadPort = {
    async getProjectActuals(input) {
      const coverage = state.byProject.get(input.projectId) ?? state.coverage;
      if (coverage === "unavailable") return { coverage, actuals: [] };
      return { coverage, actuals: state.actuals.filter(actual => actual.projectId === input.projectId && (!input.asOf || actual.postedOn <= input.asOf)) };
    },
  };
  return { state, port };
}

const qboActual = (projectId: string, amountCents: string, postedOn: string, objectId: string): ProjectFinanceActual => ({
  id: randomUUID() as ProjectFinanceActual["id"], projectId: projectId as ProjectFinanceActual["projectId"], commitmentId: null, scopeItemId: null,
  source: { provider: "qbo", organizationId: company.organizationId as never, legalEntityId: company.entityId as never, environment: "sandbox", realmId: "9130000000000001", objectType: "Bill", objectId, lineId: "1", version: "0" },
  description: `Synthetic bill ${objectId}`, amountCents: amountCents as ProjectFinanceActual["amountCents"], currency: "USD" as ProjectFinanceActual["currency"],
  postedOn: postedOn as ProjectFinanceActual["postedOn"], sourceRevision: "0",
});

async function fixture() {
  const database = await createSyntheticCompanyDatabase();
  await seedRentalDemo({ executor: database.executor, actorId: company.actorId, actorRole: "owner" });
  const executor = await createSyntheticRuntimeExecutor(database.db);
  await seedWorkOrderDemo(executor, createWorkOrderPort(executor));
  // The session middleware owns the actor; tests pick it with a header.
  const requireAdmin: RequestHandler = (req, _res, next) => {
    req.rentOpsAdminUser = { id: req.get("x-test-actor") ?? company.actorId, role: "admin", email: "synthetic@example.test" } as User;
    next();
  };
  const finance = fakeFinance();
  const app = express();
  registerWorkspaceRoutes(app, { executor, requireAdmin, today: () => AS_OF, projectFinanceFactory: () => finance.port });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const get = (path: string, actor?: string) => fetch(`${origin}${path}`, { headers: actor ? { "x-test-actor": actor } : {} });
  const service = new RentOpsService(new PostgresRentOpsRepository(executor));
  return {
    db: database.db, executor, get, service, finance: finance.state,
    close: async () => { await new Promise<void>(resolve => listener.close(() => resolve())); await database.close(); },
  };
}

const measure = (measures: readonly FinancialMeasure[], key: FinancialMeasure["key"]) => {
  const found = measures.find(item => item.key === key);
  assert.ok(found, `measure ${key}`);
  return found;
};
const sumCents = (rows: readonly unknown[], read: (row: Record<string, unknown>) => unknown) =>
  rows.reduce<bigint>((total, row) => { const value = read(row as Record<string, unknown>); return typeof value === "number" ? total + BigInt(value) : total; }, BigInt(0)).toString();

test("property financials equal the report totals for the same property and period", async () => {
  const context = await fixture();
  try {
    const response = await context.get(`/api/workspaces/properties/${company.propertyId}/financials?month=${MONTH}&asOf=${AS_OF}`);
    assert.equal(response.status, 200, await response.clone().text());
    const body = propertyFinancialsSchema.parse(await response.json());
    const { monthly, asOf } = propertyReportFilters(company.propertyId, MONTH, AS_OF);

    const scheduled = await context.service.report("scheduled-income", monthly) as Array<Record<string, unknown>>;
    assert.equal(measure(body.measures, "scheduled_rent").amountCents, sumCents(scheduled.filter(row => row.category === "base_rent"), row => row.amountCents));
    assert.equal(measure(body.measures, "scheduled_other_charges").amountCents, sumCents(scheduled.filter(row => row.category !== "base_rent"), row => row.amountCents));

    const collected = await context.service.report("collected-income", monthly) as Array<Record<string, unknown>>;
    const collections = ["tenant_collections", "subsidy_collections", "other_collections"] as const;
    const collectionTotal = collections.reduce((total, key) => total + BigInt(measure(body.measures, key).amountCents ?? "0"), BigInt(0));
    assert.equal(collectionTotal.toString(), sumCents(collected, row => row.amountCents), "tenant + subsidy + other receipts conserve collected income");
    assert.notEqual(measure(body.measures, "subsidy_collections").amountCents, "0", "agency receipts are shown separately from tenant receipts");

    const delinquency = await context.service.report("delinquency", asOf) as Array<Record<string, unknown>>;
    assert.equal(measure(body.measures, "arrears").amountCents, sumCents(delinquency.filter(row => typeof row.operationalBalanceCents !== "number" || row.operationalBalanceCents > 0), row => row.operationalBalanceCents));

    const deposits = await context.service.report("security-deposit", asOf) as Array<Record<string, unknown>>;
    assert.equal(measure(body.measures, "deposits_held").amountCents, sumCents(deposits, row => row.totalHeldCents));

    // Without a company, manager and project figures are unavailable — never zero.
    for (const key of ["pm_fees", "owner_remittances", "project_spending_posted"] as const) {
      const value = measure(body.measures, key);
      assert.equal(value.state, "unavailable"); assert.equal(value.amountCents, null); assert.ok(value.unavailableReason);
    }
    assert.ok(body.measures.every(item => !/income/i.test(item.label)), "no measure is labelled income");
    assert.equal((await context.get(`/api/workspaces/properties/missing-property/financials?month=${MONTH}`)).status, 404);
    assert.equal((await context.get(`/api/workspaces/properties/${company.propertyId}/financials?month=2026-13`)).status, 400);
  } finally { await context.close(); }
});

test("company measures keep PM collections, fees, remittances and project spending distinct and exact", async () => {
  const context = await fixture();
  try {
    const settlementId = randomUUID();
    await context.db.query(`INSERT INTO accounting_pm_settlements (id, organization_id, legal_entity_id, property_id, manager_name, period_start, period_end, currency,
        opening_held_cents, gross_collections_cents, pm_fees_cents, pm_expenses_cents, other_deductions_cents, owner_remittance_cents, closing_held_cents,
        qbo_references, state, bank_settled_on, source_fingerprint)
      VALUES ($1,$2,$3,$4,'Example Management','2026-08-01','2026-08-31','USD', 5000, 100000, 8000, 2000, 0, 90000, 5000, '["JournalEntry 77"]'::jsonb, 'reconciled', '2026-09-02', $5)`,
      [settlementId, company.organizationId, company.entityId, company.propertyId, "a".repeat(64)]);
    const projectId = randomUUID();
    await context.db.query(`INSERT INTO company_projects (id, organization_id, legal_entity_id, property_id, name, project_type, status, currency)
      VALUES ($1,$2,$3,$4,'Synthetic roof','rehab','active','USD')`, [projectId, company.organizationId, company.entityId, company.propertyId]);
    // A legacy importer row is not a posting: only bound QuickBooks lines through the finance port count.
    await context.db.query(`INSERT INTO company_project_posted_actuals (id, organization_id, project_id, provider, source_scope, external_id, description, amount_cents, currency, posted_on)
      VALUES ($1,$2,$3,'qbo','synthetic-realm','Bill-0:1','Legacy import', 777, 'USD', '2026-08-10')`, [randomUUID(), company.organizationId, projectId]);
    context.finance.actuals.push(
      qboActual(projectId, "9007199254740993", "2026-08-10", "Bill-1"),
      qboActual(projectId, "4000", "2026-07-31", "Bill-2"),
      qboActual(projectId, "5000", "2026-08-20", "Bill-3"),
    );
    // Draft costs: a user cost counts; a cost-to-complete override (reserved vendor) is forecasting input, not a cost.
    await context.db.query(`INSERT INTO company_project_draft_costs (id, organization_id, project_id, vendor_name, description, amount_cents, currency, incurred_on)
      VALUES ($1,$2,$3,NULL,'Dumpster',1500,'USD','2026-08-05'), ($4,$2,$3,'system:etc_override','Remaining roof work',999900,'USD','2026-08-06')`,
      [randomUUID(), company.organizationId, projectId, randomUUID()]);

    const path = `/api/workspaces/properties/${company.propertyId}/financials?month=${MONTH}&asOf=${AS_OF}&company=${company.organizationId}`;
    const response = await context.get(path);
    assert.equal(response.status, 200, await response.clone().text());
    const body = propertyFinancialsSchema.parse(await response.json());
    assert.equal(body.company?.legalEntityId, company.entityId);
    assert.equal(measure(body.measures, "pm_gross_collections").amountCents, "100000");
    assert.equal(measure(body.measures, "pm_fees").amountCents, "8000");
    assert.equal(measure(body.measures, "pm_expenses").amountCents, "2000");
    assert.equal(measure(body.measures, "owner_remittances").amountCents, "90000");
    assert.equal(measure(body.measures, "manager_held_funds").amountCents, "5000");
    const gross = BigInt(measure(body.measures, "pm_gross_collections").amountCents!);
    const deducted = ["pm_fees", "pm_expenses", "owner_remittances"].reduce((total, key) => total + BigInt(measure(body.measures, key as FinancialMeasure["key"]).amountCents!), BigInt(0));
    assert.equal(BigInt(5000) + gross - deducted, BigInt(measure(body.measures, "manager_held_funds").amountCents!), "opening + gross − deductions − remittance = closing held");
    const spending = measure(body.measures, "project_spending_posted");
    assert.equal(spending.amountCents, "9007199254740993", "only bound lines posted in the month up to the as-of date, in exact bigint cents");
    assert.equal(spending.complete, true);
    assert.equal(spending.recordCount, 1);
    assert.deepEqual(spending.records[0].link, { kind: "project", id: projectId });
    assert.ok(spending.records[0].sourceReferences[0].startsWith("QBO "), "QBO identity only in record detail");
    const recorded = measure(body.measures, "project_costs_recorded");
    assert.equal(recorded.amountCents, "1500", "cost-to-complete overrides are not unposted project costs");
    assert.equal(recorded.recordCount, 1);

    // Partial QuickBooks coverage is a minimum, never a complete total.
    context.finance.coverage = "partial";
    const partial = measure(propertyFinancialsSchema.parse(await (await context.get(path)).json()).measures, "project_spending_posted");
    assert.equal(partial.state, "available");
    assert.equal(partial.amountCents, "9007199254740993");
    assert.equal(partial.complete, false);
    // One project unreadable and another complete is still partial.
    const second = randomUUID();
    await context.db.query(`INSERT INTO company_projects (id, organization_id, legal_entity_id, property_id, name, project_type, status, currency)
      VALUES ($1,$2,$3,$4,'Synthetic siding','rehab','active','USD')`, [second, company.organizationId, company.entityId, company.propertyId]);
    context.finance.coverage = "complete";
    context.finance.byProject.set(second, "unavailable");
    const mixed = measure(propertyFinancialsSchema.parse(await (await context.get(path)).json()).measures, "project_spending_posted");
    assert.equal(mixed.complete, false, "an unreadable project makes the total a minimum");
    // Nothing readable: unknown, never zero.
    context.finance.coverage = "unavailable";
    const none = measure(propertyFinancialsSchema.parse(await (await context.get(path)).json()).measures, "project_spending_posted");
    assert.equal(none.state, "unavailable");
    assert.equal(none.amountCents, null);
    assert.ok(none.unavailableReason);
  } finally { await context.close(); }
});

test("company reads are denied without a grant and narrowed by property grants", async () => {
  const context = await fixture();
  try {
    const outsider = "outsider-actor";
    for (const path of [
      `/api/company/${company.organizationId}/workspaces/entities`,
      `/api/company/${company.organizationId}/workspaces/settings`,
      `/api/company/${company.organizationId}/workspaces/dashboard`,
      `/api/workspaces/property-performance?company=${company.organizationId}`,
      `/api/workspaces/properties/${company.propertyId}/financials?company=${company.organizationId}`,
    ]) assert.equal((await context.get(path, outsider)).status, 403, path);

    const restricted = "property-b-reader";
    await context.db.query("INSERT INTO company_access_grants(id,organization_id,actor_id,role,legal_entity_id,property_id) VALUES ($1,$2,$3,'admin',$4,'demo-property-b')",
      [randomUUID(), company.organizationId, restricted, company.entityId]);
    const financials = propertyFinancialsSchema.parse(await (await context.get(`/api/workspaces/properties/${company.propertyId}/financials?month=${MONTH}&company=${company.organizationId}`, restricted)).json());
    assert.equal(measure(financials.measures, "pm_fees").state, "unavailable", "a property-b grant cannot read property-a manager figures");
    const performance = propertyPerformanceSchema.parse(await (await context.get(`/api/workspaces/property-performance?month=${MONTH}&asOf=${AS_OF}&company=${company.organizationId}`, restricted)).json());
    assert.equal(performance.rows.find(row => row.propertyId === company.propertyId)?.openWorkOrders, null);
    assert.equal(typeof performance.rows.find(row => row.propertyId === "demo-property-b")?.openWorkOrders, "number");
    const settings = companySettingsSchema.parse(await (await context.get(`/api/company/${company.organizationId}/workspaces/settings`, restricted)).json());
    assert.deepEqual(settings.grants, [], "access lists are limited to organization-wide readers");
    const entities = entityDirectorySchema.parse(await (await context.get(`/api/company/${company.organizationId}/workspaces/entities`, restricted)).json());
    assert.deepEqual(entities.entities, [], "a property grant does not expose the whole entity");

    await context.db.query("UPDATE company_access_grants SET revoked_at = now() WHERE actor_id = $1", [restricted]);
    assert.equal((await context.get(`/api/company/${company.organizationId}/workspaces/dashboard`, restricted)).status, 403, "revoked grants stop reading");
  } finally { await context.close(); }
});

test("property financials omit PM statements and draft costs of an entity the reader's grant does not cover", async () => {
  const context = await fixture();
  try {
    const formerEntityId = "20000000-0000-4000-8000-000000000002";
    await context.db.query("INSERT INTO company_legal_entities(id,organization_id,name,entity_type,currency) VALUES ($1,$2,'Former Owner LLC','llc','USD')", [formerEntityId, company.organizationId]);
    await context.db.query("INSERT INTO company_property_entity_periods(id,organization_id,legal_entity_id,property_id,effective_from,effective_until) VALUES ($1,$2,$3,$4,'2019-01-01','2020-01-01')",
      [randomUUID(), company.organizationId, formerEntityId, company.propertyId]);
    await context.db.query(`INSERT INTO accounting_pm_settlements (id, organization_id, legal_entity_id, property_id, manager_name, period_start, period_end, currency,
        opening_held_cents, gross_collections_cents, pm_fees_cents, pm_expenses_cents, other_deductions_cents, owner_remittance_cents, closing_held_cents,
        qbo_references, state, bank_settled_on, source_fingerprint)
      VALUES ($1,$2,$3,$4,'Former Management','2026-08-01','2026-08-31','USD', 0, 1000, 80, 20, 0, 900, 0, '[]'::jsonb, 'reconciled', '2026-09-02', $5)`,
      [randomUUID(), company.organizationId, formerEntityId, company.propertyId, "b".repeat(64)]);
    const formerProject = randomUUID();
    await context.db.query(`INSERT INTO company_projects (id, organization_id, legal_entity_id, property_id, name, project_type, status, currency)
      VALUES ($1,$2,$3,$4,'Former owner roof','rehab','active','USD')`, [formerProject, company.organizationId, formerEntityId, company.propertyId]);
    await context.db.query(`INSERT INTO company_project_draft_costs (id, organization_id, project_id, vendor_name, description, amount_cents, currency, incurred_on)
      VALUES ($1,$2,$3,NULL,'Former owner dumpster',4400,'USD','2026-08-05')`, [randomUUID(), company.organizationId, formerProject]);
    const reader = "property-a-reader";
    await context.db.query("INSERT INTO company_access_grants(id,organization_id,actor_id,role,legal_entity_id,property_id) VALUES ($1,$2,$3,'admin',$4,$5)",
      [randomUUID(), company.organizationId, reader, company.entityId, company.propertyId]);
    const path = `/api/workspaces/properties/${company.propertyId}/financials?month=${MONTH}&asOf=${AS_OF}&company=${company.organizationId}`;
    const scoped = propertyFinancialsSchema.parse(await (await context.get(path, reader)).json());
    assert.equal(scoped.company?.legalEntityId, company.entityId);
    assert.equal(measure(scoped.measures, "pm_fees").state, "unavailable", "the former owner's PM statement is not the reader's");
    assert.equal(measure(scoped.measures, "project_costs_recorded").recordCount, 0);
    const orgWide = propertyFinancialsSchema.parse(await (await context.get(path)).json());
    assert.equal(measure(orgWide.measures, "project_costs_recorded").amountCents, "4400", "an organization-wide reader still sees every entity's rows");
  } finally { await context.close(); }
});

test("property performance uses report derivations and marks unmapped company figures unknown", async () => {
  const context = await fixture();
  try {
    const rental = propertyPerformanceSchema.parse(await (await context.get(`/api/workspaces/property-performance?month=${MONTH}&asOf=${AS_OF}&scope=all`)).json());
    assert.equal(rental.companyAvailable, false);
    const row = rental.rows.find(item => item.propertyId === company.propertyId)!;
    assert.equal(row.openWorkOrders, null, "company counts are unknown without a company");
    const { monthly } = propertyReportFilters(company.propertyId, MONTH, AS_OF);
    const collected = await context.service.report("collected-income", monthly) as Array<Record<string, unknown>>;
    assert.equal(row.collectedCents, sumCents(collected, item => item.amountCents));
    const withCompany = propertyPerformanceSchema.parse(await (await context.get(`/api/workspaces/property-performance?month=${MONTH}&asOf=${AS_OF}&scope=all&company=${company.organizationId}`)).json());
    const mapped = withCompany.rows.find(item => item.propertyId === company.propertyId)!;
    const open = await context.db.query<{ count: number }>("SELECT count(*)::int AS count FROM company_work_orders WHERE property_id = $1 AND status NOT IN ('completed','canceled')", [company.propertyId]);
    assert.ok(open.rows[0].count > 0);
    assert.equal(mapped.openWorkOrders, open.rows[0].count);
    assert.equal(mapped.legalEntityName, "Example Property LLC");
    assert.equal(mapped.projectPostedCents, "0"); assert.equal(mapped.projectPostedComplete, true, "no projects: nothing posted, exactly");

    // Posted project costs come from the finance port (not the legacy importer table), up to the as-of date.
    const projectId = randomUUID();
    await context.db.query(`INSERT INTO company_projects (id, organization_id, legal_entity_id, property_id, name, project_type, status, currency)
      VALUES ($1,$2,$3,$4,'Synthetic boiler','rehab','active','USD')`, [projectId, company.organizationId, company.entityId, company.propertyId]);
    await context.db.query(`INSERT INTO company_project_posted_actuals (id, organization_id, project_id, provider, source_scope, external_id, description, amount_cents, currency, posted_on)
      VALUES ($1,$2,$3,'qbo','synthetic-realm','Bill-0:1','Legacy import', 777, 'USD', '2026-08-01')`, [randomUUID(), company.organizationId, projectId]);
    context.finance.actuals.push(qboActual(projectId, "12500", "2026-06-30", "Bill-9"), qboActual(projectId, "100", "2026-09-01", "Bill-10"));
    const performancePath = `/api/workspaces/property-performance?month=${MONTH}&asOf=${AS_OF}&scope=all&company=${company.organizationId}`;
    const posted = propertyPerformanceSchema.parse(await (await context.get(performancePath)).json()).rows.find(item => item.propertyId === company.propertyId)!;
    assert.equal(posted.projectPostedCents, "12500"); assert.equal(posted.projectPostedComplete, true);
    context.finance.coverage = "partial";
    const partial = propertyPerformanceSchema.parse(await (await context.get(performancePath)).json()).rows.find(item => item.propertyId === company.propertyId)!;
    assert.equal(partial.projectPostedCents, "12500"); assert.equal(partial.projectPostedComplete, false, "partial coverage is a minimum");
    context.finance.coverage = "unavailable";
    const unknown = propertyPerformanceSchema.parse(await (await context.get(performancePath)).json()).rows.find(item => item.propertyId === company.propertyId)!;
    assert.equal(unknown.projectPostedCents, null, "unavailable QuickBooks postings are unknown, never zero");
    assert.equal((await context.get(`/api/workspaces/property-performance?scope=everything`)).status, 400);
  } finally { await context.close(); }
});

test("directory, settings, documents, cost library and dashboard reads are bounded and exact", async () => {
  const context = await fixture();
  try {
    const base = `/api/company/${company.organizationId}/workspaces`;
    const entities = entityDirectorySchema.parse(await (await context.get(`${base}/entities`)).json());
    assert.equal(entities.entities[0].id, company.entityId);
    assert.ok(entities.entities[0].properties.some(item => item.propertyId === company.propertyId && item.current));
    assert.deepEqual(entities.entities[0].qbo, [], "no connection is reported as none, not connected");

    for (let index = 0; index < 3; index += 1) {
      const contactId = randomUUID();
      await context.db.query("INSERT INTO company_contacts(id,organization_id,kind,display_name) VALUES ($1,$2,'organization',$3)", [contactId, company.organizationId, `Vendor ${index}`]);
      await context.db.query("INSERT INTO company_contact_roles(id,organization_id,contact_id,legal_entity_id,role,effective_from) VALUES ($1,$2,$3,$4,'vendor','2026-01-01')", [randomUUID(), company.organizationId, contactId, company.entityId]);
    }
    const first = peopleDirectorySchema.parse(await (await context.get(`${base}/people?limit=2&role=vendor`)).json());
    assert.equal(first.contacts.length, 2); assert.ok(first.nextCursor);
    const second = peopleDirectorySchema.parse(await (await context.get(`${base}/people?limit=2&role=vendor&cursor=${encodeURIComponent(first.nextCursor!)}`)).json());
    assert.deepEqual(second.contacts.map(item => item.displayName), ["Vendor 2"]); assert.equal(second.nextCursor, null);
    assert.equal((await context.get(`${base}/people?cursor=not-a-cursor`)).status, 400);
    assert.equal((await context.get(`${base}/people?limit=500`)).status, 400);

    const settings = companySettingsSchema.parse(await (await context.get(`${base}/settings`)).json());
    assert.ok(settings.grants.some(grant => grant.actorId === company.actorId));
    assert.ok(!JSON.stringify(settings).includes("token"), "no credential material");

    const templateId = randomUUID();
    await context.db.query("INSERT INTO company_project_templates(id,organization_id,name,project_type,currency,created_by) VALUES ($1,$2,'Unit turn','unit_turn','USD','demo-admin')", [templateId, company.organizationId]);
    await context.db.query("INSERT INTO company_project_template_scope_items(id,organization_id,template_id,description,category,unit_label,quantity,rate_cents,position) VALUES ($1,$2,$3,'Interior paint','finishes','sq ft',1.125,275,0)", [randomUUID(), company.organizationId, templateId]);
    const library = costLibrarySchema.parse(await (await context.get(`${base}/cost-library?search=paint`)).json());
    assert.equal(library.items.length, 1);
    assert.equal(library.items[0].quantity, "1.125000000000"); assert.equal(library.items[0].rateCents, "275");

    const documents = propertyDocumentsSchema.parse(await (await context.get(`${base}/property-documents`)).json());
    assert.deepEqual(documents.documents, []);

    const account = await context.db.query<{ id: string }>("INSERT INTO company_contacts(id,organization_id,kind,display_name) VALUES ($1,$2,'person','Synthetic Investor') RETURNING id", [randomUUID(), company.organizationId]);
    void account;
    const dashboard = dashboardCompanySchema.parse(await (await context.get(`${base}/dashboard?asOf=2026-09-20`)).json());
    assert.equal(dashboard.reviewCases.available, true);
    assert.equal(dashboard.reviewCases.openCount, 0);
    assert.ok(dashboard.workDue.items.some(item => item.title.includes("No heat")), "unscheduled emergency work is due");
    assert.ok(dashboard.workDue.items.every(item => item.status !== "completed"));
  } finally { await context.close(); }
});

test("Codex tools read the same workspace service and grants as the browser", async () => {
  const context = await fixture();
  try {
    const { registerWorkspaceMcpTools } = await import("./mcp");
    const { createWorkspaceReadPort } = await import("./port");
    const tools = new Map<string, { write: boolean; handler: (args: any) => Promise<unknown> }>();
    const port = createWorkspaceReadPort(context.executor, { today: () => AS_OF });
    registerWorkspaceMcpTools((name, _description, _schema, write, handler) => { tools.set(name, { write, handler }); }, { port, actorId: company.actorId });
    assert.ok([...tools.values()].every(tool => tool.write === false), "workspace tools are read-only");
    const viaTool = propertyFinancialsSchema.parse(await tools.get("get_property_financials")!.handler({ propertyId: company.propertyId, organizationId: company.organizationId, month: MONTH, asOf: AS_OF }));
    const viaHttp = propertyFinancialsSchema.parse(await (await context.get(`/api/workspaces/properties/${company.propertyId}/financials?month=${MONTH}&asOf=${AS_OF}&company=${company.organizationId}`)).json());
    assert.deepEqual(viaTool, viaHttp, "the tool and the page read identical figures");
    const outsider = new Map<string, (args: any) => Promise<unknown>>();
    registerWorkspaceMcpTools((name, _description, _schema, _write, handler) => { outsider.set(name, handler); }, { port, actorId: "outsider-actor" });
    await assert.rejects(outsider.get("get_dashboard_company_summary")!({ organizationId: company.organizationId }), /grant/i);
  } finally { await context.close(); }
});
