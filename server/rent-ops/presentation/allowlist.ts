/**
 * Small runtime helpers used by every Rent Operations response serializer.
 *
 * The persistence and import layers intentionally have a much wider shape
 * than the browser/API contract. Presentation code therefore constructs
 * response objects from explicit fields instead of cloning input objects.
 */

export const FORBIDDEN_PRESENTATION_KEYS = [
  "source",
  "sourceId",
  "sourceSystem",
  "sourceUpdatedAt",
  "sourceRecord",
  "sourceRecords",
  "sourceRecordId",
  "sourceRef",
  "sourceRefs",
  "sourceCollection",
  "sourceEntity",
  "sourceBinaryBinding",
  "import",
  "imports",
  "importRecord",
  "importRecords",
  "importRun",
  "importRuns",
  "importRunId",
  "manifest",
  "manifestHash",
  "sourceManifest",
  "sourceManifestHash",
  "checkpoint",
  "resume",
  "resumeToken",
  "resumeTokenHash",
  "resumeTokenExpiresAt",
  "token",
  "hash",
  "digest",
  "raw",
  "rawMetadata",
  "rawPayload",
  "rawJson",
  "restricted",
  "restrictedPayload",
  "restrictedRows",
  "restrictedInput",
  "payload",
  "storage",
  "storageKey",
  "checksum",
  "checksumSha256",
  "metadataChecksumSha256",
  "backend",
  "bucket",
  "key",
  "generation",
  "immutableGeneration",
  "logicalKey",
  "verification",
  "version",
  "signedUrl",
  "signed URL",
  "downloadUrl",
  "provenance",
  "provenanceSha256",
  "sourceDefinitionId",
  "sourceDefinitionKey",
  "chargeDefinitionKey",
] as const;

const forbiddenKeys = new Set<string>(FORBIDDEN_PRESENTATION_KEYS.map((key) => key.toLowerCase()));

export const PRESENTATION_ERROR_CODES = [
  "invalid_input",
  "invalid_target_id",
  "not_found",
  "not_authorized",
  "rate_limited",
  "conflict",
  "versioned_schedule_required",
  "activity_append_only",
  "hap_create_requires_provenance",
  "unknown_report",
  "unsafe_output",
  "temporarily_unavailable",
  "verified_upload_required",
  "request_failed",
] as const;

export type PresentationErrorCode = (typeof PRESENTATION_ERROR_CODES)[number];

export class RentOpsPresentationError extends Error {
  readonly code: PresentationErrorCode;

  constructor(code: PresentationErrorCode) {
    super(code);
    this.name = "RentOpsPresentationError";
    this.code = code;
  }
}

export type JsonObject = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Preserve an explicit v8 NULL without turning an absent field into NULL. */
export function nullableStringValue(value: unknown): string | null | undefined {
  if (value === null) return null;
  return stringValue(value);
}

export function finiteNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Preserve an explicit v8 NULL without inventing a value for an omitted field. */
export function nullableNumberValue(value: unknown): number | null | undefined {
  if (value === null) return null;
  return finiteNumberValue(value);
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Preserve an explicit v8 NULL without inventing a boolean default. */
export function nullableBooleanValue(value: unknown): boolean | null | undefined {
  if (value === null) return null;
  return booleanValue(value);
}

export function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.filter((item): item is string => typeof item === "string");
  return result;
}

export function recordArrayValue(value: unknown): JsonObject[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isRecord);
}

export function isForbiddenPresentationKey(key: string): boolean {
  return forbiddenKeys.has(key.toLowerCase());
}

/**
 * Verifies an already-built response. This is a second line of defence for
 * future serializers and for route integration tests; serializers still use
 * positive allowlists and never rely on this function to redact input.
 */
export function assertPresentationSafe(value: unknown): void {
  const visit = (candidate: unknown, seen: Set<object>): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, seen);
      return;
    }
    if (!isRecord(candidate)) return;
    if (seen.has(candidate)) throw new RentOpsPresentationError("unsafe_output");
    seen.add(candidate);
    for (const [key, child] of Object.entries(candidate)) {
      if (isForbiddenPresentationKey(key)) throw new RentOpsPresentationError("unsafe_output");
      visit(child, seen);
    }
    seen.delete(candidate);
  };
  visit(value, new Set<object>());
}

export const assertNoForbiddenKeys = assertPresentationSafe;

function withoutUndefined(input: object): JsonObject {
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}

/** Build an object from an explicit allowlist and omit undefined fields. */
export function pickAllowed(input: unknown, keys: readonly string[]): JsonObject {
  if (!isRecord(input)) return {};
  const output: JsonObject = {};
  for (const key of keys) {
    if (isForbiddenPresentationKey(key)) continue;
    const value = input[key];
    if (value !== undefined) output[key] = value;
  }
  assertPresentationSafe(output);
  return output;
}

/** Build an object from serializer-produced values and verify it immediately. */
export function presentationObject<T extends object>(input: T): T {
  const output = withoutUndefined(input);
  assertPresentationSafe(output);
  return output as T;
}

export function errorBody(code: PresentationErrorCode): { code: PresentationErrorCode } {
  return { code };
}

function isPresentationErrorCode(value: unknown): value is PresentationErrorCode {
  return typeof value === "string" && (PRESENTATION_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Convert arbitrary route/service failures to the deliberately tiny public
 * error surface. No service message, validation detail, stack, or provider
 * text is ever copied into the response.
 */
export function serializePresentationError(error: unknown): { code: PresentationErrorCode } {
  if (error instanceof RentOpsPresentationError) return errorBody(error.code);
  if (isRecord(error) && isPresentationErrorCode(error.code)) return errorBody(error.code);
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("not found")) return errorBody("not_found");
  if (message.includes("unauthorized") || message.includes("authentication") || message.includes("forbidden")) return errorBody("not_authorized");
  if (message.includes("too many") || message.includes("rate limit")) return errorBody("rate_limited");
  if (message.includes("invalid") || message.includes("required") || message.includes("must ") || message.includes("provenance") || message.includes("allowlist") || message.includes("patch contains")) return errorBody("invalid_input");
  return errorBody("request_failed");
}

export const serializeError = serializePresentationError;

/** Validate the final boundary value in tests and in route adapters. */
export function present<T>(value: T): T {
  assertPresentationSafe(value);
  return value;
}
