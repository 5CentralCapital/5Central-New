import assert from "node:assert/strict";
import test from "node:test";
import { openPrintView } from "./workspace-model";

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
