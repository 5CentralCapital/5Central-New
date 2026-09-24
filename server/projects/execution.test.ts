import assert from "node:assert/strict";
import test from "node:test";
import {
  financialSourceCoverageSchema,
  financialSourceLineResolutionSchema,
  financialSourceReferenceSchema,
  type FinancialProviderCostContextPort,
  type FinancialSourceAllocationPort,
  type FinancialSourceReadPort,
} from "../../shared/accounting/source";
import { centsFromBigInt } from "../../shared/company";
import {
  attestTransport,
  loadAuthenticatedPrincipal,
} from "../company/authorization";
import { newOperationId } from "../../shared/company";
import {
  projectCommitmentSchema,
  projectExecutionDetailSchema,
  projectFinanceBindingSchema,
  projectFinanceActualSchema,
  unavailableProjectFinanceReadPort,
  type ProjectChangeOrder,
  type ProjectExecutionBudgetSnapshot,
} from "../../shared/projects";
import { createSyntheticCompanyDatabase, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { calculateProjectExecutionTotals, ProjectExecutionReadService, resolveProjectFinanceActuals, type ProjectFinanceBindingSource } from "./execution";
import { executeProjectExecutionCommand } from "./execution-commands";
import { createProjectExecutionStore, createProjectFinanceBindingStore } from "./execution-store";

const PROJECT_ID = "50000000-0000-4000-8000-000000000010";
const COMMITMENT_ID = "51000000-0000-4000-8000-000000000010";
const SOURCE_ID = "52000000-0000-4000-8000-000000000010";
const SOURCE = financialSourceReferenceSchema.parse({
  provider: "qbo",
  organizationId: SYNTHETIC_COMPANY.organizationId,
  legalEntityId: SYNTHETIC_COMPANY.entityId,
  environment: "sandbox",
  realmId: "12345",
  objectType: "Bill",
  objectId: "bill-42",
  lineId: "1",
  version: "v1",
});
const SCOPE = {
  provider: SOURCE.provider,
  organizationId: SOURCE.organizationId,
  legalEntityId: SOURCE.legalEntityId,
  environment: SOURCE.environment,
  realmId: SOURCE.realmId,
};

function costContextForLine(line: ReturnType<typeof financialSourceLineResolutionSchema.parse>): FinancialProviderCostContextPort {
  return {
    async readCostContext() {
      return {
        source: line.source,
        accountObjectId: line.accountObjectId ?? "synthetic-expense-account",
        accountType: "Expense",
        accountSubType: null,
        classification: "expense",
        eligible: true,
        amountCents: line.amountCents,
        currency: line.currency,
        postedOn: line.postedOn ?? "2026-09-20",
        postingState: "posted",
        providerUpdatedAt: line.watermark.observedAt,
        watermark: line.watermark,
      };
    },
  };
}

const BUDGETS: readonly ProjectExecutionBudgetSnapshot[] = [
  { versionNo: 1, status: "approved", totalEstimatedCents: "100000" as ProjectExecutionBudgetSnapshot["totalEstimatedCents"] },
  { versionNo: 2, status: "approved", totalEstimatedCents: "110000" as ProjectExecutionBudgetSnapshot["totalEstimatedCents"] },
];
const COMMITMENTS = [
  projectCommitmentSchema.parse({
    id: COMMITMENT_ID,
    projectId: PROJECT_ID,
    vendorId: null,
    bidId: null,
    description: "Synthetic electrical contract",
    status: "approved",
    originalCents: "60000",
    approvedChangeCents: "0",
    committedCents: "60000",
    currency: "USD",
    startOn: null,
    targetOn: null,
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
  }),
  projectCommitmentSchema.parse({
    id: "51000000-0000-4000-8000-000000000011",
    projectId: PROJECT_ID,
    vendorId: null,
    bidId: null,
    description: "Synthetic flooring contract",
    status: "closed",
    originalCents: "20000",
    approvedChangeCents: "0",
    committedCents: "20000",
    currency: "USD",
    startOn: null,
    targetOn: null,
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
  }),
];
const CHANGE_ORDERS: readonly ProjectChangeOrder[] = [{
  id: "53000000-0000-4000-8000-000000000010",
  projectId: PROJECT_ID,
  commitmentId: COMMITMENT_ID,
  description: "Electrical panel allowance",
  reason: "Required by inspection",
  status: "approved",
  amountCents: "8000",
  currency: "USD",
  includedInBudgetVersionId: null,
  submittedOn: "2026-09-21",
  approvedOn: "2026-09-21",
  createdAt: "2026-09-21T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
}];

test("canonical project execution migration applies in isolated PGlite", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    const rows = await fixture.db.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE 'company_project_%'
        ORDER BY table_name`,
    );
    const names = new Set(rows.rows.map((row) => row.table_name));
    for (const name of [
      "company_project_templates",
      "company_project_template_scope_items",
      "company_project_template_tasks",
      "company_project_assignments",
      "company_project_milestones",
      "company_project_inspections",
      "company_project_punch_items",
      "company_project_vendors",
      "company_project_bids",
      "company_project_commitments",
      "company_project_change_orders",
      "company_project_purchase_orders",
      "company_project_draw_requests",
      "company_project_draw_request_items",
      "company_project_finance_bindings",
    ]) assert.equal(names.has(name), true, `${name} should be present`);
  } finally {
    await fixture.close();
  }
});

test("execution totals preserve snapshots and do not double count commitment actuals", () => {
  const actual = projectFinanceActualSchema.parse({
    id: SOURCE_ID,
    projectId: PROJECT_ID,
    commitmentId: COMMITMENT_ID,
    scopeItemId: null,
    source: SOURCE,
    description: "Synthetic posted bill",
    amountCents: "10000",
    currency: "USD",
    postedOn: "2026-09-20",
    sourceRevision: "v1",
  });
  const unlinked = projectFinanceActualSchema.parse({
    ...actual,
    id: "52000000-0000-4000-8000-000000000011",
    commitmentId: null,
    amountCents: "5000",
  });
  const totals = calculateProjectExecutionTotals({
    currency: "USD",
    budgets: BUDGETS,
    commitments: COMMITMENTS,
    changeOrders: CHANGE_ORDERS,
    actuals: [actual, unlinked],
    actualCoverage: "complete",
  });
  assert.equal(totals.originalBudgetCents, "100000");
  assert.equal(totals.revisedBudgetCents, "118000");
  assert.equal(totals.commitmentCents, "80000");
  assert.equal(totals.linkedActualCents, "10000");
  assert.equal(totals.actualCents, "15000");
  assert.equal(totals.unspentCommitmentCents, "50000", "a closed commitment releases its unbilled balance");
  assert.equal(totals.remainingCents, "53000");
  const partial = calculateProjectExecutionTotals({
    currency: "USD",
    budgets: BUDGETS,
    commitments: COMMITMENTS,
    changeOrders: CHANGE_ORDERS,
    actuals: [actual, unlinked],
    actualCoverage: "partial",
  });
  assert.equal(partial.actualCents, "15000");
  assert.equal(partial.remainingCents, null);
  const unavailable = calculateProjectExecutionTotals({
    currency: "USD",
    budgets: BUDGETS,
    commitments: COMMITMENTS,
    changeOrders: CHANGE_ORDERS,
    actuals: [actual, unlinked],
    actualCoverage: "unavailable",
  });
  assert.equal(unavailable.actualCents, null);
  assert.equal(unavailable.remainingCents, null);
});

test("finance bindings use reserved allocation and downgrade stale or ineligible source lines", async () => {
  const coverage = financialSourceCoverageSchema.parse({
    scope: SCOPE,
    status: "complete",
    evidence: "live_provider_readback",
    basis: "source_transactions",
    watermark: { value: "synthetic-watermark", observedAt: "2026-09-21T00:00:00.000Z" },
    coveredFrom: "2026-01-01",
    coveredThrough: "2026-12-31",
    observedAt: "2026-09-21T00:00:00.000Z",
    objectCount: 1,
    transactionCount: 1,
    lineCount: 1,
    missingIntervals: [],
    reason: null,
  });
  const line = financialSourceLineResolutionSchema.parse({
    source: SOURCE,
    direction: "debit",
    flow: "outgoing",
    lineRole: "expense",
    amountCents: "10000",
    currency: "USD",
    transactionType: "Bill",
    accountObjectId: "expense-account",
    counterpartyObjectId: "vendor-42",
    description: "Synthetic posted bill",
    postingState: "posted",
    postedOn: "2026-09-20",
    settlement: { state: "unknown", settledOn: null, settledAmountCents: null },
    watermark: coverage.watermark,
  });
  let requestedVersion: string | undefined = "not-read";
  const source: FinancialSourceReadPort = {
    async resolveLine(query) { requestedVersion = query.version; return line; },
    async readCoverage() { return coverage; },
    async listTransactions() { return { items: [line], nextCursor: null, coverage }; },
  };
  const bindings: ProjectFinanceBindingSource = {
    async listProjectBindings() {
      return [projectFinanceBindingSchema.parse({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        commitmentId: COMMITMENT_ID,
        scopeItemId: null,
        source: SOURCE,
        allocatedCents: "2500",
        eligible: true,
        bindingStatus: "verified",
      })];
    },
  };
  const result = await resolveProjectFinanceActuals(source, bindings, costContextForLine(line), { organizationId: SYNTHETIC_COMPANY.organizationId, projectId: PROJECT_ID });
  assert.equal(result.coverage, "complete");
  assert.equal(result.actuals[0]?.amountCents, "2500");
  assert.equal(requestedVersion, undefined);

  const oversizedBindings: ProjectFinanceBindingSource = {
    async listProjectBindings() {
      return [projectFinanceBindingSchema.parse({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        commitmentId: COMMITMENT_ID,
        scopeItemId: null,
        source: SOURCE,
        allocatedCents: "15000",
        eligible: true,
        bindingStatus: "verified",
      })];
    },
  };
  const oversized = await resolveProjectFinanceActuals(source, oversizedBindings, costContextForLine(line), { organizationId: SYNTHETIC_COMPANY.organizationId, projectId: PROJECT_ID });
  assert.equal(oversized.coverage, "partial");
  assert.equal(oversized.actuals.length, 0);

  const unknownAccountContext: FinancialProviderCostContextPort = {
    async readCostContext(query) {
      const valid = await costContextForLine(line).readCostContext(query);
      return valid ? { ...valid, classification: "unknown" as const, eligible: false } : null;
    },
  };
  const held = await resolveProjectFinanceActuals(source, bindings, unknownAccountContext, { organizationId: SYNTHETIC_COMPANY.organizationId, projectId: PROJECT_ID });
  assert.equal(held.coverage, "partial");
  assert.equal(held.actuals.length, 0);

  const releasedAndVerified: ProjectFinanceBindingSource = {
    async listProjectBindings() {
      return [
        projectFinanceBindingSchema.parse({
          id: SOURCE_ID,
          projectId: PROJECT_ID,
          commitmentId: COMMITMENT_ID,
          scopeItemId: null,
          source: SOURCE,
          allocatedCents: "2500",
          eligible: true,
          bindingStatus: "verified",
        }),
        projectFinanceBindingSchema.parse({
          id: "52000000-0000-4000-8000-000000000011",
          projectId: PROJECT_ID,
          commitmentId: COMMITMENT_ID,
          scopeItemId: null,
          source: SOURCE,
          allocatedCents: "1000",
          eligible: false,
          bindingStatus: "released",
        }),
      ];
    },
  };
  const afterRelease = await resolveProjectFinanceActuals(source, releasedAndVerified, costContextForLine(line), { organizationId: SYNTHETIC_COMPANY.organizationId, projectId: PROJECT_ID });
  assert.equal(afterRelease.coverage, "complete");
  assert.deepEqual(afterRelease.actuals.map((actual) => actual.amountCents), ["2500"], "released history must not keep current project coverage partial or duplicate an actual");
});

test("project cost coverage follows the bound QBO stream without hiding aggregate uncertainty", async () => {
  const line = financialSourceLineResolutionSchema.parse({
    source: SOURCE,
    direction: "debit",
    flow: "outgoing",
    lineRole: "expense",
    amountCents: "10000",
    currency: "USD",
    transactionType: "Bill",
    accountObjectId: "expense-account",
    counterpartyObjectId: "vendor-42",
    description: "Synthetic posted bill",
    postingState: "posted",
    postedOn: "2026-09-20",
    settlement: { state: "unknown", settledOn: null, settledAmountCents: null },
    watermark: { value: "stream-watermark", observedAt: "2026-09-21T00:00:00.000Z" },
  });
  const aggregateCoverage = financialSourceCoverageSchema.parse({
    scope: SCOPE,
    stream: "aggregate",
    status: "partial",
    evidence: "live_provider_readback",
    basis: "source_transactions",
    watermark: { value: "aggregate-watermark", observedAt: "2026-09-21T00:00:00.000Z" },
    coveredFrom: "2026-01-01",
    coveredThrough: "2026-12-31",
    observedAt: "2026-09-21T00:00:00.000Z",
    objectCount: 2,
    transactionCount: 2,
    lineCount: 1,
    missingIntervals: [],
    reason: "One unrelated QBO account object remains unresolved",
  });
  const billCoverage = financialSourceCoverageSchema.parse({
    ...aggregateCoverage,
    stream: "transactions.bill",
    status: "complete",
    reason: null,
  });
  const bindingSource: ProjectFinanceBindingSource = {
    async listProjectBindings() {
      return [projectFinanceBindingSchema.parse({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        commitmentId: COMMITMENT_ID,
        scopeItemId: null,
        source: SOURCE,
        allocatedCents: "2500",
        eligible: true,
        bindingStatus: "verified",
      })];
    },
  };
  const requestedStreams: (string | undefined)[] = [];
  let relevantCoverage = billCoverage;
  const source: FinancialSourceReadPort = {
    async resolveLine() { return line; },
    async readCoverage(_scope, stream) {
      requestedStreams.push(stream);
      return stream === "transactions.bill" ? relevantCoverage : aggregateCoverage;
    },
    async listTransactions() { return { items: [line], nextCursor: null, coverage: relevantCoverage }; },
  };
  const complete = await resolveProjectFinanceActuals(source, bindingSource, costContextForLine(line), { organizationId: SYNTHETIC_COMPANY.organizationId, projectId: PROJECT_ID });
  assert.equal(complete.coverage, "complete", "an unrelated aggregate exception must not downgrade a fully covered bound Bill stream");
  assert.deepEqual(requestedStreams, ["transactions.bill"]);
  assert.equal(complete.actuals[0]?.amountCents, "2500");

  relevantCoverage = financialSourceCoverageSchema.parse({ ...billCoverage, status: "partial", reason: "The bound Bill stream has an unresolved object" });
  const partial = await resolveProjectFinanceActuals(source, bindingSource, costContextForLine(line), { organizationId: SYNTHETIC_COMPANY.organizationId, projectId: PROJECT_ID });
  assert.equal(partial.coverage, "partial", "relevant stream uncertainty must remain visible even when the exact line resolves");
  assert.equal(partial.actuals[0]?.amountCents, "2500");
});

test("a Purchase credit keeps a Purchase-bound project cost report partial", async () => {
  const purchaseSource = financialSourceReferenceSchema.parse({ ...SOURCE, objectType: "Purchase", objectId: "purchase-42" });
  const refundSource = financialSourceReferenceSchema.parse({ ...SOURCE, objectType: "Purchase", objectId: "purchase-refund-42" });
  const coverage = financialSourceCoverageSchema.parse({
    scope: SCOPE,
    stream: "transactions.purchase",
    status: "complete",
    evidence: "live_provider_readback",
    basis: "source_transactions",
    watermark: { value: "purchase-watermark", observedAt: "2026-09-21T00:00:00.000Z" },
    coveredFrom: "2026-01-01",
    coveredThrough: "2026-12-31",
    observedAt: "2026-09-21T00:00:00.000Z",
    objectCount: 2,
    transactionCount: 2,
    lineCount: 2,
    missingIntervals: [],
    reason: null,
  });
  const purchaseLine = financialSourceLineResolutionSchema.parse({
    source: purchaseSource,
    direction: "debit",
    flow: "outgoing",
    lineRole: "expense",
    amountCents: "10000",
    currency: "USD",
    transactionType: "Purchase",
    accountObjectId: "expense-account",
    counterpartyObjectId: "vendor-42",
    description: "Synthetic posted purchase",
    postingState: "posted",
    postedOn: "2026-09-20",
    settlement: { state: "unknown", settledOn: null, settledAmountCents: null },
    watermark: coverage.watermark,
  });
  const refundLine = financialSourceLineResolutionSchema.parse({
    source: refundSource,
    direction: "credit",
    flow: "incoming",
    lineRole: "expense",
    amountCents: "2500",
    currency: "USD",
    transactionType: "Purchase",
    accountObjectId: "expense-account",
    counterpartyObjectId: "vendor-42",
    description: "Synthetic purchase refund",
    postingState: "posted",
    postedOn: "2026-09-21",
    settlement: { state: "unknown", settledOn: null, settledAmountCents: null },
    watermark: coverage.watermark,
  });
  let listTransactionsCalls = 0;
  let hasPurchaseCreditsCalls = 0;
  const source: FinancialSourceReadPort = {
    async resolveLine() { return purchaseLine; },
    async readCoverage() { return coverage; },
    async listTransactions() {
      listTransactionsCalls += 1;
      return { items: [purchaseLine, refundLine], nextCursor: null, coverage };
    },
    async hasPurchaseCredits(_scope, through) {
      hasPurchaseCreditsCalls += 1;
      assert.equal(through, "2026-09-21");
      return true;
    },
  };
  const bindings: ProjectFinanceBindingSource = {
    async listProjectBindings() {
      return [projectFinanceBindingSchema.parse({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        commitmentId: COMMITMENT_ID,
        scopeItemId: null,
        source: purchaseSource,
        allocatedCents: "2500",
        eligible: true,
        bindingStatus: "verified",
      })];
    },
  };
  const result = await resolveProjectFinanceActuals(source, bindings, costContextForLine(purchaseLine), {
    organizationId: SYNTHETIC_COMPANY.organizationId,
    projectId: PROJECT_ID,
    asOf: "2026-09-21",
  });
  assert.equal(result.coverage, "partial");
  assert.deepEqual(result.actuals.map((actual) => actual.amountCents), ["2500"]);
  assert.equal(hasPurchaseCreditsCalls, 1);
  assert.equal(listTransactionsCalls, 0, "project coverage uses the narrow provider probe instead of scanning all lines");

  const withoutProbe: FinancialSourceReadPort = { ...source, hasPurchaseCredits: undefined };
  const unavailable = await resolveProjectFinanceActuals(withoutProbe, bindings, costContextForLine(purchaseLine), {
    organizationId: SYNTHETIC_COMPANY.organizationId,
    projectId: PROJECT_ID,
    asOf: "2026-09-21",
  });
  assert.equal(unavailable.coverage, "partial", "missing provider probe must fail closed");
  assert.equal(listTransactionsCalls, 0);
});

test("execution create commands persist through one idempotent company command path", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    await fixture.db.query(
      `INSERT INTO company_projects
        (id, organization_id, legal_entity_id, property_id, name, project_type, status, start_on, currency)
       VALUES ($1,$2,$3,$4,'Execution command project','rehab','planning','2026-09-21','USD')`,
      [PROJECT_ID, SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId, SYNTHETIC_COMPANY.propertyId],
    );
    await fixture.db.query(
      `INSERT INTO company_contacts (id, organization_id, kind, display_name)
       VALUES ('55000000-0000-4000-8000-000000000010',$1,'person','Synthetic project manager')`,
      [SYNTHETIC_COMPANY.organizationId],
    );
    await fixture.db.query(
      `INSERT INTO company_contact_roles (id, organization_id, contact_id, legal_entity_id, role, effective_from)
       VALUES ('56000000-0000-4000-8000-000000000010',$1,'55000000-0000-4000-8000-000000000010',$2,'employee','2026-01-01')`,
      [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId],
    );
    const principal = await loadAuthenticatedPrincipal(fixture.executor, {
      actorId: SYNTHETIC_COMPANY.actorId,
      organizationId: SYNTHETIC_COMPANY.organizationId,
      role: "admin",
    });
    const options = {
      principal,
      transport: attestTransport("web"),
      resolvePrincipal: (executor: typeof fixture.executor) => loadAuthenticatedPrincipal(executor, {
        actorId: SYNTHETIC_COMPANY.actorId,
        organizationId: SYNTHETIC_COMPANY.organizationId,
        role: "admin",
      }),
    };
    const scope = {
      organizationId: SYNTHETIC_COMPANY.organizationId,
      legalEntityId: SYNTHETIC_COMPANY.entityId,
      propertyId: SYNTHETIC_COMPANY.propertyId,
    };
    const organizationScope = { organizationId: SYNTHETIC_COMPANY.organizationId };
    const envelope = (payload: Record<string, unknown>, expectedRevision?: number) => ({
      operationId: newOperationId(),
      idempotencyKey: `execution-test-${newOperationId()}`,
      scope,
      effectiveDate: "2026-09-21",
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      payload,
    });
    const organizationEnvelope = (payload: Record<string, unknown>) => ({
      operationId: newOperationId(),
      idempotencyKey: `execution-test-org-${newOperationId()}`,
      scope: organizationScope,
      effectiveDate: "2026-09-21",
      payload,
    });
    const templateReceipt = await executeProjectExecutionCommand(fixture.executor, "project.template.create", envelope({ name: "Turn template", projectType: "unit_turn", description: null, currency: "USD" }), options);
    const templateId = String(templateReceipt.affectedRecordIds[0]);
    await fixture.db.query(
      `INSERT INTO company_project_template_scope_items (id,organization_id,template_id,description,quantity,rate_cents,position)
       VALUES ('54000000-0000-4000-8000-000000000010',$1,$2,'Template paint',2,12500,0)`,
      [SYNTHETIC_COMPANY.organizationId, templateId],
    );
    await fixture.db.query(
      `INSERT INTO company_project_template_tasks (id,organization_id,template_id,title,relative_days,position)
       VALUES ('54000000-0000-4000-8000-000000000011',$1,$2,'Template inspection',7,0)`,
      [SYNTHETIC_COMPANY.organizationId, templateId],
    );
    const instantiate = await executeProjectExecutionCommand(fixture.executor, "project.template.instantiate", envelope({ projectId: PROJECT_ID, templateId, startOn: "2026-09-21" }, 1), options);
    let projectRevision = Number(instantiate.resultingRevisions.find((item) => String(item.recordId) === PROJECT_ID)?.revision);
    const vendor = await executeProjectExecutionCommand(fixture.executor, "project.vendor.create", organizationEnvelope({ name: "Synthetic vendor", notes: null }), options);
    const vendorId = String(vendor.affectedRecordIds[0]);
    const restrictedActor = "project-entity-admin";
    await fixture.db.query(
      `INSERT INTO company_access_grants(id,organization_id,actor_id,role,legal_entity_id)
       VALUES ('57000000-0000-4000-8000-000000000010',$1,$2,'admin',$3)`,
      [SYNTHETIC_COMPANY.organizationId, restrictedActor, SYNTHETIC_COMPANY.entityId],
    );
    const restrictedResolve = (executor: typeof fixture.executor) => loadAuthenticatedPrincipal(executor, {
      actorId: restrictedActor,
      organizationId: SYNTHETIC_COMPANY.organizationId,
      role: "admin",
    });
    const restrictedOptions = {
      principal: await restrictedResolve(fixture.executor),
      transport: attestTransport("web"),
      resolvePrincipal: restrictedResolve,
    };
    await assert.rejects(
      () => executeProjectExecutionCommand(fixture.executor, "project.vendor.update", envelope({ vendorId, name: "Unauthorized vendor rename" }), restrictedOptions),
      /scope level/,
      "an entity-scoped administrator cannot edit the organization-wide vendor registry",
    );
    const vendorRow = await fixture.db.query<{ name: string }>("SELECT name FROM company_project_vendors WHERE organization_id=$1 AND id=$2", [SYNTHETIC_COMPANY.organizationId, vendorId]);
    assert.equal(vendorRow.rows[0]?.name, "Synthetic vendor");
    const assignment = await executeProjectExecutionCommand(fixture.executor, "project.assignment.create", envelope({ projectId: PROJECT_ID, assigneeType: "vendor", assigneeRef: vendorId, role: "General contractor" }, projectRevision), options);
    projectRevision = Number(assignment.resultingRevisions.find((item) => String(item.recordId) === PROJECT_ID)?.revision);
    const milestone = await executeProjectExecutionCommand(fixture.executor, "project.milestone.create", envelope({ projectId: PROJECT_ID, name: "Rough inspection" }, projectRevision), options);
    projectRevision = Number(milestone.resultingRevisions.find((item) => String(item.recordId) === PROJECT_ID)?.revision);
    const inspection = await executeProjectExecutionCommand(fixture.executor, "project.inspection.create", envelope({ projectId: PROJECT_ID, inspectionType: "Rough" }, projectRevision), options);
    const inspectionId = String(inspection.affectedRecordIds[0]);
    projectRevision = Number(inspection.resultingRevisions.find((item) => String(item.recordId) === PROJECT_ID)?.revision);
    const punch = await executeProjectExecutionCommand(fixture.executor, "project.punch_item.create", envelope({ projectId: PROJECT_ID, inspectionId, description: "Seal trim" }, projectRevision), options);
    projectRevision = Number(punch.resultingRevisions.find((item) => String(item.recordId) === PROJECT_ID)?.revision);
    const bid = await executeProjectExecutionCommand(fixture.executor, "project.bid.create", envelope({ projectId: PROJECT_ID, vendorId, amountCents: "60000", notes: null }, projectRevision), options);
    const bidId = String(bid.affectedRecordIds[0]);
    projectRevision = Number(bid.resultingRevisions.find((item) => String(item.recordId) === PROJECT_ID)?.revision);
    const commitment = await executeProjectExecutionCommand(fixture.executor, "project.commitment.create", envelope({ projectId: PROJECT_ID, vendorId, bidId, description: "Contract", originalCents: "60000", currency: "USD" }, projectRevision), options);
    const commitmentId = String(commitment.affectedRecordIds[0]);
    projectRevision = Number(commitment.resultingRevisions.find((item) => String(item.recordId) === PROJECT_ID)?.revision);
    const changeOrder = await executeProjectExecutionCommand(fixture.executor, "project.change_order.create", envelope({ projectId: PROJECT_ID, commitmentId, description: "Panel", reason: "Inspection", amountCents: "8000", currency: "USD" }, projectRevision), options);
    projectRevision = Number(changeOrder.resultingRevisions.find((item) => String(item.recordId) === PROJECT_ID)?.revision);
    const purchaseOrder = await executeProjectExecutionCommand(fixture.executor, "project.purchase_order.create", envelope({ projectId: PROJECT_ID, commitmentId, poNumber: "PO-1", amountCents: "60000", currency: "USD" }, projectRevision), options);
    projectRevision = Number(purchaseOrder.resultingRevisions.find((item) => String(item.recordId) === PROJECT_ID)?.revision);
    const drawEnvelope = envelope({ projectId: PROJECT_ID, periodFrom: "2026-09-21", periodTo: "2026-09-30", retainagePercent: "10", currency: "USD" }, projectRevision);
    const draw = await executeProjectExecutionCommand(fixture.executor, "project.draw_request.create", drawEnvelope, options);
    const replay = await executeProjectExecutionCommand(fixture.executor, "project.draw_request.create", drawEnvelope, options);
    assert.equal(replay.operationId, draw.operationId);
    projectRevision = Number(draw.resultingRevisions.find((item) => String(item.recordId) === PROJECT_ID)?.revision ?? projectRevision);
    const drawId = String(draw.affectedRecordIds[0]);
    const update = async (kind: Parameters<typeof executeProjectExecutionCommand>[1], payload: Record<string, unknown>) => {
      const receipt = await executeProjectExecutionCommand(fixture.executor, kind as never, envelope(payload, projectRevision), options);
      projectRevision = Number(receipt.resultingRevisions.find((item) => String(item.recordId) === PROJECT_ID)?.revision ?? projectRevision);
      return receipt;
    };
    await update("project.assignment.update", { assignmentId: String(assignment.affectedRecordIds[0]), status: "accepted" });
    await update("project.milestone.update", { milestoneId: String(milestone.affectedRecordIds[0]), status: "complete" });
    await update("project.inspection.update", { inspectionId, status: "passed" });
    await update("project.punch_item.update", { punchItemId: String(punch.affectedRecordIds[0]), status: "complete" });
    await update("project.bid.update", { bidId, status: "submitted", submittedOn: "2026-09-21" });
    await update("project.commitment.update", { commitmentId, status: "approved", approvedChangeCents: "5000" });
    await update("project.change_order.update", { changeOrderId: String(changeOrder.affectedRecordIds[0]), status: "approved" });
    await update("project.purchase_order.update", { purchaseOrderId: String(purchaseOrder.affectedRecordIds[0]), status: "issued" });
    const item = await update("project.draw_request.item.create", { drawRequestId: drawId, sourceType: "commitment", sourceId: commitmentId, eligibleCents: "65000", requestedCents: "50000", retainageEligible: true, retainageCents: "5000" });
    await update("project.draw_request.item.update", { drawRequestItemId: String(item.affectedRecordIds[0]), requestedCents: "55000", retainageCents: "5500" });
    await assert.rejects(
      () => executeProjectExecutionCommand(fixture.executor, "project.draw_request.item.update", envelope({ drawRequestItemId: String(item.affectedRecordIds[0]), requestedCents: "66000" }, projectRevision), options),
      /Draw request exceeds the source eligibility|Draw item amounts are not eligible/,
    );
    // The edit form always resends the percent; item retainage stays authoritative.
    await update("project.draw_request.update", { drawRequestId: drawId, status: "submitted", retainagePercent: "5" });
    const executionSnapshot = await createProjectExecutionStore(fixture.executor).read({ scope, projectId: PROJECT_ID, asOf: "2026-09-21" });
    assert.equal(executionSnapshot.assigneeOptions.some((option) => option.label === "Synthetic project manager" && option.type === "employee"), true);
    assert.equal(executionSnapshot.assignments[0]?.status, "accepted");
    assert.equal(executionSnapshot.inspections[0]?.status, "passed");
    assert.equal(executionSnapshot.punchItems[0]?.status, "complete");
    assert.equal(executionSnapshot.bids[0]?.status, "submitted");
    assert.equal(executionSnapshot.commitments[0]?.committedCents, "65000");
    assert.equal(executionSnapshot.changeOrders[0]?.status, "approved");
    assert.equal(executionSnapshot.purchaseOrders[0]?.status, "issued");
    assert.equal(executionSnapshot.drawRequests[0]?.status, "submitted");
    assert.equal(executionSnapshot.drawRequests[0]?.grossEligibleCents, "55000");
    assert.equal(executionSnapshot.drawRequests[0]?.retainageCents, "5500");
    assert.equal(executionSnapshot.drawRequests[0]?.netRequestedCents, "49500");

    await update("project.draw_request.update", { drawRequestId: drawId, status: "paid" });
    await assert.rejects(
      () => executeProjectExecutionCommand(fixture.executor, "project.draw_request.update", envelope({ drawRequestId: drawId, notes: "Late edit" }, projectRevision), options),
      /Paid draw requests are immutable/,
    );
    await assert.rejects(
      () => executeProjectExecutionCommand(fixture.executor, "project.draw_request.item.update", envelope({ drawRequestItemId: String(item.affectedRecordIds[0]), requestedCents: "54000" }, projectRevision), options),
      /Paid draw requests are immutable/,
    );
    await assert.rejects(
      () => executeProjectExecutionCommand(fixture.executor, "project.draw_request.item.create", envelope({ drawRequestId: drawId, sourceType: "commitment", sourceId: commitmentId, eligibleCents: "65000", requestedCents: "1000", retainageEligible: true, retainageCents: "100" }, projectRevision), options),
      /Paid draw requests are immutable/,
    );
    const paidSnapshot = await createProjectExecutionStore(fixture.executor).read({ scope, projectId: PROJECT_ID, asOf: "2026-09-21" });
    assert.equal(paidSnapshot.drawRequests[0]?.status, "paid");
    const executionDetail = await new ProjectExecutionReadService(createProjectExecutionStore(fixture.executor), unavailableProjectFinanceReadPort).get(principal, { scope, projectId: PROJECT_ID, asOf: "2026-09-21" });
    assert.equal(projectExecutionDetailSchema.parse(executionDetail).projectId, PROJECT_ID);
    const counts = await fixture.db.query<{ assignments: string; milestones: string; inspections: string; punch: string; bids: string; commitments: string; changes: string; purchaseOrders: string; draws: string; scopes: string; tasks: string }>(
      `SELECT
        (SELECT count(*) FROM company_project_assignments WHERE project_id=$1)::text assignments,
        (SELECT count(*) FROM company_project_milestones WHERE project_id=$1)::text milestones,
        (SELECT count(*) FROM company_project_inspections WHERE project_id=$1)::text inspections,
        (SELECT count(*) FROM company_project_punch_items WHERE project_id=$1)::text punch,
        (SELECT count(*) FROM company_project_bids WHERE project_id=$1)::text bids,
        (SELECT count(*) FROM company_project_commitments WHERE project_id=$1)::text commitments,
        (SELECT count(*) FROM company_project_change_orders WHERE project_id=$1)::text changes,
        (SELECT count(*) FROM company_project_purchase_orders WHERE project_id=$1)::text "purchaseOrders",
        (SELECT count(*) FROM company_project_draw_requests WHERE project_id=$1)::text draws,
        (SELECT count(*) FROM company_project_scope_items WHERE project_id=$1)::text scopes,
        (SELECT count(*) FROM company_project_tasks WHERE project_id=$1)::text tasks`,
      [PROJECT_ID],
    );
    assert.deepEqual(counts.rows[0], { assignments: "1", milestones: "1", inspections: "1", punch: "1", bids: "1", commitments: "1", changes: "1", purchaseOrders: "1", draws: "1", scopes: "1", tasks: "1" });
  } finally {
    await fixture.close();
  }
});

test("finance binding commands require current verified source context and release the central reservation", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    await fixture.db.query(
      `INSERT INTO company_projects
        (id, organization_id, legal_entity_id, property_id, name, project_type, status, start_on, currency)
       VALUES ($1,$2,$3,$4,'Binding command project','rehab','planning','2026-09-21','USD')`,
      [PROJECT_ID, SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId, SYNTHETIC_COMPANY.propertyId],
    );
    const principal = await loadAuthenticatedPrincipal(fixture.executor, {
      actorId: SYNTHETIC_COMPANY.actorId,
      organizationId: SYNTHETIC_COMPANY.organizationId,
      role: "admin",
    });
    const options = {
      principal,
      transport: attestTransport("web"),
      resolvePrincipal: (executor: typeof fixture.executor) => loadAuthenticatedPrincipal(executor, {
        actorId: SYNTHETIC_COMPANY.actorId,
        organizationId: SYNTHETIC_COMPANY.organizationId,
        role: "admin",
      }),
    };
    const scope = {
      organizationId: SYNTHETIC_COMPANY.organizationId,
      legalEntityId: SYNTHETIC_COMPANY.entityId,
      propertyId: SYNTHETIC_COMPANY.propertyId,
    };
    const coverage = financialSourceCoverageSchema.parse({
      scope: SCOPE,
      status: "partial",
      evidence: "live_provider_readback",
      basis: "source_transactions",
      watermark: { value: "binding-watermark", observedAt: "2026-09-21T00:00:00.000Z" },
      coveredFrom: "2026-01-01",
      coveredThrough: "2026-12-31",
      observedAt: "2026-09-21T00:00:00.000Z",
      objectCount: 1,
      transactionCount: 1,
      lineCount: 1,
      missingIntervals: [],
      reason: null,
    });
    const line = financialSourceLineResolutionSchema.parse({
      source: SOURCE,
      direction: "debit",
      flow: "outgoing",
      lineRole: "expense",
      amountCents: "10000",
      currency: "USD",
      transactionType: "Bill",
      accountObjectId: "expense-account",
      counterpartyObjectId: "vendor-42",
      description: "Synthetic binding bill",
      postingState: "posted",
      postedOn: "2026-09-20",
      settlement: { state: "unknown", settledOn: null, settledAmountCents: null },
      watermark: coverage.watermark,
    });
    const source: FinancialSourceReadPort = {
      async resolveLine() { return line; },
      async readCoverage() { return coverage; },
      async listTransactions() { return { items: [line], nextCursor: null, coverage }; },
    };
    const costContext = costContextForLine(line);
    let reserved = BigInt(0);
    const allocations: FinancialSourceAllocationPort = {
      async getBalance(sourceReference) {
        return { source: sourceReference, lineAmountCents: "10000", allocatedCents: centsFromBigInt(reserved), availableCents: centsFromBigInt(BigInt(10000) - reserved), currency: "USD" };
      },
      async reserve(request) { reserved += BigInt(request.amountCents); return this.getBalance(request.source); },
      async release(request) { reserved -= BigInt(request.amountCents); return this.getBalance(request.source); },
    };
    const envelope = (payload: Record<string, unknown>, expectedRevision?: number) => ({
      operationId: newOperationId(),
      idempotencyKey: `binding-test-${newOperationId()}`,
      scope,
      effectiveDate: "2026-09-21",
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      payload,
    });
    const create = await executeProjectExecutionCommand(fixture.executor, "project.finance_binding.create", envelope({ projectId: PROJECT_ID, source: SOURCE, allocatedCents: "2500" }, 1), { ...options, financeFactory: () => ({ source, allocations, costContext }) });
    assert.equal(reserved, BigInt(2500));
    const bindingId = String(create.affectedRecordIds[0]);
    const store = createProjectFinanceBindingStore(fixture.executor);
    const bindings = await store.listProjectBindings({ organizationId: SYNTHETIC_COMPANY.organizationId, projectId: PROJECT_ID });
    assert.equal(bindings[0]?.bindingStatus, "verified");
    const projectRevision = Number(create.resultingRevisions.find((item) => String(item.recordId) === PROJECT_ID)?.revision);
    await executeProjectExecutionCommand(fixture.executor, "project.finance_binding.release", envelope({ bindingId }, projectRevision), { ...options, financeFactory: () => ({ source, allocations, costContext }) });
    assert.equal(reserved, BigInt(0));
    const released = await store.listProjectBindings({ organizationId: SYNTHETIC_COMPANY.organizationId, projectId: PROJECT_ID });
    assert.equal(released[0]?.bindingStatus, "released");
    assert.equal(released[0]?.eligible, false);
  } finally {
    await fixture.close();
  }
});
