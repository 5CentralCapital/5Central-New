import express, { type Express } from "express";

/**
 * MCP uploads carry file bytes as base64 inside JSON-RPC (stage_mra_packet and
 * upload_company_document accept about 10 MB, which is about 13.4 MB encoded).
 * The global JSON parser keeps Express's small default for every other route.
 */
export const MCP_JSON_BODY_LIMIT = "16mb";

/**
 * Register the JSON and form parsers. The /mcp parser runs first; the global
 * parser then skips a request whose body is already parsed, so only MCP gets
 * the larger limit. Raw-body webhook routes must be registered before this.
 */
export function registerRequestBodyParsers(app: Express): void {
  app.use("/mcp", express.json({ limit: MCP_JSON_BODY_LIMIT }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
}
