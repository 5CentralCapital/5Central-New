import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RecurringBillingPanel } from "./recurring-billing-panel";

test("billing starts at the loaded server business month instead of the browser month", () => {
  const html = renderToStaticMarkup(createElement(RecurringBillingPanel, { businessDate: "2026-10-01" }));
  assert.match(html, /type="month"[^>]*value="2026-10"/);
});
test("billing has no invented month before server context is available", () => {
  const html = renderToStaticMarkup(createElement(RecurringBillingPanel));
  assert.match(html, /type="month"[^>]*value=""/);
  assert.match(html, /disabled=""[^>]*>Preview charges/);
});
