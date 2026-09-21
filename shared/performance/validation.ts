import {
  PERFORMANCE_CONTRACT_VERSION,
  PERFORMANCE_COVERAGE_SCHEMA,
  PERFORMANCE_EVIDENCE_SCHEMA,
  PERFORMANCE_CONTRACT,
  type PerformanceBudget,
  type PerformanceContract,
  type PerformanceCoverage,
  type PerformanceCoverageInventory,
  type PerformanceEvidence,
  type PerformanceMeasurement,
  type PerformanceRegressionBaseline,
  type PerformanceSurface,
} from "./contracts.ts";

export interface PerformanceValidationIssue {
  path: string;
  code: "invalid_type" | "missing_field" | "invalid_value" | "unknown_field";
  message: string;
}

export interface PerformanceValidationResult<T> {
  ok: boolean;
  value?: T;
  issues: readonly PerformanceValidationIssue[];
}

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isFinitePositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value > 0;

const isSafeString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);

const addUnknownFields = (record: UnknownRecord, allowed: readonly string[], path: string, issues: PerformanceValidationIssue[]): void => {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      issues.push({ path: `${path}.${key}`, code: "unknown_field", message: "Field is not part of the performance contract." });
    }
  }
};

const requireString = (record: UnknownRecord, key: string, path: string, issues: PerformanceValidationIssue[]): string | undefined => {
  if (!(key in record)) {
    issues.push({ path: `${path}.${key}`, code: "missing_field", message: "Required string field is missing." });
    return undefined;
  }
  if (!isSafeString(record[key])) {
    issues.push({ path: `${path}.${key}`, code: "invalid_value", message: "Expected a non-empty safe string." });
    return undefined;
  }
  return record[key] as string;
};

const validatePercentile = (value: unknown, path: string, issues: PerformanceValidationIssue[]): value is number => {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value) || value < 1 || value > 100) {
    issues.push({ path, code: "invalid_value", message: "Percentile must be an integer from 1 through 100." });
    return false;
  }
  return true;
};

const validateCohort = (record: UnknownRecord, path: string, issues: PerformanceValidationIssue[]): boolean => {
  let valid = true;
  for (const key of ["caseId", "device", "network", "dataScale", "cacheState", "appearance", "providerState"] as const) {
    valid = requireString(record, key, path, issues) !== undefined && valid;
  }
  const surface = requireString(record, "surface", path, issues);
  if (surface !== undefined && !["browser", "service", "native", "job"].includes(surface)) {
    issues.push({ path: `${path}.surface`, code: "invalid_value", message: "Unknown performance surface." });
    valid = false;
  }
  return valid;
};

const validateCoverage = (value: unknown, path: string, issues: PerformanceValidationIssue[], allowAdditionalFields = false): PerformanceCoverage | undefined => {
  if (!isRecord(value)) {
    issues.push({ path, code: "invalid_type", message: "Coverage must be an object." });
    return undefined;
  }
  if (!allowAdditionalFields) addUnknownFields(value, ["budgetId", "metric", "variant", "surface", "caseId", "device", "network", "dataScale", "cacheState", "appearance", "providerState", "minimumSamples", "minimumRuns"], path, issues);
  const budgetId = requireString(value, "budgetId", path, issues);
  const metric = requireString(value, "metric", path, issues);
  const cohortValid = validateCohort(value, path, issues);
  let valid = budgetId !== undefined && metric !== undefined && cohortValid;
  if ("variant" in value && value.variant !== undefined && !isSafeString(value.variant)) {
    issues.push({ path: `${path}.variant`, code: "invalid_value", message: "Variant must be a safe string when supplied." });
    valid = false;
  }
  for (const key of ["minimumSamples", "minimumRuns"] as const) {
    if (key in value && value[key] !== undefined && !isFinitePositiveInteger(value[key])) {
      issues.push({ path: `${path}.${key}`, code: "invalid_value", message: "Minimum counts must be finite positive integers." });
      valid = false;
    }
  }
  if (!valid) return undefined;
  return {
    budgetId: budgetId as string,
    metric: metric as PerformanceCoverage["metric"],
    variant: value.variant as string | undefined,
    surface: value.surface as PerformanceSurface,
    caseId: value.caseId as string,
    device: value.device as string,
    network: value.network as string,
    dataScale: value.dataScale as string,
    cacheState: value.cacheState as string,
    appearance: value.appearance as string,
    providerState: value.providerState as string,
    minimumSamples: value.minimumSamples as number | undefined,
    minimumRuns: value.minimumRuns as number | undefined,
  };
};

const validateMeasurement = (value: unknown, path: string, issues: PerformanceValidationIssue[]): PerformanceMeasurement | undefined => {
  if (!isRecord(value)) {
    issues.push({ path, code: "invalid_type", message: "Measurement must be an object." });
    return undefined;
  }
  addUnknownFields(value, ["measurementId", "sampleId", "runId", "budgetId", "metric", "variant", "surface", "caseId", "device", "network", "dataScale", "cacheState", "appearance", "providerState", "minimumSamples", "minimumRuns", "value", "unit", "status", "source", "unexpectedError", "timeout", "correctnessFailure", "errorCode", "measuredAt"], path, issues);
  const coverage = validateCoverage(value, path, issues, true);
  let valid = coverage !== undefined;
  for (const key of ["measurementId", "sampleId", "runId"] as const) {
    valid = requireString(value, key, path, issues) !== undefined && valid;
  }
  if (!("value" in value) || !isFiniteNonNegative(value.value)) {
    issues.push({ path: `${path}.value`, code: "invalid_value", message: "Measured value must be finite and non-negative." });
    valid = false;
  }
  if (!("unit" in value) || !["ms", "score"].includes(value.unit as string)) {
    issues.push({ path: `${path}.unit`, code: "invalid_value", message: "Unit must be ms or score." });
    valid = false;
  }
  if (!("status" in value) || !["ok", "failed"].includes(value.status as string)) {
    issues.push({ path: `${path}.status`, code: "invalid_value", message: "Status must be ok or failed." });
    valid = false;
  }
  if (!("source" in value) || !["browser_harness", "service_harness", "native_harness", "job_harness"].includes(value.source as string)) {
    issues.push({ path: `${path}.source`, code: "invalid_value", message: "Measurement source must identify a runtime harness; unit tests are not accepted." });
    valid = false;
  }
  const sourceSurface: Record<string, string> = {
    browser_harness: "browser",
    service_harness: "service",
    native_harness: "native",
    job_harness: "job",
  };
  if (coverage !== undefined && typeof value.source === "string" && sourceSurface[value.source] !== coverage.surface) {
    issues.push({ path: `${path}.source`, code: "invalid_value", message: "Runtime harness source must match the declared performance surface." });
    valid = false;
  }
  for (const key of ["unexpectedError", "timeout", "correctnessFailure"] as const) {
    if (typeof value[key] !== "boolean") {
      issues.push({ path: `${path}.${key}`, code: "invalid_value", message: "Failure flags must be booleans." });
      valid = false;
    }
  }
  if ("errorCode" in value && value.errorCode !== undefined && !isSafeString(value.errorCode)) {
    issues.push({ path: `${path}.errorCode`, code: "invalid_value", message: "Error code must be a safe string when supplied." });
    valid = false;
  }
  if ("measuredAt" in value && value.measuredAt !== undefined && (!isSafeString(value.measuredAt) || Number.isNaN(Date.parse(value.measuredAt)))) {
    issues.push({ path: `${path}.measuredAt`, code: "invalid_value", message: "Measured timestamp must be a valid date string." });
    valid = false;
  }
  if (!valid || coverage === undefined) return undefined;
  return {
    ...coverage,
    measurementId: value.measurementId as string,
    sampleId: value.sampleId as string,
    runId: value.runId as string,
    value: value.value as number,
    unit: value.unit as PerformanceMeasurement["unit"],
    status: value.status as PerformanceMeasurement["status"],
    source: value.source as PerformanceMeasurement["source"],
    unexpectedError: value.unexpectedError as boolean,
    timeout: value.timeout as boolean,
    correctnessFailure: value.correctnessFailure as boolean,
    errorCode: value.errorCode as string | undefined,
    measuredAt: value.measuredAt as string | undefined,
  };
};

const validateRegression = (value: unknown, path: string, issues: PerformanceValidationIssue[]): PerformanceRegressionBaseline | undefined => {
  if (!isRecord(value)) {
    issues.push({ path, code: "invalid_type", message: "Regression baseline must be an object." });
    return undefined;
  }
  addUnknownFields(value, ["groupKey", "percentile", "value", "unit", "acceptedBuild"], path, issues);
  const groupKey = requireString(value, "groupKey", path, issues);
  const acceptedBuild = requireString(value, "acceptedBuild", path, issues);
  const validPercentile = validatePercentile(value.percentile, `${path}.percentile`, issues);
  if (!("value" in value) || !isFiniteNonNegative(value.value)) {
    issues.push({ path: `${path}.value`, code: "invalid_value", message: "Baseline value must be finite and non-negative." });
  }
  if (!("unit" in value) || !["ms", "score"].includes(value.unit as string)) {
    issues.push({ path: `${path}.unit`, code: "invalid_value", message: "Unit must be ms or score." });
  }
  if (groupKey === undefined || acceptedBuild === undefined || !validPercentile || !isFiniteNonNegative(value.value) || !["ms", "score"].includes(value.unit as string)) return undefined;
  return {
    groupKey,
    percentile: value.percentile as number,
    value: value.value as number,
    unit: value.unit as PerformanceRegressionBaseline["unit"],
    acceptedBuild,
  };
};

export const validatePerformanceBudget = (value: unknown, path = "budget"): PerformanceValidationResult<PerformanceBudget> => {
  const issues: PerformanceValidationIssue[] = [];
  if (!isRecord(value)) return { ok: false, issues: [{ path, code: "invalid_type", message: "Budget must be an object." }] };
  addUnknownFields(value, ["id", "parentId", "metric", "percentile", "unit", "maximum", "surface", "kind", "scope"], path, issues);
  const id = requireString(value, "id", path, issues);
  const metric = requireString(value, "metric", path, issues);
  const scope = requireString(value, "scope", path, issues);
  const validPercentile = validatePercentile(value.percentile, `${path}.percentile`, issues);
  const validUnit = ["ms", "score"].includes(value.unit as string);
  if (!validUnit) issues.push({ path: `${path}.unit`, code: "invalid_value", message: "Unit must be ms or score." });
  const surface = value.surface;
  if (![
    "browser",
    "service",
    "native",
    "job",
  ].includes(surface as string)) issues.push({ path: `${path}.surface`, code: "invalid_value", message: "Unknown budget surface." });
  const validKind = ["standard", "large_workload"].includes(value.kind as string);
  if (!validKind) issues.push({ path: `${path}.kind`, code: "invalid_value", message: "Budget kind must be standard or large_workload." });
  if ("parentId" in value && value.parentId !== undefined && !isSafeString(value.parentId)) issues.push({ path: `${path}.parentId`, code: "invalid_value", message: "Parent id must be a safe string." });
  if ("maximum" in value && value.maximum !== undefined && !isFiniteNonNegative(value.maximum)) issues.push({ path: `${path}.maximum`, code: "invalid_value", message: "Maximum must be finite and non-negative." });
  if (value.kind === "standard" && !isFiniteNonNegative(value.maximum)) issues.push({ path: `${path}.maximum`, code: "missing_field", message: "Standard budgets require a finite maximum." });
  const valid = issues.length === 0 && id !== undefined && metric !== undefined && scope !== undefined && validPercentile && validUnit && validKind;
  if (!valid) return { ok: false, issues };
  return {
    ok: true,
    issues,
    value: {
      id,
      parentId: value.parentId as string | undefined,
      metric: metric as PerformanceBudget["metric"],
      percentile: value.percentile as number,
      unit: value.unit as PerformanceBudget["unit"],
      maximum: value.maximum as number | undefined,
      surface: surface as PerformanceBudget["surface"],
      kind: value.kind as PerformanceBudget["kind"],
      scope,
    },
  };
};

export const validatePerformanceCoverage = (value: unknown, path = "coverage"): PerformanceValidationResult<PerformanceCoverage> => {
  const issues: PerformanceValidationIssue[] = [];
  const coverage = validateCoverage(value, path, issues);
  if (coverage === undefined || issues.length > 0) return { ok: false, issues };
  return { ok: true, issues, value: coverage };
};

export const validatePerformanceCoverageInventory = (input: unknown): PerformanceValidationResult<PerformanceCoverageInventory> => {
  const issues: PerformanceValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "inventory", code: "invalid_type", message: "Coverage inventory must be an object." }] };
  addUnknownFields(input, ["schema", "contractVersion", "inventoryId", "coverage"], "inventory", issues);
  const schema = requireString(input, "schema", "inventory", issues);
  if (schema !== undefined && schema !== PERFORMANCE_COVERAGE_SCHEMA) issues.push({ path: "inventory.schema", code: "invalid_value", message: `Expected ${PERFORMANCE_COVERAGE_SCHEMA}.` });
  const contractVersion = requireString(input, "contractVersion", "inventory", issues);
  if (contractVersion !== undefined && contractVersion !== PERFORMANCE_CONTRACT_VERSION) issues.push({ path: "inventory.contractVersion", code: "invalid_value", message: `Expected ${PERFORMANCE_CONTRACT_VERSION}.` });
  const inventoryId = requireString(input, "inventoryId", "inventory", issues);
  const coverageValues: PerformanceCoverage[] = [];
  if (!Array.isArray(input.coverage)) issues.push({ path: "inventory.coverage", code: "invalid_type", message: "Coverage inventory must contain an array." });
  else input.coverage.forEach((value, index) => {
    const result = validateCoverage(value, `inventory.coverage[${index}]`, issues);
    if (result !== undefined) coverageValues.push(result);
  });
  const keys = new Set<string>();
  coverageValues.forEach((coverage, index) => {
    const key = JSON.stringify([
      coverage.budgetId,
      coverage.metric,
      coverage.variant ?? "",
      coverage.surface,
      coverage.caseId,
      coverage.device,
      coverage.network,
      coverage.dataScale,
      coverage.cacheState,
      coverage.appearance,
      coverage.providerState,
    ]);
    if (keys.has(key)) issues.push({ path: `inventory.coverage[${index}]`, code: "invalid_value", message: "Coverage inventory contains a duplicate group." });
    keys.add(key);
  });
  if (issues.length > 0 || schema === undefined || contractVersion === undefined || inventoryId === undefined) return { ok: false, issues };
  return {
    ok: true,
    issues,
    value: {
      schema: PERFORMANCE_COVERAGE_SCHEMA,
      contractVersion,
      inventoryId,
      coverage: coverageValues,
    },
  };
};

export const validatePerformanceMeasurement = (value: unknown, path = "measurement"): PerformanceValidationResult<PerformanceMeasurement> => {
  const issues: PerformanceValidationIssue[] = [];
  const measurement = validateMeasurement(value, path, issues);
  if (measurement === undefined || issues.length > 0) return { ok: false, issues };
  return { ok: true, issues, value: measurement };
};

export const validatePerformanceContract = (contract: PerformanceContract): readonly PerformanceValidationIssue[] => {
  const issues: PerformanceValidationIssue[] = [];
  if (!isRecord(contract)) return [{ path: "contract", code: "invalid_type", message: "Contract must be an object." }];
  if (!isSafeString(contract.version)) issues.push({ path: "contract.version", code: "invalid_value", message: "Contract version is required." });
  if (!Array.isArray(contract.budgets) || contract.budgets.length === 0) issues.push({ path: "contract.budgets", code: "invalid_value", message: "Contract must define at least one budget." });
  else {
    const budgetIds = new Set<string>();
    contract.budgets.forEach((candidate, index) => {
      const result = validatePerformanceBudget(candidate, `contract.budgets[${index}]`);
      issues.push(...result.issues);
      if (result.value !== undefined) {
        if (budgetIds.has(result.value.id)) issues.push({ path: `contract.budgets[${index}].id`, code: "invalid_value", message: `Duplicate budget id ${result.value.id}.` });
        budgetIds.add(result.value.id);
      }
    });
  }
  const minimumSamples = (isRecord(contract.minimumSamples) ? contract.minimumSamples : {}) as Partial<Record<PerformanceSurface, unknown>>;
  for (const surface of ["browser", "service", "native", "job"] as const) {
    if (!isFinitePositiveInteger(minimumSamples[surface])) issues.push({ path: `contract.minimumSamples.${surface}`, code: "invalid_value", message: "Minimum samples must be a positive integer." });
  }
  if (!isFinitePositiveInteger(contract.minimumIndependentRuns)) issues.push({ path: "contract.minimumIndependentRuns", code: "invalid_value", message: "Minimum independent runs must be a positive integer." });
  if (!Array.isArray(contract.largeWorkloadGroups) || contract.largeWorkloadGroups.some((group) => !isSafeString(group))) issues.push({ path: "contract.largeWorkloadGroups", code: "invalid_value", message: "Large workload groups must be safe strings." });
  else if (new Set(contract.largeWorkloadGroups).size !== contract.largeWorkloadGroups.length) issues.push({ path: "contract.largeWorkloadGroups", code: "invalid_value", message: "Large workload groups must be unique." });
  return issues;
};

export const validatePerformanceEvidence = (input: unknown): PerformanceValidationResult<PerformanceEvidence> => {
  const issues: PerformanceValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "evidence", code: "invalid_type", message: "Evidence must be an object." }] };
  addUnknownFields(input, ["schema", "contractVersion", "buildIdentity", "capturedAt", "coverage", "measurements", "regressionBaselines"], "evidence", issues);
  const schema = requireString(input, "schema", "evidence", issues);
  if (schema !== undefined && schema !== PERFORMANCE_EVIDENCE_SCHEMA) issues.push({ path: "evidence.schema", code: "invalid_value", message: `Expected ${PERFORMANCE_EVIDENCE_SCHEMA}.` });
  const contractVersion = requireString(input, "contractVersion", "evidence", issues);
  if (contractVersion !== undefined && contractVersion !== PERFORMANCE_CONTRACT_VERSION) issues.push({ path: "evidence.contractVersion", code: "invalid_value", message: `Expected ${PERFORMANCE_CONTRACT_VERSION}.` });
  const buildIdentity = requireString(input, "buildIdentity", "evidence", issues);
  const capturedAt = requireString(input, "capturedAt", "evidence", issues);
  if (capturedAt !== undefined && Number.isNaN(Date.parse(capturedAt))) issues.push({ path: "evidence.capturedAt", code: "invalid_value", message: "Captured timestamp must be a valid date string." });
  const coverageValues: PerformanceCoverage[] = [];
  if (!Array.isArray(input.coverage)) issues.push({ path: "evidence.coverage", code: "invalid_type", message: "Coverage must be an array." });
  else input.coverage.forEach((value, index) => {
    const result = validateCoverage(value, `evidence.coverage[${index}]`, issues);
    if (result !== undefined) coverageValues.push(result);
  });
  const measurements: PerformanceMeasurement[] = [];
  if (!Array.isArray(input.measurements)) issues.push({ path: "evidence.measurements", code: "invalid_type", message: "Measurements must be an array." });
  else input.measurements.forEach((value, index) => {
    const result = validateMeasurement(value, `evidence.measurements[${index}]`, issues);
    if (result !== undefined) measurements.push(result);
  });
  const measurementIds = new Set<string>();
  measurements.forEach((measurement, index) => {
    if (measurementIds.has(measurement.measurementId)) issues.push({ path: `evidence.measurements[${index}].measurementId`, code: "invalid_value", message: `Duplicate measurement id ${measurement.measurementId}.` });
    measurementIds.add(measurement.measurementId);
  });
  const regressionBaselines: PerformanceRegressionBaseline[] = [];
  if ("regressionBaselines" in input && input.regressionBaselines !== undefined) {
    if (!Array.isArray(input.regressionBaselines)) issues.push({ path: "evidence.regressionBaselines", code: "invalid_type", message: "Regression baselines must be an array." });
    else input.regressionBaselines.forEach((value, index) => {
      const result = validateRegression(value, `evidence.regressionBaselines[${index}]`, issues);
      if (result !== undefined) regressionBaselines.push(result);
    });
  }
  const baselineKeys = new Set<string>();
  regressionBaselines.forEach((baseline, index) => {
    if (baselineKeys.has(baseline.groupKey)) issues.push({ path: `evidence.regressionBaselines[${index}].groupKey`, code: "invalid_value", message: `Duplicate regression baseline for ${baseline.groupKey}.` });
    baselineKeys.add(baseline.groupKey);
  });
  if (issues.length > 0 || schema === undefined || contractVersion === undefined || buildIdentity === undefined || capturedAt === undefined) return { ok: false, issues };
  return {
    ok: true,
    issues,
    value: {
      schema: PERFORMANCE_EVIDENCE_SCHEMA,
      contractVersion,
      buildIdentity,
      capturedAt,
      coverage: coverageValues,
      measurements,
      regressionBaselines,
    },
  };
};

/** The release evaluator's source of truth. Exported for callers that need to display it. */
export const DEFAULT_PERFORMANCE_CONTRACT = PERFORMANCE_CONTRACT;
