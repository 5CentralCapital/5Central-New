import assert from "node:assert/strict";
import test from "node:test";
import { isPublicApplicationInventory } from "./public";

test("explicit manual inventory remains public while unknown facts and manual occupancy stay closed", () => {
  const property = { id: "p", name: "Synthetic homes", slug: "synthetic", state: "active", nameKnowledge: "manual", addressKnowledge: "manual", stateKnowledge: "manual", address: { line1: "1 Example Street", city: "Example", state: "FL", postalCode: "00000" } };
  const unit = { id: "u", propertyId: "p", unitNumber: "1", readiness: "ready", listing: "listed", propertyLinkKnowledge: "manual", unitNumberKnowledge: "manual", readinessKnowledge: "manual", listingKnowledge: "manual" };
  assert.equal(isPublicApplicationInventory(property, unit, [], "2026-09-07"), true);
  for (const field of ["propertyLinkKnowledge", "unitNumberKnowledge", "readinessKnowledge", "listingKnowledge"]) {
    assert.equal(isPublicApplicationInventory(property, { ...unit, [field]: "unknown" }, [], "2026-09-07"), false);
  }
  assert.equal(isPublicApplicationInventory({ ...property, stateKnowledge: "unknown" }, unit, [], "2026-09-07"), false);
  const occupied = { id: "t", propertyId: "p", unitId: "u", status: "current", propertyLinkKnowledge: "manual", unitLinkKnowledge: "manual", statusKnowledge: "manual", actualMoveInOn: "2026-09-01", actualMoveInKnowledge: "manual" };
  assert.equal(isPublicApplicationInventory(property, unit, [occupied], "2026-09-07"), false);
});
