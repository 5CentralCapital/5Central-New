import type { Express, RequestHandler } from "express";
import { publicPageHttpStatus, publicRobotsTxt, publicSitemapXml, normalizeSiteOrigin, normalizeFaviconPath, type PublicPageMetadataOptions } from "../shared/public-page-metadata";
export * from "../shared/public-page-metadata";

function notFoundDocument(): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="UTF-8">',
    "<meta name=\"robots\" content=\"noindex\">",
    "<title>Page not found | 5Central Capital</title>",
    "</head><body><h1>Page not found</h1></body></html>",
  ].join("");
}

export function publicPageMetadataMiddleware(): RequestHandler {
  return (req, res, next) => {
    if (publicPageHttpStatus(req.path) === 404) {
      res.status(404).type("html").send(notFoundDocument());
      return;
    }
    next();
  };
}

/**
 * Register the public metadata endpoints and the public-route 404 guard.
 * Call this after API/auth routes and before the Vite or static SPA fallback.
 */
export function registerPublicPageMetadata(
  app: Express,
  options: PublicPageMetadataOptions = {},
): void {
  const siteOrigin = normalizeSiteOrigin(options.siteOrigin);
  const faviconPath = normalizeFaviconPath(options.faviconPath);

  app.get("/favicon.ico", (_req, res) => {
    res.redirect(302, faviconPath);
  });
  app.get("/robots.txt", (_req, res) => {
    res.type("text/plain").set("Cache-Control", "public, max-age=3600").send(publicRobotsTxt(siteOrigin));
  });
  app.get("/sitemap.xml", (_req, res) => {
    res.type("application/xml").set("Cache-Control", "public, max-age=3600").send(publicSitemapXml(siteOrigin));
  });
  app.use(publicPageMetadataMiddleware());
}
