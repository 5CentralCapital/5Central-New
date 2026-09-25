import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import {
  applyPublicPageMetadata,
  publicPageHttpStatus,
  publicPageMetadataForPath,
  publicRobotsTxt,
  publicSitemapXml,
  registerPublicPageMetadata,
} from "./public-page-metadata";

test("public metadata resolves known pages and rejects unknown property stories", () => {
  assert.equal(publicPageMetadataForPath("/" )?.canonicalPath, "/");
  assert.equal(publicPageMetadataForPath("/founder")?.ogType, "profile");
  assert.equal(publicPageMetadataForPath("/portfolio/sun-cove-apartments")?.canonicalPath, "/portfolio/sun-cove-apartments");
  assert.equal(publicPageMetadataForPath("/portfolio/sun-cove-apartments/")?.canonicalPath, "/portfolio/sun-cove-apartments");
  assert.equal(publicPageMetadataForPath("/portfolio/not-a-public-story"), null);

  assert.equal(publicPageHttpStatus("/portfolio"), 200);
  assert.equal(publicPageHttpStatus("/portfolio/not-a-public-story"), 404);
  assert.equal(publicPageHttpStatus("/ops/tenants"), null);
  assert.equal(publicPageHttpStatus("/api/unknown"), null);
  assert.equal(publicPageHttpStatus("/not-a-public-route"), 404);
});

test("metadata replaces generic shell tags and emits canonical social URLs", () => {
  const shell = [
    "<!doctype html><html><head>",
    "<title>Generic title</title>",
    '<meta name="description" content="Generic description">',
    '<meta property="og:title" content="Generic title">',
    '<meta property="og:description" content="Generic description">',
    '<meta property="og:url" content="https://old.example.test/">',
    '<meta property="og:type" content="website">',
    '<meta property="og:image" content="/old.jpg">',
    '<link rel="canonical" href="https://old.example.test/">',
    "</head><body></body></html>",
  ].join("");

  const result = applyPublicPageMetadata(shell, "/investor", { siteOrigin: "https://public.example.test/" });
  assert.match(result, /<title>Investor Opportunities \| 5Central Capital<\/title>/);
  assert.match(result, /<meta name="description" content="Join the 5Central Capital investor list/);
  assert.match(result, /<meta property="og:url" content="https:\/\/public\.example\.test\/investor">/);
  assert.match(result, /<meta property="og:image" content="https:\/\/public\.example\.test\/logo\.jpg">/);
  assert.match(result, /<link rel="canonical" href="https:\/\/public\.example\.test\/investor">/);
  assert.doesNotMatch(result, /Generic title|old\.example\.test|old\.jpg/);
});

test("metadata endpoints and the public route guard return safe synthetic responses", async () => {
  const app = express();
  registerPublicPageMetadata(app, { siteOrigin: "https://public.example.test", faviconPath: "/logo.jpg" });
  app.use((request, response) => {
    if (request.path.startsWith("/api/")) {
      response.status(404).send("api route missing");
      return;
    }
    response.status(200).send("shell");
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const robots = await fetch(`${origin}/robots.txt`);
    assert.equal(robots.status, 200);
    assert.match(await robots.text(), /Sitemap: https:\/\/public\.example\.test\/sitemap\.xml/);

    const sitemap = await fetch(`${origin}/sitemap.xml`);
    assert.equal(sitemap.status, 200);
    assert.match(await sitemap.text(), /https:\/\/public\.example\.test\/portfolio\/sun-cove-apartments/);

    const favicon = await fetch(`${origin}/favicon.ico`, { redirect: "manual" });
    assert.equal(favicon.status, 302);
    assert.equal(favicon.headers.get("location"), "/logo.jpg");

    assert.equal((await fetch(`${origin}/portfolio`)).status, 200);
    assert.equal((await fetch(`${origin}/portfolio/not-a-public-story`)).status, 404);
    assert.equal((await fetch(`${origin}/not-a-public-route`)).status, 404);
    assert.equal((await fetch(`${origin}/api/not-a-route`)).status, 404);
    assert.equal((await fetch(`${origin}/ops/not-a-route`)).status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
});

test("robots and sitemap use the configured origin without adding private routes", () => {
  const robots = publicRobotsTxt("https://preview.example.test/");
  assert.match(robots, /Allow: \/\n/);
  assert.match(robots, /Disallow: \/investor-dashboard/);
  assert.match(robots, /Sitemap: https:\/\/preview\.example\.test\/sitemap\.xml/);

  const sitemap = publicSitemapXml("https://preview.example.test/");
  assert.match(sitemap, /<loc>https:\/\/preview\.example\.test\/portfolio<\/loc>/);
  assert.doesNotMatch(sitemap, /investor-dashboard|\/admin|\/api\//);
});
