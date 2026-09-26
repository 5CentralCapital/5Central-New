import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import type { ForecastSourceData } from "./engine";
import { createForecastingPort } from "./port";
import type { ForecastQboOpeningBalance } from "./source-port";
import { forecastSnapshotMetaSchema } from "../../shared/forecasting/contracts";
import { OPENING_ITEM_KEYS, OPENING_ITEM_LABELS } from "../../shared/forecasting/assumptions";
import { qboOpeningApprovalIssue } from "./commands";
import { syntheticForecastAssumptionsInput, SYNTHETIC_FORECAST_CUTOFF, SYNTHETIC_FORECAST_START, syntheticForecastSources } from "./testing/fixture";

const base = {
  id: "11111111-1111-4111-8111-111111111111",
  scenarioId: "22222222-2222-4222-8222-222222222222",
  assumptionVersion: 1,
  modelVersion: "forecast-v1",
  actualsCutoff: "2026-09-20",
  sourceFingerprint: "0".repeat(64),
  resultSha256: "1".repeat(64),
  label: null,
  completeness: "partial" as const,
  checksPassed: true,
  openingCashKnown: true,
  parametersSha256: "2".repeat(64),
  createdBy: "test",
  createdAt: "2026-09-26T12:00:00.000Z",
};

test("QBO approval guard requires an acknowledgement for partial or unreconciled evidence", () => {
  const snapshot = forecastSnapshotMetaSchema.parse({
    ...base,
    qboOpeningCoverage: "partial",
    qboOpeningMappingCoverage: "partial",
    qboOpeningReconciliation: "unreconciled",
    qboOpeningFreshness: "unknown",
  });
  assert.equal(qboOpeningApprovalIssue(snapshot), "coverage partial, account mapping partial, reconciliation unreconciled, freshness unknown");
});

test("QBO approval guard allows complete live reconciled evidence", () => {
  const snapshot = forecastSnapshotMetaSchema.parse({
    ...base,
    completeness: "complete",
    qboOpeningCoverage: "complete",
    qboOpeningMappingCoverage: "complete",
    qboOpeningReconciliation: "reconciled",
    qboOpeningFreshness: "live_read",
  });
  assert.equal(qboOpeningApprovalIssue(snapshot), null);
});

test("snapshots without QBO evidence keep the existing unknown-cash approval path", () => {
  const snapshot = forecastSnapshotMetaSchema.parse(base);
  assert.equal(qboOpeningApprovalIssue(snapshot), null);
});

test("scenario approval refuses a stored partial QBO opening until it is acknowledged", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    const executor = await createSyntheticRuntimeExecutor(fixture.db);
    const { organizationId, actorId } = SYNTHETIC_COMPANY;
    const qboAmount = (amountCents: string) => ({ amountCents, state: "partial" as const, asOf: SYNTHETIC_FORECAST_CUTOFF, sourceIds: ["qbo:balance-sheet"] });
    const qbo: ForecastQboOpeningBalance = {
      organizationId, legalEntityId: "entity-qbo", entityScope: ["entity-qbo"], realmId: "realm-qbo", environment: "production",
      asOf: SYNTHETIC_FORECAST_CUTOFF, basis: "Accrual", currency: "USD", observedAt: "2026-12-28T12:00:00.000Z", freshness: "live_read",
      coverage: "partial", mappingCoverage: "partial", reconciliation: "unreconciled", reportSourceId: "qbo:balance-sheet", sourceIds: ["qbo:balance-sheet"],
      operatingCash: qboAmount("12000000"), restrictedCash: qboAmount("1000000"), accountsPayable: qboAmount("610000"), propertyBookBalances: {},
    };
    const baseSources = syntheticForecastSources();
    const sourceData: ForecastSourceData = {
      ...baseSources,
      items: OPENING_ITEM_KEYS.map(key => ({
        key, label: OPENING_ITEM_LABELS[key], amountCents: key === "cash_operating" ? "12000000" : key === "cash_restricted" ? "1000000" : key === "accounts_payable" ? "610000" : "0",
        asOf: SYNTHETIC_FORECAST_CUTOFF, state: key === "cash_operating" || key === "cash_restricted" || key === "accounts_payable" ? "partial" as const : "sourced" as const,
        source: key === "cash_operating" || key === "cash_restricted" || key === "accounts_payable" ? "QuickBooks Online native BalanceSheet" : "Synthetic source", sourceIds: [`source:${key}`],
      })),
      qboOpening: qbo,
    };
    const port = createForecastingPort(executor, { today: () => "2026-12-28", sources: () => ({ read: async () => sourceData }) });
    const principal = await loadAuthenticatedPrincipal(executor, { actorId, organizationId, role: "admin" });
    const access = { principal, resolvePrincipal: (connection = executor) => loadAuthenticatedPrincipal(connection, { actorId, organizationId, role: "admin" }), transport: attestTransport("web") };
    const scope = { organizationId };
    const envelope = (payload: Record<string, unknown>, expectedRevision?: number) => ({ operationId: randomUUID(), idempotencyKey: `qbo-approval:${randomUUID()}`, scope, ...(expectedRevision === undefined ? {} : { expectedRevision }), payload });
    const create = await port.execute("forecast.scenario.create", envelope({ name: "QBO guard", kind: "base", startDate: SYNTHETIC_FORECAST_START, horizonWeeks: 13, horizonMonths: 24, reserveFloorCents: "2500000", assumptions: syntheticForecastAssumptionsInput() }), access);
    const scenarioId = String(create.affectedRecordIds[0]);
    const snapshot = await port.execute("forecast.snapshot.create", envelope({ scenarioId }), access);
    const snapshotId = String(snapshot.affectedRecordIds[0]);
    const detail = await port.get(principal, { scope, scenarioId });
    assert.equal(detail.snapshots[0]?.qboOpeningCoverage, "partial");
    assert.equal(detail.snapshots[0]?.qboOpeningReconciliation, "unreconciled");
    await assert.rejects(port.execute("forecast.scenario.approve", envelope({ scenarioId, snapshotId }, detail.recordRevision), access), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "validation");
      assert.equal((error as { details?: { reason?: string } }).details?.reason, "forecast_qbo_opening_incomplete");
      return true;
    });
    await assert.rejects(port.execute("forecast.scenario.approve", envelope({ scenarioId, snapshotId, acknowledgeIncompleteOpening: true }, detail.recordRevision), access), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "validation");
      return true;
    });
    const approved = await port.execute("forecast.scenario.approve", envelope({ scenarioId, snapshotId, acknowledgeIncompleteOpening: true, reason: "Reviewed QBO report; independent reconciliation is pending" }, detail.recordRevision), access);
    assert.ok(approved.validationOutcomes.some(outcome => outcome.code === "forecast.qbo_opening_acknowledged"));
    const after = await port.get(principal, { scope, scenarioId });
    assert.match(after.approvalNote ?? "", /incomplete QBO opening/);
    assert.match(after.approvalNote ?? "", /reconciliation unreconciled/);
  } finally {
    await fixture.close();
  }
});
