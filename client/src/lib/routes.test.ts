import assert from "node:assert/strict";
import test from "node:test";
import { applyPropertySlug, appSurfaceForPath } from "./routes";

test("portal paths are classified the way the router matches them", () => {
  assert.equal(appSurfaceForPath("/ops"), "manager");
  assert.equal(appSurfaceForPath("/ops/"), "manager");
  assert.equal(appSurfaceForPath("/tenant"), "tenant");
  // wouter renders the tenant portal for "/tenant/"; the website navigation
  // and staff providers must not be wrapped around it.
  assert.equal(appSurfaceForPath("/tenant/"), "tenant");
  assert.equal(appSurfaceForPath("/Tenant"), "tenant");
  assert.equal(appSurfaceForPath("/apply"), "applicant");
  assert.equal(appSurfaceForPath("/apply/sun-cove"), "applicant");
  assert.equal(appSurfaceForPath("/apply/sun-cove/"), "applicant");
});

test("other paths, including unknown portal subpaths, are the public site with its navigation", () => {
  for (const path of ["/", "/portfolio", "/portfolio/sun-cove", "/legal/eula", "/ops/unknown", "/tenant/unknown", "/apply/a/b", "/operations", "/tenants"]) {
    assert.equal(appSurfaceForPath(path), "site", path);
  }
});

test("the apply property slug is decoded and a malformed escape cannot crash the page", () => {
  assert.equal(applyPropertySlug("/apply/sun-cove"), "sun-cove");
  assert.equal(applyPropertySlug("/apply/sun%20cove/"), "sun cove");
  assert.equal(applyPropertySlug("/apply"), "");
  assert.equal(applyPropertySlug("/apply/%E0%A4%A"), "");
});
