import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { collectMcpInventory, renderMcpInventory } from "../../../scripts/company/mcp-inventory";

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
  const committed = readFileSync(new URL("../../../docs/company/mcp-inventory.md", import.meta.url), "utf8");
  assert.equal(committed, renderMcpInventory(inventory), "Regenerate with: npx tsx scripts/company/mcp-inventory.ts --write");
});
