/**
 * Performance acceptance contracts shared by the runtime evaluator and the
 * release evidence tools.
 *
 * The values in this file are copied from the approved R-ops performance
 * contract.  They are deliberately explicit: a measured result cannot pass
 * by inventing a budget at collection time.
 */

export const PERFORMANCE_EVIDENCE_SCHEMA = "r-ops.performance-evidence.v1" as const;
export const PERFORMANCE_COVERAGE_SCHEMA = "r-ops.performance-coverage.v1" as const;
export const PERFORMANCE_EVALUATION_SCHEMA = "r-ops.performance-evaluation.v1" as const;
export const PERFORMANCE_CONTRACT_VERSION = "2026-09-20.t03.v1" as const;

export type PerformanceSurface = "browser" | "service" | "native" | "job";
export type PerformanceUnit = "ms" | "score";
export type PerformanceMetric =
  | "largest_contentful_paint"
  | "interaction_to_next_paint"
  | "cumulative_layout_shift"
  | "cached_navigation_to_usable_content"
  | "uncached_indexed_view_to_usable_content"
  | "search_filter_sort_pagination"
  | "ordinary_save_to_persisted_readback"
  | "common_report_to_usable_results"
  | "ordinary_api_mcp_server_processing"
  | "signed_mac_startup_to_usable_authorized_view"
  | "local_control_visible_response"
  | "asynchronous_acknowledgement_and_state_display"
  | "large_workload_completion"
  | (string & {});

/**
 * A cohort is intentionally made of separate dimensions.  In particular,
 * cache state, device, network and data scale must never be folded into one
 * opaque profile string and accidentally aggregated together.
 */
export interface PerformanceCohort {
  surface: PerformanceSurface;
  caseId: string;
  device: string;
  network: string;
  dataScale: string;
  cacheState: string;
  appearance: string;
  providerState: string;
}

export interface PerformanceCoverage extends PerformanceCohort {
  budgetId: string;
  metric: PerformanceMetric;
  variant?: string;
  minimumSamples?: number;
  minimumRuns?: number;
}

export interface PerformanceMeasurement extends PerformanceCoverage {
  measurementId: string;
  sampleId: string;
  runId: string;
  value: number;
  unit: PerformanceUnit;
  status: "ok" | "failed";
  /** Runtime harness identity. `unit_test` is intentionally not a value here. */
  source: "browser_harness" | "service_harness" | "native_harness" | "job_harness";
  unexpectedError: boolean;
  timeout: boolean;
  correctnessFailure: boolean;
  errorCode?: string;
  measuredAt?: string;
}

export interface PerformanceBudget {
  id: string;
  /** The PERF13 workload budgets can use this to retain their parent contract id. */
  parentId?: string;
  metric: PerformanceMetric;
  percentile: number;
  unit: PerformanceUnit;
  /** Undefined is allowed only for the intentionally unassigned PERF13 base row. */
  maximum?: number;
  surface: PerformanceSurface;
  kind: "standard" | "large_workload";
  scope: string;
}

export interface PerformanceContract {
  version: string;
  budgets: readonly PerformanceBudget[];
  minimumSamples: Readonly<Record<PerformanceSurface, number>>;
  minimumIndependentRuns: number;
  largeWorkloadGroups: readonly string[];
}

export interface PerformanceRegressionBaseline {
  groupKey: string;
  percentile: number;
  value: number;
  unit: PerformanceUnit;
  acceptedBuild: string;
}

export interface PerformanceEvidence {
  schema: typeof PERFORMANCE_EVIDENCE_SCHEMA;
  contractVersion: string;
  buildIdentity: string;
  capturedAt: string;
  /** Every supported case must be declared before its measurements are accepted. */
  coverage: readonly PerformanceCoverage[];
  measurements: readonly PerformanceMeasurement[];
  regressionBaselines?: readonly PerformanceRegressionBaseline[];
}

/** Trusted release inventory supplied independently of measured evidence. */
export interface PerformanceCoverageInventory {
  schema: typeof PERFORMANCE_COVERAGE_SCHEMA;
  contractVersion: string;
  inventoryId: string;
  coverage: readonly PerformanceCoverage[];
}

export type PerformanceIssueCode =
  | "invalid_evidence"
  | "unknown_budget"
  | "unassigned_large_workload_budget"
  | "unexpected_coverage"
  | "coverage_not_declared"
  | "missing_coverage"
  | "insufficient_samples"
  | "insufficient_runs"
  | "metric_mismatch"
  | "unit_mismatch"
  | "threshold_failure"
  | "unexpected_errors"
  | "timeout"
  | "correctness_failure"
  | "failed_measurement"
  | "regression_failure";

export interface PerformanceIssue {
  code: PerformanceIssueCode;
  severity: "error" | "warning";
  message: string;
  groupKey?: string;
  budgetId?: string;
  caseId?: string;
  measurementIds?: readonly string[];
}

export interface PerformanceGroupResult extends PerformanceCoverage {
  groupKey: string;
  expected: boolean;
  sampleCount: number;
  successfulSampleCount: number;
  failedSampleCount: number;
  independentRunCount: number;
  percentiles: {
    p50: number;
    p75: number;
    p95: number;
    p99: number;
  } | null;
  evaluatedPercentile: number | null;
  maximum: number | null;
  unexpectedErrorCount: number;
  timeoutCount: number;
  correctnessFailureCount: number;
  measurementIds: readonly string[];
  passed: boolean;
}

export interface PerformanceEvaluation {
  schema: typeof PERFORMANCE_EVALUATION_SCHEMA;
  mode: "diagnostic" | "release";
  /** Diagnostic reports are useful for triage but never constitute release acceptance. */
  releaseReady: boolean;
  contractVersion: string;
  buildIdentity: string;
  capturedAt: string;
  generatedAt: string;
  /** True when this evaluation has no recorded errors; releaseReady is the acceptance gate. */
  ok: boolean;
  groups: readonly PerformanceGroupResult[];
  issues: readonly PerformanceIssue[];
  counts: {
    expectedCoverage: number;
    evaluatedCoverage: number;
    missingCoverage: number;
    unexpectedCoverage: number;
    validationIssues: number;
  };
  retainedFailures: {
    failedSamples: number;
    unexpectedErrors: number;
    timeouts: number;
    correctnessFailures: number;
  };
}

const budget = (definition: PerformanceBudget): PerformanceBudget => definition;

/**
 * PERF13 deliberately has no maximum yet.  A report containing this row is a
 * release blocker until B04/B05 register each supported large-workload tier.
 */
export const PERFORMANCE_BUDGETS: readonly PerformanceBudget[] = [
  budget({
    id: "PERF01",
    metric: "largest_contentful_paint",
    percentile: 75,
    maximum: 2500,
    unit: "ms",
    surface: "browser",
    kind: "standard",
    scope: "Each web route group; desktop and mobile separately.",
  }),
  budget({
    id: "PERF02",
    metric: "interaction_to_next_paint",
    percentile: 75,
    maximum: 200,
    unit: "ms",
    surface: "browser",
    kind: "standard",
    scope: "Actual representative web interactions; Lighthouse TBT does not satisfy INP.",
  }),
  budget({
    id: "PERF03",
    metric: "cumulative_layout_shift",
    percentile: 75,
    maximum: 0.1,
    unit: "score",
    surface: "browser",
    kind: "standard",
    scope: "Each web route group including delayed content and interaction states.",
  }),
  budget({
    id: "PERF04",
    metric: "cached_navigation_to_usable_content",
    percentile: 95,
    maximum: 1000,
    unit: "ms",
    surface: "browser",
    kind: "standard",
    scope: "Supported web and Mac in-app views.",
  }),
  budget({
    id: "PERF05",
    metric: "uncached_indexed_view_to_usable_content",
    percentile: 95,
    maximum: 2000,
    unit: "ms",
    surface: "browser",
    kind: "standard",
    scope: "Signed-in application record and list views, retrieval through rendering.",
  }),
  budget({
    id: "PERF06",
    metric: "search_filter_sort_pagination",
    percentile: 95,
    maximum: 500,
    unit: "ms",
    surface: "browser",
    kind: "standard",
    scope: "Input through usable results, including debounce.",
  }),
  budget({
    id: "PERF07",
    metric: "ordinary_save_to_persisted_readback",
    percentile: 95,
    maximum: 2000,
    unit: "ms",
    surface: "browser",
    kind: "standard",
    scope: "User action through a persisted readback; QBO completion is measured separately.",
  }),
  budget({
    id: "PERF08",
    metric: "common_report_to_usable_results",
    percentile: 95,
    maximum: 5000,
    unit: "ms",
    surface: "browser",
    kind: "standard",
    scope: "Current financial and operating read model with correct parameters and scope.",
  }),
  budget({
    id: "PERF09.read",
    parentId: "PERF09",
    metric: "ordinary_api_mcp_server_processing",
    percentile: 95,
    maximum: 500,
    unit: "ms",
    surface: "service",
    kind: "standard",
    scope: "Ordinary API and MCP server reads; service timing only.",
  }),
  budget({
    id: "PERF09.write",
    parentId: "PERF09",
    metric: "ordinary_api_mcp_server_processing",
    percentile: 95,
    maximum: 1000,
    unit: "ms",
    surface: "service",
    kind: "standard",
    scope: "Local writes; service timing only.",
  }),
  budget({
    id: "PERF10.cold",
    parentId: "PERF10",
    metric: "signed_mac_startup_to_usable_authorized_view",
    percentile: 95,
    maximum: 3000,
    unit: "ms",
    surface: "native",
    kind: "standard",
    scope: "Signed Mac cold startup to a usable authorized view.",
  }),
  budget({
    id: "PERF10.warm",
    parentId: "PERF10",
    metric: "signed_mac_startup_to_usable_authorized_view",
    percentile: 95,
    maximum: 1000,
    unit: "ms",
    surface: "native",
    kind: "standard",
    scope: "Signed Mac warm startup to a usable authorized view.",
  }),
  budget({
    id: "PERF11",
    metric: "local_control_visible_response",
    percentile: 95,
    maximum: 100,
    unit: "ms",
    surface: "browser",
    kind: "standard",
    scope: "Menus, dropdowns and local controls; glass and solid.",
  }),
  budget({
    id: "PERF12.ack",
    parentId: "PERF12",
    metric: "asynchronous_acknowledgement_and_state_display",
    percentile: 95,
    maximum: 1000,
    unit: "ms",
    surface: "browser",
    kind: "standard",
    scope: "Acknowledgement of queued state, never completion.",
  }),
  budget({
    id: "PERF12.state",
    parentId: "PERF12",
    metric: "asynchronous_acknowledgement_and_state_display",
    percentile: 95,
    maximum: 1000,
    unit: "ms",
    surface: "browser",
    kind: "standard",
    scope: "Received state render.",
  }),
  budget({
    id: "PERF13",
    metric: "large_workload_completion",
    percentile: 95,
    unit: "ms",
    surface: "job",
    kind: "large_workload",
    scope: "Large documents, imports, reports, forecasts, exports and QBO sync.",
  }),
] as const;

export const PERFORMANCE_CONTRACT: PerformanceContract = {
  version: PERFORMANCE_CONTRACT_VERSION,
  budgets: PERFORMANCE_BUDGETS,
  minimumSamples: {
    browser: 100,
    service: 100,
    native: 30,
    job: 100,
  },
  minimumIndependentRuns: 3,
  largeWorkloadGroups: [
    "document_first_readable_page",
    "MRA_digital_and_OCR_packet_tiers",
    "project_cost_import_preview_and_apply",
    "large_reports_and_exports",
    "portfolio_forecasts",
    "QBO_write_sync_and_catchup",
  ],
};

export const performanceGroupKey = (group: Pick<PerformanceCoverage, "budgetId" | "metric" | "variant" | "surface" | "caseId" | "device" | "network" | "dataScale" | "cacheState" | "appearance" | "providerState">): string =>
  JSON.stringify([
    group.budgetId,
    group.metric,
    group.variant ?? "",
    group.surface,
    group.caseId,
    group.device,
    group.network,
    group.dataScale,
    group.cacheState,
    group.appearance,
    group.providerState,
  ]);

export const getPerformanceBudget = (
  contract: PerformanceContract,
  budgetId: string,
): PerformanceBudget | undefined => contract.budgets.find((candidate) => candidate.id === budgetId);
