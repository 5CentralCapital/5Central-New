import assert from "node:assert/strict";
import test from "node:test";
import { occupancyFromRentRolls } from "./rm-occupancy";

const names = { "30": "MLK Apartments", "31": "Hickory Landing", "32": "Sun Cove Apartments" };
const roll = (totalUnits: number, occupiedUnits: number) => ({ summary: { totalUnits, occupiedUnits, vacantUnits: totalUnits - occupiedUnits, occupancyRate: occupiedUnits / totalUnits, totalMonthlyRent: occupiedUnits * 1000 } });

test("a failed rent roll does not shift the other properties' names", () => {
  const records = occupancyFromRentRolls(["30", "31", "32"], names, [null, roll(40, 38), roll(10, 7)]);
  assert.deepEqual(records.map((record) => [record.property, record.units, record.occupied]), [
    ["Hickory Landing", 40, 38],
    ["Sun Cove Apartments", 10, 7],
  ]);
});

test("occupancy is a rounded percentage with the existing status thresholds", () => {
  const [record] = occupancyFromRentRolls(["32"], names, [roll(12, 11)]);
  assert.equal(record.id, "rm-occ-32");
  assert.equal(record.occupancyRate, 91.7);
  assert.equal(record.status, "stable");
  assert.equal(occupancyFromRentRolls(["32"], names, [roll(10, 8)])[0].status, "watch");
  assert.equal(occupancyFromRentRolls(["99"], names, [roll(10, 7)])[0].property, "Property 99");
  assert.equal(occupancyFromRentRolls(["99"], names, [roll(10, 7)])[0].status, "critical");
});
