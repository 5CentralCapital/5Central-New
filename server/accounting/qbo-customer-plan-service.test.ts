import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createCompanyDemoApp } from "../company/demo";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { createQboAccountingMirrorStore } from "./mirror-store";
import { readQboCustomerPlan } from "./qbo-customer-plan-service";
import { registerAccountingMcpTools } from "./mcp";
import type { QboCustomerPlan } from "./qbo-customer-plan";
import { CustomerPlanCliError, parseCustomerPlanArgs, runCustomerPlanCli } from "../../scripts/company/qbo-customer-plan";

const { organizationId, entityId: ENTITY_A, propertyId, unitId } = SYNTHETIC_COMPANY;
const ENTITY_B = "20000000-0000-4000-8000-000000000002";
const REALM = "4620816365000001";
const scope = { organizationId, legalEntityId: ENTITY_A, environment: "production" as const, realmId: REALM };
const AT = "2026-09-20T12:00:00.000Z";

async function fixture() {
  const synthetic = await createSyntheticCompanyDatabase();
  const db = synthetic.db;
  await db.exec(`
    INSERT INTO company_legal_entities(id,organization_id,name,entity_type,currency) VALUES ('${ENTITY_B}','${organizationId}','Second Example LLC','llc','USD');
    INSERT INTO accounting_qbo_realm_bindings(organization_id,legal_entity_id,environment,realm_id,provider_company_id,provider_company_name,evidence_version,company_info_hash,confirmed_by)
      VALUES ('${organizationId}','${ENTITY_A}','production','${REALM}','1','Example Property LLC','0','${"a".repeat(64)}','demo-admin');
    -- Sandbox binding for entity B does not connect it in production.
    INSERT INTO accounting_qbo_realm_bindings(organization_id,legal_entity_id,environment,realm_id,provider_company_id,provider_company_name,evidence_version,company_info_hash,confirmed_by)
      VALUES ('${organizationId}','${ENTITY_B}','sandbox','999','1','Sandbox','0','${"b".repeat(64)}','demo-admin');
    INSERT INTO rent_ops_properties(id,name,slug) VALUES ('prop-sold','Birch: Row','birch-row'),('prop-b','Cedar Flats','cedar-flats'),('prop-none','Unowned House','unowned-house');
    INSERT INTO rent_ops_units(id,property_id,unit_number) VALUES ('u-3','${propertyId}','3'),('u-4','${propertyId}','4'),('u-5','${propertyId}','5'),('u-9','${propertyId}','9'),('unit-sold','prop-sold','2'),('unit-b','prop-b','3C'),('unit-none','prop-none','1');
    INSERT INTO company_property_entity_periods(id,organization_id,legal_entity_id,property_id,effective_from,effective_until) VALUES
      ('30000000-0000-4000-8000-000000000002','${organizationId}','${ENTITY_B}','prop-sold','2020-01-01','2025-06-01'),
      ('30000000-0000-4000-8000-000000000003','${organizationId}','${ENTITY_A}','prop-sold','2025-06-01',NULL),
      ('30000000-0000-4000-8000-000000000004','${organizationId}','${ENTITY_B}','prop-b','2020-01-01',NULL);
    INSERT INTO rent_ops_people(id,first_name,last_name) VALUES
      ('p-1','Ada','Current'),('p-2','Former','Resident'),('p-3','Linked','Tenant'),('p-4','Match','Person'),('p-5','Clash','Vendor'),
      ('p-6','Span','Owners'),('p-7','Blocked','Tenant'),('p-8','Nobody','Owns'),('p-9','Maximiliana Alexandrina','Bartholomew-Featherstonehaugh of the Extraordinarily Long Garden Apartments');
  `);
  const tenancies: [string, string, string, string, string, string | null, string | null][] = [
    ["t-1", propertyId, unitId, "p-1", "current", "2024-01-01", null],
    ["t-2", propertyId, unitId, "p-2", "past", "2021-01-01", "2023-12-31"],
    ["t-3", propertyId, "u-3", "p-3", "current", "2024-01-01", null],
    ["t-4", propertyId, "u-4", "p-4", "current", "2024-01-01", null],
    ["t-5", propertyId, "u-5", "p-5", "current", "2024-01-01", null],
    ["t-6", "prop-sold", "unit-sold", "p-6", "current", "2024-03-01", null],
    ["t-7", "prop-b", "unit-b", "p-7", "current", "2024-01-01", null],
    ["t-8", "prop-none", "unit-none", "p-8", "current", "2024-01-01", null],
    ["t-9", propertyId, "u-9", "p-9", "notice", "2024-01-01", null],
  ];
  const executor = await createSyntheticRuntimeExecutor(db);
  // Rent Manager source ids are established only by the importer role.
  await db.transaction(async tx => {
    await tx.exec('SET LOCAL ROLE "rent_ops_staging_importer"');
    for (const [id, property, unit, person, status, moveIn, moveOut] of tenancies) {
      await tx.query(
      `INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,actual_move_in_on,actual_move_out_on,source_system,source_id,created_at,property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge,status_knowledge)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'rent_manager',$8,NOW(),'manual','manual','manual','manual')`,
      [id, property, unit, person, status, moveIn, moveOut, `90${id.slice(2)}`],
      );
    }
  });
  await db.query(
    "INSERT INTO company_external_identities (id, organization_id, legal_entity_id, provider, source_scope, record_kind, external_id, local_kind, local_id) VALUES ('50000000-0000-4000-8000-000000000003',$1,$2,'qbo',$3,'Customer','57','tenancy','t-3')",
    [organizationId, ENTITY_A, `qbo:production:${REALM}`],
  );
  return { synthetic, executor, close: () => synthetic.close() };
}

async function mirrorNames(executor: Awaited<ReturnType<typeof fixture>>["executor"]) {
  const mirror = createQboAccountingMirrorStore(executor);
  const names: [string, string, Record<string, unknown>][] = [
    ["Customer", "57", { DisplayName: "Linked Tenant (renamed in QuickBooks)" }],
    ["Customer", "58", { DisplayName: " match person · demo property a 4 · rm904 " }],
    ["Vendor", "70", { DisplayName: "Clash Vendor · Demo property A 5 · RM905" }],
    ["Employee", "80", { GivenName: "Office", FamilyName: "Worker" }],
  ];
  for (const [objectType, objectId, body] of names) {
    await mirror.ingestSourceObject({ scope, objectType, objectId, version: "0", providerUpdatedAt: AT, providerBody: { Id: objectId, SyncToken: "0", Active: true, ...body }, receivedAt: AT });
  }
  await mirror.recordCoverage({
    scope, stream: "customers", status: "complete", evidence: "live_provider_readback", basis: "source_transactions", watermark: null,
    coveredFrom: null, coveredThrough: null, observedAt: AT, objectCount: 2, transactionCount: 0, lineCount: 0, reason: null,
  });
}

const row = (plan: QboCustomerPlan, tenancyId: string) => plan.entities.flatMap(group => group.rows).find(item => item.tenancyId === tenancyId)!;

test("the service plans customers from tenancies, entity periods, realm bindings, links and the QuickBooks mirror", async () => {
  const h = await fixture();
  try {
    const unread = await h.executor.transaction!(tx => readQboCustomerPlan(tx, { organizationId, environment: "production", asOf: "2026-09-23" }), { readOnly: true });
    assert.equal(row(unread, "t-1").status, "blocked_mirror_not_read", "no customer mirror: names cannot be checked");

    await mirrorNames(h.executor);
    const plan = await h.executor.transaction!(tx => readQboCustomerPlan(tx, { organizationId, environment: "production", asOf: "2026-09-23" }), { readOnly: true });
    assert.deepEqual(row(plan, "t-1").proposed, { displayName: "Ada Current · Demo property A 1A · RM901", active: true, truncated: false });
    assert.equal(row(plan, "t-1").status, "create");
    assert.deepEqual([row(plan, "t-2").status, row(plan, "t-2").proposed?.active], ["create", false]);
    assert.deepEqual([row(plan, "t-3").status, row(plan, "t-3").linkedCustomerId], ["linked", "57"]);
    assert.deepEqual([row(plan, "t-4").status, row(plan, "t-4").conflict?.objectId], ["review_possible_match", "58"]);
    assert.deepEqual([row(plan, "t-5").status, row(plan, "t-5").conflict?.objectType], ["review_name_collision", "Vendor"]);
    assert.deepEqual([row(plan, "t-6").status, row(plan, "t-6").legalEntityId, row(plan, "t-6").ownerEntityIds], ["review_ownership_change", ENTITY_A, [ENTITY_B, ENTITY_A]]);
    assert.equal(row(plan, "t-6").proposed?.displayName, "Span Owners · Birch Row 2 · RM906", "colon removed from the property name");
    assert.deepEqual([row(plan, "t-7").status, row(plan, "t-7").legalEntityId], ["blocked_not_connected", ENTITY_B]);
    assert.deepEqual([row(plan, "t-8").status, row(plan, "t-8").legalEntityId], ["blocked_no_entity", null]);
    const long = row(plan, "t-9").proposed!;
    assert.equal(long.truncated, true);
    assert.ok(long.displayName.length <= 100 && long.displayName.endsWith(" · RM909"), long.displayName);

    const groupA = plan.entities.find(group => group.legalEntityId === ENTITY_A)!;
    assert.deepEqual([groupA.legalEntityName, groupA.realmId, groupA.connected, groupA.mirrorRead], ["Example Property LLC", REALM, true, true]);
    assert.deepEqual([groupA.counts.create, groupA.counts.linked, groupA.counts.review_possible_match, groupA.counts.review_name_collision, groupA.counts.review_ownership_change], [3, 1, 1, 1, 1]);
    const groupB = plan.entities.find(group => group.legalEntityId === ENTITY_B)!;
    assert.deepEqual([groupB.connected, groupB.counts.blocked_not_connected], [false, 1]);
    assert.equal(plan.entities.at(-1)!.legalEntityId, null);
    assert.match(plan.planSha256, /^[a-f0-9]{64}$/);

    // One entity's view carries only its rows, counts and digest.
    const onlyA = await h.executor.transaction!(tx => readQboCustomerPlan(tx, { organizationId, environment: "production", asOf: "2026-09-23", legalEntityId: ENTITY_A }), { readOnly: true });
    assert.deepEqual(onlyA.entities.map(group => group.legalEntityId), [ENTITY_A]);
    assert.equal(onlyA.planSha256, groupA.planSha256);
    assert.deepEqual(onlyA.counts, groupA.counts);

    // The plan is read-only: nothing was written.
    assert.equal((await h.synthetic.db.query("SELECT 1 FROM accounting_qbo_write_attempts")).rows.length, 0);
    assert.equal((await h.synthetic.db.query("SELECT 1 FROM company_external_identities WHERE record_kind='Customer'")).rows.length, 1);
  } finally {
    await h.close();
  }
});

test("the MCP read tool returns the same plan for an authorized actor", async () => {
  const h = await fixture();
  try {
    await mirrorNames(h.executor);
    const tools = new Map<string, { write: boolean; handler: (args: unknown) => Promise<unknown> }>();
    registerAccountingMcpTools((name, _description, _schema, write, handler) => { tools.set(name, { write, handler }); }, { executor: h.executor, services: {} as never, actorId: SYNTHETIC_COMPANY.actorId });
    const tool = tools.get("get_qbo_customer_plan")!;
    assert.equal(tool.write, false);
    const plan = await tool.handler({ organizationId, asOf: "2026-09-23" }) as QboCustomerPlan;
    const direct = await h.executor.transaction!(tx => readQboCustomerPlan(tx, { organizationId, environment: "production", asOf: "2026-09-23" }), { readOnly: true });
    assert.equal(plan.planSha256, direct.planSha256);
    assert.equal(plan.environment, "production");
  } finally {
    await h.close();
  }
});

test("the HTTP route serves the read-only plan and validates its query", async () => {
  const demo = await createCompanyDemoApp();
  const listener = demo.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/api/company/${organizationId}/accounting/qbo/customer-plan`;
  try {
    const response = await fetch(`${base}?asOf=2026-09-23`);
    assert.equal(response.status, 200, await response.clone().text());
    const plan = await response.json() as QboCustomerPlan;
    assert.deepEqual([plan.kind, plan.readOnly, plan.environment, plan.asOf], ["qbo_customer_plan", true, "production", "2026-09-23"]);
    assert.ok(plan.entities.some(group => group.legalEntityId === ENTITY_A && group.connected === false));
    assert.equal((await fetch(`${base}?environment=live`)).status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await demo.close();
  }
});

test("the CLI reads the plan for the only organization and refuses bad arguments", async () => {
  const h = await fixture();
  try {
    await mirrorNames(h.executor);
    const plan = await runCustomerPlanCli(["--as-of", "2026-09-23"], h.executor, "2026-01-01");
    assert.deepEqual([plan.environment, plan.asOf], ["production", "2026-09-23"]);
    assert.equal(row(plan, "t-1").status, "create");
    const onlyB = await runCustomerPlanCli(["--organization", organizationId, "--legal-entity", ENTITY_B, "--environment", "sandbox"], h.executor, "2026-09-23");
    assert.deepEqual([onlyB.environment, onlyB.entities.map(group => [group.legalEntityId, group.realmId])], ["sandbox", [[ENTITY_B, "999"]]]);
    assert.throws(() => parseCustomerPlanArgs(["--environment", "live"]), CustomerPlanCliError);
    assert.throws(() => parseCustomerPlanArgs(["--as-of", "2026-02-30"]), CustomerPlanCliError);
    assert.throws(() => parseCustomerPlanArgs(["--token", "x"]), CustomerPlanCliError);
  } finally {
    await h.close();
  }
});
