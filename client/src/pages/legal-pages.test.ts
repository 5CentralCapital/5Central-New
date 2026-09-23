import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import EndUserLicenseAgreement from "./legal/eula";
import PrivacyPolicy from "./legal/privacy";
import QuickBooksDisconnected from "./quickbooks-disconnected";

test("legal pages link to each other and the contact address", () => {
  for (const page of [EndUserLicenseAgreement, PrivacyPolicy]) {
    const html = renderToStaticMarkup(createElement(page));
    assert.match(html, /href="\/legal\/eula"/);
    assert.match(html, /href="\/legal\/privacy"/);
    assert.match(html, /href="mailto:michael@5central\.capital"/);
  }
});

test("the QuickBooks disconnected page reconnects in the manager accounting section under the current app name", () => {
  const html = renderToStaticMarkup(createElement(QuickBooksDisconnected));
  assert.match(html, /href="\/ops\?section=accounting"[^>]*>Reconnect QuickBooks/);
  assert.match(html, /subject=5Central%20Ops%20QuickBooks%20support/);
  assert.doesNotMatch(html, /Rent%20Ops/);
});
