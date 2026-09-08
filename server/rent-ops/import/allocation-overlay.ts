import type { RentManagerRawRecord } from "../../../shared/rent-ops-contracts";
import { canonicalJson, hashRecord, sha256 } from '../export/hash';
import { normalizeRmRecord } from '../export/normalize';
import { assertNoCredentialShapedFields } from '../export/collector';
import type { ExportEnvelope, RedactedExportManifest, ExportCheckpoint, CollectionCoverage } from '../export/types';
export const ALLOCATION_OVERLAY_FILE = 'allocation-overlay-provenance.json';
export const ALLOCATION_OVERLAY_COLLECTION = 'chargeAllocationSupplement';
export const ALLOCATION_OVERLAY_PAGE = 'pages/charge-allocation-supplement.json';
const digest = (x: unknown) => sha256(canonicalJson(x));
const check = (x: unknown) => { if (!x) throw new Error('allocation_overlay_provenance_invalid'); };
type Raw = Record<string, unknown>;
export interface AllocationOverlayEvidence {
  snapshotManifestBase64: string;
  pages: Array<{ file: string; bytesBase64: string }>;
  deltaBase64: string;
}
function decode(value: string): Buffer { check(typeof value === 'string' && value.length <= 64 * 1024 * 1024); const b = Buffer.from(value, 'base64'); check(b.toString('base64') === value); return b; }
function parse(value: string): any { return JSON.parse(decode(value).toString('utf8')); }
function identity(row: Raw): string { check(Number.isSafeInteger(row.AllocationID) && Number(row.AllocationID) > 0); return String(row.AllocationID); }
/** Recompute the delta from captured raw responses; supplied delta prose is never authority. */
export function allocationOverlayRows(envelope: ExportEnvelope, evidence: AllocationOverlayEvidence) {
  const manifest = parse(evidence.snapshotManifestBase64);
  check(manifest.method === 'GET-Charges-embedded-Allocations/v1' && manifest.readOnly === true && manifest.complete === true);
  check(Array.isArray(manifest.pages) && manifest.pages.length > 0 && manifest.pages.length <= 100 && evidence.pages.length === manifest.pages.length);
  const raw = new Map<string, Raw>();
  const refs = new Map<string, { file: string; pointer: string }>();
  let chargeCount = 0;
  const chargeIds = new Set<string>();
  for (let p = 0; p < manifest.pages.length; p++) {
    const descriptor = manifest.pages[p], file = evidence.pages[p];
    check(descriptor.file === file.file && /^charges-[1-9][0-9]*\.json$/.test(file.file));
    check(sha256(decode(file.bytesBase64)) === descriptor.sha256);
    const rows = parse(file.bytesBase64); check(Array.isArray(rows) && rows.length === descriptor.count && rows.length <= 10000);
    chargeCount += rows.length;
    rows.forEach((charge: Raw, i: number) => {
      assertNoCredentialShapedFields(charge);
      check(charge.ChargeID !== undefined && !chargeIds.has(String(charge.ChargeID))); chargeIds.add(String(charge.ChargeID));
      check(Array.isArray(charge.Allocations));
      (charge.Allocations as Raw[]).forEach((row, j) => {
        const id = identity(row); check(String(row.ChargeID) === String(charge.ChargeID));
        if (raw.has(id)) check(canonicalJson(raw.get(id)) === canonicalJson(row));
        else { raw.set(id, row); refs.set(id, { file: file.file, pointer: `/${i}/Allocations/${j}` }); }
      });
    });
  }
  check(chargeCount === manifest.received && chargeCount === manifest.totalResults);
  const sourceChargeIds = new Set((envelope.payload.charges ?? []).map(row => String(row.ChargeID)));
  check(sourceChargeIds.size === chargeIds.size && Array.from(chargeIds).every(id => sourceChargeIds.has(id)));
  const baseline = envelope.payload.allocations ?? []; const baselineIds = new Set<string>();
  for (const row of baseline) {
    const id = identity(row); check(!baselineIds.has(id)); baselineIds.add(id);
    const source = raw.get(id); check(source);
    // Collector aliases are additional fields; every original captured field must match.
    for (const [key, value] of Object.entries(source!)) check(canonicalJson(row[key]) === canonicalJson(value));
  }
  const delta = Array.from(raw).filter(([id]) => !baselineIds.has(id)).map(([id, record]) => ({ sourceIdentity: { collection: 'Charges.Allocations', idField: 'AllocationID', sourceId: id }, sourceReference: refs.get(id)!, record }));
  const claimed = parse(evidence.deltaBase64);
  check(claimed.sourceRunId === envelope.runId && Array.isArray(claimed.rows) && claimed.rows.length === delta.length);
  const claimedById = new Map(claimed.rows.map((row: any) => [row.sourceIdentity?.sourceId, row]));
  check(claimedById.size === delta.length && delta.every(row => canonicalJson(claimedById.get(row.sourceIdentity.sourceId)) === canonicalJson(row)));
  check(Array.isArray(claimed.overlapMismatches) && claimed.overlapMismatches.length === 0);
  const rows = delta.map(({ record }) => normalizeRmRecord({ name: 'Charges.Allocations', outputKey: 'allocations', idFields: ['AllocationID'], entityType: 'payment_allocation', sourceIdNamespace: 'payment_allocation' }, record as RentManagerRawRecord));
  return { rows, baselineCount: baseline.length, fullCount: raw.size };
}
export function deriveAllocationOverlay(envelope: ExportEnvelope, manifest: RedactedExportManifest, checkpointBytes: Uint8Array, coverageBytes: Uint8Array, evidence: AllocationOverlayEvidence) {
  check(!envelope.supplementEvidence && manifest.archiveEnvelopeSha256 === digest(envelope));
  const checkpoint = JSON.parse(Buffer.from(checkpointBytes).toString('utf8')) as ExportCheckpoint;
  check(checkpoint.runId === envelope.runId && canonicalJson(JSON.parse(Buffer.from(coverageBytes).toString('utf8'))) === canonicalJson(manifest.collections));
  check(!checkpoint.collections[ALLOCATION_OVERLAY_COLLECTION] && !manifest.collections.some(x => x.name === ALLOCATION_OVERLAY_COLLECTION));
  const { rows, baselineCount, fullCount } = allocationOverlayRows(envelope, evidence);
  check(rows.length > 0);
  const hashes = rows.map(hashRecord);
  const coverage: CollectionCoverage = { name: ALLOCATION_OVERLAY_COLLECTION, path: '/Charges/Allocations', outputKey: 'allocations', kind: 'collection', required: true, status: 'complete', pages: 1, requested: rows.length, received: rows.length, expected: rows.length, recordHashes: hashes, errors: [], exceptions: [] };
  const derivedEnvelope = { ...envelope, payload: { ...envelope.payload, allocations: [...(envelope.payload.allocations ?? []), ...rows] } };
  const derivedManifest = { ...manifest, counts: { ...manifest.counts, allocations: fullCount }, collections: [...manifest.collections, coverage], archiveEnvelopeSha256: digest(derivedEnvelope) };
  const derivedCheckpoint: ExportCheckpoint = { ...checkpoint, collections: { ...checkpoint.collections, [ALLOCATION_OVERLAY_COLLECTION]: { nextPage: 2, nextParentIndex: 0, parentIds: [], pageSize: rows.length, pages: 1, received: rows.length, hashes, pageFiles: [ALLOCATION_OVERLAY_PAGE], status: 'complete', sourceTotal: rows.length, errors: [], exceptions: [] } } };
  const provenance = { version: 'rm-allocation-overlay/v1', sourceRunId: envelope.runId, parentEnvelopeSha256: digest(envelope), parentManifest: manifest, parentCheckpointBase64: Buffer.from(checkpointBytes).toString('base64'), parentCoverageBase64: Buffer.from(coverageBytes).toString('base64'), evidence, baselineCount, fullCount, addedCount: rows.length, derivativeEnvelopeSha256: digest(derivedEnvelope), derivativeManifestSha256: digest(derivedManifest), derivativeCheckpointSha256: digest(derivedCheckpoint), derivativeCoverageSha256: digest(derivedManifest.collections), pageSha256: digest(rows) };
  return { envelope: derivedEnvelope, manifest: derivedManifest, checkpoint: derivedCheckpoint, coverage: derivedManifest.collections, rows, provenance };
}
export function verifyAllocationOverlay(envelope: ExportEnvelope, manifest: RedactedExportManifest, checkpointBytes: Uint8Array, coverageBytes: Uint8Array, provenance: unknown) {
  check(provenance && typeof provenance === 'object'); const p = provenance as ReturnType<typeof deriveAllocationOverlay>['provenance'];
  check(p.version === 'rm-allocation-overlay/v1' && Number.isSafeInteger(p.baselineCount) && p.baselineCount >= 0);
  const parentEnvelope = { ...envelope, payload: { ...envelope.payload, allocations: (envelope.payload.allocations ?? []).slice(0, p.baselineCount) } };
  check(digest(parentEnvelope) === p.parentEnvelopeSha256);
  const parentCheckpoint = decode(p.parentCheckpointBase64), parentCoverage = decode(p.parentCoverageBase64);
  const expected = deriveAllocationOverlay(parentEnvelope, p.parentManifest, parentCheckpoint, parentCoverage, p.evidence);
  check(canonicalJson(expected.provenance) === canonicalJson(p) && canonicalJson(expected.envelope) === canonicalJson(envelope) && canonicalJson(expected.manifest) === canonicalJson(manifest));
  check(sha256(checkpointBytes) === p.derivativeCheckpointSha256 && sha256(coverageBytes) === p.derivativeCoverageSha256);
  return { envelope: parentEnvelope, manifest: p.parentManifest, checkpointBytes: parentCheckpoint, coverageBytes: parentCoverage, rows: expected.rows };
}
