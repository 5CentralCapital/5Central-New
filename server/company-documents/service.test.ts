import assert from "node:assert/strict";
import test from "node:test";
import { createCompanyDocumentPort, CompanyDocumentError } from "./service";
import { createInMemoryObjectStore } from "../rent-ops/storage";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";

const requestedOrganization = "10000000-0000-4000-8000-000000000001";
const otherOrganization = "10000000-0000-4000-8000-000000000002";
const checksum = "a".repeat(64);

function row(organizationId: string): Record<string, unknown> {
  return {
    id: "company-document:test-cross-company",
    organization_id: organizationId,
    legal_entity_id: null,
    property_id: null,
    project_id: null,
    investor_contract_id: null,
    investor_contract_version_id: null,
    kind: "contract",
    state: "verified",
    title: "Private agreement",
    description: null,
    document_date: null,
    tags: [],
    file_name: "agreement.pdf",
    declared_content_type: "application/pdf",
    size_bytes: 1,
    checksum_sha256: checksum,
    backend: "private-versioned-object-store",
    logical_key: `sha256:${checksum}`,
    immutable_generation: "1",
    immutable_version: null,
    verified_at: "2026-09-21T12:00:00.000Z",
    record_revision: 1,
    uploaded_at: "2026-09-21T12:00:00.000Z",
    updated_at: "2026-09-21T12:00:00.000Z",
    archived_at: null,
  };
}

function fakeExecutor(documentRow: Record<string, unknown>): RentOpsQueryExecutor {
  const executor: RentOpsQueryExecutor = {
    async query<T = Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> {
      if (sql.includes("FROM company_documents d")) return { rows: [documentRow as T] };
      if (sql.includes("FROM company_document_links")) return { rows: [] as T[] };
      return { rows: [] as T[] };
    },
  };
  executor.transaction = async (work) => work(executor);
  return executor;
}

function authorization() {
  return {
    authorizeRead: async () => undefined,
    authorizeWrite: async () => undefined,
  };
}

test("company document port requires server authorization callbacks", () => {
  assert.throws(() => createCompanyDocumentPort({
    executor: fakeExecutor(row(requestedOrganization)),
    documentStorage: createInMemoryObjectStore(),
    authorization: undefined as never,
  }), (error: unknown) => error instanceof CompanyDocumentError && error.code === "authorization_unconfigured");
});

test("company document list rejects a row from another organization even if a query adapter misbehaves", async () => {
  const service = createCompanyDocumentPort({
    executor: fakeExecutor(row(otherOrganization)),
    documentStorage: createInMemoryObjectStore(),
    authorization: authorization(),
  });
  await assert.rejects(
    () => service.list({ organizationId: requestedOrganization }),
    (error: unknown) => error instanceof CompanyDocumentError && error.code === "forbidden",
  );
});
