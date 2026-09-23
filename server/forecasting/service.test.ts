import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ForecastCommandKind } from "../../shared/forecasting/contracts";
import { FORECAST_MODEL_VERSION } from "../../shared/forecasting/result";
import { getReportingDefinition, reportRunRequestSchema, type ReportingEngineContext } from "../../shared/reporting";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import { canonicalJsonSha256 } from "../company/commands/fingerprint";
import { CompanyCommandError } from "../company/commands/errors";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { createForecastReportingEngine } from "../reporting/forecast-engine";
import { ReportingError } from "../reporting/errors";
import { createForecastingPort } from "./port";
import { createForecastReportingReadPort } from "./reporting-port";
import { forecastStore } from "./store";
import { syntheticForecastAssumptionsInput, SYNTHETIC_FORECAST_START } from "./testing/fixture";

const { organizationId, entityId, actorId, propertyId, unitId } = SYNTHETIC_COMPANY;
const TODAY = "2026-12-28";

async function setup() {
  const fixture = await createSyntheticCompanyDatabase();
  const db = fixture.db;
  // Synthetic sources: one held deposit and extra grants for authorization tests.
  await db.query("INSERT INTO rent_ops_people(id,first_name,last_name) VALUES ('fc-person-1','Example','Resident')");
  await db.query("INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,created_at) VALUES ('fc-tenancy-1',$1,$2,'fc-person-1','current',now())", [propertyId, unitId]);
  await db.query("INSERT INTO rent_ops_security_deposits(id,property_id,unit_id,tenancy_id,person_id,type,amount_held_cents,received_on,disposition_status) VALUES ('fc-deposit-1',$1,$2,'fc-tenancy-1','fc-person-1','security',125000,'2026-01-05','held')", [propertyId, unitId]);
  await db.query(`INSERT INTO company_access_grants(id,organization_id,actor_id,role,legal_entity_id) VALUES
    ('40000000-0000-4000-8000-0000000000f1',$1,'finance-user','finance',NULL),
    ('40000000-0000-4000-8000-0000000000f2',$1,'reviewer-user','read_only_reviewer',NULL),
    ('40000000-0000-4000-8000-0000000000f3',$1,'entity-admin','admin',$2)`, [organizationId, entityId]);
  const executor = await createSyntheticRuntimeExecutor(db);
  const port = createForecastingPort(executor, { today: () => TODAY });
  const accessFor = async (actor = actorId, role: "admin" | "finance" | "read_only_reviewer" = "admin") => {
    const resolvePrincipal = (connection = executor) => loadAuthenticatedPrincipal(connection, { actorId: actor, organizationId, role });
    return { principal: await resolvePrincipal(), resolvePrincipal, transport: attestTransport("web") };
  };
  const access = await accessFor();
  const scope = { organizationId };
  const envelope = (payload: Record<string, unknown>, expectedRevision?: number) => {
    const operationId = randomUUID();
    return { operationId, idempotencyKey: `fc-test:${operationId}`, scope, ...(expectedRevision === undefined ? {} : { expectedRevision }), payload };
  };
  const run = (kind: ForecastCommandKind, payload: Record<string, unknown>, expectedRevision?: number, commandAccess = access) => port.execute(kind, envelope(payload, expectedRevision), commandAccess);
  const createBase = async (name = "Base case") => {
    const receipt = await run("forecast.scenario.create", { name, kind: "base", startDate: SYNTHETIC_FORECAST_START, horizonWeeks: 13, horizonMonths: 24, reserveFloorCents: "2500000", assumptions: syntheticForecastAssumptionsInput() });
    return String(receipt.affectedRecordIds[0]);
  };
  return { fixture, db, executor, port, access, accessFor, scope, envelope, run, createBase };
}

const rejectsWith = async (promise: Promise<unknown>, code: string, reason?: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CompanyCommandError, String(error));
    assert.equal(error.code, code, error.message);
    if (reason) assert.equal(error.details.reason, reason, error.message);
    return true;
  });
};

test("scenario lifecycle: create, snapshot, reproduce, version, approve", async () => {
  const { fixture, port, access, scope, run, createBase } = await setup();
  try {
    const scenarioId = await createBase();
    let detail = await port.get(access.principal, { scope, scenarioId });
    assert.equal(detail.state, "draft");
    assert.equal(detail.currentAssumptionVersion, 1);
    assert.equal(detail.versions.length, 1);
    assert.equal(detail.versions[0]!.reason, "Initial assumptions");
    assert.equal(detail.createdBy, actorId);

    const first = await run("forecast.snapshot.create", { scenarioId, label: "Board draft" });
    assert.equal(first.state, "saved_in_rops");
    assert.ok(first.validationOutcomes.some(outcome => outcome.code === "forecast.opening_incomplete"), "unknown opening cash is surfaced");
    const snapshotId = String(first.affectedRecordIds[0]);
    const view = await port.snapshot(access.principal, { scope, snapshotId });
    assert.equal(view.snapshot.modelVersion, FORECAST_MODEL_VERSION);
    assert.equal(view.snapshot.assumptionVersion, 1);
    assert.equal(view.snapshot.label, "Board draft");
    assert.ok(view.snapshot.checksPassed);
    assert.equal(view.result.completeness, "partial");
    assert.ok(view.result.opening.unknown.includes("Operating cash"));
    const deposits = view.result.opening.items.find(item => item.key === "deposits_held")!;
    assert.equal(deposits.state, "sourced");
    assert.equal(deposits.amountCents, "125000");
    assert.ok(!("events" in view.result), "bulk events are not returned");

    // Same model, assumptions and sources reproduce the same hashes.
    const second = await run("forecast.snapshot.create", { scenarioId });
    const again = await port.snapshot(access.principal, { scope, snapshotId: String(second.affectedRecordIds[0]) });
    assert.equal(again.snapshot.resultSha256, view.snapshot.resultSha256);
    assert.equal(again.snapshot.sourceFingerprint, view.snapshot.sourceFingerprint);
    const stored = await forecastStore.getSnapshot(fixture.executor, organizationId, snapshotId);
    assert.equal(canonicalJsonSha256(stored!.result), view.snapshot.resultSha256, "stored JSON re-hashes to the recorded hash");

    // Approve requires the current version's snapshot and owner/admin role.
    detail = await port.get(access.principal, { scope, scenarioId });
    const approved = await run("forecast.scenario.approve", { scenarioId, snapshotId }, detail.recordRevision);
    detail = await port.get(access.principal, { scope, scenarioId });
    assert.equal(detail.state, "approved");
    assert.equal(detail.recordRevision, approved.resultingRevisions[0]!.revision);

    // A new assumption version (with a reason) returns the scenario to draft.
    const doc = syntheticForecastAssumptionsInput();
    doc.leasing!.badDebtBps = 250;
    await rejectsWith(run("forecast.assumptions.save", { scenarioId, assumptions: doc }, detail.recordRevision), "validation");
    const saved = await run("forecast.assumptions.save", { scenarioId, assumptions: doc, reason: "Higher bad debt from Q4 collections" }, detail.recordRevision);
    detail = await port.get(access.principal, { scope, scenarioId });
    assert.equal(detail.state, "draft");
    assert.equal(detail.currentAssumptionVersion, 2);
    assert.equal(detail.versions[0]!.reason, "Higher bad debt from Q4 collections");
    await rejectsWith(run("forecast.scenario.approve", { scenarioId, snapshotId }, detail.recordRevision), "conflict", "forecast_snapshot_stale");
    // Stale revision is a conflict.
    await rejectsWith(run("forecast.assumptions.save", { scenarioId, assumptions: syntheticForecastAssumptionsInput(), reason: "stale" }, saved.resultingRevisions[0]!.revision - 1), "conflict", "revision_conflict");
    // Revert = restore version 1 as version 3 (reversible, history kept).
    await run("forecast.assumptions.save", { scenarioId, fromVersion: 1, reason: "Back to the approved base" }, detail.recordRevision);
    detail = await port.get(access.principal, { scope, scenarioId });
    assert.equal(detail.currentAssumptionVersion, 3);
    assert.match(detail.versions[0]!.reason, /^Restored version 1: /);
    assert.equal(detail.versions[0]!.assumptionsSha256, detail.versions[2]!.assumptionsSha256);
    await rejectsWith(run("forecast.assumptions.save", { scenarioId, fromVersion: 1, reason: "again" }, detail.recordRevision), "validation", "forecast_assumptions_unchanged");
  } finally {
    await fixture.close();
  }
});

test("commands replay idempotently and refuse a reused key with different input", async () => {
  const { fixture, port, access, scope, envelope, createBase } = await setup();
  try {
    const scenarioId = await createBase();
    const detail = await port.get(access.principal, { scope, scenarioId });
    const doc = syntheticForecastAssumptionsInput();
    doc.leasing!.vacancyDays = 45;
    const command = envelope({ scenarioId, assumptions: doc, reason: "Slower lease-up" }, detail.recordRevision);
    const first = await port.execute("forecast.assumptions.save", command, access);
    const replay = await port.execute("forecast.assumptions.save", command, access);
    assert.deepEqual(replay, first);
    const after = await port.get(access.principal, { scope, scenarioId });
    assert.equal(after.versions.length, 2, "one version despite the retry");
    const conflicting = { ...command, payload: { ...command.payload, reason: "Different" } };
    await rejectsWith(port.execute("forecast.assumptions.save", conflicting, access), "conflict", "idempotency_key_conflict");
  } finally {
    await fixture.close();
  }
});

test("overrides are stamped with the author and date and can be removed", async () => {
  const { fixture, port, access, scope, run, createBase } = await setup();
  try {
    const scenarioId = await createBase();
    let detail = await port.get(access.principal, { scope, scenarioId });
    await run("forecast.override.set", { scenarioId, reason: "Bank statement 12/27", override: { id: "open-cash", kind: "opening_balance", item: "cash_operating", amountCents: "8400000", asOf: "2026-12-27" } }, detail.recordRevision);
    detail = await port.get(access.principal, { scope, scenarioId });
    const override = (detail.assumptions!.overrides as Record<string, unknown>[])[0]!;
    assert.equal(override.author, actorId);
    assert.equal(override.reason, "Bank statement 12/27");
    assert.equal(override.setOn, "2026-12-28");
    assert.match(detail.versions[0]!.reason, /^Override open-cash: /);
    const preview = await port.preview(access.principal, { scope, scenarioId });
    const cash = preview.result.opening.items.find(item => item.key === "cash_operating")!;
    assert.equal(cash.state, "manual");
    assert.equal(cash.amountCents, "8400000");
    assert.ok(!preview.result.opening.unknown.includes("Operating cash"));
    await rejectsWith(run("forecast.override.set", { scenarioId, reason: "x", removeOverrideId: "missing" }, detail.recordRevision), "validation", "forecast_override_not_found");
    await run("forecast.override.set", { scenarioId, reason: "Superseded by QuickBooks", removeOverrideId: "open-cash" }, detail.recordRevision);
    detail = await port.get(access.principal, { scope, scenarioId });
    assert.equal((detail.assumptions!.overrides as unknown[]).length, 0);
    assert.equal(detail.currentAssumptionVersion, 3);
  } finally {
    await fixture.close();
  }
});

test("authorization: organization-level finance grants only; approval is owner/admin; revocation closes reads", async () => {
  const { fixture, db, port, accessFor, scope, run, createBase } = await setup();
  try {
    const scenarioId = await createBase();
    const finance = await accessFor("finance-user", "finance");
    const reviewer = await accessFor("reviewer-user", "read_only_reviewer");
    const entityAdmin = await accessFor("entity-admin", "admin");
    // Finance can snapshot but not approve.
    const snapshot = await run("forecast.snapshot.create", { scenarioId }, undefined, finance);
    const detail = await port.get(finance.principal, { scope, scenarioId });
    await rejectsWith(run("forecast.scenario.approve", { scenarioId, snapshotId: String(snapshot.affectedRecordIds[0]) }, detail.recordRevision, finance), "forbidden");
    // Reviewers read but cannot write.
    assert.equal((await port.list(reviewer.principal, { scope })).items.length, 1);
    await rejectsWith(run("forecast.snapshot.create", { scenarioId }, undefined, reviewer), "forbidden");
    // An entity-scoped grant cannot read or write company-wide forecasts.
    await rejectsWith(port.list(entityAdmin.principal, { scope }), "forbidden");
    await rejectsWith(port.execute("forecast.snapshot.create", { operationId: randomUUID(), idempotencyKey: `fc:${randomUUID()}`, scope: { organizationId, legalEntityId: entityId }, payload: { scenarioId } }, entityAdmin), "forbidden");
    // Revoking a grant closes reads inside the next snapshot.
    await db.query("UPDATE company_access_grants SET revoked_at = now() WHERE actor_id = 'reviewer-user'");
    await rejectsWith(port.list(reviewer.principal, { scope }), "forbidden");
  } finally {
    await fixture.close();
  }
});

test("history is immutable and archived scenarios refuse changes", async () => {
  const { fixture, executor, port, access, scope, run, createBase } = await setup();
  try {
    const scenarioId = await createBase();
    await run("forecast.snapshot.create", { scenarioId });
    await assert.rejects(executor.query("UPDATE company_forecast_assumption_versions SET reason = 'edited' WHERE scenario_id = $1", [scenarioId]));
    await assert.rejects(executor.query("DELETE FROM company_forecast_snapshots WHERE scenario_id = $1", [scenarioId]));
    await assert.rejects(fixture.db.query("UPDATE company_forecast_snapshots SET label = 'edited' WHERE scenario_id = $1", [scenarioId]), /immutable/);
    const detail = await port.get(access.principal, { scope, scenarioId });
    await run("forecast.scenario.archive", { scenarioId }, detail.recordRevision);
    const archived = await port.get(access.principal, { scope, scenarioId });
    assert.equal(archived.state, "archived");
    assert.ok(archived.archivedAt);
    await rejectsWith(run("forecast.snapshot.create", { scenarioId }), "conflict", "forecast_scenario_archived");
    await rejectsWith(run("forecast.scenario.update", { scenarioId, name: "Renamed" }, archived.recordRevision), "conflict", "forecast_scenario_archived");
    // The archived name is free again.
    await createBase("Base case");
  } finally {
    await fixture.close();
  }
});

test("listing pages by cursor and duplicate scenarios copy assumptions", async () => {
  const { fixture, port, access, scope, run, createBase } = await setup();
  try {
    const baseId = await createBase("Base");
    const downside = await run("forecast.scenario.create", { name: "Downside", kind: "downside", startDate: SYNTHETIC_FORECAST_START, baseScenarioId: baseId });
    await run("forecast.scenario.create", { name: "Blank custom", kind: "custom", startDate: "2027-01-04" });
    await rejectsWith(run("forecast.scenario.create", { name: "base", kind: "custom", startDate: "2027-01-04" }), "conflict", "forecast_scenario_name_taken");
    await rejectsWith(run("forecast.scenario.create", { name: "Tuesday", kind: "custom", startDate: "2027-01-05" }), "validation");
    const page1 = await port.list(access.principal, { scope, limit: 2 });
    assert.equal(page1.items.length, 2);
    assert.ok(page1.nextCursor);
    const page2 = await port.list(access.principal, { scope, limit: 2, cursor: page1.nextCursor! });
    assert.equal(page2.items.length, 1);
    assert.equal(page2.nextCursor, null);
    assert.equal(new Set([...page1.items, ...page2.items].map(item => item.id)).size, 3);
    const copy = await port.get(access.principal, { scope, scenarioId: String(downside.affectedRecordIds[0]) });
    const base = await port.get(access.principal, { scope, scenarioId: baseId });
    assert.equal(copy.baseScenarioId, baseId);
    assert.equal(copy.versions[0]!.assumptionsSha256, base.versions[0]!.assumptionsSha256);
    assert.match(copy.versions[0]!.reason, /^Duplicated from Base version 1/);
  } finally {
    await fixture.close();
  }
});

test("explain drills every figure to events that sum to it; compare lists changed assumptions", async () => {
  const { fixture, port, access, scope, run, createBase } = await setup();
  try {
    const baseId = await createBase("Base");
    const baseSnap = String((await run("forecast.snapshot.create", { scenarioId: baseId })).affectedRecordIds[0]);
    const view = await port.snapshot(access.principal, { scope, snapshotId: baseSnap });
    const week = view.result.weeks[1]!;
    const month = view.result.months[3]!;
    const check = async (line: string, period: string, expected: string) => {
      const explained = await port.explain(access.principal, { scope, source: { snapshotId: baseSnap }, line, period, limit: 500 });
      assert.equal(explained.totalCents, expected, `${line} ${period}`);
      const sum = explained.contributions.reduce((total, item) => total + BigInt(item.amountCents), BigInt(explained.openingCents ?? "0"));
      assert.equal(sum.toString(), expected);
      return explained;
    };
    const closing = await check("cash.closing", week.key, week.closingCashCents);
    assert.equal(closing.openingCents, week.openingCashCents);
    await check("cash.inflows", week.key, week.inflowsCents);
    await check("cash.outflows", week.key, week.outflowsCents);
    await check("is.noi", month.key, month.noiCents);
    await check("is.net_income", month.key, month.netIncomeCents);
    await check("cf.operating", month.key, month.cashFlow.operatingCents);
    await check("cf.financing", month.key, month.cashFlow.financingCents);
    await check("bs.debt", month.key, month.balance.debt!);
    await check("bs.retained_earnings", month.key, month.balance.retained_earnings!);
    const debt = await check("debt.service", month.key, view.result.debt.coverage[3]!.debtServiceCents);
    assert.ok(debt.inputs.some(input => input.ref === "loans[loan-a]"));
    const rent = await port.explain(access.principal, { scope, source: { scenarioId: baseId }, line: "ops.scheduled_rent", period: month.key, limit: 2 });
    assert.equal(rent.contributions.length, 2);
    assert.ok(rent.nextCursor);
    assert.ok(rent.inputs.some(input => input.ref.startsWith("units[")));
    await rejectsWith(port.explain(access.principal, { scope, source: { snapshotId: baseSnap }, line: "is.noi", period: week.key }), "validation", "forecast_period_monthly_only");

    const downside = String((await run("forecast.scenario.create", { name: "Downside", kind: "downside", startDate: SYNTHETIC_FORECAST_START, baseScenarioId: baseId })).affectedRecordIds[0]);
    const downDetail = await port.get(access.principal, { scope, scenarioId: downside });
    const doc = syntheticForecastAssumptionsInput();
    doc.leasing!.badDebtBps = 500;
    doc.leasing!.collectionsBps = 9_300;
    await run("forecast.assumptions.save", { scenarioId: downside, assumptions: doc, reason: "Downside collections" }, downDetail.recordRevision);
    const downSnap = String((await run("forecast.snapshot.create", { scenarioId: downside })).affectedRecordIds[0]);
    const compared = await port.compare(access.principal, { scope, snapshotA: baseSnap, snapshotB: downSnap });
    assert.deepEqual(compared.assumptionChanges.map(change => change.path).sort(), ["leasing.badDebtBps", "leasing.collectionsBps"]);
    assert.equal(compared.a.scenarioName, "Base");
    assert.equal(compared.b.scenarioKind, "downside");
    assert.ok(compared.contributingEventCount > 0);
    assert.ok(compared.contributingEvents.every(event => BigInt(event.deltaCashCents) !== BigInt(0) || BigInt(event.deltaIncomeCents) !== BigInt(0)));
    assert.equal(compared.weekly.length, 13);
  } finally {
    await fixture.close();
  }
});

test("the reporting port runs the four forecast reports from saved snapshots", async () => {
  const { fixture, executor, port, access, run, createBase } = await setup();
  try {
    const scenarioId = await createBase();
    const snapshotId = String((await run("forecast.snapshot.create", { scenarioId })).affectedRecordIds[0]);
    const readPort = createForecastReportingReadPort(port, { principal: access.principal });
    const reportScope = { organizationId, legalEntityIds: [], propertyIds: [], unitIds: [], tenantIds: [], tenancyIds: [], ownerIds: [], investorIds: [], projectIds: [], vendorIds: [], staffIds: [] };
    const context = (reportId: string, inputVersion: string): ReportingEngineContext => ({
      runId: "11111111-1111-4111-8111-111111111112", snapshotId: "11111111-1111-4111-8111-111111111113", now: "2026-12-28T12:00:00.000Z" as never,
      request: reportRunRequestSchema.parse({ reportId, definitionVersion: "1", scope: reportScope, filters: {}, period: { mode: "custom", fromDate: "2026-12-28", toDate: "2027-03-28" }, basis: "mixed", currency: "USD",
        forecast: { scenarioId, inputVersion, modelVersion: FORECAST_MODEL_VERSION } }),
      definition: getReportingDefinition(reportId)!,
    });
    const bySnapshot = await readPort.read({ context: context("cash-forecast-13-week", snapshotId), scenarioId, inputVersion: snapshotId, modelVersion: FORECAST_MODEL_VERSION });
    const byVersion = await readPort.read({ context: context("cash-forecast-13-week", "v1"), scenarioId, inputVersion: "v1", modelVersion: FORECAST_MODEL_VERSION });
    assert.deepEqual(byVersion.weeks, bySnapshot.weeks);
    assert.equal(bySnapshot.weeks!.length, 13);
    assert.equal(bySnapshot.coverage.state, "partial");
    assert.equal(bySnapshot.coverage.evidence, "reproducible_snapshot");
    assert.ok(bySnapshot.actuals.every(row => row.date < bySnapshot.weeks![0]!.weekStart));
    assert.ok(bySnapshot.growth!.some(line => line.metric === "Net operating income"));
    assert.ok(bySnapshot.debt!.some(line => line.debtId === "loan-c" && line.refinanceBalanceCents === "5500000"));
    assert.ok(bySnapshot.exits!.length >= 1);
    // All four forecast reports run through the reporting engine from the snapshot.
    const engine = createForecastReportingEngine(readPort);
    const cash = await engine.run(context("cash-forecast-13-week", "v1"));
    assert.equal(cash.rows.length, 13);
    for (const reportId of ["operating-growth-plan", "debt-refinance", "exit-scenarios"]) {
      const report = await engine.run(context(reportId, snapshotId));
      assert.ok(report.rows.length > 0, reportId);
    }
    await assert.rejects(readPort.read({ context: context("cash-forecast-13-week", "v9"), scenarioId, inputVersion: "v9", modelVersion: FORECAST_MODEL_VERSION }), (error: unknown) => error instanceof ReportingError && error.code === "report_unavailable");
    const direct = createForecastReportingReadPort(executor);
    assert.deepEqual((await direct.read({ context: context("debt-refinance", "1"), scenarioId, inputVersion: "1", modelVersion: FORECAST_MODEL_VERSION })).debt, bySnapshot.debt);
    const withoutPrincipal = createForecastReportingReadPort(port);
    await assert.rejects(withoutPrincipal.read({ context: context("debt-refinance", "1"), scenarioId, inputVersion: "1", modelVersion: FORECAST_MODEL_VERSION }), (error: unknown) => error instanceof ReportingError && error.code === "report_forbidden");
  } finally {
    await fixture.close();
  }
});
