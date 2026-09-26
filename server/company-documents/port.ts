import type { Readable } from "node:stream";
import {
  companyDocumentCreateInputSchema,
  type CompanyDocument,
  type CompanyDocumentCommandKind,
  type CompanyDocumentContext,
  type CompanyDocumentCreateInput,
  type CompanyDocumentPage,
  type CompanyDocumentScopeFilter,
} from "../../shared/company-documents";
import { companyScopeSchema, type CompanyScope, type OperationReceipt } from "../../shared/company";
import { authorizeCompanyRead, loadAuthenticatedPrincipal, type AuthenticatedPrincipal, type TransportAttestation } from "../company/authorization";
import { ValidationCommandError } from "../company/commands/errors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import type { ContentAddressedObjectStore } from "../rent-ops/storage";
import { registerVerifiedRentOpsDocument } from "./bridge";
import {
  CompanyDocumentError,
  createCompanyDocumentPort,
  executeCompanyDocumentCommand,
  type CompanyDocumentAuthorization,
  type CompanyDocumentLegacyBridge,
} from "./service";

export const COMPANY_DOCUMENT_READ_ROLES = ["owner", "admin", "finance", "operations_pm", "project_manager", "read_only_reviewer"] as const;
export const COMPANY_DOCUMENT_WRITE_ROLE_LIST = ["owner", "admin", "finance", "operations_pm", "project_manager"] as const;

export interface CompanyDocumentCommandAccess {
  readonly principal: AuthenticatedPrincipal;
  readonly resolvePrincipal: (executor: RentOpsQueryExecutor) => Promise<AuthenticatedPrincipal>;
  readonly transport: TransportAttestation;
}

export interface CompanyDocumentBinary {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly declaredContentType: string;
}

export interface CompanyDocumentStageResult {
  readonly stageId: string;
  readonly document: CompanyDocument;
}

export interface CompanyDocumentDownloadResult {
  readonly document: CompanyDocument;
  readonly stream: Readable;
  readonly contentType: string;
  readonly fileName: string;
}

/** Principal-bound facade used by the browser and Codex adapters. */
export interface CompanyDocumentsPort {
  list(principal: AuthenticatedPrincipal, filter: CompanyDocumentScopeFilter): Promise<CompanyDocumentPage>;
  get(principal: AuthenticatedPrincipal, input: { scope: CompanyScope; documentId: string }): Promise<CompanyDocument>;
  /** Verify and stage source bytes for this actor. The durable create is a separate command. */
  prepareUpload(principal: AuthenticatedPrincipal, input: CompanyDocumentCreateInput, binary: CompanyDocumentBinary): Promise<CompanyDocumentStageResult>;
  execute(kind: CompanyDocumentCommandKind, envelope: unknown, access: CompanyDocumentCommandAccess): Promise<OperationReceipt>;
  /** Authorize, then open a verified stream. The caller streams it; no storage URL is exposed. */
  openDownload(principal: AuthenticatedPrincipal, input: { scope: CompanyScope; documentId: string }): Promise<CompanyDocumentDownloadResult>;
}

export interface CompanyDocumentsPortOptions {
  readonly documentStorage?: ContentAddressedObjectStore;
  readonly now?: () => Date;
}

function contextScope(context: Pick<CompanyDocumentContext, "organizationId" | "legalEntityId" | "propertyId">): CompanyScope {
  return companyScopeSchema.parse({
    organizationId: context.organizationId,
    ...(context.legalEntityId ? { legalEntityId: context.legalEntityId } : {}),
    ...(context.legalEntityId && context.propertyId ? { propertyId: context.propertyId } : {}),
  });
}

/**
 * Grants are reloaded from the database executor handed to each check, so a
 * revoked grant stops a long-running list or command at its next check.
 */
function principalAuthorization(principal: AuthenticatedPrincipal): CompanyDocumentAuthorization {
  const cache = new WeakMap<RentOpsQueryExecutor, Promise<AuthenticatedPrincipal>>();
  const fresh = (executor: RentOpsQueryExecutor) => {
    let loaded = cache.get(executor);
    if (!loaded) {
      loaded = loadAuthenticatedPrincipal(executor, { actorId: principal.actorId, organizationId: principal.organizationId, role: principal.role });
      cache.set(executor, loaded);
    }
    return loaded;
  };
  return {
    async authorizeRead(executor, context) { authorizeCompanyRead(await fresh(executor), contextScope(context), COMPANY_DOCUMENT_READ_ROLES); },
    async authorizeWrite(executor, context) { authorizeCompanyRead(await fresh(executor), contextScope(context), COMPANY_DOCUMENT_WRITE_ROLE_LIST); },
  };
}

/** Investor agreements may be uploaded before their first contract version. */
const legacyBridge: CompanyDocumentLegacyBridge = {
  async registerVerifiedDocument(input) {
    const needsBridge = Boolean(input.document.context.investorContractVersionId)
      || input.document.links.some(link => link.kind === "investor_contract_version")
      || (Boolean(input.document.context.legalEntityId)
        && ["contract", "loan", "investor_agreement"].includes(input.document.kind));
    if (needsBridge) await registerVerifiedRentOpsDocument(input);
  },
};

function mapServiceError(error: unknown): never {
  if (error instanceof CompanyDocumentError) {
    if (error.code === "not_found" || error.code === "forbidden") throw new ValidationCommandError("The company document was not found in the requested scope.", { reason: "company_document_not_found" });
    throw new ValidationCommandError(error.message, { reason: error.code });
  }
  throw error;
}

export function createCompanyDocumentsPort(executor: RentOpsQueryExecutor, options: CompanyDocumentsPortOptions = {}): CompanyDocumentsPort {
  const service = (principal: AuthenticatedPrincipal) => {
    if (!options.documentStorage) throw new ValidationCommandError("The verified private document store is unavailable.", { reason: "document_storage_unconfigured" });
    return createCompanyDocumentPort({
      executor, documentStorage: options.documentStorage, authorization: principalAuthorization(principal),
      legacyBridge, actorId: principal.actorId, ...(options.now ? { now: options.now } : {}),
    });
  };
  const checkScope = (principal: AuthenticatedPrincipal, scope: CompanyScope, roles: readonly string[]) =>
    authorizeCompanyRead(principal, companyScopeSchema.parse(scope), roles as never);
  return {
    async list(principal, filter) {
      checkScope(principal, contextScope(filter), COMPANY_DOCUMENT_READ_ROLES);
      try { return await service(principal).list(filter); } catch (error) { return mapServiceError(error); }
    },
    async get(principal, input) {
      checkScope(principal, input.scope, COMPANY_DOCUMENT_READ_ROLES);
      try { return await service(principal).get(input.documentId, input.scope); } catch (error) { return mapServiceError(error); }
    },
    async prepareUpload(principal, rawInput, binary) {
      const input = companyDocumentCreateInputSchema.parse(rawInput);
      if (input.context.organizationId !== principal.organizationId) throw new ValidationCommandError("The document company does not match this request.", { reason: "company_document_scope" });
      checkScope(principal, contextScope(input.context), COMPANY_DOCUMENT_WRITE_ROLE_LIST);
      try {
        const prepared = await service(principal).prepare(input, binary);
        return { stageId: prepared.stageId, document: prepared.document };
      } catch (error) { return mapServiceError(error); }
    },
    execute(kind, envelope, access) {
      if (!options.documentStorage) throw new ValidationCommandError("The verified private document store is unavailable.", { reason: "document_storage_unconfigured" });
      return executeCompanyDocumentCommand(executor, kind, envelope, {
        documentStorage: options.documentStorage, authorization: principalAuthorization(access.principal), legacyBridge,
        actorId: access.principal.actorId, principal: access.principal, resolvePrincipal: access.resolvePrincipal, transport: access.transport,
        ...(options.now ? { now: options.now } : {}),
      });
    },
    async openDownload(principal, input) {
      checkScope(principal, input.scope, COMPANY_DOCUMENT_READ_ROLES);
      try {
        const opened = await service(principal).openDownload(input.documentId, input.scope);
        return { document: opened.document, stream: opened.stream as unknown as Readable, contentType: opened.contentType, fileName: opened.fileName };
      } catch (error) { return mapServiceError(error); }
    },
  };
}
