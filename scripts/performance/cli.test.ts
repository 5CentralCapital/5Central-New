import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runPerformanceCli } from "./cli.ts";

test("release check requires an external trusted coverage inventory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "r-ops-performance-cli-"));
  try {
    const inputPath = join(directory, "evidence.json");
    const outputPath = join(directory, "evaluation.json");
    await writeFile(inputPath, JSON.stringify({
      schema: "r-ops.performance-evidence.v1",
      contractVersion: "2026-09-20.t03.v1",
      buildIdentity: "test-build",
      capturedAt: "2026-09-21T12:00:00.000Z",
      coverage: [],
      measurements: [],
    }));
    const exitCode = await runPerformanceCli("check", ["--input", inputPath, "--out", outputPath]);
    const result = JSON.parse(await readFile(outputPath, "utf8")) as { mode: string; releaseReady: boolean; ok: boolean; issues: Array<{ code: string }> };
    assert.equal(exitCode, 2);
    assert.equal(result.mode, "release");
    assert.equal(result.releaseReady, false);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === "invalid_evidence"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the evaluation is never written over the evidence file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "r-ops-performance-cli-"));
  try {
    const inputPath = join(directory, "evidence.json");
    const evidence = JSON.stringify({ schema: "r-ops.performance-evidence.v1", coverage: [], measurements: [] });
    await writeFile(inputPath, evidence);
    const exitCode = await runPerformanceCli("report", ["--input", inputPath, "--out", join(directory, ".", "evidence.json")]);
    assert.equal(exitCode, 2);
    assert.equal(await readFile(inputPath, "utf8"), evidence);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
