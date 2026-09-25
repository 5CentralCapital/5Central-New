import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateProjectDealCostReport,
  projectDealCostSchema,
  projectDealFundingSchema,
  projectDealSaleForecastSchema,
} from "./deal-costs";

const projectId = "10000000-0000-4000-8000-000000000001";
const now = "2026-09-24T12:00:00.000Z";

function cost(input: Record<string, unknown>) {
  return projectDealCostSchema.parse({
    id: input.id ?? "10000000-0000-4000-8000-000000000101",
    projectId,
    entryKind: "cost",
    lane: "rehab",
    description: "Synthetic cost",
    vendorName: null,
    budgetCents: "1000",
    amountCents: "500",
    forecastCents: "100",
    paidCents: "500",
    incurredOn: "2026-09-20",
    paidOn: "2026-09-21",
    prepaid: false,
    sourceKind: "manual",
    reconciliationState: "source_backed",
    sourceRecordRef: "synthetic-cost",
    sourceReferenceHash: null,
    source: null,
    settlementProof: { kind: "document", reference: "synthetic-payment", observedOn: "2026-09-21", amountCents: null },
    recordRevision: 1,
    updatedAt: now,
    archivedAt: null,
    ...input,
  });
}

function funding(input: Record<string, unknown>) {
  return projectDealFundingSchema.parse({
    id: input.id ?? "10000000-0000-4000-8000-000000000201",
    projectId,
    entryKind: "funding",
    fundingKind: "contribution",
    description: "Synthetic contribution",
    amountCents: "5000",
    fundedOn: "2026-09-20",
    sourceKind: "manual",
    reconciliationState: "source_backed",
    sourceRecordRef: "synthetic-funding",
    sourceReferenceHash: null,
    source: null,
    settlementProof: { kind: "document", reference: "synthetic-payment", observedOn: "2026-09-21", amountCents: null },
    recordRevision: 1,
    updatedAt: now,
    archivedAt: null,
    ...input,
  });
}

test("deal cost projection keeps exact signed cents and excludes funding from costs", () => {
  const report = calculateProjectDealCostReport({
    projectId: projectId as never,
    currency: "USD" as never,
    asOf: "2026-09-24" as never,
    costs: [
      cost({ id: "10000000-0000-4000-8000-000000000101", lane: "acquisition", budgetCents: "10000000000000001", amountCents: "10000000000000001", forecastCents: "0", paidCents: "10000000000000001" }),
      cost({ id: "10000000-0000-4000-8000-000000000102", lane: "rehab", budgetCents: "2000", amountCents: "1500", forecastCents: "500", paidCents: "0" }),
      cost({ id: "10000000-0000-4000-8000-000000000103", lane: "financing", budgetCents: "300", amountCents: "-25", forecastCents: "0", paidCents: "0" }),
      cost({ id: "10000000-0000-4000-8000-000000000104", lane: "holding", budgetCents: "500", amountCents: null, forecastCents: "500", paidCents: null, sourceKind: "estimate", reconciliationState: "unreconciled" }),
      cost({ id: "10000000-0000-4000-8000-000000000105", lane: "selling", budgetCents: "400", amountCents: "0", forecastCents: "400", paidCents: "0" }),
    ],
    funding: [funding({})],
    saleForecast: projectDealSaleForecastSchema.parse({
      id: "10000000-0000-4000-8000-000000000301",
      projectId,
      entryKind: "sale_forecast",
      grossProceedsCents: "20000000000000000",
      saleOn: "2026-10-30",
      sourceKind: "estimate",
      reconciliationState: "unreconciled",
      recordRevision: 1,
      updatedAt: now,
      archivedAt: null,
    }),
    qboStatus: "complete",
  });
  assert.equal(report.totals.incurredCents, "10000000000001476");
  assert.equal(report.totals.finalCostCents, null, "an unincurred holding amount keeps final cost unknown");
  assert.equal(report.fundingTotals.find((row) => row.fundingKind === "contribution")?.amountCents, "5000");
  assert.equal(report.saleForecast.projectedProfitCents, null, "profit is withheld while a lane is incomplete");
  assert.equal(report.coverage.status, "partial");
  assert.ok(report.coverage.unknownEntryIds.includes("10000000-0000-4000-8000-000000000104"));
});

test("prepaid cash can be recorded without claiming incurred cost", () => {
  const prepaid = cost({
    id: "10000000-0000-4000-8000-000000000106",
    lane: "holding",
    description: "Prepaid insurance",
    budgetCents: "12000",
    amountCents: null,
    forecastCents: null,
    paidCents: "12000",
    paidOn: "2026-09-20",
    prepaid: true,
    sourceKind: "operational",
    reconciliationState: "source_backed",
    sourceRecordRef: "insurance-policy-1",
  });
  assert.equal(prepaid.amountCents, null);
  assert.equal(prepaid.paidCents, "12000");
});

test("source rules keep manual rows from masquerading as QBO rows", () => {
  const qboSource = {
    provider: "qbo", organizationId: "20000000-0000-4000-8000-000000000001", legalEntityId: "30000000-0000-4000-8000-000000000001",
    environment: "production", realmId: "123", objectType: "Bill", objectId: "1", lineId: "1", version: "1",
  } as const;
  assert.throws(() => projectDealCostSchema.parse({
    ...cost({}),
    sourceKind: "qbo",
    source: null,
  }), /QBO deal costs require/);
  assert.throws(() => projectDealCostSchema.parse({
    ...cost({}),
    sourceKind: "manual",
    source: qboSource,
  }), /Manual costs cannot carry/);
  assert.throws(() => projectDealCostSchema.parse({
    ...cost({}),
    sourceKind: "operational",
    reconciliationState: "source_backed",
    source: qboSource,
  }), /Only QBO costs may carry/);
  assert.throws(() => projectDealFundingSchema.parse({
    ...funding({}),
    sourceKind: "operational",
    source: qboSource,
  }), /Only QBO funding may carry/);
});

test("prepaid asset is kept out of incurred cost and later recognition is counted once", () => {
  const report = calculateProjectDealCostReport({
    projectId: projectId as never, currency: "USD" as never, asOf: "2026-09-24" as never,
    costs: [cost({ prepaid: true, amountCents: "12000", forecastCents: "0" }),
      cost({ id: "10000000-0000-4000-8000-000000000102", amountCents: "1000", forecastCents: "0", paidCents: null, settlementProof: null })],
    funding: [], saleForecast: null, qboStatus: "partial",
  });
  assert.equal(report.totals.incurredCents, "1000");
  assert.equal(report.totals.prepaidCents, "12000");
});

test("complete actual coverage permits future cost forecasts and an empty allocation queue", () => {
  const costs = ["acquisition", "rehab", "financing", "holding", "selling"].map((lane, i) => cost({
    id: `10000000-0000-4000-8000-00000000010${i}`,
    lane, amountCents: i < 3 ? "1000" : "0", forecastCents: i < 3 ? "0" : "500",
    sourceKind: i < 3 ? "manual" : "estimate", reconciliationState: i < 3 ? "source_backed" : "unreconciled",
  }));
  const saleForecast = projectDealSaleForecastSchema.parse({ id: "10000000-0000-4000-8000-000000000301", projectId,
    entryKind: "sale_forecast", grossProceedsCents: "10000", saleOn: null, sourceKind: "estimate", reconciliationState: "unreconciled",
    recordRevision: 1, updatedAt: now, archivedAt: null });
  const input = {projectId: projectId as never, currency: "USD" as never, asOf: "2026-09-24" as never, costs, funding: [], saleForecast, qboStatus: "complete" as const};
  assert.equal(calculateProjectDealCostReport(input).saleForecast.projectedProfitCents, "6000");
  assert.equal(calculateProjectDealCostReport({...input, qboStatus: "partial"}).saleForecast.projectedProfitCents, null);
  assert.equal(calculateProjectDealCostReport({...input, costs: [...costs, cost({lane: "unallocated"})]}).saleForecast.projectedProfitCents, null);
});

test("positive paid values require evidence and estimates cannot become actuals", () => {
  assert.throws(() => cost({settlementProof: null}), /settlement evidence/);
  assert.throws(() => cost({sourceKind: "estimate", reconciliationState: "unreconciled"}), /remaining forecast/);
  assert.throws(() => cost({sourceKind: "estimate", amountCents: "0"}), /source-backed actuals/);
});

test("future incurred costs and settlement are withheld at the reporting date", () => {
  const report = calculateProjectDealCostReport({ projectId: projectId as never, currency: "USD" as never, asOf: "2026-09-19" as never,
    costs: [cost({})], funding: [funding({})], saleForecast: null, qboStatus: "complete" });
  assert.equal(report.totals.incurredCents, null);
  assert.equal(report.totals.paidCents, null);
  assert.equal(report.funding.length, 0);
});

test("approved rehab budget overrides duplicate cost-row budgets exactly once", () => {
  const report = calculateProjectDealCostReport({ projectId: projectId as never, currency: "USD" as never, asOf: "2026-09-24" as never,
    costs: [cost({budgetCents: "10000"}), cost({id: "10000000-0000-4000-8000-000000000102", budgetCents: "10000"})], funding: [], saleForecast: null,
    rehabBudgetCents: "10000" as never });
  assert.equal(report.byLane.find(lane => lane.lane === "rehab")?.budgetCents, "10000");
  assert.equal(report.totals.budgetCents, "10000");
});

test("canonical rehab ETC replaces missing row forecast in rehab final cost", () => {
  const report = calculateProjectDealCostReport({
    projectId: projectId as never,
    currency: "USD" as never,
    asOf: "2026-09-24" as never,
    costs: [cost({ amountCents: "500", forecastCents: null })],
    funding: [],
    saleForecast: null,
    qboStatus: "complete",
    rehabRemainingForecastCents: "250",
  });
  const rehab = report.byLane.find((lane) => lane.lane === "rehab")!;
  assert.equal(rehab.remainingForecastCents, "250");
  assert.equal(rehab.finalCostCents, "750");
  assert.deepEqual(report.coverage.unknownEntryIds, [], "canonical rehab ETC covers the row forecast in whole-deal coverage");
});

test("whole-deal coverage stays partial until every required lane is represented", () => {
  const report = calculateProjectDealCostReport({
    projectId: projectId as never,
    currency: "USD" as never,
    asOf: "2026-09-24" as never,
    costs: [cost({ amountCents: "500", forecastCents: "0" })],
    funding: [],
    saleForecast: null,
    qboStatus: "complete",
  });
  assert.equal(report.coverage.status, "partial");
  assert.ok(report.coverage.unknownFields.includes("acquisition.coverage"));
});
