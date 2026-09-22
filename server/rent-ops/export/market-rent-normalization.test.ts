import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRentManagerExport } from "./normalizer";
import type { ExportPayload } from "./types";

function normalize(rent: unknown, scalar?: number) {
  return normalizeRentManagerExport({properties:[{PropertyID:"p",PropertyName:"Synthetic"}], units:[{UnitID:"u",PropertyID:"p",Name:"1",UnitType:{Name:"One"},MarketRent:rent,marketRent: scalar ?? rent}]} as ExportPayload,{asOfDate:"2026-09-07",artifactSha256:"a".repeat(64),artifactObservationOn:"2026-09-07"});
}

test("exact single undated RM market amount remains the source amount", () => {
  const result = normalize([{MarketRentID:1,Amount:1750}]);
  assert.equal(result.input.units?.[0].marketRent,1750);
  assert.ok(!result.exceptions.some(e => e.detail?.startsWith("market_rent_")));
});

test("empty or amountless market rent embeds remain unknown and explicit exceptions", () => {
  for (const rows of [[],[{MarketRentID:90,FromDate:"2022-10-10"}],{}]) {
    const result = normalize(rows);
    assert.equal(result.input.units?.[0].marketRent,undefined);
    assert.equal(result.input.units?.[0].marketRentCents,undefined);
    assert.ok(result.exceptions.some(e => e.detail === "market_rent_not_returned"));
  }
});

test("empty embeds preserve independent scalar zero while future or conflicting values stay unknown", () => {
  assert.equal(normalize([],0).input.units?.[0].marketRent,0);
  assert.equal(normalize([{Amount:1900,FromDate:"2027-01-01"}]).input.units?.[0].marketRent,undefined);
  const conflict = normalize([{Amount:1750},{Amount:1900}]);
  assert.equal(conflict.input.units?.[0].marketRent,undefined);
  assert.ok(conflict.exceptions.some(e => e.detail === "market_rent_effective_interval_ambiguous"));
});
