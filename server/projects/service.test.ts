import assert from "node:assert/strict";
import test from "node:test";
import {
  attestTransport,
  createAuthenticatedPrincipal,
  loadAuthenticatedPrincipal,
} from "../company/authorization";
import { newOperationId } from "../../shared/company";
import { createSyntheticCompanyDatabase, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { ProjectService } from "./service";
import { executeProjectCommand } from "./commands";
import type { CompanyScope } from "../../shared/company";

const scope: CompanyScope = {
  organizationId: SYNTHETIC_COMPANY.organizationId as CompanyScope["organizationId"],
  legalEntityId: SYNTHETIC_COMPANY.entityId as CompanyScope["legalEntityId"],
  propertyId: SYNTHETIC_COMPANY.propertyId,
};

function envelope(payload: Record<string, unknown>, expectedRevision?: number) {
  return {
    operationId: newOperationId(),
    idempotencyKey: `project-test-${newOperationId()}`,
    scope,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    effectiveDate: "2026-09-21",
    payload,
  };
}

async function fixturePrincipal(executor: Parameters<typeof loadAuthenticatedPrincipal>[0]) {
  return loadAuthenticatedPrincipal(executor, {
    actorId: SYNTHETIC_COMPANY.actorId,
    organizationId: SYNTHETIC_COMPANY.organizationId,
    role: "admin",
  });
}

test("project service stores property-scoped projects, exact budget snapshots, task dependencies and draft costs", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    const { executor, db } = fixture;
    const principal = await fixturePrincipal(executor);
    const transport = attestTransport("web");
    const options = {
      principal,
      transport,
      resolvePrincipal: (tx: typeof executor) => fixturePrincipal(tx),
    };
    const createReceipt = await executeProjectCommand(executor, "project.create", envelope({
      propertyId: SYNTHETIC_COMPANY.propertyId,
      unitId: SYNTHETIC_COMPANY.unitId,
      name: "Unit 1A rehab",
      projectType: "unit_turn",
      description: "Synthetic project",
      status: "planning",
      startOn: "2026-09-21",
      targetOn: "2026-10-10",
    }), options);
    const projectId = String(createReceipt.affectedRecordIds[0]);
    assert.equal(createReceipt.state, "saved_in_rops");
    assert.equal(createReceipt.resultingRevisions[0]?.revision, 1);

    const itemReceipt = await executeProjectCommand(executor, "project.scope_item.create", envelope({
      projectId,
      description: "Paint",
      quantity: "2.5",
      rateCents: "12500",
      unitLabel: "room",
    }), options);
    assert.equal(itemReceipt.state, "saved_in_rops");
    const scopeItemId = String(itemReceipt.affectedRecordIds[0]);

    const projectRevisionAfterItem = Number(itemReceipt.resultingRevisions.find((entry) => String(entry.recordId) === projectId)?.revision ?? 1);
    const budgetReceipt = await executeProjectCommand(executor, "project.budget.approve", envelope({ projectId }, projectRevisionAfterItem), options);
    assert.equal(budgetReceipt.state, "saved_in_rops");
    assert.equal(budgetReceipt.resultingRevisions[0]?.revision, 3);
    await assert.rejects(db.query(`INSERT INTO company_project_budget_lines
      (id,organization_id,budget_version_id,scope_item_id,position,description,quantity,rate_cents,estimated_cents)
      VALUES ($1,$2,$3,$4,99,'Late line',1,100,100)`,
      [newOperationId(), SYNTHETIC_COMPANY.organizationId, budgetReceipt.affectedRecordIds[1], scopeItemId]),
      /company_approved_budget_lines_immutable/);

    const taskOneReceipt = await executeProjectCommand(executor, "project.task.create", envelope({ projectId, title: "Prep", startsOn: "2026-09-21", dueOn: "2026-09-22" }), options);
    const taskOne = String(taskOneReceipt.affectedRecordIds[0]);
    const taskTwoReceipt = await executeProjectCommand(executor, "project.task.create", envelope({ projectId, title: "Paint", dependencyTaskIds: [taskOne] }), options);
    const taskTwo = String(taskTwoReceipt.affectedRecordIds[0]);
    const projectRevisionAfterTasks = Number(taskTwoReceipt.resultingRevisions.find((entry) => String(entry.recordId) === projectId)?.revision ?? 1);
    await assert.rejects(
      executeProjectCommand(executor, "project.task.dependencies.set", envelope({ taskId: taskOne, dependencyTaskIds: [taskTwo] }, projectRevisionAfterTasks), options),
      (error: unknown) => (error as { code?: string; details?: { reason?: string } }).code === "conflict"
        && (error as { details?: { reason?: string } }).details?.reason === "task_dependency_cycle",
    );

    const costReceipt = await executeProjectCommand(executor, "project.draft_cost.create", envelope({
      projectId,
      scopeItemId,
      description: "Paint deposit",
      amountCents: "1250",
      incurredOn: "2026-09-21",
      vendorName: "Synthetic vendor",
    }), options);
    assert.equal(costReceipt.state, "saved_in_rops");

    await db.query(
      `INSERT INTO company_project_posted_actuals
        (id, organization_id, project_id, provider, source_scope, external_id, description, amount_cents, currency, posted_on)
       VALUES ('50000000-0000-4000-8000-000000000001',$1,$2,'qbo','synthetic-realm','txn-1','QBO credit','-250','USD','2026-09-21')`,
      [SYNTHETIC_COMPANY.organizationId, projectId],
    );

    const service = new ProjectService(executor);
    const readPrincipal = await fixturePrincipal(executor);
    const detail = await service.get(readPrincipal, { scope, projectId, asOf: "2026-09-21" });
    assert.equal(detail.name, "Unit 1A rehab");
    assert.equal(detail.description, "Synthetic project");
    assert.equal(detail.projectType, "unit_turn");
    assert.equal(detail.scopeItems[0]?.estimatedCents, "31250");
    assert.equal(detail.budgetVersions[0]?.totalEstimatedCents, "31250");
    assert.equal(detail.tasks.length, 2);
    assert.deepEqual(detail.tasks.find((task) => task.id === taskTwo)?.dependencyTaskIds, [taskOne]);
    assert.equal(detail.draftCosts[0]?.amountCents, "1250");
    assert.equal(detail.postedActuals[0]?.amountCents, "-250");

    const page = await service.list(readPrincipal, { scope, asOf: "2026-09-21", limit: 1 });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.id, projectId);
  } finally {
    await fixture.close();
  }
});

test("project reads reject a principal outside the paired company grant", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    const service = new ProjectService(fixture.executor);
    const untrusted = createAuthenticatedPrincipal({
      actorId: "other-admin",
      organizationId: SYNTHETIC_COMPANY.organizationId,
      role: "admin",
      authorizedScopes: [],
    });
    await assert.rejects(
      service.list(untrusted, { scope, limit: 10 }),
      (error: unknown) => (error as { code?: string }).code === "forbidden",
    );
  } finally {
    await fixture.close();
  }
});

test("dependency-only task updates persist the task revision returned in the receipt", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    const { executor, db } = fixture;
    const principal = await fixturePrincipal(executor);
    const options = {
      principal,
      transport: attestTransport("web"),
      resolvePrincipal: (tx: typeof executor) => fixturePrincipal(tx),
    };
    const createProject = await executeProjectCommand(executor, "project.create", envelope({
      propertyId: SYNTHETIC_COMPANY.propertyId,
      name: "Dependency revision project",
    }), options);
    const projectId = String(createProject.affectedRecordIds[0]);
    const taskOne = String((await executeProjectCommand(executor, "project.task.create", envelope({
      projectId,
      title: "Prerequisite",
    }), options)).affectedRecordIds[0]);
    const taskTwoReceipt = await executeProjectCommand(executor, "project.task.create", envelope({
      projectId,
      title: "Dependent",
    }), options);
    const taskTwo = String(taskTwoReceipt.affectedRecordIds[0]);
    const projectRevision = Number(taskTwoReceipt.resultingRevisions.find((entry) => String(entry.recordId) === projectId)?.revision);

    const updateReceipt = await executeProjectCommand(executor, "project.task.update", envelope({
      taskId: taskTwo,
      dependencyTaskIds: [taskOne],
    }, projectRevision), options);
    assert.equal(updateReceipt.state, "saved_in_rops");
    assert.equal(updateReceipt.resultingRevisions.find((entry) => String(entry.recordId) === taskTwo)?.revision, 2);
    assert.equal(updateReceipt.resultingRevisions.find((entry) => String(entry.recordId) === projectId)?.revision, projectRevision + 1);

    const saved = await db.query<{ record_revision: number }>(
      `SELECT record_revision FROM company_project_tasks WHERE organization_id = $1 AND id = $2`,
      [SYNTHETIC_COMPANY.organizationId, taskTwo],
    );
    assert.equal(saved.rows[0]?.record_revision, 2);
    const detail = await new ProjectService(executor).get(await fixturePrincipal(executor), { scope, projectId, asOf: "2026-09-21" });
    assert.deepEqual(detail.tasks.find((task) => task.id === taskTwo)?.dependencyTaskIds, [taskOne]);
  } finally {
    await fixture.close();
  }
});

test("task archive rejects active dependents until their dependency is removed", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    const { executor } = fixture;
    const principal = await fixturePrincipal(executor);
    const options = {
      principal,
      transport: attestTransport("web"),
      resolvePrincipal: (tx: typeof executor) => fixturePrincipal(tx),
    };
    const createProject = await executeProjectCommand(executor, "project.create", envelope({
      propertyId: SYNTHETIC_COMPANY.propertyId,
      name: "Dependent archive project",
    }), options);
    const projectId = String(createProject.affectedRecordIds[0]);
    const taskOne = String((await executeProjectCommand(executor, "project.task.create", envelope({
      projectId,
      title: "Prerequisite",
    }), options)).affectedRecordIds[0]);
    const taskTwoReceipt = await executeProjectCommand(executor, "project.task.create", envelope({
      projectId,
      title: "Dependent",
      dependencyTaskIds: [taskOne],
    }), options);
    const taskTwo = String(taskTwoReceipt.affectedRecordIds[0]);
    const projectRevision = Number(taskTwoReceipt.resultingRevisions.find((entry) => String(entry.recordId) === projectId)?.revision);

    await assert.rejects(
      executeProjectCommand(executor, "project.task.archive", envelope({ taskId: taskOne }, projectRevision), options),
      (error: unknown) => (error as { code?: string; details?: { reason?: string; dependentTaskId?: string } }).code === "conflict"
        && (error as { details?: { reason?: string; dependentTaskId?: string } }).details?.reason === "task_has_active_dependents"
        && (error as { details?: { reason?: string; dependentTaskId?: string } }).details?.dependentTaskId === taskTwo,
    );

    const removeDependency = await executeProjectCommand(executor, "project.task.dependencies.set", envelope({
      taskId: taskTwo,
      dependencyTaskIds: [],
    }, projectRevision), options);
    const revisionAfterRemoval = Number(removeDependency.resultingRevisions.find((entry) => String(entry.recordId) === projectId)?.revision);
    const archiveReceipt = await executeProjectCommand(executor, "project.task.archive", envelope({ taskId: taskOne }, revisionAfterRemoval), options);
    assert.equal(archiveReceipt.state, "saved_in_rops");

    const detail = await new ProjectService(executor).get(await fixturePrincipal(executor), { scope, projectId, asOf: "2026-09-21" });
    assert.equal(detail.tasks.length, 1);
    assert.equal(detail.tasks[0]?.id, taskTwo);
    assert.deepEqual(detail.tasks[0]?.dependencyTaskIds, []);
  } finally {
    await fixture.close();
  }
});

test("ordinary project reads survive a later property/entity transfer while explicit as-of reads stay historical", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    const { executor, db } = fixture;
    const projectId = "50000000-0000-4000-8000-000000000001";
    const transferredEntityId = "20000000-0000-4000-8000-000000000002";
    await db.query(
      `INSERT INTO company_projects
        (id, organization_id, legal_entity_id, property_id, name, project_type, status, currency)
       VALUES ($1, $2, $3, $4, 'Transferred property project', 'rehab', 'planning', 'USD')`,
      [projectId, SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId, SYNTHETIC_COMPANY.propertyId],
    );
    await db.query(
      `INSERT INTO company_legal_entities(id, organization_id, name, entity_type, currency)
       VALUES ($1, $2, 'Successor Property LLC', 'llc', 'USD')`,
      [transferredEntityId, SYNTHETIC_COMPANY.organizationId],
    );
    await db.query(
      `UPDATE company_property_entity_periods
          SET effective_until = '2026-09-21'
        WHERE organization_id = $1 AND legal_entity_id = $2 AND property_id = $3`,
      [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId, SYNTHETIC_COMPANY.propertyId],
    );
    await db.query(
      `INSERT INTO company_property_entity_periods
        (id, organization_id, legal_entity_id, property_id, effective_from)
       VALUES ('30000000-0000-4000-8000-000000000002', $1, $2, $3, '2026-09-21')`,
      [SYNTHETIC_COMPANY.organizationId, transferredEntityId, SYNTHETIC_COMPANY.propertyId],
    );

    const principal = await fixturePrincipal(executor);
    const service = new ProjectService(executor);
    const ordinaryRead = await service.get(principal, { scope, projectId });
    assert.equal(ordinaryRead.id, projectId);
    const historicalRead = await service.get(principal, { scope, projectId, asOf: "2026-09-20" });
    assert.equal(historicalRead.id, projectId);
    await assert.rejects(
      service.get(principal, { scope, projectId, asOf: "2026-09-21" }),
      (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === "project_not_found",
    );
  } finally {
    await fixture.close();
  }
});
