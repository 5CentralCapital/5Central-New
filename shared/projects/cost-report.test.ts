import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateProjectCostReport,
  calculateRetainageRollforward,
  calculateScheduleRisk,
  paidPortionCents,
  type ProjectCostReportInput,
} from "./cost-report";
import type { ProjectCommitment, ProjectDrawRequest, ProjectFinanceActual } from "./execution-contracts";

const PROJECT = "50000000-0000-4000-8000-0000000000a1";
const SCOPE_A = "51000000-0000-4000-8000-0000000000a1";
const SCOPE_B = "51000000-0000-4000-8000-0000000000a2";
const BID_A = "52000000-0000-4000-8000-0000000000a1";
const COMMIT_A = "53000000-0000-4000-8000-0000000000a1";
const TS = "2026-09-01T00:00:00.000Z";

const source = (objectId: string, lineId = "1") => ({
  provider: "qbo" as const,
  organizationId: "10000000-0000-4000-8000-000000000001",
  legalEntityId: "20000000-0000-4000-8000-000000000001",
  environment: "sandbox" as const,
  realmId: "12345",
  objectType: "Bill",
  objectId,
  lineId,
  version: "3",
});

function commitment(overrides: Partial<ProjectCommitment> = {}): ProjectCommitment {
  return {
    id: COMMIT_A, projectId: PROJECT, vendorId: "54000000-0000-4000-8000-0000000000a1", bidId: BID_A, description: "Framing", status: "approved",
    originalCents: "100000", approvedChangeCents: "0", committedCents: "100000", currency: "USD", startOn: null, targetOn: null, createdAt: TS, updatedAt: TS,
    ...overrides,
  } as ProjectCommitment;
}

function actual(id: string, amountCents: string, overrides: Partial<ProjectFinanceActual> = {}): ProjectFinanceActual {
  return {
    id, projectId: PROJECT, commitmentId: COMMIT_A, scopeItemId: null, source: source(`bill-${id.slice(-2)}`), description: "Framing bill",
    amountCents, currency: "USD", postedOn: "2026-09-10", sourceRevision: "3", transactionType: "Bill",
    settlement: { state: "unsettled", settledOn: null, settledAmountCents: null }, lineAmountCents: amountCents,
    ...overrides,
  } as ProjectFinanceActual;
}

function baseInput(overrides: Partial<ProjectCostReportInput> = {}): ProjectCostReportInput {
  return {
    projectId: PROJECT,
    currency: "USD",
    asOf: "2026-09-23",
    targetOn: "2026-12-31",
    scopeItems: [{ id: SCOPE_A, description: "Framing", estimatedCents: "120000" }, { id: SCOPE_B, description: "Paint", estimatedCents: "30000" }],
    budgetVersions: [{ versionNo: 1, status: "approved", totalEstimatedCents: "150000", lines: [{ scopeItemId: SCOPE_A, description: "Framing", estimatedCents: "120000" }, { scopeItemId: SCOPE_B, description: "Paint", estimatedCents: "30000" }] }],
    draftCostCents: "0",
    etcOverrides: [],
    commitments: [commitment()],
    bids: [{ id: BID_A, scopeItemId: SCOPE_A }],
    changeOrders: [],
    purchaseOrders: [],
    draws: [],
    punchItems: [],
    tasks: [],
    actuals: [],
    actualCoverage: "complete",
    labor: [],
    lienWaiverDocumentCount: 0,
    ...overrides,
  };
}

test("commitment, bill and payment are one cost, not three", () => {
  const report = calculateProjectCostReport(baseInput({
    actuals: [actual("55000000-0000-4000-8000-0000000000a1", "40000", { settlement: { state: "settled", settledOn: "2026-09-15", settledAmountCents: "40000" } })],
  }));
  const summary = report.summary;
  assert.equal(summary.committedCents, "100000");
  assert.equal(summary.incurred.verifiedActualCents, "40000");
  assert.equal(summary.incurred.totalCents, "40000");
  assert.equal(summary.paid.cents, "40000");
  assert.equal(summary.remainingCommitmentCents, "60000");
  // Framing: max(120000 − 40000, 60000) = 80000; Paint: 30000 uncommitted.
  assert.equal(summary.costToCompleteCents, "110000");
  assert.equal(summary.forecastFinalCostCents, "150000", "EAC = incurred + cost to complete, never commitment + bill + payment");
  assert.equal(summary.varianceCents, "0");
  const framing = report.lines.find((line) => line.scopeItemId === SCOPE_A)!;
  assert.equal(framing.incurredCents, "40000");
  assert.equal(framing.remainingCommitmentCents, "60000");
  assert.equal(framing.costToCompleteCents, "80000");
  const ledger = report.commitments[0]!;
  assert.equal(ledger.invoicedCents, "40000");
  assert.equal(ledger.paidCents, "40000");
  assert.equal(ledger.remainingCents, "60000");
});

test("commitment overruns drive cost to complete above budget", () => {
  const report = calculateProjectCostReport(baseInput({
    commitments: [commitment({ originalCents: "150000", committedCents: "150000" })],
    actuals: [actual("55000000-0000-4000-8000-0000000000a2", "20000")],
  }));
  const framing = report.lines.find((line) => line.scopeItemId === SCOPE_A)!;
  assert.equal(framing.costToCompleteCents, "130000", "remaining commitment exceeds remaining budget");
  assert.equal(report.summary.forecastFinalCostCents, "180000");
  assert.equal(report.summary.varianceCents, "-30000");
});

test("an explicit ETC override with reason replaces the derived cost to complete", () => {
  const report = calculateProjectCostReport(baseInput({
    etcOverrides: [{ id: "56000000-0000-4000-8000-0000000000a1", scopeItemId: SCOPE_B, amountCents: "45000", reason: "Lead abatement found" }],
  }));
  const paint = report.lines.find((line) => line.scopeItemId === SCOPE_B)!;
  assert.equal(paint.costToCompleteCents, "45000");
  assert.equal(paint.etcOverride?.reason, "Lead abatement found");
  assert.equal(paint.varianceCents, "-15000");
});

test("partial coverage keeps known subtotals and withholds forecast figures", () => {
  const report = calculateProjectCostReport(baseInput({ actualCoverage: "partial", actuals: [actual("55000000-0000-4000-8000-0000000000a3", "10000")] }));
  assert.equal(report.summary.incurred.verifiedActualCents, "10000");
  assert.equal(report.summary.costToCompleteCents, null);
  assert.equal(report.summary.forecastFinalCostCents, null);
  assert.equal(report.summary.completeness, "partial");
  const unavailable = calculateProjectCostReport(baseInput({ actualCoverage: "unavailable", actuals: [actual("55000000-0000-4000-8000-0000000000a4", "10000")] }));
  assert.equal(unavailable.summary.incurred.verifiedActualCents, null, "unknown is null, never zero");
  assert.equal(unavailable.summary.incurred.totalCents, null);
  assert.equal(unavailable.summary.paid.cents, null);
});

test("posted payroll replaces the labor estimate for the same timesheet", () => {
  const report = calculateProjectCostReport(baseInput({
    labor: [
      { timesheetId: "t1", scopeItemId: SCOPE_B, currency: "USD", estimatedCents: "5000", postedCents: null },
      { timesheetId: "t2", scopeItemId: SCOPE_B, currency: "USD", estimatedCents: "5000", postedCents: "5400" },
      { timesheetId: "t3", scopeItemId: null, currency: null, estimatedCents: null, postedCents: null },
    ],
  }));
  assert.equal(report.summary.incurred.laborEstimatedCents, "5000");
  assert.equal(report.summary.incurred.laborPostedCents, "5400");
  assert.equal(report.summary.incurred.totalCents, "10400", "the estimate for t2 is not counted with its posted payroll");
  assert.equal(report.summary.incurred.unpricedLaborEntries, 1);
  assert.equal(report.summary.completeness, "partial");
  assert.equal(report.lines.find((line) => line.scopeItemId === SCOPE_B)!.laborCents, "10400");
});

test("closed commitments stop adding remaining exposure", () => {
  const report = calculateProjectCostReport(baseInput({ commitments: [commitment({ status: "closed" })], actuals: [actual("55000000-0000-4000-8000-0000000000a5", "90000")] }));
  assert.equal(report.summary.remainingCommitmentCents, "0");
  assert.equal(report.commitments[0]!.remainingCents, "0");
});

test("approved change orders revise the budget until incorporated", () => {
  const change = { id: "57000000-0000-4000-8000-0000000000a1", projectId: PROJECT, commitmentId: COMMIT_A, description: "Extra wall", reason: "Owner request", status: "approved", amountCents: "7500", currency: "USD", includedInBudgetVersionId: null, submittedOn: null, approvedOn: "2026-09-05", createdAt: TS, updatedAt: TS };
  const report = calculateProjectCostReport(baseInput({ changeOrders: [change as never] }));
  assert.equal(report.summary.originalBudgetCents, "150000");
  assert.equal(report.summary.revisedBudgetCents, "157500");
  assert.equal(report.summary.approvedChangeCents, "7500");
  assert.equal(report.lines.find((line) => line.scopeItemId === SCOPE_A)!.revisedBudgetCents, "127500");
  const incorporated = calculateProjectCostReport(baseInput({ changeOrders: [{ ...change, includedInBudgetVersionId: "58000000-0000-4000-8000-0000000000a1" } as never] }));
  assert.equal(incorporated.summary.revisedBudgetCents, "150000");
});

test("line totals conserve the project totals", () => {
  const report = calculateProjectCostReport(baseInput({
    actuals: [actual("55000000-0000-4000-8000-0000000000a6", "25000"), actual("55000000-0000-4000-8000-0000000000a7", "3000", { commitmentId: null, scopeItemId: null })],
    labor: [{ timesheetId: "t4", scopeItemId: null, currency: "USD", estimatedCents: "1234", postedCents: null }],
  }));
  const sum = (key: "revisedBudgetCents" | "costToCompleteCents" | "incurredCents" | "forecastFinalCostCents") => report.lines.reduce((total, line) => total + BigInt(line[key] ?? "0"), BigInt(0)).toString();
  assert.equal(sum("revisedBudgetCents"), report.summary.revisedBudgetCents);
  assert.equal(sum("costToCompleteCents"), report.summary.costToCompleteCents);
  assert.equal(sum("incurredCents"), report.summary.incurred.totalCents);
  assert.equal(sum("forecastFinalCostCents"), report.summary.forecastFinalCostCents);
});

test("paid portions stay exact and unknown settlement stays unknown", () => {
  assert.equal(paidPortionCents({ amountCents: "3333" as never, lineAmountCents: "10000" as never, settlement: { state: "settled", settledOn: "2026-09-01", settledAmountCents: "5000" as never } }), BigInt(1666));
  assert.equal(paidPortionCents({ amountCents: "3333" as never, lineAmountCents: "10000" as never, settlement: { state: "unknown", settledOn: null, settledAmountCents: null } }), null);
  const report = calculateProjectCostReport(baseInput({ actuals: [actual("55000000-0000-4000-8000-0000000000a8", "1000", { settlement: { state: "unknown", settledOn: null, settledAmountCents: null } })] }));
  assert.equal(report.summary.paid.cents, null);
  assert.equal(report.summary.paid.coverage, "partial");
});

function draw(requestNo: number, status: string, items: { requested: string; retainage: string; eligible?: string }[]): ProjectDrawRequest {
  return {
    id: `59000000-0000-4000-8000-0000000000${String(requestNo).padStart(2, "0")}`, projectId: PROJECT, requestNo, status, periodFrom: "2026-09-01", periodTo: "2026-09-30",
    grossEligibleCents: "0", retainagePercent: "10", retainageCents: "0", netRequestedCents: "0", currency: "USD", submittedOn: null, approvedOn: null, paidOn: null, notes: null, createdAt: TS, updatedAt: TS,
    items: items.map((item, index) => ({ id: `5a000000-0000-4000-8000-0000000${requestNo}00${index}`, drawRequestId: "x", sourceType: "commitment", sourceId: COMMIT_A, eligibleCents: item.eligible ?? "100000", requestedCents: item.requested, retainageEligible: true, retainageCents: item.retainage, notes: null })),
  } as unknown as ProjectDrawRequest;
}

test("retainage payable rolls forward and releases conserve the balance", () => {
  const retainage = calculateRetainageRollforward([
    draw(1, "paid", [{ requested: "50000", retainage: "5000" }]),
    draw(2, "approved", [{ requested: "50000", retainage: "5000" }]),
    draw(3, "paid", [{ requested: "10000", retainage: "0" }]),
    draw(4, "draft", [{ requested: "1000", retainage: "100" }]),
  ]);
  assert.deepEqual(retainage.rows.map((row) => [row.openingCents, row.withheldCents, row.releasedCents, row.closingCents]), [
    ["0", "5000", "0", "5000"],
    ["5000", "5000", "0", "10000"],
    ["10000", "0", "10000", "0"],
  ]);
  assert.equal(retainage.outstandingCents, "0");
  assert.equal(retainage.pendingWithheldCents, "100");
  for (const row of retainage.rows) assert.equal(BigInt(row.openingCents) + BigInt(row.withheldCents) - BigInt(row.releasedCents), BigInt(row.closingCents));
});

test("closeout checklist derives readiness from records", () => {
  const open = calculateProjectCostReport(baseInput({
    draws: [draw(1, "approved", [{ requested: "50000", retainage: "5000" }])],
    punchItems: [{ id: "5b000000-0000-4000-8000-0000000000a1", status: "open" } as never],
  }));
  assert.equal(open.closeout.ready, false);
  const byKey = Object.fromEntries(open.closeout.items.map((item) => [item.key, item.status]));
  assert.deepEqual(byKey, { commitments_invoiced: "open", retainage_released: "open", punch_items_closed: "open", final_draw_paid: "open", lien_waivers_linked: "open", tasks_complete: "not_applicable" });
  const ready = calculateProjectCostReport(baseInput({
    commitments: [commitment({ status: "closed" })],
    actuals: [actual("55000000-0000-4000-8000-0000000000a9", "100000")],
    draws: [draw(1, "paid", [{ requested: "90000", retainage: "9000" }]), draw(2, "paid", [{ requested: "19000", retainage: "0" }])],
    punchItems: [{ id: "5b000000-0000-4000-8000-0000000000a2", status: "complete" } as never],
    lienWaiverDocumentCount: 1,
  }));
  assert.equal(ready.retainage.outstandingCents, "0");
  assert.equal(ready.closeout.ready, true, JSON.stringify(ready.closeout.items));
});

test("schedule risk follows late tasks and dependency pushes", () => {
  const tasks = [
    { id: "5c000000-0000-4000-8000-0000000000a1", title: "Demo", status: "in_progress", startsOn: "2026-09-01", dueOn: "2026-09-20", completedOn: null, dependencyTaskIds: [] },
    { id: "5c000000-0000-4000-8000-0000000000a2", title: "Frame", status: "not_started", startsOn: "2026-09-24", dueOn: "2026-09-26", completedOn: null, dependencyTaskIds: ["5c000000-0000-4000-8000-0000000000a1"] },
  ];
  const late = calculateScheduleRisk(tasks, "2026-09-23", "2026-12-31");
  assert.equal(late.status, "late");
  assert.deepEqual(late.lateTaskIds, ["5c000000-0000-4000-8000-0000000000a1"]);
  const atRisk = calculateScheduleRisk([
    { ...tasks[0]!, dueOn: "2026-09-30" },
    { ...tasks[1]!, startsOn: "2026-09-28", dueOn: "2026-09-30" },
  ], "2026-09-23", "2026-12-31");
  assert.equal(atRisk.status, "at_risk");
  assert.deepEqual(atRisk.dependencyRiskTaskIds, ["5c000000-0000-4000-8000-0000000000a2"]);
  assert.equal(atRisk.projectedFinishOn, "2026-10-02");
  assert.equal(calculateScheduleRisk([], "2026-09-23", null).status, "unknown");
});
