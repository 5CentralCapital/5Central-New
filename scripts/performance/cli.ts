import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { evaluatePerformanceEvidence } from "../../server/performance/evaluator.ts";
import type { PerformanceCoverageInventory } from "../../shared/performance/contracts.ts";

export type PerformanceCliMode = "report" | "check";

const usage = "Usage: report.ts --input <evidence.json> --out <evaluation.json> [--coverage <trusted-coverage-inventory.json>] | check.ts --input <evidence.json> --out <evaluation.json> --coverage <trusted-coverage-inventory.json>";

const parseArguments = (mode: PerformanceCliMode, argv: readonly string[]): { input?: string; out?: string; coverage?: string; error?: string } => {
  let input: string | undefined;
  let out: string | undefined;
  let coverage: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input") {
      input = argv[index + 1];
      index += 1;
    } else if (argument === "--out") {
      out = argv[index + 1];
      index += 1;
    } else if (argument === "--coverage") {
      coverage = argv[index + 1];
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      return { error: usage };
    } else {
      return { error: `Unknown argument: ${argument}. ${usage}` };
    }
  }
  if (!input || !out) return { error: usage, input, out, coverage };
  if (mode === "check" && !coverage) return { error: "Check mode requires --coverage <trusted-coverage-inventory.json>.", input, out, coverage };
  return { input, out, coverage };
};

const writeResult = async (path: string, result: unknown): Promise<void> => {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(result, null, 2)}\n`, "utf8");
};

const invalidCliResult = (message: string, inputSha256?: string, cliMode: PerformanceCliMode = "report"): Record<string, unknown> => ({
  schema: "r-ops.performance-evaluation.v1",
  mode: cliMode === "check" ? "release" : "diagnostic",
  releaseReady: false,
  contractVersion: "unknown",
  buildIdentity: "invalid-evidence",
  capturedAt: "",
  generatedAt: new Date().toISOString(),
  ok: false,
  groups: [],
  issues: [{ code: "invalid_evidence", severity: "error", message }],
  counts: {
    expectedCoverage: 0,
    evaluatedCoverage: 0,
    missingCoverage: 0,
    unexpectedCoverage: 0,
    validationIssues: 1,
  },
  retainedFailures: {
    failedSamples: 0,
    unexpectedErrors: 0,
    timeouts: 0,
    correctnessFailures: 0,
  },
  ...(inputSha256 ? { inputSha256 } : {}),
});

/**
 * Fail-closed report/check entrypoint.  Both modes always write a complete
 * machine-readable evaluation; `check` is intended for CI and exits non-zero
 * for any contract failure.  Report mode also exits non-zero because a report
 * with missing or invalid coverage must never be mistaken for acceptance.
 */
export const runPerformanceCli = async (mode: PerformanceCliMode, argv = process.argv.slice(2)): Promise<number> => {
  const parsedArguments = parseArguments(mode, argv);
  if (parsedArguments.error) {
    if (parsedArguments.out) {
      await writeResult(parsedArguments.out, invalidCliResult(parsedArguments.error, undefined, mode));
    }
    process.stderr.write(`${parsedArguments.error}\n`);
    return 2;
  }
  const inputPath = resolve(parsedArguments.input as string);
  const outputPath = resolve(parsedArguments.out as string);
  const coveragePath = parsedArguments.coverage ? resolve(parsedArguments.coverage) : undefined;
  let result: Record<string, unknown>;
  try {
    const inputBytes = await readFile(inputPath);
    const inputSha256 = createHash("sha256").update(inputBytes).digest("hex");
    let input: unknown;
    try {
      input = JSON.parse(inputBytes.toString("utf8")) as unknown;
    } catch (error) {
      result = invalidCliResult(`Evidence is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, inputSha256, mode);
      await writeResult(outputPath, result);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return 1;
    }
    let requiredCoverage: PerformanceCoverageInventory | undefined;
    let coverageSha256: string | undefined;
    if (coveragePath) {
      let coverageBytes: Buffer;
      try {
        coverageBytes = await readFile(coveragePath);
        coverageSha256 = createHash("sha256").update(coverageBytes).digest("hex");
        requiredCoverage = JSON.parse(coverageBytes.toString("utf8")) as PerformanceCoverageInventory;
      } catch (error) {
        result = invalidCliResult(`Coverage inventory is unavailable or not valid JSON: ${error instanceof Error ? error.message : String(error)}`, inputSha256, mode);
        await writeResult(outputPath, result);
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return 1;
      }
    }
    result = {
      ...evaluatePerformanceEvidence(input, {
        releaseMode: mode === "check",
        requiredCoverage,
      }),
      inputSha256,
      ...(coverageSha256 ? { coverageSha256 } : {}),
    };
  } catch (error) {
    result = invalidCliResult(`Unable to read evidence: ${error instanceof Error ? error.message : String(error)}`, undefined, mode);
  }
  await writeResult(outputPath, result);
  process.stdout.write(`${JSON.stringify({ mode, ok: result.ok, output: outputPath })}\n`);
  return result.ok === true ? 0 : 1;
};
