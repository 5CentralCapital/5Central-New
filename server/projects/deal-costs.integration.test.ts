import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import test from "node:test";
import { companyScopeSchema } from "../../shared/company";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import { createCompanyServices } from "../company/services";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { registerCompanyRoutes } from "../company/routes";
import { createQboAccountingMirrorStore } from "../accounting/mirror-store";
import { seedSyntheticQboPurchase } from "./testing/qbo-mirror";

const { organizationId, entityId, actorId, propertyId } = SYNTHETIC_COMPANY;

function projectRevision(receipt: { resultingRevisions: readonly { recordId: string; revision: number }[] }, projectId: string): number {
  const revision = receipt.resultingRevisions.find((entry) => String(entry.recordId) === projectId)?.revision;
  if (revision === undefined) throw new Error("Synthetic project revision was not returned");
  return revision;
}

test("deal-cost HTTP flow preserves QBO scope, allocation, revision and stale-source controls", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  const [source, rehabSource, staleSource, unscopedSource] = await seedSyntheticQboPurchase(fixture.executor, {
    objectId: "purchase-deal-cost-1",
    txnDate: "2026-09-20",
    lines: [
      { id: "1", amount: "100.00", description: "Synthetic acquisition expense" },
      { id: "2", amount: "50.00", description: "Synthetic rehab actual" },
      { id: "3", amount: "20.00", description: "Synthetic stale source" },
      { id: "4", amount: "10.00", description: "Synthetic unallocated actual" },
    ],
  });
  const executor = await createSyntheticRuntimeExecutor(fixture.db);
  const services = createCompanyServices(executor, { accounting: { environment: {} } });
  const resolvePrincipal = (connection = executor) => loadAuthenticatedPrincipal(connection, { actorId, organizationId, role: "admin" });
  const access = { principal: await resolvePrincipal(), resolvePrincipal, transport: attestTransport("web") };
  const scope = companyScopeSchema.parse({ organizationId, legalEntityId: entityId, propertyId });
  const envelope = (payload: Record<string, unknown>, expectedRevision?: number) => ({
    operationId: randomUUID(),
    idempotencyKey: `deal-cost-http:${randomUUID()}`,
    scope,
    effectiveDate: "2026-09-22",
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    payload,
  });
  const projectReceipt = await services.projects.execute("project.create", envelope({ propertyId, name: "Synthetic flip", projectType: "rehab", status: "active", startOn: "2026-09-01", targetOn: "2026-10-15" }), access);
  const projectId = String(projectReceipt.affectedRecordIds[0]);
  let revision = projectRevision(projectReceipt, projectId);
  const scopeItem = await services.projects.execute("project.scope_item.create", envelope({ projectId, description: "Synthetic completed rehab", quantity: "1", rateCents: "100000" }, revision), access);
  const scopeItemId = String(scopeItem.affectedRecordIds[0]);
  revision = projectRevision(scopeItem, projectId);
  const budget = await services.projects.execute("project.budget.approve", envelope({ projectId }, revision), access);
  revision = projectRevision(budget, projectId);
  const etc = await services.projects.executeExecution!("project.etc_override.set", envelope({ projectId, scopeItemId, amountCents: "0", reason: "Synthetic rehab is complete" }, revision), access);
  revision = projectRevision(etc, projectId);

  const app = express();
  app.use(express.json());
  registerCompanyRoutes(app, {
    executor,
    projects: services.projects,
    requireAdmin: (request, _response, next) => {
      request.rentOpsAdminUser = { id: actorId, role: "admin" } as any;
      next();
    },
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const origin = `http://127.0.0.1:${(listener.address() as { port: number }).port}`;
  const commandPath = (kind: string) => `${origin}/api/company/${organizationId}/project-commands/${encodeURIComponent(kind)}`;
  const reportPath = `${origin}/api/company/${organizationId}/projects/${projectId}/deal-costs?legalEntityId=${entityId}&propertyId=${propertyId}`;
  try {
    const createBody = {
      operationId: randomUUID(),
      idempotencyKey: `deal-cost-qbo:${randomUUID()}`,
      scope,
      effectiveDate: "2026-09-22",
      expectedRevision: revision,
      payload: {
        projectId,
        lane: "acquisition",
        description: "Synthetic acquisition expense",
        vendorName: null,
        budgetCents: null,
        amountCents: "6000",
        forecastCents: "0",
        paidCents: null,
        incurredOn: "2026-09-20",
        paidOn: null,
        prepaid: false,
        sourceKind: "qbo",
        reconciliationState: "qbo_verified",
        sourceRecordRef: null,
        sourceReferenceHash: null,
        source,
        settlementProof: null,
      },
    };
    const firstCreate = await fetch(commandPath("project.deal_cost.create"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(createBody) });
    assert.equal(firstCreate.status, 200, await firstCreate.clone().text());
    const firstReceipt = await firstCreate.json() as { affectedRecordIds: string[]; resultingRevisions: { recordId: string; revision: number }[] };
    const dealCostId = String(firstReceipt.affectedRecordIds[0]);
    revision = projectRevision(firstReceipt, projectId);
    const replay = await fetch(commandPath("project.deal_cost.create"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(createBody) });
    assert.equal(replay.status, 200, await replay.clone().text());
    assert.deepEqual(await replay.json(), firstReceipt, "the identical HTTP envelope returns the original receipt");
    assert.equal((await createQboAccountingMirrorStore(fixture.executor).getBalance(source!)).allocatedCents, "6000");

    await assert.rejects(
      services.projects.executeExecution!("project.finance_binding.create", {
        operationId: randomUUID(),
        idempotencyKey: `deal-cost-realm-fence:${randomUUID()}`,
        scope,
        effectiveDate: "2026-09-22",
        expectedRevision: revision,
        payload: { projectId, source: { ...source!, realmId: "900101" }, allocatedCents: "1000" },
      }, access),
      /active deal classification in a different QBO environment or realm/,
      "an active deal classification fixes the project's QBO realm before legacy finance binding creation",
    );

    const expenseAsFunding = await fetch(commandPath("project.deal_funding.create"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operationId: randomUUID(),
        idempotencyKey: `deal-funding-expense-source:${randomUUID()}`,
        scope,
        effectiveDate: "2026-09-22",
        expectedRevision: revision,
        payload: {
          projectId,
          fundingKind: "loan_principal",
          description: "Expense line must not become funding",
          amountCents: "1000",
          fundedOn: "2026-09-20",
          sourceKind: "qbo",
          reconciliationState: "qbo_verified",
          sourceRecordRef: null,
          sourceReferenceHash: null,
          source,
          settlementProof: null,
        },
      }),
    });
    assert.equal(expenseAsFunding.status, 400, await expenseAsFunding.clone().text());

    // The deal ledger and an existing rehab binding are separate consumers of
    // the same QBO line. Both allocations must remain visible and releasable.
    const splitBinding = await services.projects.executeExecution!("project.finance_binding.create", {
      operationId: randomUUID(),
      idempotencyKey: `deal-cost-split-binding:${randomUUID()}`,
      scope,
      effectiveDate: "2026-09-22",
      expectedRevision: revision,
      payload: { projectId, source, scopeItemId, allocatedCents: "4000" },
    }, access);
    revision = projectRevision(splitBinding, projectId);
    assert.equal((await createQboAccountingMirrorStore(fixture.executor).getBalance(source!)).allocatedCents, "10000");

    const binding = await services.projects.executeExecution!("project.finance_binding.create", {
      operationId: randomUUID(),
      idempotencyKey: `deal-cost-rehab-binding:${randomUUID()}`,
      scope,
      effectiveDate: "2026-09-22",
      expectedRevision: revision,
      payload: { projectId, source: rehabSource, scopeItemId, allocatedCents: "3000" },
    }, access);
    revision = projectRevision(binding, projectId);
    assert.equal((await createQboAccountingMirrorStore(fixture.executor).getBalance(rehabSource!)).allocatedCents, "3000");

    const unscopedBinding = await services.projects.executeExecution!("project.finance_binding.create", {
      operationId: randomUUID(),
      idempotencyKey: `deal-cost-unscoped-binding:${randomUUID()}`,
      scope,
      effectiveDate: "2026-09-22",
      expectedRevision: revision,
      payload: { projectId, source: unscopedSource, allocatedCents: "1000" },
    }, access);
    revision = projectRevision(unscopedBinding, projectId);
    assert.equal((await createQboAccountingMirrorStore(fixture.executor).getBalance(unscopedSource!)).allocatedCents, "1000");

    const wrongEntitySource = { ...source!, legalEntityId: "20000000-0000-4000-8000-000000000099" };
    const wrongScope = { ...createBody, operationId: randomUUID(), idempotencyKey: `deal-cost-cross-entity:${randomUUID()}`, expectedRevision: revision, payload: { ...createBody.payload, source: wrongEntitySource } };
    const crossEntity = await fetch(commandPath("project.deal_cost.create"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(wrongScope) });
    assert.equal(crossEntity.status, 400);

    const updateBody = {
      operationId: randomUUID(),
      idempotencyKey: `deal-cost-update:${randomUUID()}`,
      scope,
      effectiveDate: "2026-09-22",
      expectedRevision: revision,
      payload: {
        dealCostId,
        description: "Synthetic acquisition expense reviewed",
        lane: "acquisition",
        amountCents: "6000",
        forecastCents: "0",
        sourceKind: "qbo",
        reconciliationState: "qbo_verified",
        source,
        sourceRecordRef: null,
        sourceReferenceHash: null,
        settlementProof: null,
      },
    };
    const updated = await fetch(commandPath("project.deal_cost.update"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(updateBody) });
    assert.equal(updated.status, 200, await updated.clone().text());
    revision = projectRevision(await updated.json() as { resultingRevisions: { recordId: string; revision: number }[] }, projectId);

    const beforeArchive = await fetch(reportPath);
    assert.equal(beforeArchive.status, 200, await beforeArchive.clone().text());
    const report = await beforeArchive.json() as { costs: readonly { id: string; reconciliationState: string; sourceKind: string; amountCents: string | null; lane: string }[]; coverage: { qboStatus: string }; byLane: readonly { lane: string; incurredCents: string | null }[] };
    assert.equal(report.coverage.qboStatus, "partial", "a project stream read does not prove full deal QBO coverage");
    assert.equal(report.byLane.find((row) => row.lane === "acquisition")?.incurredCents, "6000");
    assert.equal(report.byLane.find((row) => row.lane === "rehab")?.budgetCents, "100000", "the approved rehab budget is projected once");
    assert.equal(report.byLane.find((row) => row.lane === "rehab")?.remainingForecastCents, "0", "the canonical ETC override is projected once");
    assert.ok(report.costs.some((row) => row.sourceKind === "qbo" && row.amountCents === "4000" && row.lane === "rehab"), "a later rehab binding on the same QBO line remains visible");
    assert.ok(report.costs.some((row) => row.sourceKind === "qbo" && row.amountCents === "3000" && row.lane === "rehab"), "existing rehab QBO actuals are projected without a duplicate deal row");
    assert.ok(report.costs.some((row) => row.sourceKind === "qbo" && row.amountCents === "1000" && row.lane === "unallocated"), "an unscoped QBO actual stays visible in the needs-allocation lane");
    assert.equal(report.costs.find((row) => row.id === dealCostId)?.reconciliationState, "qbo_verified");

    const archived = await fetch(commandPath("project.deal_cost.archive"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId: randomUUID(), idempotencyKey: `deal-cost-archive:${randomUUID()}`, scope, effectiveDate: "2026-09-22", expectedRevision: revision, payload: { dealCostId } }) });
    assert.equal(archived.status, 200, await archived.clone().text());
    assert.equal((await createQboAccountingMirrorStore(fixture.executor).getBalance(source!)).allocatedCents, "4000", "archiving releases only the deal reservation and preserves the rehab binding");

    const staleCreate = { ...createBody, operationId: randomUUID(), idempotencyKey: `deal-cost-stale:${randomUUID()}`, expectedRevision: projectRevision(await archived.json() as { resultingRevisions: { recordId: string; revision: number }[] }, projectId), payload: { ...createBody.payload, source: staleSource, amountCents: "1000", description: "Synthetic stale source" } };
    const staleResponse = await fetch(commandPath("project.deal_cost.create"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(staleCreate) });
    assert.equal(staleResponse.status, 200, await staleResponse.clone().text());
    const staleReceipt = await staleResponse.json() as { affectedRecordIds: string[]; resultingRevisions: { recordId: string; revision: number }[] };
    const staleId = String(staleReceipt.affectedRecordIds[0]);
    // A source-backed QBO row must be downgraded too when its exact source
    // revision disappears; stale validation cannot trust the prior state.
    await fixture.db.query("UPDATE company_project_deal_ledger SET source_version = 'stale-version', reconciliation_state = 'source_backed' WHERE organization_id = $1 AND id = $2", [organizationId, staleId]);
    const staleReportResponse = await fetch(reportPath);
    assert.equal(staleReportResponse.status, 200, await staleReportResponse.clone().text());
    const staleReport = await staleReportResponse.json() as { coverage: { status: string; qboStatus: string }; costs: readonly { id: string; reconciliationState: string }[] };
    assert.equal(staleReport.coverage.status, "partial");
    assert.equal(staleReport.coverage.qboStatus, "partial");
    assert.equal(staleReport.costs.find((row) => row.id === staleId)?.reconciliationState, "unreconciled");
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    await fixture.close();
  }
});

test("deal-cost and rehab allocations share a QBO line in either order", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    const [dealFirstSource, rehabFirstSource] = await seedSyntheticQboPurchase(fixture.executor, {
      objectId: "purchase-deal-cost-ordering",
      txnDate: "2026-09-20",
      lines: [
        { id: "1", amount: "100.00", description: "Synthetic deal-first expense" },
        { id: "2", amount: "100.00", description: "Synthetic rehab-first expense" },
      ],
    });
    const executor = await createSyntheticRuntimeExecutor(fixture.db);
    const services = createCompanyServices(executor, { accounting: { environment: {} } });
    const resolvePrincipal = (connection = executor) => loadAuthenticatedPrincipal(connection, { actorId, organizationId, role: "admin" });
    const access = { principal: await resolvePrincipal(), resolvePrincipal, transport: attestTransport("web") };
    const scope = companyScopeSchema.parse({ organizationId, legalEntityId: entityId, propertyId });
    const envelope = (payload: Record<string, unknown>, expectedRevision?: number) => ({
      operationId: randomUUID(),
      idempotencyKey: `deal-cost-ordering:${randomUUID()}`,
      scope,
      effectiveDate: "2026-09-22",
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      payload,
    });
    const createProject = async (name: string) => {
      const receipt = await services.projects.execute("project.create", envelope({ propertyId, name, projectType: "rehab", status: "active", startOn: "2026-09-01", targetOn: "2026-10-15" }), access);
      return { id: String(receipt.affectedRecordIds[0]), revision: projectRevision(receipt, String(receipt.affectedRecordIds[0])) };
    };
    const createDealCost = (projectId: string, source: NonNullable<typeof dealFirstSource>, amountCents: string, expectedRevision: number) => services.projects.executeDealCost!("project.deal_cost.create", envelope({
      projectId,
      lane: "acquisition",
      description: "Synthetic acquisition expense",
      vendorName: null,
      budgetCents: null,
      amountCents,
      forecastCents: "0",
      paidCents: null,
      incurredOn: "2026-09-20",
      paidOn: null,
      prepaid: false,
      sourceKind: "qbo",
      reconciliationState: "qbo_verified",
      sourceRecordRef: null,
      sourceReferenceHash: null,
      source,
      settlementProof: null,
    }, expectedRevision), access);

    const dealFirst = await createProject("Synthetic deal-first ordering");
    const dealFirstReceipt = await createDealCost(dealFirst.id, dealFirstSource!, "6000", dealFirst.revision);
    const dealFirstBinding = await services.projects.executeExecution!("project.finance_binding.create", envelope({ projectId: dealFirst.id, source: dealFirstSource, allocatedCents: "4000" }, projectRevision(dealFirstReceipt, dealFirst.id)), access);
    assert.equal((await createQboAccountingMirrorStore(fixture.executor).getBalance(dealFirstSource!)).allocatedCents, "10000");
    assert.equal(projectRevision(dealFirstBinding, dealFirst.id) > projectRevision(dealFirstReceipt, dealFirst.id), true);

    const rehabFirst = await createProject("Synthetic rehab-first ordering");
    const rehabFirstBinding = await services.projects.executeExecution!("project.finance_binding.create", envelope({ projectId: rehabFirst.id, source: rehabFirstSource, allocatedCents: "4000" }, rehabFirst.revision), access);
    let rehabFirstRevision = projectRevision(rehabFirstBinding, rehabFirst.id);
    assert.equal((await createQboAccountingMirrorStore(fixture.executor).getBalance(rehabFirstSource!)).allocatedCents, "4000");
    await assert.rejects(
      createDealCost(rehabFirst.id, rehabFirstSource!, "7000", rehabFirstRevision),
      /allocation exceeds its available balance|allocation exceeds the source line/i,
      "the central allocator rejects a split that exceeds the QBO line balance",
    );
    assert.equal((await createQboAccountingMirrorStore(fixture.executor).getBalance(rehabFirstSource!)).allocatedCents, "4000");
    const rehabFirstDeal = await createDealCost(rehabFirst.id, rehabFirstSource!, "6000", rehabFirstRevision);
    rehabFirstRevision = projectRevision(rehabFirstDeal, rehabFirst.id);
    assert.equal(rehabFirstRevision > projectRevision(rehabFirstBinding, rehabFirst.id), true);
    assert.equal((await createQboAccountingMirrorStore(fixture.executor).getBalance(rehabFirstSource!)).allocatedCents, "10000");
  } finally {
    await fixture.close();
  }
});
