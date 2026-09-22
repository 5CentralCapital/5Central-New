import assert from "node:assert/strict";
import test from "node:test";
import type { RentOpsQueryExecutor } from "../repositories/postgres";
import {
  RestrictedMigrationOrchestrationError,
  runArtifactBoundDatabaseAudit,
  runRestrictedMigrationArchiveOrchestration,
  runRestrictedMigrationOrchestration,
} from "./restricted-orchestration";
import { RENT_OPS_TARGET_STATE_VERSION, type RentOpsTargetState } from "./target-state";

interface SyntheticRun {
  report: { blockingReasons: string[] };
  idempotencyDigest: string;
}

function run(idempotencyDigest = "same-result"): SyntheticRun {
  return { report: { blockingReasons: [] }, idempotencyDigest };
}

function targetState(digest: string, rowCount = 0): RentOpsTargetState {
  return {
    version: RENT_OPS_TARGET_STATE_VERSION,
    rowCount,
    canonicalBytes: rowCount,
    tablesSha256: digest,
    tables: [],
  };
}

test("injected cutover seam executes archive, dry-run, apply, audit, and identical second run in order", async () => {
  const calls: string[] = [];
  const audited: string[] = [];
  const result = await runRestrictedMigrationOrchestration<SyntheticRun>({
    execute: async (mode, runNumber) => {
      calls.push(`${mode}:${runNumber}`);
      return run();
    },
    audit: async ({ stage }) => {
      audited.push(stage);
      return { passed: true };
    },
    digest: (value) => value.idempotencyDigest,
  });
  assert.deepEqual(calls, ["dry_run:0", "apply:1", "apply:2"]);
  assert.deepEqual(audited, ["first_apply", "second_apply"]);
  assert.equal(result.identicalSecondRun, true);
  assert.equal(result.firstApplyDigest, result.secondApplyDigest);
});

test("cutover seam fails closed when audit blocks or second apply is not identical", async () => {
  const audited: string[] = [];
  await assert.rejects(
    () => runRestrictedMigrationOrchestration<SyntheticRun>({
      execute: async () => run(),
      audit: async ({ stage }) => {
        audited.push(stage);
        return { passed: false, blockingReasons: ["audit_control_mismatch"] };
      },
      digest: (value) => value.idempotencyDigest,
    }),
    (error: unknown) => error instanceof RestrictedMigrationOrchestrationError && error.reasons.includes("first_apply_audit_blocked"),
  );
  assert.deepEqual(audited, ["first_apply"]);

  let applyCount = 0;
  await assert.rejects(
    () => runRestrictedMigrationOrchestration<SyntheticRun>({
      execute: async (mode) => mode === "dry_run" ? run() : run(applyCount++ === 0 ? "first" : "different"),
      audit: async () => ({ passed: true }),
      digest: (value) => value.idempotencyDigest,
    }),
    (error: unknown) => error instanceof RestrictedMigrationOrchestrationError && error.reasons.includes("second_run_not_identical"),
  );
});

test("cutover seam passes distinct one-time gates to both real apply runs", async () => {
  const gateNonces: Array<string | undefined> = [];
  const result = await runRestrictedMigrationOrchestration<SyntheticRun>({
    firstApplyGate: { phrase: "APPLY_RENT_OPS_STAGING_ONCE", nonce: "first-apply-nonce" },
    secondApplyGate: { phrase: "APPLY_RENT_OPS_STAGING_ONCE", nonce: "second-apply-nonce" },
    execute: async (mode, _runNumber, context) => {
      if (mode === "apply") gateNonces.push(context?.affirmativeGate?.nonce);
      return run();
    },
    audit: async () => ({ passed: true }),
    digest: (value) => value.idempotencyDigest,
  });
  assert.equal(result.identicalSecondRun, true);
  assert.deepEqual(gateNonces, ["first-apply-nonce", "second-apply-nonce"]);
});

test("real archive orchestration rejects a missing or reused second gate before execution", async () => {
  await assert.rejects(
    () => runRestrictedMigrationArchiveOrchestration({
      archiveRoot: "/tmp/rent-ops-restricted-archive-test",
      firstApplyGate: { phrase: "APPLY_RENT_OPS_STAGING_ONCE", nonce: "first-apply-nonce" },
      audit: async () => ({ passed: true }),
    }),
    (error: unknown) => error instanceof RestrictedMigrationOrchestrationError && error.reasons.includes("second_apply_gate_missing"),
  );
  await assert.rejects(
    () => runRestrictedMigrationArchiveOrchestration({
      archiveRoot: "/tmp/rent-ops-restricted-archive-test",
      firstApplyGate: { phrase: "APPLY_RENT_OPS_STAGING_ONCE", nonce: "same-apply-nonce" },
      secondApplyGate: { phrase: "APPLY_RENT_OPS_STAGING_ONCE", nonce: "same-apply-nonce" },
      audit: async () => ({ passed: true }),
    }),
    (error: unknown) => error instanceof RestrictedMigrationOrchestrationError && error.reasons.includes("second_apply_gate_nonce_reused"),
  );
});

test("archive orchestration wrapper supports injected runner without a database or archive filesystem", async () => {
  const modes: string[] = [];
  const result = await runRestrictedMigrationArchiveOrchestration({
    execute: async (mode) => {
      modes.push(mode);
      return {
        report: { blockingReasons: [] },
        summary: { mode, committed: mode === "apply" },
        ...(mode === "apply" ? { postcommitAudit: { passed: true, blockingReasons: [] } } : {}),
      } as never;
    },
    audit: async () => ({ passed: true }),
    digest: (value) => JSON.stringify(value.report),
  });
  assert.deepEqual(modes, ["dry_run", "apply", "apply"]);
  assert.equal(result.identicalSecondRun, true);
});

test("archive orchestration wrapper requires an archive root when no runner is injected", async () => {
  await assert.rejects(
    () => runRestrictedMigrationArchiveOrchestration({ audit: async () => ({ passed: true }) }),
    (error: unknown) => error instanceof RestrictedMigrationOrchestrationError && error.reasons.includes("restricted_archive_root_missing"),
  );
});

test("default audit rejects a missing artifact-bound context instead of auto-passing", async () => {
  const states = [targetState("empty"), targetState("after-first", 1)];
  let captureCount = 0;
  const executor: RentOpsQueryExecutor = {
    query: async () => ({ rows: [] }),
    transaction: async <T>(work: (executor: RentOpsQueryExecutor) => Promise<T>) => work(executor),
  };
  await assert.rejects(
    () => runRestrictedMigrationArchiveOrchestration({
      archiveRoot: "/private/var/restricted-archive",
      executor,
      execute: async (mode) => ({
        report: { blockingReasons: [], artifactBindingSha256: "a".repeat(64) },
        summary: { mode, committed: mode === "apply" },
        archiveAuditBindingSha256: "b".repeat(64),
        ...(mode === "apply" ? { postcommitAudit: { passed: true, blockingReasons: [] } } : {}),
      } as never),
      firstApplyGate: { phrase: "APPLY_RENT_OPS_STAGING_ONCE", nonce: "default-audit-first" },
      secondApplyGate: { phrase: "APPLY_RENT_OPS_STAGING_ONCE", nonce: "default-audit-second" },
      targetState: {
        executor,
        capture: async () => states[captureCount++]!,
        assertEmpty: () => undefined,
        assertIdentical: () => undefined,
      },
    }),
    (error: unknown) => error instanceof RestrictedMigrationOrchestrationError
      && error.reasons.includes("independent_database_audit_expected_controls_missing")
      && error.restoreRequired?.status === "restore_required",
  );
  assert.equal(captureCount, 2);
});

test("artifact-bound audit rejects a report/context binding mismatch before any database read", async () => {
  let queryCount = 0;
  const result = {
    report: { blockingReasons: [], artifactBindingSha256: "a".repeat(64) },
    archiveAuditBindingSha256: "b".repeat(64),
    databaseAuditContext: {
      asOfDate: "2026-08-17",
      expected: {},
      archiveReceiptSha256: "b".repeat(64),
      artifactBindingSha256: "c".repeat(64),
      migration: {
        version: 6,
        requiredTables: 1,
        checksum: "d".repeat(64),
        migrationChecksums: {},
        migrationChainSha256: "e".repeat(64),
      },
    },
  } as never;
  const decision = await runArtifactBoundDatabaseAudit(
    { stage: "first_apply", result, targetState: targetState("f".repeat(64), 1) },
    { executor: { query: async () => { queryCount += 1; return { rows: [] }; } } },
  );
  assert.equal(decision.passed, false);
  assert.deepEqual(decision.blockingReasons, ["independent_database_audit_artifact_binding_mismatch"]);
  assert.equal(queryCount, 0);
});

test("state-proofed orchestration rejects a preseeded stale target before any run", async () => {
  let executionCount = 0;
  await assert.rejects(
    () => runRestrictedMigrationOrchestration<SyntheticRun>({
      execute: async () => { executionCount += 1; return run(); },
      audit: async () => ({ passed: true }),
      firstApplyGate: { phrase: "APPLY_RENT_OPS_STAGING_ONCE", nonce: "first-stale-nonce" },
      secondApplyGate: { phrase: "APPLY_RENT_OPS_STAGING_ONCE", nonce: "second-stale-nonce" },
      targetState: {
        executor: {} as never,
        capture: async () => targetState("stale", 1),
        assertEmpty: (state) => { if (state.rowCount !== 0) throw Object.assign(new Error("stale"), { reasons: ["target_not_empty"] }); },
      },
    }),
    (error: unknown) => error instanceof RestrictedMigrationOrchestrationError && error.reasons.includes("target_not_empty"),
  );
  assert.equal(executionCount, 0);
});

test("postcommit audit failure emits explicit redacted restore-required evidence", async () => {
  const states = [targetState("empty"), targetState("after-first", 2)];
  let captureCount = 0;
  await assert.rejects(
    () => runRestrictedMigrationOrchestration<SyntheticRun>({
      execute: async () => run(),
      audit: async ({ stage }) => stage === "first_apply" ? { passed: false, blockingReasons: ["audit_control_mismatch"] } : { passed: true },
      firstApplyGate: { phrase: "APPLY_RENT_OPS_STAGING_ONCE", nonce: "first-audit-nonce" },
      secondApplyGate: { phrase: "APPLY_RENT_OPS_STAGING_ONCE", nonce: "second-audit-nonce" },
      targetState: {
        executor: {} as never,
        capture: async () => states[captureCount++]!,
        assertEmpty: () => undefined,
        assertIdentical: () => undefined,
      },
    }),
    (error: unknown) => {
      if (!(error instanceof RestrictedMigrationOrchestrationError)) return false;
      assert.equal(error.restoreRequired?.status, "restore_required");
      assert.equal(error.restoreRequired?.preApplyTablesSha256, "empty");
      assert.equal(error.restoreRequired?.observedTablesSha256, "after-first");
      assert.equal(JSON.stringify(error).includes("after-first"), true);
      return error.reasons.includes("restore_required");
    },
  );
  assert.equal(captureCount, 2);
});

test("second apply requires fresh gate and exact database state even when result summaries match", async () => {
  const states = [targetState("empty"), targetState("after-first", 3), targetState("after-first", 3), targetState("after-second-different", 4)];
  const gateNonces: string[] = [];
  let captureCount = 0;
  await assert.rejects(
    () => runRestrictedMigrationOrchestration<SyntheticRun>({
      execute: async (mode, _runNumber, context) => {
        if (mode === "apply") gateNonces.push(context?.affirmativeGate?.nonce ?? "missing");
        return run("same-result");
      },
      audit: async () => ({ passed: true }),
      firstApplyGate: { phrase: "APPLY_RENT_OPS_STAGING_ONCE", nonce: "first-db-nonce" },
      secondApplyGate: { phrase: "APPLY_RENT_OPS_STAGING_ONCE", nonce: "second-db-nonce" },
      targetState: {
        executor: {} as never,
        capture: async () => states[captureCount++]!,
        assertEmpty: () => undefined,
        assertIdentical: (before, after) => { if (before.tablesSha256 !== after.tablesSha256 || before.rowCount !== after.rowCount) throw Object.assign(new Error("db changed"), { reasons: ["target_state_digest_changed"] }); },
      },
    }),
    (error: unknown) => error instanceof RestrictedMigrationOrchestrationError && error.reasons.includes("restore_required") && error.reasons.includes("target_state_digest_changed"),
  );
  assert.deepEqual(gateNonces, ["first-db-nonce", "second-db-nonce"]);
  assert.equal(captureCount, 4);
});

test("a dropped source cannot leave stale rows after second apply", async () => {
  const states = [targetState("empty"), targetState("after-first", 2), targetState("after-first", 2), targetState("stale-extra", 3)];
  let captureCount = 0;
  await assert.rejects(
    () => runRestrictedMigrationOrchestration<SyntheticRun>({
      execute: async () => run("same-result"),
      audit: async () => ({ passed: true }),
      firstApplyGate: { phrase: "APPLY_RENT_OPS_STAGING_ONCE", nonce: "first-drop-nonce" },
      secondApplyGate: { phrase: "APPLY_RENT_OPS_STAGING_ONCE", nonce: "second-drop-nonce" },
      targetState: {
        executor: {} as never,
        capture: async () => states[captureCount++]!,
        assertEmpty: () => undefined,
        assertIdentical: (before, after) => { if (before.tablesSha256 !== after.tablesSha256) throw Object.assign(new Error("stale"), { reasons: ["target_state_digest_changed", "target_state_row_count_changed"] }); },
      },
    }),
    (error: unknown) => error instanceof RestrictedMigrationOrchestrationError && error.restoreRequired?.status === "restore_required" && error.reasons.includes("target_state_digest_changed"),
  );
});
