import { companyScopeSchema, type CompanyScope, type OperationReceipt } from "../../shared/company";
import type { IntakeListQuery, IntakePage, MraIngestionActionName, MraPacketReadModel } from "../../shared/intake";
import { MRA_INGESTION_POLICY, authorizeCompanyRead, loadAuthenticatedPrincipal, type AuthenticatedPrincipal, type TransportAttestation } from "../company/authorization";
import { ValidationCommandError } from "../company/commands/errors";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { RentOpsService } from "../rent-ops/services/service";
import type { ContentAddressedObjectStore } from "../rent-ops/storage";
import { createIntakeService, createTenantAccountApplyPort, executeMraIngestionCommand, type IntakeService } from "./service";

export interface IntakeCommandAccess {
  readonly principal: AuthenticatedPrincipal;
  readonly resolvePrincipal: (executor: RentOpsQueryExecutor) => Promise<AuthenticatedPrincipal>;
  readonly transport: TransportAttestation;
}

export interface MraStageSource {
  /** Raw packet bytes (Codex upload). */
  readonly bytes?: Uint8Array;
  /** Or an existing verified company document in the same organization. */
  readonly documentId?: string;
}

export interface IntakePort {
  list(principal: AuthenticatedPrincipal, query: IntakeListQuery): Promise<IntakePage>;
  get(principal: AuthenticatedPrincipal, input: { scope: CompanyScope; packetId: string }): Promise<MraPacketReadModel>;
  /** Codex-only: the MRA policy requires the codex_mcp transport and mra_ingestion capability. */
  stage(envelope: unknown, source: MraStageSource, access: IntakeCommandAccess): Promise<OperationReceipt>;
  /** Codex-only map, preview or apply through the durable company command runner. */
  execute(action: MraIngestionActionName, envelope: unknown, access: IntakeCommandAccess): Promise<OperationReceipt>;
}

export interface IntakePortOptions {
  readonly documentStorage?: ContentAddressedObjectStore;
}

const MAX_STAGE_BYTES = 50 * 1024 * 1024;

async function readDocumentBytes(executor: RentOpsQueryExecutor, storage: ContentAddressedObjectStore | undefined, principal: AuthenticatedPrincipal, organizationId: string, documentId: string): Promise<{ bytes: Uint8Array; fileName: string; declaredContentType: string }> {
  if (!storage) throw new ValidationCommandError("The verified private document store is unavailable.", { reason: "document_storage_unconfigured" });
  const result = await executor.query<Record<string, unknown>>(
    `SELECT file_name, declared_content_type, size_bytes, checksum_sha256, logical_key, immutable_generation, immutable_version, legal_entity_id, property_id
       FROM company_documents WHERE organization_id = $1 AND id = $2 AND state = 'verified'`,
    [organizationId, documentId],
  );
  const row = result.rows[0];
  const missing = () => new ValidationCommandError("The source document is not a verified company document in this company.", { reason: "source_document_missing" });
  if (!row) throw missing();
  // The parsed packet becomes readable to the stager, so the stager must be
  // able to read the source document's own entity/property scope.
  try {
    authorizeCompanyRead(principal, companyScopeSchema.parse({
      organizationId,
      ...(row.legal_entity_id ? { legalEntityId: String(row.legal_entity_id) } : {}),
      ...(row.legal_entity_id && row.property_id ? { propertyId: String(row.property_id) } : {}),
    }), MRA_INGESTION_POLICY.allowedRoles);
  } catch {
    throw missing();
  }
  const opened = await storage.openVerified(String(row.logical_key), {
    ...(row.immutable_generation ? { immutableGeneration: String(row.immutable_generation) } : {}),
    ...(row.immutable_version ? { immutableVersion: String(row.immutable_version) } : {}),
    expectedChecksumSha256: String(row.checksum_sha256), expectedSizeBytes: Number(row.size_bytes),
  });
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of opened.stream as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buffer.byteLength;
    if (total > MAX_STAGE_BYTES) throw new ValidationCommandError("The MRA packet is larger than the 50 MB limit.", { reason: "source_too_large" });
    chunks.push(buffer);
  }
  return { bytes: new Uint8Array(Buffer.concat(chunks)), fileName: String(row.file_name), declaredContentType: String(row.declared_content_type) };
}

/**
 * Intake composition: reads for the browser (read-only results) and Codex, and
 * the Codex-only MRA mutations. Tenant-account changes use the existing rental
 * payment/ledger commands inside the company command transaction, with one
 * savepoint per independent tenant-account group.
 */
export function createIntakePort(executor: RentOpsQueryExecutor, options: IntakePortOptions = {}): IntakePort {
  const serviceFor = (actorId: string, connection: RentOpsQueryExecutor = executor): IntakeService => createIntakeService({
    executor: connection,
    documentStorage: options.documentStorage,
    rentOpsFactory: transaction => new RentOpsService(new PostgresRentOpsRepository(transaction, true)),
    tenantAccountWriter: createTenantAccountApplyPort({ actorSubject: `company:${actorId}` }),
  });
  async function read<T>(principal: AuthenticatedPrincipal, work: (service: IntakeService, fresh: AuthenticatedPrincipal) => Promise<T>): Promise<T> {
    if (!executor.transaction) throw new Error("Intake reads require transaction support");
    return executor.transaction(async transaction => {
      const fresh = await loadAuthenticatedPrincipal(transaction, { actorId: principal.actorId, organizationId: principal.organizationId, role: principal.role });
      return work(serviceFor(principal.actorId, transaction), fresh);
    }, { readOnly: true });
  }
  return {
    list: (principal, query) => read(principal, (service, fresh) => service.listPackets(fresh, query)),
    get: (principal, input) => read(principal, (service, fresh) => service.readPacket(fresh, input.scope, input.packetId)),
    async stage(rawEnvelope, source, access) {
      const envelope = rawEnvelope as { scope?: CompanyScope; payload?: Record<string, unknown> };
      if (!envelope || typeof envelope !== "object" || !envelope.scope || !envelope.payload) throw new ValidationCommandError("A stage command envelope is required", { reason: "invalid_command_envelope" });
      if ((source.bytes === undefined) === (source.documentId === undefined)) throw new ValidationCommandError("Supply exactly one of packet bytes or a source document ID", { reason: "stage_source_ambiguous" });
      let bytes: Uint8Array;
      let fileName = String(envelope.payload.fileName ?? "");
      let declaredContentType = String(envelope.payload.declaredContentType ?? "");
      if (source.documentId !== undefined) {
        const document = await readDocumentBytes(executor, options.documentStorage, access.principal, envelope.scope.organizationId, source.documentId);
        bytes = document.bytes; fileName = fileName || document.fileName; declaredContentType = declaredContentType || document.declaredContentType;
      } else {
        bytes = source.bytes!;
      }
      if (bytes.byteLength > MAX_STAGE_BYTES) throw new ValidationCommandError("The MRA packet is larger than the 50 MB limit.", { reason: "source_too_large" });
      const service = serviceFor(access.principal.actorId);
      const withSource = { ...envelope, payload: { ...envelope.payload, fileName, declaredContentType, ...(source.documentId ? { sourceDocumentId: source.documentId } : {}) } };
      return service.stage({ scope: envelope.scope, fileName, declaredContentType, bytes }, withSource as never, access);
    },
    async execute(action, rawEnvelope, access) {
      const envelope = rawEnvelope as { payload?: Record<string, unknown> };
      if (!envelope || typeof envelope !== "object" || !envelope.payload || envelope.payload.action !== action) {
        throw new ValidationCommandError(`The command payload action must be ${action}`, { reason: "mra_action_mismatch" });
      }
      return executeMraIngestionCommand(executor, "mra_ingestion", rawEnvelope, { ...access, service: serviceFor(access.principal.actorId) });
    },
  };
}
