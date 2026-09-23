import assert from "node:assert/strict";
import test from "node:test";
import { createCompanyDemoApp } from "./demo";
import { SYNTHETIC_COMPANY } from "./testing/synthetic-database";

test("the local company demo seeds PM statements, forecasts, projects, investors and review cases through shared commands", async () => {
  const demo = await createCompanyDemoApp({ companyDemoData: true });
  try {
    const { organizationId } = SYNTHETIC_COMPANY;
    const count = async (table: string) => Number((await demo.database.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id=$1`, [organizationId])).rows[0]!.n);
    assert.equal(await count("accounting_pm_settlements"), 1);
    assert.equal(await count("company_forecast_scenarios"), 1);
    assert.equal(await count("company_forecast_snapshots"), 1);
    assert.equal(await count("company_projects"), 1);
    assert.equal(await count("company_investor_accounts"), 1);
    assert.ok(await count("company_review_cases") > 0, "detection opened review cases");
  } finally { await demo.close(); }
});
