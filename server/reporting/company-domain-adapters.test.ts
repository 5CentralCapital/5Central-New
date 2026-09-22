import assert from "node:assert/strict";
import test from "node:test";
import { createAuthenticatedPrincipal } from "../company/authorization";
import { syntheticRentOpsSnapshot } from "../rent-ops/fixtures/synthetic";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { getReportingDefinition, reportRunRequestSchema } from "../../shared/reporting";
import { createCompanyDomainReportingEngines } from "./company-domain-adapters";

const organizationId = "10000000-0000-4000-8000-000000000001";

test("company rental adapter keeps an organization scope empty when no dated property mapping exists", async () => {
  const snapshot = syntheticRentOpsSnapshot();
  const rentalService = { async reportSnapshot() { return snapshot; } };
  const executor: RentOpsQueryExecutor = { async query() { return { rows: [] }; } };
  const principal = createAuthenticatedPrincipal({ actorId: "demo-admin", organizationId, role: "admin", authorizedScopes: [{}] });
  const engines = createCompanyDomainReportingEngines({ executor, principal, rentalService: rentalService as never });
  const engine = engines.find(candidate => candidate.reportIds.includes("current-tenants"));
  assert.ok(engine);
  const request = reportRunRequestSchema.parse({
    reportId: "current-tenants", definitionVersion: "1",
    scope: { organizationId, legalEntityIds: [], propertyIds: [], unitIds: [], tenantIds: [], tenancyIds: [], ownerIds: [], investorIds: [], projectIds: [], vendorIds: [], staffIds: [] },
    filters: {}, period: { mode: "as_of", asOfDate: "2026-09-21" }, basis: "operational", currency: null,
  });
  const result = await engine.run({ runId: "11111111-1111-4111-8111-111111111111", snapshotId: "22222222-2222-4222-8222-222222222222", request, definition: getReportingDefinition("current-tenants")!, now: "2026-09-21T12:00:00.000Z" });
  assert.equal(result.rows.length, 0);
  assert.equal(result.missingData?.[0]?.code, "rental_source_empty");
});

