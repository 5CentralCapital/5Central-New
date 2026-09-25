import assert from "node:assert/strict";
import test from "node:test";
import { displayReportCell, displayReportPeriod, openPrintView, packageRunRowCount } from "./workspace-model";

test("print opens one tab without noopener and clears its opener", () => {
  const calls: unknown[][] = [];
  const view = { opener: {} as unknown };
  const opened = openPrintView((...args) => { calls.push(args); return view; }, "blob:report");
  assert.equal(opened, true, "a successful open must not fall back to a download");
  assert.deepEqual(calls, [["blob:report", "_blank"]], "noopener would make window.open return null even on success");
  assert.equal(view.opener, null);
});

test("print falls back to a download only when the tab is blocked", () => {
  assert.equal(openPrintView(() => null, "blob:report"), false);
});

test("package row totals keep missing legacy counts visible", () => {
  assert.deepEqual(packageRunRowCount([{ rowCount: 12 }, {}, { rowCount: 3 }]), { knownRows: 15, unknownCount: 1 });
});

test("screen periods and date cells use the shared date formats", () => {
  assert.equal(displayReportPeriod({ mode: "as_of", asOfDate: "2026-09-24" }), "As of Sep 24, 2026");
  assert.equal(displayReportPeriod({ mode: "range", fromDate: "2026-09-01", toDate: "2026-09-24" }), "Sep 1, 2026 to Sep 24, 2026");
  assert.equal(displayReportPeriod({ mode: "month", month: "2026-09" }), "Sep 2026");
  assert.equal(displayReportPeriod({ mode: "custom" }), "All dates");
  assert.equal(displayReportCell("2026-06-01", { id: "postedOn", type: "date" }, {}, 2026), "Jun 1");
  assert.equal(displayReportCell("2025-06-01", { id: "postedOn", type: "date" }, {}, 2026), "Jun 1, 2025");
  assert.equal(displayReportCell("2026-09", { id: "month", type: "month" }), "Sep 2026");
  assert.equal(displayReportCell("12345", { id: "amountCents", type: "money" }), "$123.45");
});
