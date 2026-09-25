import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { calculateProjectDealCostReport } from "@shared/projects/deal-costs";
import type { ProjectDetail } from "./types";
import type { ProjectDealCost } from "@shared/projects/deal-costs";
import {
  buildDealCostPayload,
  buildDealFundingPayload,
  DealCostsPanel,
  isDerivedRehabCost,
  type CostFormValues,
  type FundingFormValues,
} from "./deal-costs";

(globalThis as { React?: typeof React }).React = React;

test("deal cost panel keeps whole-deal coverage and funding boundaries visible", () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const report = calculateProjectDealCostReport({
    projectId: projectId as never,
    currency: "USD" as never,
    asOf: "2026-09-24" as never,
    costs: [],
    funding: [],
    saleForecast: null,
    qboStatus: "unavailable",
  });
  const project = { id: projectId, currency: "USD", qboProjectIdentities: [] } as unknown as ProjectDetail;
  const html = renderToStaticMarkup(<DealCostsPanel project={project} report={report} readOnly saving={false} onSaveCost={async () => undefined} onArchiveCost={async () => undefined} onSaveFunding={async () => undefined} onArchiveFunding={async () => undefined} onSaveSaleForecast={async () => undefined} />);

  assert.match(html, /Deal costs/);
  assert.match(html, /Acquisition/);
  assert.match(html, /Selling/);
  assert.match(html, /Funding is shown by source and never treated as available cash/);
  assert.match(html, /Net sale proceeds before loan payoff/);
  assert.match(html, /Withheld until all cost lanes and the sale forecast are complete/);
  assert.doesNotMatch(html, /11111111-1111-4111-8111-111111111111/);
});

const projectId = "11111111-1111-4111-8111-111111111111";
function costValues(overrides: Partial<CostFormValues> = {}): CostFormValues {
  return {
    lane: "unallocated",
    description: "Closing inspection",
    vendorName: "Inspector",
    budgetCents: "100000",
    amountCents: "95000",
    forecastCents: "5000",
    paidCents: "",
    incurredOn: "2026-09-24",
    paidOn: "",
    prepaid: false,
    sourceKind: "manual",
    reconciliationState: "unreconciled",
    sourceEvidenceReference: "",
    settlementReference: "",
    settlementObservedOn: "",
    ...overrides,
  };
}

test("deal cost form payloads enforce lane, source, settlement and estimate rules", () => {
  const manual = buildDealCostPayload({ projectId, values: costValues() });
  assert.equal(manual.projectId, projectId);
  assert.equal(manual.lane, "unallocated");
  assert.equal(manual.sourceKind, "manual");

  const sourceBacked = buildDealCostPayload({ projectId, values: costValues({ reconciliationState: "source_backed", sourceEvidenceReference: "invoice-17" }) });
  assert.equal(sourceBacked.sourceRecordRef, "invoice-17");
  assert.equal(sourceBacked.settlementProof, null);

  const operational = buildDealCostPayload({ projectId, values: costValues({ sourceKind: "operational", sourceEvidenceReference: "ops-record-17" }) });
  assert.equal(operational.sourceRecordRef, "ops-record-17");

  const estimate = buildDealCostPayload({ projectId, values: costValues({ sourceKind: "estimate", amountCents: "0", forecastCents: "125000" }) });
  assert.equal(estimate.amountCents, "0");
  assert.equal(estimate.forecastCents, "12500000");
  assert.throws(() => buildDealCostPayload({ projectId, values: costValues({ sourceKind: "estimate" }) }), /Estimates use remaining forecast/);
  assert.throws(() => buildDealCostPayload({ projectId, values: costValues({ lane: "rehab" }) }), /existing operations or QuickBooks workflow/);

  assert.throws(() => buildDealCostPayload({ projectId, values: costValues({ paidCents: "25000", paidOn: "2026-09-24" }) }), /separate settlement evidence/);
  const paid = buildDealCostPayload({ projectId, values: costValues({ paidCents: "25000", paidOn: "2026-09-24", settlementReference: "bank-17", settlementObservedOn: "2026-09-24" }) });
  assert.deepEqual(paid.settlementProof, { kind: "manual", reference: "bank-17", observedOn: "2026-09-24", amountCents: "2500000" });
  assert.equal(paid.sourceRecordRef, null);

  const prepaid = buildDealCostPayload({ projectId, values: costValues({ prepaid: true, paidCents: "0", paidOn: "2026-09-24" }) });
  assert.equal(prepaid.prepaid, true);
  const existing = { id: "22222222-2222-4222-8222-222222222222", projectId, sourceKind: "manual" } as unknown as ProjectDealCost;
  const edited = buildDealCostPayload({ projectId, existing, values: costValues({ description: "Updated inspection" }) });
  assert.equal(edited.dealCostId, existing.id);
  assert.equal(edited.projectId, undefined);
});

test("funding form payloads preserve source evidence and do not offer a cost-line QBO binding", () => {
  const values: FundingFormValues = { fundingKind: "contribution", description: "Owner contribution", amountCents: "500000", fundedOn: "2026-09-24", sourceKind: "manual", reconciliationState: "source_backed", sourceEvidenceReference: "capital-record-1" };
  const payload = buildDealFundingPayload({ projectId, values });
  assert.equal(payload.sourceRecordRef, "capital-record-1");
  assert.equal(payload.source, null);
  assert.throws(() => buildDealFundingPayload({ projectId, values: { ...values, sourceKind: "operational", sourceEvidenceReference: "" } }), /source evidence reference/);
  assert.throws(() => buildDealFundingPayload({ projectId, values: { ...values, sourceKind: "qbo" } }), /source selection is not available/);
});

test("rehab budget projections are visible but cannot be edited from the deal ledger", () => {
  const draftId = "33333333-3333-4333-8333-333333333333";
  const project = { id: projectId, currency: "USD", qboProjectIdentities: [], draftCosts: [{ id: draftId }] } as unknown as ProjectDetail;
  const derived = {
    id: draftId,
    projectId,
    entryKind: "cost",
    lane: "rehab",
    description: "Kitchen rehab draft",
    vendorName: null,
    budgetCents: null,
    amountCents: "100000",
    forecastCents: null,
    paidCents: null,
    incurredOn: "2026-09-24",
    paidOn: null,
    prepaid: false,
    sourceKind: "operational",
    reconciliationState: "unreconciled",
    sourceRecordRef: draftId,
    sourceReferenceHash: null,
    source: null,
    settlementProof: null,
    recordRevision: 1,
    updatedAt: "2026-09-24T00:00:00.000Z",
    archivedAt: null,
  } as never;
  assert.equal(isDerivedRehabCost(project, derived), true);
  const report = calculateProjectDealCostReport({ projectId: projectId as never, currency: "USD" as never, asOf: "2026-09-24" as never, costs: [derived], funding: [], saleForecast: null, qboStatus: "partial" });
  const html = renderToStaticMarkup(<DealCostsPanel project={project} report={report} readOnly={false} saving={false} onSaveCost={async () => undefined} onArchiveCost={async () => undefined} onSaveFunding={async () => undefined} onArchiveFunding={async () => undefined} onSaveSaleForecast={async () => undefined} />);
  assert.match(html, /From rehab budget · read-only/);
  assert.doesNotMatch(html, />Edit<\/button>/);
  assert.doesNotMatch(html, />Archive<\/button>/);
});
