import test from "node:test";
import assert from "node:assert/strict";
import { addIsoDays, compareCentsText, daysBetween, formatCentsText, formatMeasure, formatMonth, opensInline } from "./format";

test("exact cents render without floating point and unknown never becomes zero", () => {
  assert.equal(formatCentsText("0"), "$0.00");
  assert.equal(formatCentsText("5"), "$0.05");
  assert.equal(formatCentsText("123456"), "$1,234.56");
  assert.equal(formatCentsText("-9007199254740993"), "−$90,071,992,547,409.93");
  assert.equal(formatCentsText("9223372036854775807"), "$92,233,720,368,547,758.07");
  assert.equal(formatCentsText(null), "Unknown");
  assert.equal(formatCentsText("12.5"), "Unknown");
  assert.equal(formatMeasure("100", false), "At least $1.00");
  assert.equal(formatMeasure(null, true), "Unknown");
});

test("cents comparison is exact beyond the safe-integer range", () => {
  assert.equal(compareCentsText("9007199254740993", "9007199254740992"), 1);
  assert.equal(compareCentsText(null, "0"), -1);
  assert.equal(compareCentsText("-1", "-1"), 0);
});

test("calendar helpers stay on UTC calendar dates", () => {
  assert.equal(daysBetween("2026-02-27", "2026-03-01"), 2);
  assert.equal(addIsoDays("2026-12-31", 1), "2027-01-01");
  assert.equal(formatMonth("2026-08"), "August 2026");
});

test("sums of exact cents flag unknown contributors instead of treating them as zero", async () => {
  const { sumCentsTexts } = await import("./format");
  assert.deepEqual(sumCentsTexts(["9007199254740993", "1"]), { total: "9007199254740994", complete: true });
  assert.deepEqual(sumCentsTexts(["100", null]), { total: "100", complete: false });
  assert.deepEqual(sumCentsTexts([null]), { total: null, complete: false });
  assert.deepEqual(sumCentsTexts([]), { total: "0", complete: true });
  // Section totals render through formatMeasure: all-unknown is "Unknown", never "At least Unknown".
  assert.equal(formatMeasure(sumCentsTexts([null, null]).total, false), "Unknown");
  assert.equal(formatMeasure(sumCentsTexts(["2500", null]).total, false), "At least $25.00");
});

test("only PDFs and raster images open in a tab; other document types download", () => {
  assert.equal(opensInline("application/pdf"), true);
  assert.equal(opensInline("image/jpeg"), true);
  assert.equal(opensInline("Application/PDF; charset=binary"), true);
  assert.equal(opensInline("text/html"), false);
  assert.equal(opensInline("image/svg+xml"), false);
  assert.equal(opensInline("application/xhtml+xml"), false);
  assert.equal(opensInline(""), false);
});
