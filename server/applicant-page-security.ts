import type { RequestHandler } from "express";

export function isPrivatePortalPath(url: string): boolean {
  return /^\/(?:apply|tenant)(?:\/|\?|$)/.test(url);
}

/** Token-bearing pages must not request third-party assets before React loads. */
export function privatePortalHtml(html: string, url: string): string {
  if (!isPrivatePortalPath(url)) return html;
  const title = /^\/tenant(?:\/|\?|$)/.test(url) ? "5Central Capital — Tenant account" : "5Central Capital — Rental application";
  return html
    .replace(/<link\b[^>]*\bhref=["'](?:https?:)?\/\/[^"']*["'][^>]*>/gi, "")
    .replace(/<title>[^<]*<\/title>/i, `<title>${title}</title>`)
    .replace(/<meta\b[^>]*\bname=["']description["'][^>]*>/gi, "");
}

/** Protects token-bearing applicant SPA URLs before any HTML is served. */
export const applicantPageSecurityHeaders: RequestHandler = (_req, res, next) => {
  // The applicant bundle is self-contained. Keep the policy deliberately
  // narrow because a resume credential can be present in the URL fragment
  // before the SPA consumes and removes it.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'none'; worker-src 'none';",
  );
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  next();
};
