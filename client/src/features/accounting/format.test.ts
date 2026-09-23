import assert from "node:assert/strict";
import test from "node:test";
import { ageLabel, formatCents, monthPeriod, newOperationId, sumCents } from "./format";

test("cents format exactly, including values beyond double precision", () => {
  assert.equal(formatCents("100000"), "$1,000.00");
  assert.equal(formatCents("-5"), "−$0.05");
  assert.equal(formatCents("922337203685477580"), "$9,223,372,036,854,775.80");
  assert.equal(formatCents(null), "Unknown");
  assert.equal(formatCents("12.5"), "Unknown");
  assert.equal(formatCents("250", "EUR"), "€2.50");
  assert.equal(sumCents(["100000", "-10000"]), "90000");
  assert.equal(sumCents(["1", null]), null, "an unknown part makes the total unknown");
});

test("periods, ages and operation ids", () => {
  assert.deepEqual(monthPeriod(new Date("2026-09-23T00:00:00Z"), -1), { periodStart: "2026-08-01", periodEnd: "2026-08-31" });
  assert.deepEqual(monthPeriod(new Date("2026-03-15T00:00:00Z"), -1), { periodStart: "2026-02-01", periodEnd: "2026-02-28" });
  assert.equal(ageLabel(null), "Never");
  assert.equal(ageLabel(1800), "30 min ago");
  assert.equal(ageLabel(7200), "2 h ago");
  assert.match(newOperationId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
