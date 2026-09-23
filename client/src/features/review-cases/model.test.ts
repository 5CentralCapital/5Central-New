import assert from "node:assert/strict";
import test from "node:test";
import type { ReviewCaseSummary } from "@shared/review-cases";
import { ageLabel, formatImpact, groupQueue, impactTotal, primaryCommand, recordLinkTarget } from "./model";

function summary(overrides: Partial<ReviewCaseSummary>): ReviewCaseSummary {
  return {
    id: "00000000-0000-4000-8000-000000000001", organizationId: "10000000-0000-4000-8000-000000000001", legalEntityId: null, propertyId: null,
    reasonCode: "history_incomplete", shortLabel: "History incomplete", causeFamily: "history_coverage", causeKey: "x", scopeKey: "organization", scopeLabel: null,
    state: "open", materiality: "high", asOf: "2026-09-23", impactCents: null, impactCurrency: null, affectedCount: 3, blockedOn: null, detectedBy: "detector",
    reopenedCount: 0, recordRevision: 1, firstDetectedAt: "2026-09-20T12:00:00.000Z", lastDetectedAt: "2026-09-23T12:00:00.000Z", resolvedAt: null,
    updatedAt: "2026-09-23T12:00:00.000Z", nextAction: "Start research", ...overrides,
  } as ReviewCaseSummary;
}

test("unknown impact renders as Unknown and never as zero", () => {
  assert.equal(formatImpact(null), "Unknown");
  assert.equal(formatImpact(undefined), "Unknown");
  assert.equal(formatImpact("0"), "$0.00");
  assert.equal(formatImpact("123456789012345678"), "$1,234,567,890,123,456.78", "exact beyond Number precision");
  assert.equal(formatImpact("-2550"), "-$25.50");
});

test("totals with any unknown amount are labeled incomplete", () => {
  assert.deepEqual(impactTotal([summary({ impactCents: "1000", impactCurrency: "USD" }), summary({ impactCents: "250", impactCurrency: "USD" })]), { label: "$12.50", complete: true, knownCount: 2, unknownCount: 0 });
  const partial = impactTotal([summary({ impactCents: "1000", impactCurrency: "USD" }), summary({ impactCents: null })]);
  assert.equal(partial.complete, false);
  assert.equal(partial.label, "$10.00 known · incomplete");
  assert.equal(impactTotal([summary({ impactCents: null })]).label, "Unknown");
});

test("the queue groups by materiality then cause family, keeping affected counts separate", () => {
  const groups = groupQueue([
    summary({ id: "00000000-0000-4000-8000-000000000002", materiality: "medium", causeFamily: "occupancy_dates", affectedCount: 1 }),
    summary({ id: "00000000-0000-4000-8000-000000000003", materiality: "high", causeFamily: "history_coverage", affectedCount: 40 }),
    summary({ id: "00000000-0000-4000-8000-000000000004", materiality: "high", causeFamily: "identity", affectedCount: 2 }),
  ]);
  assert.deepEqual(groups.map(group => [group.materiality, group.family, group.caseCount, group.affectedCount]), [
    ["high", "identity", 1, 2], ["high", "history_coverage", 1, 40], ["medium", "occupancy_dates", 1, 1],
  ]);
});

test("one primary action per state and links resolve to rental records", () => {
  assert.equal(primaryCommand("open", ["review_case.start_research", "review_case.propose"]), "review_case.start_research");
  assert.equal(primaryCommand("proposed", ["review_case.apply"]), "review_case.apply");
  assert.equal(primaryCommand("verified", ["review_case.reopen"]), undefined);
  assert.deepEqual(recordLinkTarget({ kind: "tenancy", id: "t1", label: null, propertyId: "p1", unitId: "u1", tenancyId: "t1", personId: "person-1", codes: [] }), { kind: "tenant", id: "person-1" });
  assert.deepEqual(recordLinkTarget({ kind: "unit", id: "u1", label: null, propertyId: "p1", unitId: "u1", tenancyId: null, personId: null, codes: [] }), { kind: "unit", id: "u1" });
  assert.deepEqual(recordLinkTarget({ kind: "legal_entity", id: "e1", label: null, propertyId: null, unitId: null, tenancyId: null, personId: null, codes: [] }), { kind: "none" });
  assert.equal(ageLabel("2026-09-20T12:00:00.000Z", new Date("2026-09-23T13:00:00.000Z")), "3 days");
});
