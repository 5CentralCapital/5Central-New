import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PaymentReviewPanel, PaymentReviewView } from "./payment-review-panel";
import type { TenantPaymentReview } from "./types";

// Shared primitives use the classic JSX runtime under tsx.
(globalThis as { React?: typeof React }).React = React;

const noop = () => undefined;
const now = new Date(2026, 8, 24, 15, 0);

test("manager income view exposes the payment exception queue", () => {
  const html = renderToStaticMarkup(createElement(PaymentReviewPanel, { tenants: [] }));
  assert.match(html, /Checking payment exceptions/);
});

test("an empty queue is one status line with the time it was checked and a refresh control", () => {
  const html = renderToStaticMarkup(createElement(PaymentReviewView, { rows: [], tenants: [], loaded: true, busy: false, lastChecked: new Date(2026, 8, 24, 11, 29), onRefresh: noop, onReconcile: noop, now }));
  assert.match(html, /ops-status-line is-positive/);
  assert.match(html, /No payment exceptions · checked 11:29 AM/);
  assert.match(html, /aria-label="Refresh payment exceptions"/);
  assert.doesNotMatch(html, /Staff queue|Refresh queue|ro-panel/i);
});

test("an empty queue without a fetch time omits the time", () => {
  const html = renderToStaticMarkup(createElement(PaymentReviewView, { rows: [], tenants: [], loaded: true, busy: false, onRefresh: noop, onReconcile: noop, now }));
  assert.match(html, /No payment exceptions<\/span>/);
  assert.doesNotMatch(html, /checked/);
});

test("queued exceptions keep the panel without the uppercase eyebrow and format created times", () => {
  const row = { id: "pay_1", personId: "p1", propertyId: "prop1", unitId: "u1", tenancyId: "t1", status: "review_required", queueReason: "stale_active", amountCents: 125000, currentLedgerCents: 125000, adjustments: [], createdAt: new Date(2026, 8, 23, 9, 5, 42).toISOString() } as unknown as TenantPaymentReview;
  const html = renderToStaticMarkup(createElement(PaymentReviewView, { rows: [row], tenants: [], loaded: true, busy: false, onRefresh: noop, onReconcile: noop, now }));
  assert.match(html, /Payment exceptions/);
  assert.match(html, /Disputed, provider-held, or stale tenant payments/);
  assert.match(html, /Refresh queue/);
  assert.match(html, /\$1,250\.00/);
  assert.match(html, /Sep 23, 2026, 9:05 AM/);
  assert.match(html, /Reconcile provider/);
  assert.doesNotMatch(html, /Staff queue|eyebrow/i);
});
