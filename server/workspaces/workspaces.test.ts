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
import { registerWorkspaceRoutes } from "./routes";
import { propertyReportFilters } from "./property-financials";

const MONTH = "2026-08";
const AS_OF = "2026-08-15";

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
  const app = express();
  registerWorkspaceRoutes(app, { executor, requireAdmin, today: () => AS_OF });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const get = (path: string, actor?: string) => fetch(`${origin}${path}`, { headers: actor ? { "x-test-actor": actor } : {} });
  const service = new RentOpsService(new PostgresRentOpsRepository(executor));
  return {
    db: database.db, executor, get, service,
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
    await context.db.query(`INSERT INTO company_project_posted_actuals (id, organization_id, project_id, provider, source_scope, external_id, description, amount_cents, currency, posted_on)
      VALUES ($1,$2,$3,'qbo','synthetic-realm','Bill-1:1','Roofing deposit', 9007199254740993, 'USD', '2026-08-10')`, [randomUUID(), company.organizationId, projectId]);

    const response = await context.get(`/api/workspaces/properties/${company.propertyId}/financials?month=${MONTH}&asOf=${AS_OF}&company=${company.organizationId}`);
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
    assert.equal(spending.amountCents, "9007199254740993", "posted project cost keeps exact bigint cents");
    assert.deepEqual(spending.records[0].link, { kind: "project", id: projectId });
    assert.ok(spending.records[0].sourceReferences[0].startsWith("QBO "), "QBO identity only in record detail");
    assert.equal(measure(body.measures, "project_costs_recorded").amountCents, "0");
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
