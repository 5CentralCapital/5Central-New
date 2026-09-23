import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { companyScopeSchema, type OperationReceipt } from "../../shared/company";
import type { ProjectCommandKind, ProjectExecutionCommandKind } from "../../shared/projects";
import type { TimeCommandKind } from "../../shared/time";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import { CompanyCommandError } from "../company/commands/errors";
import { createCompanyServices } from "../company/services";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { createQboAccountingMirrorStore } from "../accounting/mirror-store";
import { normalizeTimeEntry, normalizeTimeJobcode, normalizeTimeUser } from "../time/normalize";
import { createTimeStore } from "../time/store";
import { seedSyntheticQboPurchase } from "./testing/qbo-mirror";

const { organizationId, entityId, actorId, propertyId } = SYNTHETIC_COMPANY;
const timeScope = { organizationId, legalEntityId: entityId, environment: "production" as const, providerCompanyId: "time-company" };
const EMPLOYEE_CONTACT = "57000000-0000-4000-8000-000000000001";
const modified = "2026-09-15T12:00:00.000Z";

const rejectsWith = async (promise: Promise<unknown>, code: string, reason?: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CompanyCommandError, String(error));
    assert.equal(error.code, code, error.message);
    if (reason) assert.equal(error.details.reason, reason, error.message);
    return true;
  });
};

test("project cost report combines budget, commitments, QBO actuals and labor without double counting payroll", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    const [costLine, payrollLine] = await seedSyntheticQboPurchase(fixture.executor, {
      objectId: "purchase-project-1", txnDate: "2026-09-14",
      lines: [{ id: "1", amount: "250.00", description: "Trim materials" }, { id: "2", amount: "80.00", accountId: "payroll-expense", description: "Payroll 2026-09-07 to 2026-09-13" }],
    });
    await fixture.db.query("INSERT INTO company_contacts (id,organization_id,kind,display_name) VALUES ($1,$2,'person','Example Carpenter')", [EMPLOYEE_CONTACT, organizationId]);
    await fixture.db.query("INSERT INTO company_access_grants(id,organization_id,actor_id,role) VALUES ($1,$2,'reviewer-actor','read_only_reviewer')", [randomUUID(), organizationId]);
    const executor = await createSyntheticRuntimeExecutor(fixture.db);
    const services = createCompanyServices(executor, { accounting: { environment: {} }, time: { env: {} } });
    const mirror = createQboAccountingMirrorStore(fixture.executor);
    const resolvePrincipal = (connection = executor) => loadAuthenticatedPrincipal(connection, { actorId, organizationId, role: "admin" });
    const access = { principal: await resolvePrincipal(), resolvePrincipal, transport: attestTransport("web") };
    const scope = companyScopeSchema.parse({ organizationId, legalEntityId: entityId, propertyId });
    const envelope = (payload: Record<string, unknown>, expectedRevision?: number) => {
      const operationId = randomUUID();
      return { operationId, idempotencyKey: `cost-report:${operationId}`, scope, effectiveDate: "2026-09-22", ...(expectedRevision === undefined ? {} : { expectedRevision }), payload };
    };
    let projectRevision = 0;
    const track = (receipt: OperationReceipt, projectId: string) => {
      const entry = receipt.resultingRevisions.find((item) => String(item.recordId) === projectId);
      if (entry) projectRevision = Number(entry.revision);
      return receipt;
    };
    const project = (kind: ProjectCommandKind, payload: Record<string, unknown>, expectedRevision?: number) => services.projects.execute(kind, envelope(payload, expectedRevision), access) as Promise<OperationReceipt>;
    const execution = (kind: ProjectExecutionCommandKind, payload: Record<string, unknown>, expectedRevision?: number) => services.projects.executeExecution!(kind, envelope(payload, expectedRevision), access) as Promise<OperationReceipt>;
    const time = (kind: TimeCommandKind, payload: Record<string, unknown>) => services.time.commands.execute(kind, { ...envelope({ environment: timeScope.environment, providerCompanyId: timeScope.providerCompanyId, ...payload }), scope: companyScopeSchema.parse({ organizationId, legalEntityId: entityId }) }, access);

    const created = await project("project.create", { propertyId, name: "Unit 1A trim", projectType: "rehab", status: "active", startOn: "2026-09-01", targetOn: "2026-10-15" });
    const projectId = String(created.affectedRecordIds[0]);
    track(created, projectId);
    const item = track(await project("project.scope_item.create", { projectId, description: "Trim carpentry", quantity: "1", rateCents: "100000" }), projectId);
    const scopeItemId = String(item.affectedRecordIds[0]);
    track(await project("project.budget.approve", { projectId }, projectRevision), projectId);
    await rejectsWith(project("project.draft_cost.create", { projectId, description: "Reserved marker", amountCents: "1", incurredOn: "2026-09-10", vendorName: "system:etc_override" }), "validation");
    track(await project("project.draft_cost.create", { projectId, scopeItemId, description: "Deposit", amountCents: "1250", incurredOn: "2026-09-10", vendorName: "Synthetic vendor" }), projectId);

    const commitment = track(await execution("project.commitment.create", { projectId, description: "Trim subcontract", originalCents: "60000", currency: "USD" }, projectRevision), projectId);
    const commitmentId = String(commitment.affectedRecordIds[0]);
    track(await execution("project.commitment.update", { commitmentId, status: "approved" }, projectRevision), projectId);
    track(await execution("project.finance_binding.create", { projectId, commitmentId, scopeItemId, source: costLine, allocatedCents: "25000" }, projectRevision), projectId);
    const etcEnvelope = envelope({ projectId, scopeItemId, amountCents: "30000", reason: "Remaining trim and punch work" }, projectRevision);
    const etc = track(await services.projects.executeExecution!("project.etc_override.set", etcEnvelope, access) as OperationReceipt, projectId);
    assert.deepEqual(await services.projects.executeExecution!("project.etc_override.set", etcEnvelope, access), etc, "ETC replay returns the stored receipt");

    // Time: two approved two-hour shifts mapped to the scope line by cost code.
    const store = createTimeStore(fixture.executor, () => new Date(modified));
    await store.upsertUser(timeScope, normalizeTimeUser(timeScope, { id: "employee-1", first_name: "Example", last_name: "Carpenter", active: true, submitted_to: "2026-09-13", approved_to: null, last_modified: modified }), modified);
    await store.upsertJobcode(timeScope, normalizeTimeJobcode(timeScope, { id: "job-1", name: "Unit 1A trim", active: true, billable: false, last_modified: modified }), modified);
    for (const [id, day] of [["ts-1", "10"], ["ts-2", "11"]] as const) {
      await store.upsertEntry(timeScope, normalizeTimeEntry(timeScope, { id, user_id: "employee-1", jobcode_id: "job-1", type: "regular", start: `2026-09-${day}T08:00:00-04:00`, end: `2026-09-${day}T10:00:00-04:00`, date: `2026-09-${day}`, duration: 7_200, tz: -4, tz_str: "America/New_York", active: true, locked: 0, last_modified: modified, notes: "" }), modified);
    }
    await store.mapEmployee({ scope: timeScope, providerUserId: "employee-1", contactId: EMPLOYEE_CONTACT, effectiveFrom: "2026-01-01", effectiveTo: null, hourlyRateCents: "2000", currency: "USD", actorId, operationId: randomUUID() });
    await store.mapJobcode({ scope: timeScope, providerJobcodeId: "job-1", propertyId, projectId, costCode: scopeItemId, actorId, operationId: randomUUID() });
    const entries = await store.listEntries({ scope: { organizationId, legalEntityId: entityId }, environment: timeScope.environment, providerCompanyId: timeScope.providerCompanyId, limit: 50 });
    for (const entry of entries.items) {
      await fixture.executor.transaction!(async (tx) => store.forExecutor(tx).reviewTimesheet({ scope: timeScope, timesheetId: entry.id, action: "approve", actorId, operationId: randomUUID() }));
    }

    const labor = await services.projectInsights.labor(access.principal, { scope, projectId });
    assert.equal(labor.rows.length, 2);
    assert.ok(labor.rows.every((row) => row.scopeItemId === scopeItemId && row.basis === "estimated"));
    assert.equal(labor.estimatedCents, "8000");

    let report = await services.projectInsights.costReport(access.principal, { scope, projectId, asOf: "2026-09-22" });
    assert.equal(report.summary.originalBudgetCents, "100000");
    assert.equal(report.summary.committedCents, "60000");
    assert.equal(report.summary.draftCostCents, "1250", "the ETC override is not a draft cost");
    assert.equal(report.summary.incurred.verifiedActualCents, "25000");
    assert.equal(report.summary.incurred.laborEstimatedCents, "8000");
    assert.equal(report.summary.incurred.laborPostedCents, "0");
    assert.equal(report.summary.incurred.totalCents, "33000");
    assert.equal(report.summary.remainingCommitmentCents, "35000");
    let line = report.lines.find((entry) => entry.scopeItemId === scopeItemId)!;
    assert.equal(line.etcOverride?.amountCents, "30000");
    assert.equal(line.costToCompleteCents, "30000", "an explicit override replaces the derived cost to complete");
    assert.equal(line.forecastFinalCostCents, "63000");
    assert.equal(report.summary.forecastFinalCostCents, report.lines.reduce((total, entry) => total + BigInt(entry.forecastFinalCostCents ?? "0"), BigInt(0)).toString());
    assert.equal(report.closeout.ready, false);

    // Posted payroll replaces the estimate for the linked time.
    const picker = await services.projectInsights.costSourceLines(access.principal, { organizationId, legalEntityId: entityId, purpose: "payroll" });
    assert.ok(picker.items.some((entry) => entry.source.lineId === "2" && entry.availableCents === "8000"));
    const linkEnvelope = { ...envelope({ environment: timeScope.environment, providerCompanyId: timeScope.providerCompanyId, source: payrollLine, amountCents: "8000", periodFrom: "2026-09-07", periodThrough: "2026-09-13" }), scope: companyScopeSchema.parse({ organizationId, legalEntityId: entityId }) };
    const linked = await services.time.commands.execute("time.payroll.link", linkEnvelope, access);
    assert.deepEqual(await services.time.commands.execute("time.payroll.link", linkEnvelope, access), linked, "payroll link replay returns the stored receipt");
    const batchId = String(linked.affectedRecordIds[0]);
    assert.equal((await mirror.getBalance(payrollLine)).allocatedCents, "8000");
    await rejectsWith(time("time.payroll.link", { source: payrollLine, amountCents: "1", periodFrom: "2026-09-07", periodThrough: "2026-09-13" }), "conflict", "time_payroll_already_linked");
    await assert.rejects(execution("project.finance_binding.create", { projectId, source: payrollLine, allocatedCents: "100" }, projectRevision), "a linked payroll line cannot also be a project cost");

    report = await services.projectInsights.costReport(access.principal, { scope, projectId, asOf: "2026-09-22" });
    assert.equal(report.summary.incurred.laborEstimatedCents, "0");
    assert.equal(report.summary.incurred.laborPostedCents, "8000");
    assert.equal(report.summary.incurred.totalCents, "33000", "posted payroll replaced the estimate; nothing is counted twice");
    line = report.lines.find((entry) => entry.scopeItemId === scopeItemId)!;
    assert.equal(line.laborCents, "8000");

    const links = await services.time.read.listPayrollLinks(access.principal, { organizationId, legalEntityId: entityId });
    assert.deepEqual(links.map((entry) => [entry.batchId, entry.status, entry.amountCents, entry.timesheetCount]), [[batchId, "active", "8000", 2]]);
    const reviewerResolve = (connection = executor) => loadAuthenticatedPrincipal(connection, { actorId: "reviewer-actor", organizationId, role: "read_only_reviewer" });
    const reviewer = { principal: await reviewerResolve(), resolvePrincipal: reviewerResolve, transport: attestTransport("web") };
    await rejectsWith(services.time.commands.execute("time.payroll.unlink", { ...envelope({ environment: timeScope.environment, providerCompanyId: timeScope.providerCompanyId, batchId, reason: "Wrong period" }), scope: companyScopeSchema.parse({ organizationId, legalEntityId: entityId }) }, reviewer), "forbidden");

    await time("time.payroll.unlink", { batchId, reason: "Wrong pay period" });
    assert.equal((await mirror.getBalance(payrollLine)).allocatedCents, "0");
    report = await services.projectInsights.costReport(access.principal, { scope, projectId, asOf: "2026-09-22" });
    assert.equal(report.summary.incurred.laborEstimatedCents, "8000", "releasing the link restores the estimate");
    assert.equal(report.summary.incurred.laborPostedCents, "0");
    assert.equal((await services.time.read.listPayrollLinks(access.principal, { organizationId, legalEntityId: entityId }))[0]?.status, "released");

    // Clearing the override returns the line to the derived cost to complete.
    track(await execution("project.etc_override.clear", { projectId, scopeItemId }, projectRevision), projectId);
    report = await services.projectInsights.costReport(access.principal, { scope, projectId, asOf: "2026-09-22" });
    line = report.lines.find((entry) => entry.scopeItemId === scopeItemId)!;
    assert.equal(line.etcOverride, null);
    assert.equal(line.costToCompleteCents, "67000", "max(revised 100000 − incurred 33000, remaining commitment 35000)");

    // A template can be created from inline lines and instantiated.
    const template = await execution("project.template.create", { name: "Standard trim", projectType: "rehab", scopeItems: [{ description: "Trim", quantity: "2", rateCents: "5000" }], tasks: [{ title: "Measure", relativeDays: 0 }, { title: "Install", relativeDays: 3 }] });
    const detail = await services.projects.getExecution!(access.principal, { scope, projectId }) as { templates: { id: string; scopeItems: unknown[]; tasks: unknown[] }[] };
    const saved = detail.templates.find((entry) => entry.id === String(template.affectedRecordIds[0]));
    assert.equal(saved?.scopeItems.length, 1);
    assert.equal(saved?.tasks.length, 2);
  } finally {
    await fixture.close();
  }
});
