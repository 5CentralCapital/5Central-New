import express, { type Express, type RequestHandler } from "express";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import {
  COMPANY_DOCUMENT_COMMAND_KINDS,
  COMPANY_DOCUMENT_KINDS,
  companyDocumentCommandPayloadSchemas,
  companyDocumentCreateInputSchema,
} from "../../shared/company-documents";
import { commandEnvelopeSchema, companyScopeSchema, documentReferenceIdSchema, legalEntityIdSchema, organizationIdSchema, propertyReferenceIdSchema, recordReferenceIdSchema } from "../../shared/company";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import { companyHttpError, companyReadHandler, companyWebActor } from "../company/http";
import { ForbiddenCommandError, ValidationCommandError } from "../company/commands/errors";
import type { CompanyDocumentsPort } from "./port";

export const COMPANY_DOCUMENT_HTTP_MAX_BYTES = 50 * 1024 * 1024;

const listQuery = z.object({
  legalEntityId: legalEntityIdSchema.optional(),
  propertyId: propertyReferenceIdSchema.optional(),
  projectId: recordReferenceIdSchema.optional(),
  investorContractId: recordReferenceIdSchema.optional(),
  kind: z.enum(COMPANY_DOCUMENT_KINDS).optional(),
  cursor: z.string().trim().min(1).max(4_000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

const scopeQuery = z.object({
  legalEntityId: legalEntityIdSchema.optional(),
  propertyId: propertyReferenceIdSchema.optional(),
}).strict();

/** Types the browser may render inline-safe as a download; anything else is served as octet-stream. */
const SAFE_DOWNLOAD_TYPES = new Set([
  "application/pdf", "image/png", "image/jpeg", "image/gif", "text/csv", "text/plain",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

function decodeMetadata(value: string | undefined): unknown {
  if (!value || value.length > 64 * 1024) throw new ValidationCommandError("Document metadata is required", { reason: "company_document_metadata_required" });
  try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch {
    throw new ValidationCommandError("Document metadata is not valid", { reason: "company_document_metadata_invalid" });
  }
}

function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * Browser routes. Upload is prepare + commit: raw bytes are verified and staged
 * for the session actor, then the create command commits metadata through the
 * shared command runner. Downloads stream only after authorization.
 */
export function registerCompanyDocumentRoutes(app: Express, options: { executor: RentOpsQueryExecutor; requireAdmin: RequestHandler; documents: CompanyDocumentsPort }): void {
  const web = attestTransport("web");
  const { executor, requireAdmin, documents } = options;
  const principalFor = (actorId: string, organizationId: string, connection: RentOpsQueryExecutor = executor) =>
    loadAuthenticatedPrincipal(connection, { actorId, organizationId, role: "admin" });

  app.get("/api/company/:organizationId/documents", requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const query = listQuery.parse(req.query);
    const principal = await principalFor(companyWebActor(req), organizationId);
    res.json(await documents.list(principal, { organizationId, ...query }));
  }));
  app.get("/api/company/:organizationId/documents/:documentId", requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const documentId = documentReferenceIdSchema.parse(req.params.documentId);
    const scope = companyScopeSchema.parse({ organizationId, ...scopeQuery.parse(req.query) });
    const principal = await principalFor(companyWebActor(req), organizationId);
    res.json(await documents.get(principal, { scope, documentId }));
  }));
  app.get("/api/company/:organizationId/documents/:documentId/download", requireAdmin, (req, res) => {
    res.set("Cache-Control", "no-store");
    void (async () => {
      const organizationId = organizationIdSchema.parse(req.params.organizationId);
      const documentId = documentReferenceIdSchema.parse(req.params.documentId);
      const scope = companyScopeSchema.parse({ organizationId, ...scopeQuery.parse(req.query) });
      const principal = await principalFor(companyWebActor(req), organizationId);
      const opened = await documents.openDownload(principal, { scope, documentId });
      const type = opened.contentType.toLowerCase().split(";")[0]!.trim();
      res.status(200);
      res.set("Content-Type", SAFE_DOWNLOAD_TYPES.has(type) ? type : "application/octet-stream");
      res.set("Content-Length", String(opened.document.source.sizeBytes));
      res.set("Content-Disposition", contentDisposition(opened.fileName));
      res.set("X-Content-Type-Options", "nosniff");
      res.set("Content-Security-Policy", "default-src 'none'; sandbox");
      await pipeline(opened.stream, res);
    })().catch(error => {
      if (res.headersSent) { res.destroy(error instanceof Error ? error : undefined); return; }
      companyHttpError(error, res);
    });
  });
  // Step 1: verify and stage the bytes. Metadata travels in a header so the body stays the exact file bytes.
  app.post("/api/company/:organizationId/documents/uploads", requireAdmin,
    express.raw({ type: () => true, limit: COMPANY_DOCUMENT_HTTP_MAX_BYTES }),
    companyReadHandler(async (req, res) => {
      const organizationId = organizationIdSchema.parse(req.params.organizationId);
      const principal = await principalFor(companyWebActor(req), organizationId);
      const metadata = companyDocumentCreateInputSchema.parse(decodeMetadata(req.get("x-document-metadata")));
      if (metadata.context.organizationId !== organizationId) throw new ForbiddenCommandError("Document company does not match this request.");
      const rawName = req.get("x-file-name");
      let fileName = "";
      try { fileName = rawName ? decodeURIComponent(rawName) : ""; } catch { fileName = ""; }
      if (!Buffer.isBuffer(req.body) || req.body.byteLength === 0) throw new ValidationCommandError("A non-empty file is required", { reason: "file_invalid" });
      // Clients send the bytes as application/octet-stream (so no JSON body parser touches them) and declare the real type separately.
      const declaredContentType = (req.get("x-declared-content-type") ?? req.get("content-type") ?? "application/octet-stream").slice(0, 120);
      res.status(201).json(await documents.prepareUpload(principal, metadata, { bytes: new Uint8Array(req.body), fileName, declaredContentType }));
    }));
  // Step 2 (and every other change): the shared command runner.
  app.post("/api/company/:organizationId/document-commands/:commandKind", requireAdmin, express.json({ limit: "256kb" }), companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const kind = z.enum(COMPANY_DOCUMENT_COMMAND_KINDS).parse(req.params.commandKind);
    const envelope = commandEnvelopeSchema(companyDocumentCommandPayloadSchemas[kind]).parse(req.body);
    if (envelope.scope.organizationId !== organizationId) throw new ForbiddenCommandError("Document company does not match this request.");
    const actorId = companyWebActor(req);
    const resolvePrincipal = (transaction: RentOpsQueryExecutor) => principalFor(actorId, organizationId, transaction);
    const principal = await resolvePrincipal(executor);
    res.json(await documents.execute(kind, envelope, { principal, resolvePrincipal, transport: web }));
  }));
}
