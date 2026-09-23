import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { companyScopeSchema } from "../../shared/company";
import type { WorkOrderCommandKind } from "../../shared/work-orders";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import { CompanyCommandError } from "../company/commands/errors";
import { createCompanyServices } from "../company/services";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { createQboAccountingMirrorStore } from "../accounting/mirror-store";
import { seedSyntheticQboPurchase } from "../projects/testing/qbo-mirror";

const { organizationId, entityId, actorId, propertyId } = SYNTHETIC_COMPANY;
const VENDOR_CONTACT = "56000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "synthetic-wo-invoice-1";

const rejectsWith = async (promise: Promise<unknown>, code: string, reason?: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CompanyCommandError, String(error));
    assert.equal(error.code, code, error.message);
    if (reason) assert.equal(error.details.reason, reason, error.message);
    return true;
  });
};

async function setup() {
  const fixture = await createSyntheticCompanyDatabase();
  const [line] = await seedSyntheticQboPurchase(fixture.executor, { objectId: "purchase-wo-1", txnDate: "2026-09-20", lines: [{ id: "1", amount: "100.00", description: "Plumbing repair" }] });
  await fixture.db.query("INSERT INTO company_contacts (id,organization_id,kind,display_name) VALUES ($1,$2,'organization','Example Plumbing Co')", [VENDOR_CONTACT, organizationId]);
  await fixture.db.query("INSERT INTO company_contact_roles (id,organization_id,contact_id,legal_entity_id,role,effective_from) VALUES ($1,$2,$3,$4,'vendor','2020-01-01')", [randomUUID(), organizationId, VENDOR_CONTACT, entityId]);
  await fixture.db.query(
    `INSERT INTO company_documents (id,organization_id,legal_entity_id,property_id,kind,state,title,tags,file_name,declared_content_type,size_bytes,checksum_sha256,backend,logical_key,immutable_version,verified_at)
     VALUES ($1,$2,$3,$4,'other','verified','Plumber invoice','{}','invoice.pdf','application/pdf',120,$5,'synthetic',$6,'v1',now())`,
    [DOCUMENT_ID, organizationId, entityId, propertyId, "a".repeat(64), `sha256:${"a".repeat(64)}`],
  );
  await fixture.db.query("INSERT INTO company_access_grants(id,organization_id,actor_id,role) VALUES ($1,$2,'reviewer-actor','read_only_reviewer')", [randomUUID(), organizationId]);
  const executor = await createSyntheticRuntimeExecutor(fixture.db);
  const services = createCompanyServices(executor, { accounting: { environment: {} }, time: { env: {} } });
  const accessFor = async (actor: string = actorId, role: "admin" | "read_only_reviewer" = "admin") => {
    const resolvePrincipal = (connection = executor) => loadAuthenticatedPrincipal(connection, { actorId: actor, organizationId, role });
    return { principal: await resolvePrincipal(), resolvePrincipal, transport: attestTransport("web") };
  };
  const access = await accessFor();
  const scope = companyScopeSchema.parse({ organizationId, legalEntityId: entityId });
  const envelope = (payload: Record<string, unknown>, expectedRevision?: number) => {
    const operationId = randomUUID();
    return { operationId, idempotencyKey: `wo-cost:${operationId}`, scope, effectiveDate: "2026-09-22", ...(expectedRevision === undefined ? {} : { expectedRevision }), payload };
  };
  const run = (kind: WorkOrderCommandKind, payload: Record<string, unknown>, expectedRevision?: number, commandAccess = access) =>
    services.workOrders.execute(kind, envelope(payload, expectedRevision), commandAccess);
  return { fixture, services, access, accessFor, scope, envelope, run, line: line!, mirror: createQboAccountingMirrorStore(fixture.executor) };
}

test("work order vendor, QBO cost links, manual actual, attachments and reporting", async () => {
  const { fixture, services, access, accessFor, scope, envelope, run, line, mirror } = await setup();
  try {
    const created = await run("work_order.create", { propertyId, title: "Replace water heater", category: "plumbing", priority: "high", reportedOn: "2026-09-01", estimatedCostCents: "15000" });
    const workOrderId = String(created.affectedRecordIds[0]);
    let detail = await services.workOrders.get(access.principal, { scope, workOrderId });
    assert.equal(detail.targetOn, "2026-09-04", "high priority targets three days after the report");
    assert.equal(detail.actualCost.state, "none");

    const vendors = await services.workOrders.vendorOptions(access.principal, { scope });
    assert.ok(vendors.items.some((item) => item.id === VENDOR_CONTACT && item.kind === "contact"));
    const assigned = await run("work_order.vendor.assign", { workOrderId, vendor: { kind: "contact", id: VENDOR_CONTACT } }, detail.recordRevision);
    let revision = assigned.resultingRevisions[0]!.revision;
    await rejectsWith(run("work_order.vendor.assign", { workOrderId, vendor: { kind: "contact", id: randomUUID() } }, revision), "validation");
    await rejectsWith(run("work_order.vendor.assign", { workOrderId, vendor: null }, revision - 1), "conflict");
    const reviewer = await accessFor("reviewer-actor", "read_only_reviewer");
    await rejectsWith(run("work_order.vendor.assign", { workOrderId, vendor: null }, revision, reviewer), "forbidden");

    const picker = await services.workOrders.costSourceLines(access.principal, { organizationId, legalEntityId: entityId, purpose: "cost" });
    assert.equal(picker.items.length, 1);
    assert.equal(picker.items[0]!.availableCents, "10000");

    const linkEnvelope = envelope({ workOrderId, source: line, amountCents: "6000" }, revision);
    const linked = await services.workOrders.execute("work_order.cost.link", linkEnvelope, access);
    const replay = await services.workOrders.execute("work_order.cost.link", linkEnvelope, access);
    assert.deepEqual(replay, linked, "an identical retry returns the stored receipt");
    revision = linked.resultingRevisions[0]!.revision;
    assert.equal((await mirror.getBalance(line)).allocatedCents, "6000", "the replay did not reserve twice");

    // The same QBO line cannot also be counted in full on a project.
    const project = await services.projects.execute("project.create", { ...envelope({ propertyId, name: "Water heater replacement", projectType: "rehab", status: "active", startOn: "2026-09-01", targetOn: "2026-10-01" }), scope: { ...scope, propertyId } }, access) as { affectedRecordIds: string[]; resultingRevisions: { revision: number }[] };
    const projectId = String(project.affectedRecordIds[0]);
    const bindingEnvelope = (allocatedCents: string, projectRevision: number) => ({ ...envelope({ projectId, source: line, allocatedCents }, projectRevision), scope: { ...scope, propertyId } });
    await assert.rejects(services.projects.executeExecution!("project.finance_binding.create", bindingEnvelope("5000", project.resultingRevisions[0]!.revision), access));
    await services.projects.executeExecution!("project.finance_binding.create", bindingEnvelope("4000", project.resultingRevisions[0]!.revision), access);
    const balance = await mirror.getBalance(line);
    assert.equal(balance.allocatedCents, "10000");
    assert.equal(balance.availableCents, "0", "one QBO line is conserved across the work order and the project");
    await rejectsWith(run("work_order.cost.link", { workOrderId, source: line, amountCents: "6001" }, revision), "validation");

    const manual = await run("work_order.actual.set", { workOrderId, amountCents: "7000", note: "Supplier quote" }, revision);
    revision = manual.resultingRevisions[0]!.revision;
    const documents = await services.workOrders.documentOptions(access.principal, { scope, propertyId });
    assert.deepEqual(documents.items.map((item) => item.documentId), [DOCUMENT_ID]);
    const attached = await run("work_order.attachment.link", { workOrderId, documentId: DOCUMENT_ID }, revision);
    revision = attached.resultingRevisions[0]!.revision;
    await rejectsWith(run("work_order.attachment.link", { workOrderId, documentId: DOCUMENT_ID }, revision), "validation", "work_order_attachment_exists");

    detail = await services.workOrders.get(access.principal, { scope, workOrderId });
    assert.equal(detail.vendor?.name, "Example Plumbing Co");
    assert.equal(detail.actualCost.linkedCents, "6000");
    assert.equal(detail.actualCost.linkedLineCount, 1);
    assert.equal(detail.actualCost.manualCents, "7000");
    assert.equal(detail.costLines.length, 1);
    assert.equal(detail.costLines[0]!.allocatedCents, "6000");
    assert.equal(detail.costLines[0]!.lineAmountCents, "10000");
    assert.equal(detail.costLines[0]!.validity, "current");
    assert.equal(detail.manualActual?.amountCents, "7000");
    assert.deepEqual(detail.attachments.map((item) => item.documentId), [DOCUMENT_ID]);

    const report = await services.workOrders.listForReporting(access.principal, { scope, vendorId: VENDOR_CONTACT, asOf: "2026-09-10" });
    assert.equal(report.items.length, 1);
    const row = report.items[0]!;
    assert.equal(row.agingDays, 9);
    assert.equal(row.overdue, true);
    assert.equal(row.estimatedCostCents, "15000");
    assert.equal(row.linkedActualCents, "6000");
    assert.equal(row.manualActualCents, "7000");
    assert.equal((await services.workOrders.listForReporting(access.principal, { scope, priorities: ["low"] })).items.length, 0);
    assert.equal((await services.workOrders.listForReporting(access.principal, { scope, dueFrom: "2026-09-04", dueThrough: "2026-09-04" })).items.length, 1);
    assert.equal((await services.workOrders.listForReporting(access.principal, { scope, assignee: "plumbing co" })).items.length, 1, "assignee search matches the vendor name");
    assert.equal((await services.workOrders.list(access.principal, { scope, vendorId: VENDOR_CONTACT })).items.length, 1);

    const unlinked = await run("work_order.cost.unlink", { workOrderId, source: line }, revision);
    revision = unlinked.resultingRevisions[0]!.revision;
    assert.equal((await mirror.getBalance(line)).allocatedCents, "4000", "releasing the work order leaves the project allocation");
    await rejectsWith(run("work_order.cost.unlink", { workOrderId, source: line }, revision), "validation", "work_order_cost_not_linked");
    const detached = await run("work_order.attachment.unlink", { workOrderId, documentId: DOCUMENT_ID }, revision);
    await run("work_order.actual.set", { workOrderId, amountCents: null }, detached.resultingRevisions[0]!.revision);
    detail = await services.workOrders.get(access.principal, { scope, workOrderId });
    assert.equal(detail.attachments.length, 0);
    assert.equal(detail.actualCost.linkedCents, "0");
    assert.equal(detail.actualCost.manualCents, null);
    assert.equal(detail.vendor?.id, VENDOR_CONTACT);
  } finally {
    await fixture.close();
  }
});
