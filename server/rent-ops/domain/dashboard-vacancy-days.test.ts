import test from "node:test";
import assert from "node:assert/strict";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { deriveOccupancy } from "./reports";

test("vacancy days advance daily from confirmed actual move-out for empty and preleased units", () => {
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  const unit = snapshot.units[0];
  const template = snapshot.tenancies.find(row => row.unitId === unit.id)!;
  snapshot.tenancies = [{ ...template, status: "past", actualMoveInOn: "2026-01-01", actualMoveOutOn: "2026-09-01", actualMoveOutKnowledge: "manual" }];
  const row = (date: string) => deriveOccupancy(snapshot, { asOfDate: date }).find(row => row.unitId === unit.id)!;
  assert.equal(row("2026-09-12").daysVacant, 11);
  assert.equal(row("2026-09-13").daysVacant, 12);
  snapshot.tenancies.push({ ...template, id: "next", status: "future", actualMoveInOn: undefined, plannedMoveInOn: "2026-10-01" });
  snapshot.leaseTerms.push({ ...snapshot.leaseTerms[0], id: "next-term", tenancyId: "next", contractStartOn: "2026-10-01", contractEndOn: "2027-09-30" });
  assert.equal(row("2026-09-13").occupancy, "future_preleased");
  assert.equal(row("2026-09-13").daysVacant, 12);
  snapshot.tenancies[0].actualMoveOutKnowledge = "unknown";
  assert.equal(row("2026-09-13").daysVacant, undefined);
});

test("completed departure resolves its own missing status without hiding unresolved occupancy", () => {
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  const unit = snapshot.units[0];
  const current = snapshot.tenancies.find(row => row.unitId === unit.id)!;
  const older = { ...current, id: "older-import", status: undefined, statusKnowledge: "unknown", actualMoveInOn: "2025-01-01", actualMoveOutOn: "2025-12-31", actualMoveOutKnowledge: "source" } as unknown as typeof current;
  snapshot.tenancies = [older, { ...current, status: "past", actualMoveInOn: "2026-02-13", actualMoveOutOn: "2026-09-12", actualMoveOutKnowledge: "manual" }];
  const row = (date: string) => deriveOccupancy(snapshot, { asOfDate: date }).find(row => row.unitId === unit.id)!;
  assert.equal(row("2026-09-12").occupancy, "vacant");
  assert.equal(row("2026-09-12").daysVacant, 0);
  assert.equal(row("2026-09-13").occupancy, "vacant");
  assert.equal(row("2026-09-13").daysVacant, 1);
  older.actualMoveOutKnowledge = "unknown";
  assert.equal(row("2026-09-13").occupancy, "unknown");
  older.actualMoveOutKnowledge = "source";
  older.actualMoveOutOn = "2026-09-14";
  assert.equal(row("2026-09-13").occupancy, "unknown");
});
