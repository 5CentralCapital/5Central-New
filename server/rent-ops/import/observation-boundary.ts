import { canonicalJson, sha256 } from "../export/hash";
import type { ExportCheckpoint, ExportEnvelope, RedactedExportManifest } from "../export/types";

export const OBSERVATION_PROVENANCE_FILE = "observation-boundary-provenance.json";
export interface ObservationBoundaryProvenance {
  version: "rm-observation-boundary/v1";
  sourceRunId: string;
  derivation: "completed-capture-single-utc-day";
  captureStartedAt: string;
  captureCompletedAt: string;
  artifactObservationOn: string;
  parentEnvelopeSha256: string;
  parentManifestSha256: string;
  checkpointSha256: string;
  derivativeEnvelopeSha256: string;
  derivativeManifestSha256: string;
}
const digest = (value: unknown) => sha256(canonicalJson(value));
function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error("observation_boundary_provenance_invalid");
}
/** A date boundary, not an assertion that the sequential export was atomic. */
export function deriveObservationBoundary(envelope: ExportEnvelope, manifest: RedactedExportManifest, checkpointBytes: Uint8Array) {
  const checkpoint = JSON.parse(Buffer.from(checkpointBytes).toString("utf8")) as ExportCheckpoint;
  requireValid(!("artifactObservationOn" in envelope) && !("artifactObservationOn" in manifest) && !("artifactObservationOn" in envelope.payload));
  requireValid(envelope.runId === manifest.runId && envelope.runId === checkpoint.runId && manifest.complete === true && checkpoint.complete === true);
  requireValid(manifest.archiveEnvelopeSha256 === digest(envelope) && checkpoint.registryHash === manifest.registryHash);
  const start = checkpoint.startedAt, end = checkpoint.updatedAt;
  const validTime = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  requireValid(validTime(start) && validTime(end) && start <= end && start.slice(0, 10) === end.slice(0, 10));
  requireValid(envelope.createdAt === start && manifest.createdAt === start);
  const artifactObservationOn = start.slice(0, 10);
  const derivedEnvelope = { ...envelope, artifactObservationOn } as ExportEnvelope;
  const derivedManifest = { ...manifest, artifactObservationOn, archiveEnvelopeSha256: digest(derivedEnvelope) } as RedactedExportManifest;
  const provenance: ObservationBoundaryProvenance = {
    version: "rm-observation-boundary/v1", sourceRunId: envelope.runId,
    derivation: "completed-capture-single-utc-day", captureStartedAt: start, captureCompletedAt: end,
    artifactObservationOn, parentEnvelopeSha256: digest(envelope), parentManifestSha256: digest(manifest),
    checkpointSha256: sha256(checkpointBytes), derivativeEnvelopeSha256: digest(derivedEnvelope), derivativeManifestSha256: digest(derivedManifest),
  };
  return { envelope: derivedEnvelope, manifest: derivedManifest, provenance };
}

export function verifyObservationBoundary(envelope: ExportEnvelope, manifest: RedactedExportManifest, checkpointBytes: Uint8Array, provenance: unknown): void {
  requireValid(typeof provenance === "object" && provenance !== null && !Array.isArray(provenance));
  const receipt = provenance as ObservationBoundaryProvenance;
  const parentEnvelope = { ...envelope }; delete parentEnvelope.artifactObservationOn;
  const parentManifest = { ...manifest, archiveEnvelopeSha256: receipt.parentEnvelopeSha256 }; delete parentManifest.artifactObservationOn;
  const expected = deriveObservationBoundary(parentEnvelope, parentManifest, checkpointBytes);
  requireValid(canonicalJson(expected.provenance) === canonicalJson(provenance));
  requireValid(canonicalJson(expected.envelope) === canonicalJson(envelope) && canonicalJson(expected.manifest) === canonicalJson(manifest));
}
