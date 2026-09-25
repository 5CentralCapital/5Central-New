import assert from "node:assert/strict";
import test from "node:test";
import { PROJECT_SECTIONS, PROJECT_TABS, projectSectionFor } from "./types";

test("legacy project tab values open the merged sections", () => {
  assert.equal(projectSectionFor("scope"), "budget");
  assert.equal(projectSectionFor("costs"), "budget");
  assert.equal(projectSectionFor("execution"), "commitments");
  assert.equal(projectSectionFor("deal-costs"), "deal-costs");
  assert.equal(projectSectionFor(undefined), "overview");
  for (const [section] of PROJECT_SECTIONS) {
    assert.ok((PROJECT_TABS as readonly string[]).includes(section), `${section} is routable`);
    assert.equal(projectSectionFor(section), section);
  }
  assert.deepEqual(PROJECT_SECTIONS.map(([, label]) => label), ["Overview", "Schedule", "Budgets & costs", "Deal costs", "Commitments", "Draws"]);
});
