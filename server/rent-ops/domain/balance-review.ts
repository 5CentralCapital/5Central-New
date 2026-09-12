import { createHash } from "node:crypto";
import type { RentOpsActivityEvent, RentOpsBalanceReview, RentOpsBalanceReviewView, RentOpsSnapshot } from '../../../shared/rent-ops-contracts';

export function parseBalanceReview(value: unknown): RentOpsBalanceReview | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (row.schema !== 'balance_review_v1' || typeof row.ledgerFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.ledgerFingerprint)) return undefined;
  for (const key of ['id', 'tenancyId', 'personId', 'propertyId', 'unitId', 'reviewedBy']) {
    if (typeof row[key] !== 'string' || !(row[key] as string).trim()) return undefined;
  }
  if (typeof row.asOfDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.asOfDate) || !Number.isFinite(Date.parse(row.asOfDate)) || new Date(row.asOfDate).toISOString().slice(0, 10) !== row.asOfDate) return undefined;
  if (typeof row.reviewedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(row.reviewedAt) || !Number.isFinite(Date.parse(row.reviewedAt)) || new Date(row.reviewedAt).toISOString().slice(0, 10) !== row.reviewedAt.slice(0, 10)) return undefined;
  for (const key of ['reviewedBalanceCents', 'tenantBalanceCents', 'agencyBalanceCents']) {
    if (row[key] !== null && !Number.isSafeInteger(row[key])) return undefined;
  }
  if (!Array.isArray(row.qualifications) || row.qualifications.some(v => typeof v !== 'string')) return undefined;
  if (!Array.isArray(row.sourceRefs) || !row.sourceRefs.length || row.sourceRefs.some(v => typeof v !== 'string' || !v.trim())) return undefined;
  if (row.reviewedBalanceCents === null && !row.qualifications.length) return undefined;
  if (row.reviewedBalanceCents !== null && row.tenantBalanceCents !== null && row.agencyBalanceCents !== null && row.reviewedBalanceCents !== (row.tenantBalanceCents as number) + (row.agencyBalanceCents as number)) return undefined;
  return { schema: 'balance_review_v1', ledgerFingerprint: row.ledgerFingerprint, id: row.id as string, tenancyId: row.tenancyId as string, personId: row.personId as string, propertyId: row.propertyId as string, unitId: row.unitId as string, asOfDate: row.asOfDate, reviewedAt: new Date(row.reviewedAt).toISOString(), reviewedBy: row.reviewedBy as string, reviewedBalanceCents: row.reviewedBalanceCents as number | null, tenantBalanceCents: row.tenantBalanceCents as number | null, agencyBalanceCents: row.agencyBalanceCents as number | null, qualifications: [...row.qualifications] as string[], sourceRefs: [...row.sourceRefs] as string[] };
}

/** Persist using existing saveActivity; a new review uses a new event id. */
export function createBalanceReviewEvent(value: RentOpsBalanceReview): RentOpsActivityEvent {
  const review = parseBalanceReview(value);
  if (!review) throw new Error('Invalid source-backed balance review');
  return { id: review.id, propertyId: review.propertyId, unitId: review.unitId, personId: review.personId, tenancyId: review.tenancyId, type: 'note', occurredAt: review.reviewedAt, actor: review.reviewedBy, summary: `Balance reviewed as of ${review.asOfDate}`, detail: JSON.stringify(review) };
}

export function selectBalanceReview(snapshot: RentOpsSnapshot, tenancyId: string, asOfDate: string): RentOpsBalanceReviewView | undefined {
  const tenancy = snapshot.tenancies.find(row => row.id === tenancyId);
  if (!tenancy) return undefined;
  const reviews = snapshot.activityEvents.flatMap(event => {
    if (event.type !== 'note' || event.tenancyId !== tenancyId || !event.detail) return [];
    let review: RentOpsBalanceReview | undefined;
    try { review = parseBalanceReview(JSON.parse(event.detail)); } catch { return []; }
    if (!review || review.id !== event.id || event.actor !== review.reviewedBy || event.occurredAt !== review.reviewedAt || review.tenancyId !== tenancy.id || review.personId !== tenancy.primaryPersonId || review.propertyId !== tenancy.propertyId || review.unitId !== tenancy.unitId || event.personId !== review.personId || event.propertyId !== review.propertyId || event.unitId !== review.unitId || review.asOfDate > asOfDate || review.reviewedAt.slice(0, 10) > asOfDate) return [];
    return [review];
  }).sort((a, b) => b.asOfDate.localeCompare(a.asOfDate) || b.reviewedAt.localeCompare(a.reviewedAt) || b.id.localeCompare(a.id));
  const review = reviews[0];
  if (!review) return undefined;
  const stale = balanceReviewLedgerFingerprint(snapshot, tenancy.primaryPersonId) !== review.ledgerFingerprint;
  return { ...review, stale };
}

/** Includes all linked tenancies so transfers do not drop account history. */
export function balanceReviewLedgerFingerprint(snapshot: RentOpsSnapshot, personId: string): string {
  const tenancyIds = new Set(snapshot.tenancies.filter(row => row.primaryPersonId === personId).map(row => row.id));
  const ledger = snapshot.ledgerTransactions.filter(row => row.personId === personId || tenancyIds.has(row.tenancyId ?? "")).sort((a,b) => a.id.localeCompare(b.id));
  const ids = new Set(ledger.map(row => row.id));
  const allocations = snapshot.paymentAllocations.filter(row => ids.has(row.paymentTransactionId ?? "") || ids.has(row.chargeTransactionId ?? "") || ids.has(row.creditTransactionId ?? "")).sort((a,b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify({ledger, allocations})).digest("hex");
}

/** Manager routing only; never use this observation to bill or collect funds. */
export function operationalBalanceCents(review: RentOpsBalanceReviewView | undefined, postedBalanceCents: number | null, postedComplete: boolean): number | null {
  if (review) return review.stale ? null : review.reviewedBalanceCents;
  return postedComplete ? postedBalanceCents : null;
}
