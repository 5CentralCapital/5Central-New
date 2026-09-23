import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { ReviewOperation } from "../../shared/review-cases";
import { ConflictCommandError, ValidationCommandError } from "../company/commands/errors";
import { reconcileImportedRecords, type ReconciliationManifest, type ReconciliationOperation, type ReconciliationPlan } from "../rent-ops/reconciliation/operator";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import type { StorageReadAdapter } from "../rent-ops/storage";

/**
 * Bridge from a review case to the existing guarded reconciliation writer.
 * The writer re-hashes evidence bytes, checks each target's revision and
 * before-hash, runs a dry-run plan and applies only with that plan's exact
 * token. It never changes ledger entries or allocations.
 */

export interface ReviewEvidenceDocument {
  readonly documentId: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly logicalKey: string;
  readonly immutableGeneration: string | null;
  readonly immutableVersion: string | null;
}

const MAX_EVIDENCE_BYTES = 50 * 1024 * 1024;

export async function loadEvidenceDocument(executor: RentOpsQueryExecutor, organizationId: string, documentId: string): Promise<ReviewEvidenceDocument> {
  const result = await executor.query<Record<string, unknown>>(
    `SELECT id, checksum_sha256, size_bytes, logical_key, immutable_generation, immutable_version
       FROM company_documents WHERE organization_id = $1 AND id = $2 AND state = 'verified'`,
    [organizationId, documentId],
  );
  const row = result.rows[0];
  if (!row) throw new ValidationCommandError("Evidence must be a verified company document in this company", { reason: "review_evidence_document_missing" });
  return {
    documentId: String(row.id), checksumSha256: String(row.checksum_sha256), sizeBytes: Number(row.size_bytes), logicalKey: String(row.logical_key),
    immutableGeneration: row.immutable_generation ? String(row.immutable_generation) : null,
    immutableVersion: row.immutable_version ? String(row.immutable_version) : null,
  };
}

async function readAll(stream: Readable | NodeJS.ReadableStream, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buffer.byteLength;
    if (total > limit) throw new ValidationCommandError("Evidence document exceeds the size limit", { reason: "review_evidence_too_large" });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Materialize the verified evidence bytes in a private temporary file so the
 * guarded writer can re-hash them. The file is removed afterwards.
 */
async function withEvidenceFile<T>(storage: StorageReadAdapter, document: ReviewEvidenceDocument, work: (evidence: { path: string; sha256: string; reference: string }) => Promise<T>): Promise<T> {
  let bytes: Buffer;
  try {
    const opened = await storage.openVerified(document.logicalKey, {
      ...(document.immutableGeneration ? { immutableGeneration: document.immutableGeneration } : {}),
      ...(document.immutableVersion ? { immutableVersion: document.immutableVersion } : {}),
      expectedChecksumSha256: document.checksumSha256,
      expectedSizeBytes: document.sizeBytes,
    });
    bytes = await readAll(opened.stream as Readable, MAX_EVIDENCE_BYTES);
  } catch (error) {
    if (error instanceof ValidationCommandError) throw error;
    throw new ValidationCommandError("The evidence document could not be verified", { reason: "review_evidence_unverified" });
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== document.checksumSha256) throw new ValidationCommandError("The evidence document changed and requires review", { reason: "review_evidence_unverified" });
  const directory = await mkdtemp(join(tmpdir(), "review-evidence-"));
  try {
    await chmod(directory, 0o700);
    const path = join(directory, "evidence");
    await writeFile(path, bytes, { mode: 0o600 });
    return await work({ path, sha256, reference: `company-document:${document.documentId}` });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export interface GuardedPlanInput {
  readonly executor: RentOpsQueryExecutor;
  readonly storage: StorageReadAdapter | undefined;
  readonly organizationId: string;
  readonly caseId: string;
  readonly caseRevision: number;
  readonly actorId: string;
  readonly operation: ReviewOperation;
  readonly evidenceDocumentId: string;
  readonly occurredAt: string;
}

function manifestFor(input: GuardedPlanInput, evidence: { path: string; sha256: string; reference: string }): ReconciliationManifest {
  return {
    id: `review-case-${input.caseId}-r${input.caseRevision}`,
    actorSubject: input.actorId,
    occurredAt: input.occurredAt,
    operations: [{ ...(input.operation as Record<string, unknown>), evidence } as unknown as ReconciliationOperation],
  };
}

/** Map guarded-writer failures to command errors; a changed source is a conflict. */
function guardedError(error: unknown): never {
  if (error instanceof ValidationCommandError || error instanceof ConflictCommandError) throw error;
  const message = error instanceof Error ? error.message : "The guarded correction failed";
  if (/Before-state changed|guard changed|approved dry-run plan token|Exact imported identity mismatch|revision/i.test(message)) {
    throw new ConflictCommandError("The source records changed since this fix was proposed. Propose it again from current records.", { reason: "review_case_source_stale" });
  }
  throw new ValidationCommandError(`The correction cannot be applied: ${message}`.slice(0, 500), { reason: "review_case_correction_rejected" });
}

async function withGuardedWriter<T>(input: GuardedPlanInput, work: (execute: (mode: "plan" | "apply", token?: string) => Promise<ReconciliationPlan>) => Promise<T>): Promise<T> {
  if (!input.storage) throw new ValidationCommandError("Verified document storage is not configured; operational fixes cannot be checked", { reason: "review_evidence_storage_unconfigured" });
  const document = await loadEvidenceDocument(input.executor, input.organizationId, input.evidenceDocumentId);
  return withEvidenceFile(input.storage, document, async evidence => {
    // One manifest per materialized evidence file: the plan token binds it exactly.
    const manifest = manifestFor(input, evidence);
    const repository = new PostgresRentOpsRepository(input.executor, true);
    return work(async (mode, token) => {
      try {
        return await reconcileImportedRecords(repository, manifest, mode === "plan" ? { mode } : { mode, approvedPlanToken: token });
      } catch (error) {
        return guardedError(error);
      }
    });
  });
}

/** Dry run: executes every guarded action inside a savepoint, then rolls it back. */
export function planGuardedCorrection(input: GuardedPlanInput): Promise<ReconciliationPlan> {
  return withGuardedWriter(input, execute => execute("plan"));
}

/**
 * Re-plan against current records and refuse if any target's before-state
 * differs from the proposal's reviewed preview, then apply with the plan's
 * exact token. The operation's own revision and before-hash guards also fail
 * closed if a target changed.
 */
export async function applyGuardedCorrection(input: GuardedPlanInput & { readonly proposedBeforeHashes: readonly string[] }): Promise<ReconciliationPlan> {
  return withGuardedWriter(input, async execute => {
    const plan = await execute("plan");
    const current = plan.changes.map(change => change.beforeSha256);
    if (current.length !== input.proposedBeforeHashes.length || current.some((hash, index) => hash !== input.proposedBeforeHashes[index])) {
      throw new ConflictCommandError("The source records changed since this fix was proposed. Propose it again from current records.", { reason: "review_case_source_stale" });
    }
    return execute("apply", plan.token);
  });
}
