import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { mcpToolError, toolAnnotations } from "./tools";
import { ConflictCommandError } from "../../company/commands/errors";

test("company command refusals reach MCP clients with their code and reason", () => {
  const result = mcpToolError(new ConflictCommandError("The job is not dead-lettered."));
  assert.equal(result.isError, true);
  assert.deepEqual((result.structuredContent as any).data.error, { code: "company_conflict", message: "The job is not dead-lettered." });
  const invalid = mcpToolError(z.object({ amount: z.number() }).safeParse({ amount: "x" }).error);
  assert.equal((invalid.structuredContent as any).data.error.code, "invalid_input");
  assert.equal((invalid.structuredContent as any).data.error.fields[0].path, "amount");
  // Unknown failures stay generic: no storage detail leaks.
  const generic = mcpToolError(new Error("relation rent_ops_secret does not exist"));
  assert.deepEqual(generic.content, [{ type: "text", text: "operation_rejected" }]);
});

test("annotations: requeue is not destructive; report runs and exports are not advertised as read-only", () => {
  assert.equal(toolAnnotations("requeue_job", { command: z.unknown() }, true).destructiveHint, false);
  assert.equal(toolAnnotations("cancel_job", { command: z.unknown() }, true).destructiveHint, true);
  for (const name of ["run_company_report", "run_company_report_package", "export_company_report"]) {
    assert.deepEqual(toolAnnotations(name, {}, false), { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, name);
  }
  assert.equal(toolAnnotations("list_company_reports", {}, false).readOnlyHint, true);
});
