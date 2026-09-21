import {
  PERFORMANCE_EVALUATION_SCHEMA,
  PERFORMANCE_CONTRACT,
  performanceGroupKey,
  type PerformanceBudget,
  type PerformanceContract,
  type PerformanceCoverage,
  type PerformanceCoverageInventory,
  type PerformanceEvidence,
  type PerformanceEvaluation,
  type PerformanceGroupResult,
  type PerformanceIssue,
  type PerformanceMeasurement,
  type PerformanceRegressionBaseline,
  type PerformanceSurface,
} from "../../shared/performance/contracts.ts";
import { validatePerformanceContract, validatePerformanceEvidence, validatePerformanceCoverage, validatePerformanceCoverageInventory, type PerformanceValidationIssue } from "../../shared/performance/validation.ts";

export interface PerformanceEvaluationOptions {
  contract?: PerformanceContract;
  minimumSamples?: Partial<Record<PerformanceSurface, number>>;
  minimumIndependentRuns?: number;
  /** Supplied by a trusted route/workload inventory, never from measured evidence. */
  requiredCoverage?: readonly PerformanceCoverage[] | PerformanceCoverageInventory;
  /** Release mode requires requiredCoverage and all contract workload groups. */
  releaseMode?: boolean;
  generatedAt?: string;
}

const defaultGeneratedAt = (): string => new Date().toISOString();

const asIssue = (validationIssue: PerformanceValidationIssue): PerformanceIssue => ({
  code: "invalid_evidence",
  severity: "error",
  message: `${validationIssue.path}: ${validationIssue.message}`,
});

const evaluationMode = (options: PerformanceEvaluationOptions): "diagnostic" | "release" => options.releaseMode === true ? "release" : "diagnostic";

const isFinitePositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;

const validateOptions = (options: PerformanceEvaluationOptions): PerformanceIssue[] => {
  const issues: PerformanceIssue[] = [];
  if (options.minimumSamples !== undefined) {
    if (typeof options.minimumSamples !== "object" || options.minimumSamples === null || Array.isArray(options.minimumSamples)) {
      issues.push({ code: "invalid_evidence", severity: "error", message: "Evaluation minimumSamples must be an object." });
    } else {
      for (const [surface, value] of Object.entries(options.minimumSamples)) {
        if (!["browser", "service", "native", "job"].includes(surface) || !isFinitePositiveInteger(value)) {
          issues.push({ code: "invalid_evidence", severity: "error", message: `Evaluation minimumSamples.${surface} must be a finite positive integer for a known surface.` });
        }
      }
    }
  }
  if (options.minimumIndependentRuns !== undefined && !isFinitePositiveInteger(options.minimumIndependentRuns)) {
    issues.push({ code: "invalid_evidence", severity: "error", message: "Evaluation minimumIndependentRuns must be a finite positive integer." });
  }
  if (options.generatedAt !== undefined && (typeof options.generatedAt !== "string" || Number.isNaN(Date.parse(options.generatedAt)))) {
    issues.push({ code: "invalid_evidence", severity: "error", message: "Evaluation generatedAt must be a valid date string." });
  }
  if (options.releaseMode !== undefined && typeof options.releaseMode !== "boolean") {
    issues.push({ code: "invalid_evidence", severity: "error", message: "Evaluation releaseMode must be boolean." });
  }
  return issues;
};

const resolveRequiredCoverage = (
  requiredCoverage: PerformanceEvaluationOptions["requiredCoverage"],
): { coverage: readonly PerformanceCoverage[] | undefined; issues: PerformanceIssue[] } => {
  if (requiredCoverage === undefined) return { coverage: undefined, issues: [] };
  if (Array.isArray(requiredCoverage)) {
    const coverage: PerformanceCoverage[] = [];
    const issues: PerformanceIssue[] = [];
    requiredCoverage.forEach((candidate, index) => {
      const result = validatePerformanceCoverage(candidate, `requiredCoverage[${index}]`);
      if (result.ok && result.value !== undefined) coverage.push(result.value);
      else issues.push(...result.issues.map(asIssue));
    });
    return { coverage, issues };
  }
  const inventory = validatePerformanceCoverageInventory(requiredCoverage);
  return {
    coverage: inventory.value?.coverage,
    issues: inventory.issues.map(asIssue),
  };
};

/**
 * Nearest-rank percentile.  This keeps an observed slow sample visible at the
 * acceptance boundary instead of smoothing it away through interpolation.
 */
export const nearestRankPercentile = (values: readonly number[], percentile: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1);
  return sorted[index] ?? null;
};

const getPercentiles = (values: readonly number[]): PerformanceGroupResult["percentiles"] => {
  if (values.length === 0) return null;
  return {
    p50: nearestRankPercentile(values, 50) as number,
    p75: nearestRankPercentile(values, 75) as number,
    p95: nearestRankPercentile(values, 95) as number,
    p99: nearestRankPercentile(values, 99) as number,
  };
};

const budgetMap = (contract: PerformanceContract): ReadonlyMap<string, PerformanceBudget> =>
  new Map((contract.budgets ?? []).map((budget) => [budget.id, budget]));

const groupKeyFromMeasurement = (measurement: PerformanceMeasurement): string => performanceGroupKey(measurement);
const groupKeyFromCoverage = (coverage: PerformanceCoverage): string => performanceGroupKey(coverage);

const groupMatchesBudget = (group: PerformanceCoverage, budget: PerformanceBudget): PerformanceIssue[] => {
  const issues: PerformanceIssue[] = [];
  if (group.metric !== budget.metric) issues.push({ code: "metric_mismatch", severity: "error", message: `Coverage metric ${group.metric} does not match budget metric ${budget.metric}.`, budgetId: budget.id, caseId: group.caseId, groupKey: groupKeyFromCoverage(group) });
  if (group.surface !== budget.surface) issues.push({ code: "metric_mismatch", severity: "error", message: `Coverage surface ${group.surface} does not match budget surface ${budget.surface}.`, budgetId: budget.id, caseId: group.caseId, groupKey: groupKeyFromCoverage(group) });
  if (budget.maximum === undefined) issues.push({ code: "unassigned_large_workload_budget", severity: "error", message: `Budget ${budget.id} has no finite maximum. Register a workload-tier budget before measuring it.`, budgetId: budget.id, caseId: group.caseId, groupKey: groupKeyFromCoverage(group) });
  return issues;
};

const regressionThreshold = (baseline: PerformanceRegressionBaseline): number => {
  const relative = baseline.value * 1.1;
  const absolute = baseline.unit === "ms" ? baseline.value + 100 : relative;
  return Math.max(relative, absolute);
};

const issueForFailure = (code: PerformanceIssue["code"], message: string, group: PerformanceCoverage, measurementIds: readonly string[]): PerformanceIssue => ({
  code,
  severity: "error",
  message,
  groupKey: groupKeyFromCoverage(group),
  budgetId: group.budgetId,
  caseId: group.caseId,
  measurementIds,
});

const groupMeasurements = (measurements: readonly PerformanceMeasurement[]): Map<string, PerformanceMeasurement[]> => {
  const groups = new Map<string, PerformanceMeasurement[]>();
  for (const measurement of measurements) {
    const key = groupKeyFromMeasurement(measurement);
    const existing = groups.get(key);
    if (existing) existing.push(measurement);
    else groups.set(key, [measurement]);
  }
  return groups;
};

const resultForGroup = (
  coverage: PerformanceCoverage,
  budget: PerformanceBudget | undefined,
  measurements: readonly PerformanceMeasurement[],
  expected: boolean,
): PerformanceGroupResult => {
  const values = measurements.map((measurement) => measurement.value);
  const percentiles = getPercentiles(values);
  const evaluatedPercentile = budget && percentiles
    ? nearestRankPercentile(values, budget.percentile)
    : null;
  const measurementIds = measurements.map((measurement) => measurement.measurementId);
  const successfulSampleCount = measurements.filter((measurement) => measurement.status === "ok").length;
  return {
    ...coverage,
    groupKey: groupKeyFromCoverage(coverage),
    expected,
    sampleCount: measurements.length,
    successfulSampleCount,
    failedSampleCount: measurements.length - successfulSampleCount,
    independentRunCount: new Set(measurements.map((measurement) => measurement.runId)).size,
    percentiles,
    evaluatedPercentile,
    maximum: budget?.maximum ?? null,
    unexpectedErrorCount: measurements.filter((measurement) => measurement.unexpectedError).length,
    timeoutCount: measurements.filter((measurement) => measurement.timeout).length,
    correctnessFailureCount: measurements.filter((measurement) => measurement.correctnessFailure).length,
    measurementIds,
    passed: false,
  };
};

const getRequiredSamples = (
  coverage: PerformanceCoverage,
  contract: PerformanceContract,
  options: PerformanceEvaluationOptions,
): number => Math.max(
  contract.minimumSamples?.[coverage.surface] ?? Number.MAX_SAFE_INTEGER,
  options.minimumSamples?.[coverage.surface] ?? 0,
  coverage.minimumSamples ?? 0,
);

const getRequiredRuns = (coverage: PerformanceCoverage, contract: PerformanceContract, options: PerformanceEvaluationOptions): number =>
  Math.max(
    contract.minimumIndependentRuns ?? Number.MAX_SAFE_INTEGER,
    options.minimumIndependentRuns ?? 0,
    coverage.minimumRuns ?? 0,
  );

/**
 * Evaluate runtime evidence against the explicit contract.  Invalid input is a
 * release failure and is returned as machine-readable issues rather than
 * thrown away or treated as an empty, passing run.
 */
export const evaluatePerformanceEvidence = (
  input: unknown,
  options: PerformanceEvaluationOptions = {},
): PerformanceEvaluation => {
  const generatedAt = options.generatedAt ?? defaultGeneratedAt();
  const mode = evaluationMode(options);
  const optionIssues = validateOptions(options);
  const parsed = validatePerformanceEvidence(input);
  const validationIssues = parsed.ok ? optionIssues : parsed.issues.map(asIssue);
  if (!parsed.ok || parsed.value === undefined || optionIssues.length > 0) {
    return {
      schema: PERFORMANCE_EVALUATION_SCHEMA,
      mode,
      releaseReady: false,
      contractVersion: typeof input === "object" && input !== null && "contractVersion" in input && typeof (input as { contractVersion?: unknown }).contractVersion === "string"
        ? (input as { contractVersion: string }).contractVersion
        : PERFORMANCE_CONTRACT.version,
      buildIdentity: typeof input === "object" && input !== null && "buildIdentity" in input && typeof (input as { buildIdentity?: unknown }).buildIdentity === "string"
        ? (input as { buildIdentity: string }).buildIdentity
        : "invalid-evidence",
      capturedAt: typeof input === "object" && input !== null && "capturedAt" in input && typeof (input as { capturedAt?: unknown }).capturedAt === "string"
        ? (input as { capturedAt: string }).capturedAt
        : "",
      generatedAt,
      ok: false,
      groups: [],
      issues: validationIssues,
      counts: {
        expectedCoverage: 0,
        evaluatedCoverage: 0,
        missingCoverage: 0,
        unexpectedCoverage: 0,
        validationIssues: validationIssues.length,
      },
      retainedFailures: {
        failedSamples: 0,
        unexpectedErrors: 0,
        timeouts: 0,
        correctnessFailures: 0,
      },
    };
  }

  const evidence: PerformanceEvidence = parsed.value;
  const contract = options.contract ?? PERFORMANCE_CONTRACT;
  const contractIssues = validatePerformanceContract(contract);
  const issues: PerformanceIssue[] = contractIssues.map(asIssue);
  const budgets = budgetMap(contract);
  const requiredCoverageResult = resolveRequiredCoverage(options.requiredCoverage);
  issues.push(...requiredCoverageResult.issues);
  const trustedCoverage = requiredCoverageResult.coverage;
  if (mode === "release" && Array.isArray(options.requiredCoverage)) {
    issues.push({ code: "invalid_evidence", severity: "error", message: "Release mode requires the versioned trusted coverage inventory object, not an unversioned coverage array." });
  }
  const expectedGroups = new Map<string, PerformanceCoverage>();

  if (mode === "release" && trustedCoverage === undefined) {
    issues.push({ code: "coverage_not_declared", severity: "error", message: "Release evaluation requires a separately supplied trusted coverage inventory." });
  }
  if (mode === "release" && trustedCoverage !== undefined && trustedCoverage.length === 0) {
    issues.push({ code: "coverage_not_declared", severity: "error", message: "Trusted release coverage inventory is empty." });
  }
  if (evidence.coverage.length === 0 && trustedCoverage === undefined) {
    issues.push({ code: "coverage_not_declared", severity: "error", message: "No coverage cases were declared; measured app performance cannot pass without route/workload coverage." });
  }

  const evidenceCoverageByKey = new Map(evidence.coverage.map((coverage) => [groupKeyFromCoverage(coverage), coverage]));
  if (trustedCoverage !== undefined) {
    const evidenceCoverageKeys = new Set<string>();
    for (const coverage of evidence.coverage) {
      const key = groupKeyFromCoverage(coverage);
      if (evidenceCoverageKeys.has(key)) issues.push({ code: "coverage_not_declared", severity: "error", message: `Evidence coverage case ${key} is declared more than once.`, groupKey: key, budgetId: coverage.budgetId, caseId: coverage.caseId });
      evidenceCoverageKeys.add(key);
    }
    const trustedKeys = new Set(trustedCoverage.map((coverage) => groupKeyFromCoverage(coverage)));
    for (const coverage of trustedCoverage) {
      const key = groupKeyFromCoverage(coverage);
      if (!evidenceCoverageByKey.has(key)) issues.push(issueForFailure("missing_coverage", `Evidence omitted trusted coverage case ${coverage.caseId}.`, coverage, []));
    }
    for (const coverage of evidence.coverage) {
      const key = groupKeyFromCoverage(coverage);
      if (!trustedKeys.has(key)) issues.push({ code: "unexpected_coverage", severity: "error", message: `Evidence declared coverage case ${coverage.caseId} that is absent from the trusted inventory.`, groupKey: key, budgetId: coverage.budgetId, caseId: coverage.caseId });
    }
  }

  const expectedCoverage = trustedCoverage === undefined
    ? evidence.coverage
    : trustedCoverage.map((coverage) => {
      const observed = evidenceCoverageByKey.get(groupKeyFromCoverage(coverage));
      const minimumSamples = Math.max(coverage.minimumSamples ?? 0, observed?.minimumSamples ?? 0);
      const minimumRuns = Math.max(coverage.minimumRuns ?? 0, observed?.minimumRuns ?? 0);
      return {
        ...coverage,
        minimumSamples: minimumSamples > 0 ? minimumSamples : undefined,
        minimumRuns: minimumRuns > 0 ? minimumRuns : undefined,
      };
    });

  for (const coverage of expectedCoverage) {
    const key = groupKeyFromCoverage(coverage);
    if (expectedGroups.has(key)) {
      issues.push({ code: "coverage_not_declared", severity: "error", message: `Coverage case ${key} is declared more than once.`, groupKey: key, budgetId: coverage.budgetId, caseId: coverage.caseId });
      continue;
    }
    expectedGroups.set(key, coverage);
    const budget = budgets.get(coverage.budgetId);
    if (!budget) {
      issues.push({ code: "unknown_budget", severity: "error", message: `Coverage references unknown budget ${coverage.budgetId}.`, groupKey: key, budgetId: coverage.budgetId, caseId: coverage.caseId });
      continue;
    }
    issues.push(...groupMatchesBudget(coverage, budget));
  }

  if (mode === "release") {
    for (const workloadGroup of contract.largeWorkloadGroups ?? []) {
      const workloadCoverage = expectedCoverage.filter((coverage) => coverage.caseId === workloadGroup);
      if (workloadCoverage.length === 0) {
        issues.push({ code: "unassigned_large_workload_budget", severity: "error", message: `Release inventory is missing the required PERF13 workload group ${workloadGroup}.`, caseId: workloadGroup });
        continue;
      }
      for (const coverage of workloadCoverage) {
        const budget = budgets.get(coverage.budgetId);
        if (!budget || budget.kind !== "large_workload" || budget.parentId !== "PERF13" || budget.maximum === undefined || !Number.isFinite(budget.maximum)) {
          issues.push({ code: "unassigned_large_workload_budget", severity: "error", message: `Workload group ${workloadGroup} does not resolve to a frozen finite PERF13 workload-tier budget.`, groupKey: groupKeyFromCoverage(coverage), budgetId: coverage.budgetId, caseId: workloadGroup });
        }
      }
    }
  }

  const measurementGroups = groupMeasurements(evidence.measurements);
  const knownMeasurementGroups = new Set<string>();
  for (const measurement of evidence.measurements) {
    const budget = budgets.get(measurement.budgetId);
    const key = groupKeyFromMeasurement(measurement);
    if (!budget) {
      issues.push({ code: "unknown_budget", severity: "error", message: `Measurement references unknown budget ${measurement.budgetId}.`, groupKey: key, budgetId: measurement.budgetId, caseId: measurement.caseId, measurementIds: [measurement.measurementId] });
      continue;
    }
    if (measurement.metric !== budget.metric) issues.push({ code: "metric_mismatch", severity: "error", message: `Measurement metric ${measurement.metric} does not match budget metric ${budget.metric}.`, groupKey: key, budgetId: budget.id, caseId: measurement.caseId, measurementIds: [measurement.measurementId] });
    if (measurement.unit !== budget.unit) issues.push({ code: "unit_mismatch", severity: "error", message: `Measurement unit ${measurement.unit} does not match budget unit ${budget.unit}.`, groupKey: key, budgetId: budget.id, caseId: measurement.caseId, measurementIds: [measurement.measurementId] });
    if (budget.maximum === undefined) issues.push({ code: "unassigned_large_workload_budget", severity: "error", message: `Budget ${budget.id} has no finite maximum.`, groupKey: key, budgetId: budget.id, caseId: measurement.caseId, measurementIds: [measurement.measurementId] });
    if (!expectedGroups.has(key)) issues.push({ code: "unexpected_coverage", severity: "error", message: `Measurement group ${key} was not declared in coverage.`, groupKey: key, budgetId: measurement.budgetId, caseId: measurement.caseId, measurementIds: [measurement.measurementId] });
    else knownMeasurementGroups.add(key);
  }

  const baselines = new Map((evidence.regressionBaselines ?? []).map((baseline) => [baseline.groupKey, baseline]));
  const groups: PerformanceGroupResult[] = [];
  let missingCoverage = 0;
  let unexpectedCoverage = 0;
  let failedSamples = evidence.measurements.filter((measurement) => measurement.status === "failed").length;
  let unexpectedErrors = evidence.measurements.filter((measurement) => measurement.unexpectedError).length;
  let timeouts = evidence.measurements.filter((measurement) => measurement.timeout).length;
  let correctnessFailures = evidence.measurements.filter((measurement) => measurement.correctnessFailure).length;

  for (const issue of issues) {
    if (issue.code === "unexpected_coverage") unexpectedCoverage += 1;
  }

  for (const [key, coverage] of Array.from(expectedGroups.entries())) {
    const budget = budgets.get(coverage.budgetId);
    const measurements = measurementGroups.get(key) ?? [];
    const result = resultForGroup(coverage, budget, measurements, true);
    groups.push(result);

    if (measurements.length === 0) {
      missingCoverage += 1;
      issues.push(issueForFailure("missing_coverage", `No measurements were supplied for declared case ${coverage.caseId}.`, coverage, []));
      continue;
    }

    const requiredSamples = getRequiredSamples(coverage, contract, options);
    if (measurements.length < requiredSamples) issues.push(issueForFailure("insufficient_samples", `Case ${coverage.caseId} has ${measurements.length} samples; ${requiredSamples} are required for ${coverage.surface}.`, coverage, result.measurementIds));
    const requiredRuns = getRequiredRuns(coverage, contract, options);
    if (result.independentRunCount < requiredRuns) issues.push(issueForFailure("insufficient_runs", `Case ${coverage.caseId} has ${result.independentRunCount} independent runs; ${requiredRuns} are required.`, coverage, result.measurementIds));
    if (result.failedSampleCount > 0) issues.push(issueForFailure("failed_measurement", `Case ${coverage.caseId} contains ${result.failedSampleCount} failed measurement(s); failures are retained and block acceptance.`, coverage, result.measurementIds));
    if (result.timeoutCount > 0) issues.push(issueForFailure("timeout", `Case ${coverage.caseId} contains ${result.timeoutCount} timeout(s).`, coverage, result.measurementIds));
    if (result.correctnessFailureCount > 0) issues.push(issueForFailure("correctness_failure", `Case ${coverage.caseId} contains ${result.correctnessFailureCount} correctness failure(s).`, coverage, result.measurementIds));
    const unexpectedRate = result.sampleCount === 0 ? 1 : result.unexpectedErrorCount / result.sampleCount;
    if (unexpectedRate >= 0.001) issues.push(issueForFailure("unexpected_errors", `Case ${coverage.caseId} unexpected error rate ${(unexpectedRate * 100).toFixed(4)}% is not below 0.1%.`, coverage, result.measurementIds));
    else if (result.unexpectedErrorCount > 0) issues.push({ ...issueForFailure("unexpected_errors", `Case ${coverage.caseId} retained ${result.unexpectedErrorCount} unexpected error(s) below the 0.1% rate threshold.`, coverage, result.measurementIds), severity: "warning" });
    if (budget?.maximum !== undefined && result.evaluatedPercentile !== null && result.evaluatedPercentile > budget.maximum) issues.push(issueForFailure("threshold_failure", `${coverage.caseId} ${budget.metric} p${budget.percentile}=${result.evaluatedPercentile} ${budget.unit} exceeds ${budget.maximum} ${budget.unit}.`, coverage, result.measurementIds));
    const baseline = baselines.get(key);
    if (baseline && result.evaluatedPercentile !== null) {
      if (baseline.unit !== budget?.unit || baseline.percentile !== budget?.percentile) issues.push(issueForFailure("regression_failure", `Regression baseline for ${coverage.caseId} does not use the same unit and percentile.`, coverage, result.measurementIds));
      else if (result.evaluatedPercentile > regressionThreshold(baseline)) issues.push(issueForFailure("regression_failure", `${coverage.caseId} p${baseline.percentile}=${result.evaluatedPercentile} exceeds regression ceiling ${regressionThreshold(baseline)} from ${baseline.acceptedBuild}.`, coverage, result.measurementIds));
    }
  }

  // Include known, undeclared groups in the report so a hidden slow route or
  // an accidental route rename cannot disappear from retained evidence.
  for (const [key, measurements] of Array.from(measurementGroups.entries())) {
    if (knownMeasurementGroups.has(key)) continue;
    const first = measurements[0];
    if (!first) continue;
    const budget = budgets.get(first.budgetId);
    groups.push(resultForGroup(first, budget, measurements, false));
  }

  const hasGlobalErrors = issues.some((issue) => issue.severity === "error" && issue.groupKey === undefined);
  const finalizedGroups = groups.map((group) => ({
    ...group,
    passed: !hasGlobalErrors && group.expected && group.sampleCount > 0 && !issues.some((issue) => issue.severity === "error" && issue.groupKey === group.groupKey),
  }));
  const hasErrors = issues.some((issue) => issue.severity === "error");
  return {
    schema: PERFORMANCE_EVALUATION_SCHEMA,
    mode,
    releaseReady: mode === "release" && trustedCoverage !== undefined && !hasErrors,
    contractVersion: evidence.contractVersion,
    buildIdentity: evidence.buildIdentity,
    capturedAt: evidence.capturedAt,
    generatedAt,
    ok: !hasErrors,
    groups: finalizedGroups,
    issues,
    counts: {
      expectedCoverage: expectedGroups.size,
      evaluatedCoverage: finalizedGroups.filter((group) => group.expected && group.sampleCount > 0).length,
      missingCoverage,
      unexpectedCoverage,
      validationIssues: issues.filter((issue) => issue.code === "invalid_evidence").length,
    },
    retainedFailures: {
      failedSamples,
      unexpectedErrors,
      timeouts,
      correctnessFailures,
    },
  };
};
