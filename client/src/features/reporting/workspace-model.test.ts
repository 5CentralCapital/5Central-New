import assert from "node:assert/strict";
import test from "node:test";
import { openPrintView, packageRunRowCount } from "./workspace-model";

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
