const PUBLIC_APPLICATION_TOKEN_PATH =
  /(\/api\/rent-ops\/public\/applications\/)([^/?#]+)/;
const PUBLIC_APPLICATION_TOKEN_QUERY = /([?&](?:resume|token)=)[^&#]*/gi;

/**
 * Removes bearer-like resume tokens before request metadata reaches logs.
 * Express' `req.path` excludes the query string, but the helper is deliberately
 * safe for full paths as well so it can be reused by other loggers.
 */
export function sanitizeApiPathForLogging(path: string): string {
  return path
    .replace(PUBLIC_APPLICATION_TOKEN_PATH, "$1:token")
    .replace(PUBLIC_APPLICATION_TOKEN_QUERY, "$1:redacted");
}
