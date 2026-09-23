import express, { type Express, type RequestHandler } from "express";

/**
 * MCP uploads carry file bytes as base64 inside JSON-RPC (stage_mra_packet and
 * upload_company_document accept about 10 MB, which is about 13.4 MB encoded).
 * The global JSON parser keeps Express's small default for every other route.
 */
export const MCP_JSON_BODY_LIMIT = "16mb";

/**
 * The /mcp JSON parser. The MCP route mounts it after bearer-token
 * verification so an anonymous client cannot make the server buffer and parse
 * a 16 MB body.
 */
export const mcpJsonBodyParser: RequestHandler = express.json({ limit: MCP_JSON_BODY_LIMIT });

/**
 * Register the global JSON and form parsers. /mcp is skipped here and parsed
 * by its own route. Raw-body webhook routes must be registered before this.
 */
export function registerRequestBodyParsers(app: Express): void {
  const json = express.json();
  app.use((req, res, next) => { if (/^\/mcp\/?$/i.test(req.path)) next(); else json(req, res, next); });
  app.use(express.urlencoded({ extended: false }));
}
