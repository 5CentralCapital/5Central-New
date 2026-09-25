import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticCompanyDatabase, SYNTHETIC_COMPANY } from "./testing/synthetic-database";
import { createCompanyServices } from "./services";
import { readOpsCapabilities } from "./capabilities";

test("ops capabilities describe accessible companies, module status and existing workflow tools only", async () => {
  const database = await createSyntheticCompanyDatabase();
  try {
    const company = createCompanyServices(database.executor);
    const result = await readOpsCapabilities({ executor: company.executor, actorId: SYNTHETIC_COMPANY.actorId, reporting: company.reporting, reviewCases: company.reviewCases, toolNames: () => ["search", "list_review_cases", "run_company_report"] });
    assert.equal(result.product, "5Central Ops");
    assert.equal(result.organizations.length, 1);
    const [organization] = result.organizations;
    assert.equal(organization.organizationId, SYNTHETIC_COMPANY.organizationId);
    assert.equal(organization.reports.status, "available");
    if (organization.reports.status === "available") assert.equal(organization.reports.value.total, 53);
    for (const workflow of result.workflows) for (const tool of workflow.tools) assert.ok(["search", "list_review_cases", "run_company_report"].includes(tool));
    const stranger = await readOpsCapabilities({ executor: company.executor, actorId: "someone-else", toolNames: () => [] });
    assert.equal(stranger.organizations.length, 0, "no grant, no companies");
  } finally { await database.close(); }
});
