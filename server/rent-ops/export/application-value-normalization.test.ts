import assert from "node:assert/strict";
import { test } from "node:test";
import { createApplicationAnswerAttestation, normalizeRentManagerExport } from "./normalizer";

test("documented ApplicationValue survives verified answer normalization without interpreting field labels", () => {
  const raw = { ProspectApplicationDetailID: 9, sourceId: "9", ProspectApplicationID: 1, ApplicationFieldID: 7, ApplicationValue: "synthetic-value" };
  const result = normalizeRentManagerExport({ applications: [{ ProspectApplicationID: 1 }], applicationAnswerRecords: [{ ...raw, attestation: createApplicationAnswerAttestation(raw, "synthetic-run") }] }, { sourceRunId: "synthetic-run" });
  const answers = result.input.applicationAnswerRecords as Array<Record<string, unknown>>;
  assert.equal(answers.length, 1);
  assert.equal(answers[0].answer, "synthetic-value");
  assert.equal(answers[0].ApplicationValue, "synthetic-value");
  assert.equal(answers[0].fieldPath, undefined);
});
