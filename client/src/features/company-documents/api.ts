import { companyDocumentPageSchema, companyDocumentSchema, type CompanyDocumentPage } from "@shared/company-documents";
import type { CompanyDocumentListFilter, CompanyDocumentMetadataUpdateInput, CompanyDocumentUploadInput, CompanyDocumentsApi } from "./types";
import { rentOpsAuthClient } from "../rent-ops/auth";

type JsonRecord = Record<string, unknown>;

export class CompanyDocumentsApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); this.name = "CompanyDocumentsApiError"; }
}

function isRecord(value: unknown): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function basePath(organizationId: string): string { return `/api/company/${encodeURIComponent(organizationId)}/documents`; }

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
  return params.toString() ? `?${params}` : "";
}

function createApi(): CompanyDocumentsApi {
  return {
    async list(organizationId, filter = {}, signal) {
      const response = await rentOpsAuthClient.request(`${basePath(organizationId)}${query(filter)}`, { signal, headers: { Accept: "application/json" } });
      return companyDocumentPageSchema.parse(await parseResponse(response, "Company documents could not be loaded."));
    },
    async upload(organizationId, input: CompanyDocumentUploadInput, signal) {
      const form = new FormData();
      form.set("metadata", JSON.stringify({ context: { organizationId, ...input.context }, kind: input.kind, title: input.title, description: input.description ?? null, documentDate: input.documentDate ?? null, tags: input.tags, links: input.links.map(({ label: _label, ...link }) => link) }));
      form.set("file", input.file, input.file.name);
      const response = await rentOpsAuthClient.request(basePath(organizationId), { method: "POST", body: form, signal });
      return companyDocumentSchema.parse(await parseResponse(response, "The company document could not be uploaded."));
    },
    async updateMetadata(organizationId, input: CompanyDocumentMetadataUpdateInput, signal) {
      const response = await rentOpsAuthClient.request(`${basePath(organizationId)}/${encodeURIComponent(input.documentId)}`, { method: "PATCH", body: JSON.stringify({ ...input, links: input.links?.map(({ label: _label, ...link }) => link) }), headers: { "Content-Type": "application/json" }, signal });
      return companyDocumentSchema.parse(await parseResponse(response, "The company document could not be updated."));
    },
    async download(organizationId, documentId, signal) {
      const response = await rentOpsAuthClient.request(`${basePath(organizationId)}/${encodeURIComponent(documentId)}/download`, { signal, headers: { Accept: "application/octet-stream" } });
      if (!response.ok) await parseResponse(response, "The company document could not be downloaded.");
      return response.blob();
    },
  };
}

export const companyDocumentsApi: CompanyDocumentsApi = createApi();
export function createCompanyDocumentsApi(): CompanyDocumentsApi { return createApi(); }
