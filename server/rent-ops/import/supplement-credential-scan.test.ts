import assert from "node:assert/strict";
import { test } from "node:test";
import { scanSupplementCredentialBoundary } from "./supplement-credential-scan";

test("large archive scans every bounded record and retains credential and depth rejection", () => {
  const rows = Array.from({ length: 22000 }, (_, id) => ({ id, nested: { field: "synthetic", ordinary: "value", more: 1 } }));
  const request = { envelope: { payload: { applications: rows } }, applicationAnswers: rows };
  assert.doesNotThrow(() => scanSupplementCredentialBoundary(request));
  assert.throws(() => scanSupplementCredentialBoundary({ ...request, applicationAnswers: [...rows, { nested: { password: "synthetic" } }] }));
  assert.throws(() => scanSupplementCredentialBoundary({ envelope: { payload: { password: rows } } }));
  assert.throws(() => scanSupplementCredentialBoundary({ ...request, manifest: { nested: { apiKey: "synthetic" } } }));
  const cycle: any = {}; cycle.self = cycle;
  assert.throws(() => scanSupplementCredentialBoundary({ applicationAnswers: [cycle] }));
  const hugeRow = { children: Array.from({ length: 100001 }, () => 1) };
  assert.throws(() => scanSupplementCredentialBoundary({ applicationAnswers: [hugeRow] }));
});
