import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PaymentReviewPanel } from "./payment-review-panel";

test("manager income view exposes the payment exception queue", () => {
  const html = renderToStaticMarkup(createElement(PaymentReviewPanel, { tenants: [] }));
  assert.match(html, /Payment exceptions/);
  assert.match(html, /Disputed or provider-held tenant payments/);
  assert.match(html, /Refresh queue/);
});
