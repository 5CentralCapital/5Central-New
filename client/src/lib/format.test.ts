import assert from "node:assert/strict";
import test from "node:test";

// Tampa. Set before any Date is formatted so the old local-time behavior
// (the previous calendar day) would show up here.
process.env.TZ = "America/New_York";
const { formatCalendarDate, formatWholeUsd, localIsoDate } = await import("./format");

test("calendar dates keep their stored day west of UTC", () => {
  assert.equal(formatCalendarDate("2024-04-01"), "Apr 1, 2024");
  assert.equal(formatCalendarDate("2024-04-01T00:00:00.000Z", { month: "long", year: "numeric" }), "April 2024");
  assert.equal(formatCalendarDate(new Date("2025-01-01T00:00:00.000Z"), { month: "short", year: "numeric" }), "Jan 2025");
});

test("missing or invalid calendar dates use the fallback, not Invalid Date", () => {
  assert.equal(formatCalendarDate(null), "—");
  assert.equal(formatCalendarDate(""), "—");
  assert.equal(formatCalendarDate("not a date", undefined, "N/A"), "N/A");
});

test("date-input defaults use the local day, not the UTC day", () => {
  // 9:30 PM in Tampa on March 15 is already March 16 in UTC.
  const evening = new Date(2026, 2, 15, 21, 30);
  assert.equal(evening.toISOString().slice(0, 10), "2026-03-16");
  assert.equal(localIsoDate(evening), "2026-03-15");
});

test("unknown amounts are not shown as $0", () => {
  assert.equal(formatWholeUsd(null), "—");
  assert.equal(formatWholeUsd(undefined), "—");
  assert.equal(formatWholeUsd(""), "—");
  assert.equal(formatWholeUsd("abc"), "—");
  assert.equal(formatWholeUsd(0), "$0");
  assert.equal(formatWholeUsd("0.00"), "$0");
  assert.equal(formatWholeUsd("125000.00"), "$125,000");
  assert.equal(formatWholeUsd(-2500), "-$2,500");
});
