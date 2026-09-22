import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticCompanyDatabase } from "../company/testing/synthetic-database";
import { createAuthenticatedPrincipal } from "../company/authorization";
import { getReportingDefinition } from "../../shared/reporting";
import { createReportingRegistry } from "./registry";
import { PostgresReportingStore } from "./postgres-store";
import { ReportingService } from "./service";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";

test("Postgres reporting store persists immutable headers and pages rows from the row table", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  const db = fixture.db;
  try {
    await db.query("INSERT INTO company_organizations(id,name) VALUES ($1,'Reporting test company')", ["11111111-1111-4111-8111-111111111111"]);
    const executor: RentOpsQueryExecutor = { query: (text, values) => db.query(text, values) };
    const organizationId = "11111111-1111-4111-8111-111111111111";
    const actorId = "22222222-2222-4222-8222-222222222222";
    const principal = createAuthenticatedPrincipal({ actorId, organizationId, role: "admin", authorizedScopes: [{}] });
    const scope = { organizationId, legalEntityIds: [], propertyIds: [], unitIds: [], tenantIds: [], tenancyIds: [], ownerIds: [], investorIds: [], projectIds: [], vendorIds: [], staffIds: [] } as const;
    const registry = createReportingRegistry({ engines: [{ key: "fixture", reportIds: ["rent-roll"], ready: true, async run() { return { columns: [{ id: "value", label: "Value", type: "text", sortable: true, filterable: true, sensitive: false }], rows: Array.from({ length: 3 }, (_item, index) => ({ rowId: `row-${index}`, values: { value: String(index) } })), coverage: [{ source: "fixture", state: "complete", evidence: "synthetic", basis: "operational", watermark: "fixture", observedAt: "2026-09-21T00:00:00.000Z", coveredFrom: null, coveredThrough: "2026-09-21", rowCount: 3, reason: null }], missingData: [] }; } }] });
    const service = new ReportingService({ registry, store: new PostgresReportingStore(executor), now: () => new Date("2026-09-21T00:00:00.000Z") });
    const result = await service.run({ principal }, { reportId: "rent-roll", definitionVersion: "1", scope, filters: { propertyScope: "all" }, period: { mode: "as_of", asOfDate: "2026-09-21" }, basis: "operational", currency: null });
    assert.equal(result.page.totalRows, 3);
    const page = await service.page({ principal }, { runId: result.run.id, limit: 2 });
    assert.deepEqual(page.rows.map(row => row.rowId), ["row-0", "row-1"]);
    const count = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM company_report_run_rows");
    assert.equal(count.rows[0].count, "3");
    const stored = await new PostgresReportingStore(executor).readRunMetadata(organizationId, result.run.id);
    assert.equal(stored?.rows.length, 0);
    assert.equal(stored?.snapshotId, result.run.snapshotId);
    assert.equal(getReportingDefinition("rent-roll")?.version, "1");

    const otherOrganizationId = "88888888-8888-4888-8888-888888888888";
    await db.query("INSERT INTO company_organizations(id,name) VALUES ($1,'Other reporting company')", [otherOrganizationId]);
    const otherPrincipal = createAuthenticatedPrincipal({ actorId: "99999999-9999-4999-8999-999999999999", organizationId: otherOrganizationId, role: "admin", authorizedScopes: [{}] });
    const otherScope = { ...scope, organizationId: otherOrganizationId } as const;
    const preset = await service.savePreset({ principal }, { name: "Company A preset", reportId: "rent-roll", scope, filters: { propertyScope: "all" }, period: { mode: "as_of", asOfDate: "2026-09-21" }, basis: "operational", currency: null });
    const otherService = new ReportingService({ registry, store: new PostgresReportingStore(executor), now: () => new Date("2026-09-21T00:00:00.000Z") });
    await assert.rejects(() => otherService.savePreset({ principal: otherPrincipal }, { id: preset.id, expectedRevision: 0, name: "Cross-company overwrite", reportId: "rent-roll", scope: otherScope, filters: { propertyScope: "all" }, period: { mode: "as_of", asOfDate: "2026-09-21" }, basis: "operational", currency: null }), /Preset changed/);
    assert.equal((await new PostgresReportingStore(executor).readPreset(organizationId, preset.id))?.name, "Company A preset");
  } finally { await db.close(); }
});
