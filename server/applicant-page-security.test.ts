import assert from "node:assert/strict";
import test from "node:test";

import { applicantPageSecurityHeaders, isPrivatePortalPath, privatePortalHtml } from "./applicant-page-security";

test("tenant activation HTML omits third-party assets and marketing metadata", () => {
  const template = '<head><title>Marketing</title><meta name="description" content="Investment returns"><link rel="preconnect" href="https://fonts.googleapis.com"><link href="//fonts.gstatic.com/example" rel="stylesheet"><link href="/assets/app.css" rel="stylesheet"></head>';
  const tenantHtml = privatePortalHtml(template, "/tenant?payment=success");
  assert.ok(!tenantHtml.includes("fonts.google"));
  assert.ok(!tenantHtml.includes("fonts.gstatic"));
  assert.ok(!tenantHtml.includes("Investment returns"));
  assert.match(tenantHtml, /Tenant account/);
  assert.match(tenantHtml, /\/assets\/app.css/);
  assert.equal(privatePortalHtml(template, "/"), template);
  assert.equal(isPrivatePortalPath("/tenant-other"), false);
  assert.equal(isPrivatePortalPath("/apply/property"), true);
});

test("applicant HTML is non-cacheable and sends no referrer", () => {
  const headers = new Map<string, string>();
  let nextCalled = false;
  applicantPageSecurityHeaders({} as never, { setHeader: (name: string, value: string) => { headers.set(name, value); } } as never, () => { nextCalled = true; });
  assert.equal(headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(headers.get("Cache-Control"), "no-store");
  assert.match(headers.get("Content-Security-Policy") ?? "", /default-src 'self'/);
  assert.match(headers.get("Content-Security-Policy") ?? "", /frame-ancestors 'none'/);
  assert.match(headers.get("Content-Security-Policy") ?? "", /style-src 'self'/);
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(headers.get("X-Frame-Options"), "DENY");
  assert.equal(headers.get("Permissions-Policy"), "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  assert.equal(nextCalled, true);
});
