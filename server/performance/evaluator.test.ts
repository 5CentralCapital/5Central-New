import assert from "node:assert/strict";
import test from "node:test";
import {
  PERFORMANCE_CONTRACT_VERSION,
  PERFORMANCE_COVERAGE_SCHEMA,
  PERFORMANCE_EVIDENCE_SCHEMA,
  PERFORMANCE_CONTRACT,
  performanceGroupKey,
  type PerformanceBudget,
  type PerformanceContract,
  type PerformanceCoverage,
  type PerformanceEvidence,
  type PerformanceMeasurement,
} from "../../shared/performance/contracts.ts";
import { validatePerformanceEvidence } from "../../shared/performance/validation.ts";
import { evaluatePerformanceEvidence, nearestRankPercentile } from "./evaluator.ts";

const baseCoverage = (overrides: Partial<PerformanceCoverage> = {}): PerformanceCoverage => ({
  budgetId: "TEST",
  metric: "test_latency",
  surface: "browser",
  caseId: "/ops/overview",
  device: "desktop-floor",
  network: "office",
  dataScale: "baseline",
  cacheState: "warm",
  appearance: "solid",
  providerState: "healthy",
  ...overrides,
});

const measurement = (coverage: PerformanceCoverage, index: number, value: number, overrides: Partial<PerformanceMeasurement> = {}): PerformanceMeasurement => ({
  ...coverage,
  measurementId: `${coverage.caseId}-${index}`,
  sampleId: `sample-${index}`,
  runId: `run-${Math.floor(index / 10)}`,
  value,
  unit: "ms",
  status: "ok",
  source: "browser_harness",
  unexpectedError: false,
  timeout: false,
  correctnessFailure: false,
  ...overrides,
});

const contractWith = (budget: PerformanceBudget): PerformanceContract => ({
  ...PERFORMANCE_CONTRACT,
  budgets: [budget],
  minimumSamples: { browser: 1, service: 1, native: 1, job: 1 },
  minimumIndependentRuns: 1,
});

const evidenceFor = (coverage: PerformanceCoverage, measurements: readonly PerformanceMeasurement[], regressionBaselines: PerformanceEvidence["regressionBaselines"] = []): PerformanceEvidence => ({
  schema: PERFORMANCE_EVIDENCE_SCHEMA,
  contractVersion: PERFORMANCE_CONTRACT_VERSION,
  buildIdentity: "test-runtime-build",
  capturedAt: "2026-09-21T12:00:00.000Z",
  coverage: [coverage],
  measurements,
  regressionBaselines,
});

const inventoryFor = (coverage: readonly PerformanceCoverage[]) => ({
  schema: PERFORMANCE_COVERAGE_SCHEMA,
  contractVersion: PERFORMANCE_CONTRACT_VERSION,
  inventoryId: "trusted-test-inventory",
  coverage,
});

test("nearest-rank percentiles preserve exact boundary values", () => {
  assert.equal(nearestRankPercentile([100, 100, 100, 100], 75), 100);
  assert.equal(nearestRankPercentile([1, 2, 3, 4], 75), 3);
  assert.equal(nearestRankPercentile([1, 2, 3, 4], 100), 4);
});

test("a hidden slow route is evaluated when it is declared in coverage", () => {
  const fast = baseCoverage({ caseId: "/fast" });
  const hidden = baseCoverage({ caseId: "/hidden-slow" });
  const budget: PerformanceBudget = { id: "TEST", metric: "test_latency", percentile: 95, maximum: 100, unit: "ms", surface: "browser", kind: "standard", scope: "test" };
  const evidence = { ...evidenceFor(fast, [measurement(fast, 1, 50)]), coverage: [fast, hidden], measurements: [measurement(fast, 1, 50), measurement(hidden, 1, 250)] };
  const result = evaluatePerformanceEvidence(evidence, { contract: contractWith(budget) });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "threshold_failure" && issue.caseId === "/hidden-slow"));
  assert.equal(result.groups.find((group) => group.caseId === "/fast")?.passed, true);
  assert.equal(result.groups.find((group) => group.caseId === "/hidden-slow")?.passed, false);
});

test("missing route coverage fails closed", () => {
  const present = baseCoverage({ caseId: "/present" });
  const missing = baseCoverage({ caseId: "/missing" });
  const budget: PerformanceBudget = { id: "TEST", metric: "test_latency", percentile: 95, maximum: 100, unit: "ms", surface: "browser", kind: "standard", scope: "test" };
  const result = evaluatePerformanceEvidence({ ...evidenceFor(present, [measurement(present, 1, 50)]), coverage: [present, missing] }, { contract: contractWith(budget) });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "missing_coverage" && issue.caseId === "/missing"));
});

test("malformed, nonfinite, negative and unit-test evidence is rejected", () => {
  const coverage = baseCoverage();
  const malformed = {
    schema: PERFORMANCE_EVIDENCE_SCHEMA,
    contractVersion: PERFORMANCE_CONTRACT_VERSION,
    buildIdentity: "test",
    capturedAt: "2026-09-21T12:00:00.000Z",
    coverage: [coverage],
    measurements: [
      measurement(coverage, 1, Number.NaN),
      measurement(coverage, 2, Number.POSITIVE_INFINITY),
      measurement(coverage, 3, -1),
      measurement(coverage, 4, 20, { source: "unit_test" as never }),
    ],
  };
  const validation = validatePerformanceEvidence(malformed);
  assert.equal(validation.ok, false);
  assert.ok(validation.issues.some((issue) => issue.path.endsWith(".value")));
  assert.ok(validation.issues.some((issue) => issue.path.endsWith(".source")));
});

test("critical browser/service evidence requires sample and run minimums", () => {
  const coverage = baseCoverage({ minimumSamples: 3, minimumRuns: 2 });
  const budget: PerformanceBudget = { id: "TEST", metric: "test_latency", percentile: 95, maximum: 100, unit: "ms", surface: "browser", kind: "standard", scope: "test" };
  const result = evaluatePerformanceEvidence(evidenceFor(coverage, [measurement(coverage, 1, 50)]), { contract: contractWith(budget) });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "insufficient_samples"));
  assert.ok(result.issues.some((issue) => issue.code === "insufficient_runs"));
});

test("default contract keeps native launches at 30 and critical browser samples at 100", () => {
  const nativeCoverage = baseCoverage({
    budgetId: "PERF10.cold",
    metric: "signed_mac_startup_to_usable_authorized_view",
    surface: "native",
    caseId: "mac-startup",
  });
  const browserCoverage = baseCoverage({
    budgetId: "PERF04",
    metric: "cached_navigation_to_usable_content",
    caseId: "/ops/overview",
  });
  const nativeResult = evaluatePerformanceEvidence(evidenceFor(nativeCoverage, [measurement(nativeCoverage, 1, 500, { source: "native_harness" })]));
  const browserResult = evaluatePerformanceEvidence(evidenceFor(browserCoverage, [measurement(browserCoverage, 1, 500)]));
  assert.ok(nativeResult.issues.some((issue) => issue.code === "insufficient_samples"));
  assert.ok(nativeResult.issues.some((issue) => issue.code === "insufficient_runs"));
  assert.ok(browserResult.issues.some((issue) => issue.code === "insufficient_samples"));
  assert.ok(browserResult.issues.some((issue) => issue.code === "insufficient_runs"));
});

test("evidence and evaluator options can only raise approved sample and run floors", () => {
  const coverage = baseCoverage({ minimumSamples: 1, minimumRuns: 1 });
  const budget: PerformanceBudget = { id: "TEST", metric: "test_latency", percentile: 95, maximum: 100, unit: "ms", surface: "browser", kind: "standard", scope: "test" };
  const contract: PerformanceContract = {
    ...contractWith(budget),
    minimumSamples: { browser: 5, service: 1, native: 1, job: 1 },
    minimumIndependentRuns: 3,
    largeWorkloadGroups: [],
  };
  const result = evaluatePerformanceEvidence(evidenceFor(coverage, [measurement(coverage, 1, 50)]), {
    contract,
    minimumSamples: { browser: 1 },
    minimumIndependentRuns: 1,
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "insufficient_samples" && issue.message.includes("5 are required")));
  assert.ok(result.issues.some((issue) => issue.code === "insufficient_runs" && issue.message.includes("3 are required")));
});

test("invalid evaluator minimums fail before they can alter acceptance", () => {
  const coverage = baseCoverage();
  const budget: PerformanceBudget = { id: "TEST", metric: "test_latency", percentile: 95, maximum: 100, unit: "ms", surface: "browser", kind: "standard", scope: "test" };
  const result = evaluatePerformanceEvidence(evidenceFor(coverage, [measurement(coverage, 1, 50)]), {
    contract: contractWith(budget),
    minimumSamples: { browser: Number.NaN },
    minimumIndependentRuns: -1,
  });
  assert.equal(result.ok, false);
  assert.equal(result.groups.length, 0);
  assert.equal(result.issues.filter((issue) => issue.code === "invalid_evidence").length, 2);
});

test("release mode compares evidence with a separately supplied trusted inventory", () => {
  const present = baseCoverage({ caseId: "/present" });
  const missing = baseCoverage({ caseId: "/missing" });
  const extra = baseCoverage({ caseId: "/extra" });
  const budget: PerformanceBudget = { id: "TEST", metric: "test_latency", percentile: 95, maximum: 100, unit: "ms", surface: "browser", kind: "standard", scope: "test" };
  const contract: PerformanceContract = { ...contractWith(budget), largeWorkloadGroups: [] };
  const result = evaluatePerformanceEvidence(
    { ...evidenceFor(present, [measurement(present, 1, 50)]), coverage: [present, extra] },
    { contract, releaseMode: true, requiredCoverage: inventoryFor([present, missing]) },
  );
  assert.equal(result.mode, "release");
  assert.equal(result.releaseReady, false);
  assert.ok(result.issues.some((issue) => issue.code === "missing_coverage" && issue.caseId === "/missing"));
  assert.ok(result.issues.some((issue) => issue.code === "unexpected_coverage" && issue.caseId === "/extra"));
});

test("release mode without trusted inventory is global failure and no group passes", () => {
  const coverage = baseCoverage();
  const budget: PerformanceBudget = { id: "TEST", metric: "test_latency", percentile: 95, maximum: 100, unit: "ms", surface: "browser", kind: "standard", scope: "test" };
  const contract: PerformanceContract = { ...contractWith(budget), largeWorkloadGroups: [] };
  const result = evaluatePerformanceEvidence(evidenceFor(coverage, [measurement(coverage, 1, 50)]), { contract, releaseMode: true });
  assert.equal(result.releaseReady, false);
  assert.ok(result.issues.some((issue) => issue.code === "coverage_not_declared" && issue.groupKey === undefined));
  assert.equal(result.groups[0]?.passed, false);
});

test("regression comparison applies the greater of ten percent and 100 ms", () => {
  const coverage = baseCoverage();
  const budget: PerformanceBudget = { id: "TEST", metric: "test_latency", percentile: 95, maximum: 2000, unit: "ms", surface: "browser", kind: "standard", scope: "test" };
  const groupKey = performanceGroupKey(coverage);
  const result = evaluatePerformanceEvidence(evidenceFor(coverage, [measurement(coverage, 1, 1111)], [{ groupKey, percentile: 95, value: 1000, unit: "ms", acceptedBuild: "accepted-build" }]), { contract: contractWith(budget) });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "regression_failure"));
});

test("release mode requires finite PERF13 budgets and coverage for every workload group", () => {
  const workloadCoverage = PERFORMANCE_CONTRACT.largeWorkloadGroups.map((caseId) => baseCoverage({
    budgetId: "PERF13",
    metric: "large_workload_completion",
    surface: "job",
    caseId,
  }));
  const first = workloadCoverage[0] as PerformanceCoverage;
  const jobMeasurement = measurement(first, 1, 100, { source: "job_harness" });
  const result = evaluatePerformanceEvidence(
    evidenceFor(first, [jobMeasurement]),
    { releaseMode: true, requiredCoverage: inventoryFor(workloadCoverage) },
  );
  assert.equal(result.releaseReady, false);
  assert.ok(result.issues.filter((issue) => issue.code === "unassigned_large_workload_budget").length >= PERFORMANCE_CONTRACT.largeWorkloadGroups.length);
  assert.ok(result.issues.some((issue) => issue.code === "missing_coverage" && issue.caseId === PERFORMANCE_CONTRACT.largeWorkloadGroups[5]));
});

test("failure flags remain in the result and block acceptance", () => {
  const coverage = baseCoverage();
  const budget: PerformanceBudget = { id: "TEST", metric: "test_latency", percentile: 95, maximum: 100, unit: "ms", surface: "browser", kind: "standard", scope: "test" };
  const result = evaluatePerformanceEvidence(evidenceFor(coverage, [measurement(coverage, 1, 50, { status: "failed", unexpectedError: true, timeout: true, correctnessFailure: true })]), { contract: contractWith(budget) });
  assert.equal(result.ok, false);
  assert.equal(result.retainedFailures.failedSamples, 1);
  assert.equal(result.retainedFailures.unexpectedErrors, 1);
  assert.equal(result.retainedFailures.timeouts, 1);
  assert.equal(result.retainedFailures.correctnessFailures, 1);
  assert.ok(result.issues.some((issue) => issue.code === "failed_measurement"));
  assert.ok(result.issues.some((issue) => issue.code === "timeout"));
  assert.ok(result.issues.some((issue) => issue.code === "correctness_failure"));
});

test("retained failure counts include undeclared measurement groups", () => {
  const declared = baseCoverage({ caseId: "/declared" });
  const undeclared = baseCoverage({ caseId: "/undeclared" });
  const budget: PerformanceBudget = { id: "TEST", metric: "test_latency", percentile: 95, maximum: 100, unit: "ms", surface: "browser", kind: "standard", scope: "test" };
  const contract: PerformanceContract = { ...contractWith(budget), largeWorkloadGroups: [] };
  const result = evaluatePerformanceEvidence({
    ...evidenceFor(declared, [measurement(declared, 1, 50)]),
    measurements: [
      measurement(declared, 1, 50),
      measurement(undeclared, 2, 50, { status: "failed", unexpectedError: true, timeout: true, correctnessFailure: true }),
    ],
  }, { contract });
  assert.equal(result.ok, false);
  assert.equal(result.retainedFailures.failedSamples, 1);
  assert.equal(result.retainedFailures.unexpectedErrors, 1);
  assert.equal(result.retainedFailures.timeouts, 1);
  assert.equal(result.retainedFailures.correctnessFailures, 1);
  assert.equal(result.groups.find((group) => group.caseId === "/undeclared")?.passed, false);
});

test("cold and warm cohorts remain separate groups", () => {
  const cold = baseCoverage({ cacheState: "cold" });
  const warm = baseCoverage({ cacheState: "warm" });
  const budget: PerformanceBudget = { id: "TEST", metric: "test_latency", percentile: 95, maximum: 100, unit: "ms", surface: "browser", kind: "standard", scope: "test" };
  const result = evaluatePerformanceEvidence({ ...evidenceFor(cold, [measurement(cold, 1, 50)]), coverage: [cold, warm], measurements: [measurement(cold, 1, 50), measurement(warm, 2, 75)] }, { contract: contractWith(budget) });
  assert.equal(result.mode, "diagnostic");
  assert.equal(result.releaseReady, false);
  assert.equal(result.groups.filter((group) => group.expected).length, 2);
  assert.equal(result.groups.find((group) => group.cacheState === "cold")?.evaluatedPercentile, 50);
  assert.equal(result.groups.find((group) => group.cacheState === "warm")?.evaluatedPercentile, 75);
});
