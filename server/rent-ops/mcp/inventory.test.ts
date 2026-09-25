import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { collectMcpInventory, renderMcpInventory } from "../../../scripts/company/mcp-inventory";
import { OPS_WORKFLOW_GUIDE } from "../../company/capabilities";

test("generated MCP inventory matches the running server and annotations are consistent", async () => {
  const inventory = await collectMcpInventory();
  assert.equal(inventory.serverName, "5central-ops");
  assert.match(inventory.instructions ?? "", /get_ops_capabilities/);
  const names = inventory.tools.map(tool => tool.name);
  assert.equal(new Set(names).size, names.length, "tool names are unique");
  assert.ok(names.includes("get_ops_capabilities"));
  for (const tool of inventory.tools) {
    if (tool.readOnly) { assert.equal(tool.destructive, false, tool.name); assert.equal(tool.idempotent, true, tool.name); }
    assert.doesNotMatch(tool.description, /\bR-ops\b|\bRent Ops\b|Rent Operations/, tool.name);
  }
  // Every tool the capabilities guide recommends must exist on the full surface.
  for (const entry of OPS_WORKFLOW_GUIDE) for (const name of entry.tools) assert.ok(names.includes(name), `${entry.intent}: ${name}`);
  const committed = readFileSync(new URL("../../../docs/company/mcp-inventory.md", import.meta.url), "utf8");
  assert.equal(committed, renderMcpInventory(inventory), "Regenerate with: npx tsx scripts/company/mcp-inventory.ts --write");
});
