import type {
  ImportEntityType,
  ImportMappingException,
  RentManagerImportInput,
  RentManagerImportResult,
  RentManagerRawRecord,
  IsoDate,
} from "../../../shared/rent-ops-contracts";
import { isoDateSchema } from "../../../shared/rent-ops-contracts";
import { canonicalJson, sha256 } from "../export/hash";
import { approvedSupplementEvidenceValid, normalizeRentManagerExport, type NormalizationException } from "../export/normalizer";
import type { ExportEnvelope, RedactedExportManifest } from "../export/types";
import { projectApplicationHistoryForImport } from "../application-history/projection";
import { mapRentManagerExport, moneyControlCounts, reconcileRentManagerImport, type RentOpsTargetIdFactory } from "./rm-mapper";
import type { RentManagerTargetIdentityOptions } from "../../../shared/rent-ops-contracts";
import {
  APPROVED_RM_NORMALIZER_ARTIFACT,
  approvedArchiveEnvelopeSha256,
  approvedArtifactBindingSha256,
  approvedControlsSha256,
  approvedMappedRowsSha256,
  approvedNormalizedRowsSha256,
  approvedRestrictedRowsSha256,
  verifiedSupplementReceiptReasons,
  verifiedSupplementReceiptSha256,
  type ApprovedPersistenceImportArtifact,
  type ApprovedImportBinding,
  type ImportControlTotals,
  type RentManagerExportEnvelope,
  type VerifiedSupplementReceiptBinding,
} from "./persistence-importer";

export const RENT_MANAGER_NORMALIZER_VERSION = "rent-manager-normalizer/2026-08-17.1";

const SHA256 = /^[a-f0-9]{64}$/i;

export interface MigrationArtifactReport {
  archiveEnvelopeSha256: string;
  manifestSha256: string;
  normalizationReportSha256: string;
  normalizedRowsSha256: string;
  controlsSha256: string;
  mappedRowsSha256: string;
  restrictedRowsSha256: string;
  artifactBindingSha256: string;
  normalizerVersion: string;
  sourceRunId: string;
  artifactObservationOn?: IsoDate;
  rawCollectionCounts: Record<string, number>;
  normalizedRecordCounts: Record<string, number>;
  mappedSourceCounts: Record<string, number>;
  normalizationExceptionCount: number;
  mappingWarningCount: number;
  mappingErrorCount: number;
  blockingReasons: string[];
}

export interface MigrationArtifactCandidate {
  artifact?: ApprovedPersistenceImportArtifact;
  report: MigrationArtifactReport;
  /** In-memory only. Callers must never log or serialize this outside the restricted path. */
  normalizedResult: RentManagerImportResult;
  /** In-memory replay binding; never serialized into the artifact. */
  targetIdFactory?: RentOpsTargetIdFactory;
  targetIdentity?: RentManagerTargetIdentityOptions;
  /** In-memory proof read from the descriptor-verified derivative archive. */
  verifiedSupplementReceipt?: VerifiedSupplementReceiptBinding;
}

/**
 * An approved artifact is a binding between the exact redacted manifest and
 * the exact export envelope.  PersistenceImporter intentionally accepts the
 * already-approved shape, so the restricted boundary must verify that
 * binding immediately before handing the artifact to it.  This error only
 * contains stable reason codes; the envelope and manifest are never included
 * in an exception or log message.
 */
export class MigrationArtifactIntegrityError extends Error {
  readonly reasons: string[];

  constructor(reasons: readonly string[]) {
    const safeReasons = Array.from(new Set(reasons.map((reason) => safeCode(reason))));
    super(`Rent Manager migration artifact integrity check failed: ${safeReasons.join("; ")}`);
    this.name = "MigrationArtifactIntegrityError";
    this.reasons = safeReasons;
  }
}

function safeCode(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120) || "invalid";
}

function validObservation(value: unknown): value is IsoDate {
  return isoDateSchema.safeParse(value).success;
}

function recordCounts(value: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
      .map(([key, rows]) => [key, rows.length])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  );
}

function manifestCountReasons(payloadCounts: Record<string, number>, manifestCounts: Record<string, number>): string[] {
  const keys = new Set([...Object.keys(payloadCounts), ...Object.keys(manifestCounts)]);
  return Array.from(keys)
    .filter((key) => payloadCounts[key] !== manifestCounts[key])
    .map((key) => `manifest_count_mismatch_${safeCode(key)}`);
}

function restrictedIdentityReasons(payload: Record<string, unknown>): string[] {
  for (const [collection, value] of Object.entries(payload)) {
    // The artifact-bound HAP status crosswalk is immutable metadata, not a
    // source-row collection. It is keyed by its artifact hash and therefore
    // intentionally has no sourceId field.
    if (collection === "hapStatusCrosswalk" || collection === "applicationHistoryStatusCrosswalk" || collection === "financialReviewHolds") continue;
    if (!Array.isArray(value)) continue;
    for (const candidate of value) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return ["restricted_source_row_invalid"];
      const sourceId = String((candidate as Record<string, unknown>).sourceId ?? "").trim();
      if (!sourceId) return ["restricted_source_identity_missing"];
    }
  }
  return [];
}

function moneyCents(record: RentManagerRawRecord, ...keys: string[]): number | undefined {
  const key = keys.find((candidate) => record[candidate] !== undefined && record[candidate] !== null && record[candidate] !== "");
  if (!key) return undefined;
  const normalized = String(record[key]).trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return undefined;
  const [whole, fraction = ""] = normalized.split(".");
  const centsInput = key.toLowerCase().includes("cents");
  if ((centsInput && fraction.length > 0) || (!centsInput && fraction.length > 2)) return undefined;
  const result = centsInput ? Number(whole) : Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}

function sumMoney(records: readonly RentManagerRawRecord[] | undefined, ...keys: string[]): number {
  return (records ?? []).reduce((sum, record) => sum + (moneyCents(record, ...keys) ?? 0), 0);
}

function expectedSourceCounts(input: RentManagerImportInput): Partial<Record<ImportEntityType, number>> {
  return {
    property: input.properties?.length ?? 0,
    unit: input.units?.length ?? 0,
    person: (input.tenants?.length ?? 0) + (input.contacts?.length ?? 0),
    tenancy: input.leases?.length ?? 0,
    lease_term: input.leaseTerms?.length ?? 0,
    charge_definition: input.chargeTypes?.length ?? 0,
    recurring_schedule: input.recurringSchedules?.length ?? 0,
    ledger_transaction: (input.charges?.length ?? 0) + (input.payments?.length ?? 0) + (input.credits?.length ?? 0),
    payment_allocation: input.allocations?.length ?? 0,
    deposit: input.deposits?.length ?? 0,
    subsidy: (input.subsidies?.length ?? 0) + (input.hap?.length ?? 0),
    subsidy_tenant: input.subsidyTenants?.length ?? 0,
    subsidy_payment: input.subsidyPayments?.length ?? 0,
    application: input.applications?.length ?? 0,
    document: input.documents?.length ?? 0,
    activity: input.activities?.length ?? 0,
  };
}

function controlsFor(input: RentManagerImportInput): ImportControlTotals {
  const money = moneyControlCounts(input);
  return {
    counts: expectedSourceCounts(input),
    totalsCents: {
      charges: money.knownTotals.charges ?? sumMoney(input.charges, "amountCents", "amount"),
      payments: money.knownTotals.payments ?? sumMoney(input.payments, "amountCents", "amount"),
      credits: money.knownTotals.credits ?? sumMoney(input.credits, "amountCents", "amount"),
      allocations: money.knownTotals.allocations ?? sumMoney(input.allocations, "amountCents", "amount"),
      deposits: money.knownTotals.deposits ?? sumMoney(input.deposits, "amountHeldCents", "amount", "balance"),
    },
    hap: {
      agencyObligationCents: money.knownTotals.hapAgencyObligationCents ?? sumMoney(input.subsidies, "agencyObligationCents", "agencyAmountCents", "agencyAmount"),
      tenantObligationCents: money.knownTotals.hapTenantObligationCents ?? sumMoney(input.subsidies, "tenantObligationCents", "tenantAmountCents", "tenantAmount"),
    },
    unknownCounts: money.unknownCounts,
    invalidMoneyCounts: money.invalidCounts,
  };
}

function normalizationSeverity(exception: NormalizationException): ImportMappingException["severity"] {
  if (exception.confidence === "ambiguous") return "error";
  if (exception.collection === "hap") return "error";
  if ((exception.collection === "leases" && exception.detail === "lease_unit_not_returned") || (exception.collection === "units" && exception.detail === "market_rent_not_returned")) return "warning";
  if (/deposit_property_not_resolved|deposit_tenant_not_resolved/.test(exception.detail)) return "warning";
  if (exception.detail === "deposit_unit_id_not_returned_by_rm") return "warning";
  if (/_inferred(?:_|$)/.test(exception.detail)) return "warning";
  if (/primary_contact_phone_not_resolved/.test(exception.detail)) return "warning";
  if (exception.code === "missing_relationship" || exception.code === "incomplete_coverage") return "error";
  return "warning";
}

function mappingException(exception: NormalizationException): ImportMappingException {
  return {
    code: `normalization_${safeCode(exception.collection)}_${safeCode(exception.detail)}`,
    severity: normalizationSeverity(exception),
    ...(exception.sourceIdHash ? { sourceId: exception.sourceIdHash } : {}),
    message: `Rent Manager normalization ${safeCode(exception.detail)}`,
  };
}

function mappedSourceCounts(result: RentManagerImportResult): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of result.sourceRecords) counts[row.entityType] = (counts[row.entityType] ?? 0) + 1;
  return counts;
}

function restrictedEnvelope(envelope: ExportEnvelope, manifest: RedactedExportManifest, manifestHash: string): RentManagerExportEnvelope {
  // The caller has already checked the manifest hash against the exact
  // envelope.  Always carry that exact value instead of trusting an optional
  // manifest field, and carry the manifest digest in the private envelope
  // wrapper so a later boundary can reject a swapped manifest.
  const archiveEnvelopeSha256 = approvedArchiveEnvelopeSha256(envelope);
  return {
    ...envelope,
    payload: envelope.payload,
    archiveEnvelopeSha256,
    sourceManifestHash: archiveEnvelopeSha256,
    artifactObservationOn: envelope.artifactObservationOn,
    manifest: { archiveEnvelopeSha256, manifestSha256: manifestHash, artifactObservationOn: manifest.artifactObservationOn },
  } as unknown as RentManagerExportEnvelope;
}

function verifiedAnswerSupplement(
  envelope: ExportEnvelope,
  manifestSha256: string,
  receipt: VerifiedSupplementReceiptBinding | undefined,
): boolean {
  return Boolean(receipt)
    && verifiedSupplementReceiptReasons(envelope, receipt, manifestSha256).length === 0
    && approvedSupplementEvidenceValid(envelope.payload, envelope.supplementEvidence, envelope.runId);
}

function projectApplicationHistory(
  result: RentManagerImportResult,
  envelope: ExportEnvelope,
  artifactSha256: string,
  supplementApproved: boolean,
  targetIdFactory: RentOpsTargetIdFactory | undefined,
): string[] {
  const projected = projectApplicationHistoryForImport({
    ...envelope.payload,
    documentBinaries: envelope.documentBinaries,
  }, result.sourceRecords, {
    artifactSha256,
    supplementApproved,
    supplementEvidence: supplementApproved && envelope.supplementEvidence
      ? {
        rowSetSha256: envelope.supplementEvidence.rowSetSha256,
        attestationSha256: envelope.supplementEvidence.attestationSha256,
      }
      : undefined,
    targetIdFactory: targetIdFactory
      ? (entityType, sourceId) => targetIdFactory(entityType as ImportEntityType, sourceId)
      : undefined,
    statusCrosswalk: supplementApproved ? envelope.payload.applicationHistoryStatusCrosswalk : undefined,
  });
  result.snapshot.applicationHistory = projected.snapshot;
  for (const code of projected.blockingCodes) {
    result.exceptions.push({
      code,
      severity: "error",
      message: `Rent Manager application-history projection ${safeCode(code)}`,
    });
  }
  return projected.blockingCodes;
}

/**
 * Re-checks the immutable envelope/manifest binding on an approved artifact.
 * This is deliberately separate from artifact construction because an
 * in-memory caller could otherwise mutate `restrictedSourceInput` after the
 * artifact was built but before persistence begins.
 */
export function assertMigrationArtifactIntegrity(
  candidate: MigrationArtifactCandidate,
  envelope: ExportEnvelope,
  manifest: RedactedExportManifest,
): void {
  if (!candidate.artifact) throw new MigrationArtifactIntegrityError(["approved_artifact_missing"]);
  const artifact = candidate.artifact;
  const envelopeHash = approvedArchiveEnvelopeSha256(envelope);
  const manifestHash = sha256(canonicalJson(manifest));
  const privateEnvelope = artifact.restrictedSourceInput;
  const privateEnvelopeHash = approvedArchiveEnvelopeSha256(privateEnvelope);
  const privateManifestHash = privateEnvelope.manifest?.manifestSha256;
  const reasons: string[] = [];
  const receiptSha256 = candidate.verifiedSupplementReceipt
    ? verifiedSupplementReceiptSha256(candidate.verifiedSupplementReceipt)
    : undefined;
  const envelopeObservation = envelope.artifactObservationOn;
  const manifestObservation = manifest.artifactObservationOn;
  const observationOn = envelopeObservation ?? manifestObservation;
  const verifiedObservationOn = validObservation(observationOn) ? observationOn : undefined;
  if (!verifiedObservationOn || envelopeObservation !== manifestObservation) reasons.push("artifact_observation_boundary_invalid");
  let normalizedRowsSha256: string | undefined;
  let controlsSha256: string | undefined;
  let artifactControlsSha256: string | undefined;
  let mappedRowsSha256: string | undefined;
  let restrictedRowsSha256: string | undefined;
  try {
    if (!verifiedObservationOn) throw new Error("artifact_observation_boundary_missing");
    const normalizedReplay = normalizeRentManagerExport(envelope.payload, {
      sourceRunId: envelope.runId,
      approvedSupplementEvidence: verifiedAnswerSupplement(envelope, manifestHash, candidate.verifiedSupplementReceipt),
      artifactSha256: envelope.payload.artifactSha256 ?? envelopeHash,
      asOfDate: verifiedObservationOn,
      artifactObservationOn: verifiedObservationOn,
    });
    const normalizedInput = normalizedReplay.input;
    normalizedRowsSha256 = approvedNormalizedRowsSha256(normalizedInput);
    controlsSha256 = approvedControlsSha256(controlsFor(normalizedInput));
    artifactControlsSha256 = approvedControlsSha256(artifact.controls);
    mappedRowsSha256 = approvedMappedRowsSha256(artifact.normalizedResult);
    restrictedRowsSha256 = approvedRestrictedRowsSha256(privateEnvelope);
    if (artifact.normalizedResult.snapshot.modelVersion === 3 && candidate.targetIdFactory) {
      const replay = mapRentManagerExport(normalizedInput, {
        now: new Date(artifact.normalizedResult.importRun.startedAt),
        mode: artifact.normalizedResult.importRun.mode,
        sourceManifestHash: envelopeHash,
        targetIdFactory: candidate.targetIdFactory,
        targetIdentity: candidate.targetIdentity,
        fidelityVersion: 3,
        artifactSha256: envelope.payload.artifactSha256 ?? envelopeHash,
        artifactObservationOn: verifiedObservationOn,
      });
      replay.exceptions.push(...normalizedReplay.exceptions.map(mappingException));
      const replayControls = controlsFor(normalizedInput);
      const replayReconciliation = reconcileRentManagerImport(replay, normalizedInput, replayControls);
      for (const mismatch of replayReconciliation.mismatches) {
        replay.exceptions.push({ code: `reconciliation_${safeCode(mismatch.code)}_${safeCode(mismatch.metric)}`, severity: mismatch.severity, message: `Rent Manager reconciliation ${safeCode(mismatch.code)} for ${safeCode(mismatch.metric)}`, ...(mismatch.amountCents === undefined ? {} : { amountCents: mismatch.amountCents }) });
      }
      projectApplicationHistory(
        replay,
        envelope,
        envelope.payload.artifactSha256 ?? envelopeHash,
        verifiedAnswerSupplement(envelope, manifestHash, candidate.verifiedSupplementReceipt),
        candidate.targetIdFactory,
      );
      replay.importRun.exceptionCount = replay.exceptions.length;
      replay.importRun.status = replay.exceptions.some((exception) => exception.severity === "error") ? "failed" : "completed";
      if (approvedMappedRowsSha256(replay) !== mappedRowsSha256) reasons.push("artifact_target_identity_mismatch");
    }
  } catch {
    reasons.push("artifact_component_digest_verification_failed");
  }
  const expectedBinding: ApprovedImportBinding | undefined = normalizedRowsSha256 && controlsSha256 && mappedRowsSha256 && restrictedRowsSha256 && verifiedObservationOn
    ? {
      archiveEnvelopeSha256: envelopeHash,
      manifestSha256: manifestHash,
      normalizedRowsSha256,
      controlsSha256,
      mappedRowsSha256,
      restrictedRowsSha256,
      normalizerVersion: artifact.provenance.normalizerVersion,
      normalizationReportSha256: artifact.provenance.normalizationReportSha256,
      sourceRunId: artifact.provenance.sourceRunId,
      registryHash: artifact.provenance.registryHash,
      artifactObservationOn: verifiedObservationOn,
      targetIdentity: artifact.provenance.targetIdentity,
      verifiedSupplementReceiptSha256: receiptSha256,
    }
    : undefined;
  const bindingSha256 = expectedBinding ? approvedArtifactBindingSha256(expectedBinding) : undefined;
  if (candidate.report.archiveEnvelopeSha256 !== envelopeHash) reasons.push("artifact_report_envelope_digest_mismatch");
  if (candidate.report.manifestSha256 !== manifestHash) reasons.push("artifact_report_manifest_digest_mismatch");
  if (candidate.report.normalizedRowsSha256 !== normalizedRowsSha256) reasons.push("artifact_report_normalized_rows_digest_mismatch");
  if (candidate.report.controlsSha256 !== controlsSha256) reasons.push("artifact_report_controls_digest_mismatch");
  if (candidate.report.mappedRowsSha256 !== mappedRowsSha256) reasons.push("artifact_report_mapped_rows_digest_mismatch");
  if (candidate.report.restrictedRowsSha256 !== restrictedRowsSha256) reasons.push("artifact_report_restricted_rows_digest_mismatch");
  if (candidate.report.artifactBindingSha256 !== bindingSha256) reasons.push("artifact_report_binding_digest_mismatch");
  if (artifact.provenance.archiveEnvelopeSha256 !== envelopeHash) reasons.push("artifact_provenance_envelope_digest_mismatch");
  if (artifact.provenance.manifestSha256 !== manifestHash) reasons.push("artifact_provenance_manifest_digest_mismatch");
  if (artifact.provenance.normalizedRowsSha256 !== normalizedRowsSha256) reasons.push("artifact_normalized_rows_digest_mismatch");
  if (artifact.provenance.controlsSha256 !== controlsSha256) reasons.push("artifact_controls_digest_mismatch");
  if (artifactControlsSha256 !== controlsSha256) reasons.push("artifact_controls_digest_mismatch");
  if (artifact.provenance.mappedRowsSha256 !== mappedRowsSha256) reasons.push("artifact_mapped_rows_digest_mismatch");
  if (artifact.provenance.restrictedRowsSha256 !== restrictedRowsSha256) reasons.push("artifact_restricted_rows_digest_mismatch");
  if (artifact.provenance.artifactBindingSha256 !== bindingSha256) reasons.push("artifact_binding_digest_mismatch");
  const receiptReasons = verifiedSupplementReceiptReasons(envelope, candidate.verifiedSupplementReceipt, manifestHash);
  if (receiptReasons.length > 0) reasons.push(...receiptReasons.map((reason) => `artifact_${reason}`));
  if (artifact.provenance.verifiedSupplementReceiptSha256 !== receiptSha256) reasons.push("artifact_supplement_receipt_digest_mismatch");
  if (artifact.provenance.artifactObservationOn !== observationOn) reasons.push("artifact_observation_boundary_mismatch");
  if (candidate.report.artifactObservationOn !== observationOn) reasons.push("artifact_report_observation_boundary_mismatch");
  if (privateEnvelopeHash !== envelopeHash) reasons.push("artifact_restricted_envelope_digest_mismatch");
  if (privateEnvelope.archiveEnvelopeSha256 !== envelopeHash || privateEnvelope.sourceManifestHash !== envelopeHash) reasons.push("artifact_source_manifest_binding_mismatch");
  if (privateManifestHash !== manifestHash) reasons.push("artifact_manifest_binding_mismatch");
  if ((privateEnvelope as unknown as Record<string, unknown>).runId !== envelope.runId || artifact.provenance.sourceRunId !== envelope.runId) reasons.push("artifact_source_run_binding_mismatch");
  if (manifest.archiveEnvelopeSha256 !== envelopeHash) reasons.push("manifest_envelope_digest_mismatch");
  if (manifest.runId !== envelope.runId) reasons.push("manifest_source_run_binding_mismatch");
  if (artifact.normalizedResult.importRun.sourceManifestHash !== envelopeHash) reasons.push("artifact_result_manifest_binding_mismatch");
  if (reasons.length > 0) throw new MigrationArtifactIntegrityError(reasons);
}

/**
 * Builds the only production-eligible RM import artifact. The returned report
 * contains counts and hashes only. Raw and normalized records remain in memory
 * and in the separately protected archive.
 */
export function buildRentManagerMigrationArtifact(
  envelope: ExportEnvelope,
  manifest: RedactedExportManifest,
  options: { now?: Date; mode?: "dry_run" | "apply"; targetIdFactory?: RentOpsTargetIdFactory; targetIdentity?: RentManagerTargetIdentityOptions; fidelityVersion?: 2 | 3; verifiedSupplementReceipt?: VerifiedSupplementReceiptBinding } = {},
): MigrationArtifactCandidate {
  const envelopeHash = approvedArchiveEnvelopeSha256(envelope);
  const manifestHash = sha256(canonicalJson(manifest));
  const payloadCounts = recordCounts(envelope.payload as Record<string, unknown>);
  const blockingReasons: string[] = [];
  const observationOn = envelope.artifactObservationOn ?? manifest.artifactObservationOn;
  const verifiedObservationOn = validObservation(observationOn) ? observationOn : undefined;
  if (!verifiedObservationOn || envelope.artifactObservationOn !== manifest.artifactObservationOn) blockingReasons.push("artifact_observation_boundary_invalid");
  if (!manifest.archiveEnvelopeSha256 || !SHA256.test(manifest.archiveEnvelopeSha256) || manifest.archiveEnvelopeSha256 !== envelopeHash) blockingReasons.push("archive_envelope_hash_mismatch");
  if (manifest.runId !== envelope.runId) blockingReasons.push("source_run_id_mismatch");
  if (manifest.source !== "rent_manager" || envelope.source.system !== "rent_manager" || envelope.source.readOnly !== true) blockingReasons.push("source_provenance_invalid");
  if (!SHA256.test(manifest.registryHash)) blockingReasons.push("registry_hash_invalid");
  if (!manifest.complete) blockingReasons.push("export_manifest_incomplete");
  blockingReasons.push(...manifestCountReasons(payloadCounts, manifest.counts));
  blockingReasons.push(...restrictedIdentityReasons(envelope.payload as Record<string, unknown>));
  if (process.env.NODE_ENV === "production" && !options.targetIdFactory) blockingReasons.push("target_id_factory_required");
  if (process.env.NODE_ENV === "production" && (!options.targetIdentity?.keyId || !options.targetIdentity?.keyVersion)) blockingReasons.push("target_id_key_identity_required");
  const supplementReceiptReasons = verifiedSupplementReceiptReasons(envelope, options.verifiedSupplementReceipt, manifestHash);
  const supplementApproved = verifiedAnswerSupplement(envelope, manifestHash, options.verifiedSupplementReceipt);
  if (supplementReceiptReasons.length > 0) blockingReasons.push(...supplementReceiptReasons);
  if ((envelope.payload.applicationAnswerRecords?.length ?? 0) > 0 && !supplementApproved) blockingReasons.push("application_answer_supplement_provenance_invalid");

  const normalized = normalizeRentManagerExport(envelope.payload, {
    sourceRunId: envelope.runId,
    approvedSupplementEvidence: supplementApproved,
    artifactSha256: envelope.payload.artifactSha256 ?? envelopeHash,
    ...(verifiedObservationOn ? { asOfDate: verifiedObservationOn, artifactObservationOn: verifiedObservationOn } : {}),
  });
  const normalizedRowsSha256 = approvedNormalizedRowsSha256(normalized.input);
  const normalizationReport = {
    version: RENT_MANAGER_NORMALIZER_VERSION,
    archiveEnvelopeSha256: envelopeHash,
    recordCounts: normalized.recordCounts,
    confidence: normalized.confidence,
    exceptions: normalized.exceptions,
  };
  const normalizationReportSha256 = sha256(canonicalJson(normalizationReport));
  const controls = controlsFor(normalized.input);
  const controlsSha256 = approvedControlsSha256(controls);
  const result = mapRentManagerExport(normalized.input, {
    now: options.now,
    mode: options.mode ?? "dry_run",
    sourceManifestHash: envelopeHash,
    targetIdFactory: options.targetIdFactory,
    targetIdentity: options.targetIdentity,
    fidelityVersion: options.fidelityVersion ?? 3,
    artifactSha256: envelope.payload.artifactSha256 ?? envelopeHash,
    ...(verifiedObservationOn ? { artifactObservationOn: verifiedObservationOn } : {}),
  });
  result.exceptions.push(...normalized.exceptions.map(mappingException));

  const reconciliation = reconcileRentManagerImport(result, normalized.input, {
    counts: controls.counts as Partial<Record<ImportEntityType, number>>,
    totalsCents: controls.totalsCents,
    unknownCounts: controls.unknownCounts,
    invalidMoneyCounts: controls.invalidMoneyCounts,
  });
  for (const mismatch of reconciliation.mismatches) {
    result.exceptions.push({ code: `reconciliation_${safeCode(mismatch.code)}_${safeCode(mismatch.metric)}`, severity: mismatch.severity, message: `Rent Manager reconciliation ${safeCode(mismatch.code)} for ${safeCode(mismatch.metric)}`, ...(mismatch.amountCents === undefined ? {} : { amountCents: mismatch.amountCents }) });
  }
  blockingReasons.push(...projectApplicationHistory(
    result,
    envelope,
    envelope.payload.artifactSha256 ?? envelopeHash,
    supplementApproved,
    options.targetIdFactory,
  ));
  result.importRun.exceptionCount = result.exceptions.length;
  result.importRun.status = result.exceptions.some((exception) => exception.severity === "error") ? "failed" : "completed";
  blockingReasons.push(...result.exceptions.filter((exception) => exception.severity === "error").map((exception) => `mapping_${safeCode(exception.code)}`));

  const applicationTemplateFieldCount = envelope.payload.applicationTemplates?.filter((row) => String(row.sourceCollection ?? "").includes("Field")).length ?? 0;
  if ((envelope.payload.applications?.length ?? 0) > 0 && applicationTemplateFieldCount > 0 && !(envelope.payload as Record<string, unknown>).applicationAnswerRecords) {
    blockingReasons.push("application_answers_not_exported");
  }
  const binaryDescriptors = envelope.documentBinaries ?? [];
  if (binaryDescriptors.some((descriptor) => !descriptor.binaryAvailable || !descriptor.sha256 || descriptor.sizeBytes === undefined || !descriptor.archivePath)) {
    blockingReasons.push("document_binaries_not_fully_archived");
  }

  const mappedCounts = mappedSourceCounts(result);
  const mappedRowsSha256 = approvedMappedRowsSha256(result);
  const sourceInput = restrictedEnvelope(envelope, manifest, manifestHash);
  const restrictedRowsSha256 = approvedRestrictedRowsSha256(sourceInput);
  const receiptSha256 = options.verifiedSupplementReceipt ? verifiedSupplementReceiptSha256(options.verifiedSupplementReceipt) : undefined;
  const binding: ApprovedImportBinding | undefined = verifiedObservationOn ? {
    archiveEnvelopeSha256: envelopeHash,
    manifestSha256: manifestHash,
    normalizedRowsSha256,
    controlsSha256,
    mappedRowsSha256,
    restrictedRowsSha256,
    normalizerVersion: RENT_MANAGER_NORMALIZER_VERSION,
    normalizationReportSha256,
    sourceRunId: envelope.runId,
    registryHash: manifest.registryHash,
    artifactObservationOn: verifiedObservationOn,
    targetIdentity: options.targetIdentity,
    verifiedSupplementReceiptSha256: receiptSha256,
  } : undefined;
  const artifactBindingSha256 = binding
    ? approvedArtifactBindingSha256(binding)
    : sha256(canonicalJson({ artifactType: APPROVED_RM_NORMALIZER_ARTIFACT, archiveEnvelopeSha256: envelopeHash, manifestSha256: manifestHash, observationBoundary: "invalid" }));
  const uniqueBlockingReasons = Array.from(new Set(blockingReasons)).sort();
  const report: MigrationArtifactReport = {
    archiveEnvelopeSha256: envelopeHash,
    manifestSha256: manifestHash,
    normalizationReportSha256,
    normalizedRowsSha256,
    controlsSha256,
    mappedRowsSha256,
    restrictedRowsSha256,
    artifactBindingSha256,
    normalizerVersion: RENT_MANAGER_NORMALIZER_VERSION,
    sourceRunId: envelope.runId,
    artifactObservationOn: verifiedObservationOn,
    rawCollectionCounts: payloadCounts,
    normalizedRecordCounts: normalized.recordCounts,
    mappedSourceCounts: mappedCounts,
    normalizationExceptionCount: normalized.exceptions.length,
    mappingWarningCount: result.exceptions.filter((exception) => exception.severity === "warning").length,
    mappingErrorCount: result.exceptions.filter((exception) => exception.severity === "error").length,
    blockingReasons: uniqueBlockingReasons,
  };
  if (uniqueBlockingReasons.length > 0 || !verifiedObservationOn) return { report, normalizedResult: result, targetIdFactory: options.targetIdFactory, targetIdentity: options.targetIdentity, verifiedSupplementReceipt: options.verifiedSupplementReceipt };

  const artifact: ApprovedPersistenceImportArtifact = {
    artifactType: APPROVED_RM_NORMALIZER_ARTIFACT,
    normalizedResult: result,
    restrictedSourceInput: sourceInput,
    controls,
    provenance: {
      archiveEnvelopeSha256: envelopeHash,
      manifestSha256: manifestHash,
      normalizedRowsSha256,
      controlsSha256,
      mappedRowsSha256,
      restrictedRowsSha256,
      artifactBindingSha256,
      normalizerVersion: RENT_MANAGER_NORMALIZER_VERSION,
      normalizationReportSha256,
      sourceRunId: envelope.runId,
      registryHash: manifest.registryHash,
      artifactObservationOn: verifiedObservationOn,
      targetIdentity: options.targetIdentity,
      verifiedSupplementReceiptSha256: receiptSha256,
    },
  };
  // Keep construction self-checking.  The runner repeats this check after
  // loading the archive, which protects the hand-off interval as well.
  assertMigrationArtifactIntegrity({ artifact, report, normalizedResult: result, targetIdFactory: options.targetIdFactory, targetIdentity: options.targetIdentity, verifiedSupplementReceipt: options.verifiedSupplementReceipt }, envelope, manifest);
  return { artifact, report, normalizedResult: result, targetIdFactory: options.targetIdFactory, targetIdentity: options.targetIdentity, verifiedSupplementReceipt: options.verifiedSupplementReceipt };
}
