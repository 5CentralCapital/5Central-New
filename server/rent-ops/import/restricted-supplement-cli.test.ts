import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatRestrictedSupplementError,
  formatRestrictedSupplementOutput,
  parseRestrictedSupplementCliArgs,
} from "./restricted-supplement-cli";
import { RestrictedSupplementDerivativeArchiveError } from "./restricted-supplement-archive";

const HASH = "a".repeat(64);

test("private supplement CLI parses explicit paths", () => {
  assert.deepEqual(
    parseRestrictedSupplementCliArgs(["--archive-root", "/private/synthetic/source", "--derivative-root=/private/synthetic/derivative", "--supplement-package", "/private/synthetic/package.json"]),
    { archiveRoot: "/private/synthetic/source", derivativeRoot: "/private/synthetic/derivative", supplementPackagePath: "/private/synthetic/package.json" },
  );
});

test("CLI success and error output are redacted summaries", () => {
  const output = formatRestrictedSupplementOutput({
    status: "written",
    report: {
      version: "rm-restricted-supplement/v1",
      sourceRunId: "synthetic-run",
      originalEnvelopeSha256: HASH,
      originalManifestSha256: HASH,
      derivativeEnvelopeSha256: HASH,
      derivativeManifestSha256: HASH,
      supplementSha256: HASH,
      attestationSha256: HASH,
      countsAdded: { application_answers: 1, hap_subsidies: 0, document_binaries: 0 },
      sourceIdHashes: { application_answers: ["id_synthetic"], hap_subsidies: [], document_binaries: [] },
      operatorReferenceHash: HASH,
      verifiedAt: "2026-08-17T12:00:00.000Z",
      manifestComplete: true,
      exceptionsRemoved: 0,
      removedExceptionHashes: [],
    },
    provenance: {
      version: "rm-restricted-supplement-derivative/v1",
      sourceRunId: "synthetic-run",
      createdAt: "2026-08-17T12:00:00.000Z",
      parentEnvelopeSha256: HASH,
      parentManifestSha256: HASH,
      supplementSha256: HASH,
      attestationSha256: HASH,
      derivativeEnvelopeSha256: HASH,
      derivativeManifestSha256: HASH,
      approval: { approvalId: "synthetic-approval", approvedAt: "2026-08-17T12:00:00.000Z", operatorReferenceHash: HASH, gate: "restricted_supplement_apply" },
      countsAdded: { application_answers: 1, hap_subsidies: 0, document_binaries: 0 },
      exceptionsRemoved: 0,
      removedExceptionHashes: [],
    },
    provenanceSha256: HASH,
    derivativeRootHash: HASH,
  });
  const outputText = JSON.stringify(output);
  assert.equal(outputText.includes("synthetic restricted value"), false);
  assert.equal(outputText.includes("operator:synthetic"), false);
  assert.equal(outputText.includes("/private/synthetic"), false);
  assert.equal(output.status, "written");
  const errorText = formatRestrictedSupplementError(new RestrictedSupplementDerivativeArchiveError(["bad PII value", "safe_reason"]));
  assert.equal(errorText.includes("bad PII value"), false);
  assert.equal(errorText.includes("safe_reason"), true);
});
