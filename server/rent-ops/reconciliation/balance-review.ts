import type { RentOpsBalanceReview, RentOpsRepository, RentOpsSnapshot } from '../../../shared/rent-ops-contracts';
import { createBalanceReviewEvent, balanceReviewLedgerFingerprint } from '../domain/balance-review';

export async function applyOwnerBalanceReview(repository: RentOpsRepository, input: Omit<RentOpsBalanceReview, 'reviewedBy' | 'reviewedAt' | 'ledgerFingerprint'>, context: { actorSubject: string; occurredAt: string }, preparedSnapshot?: RentOpsSnapshot) {
  const snapshot = preparedSnapshot ?? await repository.getSnapshot();
  const review: RentOpsBalanceReview = { ...input, reviewedBy: context.actorSubject, reviewedAt: context.occurredAt, ledgerFingerprint: balanceReviewLedgerFingerprint(snapshot, input.personId) };
  const event = createBalanceReviewEvent(review);
  const tenancy = snapshot.tenancies.find(row => row.id === review.tenancyId);
  if (!tenancy || tenancy.primaryPersonId !== review.personId || tenancy.propertyId !== review.propertyId || tenancy.unitId !== review.unitId) throw new Error('Balance review identity differs from tenancy');
  const saved = await repository.saveActivity(event);
  if (preparedSnapshot) return saved; // Outer guarded operator verifies the complete batch.
  const readback = (await repository.getSnapshot()).activityEvents.find(row => row.id === event.id);
  if (!readback || readback.detail !== event.detail) throw new Error('Balance review readback differs');
  return saved;
}
