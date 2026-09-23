import assert from "node:assert/strict";
import test from "node:test";
import { registerProjectInsightMcpTools } from "./mcp";

test("the cost report tool describes incurred the way the report computes it", () => {
  const descriptions = new Map<string, string>();
  registerProjectInsightMcpTools((name, description) => { descriptions.set(name, description); }, { executor: {} as never, insights: {} as never, actorId: "synthetic" });
  const description = descriptions.get("get_project_cost_report");
  assert.ok(description);
  // Incurred = verified QBO actual + posted payroll + estimated labor (shared/projects/cost-report.ts, docs/company/project-execution.md).
  assert.match(description, /verified QBO actual plus posted payroll labor plus estimated labor/);
  assert.doesNotMatch(description, /estimated labor shown separately/);
});
