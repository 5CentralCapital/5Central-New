import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { companyScopeSchema } from "../../shared/company";
import type { WorkOrderCommandKind } from "../../shared/work-orders";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import { CompanyCommandError } from "../company/commands/errors";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { createWorkOrderPort } from "./port";

const { organizationId, entityId, actorId, propertyId, unitId } = SYNTHETIC_COMPANY;

async function setup() {
  const fixture = await createSyntheticCompanyDatabase();
  const db = fixture.db;
  // Synthetic rental links: a second property, a tenancy and a posted tenant charge.
  await db.query("INSERT INTO rent_ops_properties(id,name,slug) VALUES ('demo-property-z','Example Other Property','demo-property-z')");
  await db.query("INSERT INTO rent_ops_units(id,property_id,unit_number) VALUES ('demo-unit-z-1','demo-property-z','Z1'),('demo-unit-a-9',$1,'9A')", [propertyId]);
  await db.query("INSERT INTO company_property_entity_periods(id,organization_id,legal_entity_id,property_id,effective_from) VALUES ('30000000-0000-4000-8000-000000000009',$1,$2,'demo-property-z','2020-01-01')", [organizationId, entityId]);
  await db.query("INSERT INTO rent_ops_people(id,first_name,last_name) VALUES ('wo-person-1','Example','Resident'),('wo-person-2','Other','Resident')");
  await db.query("INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,created_at) VALUES ('wo-tenancy-1',$1,$2,'wo-person-1','current',now()),('wo-tenancy-z','demo-property-z','demo-unit-z-1','wo-person-2','current',now())", [propertyId, unitId]);
  const ledgerColumns = "id,property_id,unit_id,tenancy_id,person_id,kind,category,status,amount_cents,posted_on,description,payer,amount_knowledge,category_knowledge,status_knowledge,posted_on_knowledge,description_knowledge,payer_knowledge,charge_definition_link_knowledge,property_link_knowledge,unit_link_knowledge,person_link_knowledge,tenancy_link_knowledge,due_on_knowledge,payment_method_knowledge";
  const knowledge = "'known','manual','manual','manual','manual','manual','unknown','manual','manual','manual','manual','unknown','unknown'";
  await db.query(`INSERT INTO rent_ops_ledger_transactions(${ledgerColumns}) VALUES ('wo-charge-1',$1,$2,'wo-tenancy-1','wo-person-1','charge','one_time_fee','posted',7500,'2026-09-06','Screen repair','tenant',${knowledge}),('wo-payment-1',$1,$2,'wo-tenancy-1','wo-person-1','payment','other','posted',7500,'2026-09-07','Payment','tenant',${knowledge})`, [propertyId, unitId]);
  await db.query("INSERT INTO company_access_grants(id,organization_id,actor_id,role,legal_entity_id,property_id) VALUES ('40000000-0000-4000-8000-000000000009',$1,'restricted-actor','admin',$2,$3)", [organizationId, entityId, propertyId]);
  const executor = await createSyntheticRuntimeExecutor(db);
  const port = createWorkOrderPort(executor);
  const accessFor = async (actor = actorId) => {
    const resolvePrincipal = (connection = executor) => loadAuthenticatedPrincipal(connection, { actorId: actor, organizationId, role: "admin" });
    return { principal: await resolvePrincipal(), resolvePrincipal, transport: attestTransport("web") };
  };
  const access = await accessFor();
  const scope = companyScopeSchema.parse({ organizationId, legalEntityId: entityId });
  const envelope = (payload: Record<string, unknown>, expectedRevision?: number, commandScope: unknown = scope) => {
    const operationId = randomUUID();
    return { operationId, idempotencyKey: `wo-test:${operationId}`, scope: commandScope, ...(expectedRevision === undefined ? {} : { expectedRevision }), payload };
  };
  const run = (kind: WorkOrderCommandKind, payload: Record<string, unknown>, expectedRevision?: number, commandAccess = access, commandScope?: unknown) =>
    port.execute(kind, envelope(payload, expectedRevision, commandScope), commandAccess);
  return { fixture, db, executor, port, access, accessFor, scope, envelope, run };
}

const rejectsWith = async (promise: Promise<unknown>, code: string, reason?: string | RegExp) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CompanyCommandError, String(error));
    assert.equal(error.code, code, error.message);
    if (typeof reason === "string") assert.equal(error.details.reason, reason, error.message);
    if (reason instanceof RegExp) assert.match(error.message, reason);
    return true;
  });
};

test("work order lifecycle persists fields, history and readback", async () => {
  const { fixture, port, access, scope, run } = await setup();
  try {
    const created = await run("work_order.create", {
      propertyId, unitId, tenancyId: "wo-tenancy-1", title: "Leaking faucet", description: "Kitchen faucet drips", category: "plumbing",
      priority: "high", reportedOn: "2026-09-01", assignedTo: "Example Plumbing", entryPermitted: true, estimatedCostCents: "12345",
    });
    assert.equal(created.state, "saved_in_rops");
    const id = String(created.affectedRecordIds[0]);
    let detail = await port.get(access.principal, { scope, workOrderId: id });
    assert.equal(detail.status, "new");
    assert.equal(detail.personId, "wo-person-1", "tenancy defaults to its primary person");
    assert.equal(detail.personName, "Example Resident");
    assert.equal(detail.estimatedCostCents, "12345");
    assert.equal(detail.currency, "USD");
    assert.equal(detail.entryPermitted, true);
    assert.equal(detail.createdBy, actorId);
    assert.deepEqual(detail.allowedTransitions, ["scheduled", "in_progress", "on_hold", "completed", "canceled"]);

    await rejectsWith(run("work_order.status.change", { workOrderId: id, status: "scheduled" }, detail.recordRevision), "validation", "work_order_scheduled_date_required");
    const scheduled = await run("work_order.status.change", { workOrderId: id, status: "scheduled", scheduledOn: "2026-09-03" }, detail.recordRevision);
    await rejectsWith(run("work_order.status.change", { workOrderId: id, status: "on_hold" }, scheduled.resultingRevisions[0]!.revision), "validation", "work_order_note_required");
    const held = await run("work_order.status.change", { workOrderId: id, status: "on_hold", note: "Waiting on parts" }, scheduled.resultingRevisions[0]!.revision);
    const done = await run("work_order.status.change", { workOrderId: id, status: "completed", completedOn: "2026-09-05" }, held.resultingRevisions[0]!.revision);
    detail = await port.get(access.principal, { scope, workOrderId: id });
    assert.equal(detail.status, "completed");
    assert.equal(detail.completedOn, "2026-09-05");
    assert.equal(detail.scheduledOn, "2026-09-03");
    assert.equal(detail.recordRevision, done.resultingRevisions[0]!.revision);
    assert.equal(detail.chargeback, null, "completion does not imply a charge");
    await rejectsWith(run("work_order.status.change", { workOrderId: id, status: "canceled", note: "x" }, detail.recordRevision), "validation", "work_order_transition_not_allowed");
    await rejectsWith(run("work_order.status.change", { workOrderId: id, status: "in_progress" }, detail.recordRevision), "validation", "work_order_note_required");
    const reopened = await run("work_order.status.change", { workOrderId: id, status: "in_progress", note: "Drip returned" }, detail.recordRevision);
    await run("work_order.note.add", { workOrderId: id, note: "Tenant confirmed access window" });
    detail = await port.get(access.principal, { scope, workOrderId: id });
    assert.equal(detail.completedOn, null, "reopening clears the completed date");
    assert.equal(detail.recordRevision, reopened.resultingRevisions[0]!.revision + 1);
    assert.deepEqual(detail.history.map(event => [event.type, event.fromStatus, event.toStatus]), [
      ["created", null, null],
      ["status_changed", "new", "scheduled"],
      ["status_changed", "scheduled", "on_hold"],
      ["status_changed", "on_hold", "completed"],
      ["status_changed", "completed", "in_progress"],
      ["note", null, null],
    ]);
    assert.equal(detail.history[2]!.note, "Waiting on parts");
    assert.deepEqual(detail.history.map(event => event.recordRevision), [1, 2, 3, 4, 5, 6]);

    const updated = await run("work_order.update", { workOrderId: id, title: "Leaking kitchen faucet", priority: "emergency", estimatedCostCents: null, assignedTo: "" }, detail.recordRevision);
    detail = await port.get(access.principal, { scope, workOrderId: id });
    assert.equal(detail.title, "Leaking kitchen faucet");
    assert.equal(detail.priority, "emergency");
    assert.equal(detail.estimatedCostCents, null);
    assert.equal(detail.assignedTo, null);
    assert.equal(detail.recordRevision, updated.resultingRevisions[0]!.revision);
    assert.deepEqual(detail.history.at(-1)!.details, { fields: ["assignedTo", "estimatedCostCents", "priority", "title"] });

    // History rows cannot be rewritten through the runtime role.
    await assert.rejects(fixture.db.query("UPDATE company_work_order_events SET note = 'changed'"), /immutable/);
  } finally {
    await fixture.close();
  }
});

test("list filters, open default, search and cursor pagination", async () => {
  const { fixture, port, access, scope, run } = await setup();
  try {
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const receipt = await run("work_order.create", { propertyId, title: `Synthetic job ${index}`, priority: index === 0 ? "emergency" : "normal", reportedOn: `2026-09-0${index + 1}`, category: index % 2 ? "pest" : "general" });
      ids.push(String(receipt.affectedRecordIds[0]));
    }
    await run("work_order.create", { propertyId: "demo-property-z", unitId: "demo-unit-z-1", title: "Other property furnace", category: "hvac", assignedTo: "Example HVAC" });
    const first = await port.get(access.principal, { scope, workOrderId: ids[4]! });
    await run("work_order.status.change", { workOrderId: ids[4], status: "canceled", note: "Duplicate request" }, first.recordRevision);

    const open = await port.list(access.principal, { scope });
    assert.equal(open.items.length, 5, "canceled work is hidden by default");
    assert.equal(open.items[0]!.priority, "emergency", "emergencies sort first");
    const all = await port.list(access.principal, { scope, openOnly: false });
    assert.equal(all.items.length, 6);
    assert.deepEqual((await port.list(access.principal, { scope, statuses: ["canceled"] })).items.map(item => item.id), [ids[4]]);
    assert.equal((await port.list(access.principal, { scope, categories: ["pest"] })).items.length, 2);
    assert.equal((await port.list(access.principal, { scope, priorities: ["emergency"] })).items.length, 1);
    assert.equal((await port.list(access.principal, { scope: { ...scope, propertyId: "demo-property-z" } as typeof scope })).items.length, 1);
    assert.equal((await port.list(access.principal, { scope, assignedTo: "hvac" })).items.length, 1);
    assert.equal((await port.list(access.principal, { scope, search: "furnace" })).items.length, 1);
    assert.equal((await port.list(access.principal, { scope, search: "Z1" })).items.length, 1, "search matches unit numbers");
    const reference = open.items[1]!.reference;
    assert.deepEqual((await port.list(access.principal, { scope, search: reference })).items.map(item => item.reference), [reference]);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await port.list(access.principal, { scope, openOnly: false, limit: 2, cursor });
      seen.push(...page.items.map(item => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(seen, all.items.map(item => item.id), "cursor pages are stable and complete");
    await rejectsWith(port.list(access.principal, { scope, cursor: "not-a-cursor" }), "validation", "invalid_work_order_cursor");
  } finally {
    await fixture.close();
  }
});

test("invalid input and links are rejected without partial writes", async () => {
  const { fixture, db, port, access, scope, run } = await setup();
  try {
    await rejectsWith(run("work_order.create", { propertyId, title: "" }), "validation");
    await rejectsWith(run("work_order.create", { propertyId, title: "Bad", category: "roof" }), "validation");
    await rejectsWith(run("work_order.create", { propertyId, title: "No entity" }, undefined, access, { organizationId }), "validation", "work_order_entity_scope_required");
    await rejectsWith(run("work_order.create", { propertyId, unitId: "demo-unit-z-1", title: "Wrong unit" }), "validation", "unit_property_ownership");
    await rejectsWith(run("work_order.create", { propertyId, tenancyId: "wo-tenancy-z", title: "Wrong tenancy" }), "validation", "work_order_tenancy_property");
    await rejectsWith(run("work_order.create", { propertyId, unitId: "demo-unit-a-9", tenancyId: "wo-tenancy-1", title: "Tenancy unit" }), "validation", "work_order_tenancy_unit");
    await rejectsWith(run("work_order.create", { propertyId, personId: "wo-person-2", title: "Wrong person" }), "validation", "work_order_person_property");
    await rejectsWith(run("work_order.create", { propertyId, projectId: randomUUID(), title: "Missing project" }), "validation", "work_order_project_property");
    assert.equal((await db.query("SELECT count(*)::int AS count FROM company_work_orders")).rows[0]!.count, 0);

    const created = await run("work_order.create", { propertyId, title: "Needs revision" });
    const id = String(created.affectedRecordIds[0]);
    await rejectsWith(run("work_order.update", { workOrderId: id, title: "No revision" }), "validation", "work_order_revision_required");
    await rejectsWith(run("work_order.chargeback.set", { workOrderId: id, amountCents: "100", description: "No tenant" }, 1), "validation", "work_order_chargeback_requires_tenant");
    await rejectsWith(run("work_order.chargeback.clear", { workOrderId: id }, 1), "validation", "work_order_chargeback_absent");
    await rejectsWith(run("work_order.update", { workOrderId: randomUUID(), title: "Missing" }, 1), "validation", "work_order_not_found");
    const detail = await port.get(access.principal, { scope, workOrderId: id });
    assert.equal(detail.recordRevision, 1);
    assert.equal(detail.history.length, 1);
  } finally {
    await fixture.close();
  }
});

test("chargeback intent is separate from posted charges and links only a posted tenant charge once", async () => {
  const { fixture, db, port, access, scope, run } = await setup();
  try {
    const ledgerBefore = (await db.query("SELECT count(*)::int AS count FROM rent_ops_ledger_transactions")).rows[0]!.count;
    const first = await run("work_order.create", { propertyId, unitId, tenancyId: "wo-tenancy-1", title: "Torn screen", category: "exterior" });
    const id = String(first.affectedRecordIds[0]);
    const intent = await run("work_order.chargeback.set", { workOrderId: id, amountCents: "7500", description: "Tenant damage" }, 1);
    let detail = await port.get(access.principal, { scope, workOrderId: id });
    assert.deepEqual(detail.chargeback, { amountCents: "7500", description: "Tenant damage", ledgerTransactionId: null, state: "intent_only" });
    assert.equal((await db.query("SELECT count(*)::int AS count FROM rent_ops_ledger_transactions")).rows[0]!.count, ledgerBefore, "no charge is posted");
    await rejectsWith(run("work_order.chargeback.set", { workOrderId: id, amountCents: "7500", description: "Tenant damage", ledgerTransactionId: "wo-payment-1" }, intent.resultingRevisions[0]!.revision), "validation", "work_order_chargeback_ledger_invalid");
    const linked = await run("work_order.chargeback.set", { workOrderId: id, amountCents: "7500", description: "Tenant damage", ledgerTransactionId: "wo-charge-1" }, intent.resultingRevisions[0]!.revision);
    detail = await port.get(access.principal, { scope, workOrderId: id });
    assert.equal(detail.chargeback?.state, "charge_linked");
    assert.equal(detail.chargeback?.ledgerTransactionId, "wo-charge-1");

    const second = await run("work_order.create", { propertyId, unitId, tenancyId: "wo-tenancy-1", title: "Second repair" });
    await rejectsWith(run("work_order.chargeback.set", { workOrderId: String(second.affectedRecordIds[0]), amountCents: "7500", description: "Reuse", ledgerTransactionId: "wo-charge-1" }, 1), "conflict", "work_order_chargeback_ledger_in_use");
    await rejectsWith(run("work_order.update", { workOrderId: id, tenancyId: null, personId: null }, linked.resultingRevisions[0]!.revision), "validation", "work_order_chargeback_requires_tenant");

    await run("work_order.chargeback.clear", { workOrderId: id }, linked.resultingRevisions[0]!.revision);
    detail = await port.get(access.principal, { scope, workOrderId: id });
    assert.equal(detail.chargeback, null);
    assert.equal(detail.history.at(-1)!.type, "chargeback_cleared");
    assert.equal(detail.history.at(-1)!.details.previousLedgerTransactionId, "wo-charge-1");
    assert.equal((await db.query("SELECT status FROM rent_ops_ledger_transactions WHERE id='wo-charge-1'")).rows[0]!.status, "posted", "clearing leaves the ledger charge untouched");
  } finally {
    await fixture.close();
  }
});

test("project links require an active project at the same property", async () => {
  const { fixture, port, access, scope, run } = await setup();
  try {
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    await fixture.db.query("INSERT INTO company_projects(id,organization_id,legal_entity_id,property_id,name,status,currency) VALUES ($1,$2,$3,$4,'Example rehab','active','USD'),($5,$2,$3,'demo-property-z','Other rehab','active','USD')", [projectId, organizationId, entityId, propertyId, otherProjectId]);
    const created = await run("work_order.create", { propertyId, title: "Turn unit", category: "turnover" });
    const id = String(created.affectedRecordIds[0]);
    await rejectsWith(run("work_order.project.link", { workOrderId: id, projectId: otherProjectId }, 1), "validation", "work_order_project_property");
    const linked = await run("work_order.project.link", { workOrderId: id, projectId }, 1);
    let detail = await port.get(access.principal, { scope, workOrderId: id });
    assert.equal(detail.projectName, "Example rehab");
    await run("work_order.project.link", { workOrderId: id, projectId: null }, linked.resultingRevisions[0]!.revision);
    detail = await port.get(access.principal, { scope, workOrderId: id });
    assert.equal(detail.projectId, null);
    assert.deepEqual(detail.history.slice(1).map(event => event.type), ["project_linked", "project_unlinked"]);
  } finally {
    await fixture.close();
  }
});

test("authorization follows paired company grants for reads and commands", async () => {
  const { fixture, db, port, access, accessFor, scope, run } = await setup();
  try {
    const other = await run("work_order.create", { propertyId: "demo-property-z", title: "Other property job" });
    const otherId = String(other.affectedRecordIds[0]);
    const restricted = await accessFor("restricted-actor");
    const propertyScope = companyScopeSchema.parse({ organizationId, legalEntityId: entityId, propertyId });
    const own = await run("work_order.create", { propertyId, title: "Restricted job" }, undefined, restricted, propertyScope);
    assert.equal(own.state, "saved_in_rops");
    assert.equal((await port.list(restricted.principal, { scope: propertyScope })).items.length, 1);
    await rejectsWith(port.list(restricted.principal, { scope }), "forbidden", "scope_grant");
    await rejectsWith(port.get(restricted.principal, { scope: propertyScope, workOrderId: otherId }), "validation", "work_order_not_found");
    const zScope = companyScopeSchema.parse({ organizationId, legalEntityId: entityId, propertyId: "demo-property-z" });
    await rejectsWith(port.get(restricted.principal, { scope: zScope, workOrderId: otherId }), "forbidden", "scope_grant");
    await rejectsWith(run("work_order.create", { propertyId: "demo-property-z", title: "Escalate" }, undefined, restricted, zScope), "forbidden", "scope_grant");
    await rejectsWith(run("work_order.note.add", { workOrderId: otherId, note: "Sneaky" }, undefined, restricted, propertyScope), "validation", "work_order_not_found");
    await rejectsWith(run("work_order.create", { propertyId: "demo-property-z", title: "Scope mismatch" }, undefined, restricted, propertyScope), "forbidden", "work_order_property_scope");
    await rejectsWith(accessFor("unknown-actor"), "forbidden", "grant_missing");
    await rejectsWith(port.list(access.principal, { scope: { organizationId: "10000000-0000-4000-8000-000000000999" } as typeof scope }), "forbidden", "read_scope");

    await db.query("UPDATE company_access_grants SET revoked_at = now() WHERE actor_id = 'restricted-actor'");
    await rejectsWith(port.list(restricted.principal, { scope: propertyScope }), "forbidden", "grant_missing");
    await rejectsWith(run("work_order.create", { propertyId, title: "After revoke" }, undefined, restricted, propertyScope), "forbidden", "grant_missing");
  } finally {
    await fixture.close();
  }
});

test("concurrent edits on one revision produce exactly one conflict and replay is idempotent", async () => {
  const { fixture, port, access, scope, envelope, run } = await setup();
  try {
    const command = envelope({ propertyId, title: "Replayed create" });
    const createdReceipt = await port.execute("work_order.create", command, access);
    assert.deepEqual(await port.execute("work_order.create", command, access), createdReceipt, "identical retry replays the receipt");
    await rejectsWith(port.execute("work_order.create", { ...command, payload: { propertyId, title: "Different" } }, access), "conflict", "idempotency_key_conflict");
    const id = String(createdReceipt.affectedRecordIds[0]);
    const results = await Promise.allSettled([
      run("work_order.update", { workOrderId: id, title: "Edit A" }, 1),
      run("work_order.update", { workOrderId: id, title: "Edit B" }, 1),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof CompanyCommandError);
    assert.equal(rejected.reason.code, "conflict");
    assert.equal(rejected.reason.details.reason, "revision_conflict");
    const detail = await port.get(access.principal, { scope, workOrderId: id });
    assert.equal(detail.recordRevision, 2);
    assert.ok(["Edit A", "Edit B"].includes(detail.title));
    assert.equal((await port.list(access.principal, { scope })).items.length, 1, "the replay created one record");
    await rejectsWith(run("work_order.update", { workOrderId: id, title: "Stale" }, 1), "conflict", "revision_conflict");
  } finally {
    await fixture.close();
  }
});
