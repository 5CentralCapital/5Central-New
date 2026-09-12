import type { RentOpsBalanceReviewView } from '../../../shared/rent-ops-contracts';
import { parseBalanceReview } from '../domain/balance-review';

/** Manager-only allowlist; reviewed observations never enter public payment views. */
export type AdminBalanceReviewView = Omit<RentOpsBalanceReviewView, "sourceRefs" | "ledgerFingerprint">;

export function serializeBalanceReview(value: unknown): AdminBalanceReviewView | undefined {
  const review = parseBalanceReview(value);
  if (!review || typeof (value as Record<string, unknown>).stale !== 'boolean') return undefined;
  const { sourceRefs: _evidence, ledgerFingerprint: _fingerprint, ...visible } = review;
  return { ...visible, stale: (value as Record<string, unknown>).stale as boolean };
}
