import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ACCOUNT_ENTRY_ROUTES, AccountEntryChoices, ManagerDashboardLink, legacyAccountDestination } from "./account-entry";

test("public account chooser gives direct manager and resident entry without website login", () => {
  const html = renderToStaticMarkup(createElement(AccountEntryChoices, { onInvestor: () => {}, onNavigate: () => {} }));
  assert.match(html, /href="\/ops"[^>]*>Manager/);
  assert.match(html, /href="\/tenant"[^>]*>Resident/);
  assert.match(html, /<button[^>]*>Investor/);
  assert.doesNotMatch(html, /type="password"/);
  assert.equal(ACCOUNT_ENTRY_ROUTES.manager, "/ops");
  assert.equal(ACCOUNT_ENTRY_ROUTES.resident, "/tenant");
});

test("manager dashboard navigation depends on manager session independently of website login", () => {
  assert.equal(renderToStaticMarkup(createElement(ManagerDashboardLink, { authenticated: false })), "");
  assert.match(renderToStaticMarkup(createElement(ManagerDashboardLink, { authenticated: true })), /href="\/ops".*Manager Dashboard/);
});

test("legacy investor and website-admin login retain their destinations", () => {
  assert.equal(legacyAccountDestination("admin"), "/admin");
  assert.equal(legacyAccountDestination("investor"), "/investor-dashboard");
});
