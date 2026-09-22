import { sha256 } from "./hash";
import type { ExportException, ExportError, RedactedExportManifest } from "./types";

/** One-way source identifier suitable for a manifest or diagnostic event. */
export function redactIdentifier(value: unknown): string {
  return `id_${sha256(String(value)).slice(0, 16)}`;
}

export function redactException(exception: ExportException): ExportException {
  return {
    code: exception.code,
    collection: exception.collection,
    // Collectors already store only a one-way sourceIdHash. Do not hash it again
    // during manifest rendering; resume and repeated runs must be comparable.
    ...(exception.sourceIdHash ? { sourceIdHash: exception.sourceIdHash } : {}),
    detail: exception.detail,
  };
}

export function redactError(error: ExportError): ExportError {
  return {
    collection: error.collection,
    code: error.code,
    ...(typeof error.status === "number" ? { status: error.status } : {}),
    ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
  };
}

/**
 * Manifest construction is deliberately allow-list based. The raw payload never
 * passes through this function, so names, addresses, email, phone, and narratives
 * cannot accidentally leak into a normal operator artifact.
 */
export function redactedManifest(input: RedactedExportManifest): RedactedExportManifest {
  return {
    version: "rm-export-manifest/v2",
    runId: input.runId,
    source: "rent_manager",
    createdAt: input.createdAt,
    ...(input.artifactObservationOn ? { artifactObservationOn: input.artifactObservationOn } : {}),
    registryHash: input.registryHash,
    ...(input.archiveEnvelopeSha256 ? { archiveEnvelopeSha256: input.archiveEnvelopeSha256 } : {}),
    complete: input.complete,
    rawArchive: { relativePath: input.rawArchive.relativePath, mode: "0600", directoryMode: "0700" },
    counts: Object.fromEntries(Object.entries(input.counts).map(([key, count]) => [key, Number(count)])),
    collections: input.collections.map((collection) => ({
      name: collection.name,
      path: collection.path,
      outputKey: collection.outputKey,
      required: collection.required,
      kind: collection.kind,
      status: collection.status,
      pages: collection.pages,
      requested: collection.requested,
      received: collection.received,
      ...(typeof collection.expected === "number" ? { expected: collection.expected } : {}),
      recordHashes: [...collection.recordHashes],
      errors: [...collection.errors],
      exceptions: collection.exceptions.map(redactException),
      ...(typeof collection.parentCount === "number" ? { parentCount: collection.parentCount } : {}),
      ...(collection.partitionCounts ? { partitionCounts: { ...collection.partitionCounts } } : {}),
      ...(collection.clientSideValidation ? { clientSideValidation: collection.clientSideValidation } : {}),
      ...(collection.documentMode ? { documentMode: collection.documentMode } : {}),
      ...(collection.unsupportedReason ? { unsupportedReason: collection.unsupportedReason } : {}),
    })),
    errors: input.errors.map(redactError),
    exceptions: input.exceptions.map(redactException),
    documentBinarySummary: { ...input.documentBinarySummary },
  };
}

/** Error messages from an arbitrary transport are never safe to include. */
export function safeTransportError(error: unknown): { code: string; status?: number; retryable?: boolean } {
  const candidate = error as { code?: unknown; status?: unknown; retryable?: unknown } | null;
  const code = typeof candidate?.code === "string" && /^[a-z0-9_:-]+$/i.test(candidate.code) ? candidate.code : "transport_error";
  const status = typeof candidate?.status === "number" && Number.isInteger(candidate.status) ? candidate.status : undefined;
  const retryable = typeof candidate?.retryable === "boolean" ? candidate.retryable : undefined;
  return { code, ...(status === undefined ? {} : { status }), ...(retryable === undefined ? {} : { retryable }) };
}
