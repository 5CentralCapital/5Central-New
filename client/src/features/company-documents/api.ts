import { operationIdSchema, operationReceiptSchema, type OperationReceipt } from "@shared/company";
import { companyDocumentPageSchema, companyDocumentSchema, type CompanyDocument } from "@shared/company-documents";
import type { CompanyDocumentListFilter, CompanyDocumentMetadataUpdateInput, CompanyDocumentUploadInput, CompanyDocumentsApi } from "./types";
import { rentOpsAuthClient } from "../rent-ops/auth";

type JsonRecord = Record<string, unknown>;

export class CompanyDocumentsApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); this.name = "CompanyDocumentsApiError"; }
  get conflict(): boolean { return this.status === 409; }
}

function isRecord(value: unknown): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function basePath(organizationId: string): string { return `/api/company/${encodeURIComponent(organizationId)}`; }

async function parseResponse(response: Response, fallback: string): Promise<unknown> {
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const root = isRecord(payload) ? payload : {};
    const data = isRecord(root.data) ? root.data : root;
    throw new CompanyDocumentsApiError(typeof data.message === "string" ? data.message : fallback, response.status, typeof data.code === "string" ? data.code : undefined);
  }
  return payload;
}

function query(filter: CompanyDocumentListFilter): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (typeof value === "string" && value) params.set(key, value);
  if (params.has("propertyId") && !params.has("legalEntityId")) params.delete("propertyId");
  return params.toString() ? `?${params}` : "";
}

/** base64url of UTF-8 JSON, for the metadata header that travels with raw file bytes. */
function metadataHeader(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of Array.from(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A document's own entity/property, so entity- or property-scoped users address it within their grant. */
export function documentScope(document: Pick<CompanyDocument, "context"> | undefined): { legalEntityId?: string; propertyId?: string } {
  const context = document?.context;
  if (!context?.legalEntityId) return {};
  return { legalEntityId: context.legalEntityId, ...(context.propertyId ? { propertyId: context.propertyId } : {}) };
}

function scopeQuery(scope: { legalEntityId?: string; propertyId?: string } | undefined): string {
  const params = new URLSearchParams();
  if (scope?.legalEntityId) {
    params.set("legalEntityId", scope.legalEntityId);
    if (scope.propertyId) params.set("propertyId", scope.propertyId);
  }
  return params.toString() ? `?${params}` : "";
}

function envelope(organizationId: string, payload: Record<string, unknown>, scope: { legalEntityId?: string; propertyId?: string } = {}) {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (!randomUUID) throw new CompanyDocumentsApiError("Secure action IDs are unavailable in this browser.", 0, "company_document_security_unavailable");
  const operationId = operationIdSchema.parse(randomUUID.call(globalThis.crypto));
  return {
    operationId, idempotencyKey: `company-document:${operationId}`,
    scope: { organizationId, ...(scope.legalEntityId ? { legalEntityId: scope.legalEntityId, ...(scope.propertyId ? { propertyId: scope.propertyId } : {}) } : {}) },
    payload,
  };
}

async function command(organizationId: string, kind: string, body: unknown, signal?: AbortSignal): Promise<OperationReceipt> {
  const response = await rentOpsAuthClient.request(`${basePath(organizationId)}/document-commands/${encodeURIComponent(kind)}`, {
    method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", Accept: "application/json" }, signal,
  });
  return operationReceiptSchema.parse(await parseResponse(response, "The company document could not be saved."));
}

function createApi(): CompanyDocumentsApi {
  const api: CompanyDocumentsApi = {
    async list(organizationId, filter = {}, signal) {
      const response = await rentOpsAuthClient.request(`${basePath(organizationId)}/documents${query(filter)}`, { signal, headers: { Accept: "application/json" } });
      return companyDocumentPageSchema.parse(await parseResponse(response, "Company documents could not be loaded."));
    },
    async get(organizationId, documentId, signal, scope) {
      const response = await rentOpsAuthClient.request(`${basePath(organizationId)}/documents/${encodeURIComponent(documentId)}${scopeQuery(scope)}`, { signal, headers: { Accept: "application/json" } });
      return companyDocumentSchema.parse(await parseResponse(response, "The company document could not be loaded."));
    },
    /** Prepare (verify and stage the bytes), then commit the metadata through the command runner. */
    async upload(organizationId, input: CompanyDocumentUploadInput, signal) {
      const context = { organizationId, ...Object.fromEntries(Object.entries(input.context).filter(([, value]) => Boolean(value))) };
      const metadata = {
        context, kind: input.kind, title: input.title, description: input.description ?? null, documentDate: input.documentDate ?? null,
        tags: [...input.tags], links: input.links.map(link => ({ kind: link.kind, id: link.id, label: link.label, ...(link.versionId ? { versionId: link.versionId } : {}) })),
      };
      const staged = await rentOpsAuthClient.request(`${basePath(organizationId)}/documents/uploads`, {
        method: "POST", body: input.file, signal,
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Declared-Content-Type": input.file.type || "application/octet-stream",
          "X-File-Name": encodeURIComponent(input.file.name),
          "X-Document-Metadata": metadataHeader(metadata),
          Accept: "application/json",
        },
      });
      const stage = await parseResponse(staged, "The company document could not be uploaded.");
      if (!isRecord(stage) || typeof stage.stageId !== "string") throw new CompanyDocumentsApiError("The upload could not be confirmed. Try again.", 0);
      const document = companyDocumentSchema.parse(stage.document);
      await command(organizationId, "company_document.create", envelope(organizationId, { action: "create", stageId: stage.stageId, input: metadata }, input.context), signal);
      return document;
    },
    async updateMetadata(organizationId, input: CompanyDocumentMetadataUpdateInput, signal) {
      const patch = {
        documentId: input.documentId, expectedRevision: input.expectedRevision,
        ...(input.title !== undefined ? { title: input.title } : {}), ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.documentDate !== undefined ? { documentDate: input.documentDate } : {}), ...(input.tags !== undefined ? { tags: [...input.tags] } : {}),
        ...(input.links !== undefined ? { links: input.links.map(link => ({ kind: link.kind, id: link.id, label: link.label, ...(link.versionId ? { versionId: link.versionId } : {}) })) } : {}),
      };
      await command(organizationId, "company_document.update", envelope(organizationId, { action: "update", patch }, input.scope), signal);
      return api.get(organizationId, input.documentId, signal, input.scope);
    },
    async archive(organizationId, document, signal) {
      const body = { ...envelope(organizationId, { action: "archive", documentId: document.id }, documentScope(document)), expectedRevision: document.recordRevision };
      await command(organizationId, "company_document.archive", body, signal);
    },
    async download(organizationId, documentId, signal, scope) {
      const response = await rentOpsAuthClient.request(`${basePath(organizationId)}/documents/${encodeURIComponent(documentId)}/download${scopeQuery(scope)}`, { signal, headers: { Accept: "application/octet-stream" } });
      if (!response.ok) await parseResponse(response, "The company document could not be downloaded.");
      return response.blob();
    },
  };
  return api;
}

export const companyDocumentsApi: CompanyDocumentsApi = createApi();
export type { CompanyDocument };
