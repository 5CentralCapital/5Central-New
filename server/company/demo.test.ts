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
    const approved = await demo.database.db.query<{ state: string; approved: boolean }>("SELECT state, approved_snapshot_id IS NOT NULL AS approved FROM company_forecast_scenarios WHERE organization_id=$1", [organizationId]);
    assert.deepEqual(approved.rows[0], { state: "approved", approved: true });
    const futurePastMoveIn = await demo.database.db.query("SELECT id FROM rent_ops_tenancies WHERE status='future' AND COALESCE(actual_move_in_on, planned_move_in_on) <= CURRENT_DATE");
    assert.equal(futurePastMoveIn.rows.length, 0, "demo advances future tenancies whose move-in has passed");
    assert.equal(await count("company_forecast_snapshots"), 1);
    assert.equal(await count("company_projects"), 1);
    assert.equal(await count("company_investor_accounts"), 1);
    assert.ok(await count("company_review_cases") > 0, "detection opened review cases");
  } finally { await demo.close(); }
});
