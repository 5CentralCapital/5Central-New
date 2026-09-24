import type { Express, RequestHandler } from "express";

const CANONICAL_SITE_ORIGIN = "https://5central.capital";
const DEFAULT_OG_IMAGE_PATH = "/logo.jpg";

export interface PublicPageMetadata {
  title: string;
  description: string;
  canonicalPath: string;
  ogType: "website" | "profile";
  ogImagePath: string;
}

export interface PublicPageMetadataOptions {
  siteOrigin?: string;
  faviconPath?: string;
}

/**
 * These are public portfolio story slugs, kept here so the server can reject
 * fabricated property URLs before the SPA fallback returns a 200 response.
 * The client remains the source for the story content itself.
 */
const PORTFOLIO_STORY_METADATA: Readonly<Record<string, Pick<PublicPageMetadata, "title" | "description">>> = {
  "sun-cove-apartments": {
    title: "Sun Cove Apartments | Portfolio | 5Central Capital",
    description:
      "Sun Cove Apartments in St. Petersburg, Florida: a current value-add multifamily project with lease-up and refinance work in motion.",
  },
  "lucia-apartments": {
    title: "Lucia Apartments | Portfolio | 5Central Capital",
    description:
      "Lucia Apartments in Florida: a current value-add multifamily project in the 5Central Capital portfolio.",
  },
  "hickory-landing": {
    title: "Hickory Landing | Portfolio | 5Central Capital",
    description:
      "Hickory Landing in Florida: a current value-add multifamily project in the 5Central Capital portfolio.",
  },
  "mlk-apartments": {
    title: "MLK Apartments | Portfolio | 5Central Capital",
    description:
      "MLK Apartments in Florida: a current value-add multifamily project in the 5Central Capital portfolio.",
  },
  "115th-st-flip": {
    title: "115th Street Flip | Portfolio | 5Central Capital",
    description:
      "115th Street: a 5Central Capital small-project story with current status and operating context.",
  },
  "1-harmony-st": {
    title: "1 Harmony St | Portfolio | 5Central Capital",
    description:
      "1 Harmony St: a realized 5Central Capital property story and exit record.",
  },
  "41-stuart-ave": {
    title: "41 Stuart Ave | Portfolio | 5Central Capital",
    description:
      "41 Stuart Ave: a realized 5Central Capital property story and exit record.",
  },
  "52-summit-ave": {
    title: "52 Summit Ave | Portfolio | 5Central Capital",
    description:
      "52 Summit Ave: a realized 5Central Capital property story and exit record.",
  },
  "29-brainard-st": {
    title: "29 Brainard St | Portfolio | 5Central Capital",
    description:
      "29 Brainard St: a realized 5Central Capital property story and exit record.",
  },
  "25-huntington-pl": {
    title: "25 Huntington Pl | Portfolio | 5Central Capital",
    description:
      "25 Huntington Pl: a realized 5Central Capital property story and exit record.",
  },
  "145-crystal-ave": {
    title: "145 Crystal Ave | Portfolio | 5Central Capital",
    description:
      "145 Crystal Ave: a realized 5Central Capital property story and exit record.",
  },
  "149-crystal-ave": {
    title: "149 Crystal Ave | Portfolio | 5Central Capital",
    description:
      "149 Crystal Ave: a realized 5Central Capital property story and exit record.",
  },
  "157-crystal-ave": {
    title: "157 Crystal Ave | Portfolio | 5Central Capital",
    description:
      "157 Crystal Ave: a realized 5Central Capital property story and exit record.",
  },
  "175-crystal-ave": {
    title: "175 Crystal Ave | Portfolio | 5Central Capital",
    description:
      "175 Crystal Ave: a realized 5Central Capital property story and exit record.",
  },
  "35-linden-st": {
    title: "35 Linden St | Portfolio | 5Central Capital",
    description:
      "35 Linden St: a realized 5Central Capital property story and exit record.",
  },
};

const FIXED_PUBLIC_PAGE_METADATA: Readonly<Record<string, PublicPageMetadata>> = {
  "/": {
    title: "5Central Capital | Value-Add Real Estate",
    description:
      "Founder-led value-add multifamily in Florida, with public portfolio reporting, operating discipline, and a clear growth plan.",
    canonicalPath: "/",
    ogType: "website",
    ogImagePath: DEFAULT_OG_IMAGE_PATH,
  },
  "/founder": {
    title: "Michael McElwee | Founder of 5Central Capital",
    description:
      "Meet Michael McElwee, founder and principal of 5Central Capital, and learn how the platform approaches value-add real estate operations.",
    canonicalPath: "/founder",
    ogType: "profile",
    ogImagePath: DEFAULT_OG_IMAGE_PATH,
  },
  "/vision": {
    title: "Our Vision | 5Central Capital",
    description:
      "The long-range 5Central Capital vision for disciplined real estate growth, operating systems, and community-focused housing.",
    canonicalPath: "/vision",
    ogType: "website",
    ogImagePath: DEFAULT_OG_IMAGE_PATH,
  },
  "/portfolio": {
    title: "Portfolio | 5Central Capital",
    description:
      "Explore current Florida multifamily holdings, operating signals, project pipeline, and realized exits from 5Central Capital.",
    canonicalPath: "/portfolio",
    ogType: "website",
    ogImagePath: DEFAULT_OG_IMAGE_PATH,
  },
  "/investor": {
    title: "Investor Opportunities | 5Central Capital",
    description:
      "Join the 5Central Capital investor list for updates on prospective deals, portfolio reporting, and investment materials.",
    canonicalPath: "/investor",
    ogType: "website",
    ogImagePath: DEFAULT_OG_IMAGE_PATH,
  },
  "/flips": {
    title: "Small Projects | 5Central Capital",
    description:
      "Review the current small-project pipeline, progress evidence, and modeled project economics.",
    canonicalPath: "/flips",
    ogType: "website",
    ogImagePath: DEFAULT_OG_IMAGE_PATH,
  },
  "/legal/eula": {
    title: "End User License Agreement | 5Central Capital",
    description: "Terms governing use of the 5Central Capital application.",
    canonicalPath: "/legal/eula",
    ogType: "website",
    ogImagePath: DEFAULT_OG_IMAGE_PATH,
  },
  "/legal/privacy": {
    title: "Privacy Policy | 5Central Capital",
    description: "Privacy information for the 5Central Capital application and public site.",
    canonicalPath: "/legal/privacy",
    ogType: "website",
    ogImagePath: DEFAULT_OG_IMAGE_PATH,
  },
  "/quickbooks/disconnected": {
    title: "QuickBooks Disconnected | 5Central Capital",
    description: "The QuickBooks connection for this session is no longer active.",
    canonicalPath: "/quickbooks/disconnected",
    ogType: "website",
    ogImagePath: DEFAULT_OG_IMAGE_PATH,
  },
};

const PRIVATE_OR_INFRASTRUCTURE_PREFIXES = [
  /^\/api(?:\/|$)/i,
  /^\/ops(?:\/|$)/i,
  /^\/tenant(?:\/|$)/i,
  /^\/apply(?:\/|$)/i,
  /^\/admin(?:\/|$)/i,
  /^\/data-room(?:\/|$)/i,
  /^\/investor-dashboard(?:\/|$)/i,
  /^\/mcp(?:\/|$)/i,
  /^\/\.well-known(?:\/|$)/i,
  /^\/healthz$/i,
  /^\/readyz$/i,
  /^\/attached_assets(?:\/|$)/i,
  /^\/assets(?:\/|$)/i,
  /^\/src(?:\/|$)/i,
  /^\/@(?:vite|fs|id)(?:\/|$)/i,
];

const INDEXABLE_PUBLIC_PATHS = [
  "/",
  "/founder",
  "/vision",
  "/portfolio",
  "/investor",
  "/flips",
  ...Object.keys(PORTFOLIO_STORY_METADATA).map((slug) => `/portfolio/${slug}`),
];

function normalizePathname(value: string): string | null {
  try {
    const parsed = new URL(value, "http://public-page.invalid");
    const pathname = decodeURIComponent(parsed.pathname);
    if (!pathname.startsWith("/")) return null;
    if (pathname === "/") return "/";
    return pathname.replace(/\/+$/, "") || "/";
  } catch {
    return null;
  }
}

function normalizeSiteOrigin(value: string = CANONICAL_SITE_ORIGIN): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("siteOrigin must use http or https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError("siteOrigin must not contain credentials, query parameters, or fragments");
  }
  return parsed.origin;
}

function normalizeFaviconPath(value: string = DEFAULT_OG_IMAGE_PATH): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\n") || value.includes("\r")) {
    throw new TypeError("faviconPath must be a local absolute path");
  }
  return value;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function publicPortfolioMetadata(pathname: string): PublicPageMetadata | null {
  const match = /^\/portfolio\/([^/]+)$/i.exec(pathname);
  if (!match) return null;

  const slug = match[1].toLowerCase();
  const story = PORTFOLIO_STORY_METADATA[slug];
  if (!story) return null;

  return {
    ...story,
    canonicalPath: `/portfolio/${slug}`,
    ogType: "website",
    ogImagePath: DEFAULT_OG_IMAGE_PATH,
  };
}

export function publicPageMetadataForPath(path: string): PublicPageMetadata | null {
  const pathname = normalizePathname(path);
  if (!pathname) return null;
  return FIXED_PUBLIC_PAGE_METADATA[pathname] ?? publicPortfolioMetadata(pathname);
}

/**
 * Returns null for routes owned by the API or authenticated application. The
 * caller can leave those routes to their existing handlers. A known public
 * route is 200; an unknown public-looking route is 404.
 */
export function publicPageHttpStatus(path: string): 200 | 404 | null {
  const pathname = normalizePathname(path);
  if (!pathname) return 404;
  if (publicPageMetadataForPath(pathname)) return 200;
  if (PRIVATE_OR_INFRASTRUCTURE_PREFIXES.some((prefix) => prefix.test(pathname))) return null;
  return 404;
}

function upsertTag(html: string, pattern: RegExp, tag: string): string {
  if (pattern.test(html)) return html.replace(pattern, tag);
  return html.replace(/<\/head>/i, `${tag}\n</head>`);
}

export function applyPublicPageMetadata(
  html: string,
  path: string,
  options: Pick<PublicPageMetadataOptions, "siteOrigin"> = {},
): string {
  const metadata = publicPageMetadataForPath(path);
  if (!metadata) return html;

  const siteOrigin = normalizeSiteOrigin(options.siteOrigin);
  const canonicalUrl = `${siteOrigin}${metadata.canonicalPath}`;
  const imageUrl = `${siteOrigin}${metadata.ogImagePath}`;
  const title = escapeHtml(metadata.title);
  const description = escapeHtml(metadata.description);
  const canonical = escapeHtml(canonicalUrl);
  const image = escapeHtml(imageUrl);

  let result = html;
  result = upsertTag(result, /<title\b[^>]*>[\s\S]*?<\/title>/i, `<title>${title}</title>`);
  result = upsertTag(
    result,
    /<meta\b(?=[^>]*\bname=["']description["'])[^>]*>/i,
    `<meta name="description" content="${description}">`,
  );
  result = upsertTag(
    result,
    /<meta\b(?=[^>]*\bproperty=["']og:title["'])[^>]*>/i,
    `<meta property="og:title" content="${title}">`,
  );
  result = upsertTag(
    result,
    /<meta\b(?=[^>]*\bproperty=["']og:description["'])[^>]*>/i,
    `<meta property="og:description" content="${description}">`,
  );
  result = upsertTag(
    result,
    /<meta\b(?=[^>]*\bproperty=["']og:url["'])[^>]*>/i,
    `<meta property="og:url" content="${canonical}">`,
  );
  result = upsertTag(
    result,
    /<meta\b(?=[^>]*\bproperty=["']og:type["'])[^>]*>/i,
    `<meta property="og:type" content="${metadata.ogType}">`,
  );
  result = upsertTag(
    result,
    /<meta\b(?=[^>]*\bproperty=["']og:image["'])[^>]*>/i,
    `<meta property="og:image" content="${image}">`,
  );
  return upsertTag(
    result,
    /<link\b(?=[^>]*\brel=["']canonical["'])[^>]*>/i,
    `<link rel="canonical" href="${canonical}">`,
  );
}

export function publicRobotsTxt(siteOrigin: string = CANONICAL_SITE_ORIGIN): string {
  const origin = normalizeSiteOrigin(siteOrigin);
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /admin",
    "Disallow: /data-room",
    "Disallow: /investor-dashboard",
    "Disallow: /ops",
    "Disallow: /tenant",
    "Disallow: /apply",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
}

export function publicSitemapXml(siteOrigin: string = CANONICAL_SITE_ORIGIN): string {
  const origin = normalizeSiteOrigin(siteOrigin);
  const urls = INDEXABLE_PUBLIC_PATHS.map(
    (pathname) => `  <url><loc>${escapeHtml(`${origin}${pathname}`)}</loc></url>`,
  ).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    "</urlset>",
    "",
  ].join("\n");
}

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

export const publicPortfolioStorySlugs = Object.freeze(Object.keys(PORTFOLIO_STORY_METADATA));
export const publicIndexablePaths = Object.freeze([...INDEXABLE_PUBLIC_PATHS]);
export { CANONICAL_SITE_ORIGIN };
