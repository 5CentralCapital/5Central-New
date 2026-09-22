import test from "node:test";
import assert from "node:assert/strict";
import { dashboardKpis, formatPeriod, formatWholeDollars } from "./dashboard-kpis";

const grove = { propertyId: "p1", unitCount: 3, occupied: 2, vacant: 1, preleased: 0, unknown: 0, rent: 265000, rentUnknown: 0 };
const cedar = { propertyId: "p2", unitCount: 4, occupied: 1, vacant: 3, preleased: 1, unknown: 0, rent: 120000, rentUnknown: 0 };

test("summarizes known occupancy, rent, receipts and balances", () => {
  const [occupancy, rent, receipts, due] = dashboardKpis({
    propertyRows: [grove, cedar],
    receipts: [{ amountCents: 121500 }, { amountCents: 125000 }],
    dueRows: [{ operationalBalanceCents: 50000 }, { operationalBalanceCents: 2500 }],
    period: "2026-08",
  });
  assert.equal(occupancy.value, "43%");
  assert.equal(occupancy.detail, "3 of 7 units · 4 vacant · 1 preleased");
  assert.equal(occupancy.share, 3 / 7);
  assert.equal(rent.value, "$3,850");
  assert.equal(receipts.value, "$2,465");
  assert.equal(receipts.detail, "2 posted receipts · Aug 2026");
  assert.ok(receipts.share! > .64 && receipts.share! < .65);
  assert.equal(due.value, "$525");
  assert.equal(due.tone, "attention");
});

test("unknown inputs are never shown as zero", () => {
  const [occupancy, rent, receipts, due] = dashboardKpis({
    propertyRows: [{ ...grove, unknown: 1 }, { ...cedar, rentUnknown: 1 }],
    receipts: [{ amountCents: null }],
    dueRows: [{ operationalBalanceCents: undefined }],
    period: "2026-08",
  });
  assert.equal(occupancy.tone, "review");
  assert.equal(rent.value, "Needs review");
  assert.equal(receipts.value, "Needs review");
  assert.equal(due.value, "Needs review");
  assert.equal(due.detail, "1 account needs review");
});

test("missing collections read as review, empty delinquency as clear", () => {
  const kpis = dashboardKpis({ period: "2026-08", dueRows: [] });
  assert.equal(kpis[0].value, "Needs review");
  assert.equal(kpis[2].value, "Needs review");
  assert.equal(kpis[3].value, "$0");
  assert.equal(kpis[3].detail, "No open balances");
  assert.equal(kpis[3].tone, "normal");
});

test("whole-dollar formatting rounds and signs", () => {
  assert.equal(formatWholeDollars(123456789), "$1,234,568");
  assert.equal(formatWholeDollars(-5050), "−$51");
});

test("periods read as month names", () => {
  assert.equal(formatPeriod("2026-08"), "Aug 2026");
  assert.equal(formatPeriod("2026-13"), "2026-13");
});
