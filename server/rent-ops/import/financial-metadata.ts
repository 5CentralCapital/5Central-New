import { deriveFinancialProtocol, type FinancialProtocolPlan } from "./financial-protocol";
import { canonicalJson, sha256 } from "../export/hash";
import { deriveObservedFinancialCrosswalk } from "../export/observed-financial-crosswalk";
import type { ExportEnvelope, RedactedExportManifest } from "../export/types";
import { verifyObservationBoundary } from "./observation-boundary";
export const FINANCIAL_METADATA_PROVENANCE_FILE = "financial-metadata-provenance.json";
const digest = (value: unknown) => sha256(canonicalJson(value));
function check(value: unknown): asserts value { if (!value) throw new Error("financial_metadata_provenance_invalid"); }
export function deriveFinancialMetadata(envelope: ExportEnvelope, manifest: RedactedExportManifest, checkpointBytes: Uint8Array, observationBytes: Uint8Array, protocolPlan?: FinancialProtocolPlan) {
  verifyObservationBoundary(envelope, manifest, checkpointBytes, JSON.parse(Buffer.from(observationBytes).toString("utf8")));
  check(!("artifactSha256" in envelope.payload) && !("financialSemanticCrosswalk" in envelope.payload) && !("financialReviewHolds" in envelope.payload));
  check(!envelope.supplementEvidence);
  const parentEnvelopeSha256 = digest(envelope);
  check(manifest.archiveEnvelopeSha256 === parentEnvelopeSha256);
  const protocol = protocolPlan ? deriveFinancialProtocol(envelope.payload, parentEnvelopeSha256, protocolPlan) : undefined;
  const financialSemanticCrosswalk = protocol?.financialSemanticCrosswalk ?? deriveObservedFinancialCrosswalk(envelope.payload, parentEnvelopeSha256);
  const derivedEnvelope: ExportEnvelope = { ...envelope, payload: { ...envelope.payload, artifactSha256: parentEnvelopeSha256, financialSemanticCrosswalk, ...(protocol ? { financialReviewHolds: protocol.financialReviewHolds } : {}) } };
  const derivedManifest = { ...manifest, ...(protocol ? { counts: { ...manifest.counts, financialReviewHolds: protocol.financialReviewHolds.length } } : {}), archiveEnvelopeSha256: digest(derivedEnvelope) };
  const provenance = {
    version: protocolPlan ? "rm-financial-metadata/v2" : "rm-financial-metadata/v1", derivation: protocolPlan ? "documented-recorded-ledger-protocol-v1" : "observed-source-enums-exact-v1", sourceRunId: envelope.runId,
    ...(protocolPlan ? { protocolPlan, protocolPlanSha256: digest(protocolPlan) } : {}),
    parentEnvelopeSha256, parentManifestSha256: digest(manifest),
    checkpointSha256: sha256(checkpointBytes), observationProvenanceSha256: sha256(observationBytes),
    crosswalkSha256: digest(financialSemanticCrosswalk),
    derivativeEnvelopeSha256: digest(derivedEnvelope), derivativeManifestSha256: digest(derivedManifest),
  };
  return { envelope: derivedEnvelope, manifest: derivedManifest, provenance };
}
export function verifyFinancialMetadata(envelope: ExportEnvelope, manifest: RedactedExportManifest, checkpointBytes: Uint8Array, observationBytes: Uint8Array, provenance: unknown) {
  check(provenance && typeof provenance === "object" && !Array.isArray(provenance));
  const receipt = provenance as ReturnType<typeof deriveFinancialMetadata>["provenance"];
  const payload = { ...envelope.payload }; delete payload.artifactSha256; delete payload.financialSemanticCrosswalk;
  if (receipt.version === "rm-financial-metadata/v2") delete payload.financialReviewHolds;
  const parentEnvelope = { ...envelope, payload };
  const counts = { ...manifest.counts };
  if (receipt.version === "rm-financial-metadata/v2") delete counts.financialReviewHolds;
  const parentManifest = { ...manifest, counts, archiveEnvelopeSha256: receipt.parentEnvelopeSha256 };
  const expected = deriveFinancialMetadata(parentEnvelope, parentManifest, checkpointBytes, observationBytes, receipt.version === "rm-financial-metadata/v2" ? receipt.protocolPlan : undefined);
  check(canonicalJson(expected.provenance) === canonicalJson(provenance));
  check(canonicalJson(expected.envelope) === canonicalJson(envelope) && canonicalJson(expected.manifest) === canonicalJson(manifest));
  return { envelope: parentEnvelope, manifest: parentManifest };
}
