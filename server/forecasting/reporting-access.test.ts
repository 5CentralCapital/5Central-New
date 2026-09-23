import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ForecastCommandKind } from "../../shared/forecasting/contracts";
import { FORECAST_MODEL_VERSION } from "../../shared/forecasting/result";
import { reportRunRequestSchema } from "../../shared/reporting";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import { createCompanyServices } from "../company/services";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { ReportingError } from "../reporting/errors";
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
