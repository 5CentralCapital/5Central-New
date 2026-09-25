import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getReportingDefinitions } from "../../shared/reporting";
import { createQuickBooksReportingEngine } from "./quickbooks-engine";
import { createRentalReportingEngine } from "./rental-engine";
import { createReportingDomainEngines } from "./domain-engines";
import { REPORTING_CONTRACT_PATH, renderReportingInventory, reportRuntimeCondition, withInventory } from "./inventory";

test("every report definition names the engine that is registered for it", () => {
  const rental = createRentalReportingEngine({ async report() { return []; } });
  const qbo = createQuickBooksReportingEngine({ ready: false, resolveConnectionScope: () => { throw new Error("unused"); }, createClient: () => { throw new Error("unused"); } });
  const engines = [rental, qbo, ...createReportingDomainEngines({})];
  const definitions = getReportingDefinitions();
  assert.equal(definitions.length, 53);
  assert.equal(new Set(definitions.map(definition => definition.id)).size, 53);
  for (const definition of definitions) {
    const registered = engines.filter(engine => engine.reportIds.includes(definition.id));
    assert.equal(registered.length, 1, `${definition.id} has exactly one engine`);
    assert.equal(registered[0]!.key, definition.engineKey, definition.id);
    assert.notEqual(reportRuntimeCondition(definition), "Not implemented", definition.id);
  }
});

test("the reporting contract carries the generated 53-row inventory", () => {
  const table = renderReportingInventory();
  assert.equal(table.split("\n").length, 55);
  const document = readFileSync(REPORTING_CONTRACT_PATH, "utf8");
  assert.equal(withInventory(document, table), document, "Run `npx tsx server/reporting/inventory.ts --write` to refresh docs/company/reporting-contract.md");
});
