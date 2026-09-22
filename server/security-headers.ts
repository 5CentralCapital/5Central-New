import type { RequestHandler } from "express";

const forbiddenMethods = new Set(["TRACE", "TRACK"]);

/** Baseline response protections shared by public, manager, and API routes. */
export function securityHeaders(options: { readonly production: boolean }): RequestHandler {
  return (request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    if (options.production) response.setHeader("Strict-Transport-Security", "max-age=31536000");

    if (forbiddenMethods.has(request.method.toUpperCase())) {
      response.sendStatus(405);
      return;
    }
    next();
  };
}
