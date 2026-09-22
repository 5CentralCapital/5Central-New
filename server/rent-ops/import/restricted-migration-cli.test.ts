import assert from "node:assert/strict";
import test from "node:test";
import type { RentOpsQueryExecutor } from "../repositories/postgres";
import { APPLY_RENT_OPS_STAGING_PHRASE } from "./persistence-importer";
import {
  formatRestrictedMigrationError,
  formatRestrictedMigrationOutput,
  parseRestrictedMigrationCliArgs,
  runRestrictedMigrationCli,
} from "./restricted-migration-cli";
import type { RestrictedMigrationRunResult } from "./migration-runner";

const archiveRoot = "/private/var/rent-ops-archive-2026-08-17";

const report: RestrictedMigrationRunResult["report"] = {
  archiveEnvelopeSha256: "a".repeat(64),
  manifestSha256: "b".repeat(64),
  normalizationReportSha256: "c".repeat(64),
  normalizedRowsSha256: "d".repeat(64),
  controlsSha256: "e".repeat(64),
  mappedRowsSha256: "f".repeat(64),
  restrictedRowsSha256: "1".repeat(64),
  artifactBindingSha256: "2".repeat(64),
  normalizerVersion: "rent-manager-normalizer/2026-08-17.1",
  sourceRunId: "rm-run-1",
  rawCollectionCounts: { properties: 2, tenants: 3 },
  normalizedRecordCounts: { properties: 2, people: 3 },
  mappedSourceCounts: { property: 2, person: 3 },
  normalizationExceptionCount: 0,
  mappingWarningCount: 0,
  mappingErrorCount: 0,
  blockingReasons: [],
};

const summary = {
  mode: "dry_run" as const,
  importRunId: "rm-import-run-1",
  sourceManifestHash: "a".repeat(64),
  wouldWrite: false,
  committed: false,
  counts: { properties: 2, units: 4, people: 3 },
  totalsCents: { chargesCents: 1000, paymentsCents: 0 },
  warningCount: 0,
  errorCount: 0,
  blockedReasons: [],
};

function fakeRunResult(): RestrictedMigrationRunResult {
  return { report, summary };
}

test("restricted migration CLI defaults to dry-run and parses only explicit safe controls", () => {
  const args = parseRestrictedMigrationCliArgs(["--archive-root", archiveRoot]);
  assert.equal(args.archiveRoot, archiveRoot);
  assert.equal(args.mode, "dry_run");
  assert.equal(args.importerOptions.mode, "dry_run");
  assert.equal(args.importerOptions.targetClassification, undefined);
  assert.throws(() => parseRestrictedMigrationCliArgs(["--archive-root", archiveRoot, "--database-url", "postgres://secret"]), /unsupported_argument/);
  assert.throws(() => parseRestrictedMigrationCliArgs(["--apply"]), /archive_root_required/);
});

test("dry-run wrapper never creates a database executor and emits only redacted JSON", async () => {
  let createExecutorCalls = 0;
  let receivedExecutor: unknown = "not-checked";
  const args = parseRestrictedMigrationCliArgs(["--archive-root", archiveRoot]);
  const output = await runRestrictedMigrationCli(args, {
    createExecutor: async () => {
      createExecutorCalls += 1;
      throw new Error("database connection must not be attempted in dry-run");
    },
    runArchive: async (options) => {
      receivedExecutor = options.executor;
      return fakeRunResult();
    },
  });
  assert.equal(createExecutorCalls, 0);
  assert.equal(receivedExecutor, undefined);
  assert.equal(output.status, "dry_run_ready");
  assert.equal(output.summary?.wouldWrite, false);
  const serialized = JSON.stringify(output);
  assert.equal(serialized.includes(archiveRoot), false);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("payload"), false);
});

test("dry-run ignores both database environment variables and never loads a database executor", async () => {
  const previousApplicationUrl = process.env.DATABASE_URL;
  const previousRentOpsUrl = process.env.RENT_OPS_DATABASE_URL;
  process.env.DATABASE_URL = "postgres://application-credential-must-not-be-used.invalid/app";
  process.env.RENT_OPS_DATABASE_URL = "postgres://migration-credential-must-not-be-read.invalid/rent_ops";
  try {
    const args = parseRestrictedMigrationCliArgs(["--archive-root", archiveRoot]);
    const result = await runRestrictedMigrationCli(args, {
      runArchive: async (options) => {
        assert.equal(options.executor, undefined);
        return fakeRunResult();
      },
    });
    assert.equal(result.status, "dry_run_ready");
  } finally {
    if (previousApplicationUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousApplicationUrl;
    if (previousRentOpsUrl === undefined) delete process.env.RENT_OPS_DATABASE_URL;
    else process.env.RENT_OPS_DATABASE_URL = previousRentOpsUrl;
  }
});

test("apply never falls back to DATABASE_URL and reports a missing dedicated credential safely", async () => {
  const previousApplicationUrl = process.env.DATABASE_URL;
  const previousRentOpsUrl = process.env.RENT_OPS_DATABASE_URL;
  process.env.DATABASE_URL = "postgres://application-secret.invalid/app";
  delete process.env.RENT_OPS_DATABASE_URL;
  try {
    const args = parseRestrictedMigrationCliArgs(["--archive-root", archiveRoot, "--apply"]);
    await assert.rejects(() => runRestrictedMigrationCli(args), (error: unknown) => {
      assert.equal(error instanceof Error && error.message.includes("application-secret"), false);
      const formatted = JSON.parse(formatRestrictedMigrationError(error)) as { ok: boolean; blockedReasons: string[] };
      assert.equal(formatted.ok, false);
      assert.deepEqual(formatted.blockedReasons, ["dedicated_database_url_missing"]);
      return true;
    });
  } finally {
    if (previousApplicationUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousApplicationUrl;
    if (previousRentOpsUrl === undefined) delete process.env.RENT_OPS_DATABASE_URL;
    else process.env.RENT_OPS_DATABASE_URL = previousRentOpsUrl;
  }
});

test("apply wrapper forwards explicit staging gates and closes the executor", async () => {
  const executor: RentOpsQueryExecutor = { query: async () => ({ rows: [] }) };
  let createExecutorCalls = 0;
  let closeCalls = 0;
  let receivedOptions: Record<string, unknown> | undefined;
  let receivedExecutor: RentOpsQueryExecutor | undefined;
  const args = parseRestrictedMigrationCliArgs([
    "--archive-root", archiveRoot,
    "--apply",
    "--target-classification", "staging",
    "--expected-db-fingerprint", "0f0362269120239d",
    "--forbidden-db-fingerprint", "a4a44f11352d8b2f",
    "--migration-checksum", "d".repeat(64),
    "--rendered-migration-checksum", "d".repeat(64),
    "--backup-attestation-id", "backup-1",
    "--backup-target-fingerprint", "0f0362269120239d",
    "--backup-verified-at", "2026-08-17T00:00:00.000Z",
    "--gate-phrase", APPLY_RENT_OPS_STAGING_PHRASE,
    "--gate-nonce", "nonce-12345678",
    "--second-gate-nonce", "nonce-87654321",
  ]);
  const applyResult: RestrictedMigrationRunResult = {
    report: { ...report },
    summary: { ...summary, mode: "apply", wouldWrite: true, committed: true },
    archiveAuditBindingSha256: "a".repeat(64),
    postcommitAudit: { passed: true, blockingReasons: [] },
  };
  const output = await runRestrictedMigrationCli(args, {
    createExecutor: async () => {
      createExecutorCalls += 1;
      return { executor, close: async () => { closeCalls += 1; } };
    },
    runArchive: async (options) => {
      receivedExecutor = options.executor;
      receivedOptions = options.importerOptions as Record<string, unknown>;
      return applyResult;
    },
    audit: async ({ archiveReceiptSha256 }) => ({ passed: true, independentDatabaseAudit: { passed: true, archiveReceiptSha256: archiveReceiptSha256 ?? "" } }),
  });
  assert.equal(createExecutorCalls, 1);
  assert.equal(closeCalls, 1);
  assert.equal(receivedExecutor, executor);
  assert.equal(receivedOptions?.mode, "apply");
  assert.equal(receivedOptions?.targetClassification, "staging");
  assert.equal(output.status, "committed");
  assert.equal(output.summary?.committed, true);
});

test("apply CLI executes both apply runs with distinct gates before returning the second result", async () => {
  const executor: RentOpsQueryExecutor = { query: async () => ({ rows: [] }) };
  const args = parseRestrictedMigrationCliArgs([
    "--archive-root", archiveRoot,
    "--apply",
    "--gate-phrase", APPLY_RENT_OPS_STAGING_PHRASE,
    "--gate-nonce", "cli-first-nonce",
    "--second-gate-nonce", "cli-second-nonce",
  ]);
  const calls: Array<{ mode: string; nonce?: string }> = [];
  const output = await runRestrictedMigrationCli(args, {
    createExecutor: async () => ({ executor, close: async () => undefined }),
    runArchive: async (options) => {
      calls.push({ mode: options.mode ?? "dry_run", nonce: options.importerOptions?.affirmativeGate?.nonce });
      return { report, summary: { ...summary, mode: options.mode ?? "dry_run", committed: options.mode === "apply", wouldWrite: options.mode === "apply" }, archiveAuditBindingSha256: "a".repeat(64), ...(options.mode === "apply" ? { postcommitAudit: { passed: true, blockingReasons: [] } } : {}) };
    },
    audit: async ({ archiveReceiptSha256 }) => ({ passed: true, independentDatabaseAudit: { passed: true, archiveReceiptSha256: archiveReceiptSha256 ?? "" } }),
  });
  assert.deepEqual(calls, [
    { mode: "dry_run", nonce: undefined },
    { mode: "apply", nonce: "cli-first-nonce" },
    { mode: "apply", nonce: "cli-second-nonce" },
  ]);
  assert.equal(output.status, "committed");
});

test("apply CLI rejects a runner that omits or fails restricted postcommit parity even when DB audit callback passes", async () => {
  const executor: RentOpsQueryExecutor = { query: async () => ({ rows: [] }) };
  const args = parseRestrictedMigrationCliArgs([
    "--archive-root", archiveRoot,
    "--apply",
    "--gate-phrase", APPLY_RENT_OPS_STAGING_PHRASE,
    "--gate-nonce", "parity-first-nonce",
    "--second-gate-nonce", "parity-second-nonce",
  ]);
  await assert.rejects(
    () => runRestrictedMigrationCli(args, {
      createExecutor: async () => ({ executor, close: async () => undefined }),
      runArchive: async (options) => ({
        report,
        summary: { ...summary, mode: options.mode ?? "dry_run", committed: options.mode === "apply", wouldWrite: options.mode === "apply" },
        archiveAuditBindingSha256: "a".repeat(64),
        ...(options.mode === "apply" ? { postcommitAudit: { passed: false, blockingReasons: ["tampered"] } } : {}),
      }),
      audit: async ({ archiveReceiptSha256 }) => ({ passed: true, independentDatabaseAudit: { passed: true, archiveReceiptSha256: archiveReceiptSha256 ?? "" } }),
    }),
    (error: unknown) => error instanceof Error && error.message.includes("restricted_parity_postcommit_audit_missing_or_failed"),
  );
});

test("redacted output and errors do not echo paths, credentials, or arbitrary exception messages", () => {
  const output = formatRestrictedMigrationOutput(fakeRunResult());
  const serialized = JSON.stringify(output);
  assert.equal(serialized.includes(archiveRoot), false);
  assert.equal(serialized.includes("properties"), true);
  assert.equal(serialized.includes("export-envelope"), false);
  assert.equal(formatRestrictedMigrationError(new Error("DATABASE_URL=postgres://secret@private.example/db")).includes("secret"), false);
  assert.match(formatRestrictedMigrationError(new Error("DATABASE_URL=postgres://secret@private.example/db")), /restricted_migration_failed/);
});

test("formatting a blocked artifact returns safe status and reason codes only", () => {
  const blocked = formatRestrictedMigrationOutput({ report: { ...report, blockingReasons: ["application_answers_not_exported", "raw tenant PII must not be logged"] } });
  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.report.blockingReasons, ["application_answers_not_exported", "redacted_reason"]);
  assert.equal("summary" in blocked, false);
});
