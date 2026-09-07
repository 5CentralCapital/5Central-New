import assert from "node:assert/strict";
import test from "node:test";
import {
  APPLY_RENT_OPS_STAGING_PHRASE,
  type PersistenceImportInput,
  type PersistenceImportSummary,
  type PersistenceImporterOptions,
  type PersistenceImporter,
} from "./persistence-importer";
import {
  formatImportSummary,
  parseImportCliArgs,
  runImportCli,
  validateImportCliInput,
} from "./import-cli";

const safeSummary: PersistenceImportSummary = {
  mode: "dry_run",
  importRunId: "rm-import:2026-08-16T12:00:00.000Z",
  sourceManifestHash: "a".repeat(64),
  wouldWrite: false,
  committed: false,
  counts: {
    properties: 1,
    units: 1,
    people: 1,
    applications: 0,
    tenancies: 1,
    householdMemberships: 0,
    leaseTerms: 1,
    recurringSchedules: 1,
    ledgerTransactions: 2,
    paymentAllocations: 0,
    securityDeposits: 0,
    subsidyContracts: 0,
    applicationHouseholdMembers: 0,
    applicationRequirements: 0,
    documents: 0,
    activityEvents: 0,
    sourceRecords: 8,
    importRuns: 1,
  },
  totalsCents: {
    chargesCents: 85000,
    paymentsCents: 85000,
    creditsCents: 0,
    allocationsCents: 0,
    depositsCents: 0,
    hapAgencyObligationCents: 0,
    hapTenantObligationCents: 0,
    netLedgerCents: 0,
    netLedgerBalanceCents: 0,
  },
  warningCount: 0,
  errorCount: 0,
  blockedReasons: [],
};

test("CLI defaults to dry-run and parses explicit apply controls without discovering credentials", () => {
  const args = parseImportCliArgs(["--input", "mapped.json"]);
  assert.equal(args.mode, "dry_run");
  assert.equal(args.importerOptions.mode, "dry_run");
  assert.equal(args.importerOptions.forbiddenDatabaseFingerprints, undefined);

  const apply = parseImportCliArgs([
    "--input=mapped.json", "--apply", "--target-classification=staging",
    "--expected-db-fingerprint=0f0362269120239d",
    "--forbidden-db-fingerprint=d111111111111111",
    "--forbidden-db-fingerprint=a4a44f11352d8b2f",
    "--migration-checksum", "b".repeat(64), "--rendered-migration-checksum", "b".repeat(64),
    "--backup-attestation-id", "backup-1", "--backup-target-fingerprint", "0f0362269120239d",
    "--backup-verified-at", "2026-08-16T12:00:00.000Z", "--gate-phrase", APPLY_RENT_OPS_STAGING_PHRASE,
    "--gate-nonce", "nonce-12345678",
  ]);
  assert.equal(apply.mode, "apply");
  assert.deepEqual(apply.importerOptions.forbiddenDatabaseFingerprints, ["d111111111111111", "a4a44f11352d8b2f"]);
  assert.equal(apply.importerOptions.affirmativeGate?.phrase, APPLY_RENT_OPS_STAGING_PHRASE);
});

test("CLI input boundary accepts mapped results and normalized raw/envelope inputs but rejects credential-shaped fields", () => {
  assert.deepEqual(validateImportCliInput({ properties: [] }), { properties: [] });
  assert.deepEqual(validateImportCliInput({ payload: { properties: [] }, sourceManifestHash: "a".repeat(64) }), { payload: { properties: [] }, sourceManifestHash: "a".repeat(64) });
  const approvedArtifact = {
    artifactType: "approved-rm-normalizer/v1",
    normalizedResult: { snapshot: {}, sourceRecords: [], importRun: {}, exceptions: [] },
    restrictedSourceInput: { version: "rm-export/v2", runId: "synthetic", source: { system: "rent_manager", readOnly: true }, createdAt: "2026-08-17T00:00:00.000Z", payload: { properties: [], contacts: [], credits: [], webUserAccounts: [], applicationAnswerRecords: [], interestedRentals: [], applicationSettings: [] }, documentBinaries: [], sourceManifestHash: "a".repeat(64) },
    controls: {},
    provenance: { archiveEnvelopeSha256: "a".repeat(64), manifestSha256: "b".repeat(64), normalizerVersion: "synthetic/v1", normalizationReportSha256: "c".repeat(64), sourceRunId: "synthetic", registryHash: "d".repeat(64) },
  };
  assert.deepEqual(validateImportCliInput(approvedArtifact), approvedArtifact);
  assert.throws(() => validateImportCliInput({ properties: [], password: "not-accepted" }), /restricted_credential_field/);
  assert.throws(() => validateImportCliInput({ arbitrary: "raw" }), /import_input_invalid/);
});

test("CLI invokes only injected loader/importer/executor and preserves dry-run zero-write intent", async () => {
  const input: PersistenceImportInput = { properties: [] };
  const calls: { path?: string; executor?: unknown; options?: PersistenceImporterOptions } = {};
  const importer = {
    run: async (received: PersistenceImportInput, executor: unknown, options: PersistenceImporterOptions) => {
      assert.deepEqual(received, input);
      calls.executor = executor;
      calls.options = options;
      return safeSummary;
    },
  } as unknown as PersistenceImporter;
  const injectedExecutor = { query: async () => ({ rows: [] }) };
  const restrictedSourcePayloadWriter = async (): Promise<void> => undefined;
  const result = await runImportCli(
    parseImportCliArgs(["--input", "archive-envelope.json"]),
    {
      loadResult: async (path) => { calls.path = path; return input; },
      executor: injectedExecutor,
      importer,
      restrictedSourcePayloadWriter,
    },
  );
  assert.equal(calls.path, "archive-envelope.json");
  assert.equal(calls.executor, injectedExecutor);
  assert.equal(calls.options?.mode, "dry_run");
  assert.equal(calls.options?.restrictedSourcePayloadWriter, restrictedSourcePayloadWriter);
  assert.equal(result.wouldWrite, false);
  assert.equal(result.committed, false);
});

test("CLI summary contains only safe hashes, counts, cents, and codes", () => {
  const formatted = formatImportSummary({
    ...safeSummary,
    blockedReasons: ["database_fingerprint_mismatch", "https://private.example/name@example.com"],
    sourceManifestHash: "https://private.example/archive",
    importRunId: "Resident Name <name@example.com>",
  });
  assert.equal(formatted.includes("private.example"), false);
  assert.equal(formatted.includes("name@example.com"), false);
  assert.equal(formatted.includes("Resident Name"), false);
  assert.match(formatted, /"chargesCents": 85000/);
  assert.match(formatted, /database_fingerprint_mismatch/);
});
