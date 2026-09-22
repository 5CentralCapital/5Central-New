import type { ManagedStorageReadiness } from "./managed-storage-readiness";
import { canonicalJson, sha256 } from "../export/hash";
import type { RentOpsQueryExecutor } from "../repositories/postgres";
import { DatabaseAuditError, inspectDatabaseTarget, runDatabaseAudit } from "./database-audit";
import { RENT_OPS_MIGRATION_REQUIRED_TABLES, RENT_OPS_SCHEMA_VERSION, rentOpsMigrationChecksumForVersion } from "../persistence";
import {
  runRestrictedMigrationArchive,
  type RestrictedMigrationDatabaseAuditContext,
  type RestrictedMigrationRunResult,
  type VerifiedSupplementReceiptVerifier,
} from "./migration-runner";
import type { AffirmativeApplyGate, PersistenceImporterOptions, RestrictedDocumentTransferOrphanEvidence, RestrictedVerifiedDocumentTransfer } from "./persistence-importer";
import type { PrivateObjectStorePrivilegeProbe } from "../storage/types";
import {
  assertEmptyRentOpsTargetState,
  assertIdenticalRentOpsTargetState,
  captureRentOpsTargetState,
  restoreRequired as buildRestoreRequirement,
  type RentOpsRestoreRequirement,
  type RentOpsTargetState,
} from "./target-state";

export type RestrictedMigrationOrchestrationStage = "first_apply" | "second_apply";

export interface RestrictedMigrationAuditDecision {
  passed: boolean;
  blockingReasons?: readonly string[];
  /** Production CLI must identify the independent full DB audit and bind it to the archive receipt. */
  independentDatabaseAudit?: {
    passed: true;
    archiveReceiptSha256: string;
    auditReceiptSha256?: string;
    targetFingerprint?: string;
    migrationVersion?: number;
    migrationChecksum?: string;
    migrationChainSha256?: string;
    targetStateDigest?: string;
  };
}

export interface RestrictedMigrationTargetStateOptions {
  /** The same injected executor used by the apply path; no new connection is created. */
  executor: RentOpsQueryExecutor;
  capture?: (executor: RentOpsQueryExecutor) => Promise<RentOpsTargetState>;
  assertEmpty?: (state: RentOpsTargetState) => void;
  assertIdentical?: (before: RentOpsTargetState, after: RentOpsTargetState) => void;
}

export interface RestrictedMigrationExecutionContext {
  runNumber: 0 | 1 | 2;
  /** The one-time affirmative gate for this apply, when applicable. */
  affirmativeGate?: AffirmativeApplyGate;
}

export interface RestrictedMigrationOrchestrationOptions<T extends { report: { blockingReasons: readonly string[] } }> {
  /** Runs the already-loaded archive in the requested mode. */
  execute: (mode: "dry_run" | "apply", runNumber: 0 | 1 | 2, context?: RestrictedMigrationExecutionContext) => Promise<T>;
  /** A second, independent read-only audit is required after each apply. */
  audit?: (context: { stage: RestrictedMigrationOrchestrationStage; result: T; targetState?: RentOpsTargetState }) => Promise<RestrictedMigrationAuditDecision | void>;
  /** Digest of safe result metadata. Defaults to a canonical result digest. */
  digest?: (result: T) => string;
  /** Optional first gate; the archive wrapper also accepts it in importerOptions. */
  firstApplyGate?: AffirmativeApplyGate;
  /** Required by the archive wrapper for a real second apply. */
  secondApplyGate?: AffirmativeApplyGate;
  /** Optional DB-state proof. When supplied, first apply requires an empty target and second apply is DB-idempotent. */
  targetState?: RestrictedMigrationTargetStateOptions;
}

export interface RestrictedMigrationOrchestrationResult<T> {
  dryRun: T;
  firstApply: T;
  secondApply: T;
  firstApplyDigest: string;
  secondApplyDigest: string;
  identicalSecondRun: true;
  targetState?: {
    beforeFirstApply: RentOpsTargetState;
    afterFirstApply: RentOpsTargetState;
    beforeSecondApply: RentOpsTargetState;
    afterSecondApply: RentOpsTargetState;
  };
}

export class RestrictedMigrationOrchestrationError extends Error {
  readonly reasons: string[];
  readonly restoreRequired?: RentOpsRestoreRequirement;

  constructor(reasons: readonly string[], restoreRequired?: RentOpsRestoreRequirement) {
    const safe = Array.from(new Set(reasons.map((reason) => reason.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 160))));
    super(`Restricted migration orchestration failed: ${safe.join("; ")}`);
    this.name = "RestrictedMigrationOrchestrationError";
    this.reasons = safe;
    if (restoreRequired) this.restoreRequired = restoreRequired;
  }
}

function assertNoBlockingReasons<T extends { report: { blockingReasons: readonly string[] } }>(stage: string, result: T): void {
  if (result.report.blockingReasons.length > 0) {
    throw new RestrictedMigrationOrchestrationError([`${stage}_blocked`, ...result.report.blockingReasons]);
  }
}

function defaultDigest<T>(result: T): string {
  try {
    return sha256(canonicalJson(result));
  } catch {
    throw new RestrictedMigrationOrchestrationError(["result_digest_failed"]);
  }
}

async function assertAudit<T extends { report: { blockingReasons: readonly string[] } }>(
  audit: NonNullable<RestrictedMigrationOrchestrationOptions<T>["audit"]>,
  stage: RestrictedMigrationOrchestrationStage,
  result: T,
  targetState?: RentOpsTargetState,
): Promise<void> {
  let decision: RestrictedMigrationAuditDecision | void;
  try {
    decision = await audit({ stage, result, ...(targetState ? { targetState } : {}) });
  } catch {
    throw new RestrictedMigrationOrchestrationError([`${stage}_audit_failed`]);
  }
  if (decision && decision.passed !== true) {
    throw new RestrictedMigrationOrchestrationError([`${stage}_audit_blocked`, ...(decision.blockingReasons ?? [])]);
  }
}

function targetErrorReasons(error: unknown, fallback: string): string[] {
  if (error && typeof error === "object" && Array.isArray((error as { reasons?: unknown }).reasons)) {
    const reasons = (error as { reasons: unknown[] }).reasons.filter((reason): reason is string => typeof reason === "string");
    if (reasons.length > 0) return reasons;
  }
  return [fallback];
}

function restoreError(reasons: readonly string[], reason: string, before: RentOpsTargetState, observed?: RentOpsTargetState): RestrictedMigrationOrchestrationError {
  return new RestrictedMigrationOrchestrationError(["restore_required", ...reasons], buildRestoreRequirement(reason, before, observed));
}

function validGate(value: AffirmativeApplyGate | undefined): value is AffirmativeApplyGate {
  return value?.phrase === "APPLY_RENT_OPS_STAGING_ONCE"
    && typeof value.nonce === "string"
    && value.nonce.length >= 8
    && value.nonce.length <= 200;
}

function assertFreshGates(first: AffirmativeApplyGate | undefined, second: AffirmativeApplyGate | undefined): void {
  if (!first) throw new RestrictedMigrationOrchestrationError(["first_apply_gate_missing"]);
  if (!validGate(second)) throw new RestrictedMigrationOrchestrationError(["second_apply_gate_missing"]);
  if (!validGate(first)) throw new RestrictedMigrationOrchestrationError(["first_apply_gate_invalid"]);
  if (first.nonce === second.nonce) throw new RestrictedMigrationOrchestrationError(["second_apply_gate_nonce_reused"]);
}

function migrationChainDigest(checksums: Readonly<Record<number, string>> | undefined): string {
  return sha256(canonicalJson(checksums ?? {}));
}

function auditFailureReasons(error: unknown, fallback: string): string[] {
  if (error instanceof DatabaseAuditError && error.reasons.length > 0) return error.reasons;
  return [fallback];
}

/**
 * The production cutover audit. It deliberately takes the expected controls
 * from the archive runner's in-memory approved artifact and performs both the
 * target identity/schema inspection and the full SQL audit on the supplied
 * executor. No callback result can substitute for this path in production.
 */
export async function runArtifactBoundDatabaseAudit(context: {
  stage: RestrictedMigrationOrchestrationStage;
  result: RestrictedMigrationRunResult;
  targetState?: RentOpsTargetState;
}, options: {
  executor: RentOpsQueryExecutor;
  importerOptions?: PersistenceImporterOptions;
}): Promise<RestrictedMigrationAuditDecision> {
  const result = context.result;
  const auditContext: RestrictedMigrationDatabaseAuditContext | undefined = result.databaseAuditContext;
  const targetStateDigest = context.targetState?.tablesSha256;
  if (!auditContext) return { passed: false, blockingReasons: ["independent_database_audit_expected_controls_missing"] };
  if (!/^[a-f0-9]{64}$/i.test(auditContext.archiveReceiptSha256)
    || !result.archiveAuditBindingSha256
    || !/^[a-f0-9]{64}$/i.test(result.archiveAuditBindingSha256)
    || result.archiveAuditBindingSha256.toLowerCase() !== auditContext.archiveReceiptSha256.toLowerCase()) {
    return { passed: false, blockingReasons: ["independent_database_audit_archive_receipt_mismatch"] };
  }
  if (!/^[a-f0-9]{64}$/i.test(auditContext.artifactBindingSha256)) {
    return { passed: false, blockingReasons: ["independent_database_audit_artifact_binding_invalid"] };
  }
  if (!/^[a-f0-9]{64}$/i.test(result.report.artifactBindingSha256)
    || result.report.artifactBindingSha256.toLowerCase() !== auditContext.artifactBindingSha256.toLowerCase()) {
    return { passed: false, blockingReasons: ["independent_database_audit_artifact_binding_mismatch"] };
  }
  if (!targetStateDigest || !/^[a-f0-9]{64}$/i.test(targetStateDigest)) {
    return { passed: false, blockingReasons: ["independent_database_audit_target_state_digest_missing"] };
  }

  let inspection: Awaited<ReturnType<typeof inspectDatabaseTarget>>;
  try {
    inspection = await inspectDatabaseTarget(options.executor);
  } catch (error) {
    return { passed: false, blockingReasons: auditFailureReasons(error, "independent_database_audit_target_inspection_failed") };
  }
  const expectedFingerprint = auditContext.expectedTargetFingerprint ?? options.importerOptions?.expectedDatabaseFingerprint;
  const targetReasons: string[] = [];
  if (!expectedFingerprint) targetReasons.push("independent_database_audit_target_fingerprint_missing");
  else if (inspection.redactedFingerprint !== expectedFingerprint) targetReasons.push("independent_database_audit_target_fingerprint_mismatch");
  if (inspection.migrationVersion !== auditContext.migration.version || inspection.migrationVersion !== RENT_OPS_SCHEMA_VERSION) targetReasons.push("independent_database_audit_migration_version_mismatch");
  if (inspection.requiredTables !== auditContext.migration.requiredTables || inspection.requiredTables !== RENT_OPS_MIGRATION_REQUIRED_TABLES.length) targetReasons.push("independent_database_audit_required_tables_mismatch");
  if (inspection.migrationChecksum !== auditContext.migration.checksum || inspection.migrationChecksum !== rentOpsMigrationChecksumForVersion(RENT_OPS_SCHEMA_VERSION)) targetReasons.push("independent_database_audit_migration_checksum_mismatch");
  if (inspection.migrationChainValid !== true) targetReasons.push("independent_database_audit_migration_chain_invalid");
  if (migrationChainDigest(inspection.migrationChecksums) !== auditContext.migration.migrationChainSha256) targetReasons.push("independent_database_audit_migration_chain_mismatch");
  if (targetReasons.length > 0) return { passed: false, blockingReasons: targetReasons };

  let audit: Awaited<ReturnType<typeof runDatabaseAudit>>;
  try {
    audit = await runDatabaseAudit(options.executor, {
      asOfDate: auditContext.asOfDate,
      expected: auditContext.expected,
      requireExpectedControls: true,
    });
  } catch (error) {
    return { passed: false, blockingReasons: auditFailureReasons(error, "independent_database_audit_failed") };
  }
  const auditReceiptSha256 = sha256(canonicalJson(audit));
  if (!audit.passed) return { passed: false, blockingReasons: audit.blockingReasons };
  return {
    passed: true,
    independentDatabaseAudit: {
      passed: true,
      archiveReceiptSha256: auditContext.archiveReceiptSha256,
      auditReceiptSha256,
      targetFingerprint: inspection.redactedFingerprint,
      migrationVersion: inspection.migrationVersion,
      migrationChecksum: inspection.migrationChecksum,
      migrationChainSha256: migrationChainDigest(inspection.migrationChecksums),
      targetStateDigest,
    },
  };
}

/**
 * A small injected seam for the cutover checklist.  It intentionally requires
 * dry-run, apply, independent audit, and a byte-for-byte equivalent second
 * apply result.  Any failure stops the sequence and is safe to retry.
 */
export async function runRestrictedMigrationOrchestration<T extends { report: { blockingReasons: readonly string[] } }>(
  options: RestrictedMigrationOrchestrationOptions<T>,
): Promise<RestrictedMigrationOrchestrationResult<T>> {
  if (typeof options.execute !== "function") throw new RestrictedMigrationOrchestrationError(["migration_executor_missing"]);
  const audit = options.audit;
  if (typeof audit !== "function") throw new RestrictedMigrationOrchestrationError(["migration_audit_missing"]);
  const digest = options.digest ?? defaultDigest;
  // Once an apply gate is supplied, the orchestration is on the real gated
  // path and must receive an independent second gate as well.  The ungated
  // injected seam remains available for pure unit tests only.
  if (options.firstApplyGate !== undefined || options.secondApplyGate !== undefined) {
    assertFreshGates(options.firstApplyGate, options.secondApplyGate);
  }

  const targetStateOptions = options.targetState;
  let beforeFirstApply: RentOpsTargetState | undefined;
  let afterFirstApply: RentOpsTargetState | undefined;
  let beforeSecondApply: RentOpsTargetState | undefined;
  let afterSecondApply: RentOpsTargetState | undefined;
  if (targetStateOptions) {
    // State-proofed apply is a destructive staging operation and therefore
    // always needs two distinct one-time gates, even when the execution seam
    // is injected by a test.
    assertFreshGates(options.firstApplyGate, options.secondApplyGate);
    const capture = targetStateOptions.capture ?? captureRentOpsTargetState;
    try {
      beforeFirstApply = await capture(targetStateOptions.executor);
      (targetStateOptions.assertEmpty ?? assertEmptyRentOpsTargetState)(beforeFirstApply);
    } catch (error) {
      throw new RestrictedMigrationOrchestrationError(targetErrorReasons(error, "target_not_empty"));
    }
  }

  const dryRun = await options.execute("dry_run", 0, { runNumber: 0 });
  assertNoBlockingReasons("dry_run", dryRun);
  const firstApply = await options.execute("apply", 1, { runNumber: 1, ...(options.firstApplyGate ? { affirmativeGate: options.firstApplyGate } : {}) });
  if (targetStateOptions && beforeFirstApply) {
    try {
      afterFirstApply = await (targetStateOptions.capture ?? captureRentOpsTargetState)(targetStateOptions.executor);
    } catch (error) {
      throw restoreError(targetErrorReasons(error, "first_apply_target_state_capture_failed"), "first_apply_target_state_capture_failed", beforeFirstApply);
    }
  }
  try {
    assertNoBlockingReasons("first_apply", firstApply);
  } catch (error) {
    if (targetStateOptions && beforeFirstApply) {
      throw restoreError(targetErrorReasons(error, "first_apply_blocked_after_commit"), "first_apply_blocked_after_commit", beforeFirstApply, afterFirstApply);
    }
    throw error;
  }
  try {
    await assertAudit(audit, "first_apply", firstApply, afterFirstApply);
  } catch (error) {
    if (targetStateOptions && beforeFirstApply) {
      throw restoreError(targetErrorReasons(error, "first_apply_audit_failed"), "first_apply_audit_failed", beforeFirstApply, afterFirstApply);
    }
    throw error;
  }
  if (targetStateOptions && beforeFirstApply && afterFirstApply) {
    try {
      beforeSecondApply = await (targetStateOptions.capture ?? captureRentOpsTargetState)(targetStateOptions.executor);
      (targetStateOptions.assertIdentical ?? assertIdenticalRentOpsTargetState)(afterFirstApply, beforeSecondApply);
    } catch (error) {
      throw restoreError(targetErrorReasons(error, "target_state_changed_before_second_apply"), "target_state_changed_before_second_apply", afterFirstApply, beforeSecondApply);
    }
  }
  const secondApply = await options.execute("apply", 2, { runNumber: 2, ...(options.secondApplyGate ? { affirmativeGate: options.secondApplyGate } : {}) });
  if (targetStateOptions && beforeFirstApply && afterFirstApply && beforeSecondApply) {
    try {
      afterSecondApply = await (targetStateOptions.capture ?? captureRentOpsTargetState)(targetStateOptions.executor);
      (targetStateOptions.assertIdentical ?? assertIdenticalRentOpsTargetState)(afterFirstApply, afterSecondApply);
    } catch (error) {
      throw restoreError(targetErrorReasons(error, "second_apply_target_state_changed"), "second_apply_target_state_changed", afterFirstApply, afterSecondApply);
    }
  }
  try {
    assertNoBlockingReasons("second_apply", secondApply);
  } catch (error) {
    if (targetStateOptions && beforeFirstApply) {
      throw restoreError(targetErrorReasons(error, "second_apply_blocked_after_commit"), "second_apply_blocked_after_commit", beforeFirstApply, afterSecondApply);
    }
    throw error;
  }
  const firstApplyDigest = digest(firstApply);
  const secondApplyDigest = digest(secondApply);
  if (firstApplyDigest !== secondApplyDigest) {
    if (targetStateOptions && beforeFirstApply) {
      throw restoreError(["second_run_not_identical"], "second_run_not_identical", beforeFirstApply, afterSecondApply);
    }
    throw new RestrictedMigrationOrchestrationError(["second_run_not_identical"]);
  }
  try {
    await assertAudit(audit, "second_apply", secondApply, afterSecondApply);
  } catch (error) {
    if (targetStateOptions && beforeFirstApply) {
      throw restoreError(targetErrorReasons(error, "second_apply_audit_failed"), "second_apply_audit_failed", beforeFirstApply, afterSecondApply);
    }
    throw error;
  }
  return {
    dryRun,
    firstApply,
    secondApply,
    firstApplyDigest,
    secondApplyDigest,
    identicalSecondRun: true,
    ...(beforeFirstApply && afterFirstApply && beforeSecondApply && afterSecondApply
      ? { targetState: { beforeFirstApply, afterFirstApply, beforeSecondApply, afterSecondApply } }
      : {}),
  };
}

/**
 * Production-facing convenience wrapper.  The execution and audit seams stay
 * injectable for staging tests; the default execution path is still the
 * restricted archive runner and therefore never imports RM credentials or a
 * global database connection.
 */
export async function runRestrictedMigrationArchiveOrchestration(options: {
  archiveRoot?: string;
  executor?: RentOpsQueryExecutor;
  importerOptions?: PersistenceImporterOptions;
  now?: Date;
  execute?: (mode: "dry_run" | "apply", runNumber: 0 | 1 | 2, context?: RestrictedMigrationExecutionContext) => Promise<RestrictedMigrationRunResult>;
  /** Test-only override. Production/default execution uses the concrete SQL audit below. */
  audit?: (context: { stage: RestrictedMigrationOrchestrationStage; result: RestrictedMigrationRunResult; targetState?: RentOpsTargetState }) => Promise<RestrictedMigrationAuditDecision | void>;
  digest?: (result: RestrictedMigrationRunResult) => string;
  firstApplyGate?: AffirmativeApplyGate;
  secondApplyGate?: AffirmativeApplyGate;
  targetState?: RestrictedMigrationTargetStateOptions;
  restrictedVerifiedDocumentTransfer?: RestrictedVerifiedDocumentTransfer;
  restrictedDocumentOrphanSink?: (evidence: RestrictedDocumentTransferOrphanEvidence) => Promise<void> | void;
  storagePrivilegeProbe?: PrivateObjectStorePrivilegeProbe;
  managedStorageReadiness?: ManagedStorageReadiness;
  /** Independent trust-store verification for derivative supplement receipts.
   * The low-level archive reader requires this only when a provenance sidecar
   * is present; there is intentionally no default or auto-pass verifier. */
  supplementReceiptVerifier?: VerifiedSupplementReceiptVerifier;
}): Promise<RestrictedMigrationOrchestrationResult<RestrictedMigrationRunResult>> {
  if (!options.execute && !options.archiveRoot) throw new RestrictedMigrationOrchestrationError(["restricted_archive_root_missing"]);
  if (process.env.NODE_ENV === "production" && options.execute) throw new RestrictedMigrationOrchestrationError(["restricted_archive_runner_override_forbidden"]);
  const firstApplyGate = options.firstApplyGate ?? options.importerOptions?.affirmativeGate;
  if (!options.execute) assertFreshGates(firstApplyGate, options.secondApplyGate);
  const orchestrationNow = options.now ?? new Date();
  const execute = options.execute ?? (async (mode: "dry_run" | "apply", runNumber: 0 | 1 | 2, context?: RestrictedMigrationExecutionContext) => {
    if (!options.archiveRoot) throw new RestrictedMigrationOrchestrationError(["restricted_archive_root_missing"]);
    const importerOptions = {
      ...(options.importerOptions ?? {}),
      mode,
      ...(mode === "apply"
        ? { affirmativeGate: context?.affirmativeGate }
        : {}),
    };
    return runRestrictedMigrationArchive({
      archiveRoot: options.archiveRoot,
      mode,
      ...(options.executor ? { executor: options.executor } : {}),
      importerOptions,
      ...(options.restrictedVerifiedDocumentTransfer ? { restrictedVerifiedDocumentTransfer: options.restrictedVerifiedDocumentTransfer } : {}),
      ...(options.restrictedDocumentOrphanSink ? { restrictedDocumentOrphanSink: options.restrictedDocumentOrphanSink } : {}),
      ...(options.storagePrivilegeProbe ? { storagePrivilegeProbe: options.storagePrivilegeProbe } : {}),
      ...(options.managedStorageReadiness ? { managedStorageReadiness: options.managedStorageReadiness } : {}),
      ...(options.supplementReceiptVerifier ? { supplementReceiptVerifier: options.supplementReceiptVerifier } : {}),
      now: orchestrationNow,
    });
  });
  if (process.env.NODE_ENV === "production" && options.audit) throw new RestrictedMigrationOrchestrationError(["restricted_independent_audit_override_forbidden"]);
  const audit = options.audit ?? (async (context: { stage: RestrictedMigrationOrchestrationStage; result: RestrictedMigrationRunResult; targetState?: RentOpsTargetState }) => {
    if (!options.executor) return { passed: false, blockingReasons: ["restricted_independent_database_audit_executor_missing"] };
    return runArtifactBoundDatabaseAudit(context, { executor: options.executor, importerOptions: options.importerOptions });
  });
  return runRestrictedMigrationOrchestration({
    execute,
    audit: async (context) => {
      // The restricted occurrence readback is a mandatory post-commit gate;
      // an independent full DB audit must still be supplied by options.audit.
      // Neither proof may silently substitute for the other.
      if (context.result.summary?.mode === "apply" && context.result.postcommitAudit?.passed !== true) {
        return {
          passed: false,
          blockingReasons: ["restricted_parity_postcommit_audit_missing_or_failed"],
        };
      }
      return audit(context);
    },
    ...(options.digest ? { digest: options.digest } : {}),
    ...(firstApplyGate ? { firstApplyGate } : {}),
    ...(options.secondApplyGate ? { secondApplyGate: options.secondApplyGate } : {}),
    // A real executor always carries a transaction-capable target-state proof,
    // even when a staging harness supplies the archive execution seam.  The
    // transaction check keeps the legacy no-DB unit seam lightweight while
    // preventing a default audit from running without the empty/idempotent
    // business/restricted/document-object state proof.
    ...(options.targetState
      ? { targetState: options.targetState }
      : options.executor && typeof options.executor.transaction === "function"
        ? { targetState: { executor: options.executor } }
        : {}),
  });
}
