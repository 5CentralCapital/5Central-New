import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ForecastCommandKind } from "../../shared/forecasting/contracts";
import { FORECAST_MODEL_VERSION } from "../../shared/forecasting/result";
import { getReportingDefinition, reportRunRequestSchema, type ReportingEngineContext } from "../../shared/reporting";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import { createCompanyServices } from "../company/services";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { ReportingError } from "../reporting/errors";
import { createForecastReportingEngine, type ForecastReportingReadResult } from "../reporting/forecast-engine";
import { syntheticForecastAssumptionsInput, SYNTHETIC_FORECAST_START } from "./testing/fixture";

const { organizationId, entityId, actorId, propertyId } = SYNTHETIC_COMPANY;
const FORECAST_REPORTS = ["cash-forecast-13-week", "operating-growth-plan", "debt-refinance", "exit-scenarios"];

/**
 * Forecast reports run through the company reporting service with the same
 * rule as the forecasting workspace: an organization-wide owner, admin,
 * finance or reviewer grant, and only the approved snapshot.
 */
test("company forecast reports enforce forecast authorization and read only approved scenarios", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    await fixture.db.query(`INSERT INTO company_access_grants(id,organization_id,actor_id,role,legal_entity_id,property_id) VALUES
      ('40000000-0000-4000-8000-0000000000e1',$1,'entity-admin','admin',$2,NULL),
      ('40000000-0000-4000-8000-0000000000e2',$1,'property-finance','finance',$2,$3),
      ('40000000-0000-4000-8000-0000000000e3',$1,'org-pm','operations_pm',NULL,NULL),
      ('40000000-0000-4000-8000-0000000000e4',$1,'org-finance','finance',NULL,NULL)`, [organizationId, entityId, propertyId]);
    const executor = await createSyntheticRuntimeExecutor(fixture.db);
    const services = createCompanyServices(executor, { accounting: { environment: {} }, time: { env: {} } });
    const forecasting = services.forecasting;
    const principal = (actor: string, role: "admin" | "finance" | "operations_pm") => loadAuthenticatedPrincipal(executor, { actorId: actor, organizationId, role });
    const admin = await principal(actorId, "admin");
    const access = { principal: admin, resolvePrincipal: (connection = executor) => loadAuthenticatedPrincipal(connection, { actorId, organizationId, role: "admin" }), transport: attestTransport("web") };
    const run = (kind: ForecastCommandKind, payload: Record<string, unknown>, expectedRevision?: number) => {
      const operationId = randomUUID();
      return forecasting.execute(kind, { operationId, idempotencyKey: `fc-access:${operationId}`, scope: { organizationId }, ...(expectedRevision === undefined ? {} : { expectedRevision }), payload }, access);
    };
    const scope = { organizationId };
    const scenarioId = String((await run("forecast.scenario.create", { name: "Base", kind: "base", startDate: SYNTHETIC_FORECAST_START, horizonWeeks: 13, horizonMonths: 24, reserveFloorCents: "2500000", assumptions: syntheticForecastAssumptionsInput() })).affectedRecordIds[0]);
    let detail = await forecasting.get(admin, { scope, scenarioId });
    await run("forecast.override.set", { scenarioId, reason: "Bank statement", override: { id: "open-cash", kind: "opening_balance", item: "cash_operating", amountCents: "8400000", asOf: "2026-12-27" } }, detail.recordRevision);
    detail = await forecasting.get(admin, { scope, scenarioId });
    await run("forecast.override.set", { scenarioId, reason: "Reserve statement", override: { id: "open-reserve", kind: "opening_balance", item: "cash_restricted", amountCents: "600000", asOf: "2026-12-27" } }, detail.recordRevision);
    const snapshotId = String((await run("forecast.snapshot.create", { scenarioId })).affectedRecordIds[0]);

    const statusOf = async (reader: typeof admin) => {
      const entries = await services.reporting.catalog({ principal: reader });
      return Object.fromEntries(entries.filter(entry => FORECAST_REPORTS.includes(entry.id)).map(entry => [entry.id, [entry.runtimeStatus, entry.runtimeReason]]));
    };
    // A snapshot alone is not an approved scenario.
    for (const status of Object.values(await statusOf(admin))) assert.deepEqual(status, ["missing_data", "No approved forecast scenario."]);
    detail = await forecasting.get(admin, { scope, scenarioId });
    await run("forecast.scenario.approve", { scenarioId, snapshotId }, detail.recordRevision);
    for (const status of Object.values(await statusOf(admin))) assert.deepEqual(status, ["available", null]);

    const orgPm = await principal("org-pm", "operations_pm");
    for (const status of Object.values(await statusOf(orgPm))) assert.deepEqual(status, ["missing_data", "Forecast reports require company-wide finance access."]);

    const request = (reportId: string, reportScope: Record<string, unknown> = {}) => reportRunRequestSchema.parse({
      reportId, definitionVersion: "1", scope: { organizationId, ...reportScope }, filters: {}, period: { mode: "custom", fromDate: "2026-12-28", toDate: "2028-12-31" },
      basis: "mixed", currency: null, forecast: { scenarioId, inputVersion: snapshotId, modelVersion: FORECAST_MODEL_VERSION },
    });
    const denied = (error: unknown) => error instanceof ReportingError && (error.code === "report_forbidden" || error.code === "report_validation");
    const entityAdmin = await principal("entity-admin", "admin");
    const propertyFinance = await principal("property-finance", "finance");
    for (const reportId of FORECAST_REPORTS) {
      await assert.rejects(services.reporting.run({ principal: entityAdmin }, request(reportId, { legalEntityIds: [entityId] })), denied, `entity-scoped admin: ${reportId}`);
      await assert.rejects(services.reporting.run({ principal: propertyFinance }, request(reportId, { legalEntityIds: [entityId], propertyIds: [propertyId] })), denied, `property-scoped finance: ${reportId}`);
      await assert.rejects(services.reporting.run({ principal: orgPm }, request(reportId)), denied, `operations_pm: ${reportId}`);
    }
    await assert.rejects(services.reporting.run({ principal: entityAdmin }, request("debt-refinance", { legalEntityIds: [entityId] })), (error: unknown) => error instanceof ReportingError && error.code === "report_forbidden");

    const orgFinance = await principal("org-finance", "finance");
    for (const reportId of FORECAST_REPORTS) {
      const response = await services.reporting.run({ principal: orgFinance }, request(reportId));
      assert.ok(response.page.totalRows > 0, reportId);
    }
  } finally {
    await fixture.close();
  }
});

test("the 13-week engine keeps unknown balances unknown and still refuses partially missing balances", async () => {
  const weeks = Array.from({ length: 13 }, (_, index) => ({ weekStart: new Date(Date.UTC(2026, 11, 28 + index * 7)).toISOString().slice(0, 10), inflowsCents: "500", outflowsCents: "200", currency: "USD", openingCashCents: null, closingCashCents: null }));
  const source: ForecastReportingReadResult = { actuals: [{ date: "2026-12-27", category: "opening:deposits_held", amountCents: "100", currency: "USD", sourceId: "s1" }], weeks, coverage: { state: "partial", evidence: "reproducible_snapshot", watermark: null, reason: null } };
  const context: ReportingEngineContext = {
    runId: "11111111-1111-4111-8111-111111111112", snapshotId: "11111111-1111-4111-8111-111111111113", now: "2026-12-28T12:00:00.000Z" as never,
    request: reportRunRequestSchema.parse({ reportId: "cash-forecast-13-week", definitionVersion: "1", scope: { organizationId }, filters: {}, period: { mode: "custom", fromDate: "2026-12-28", toDate: "2027-03-28" }, basis: "mixed", currency: "USD", forecast: { scenarioId: "base", inputVersion: "v1", modelVersion: "m1" } }),
    definition: getReportingDefinition("cash-forecast-13-week")!,
  };
  let probed = 0;
  const engine = createForecastReportingEngine({ async read() { return source; }, async probe() { probed += 1; return { status: "missing_data", reason: "No approved forecast scenario.", dependency: "approved_forecast_scenario" }; } });
  const result = await engine.run(context);
  assert.equal(result.rows.length, 13);
  assert.ok(result.rows.every(row => row.values.openingCashCents === null && row.values.closingCashCents === null && row.values.netCents === "300"));
  assert.deepEqual(await engine.probe!({ organizationId, reportId: "cash-forecast-13-week" }), { status: "missing_data", reason: "No approved forecast scenario.", dependency: "approved_forecast_scenario" });
  assert.equal(probed, 1);
  const mixed = createForecastReportingEngine({ async read() { return { ...source, weeks: weeks.map((week, index) => index === 3 ? { ...week, openingCashCents: "0", closingCashCents: "300" } : week) }; } });
  await assert.rejects(mixed.run(context), /missing an explicit opening or closing cash balance/);
});
