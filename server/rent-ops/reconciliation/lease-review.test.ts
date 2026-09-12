import assert from 'node:assert/strict';
import test from 'node:test';
import { SyntheticRentOpsRepository } from '../repositories/synthetic';
import { syntheticRentOpsSnapshot } from '../fixtures/synthetic';
import { applyOwnerLeaseReview, type OwnerLeaseReviewInput } from './lease-review';
const context = { actorSubject: 'review-test', occurredAt: '2026-09-12T12:00:00Z' };
function setup() {
  const snapshot = syntheticRentOpsSnapshot();
  const tenancy = snapshot.tenancies[0];
  snapshot.leaseTerms = [{ id: 'old', tenancyId: tenancy.id, status: 'executed', contractStartOn: '2025-01-01', contractEndOn: '2025-12-31', monthToMonth: false, createdAt: context.occurredAt }];
  const input: OwnerLeaseReviewInput = { tenancyId: tenancy.id, personId: tenancy.primaryPersonId, unitId: tenancy.unitId, propertyId: tenancy.propertyId, termId: 'old', expectedRevision: 1, expectedStartOn: '2025-01-01', expectedEndOn: '2025-12-31', evidence: { path: '/evidence', sha256: 'a'.repeat(64), reference: 'reviewed source' }, addition: { id: 'new', status: 'executed', contractStartOn: '2026-01-01', contractEndOn: '2026-12-31', renewalOfId: 'old' } };
  return { repository: new SyntheticRentOpsRepository(snapshot), input };
}
test('documented renewal preserves historical term, occupancy, ledger and unknown signature date', async () => {
  const { repository, input } = setup(); const before = await repository.getSnapshot();
  const result = await applyOwnerLeaseReview(repository, input, context); const after = await repository.getSnapshot();
  assert.deepEqual(after.leaseTerms.find(row => row.id === 'old'), before.leaseTerms[0]);
  assert.equal(result.created?.signedOn, undefined); assert.equal(result.created?.renewalOfId, 'old');
  assert.deepEqual(after.tenancies, before.tenancies); assert.deepEqual(after.ledgerTransactions, before.ledgerTransactions);
});
test('wrong identity, revision, extra fields and overlap reject before mutation', async () => {
  for (const kind of ['identity', 'revision', 'extra', 'overlap']) {
    const { repository, input } = setup(); const before = await repository.getSnapshot();
    if (kind === 'identity') input.personId = 'wrong';
    if (kind === 'revision') input.expectedRevision = 9;
    if (kind === 'extra') input.patch = { signedOn: '2026-01-01' } as any;
    if (kind === 'overlap') input.addition!.contractStartOn = '2025-12-01';
    await assert.rejects(() => applyOwnerLeaseReview(repository, input, context));
    assert.deepEqual(await repository.getSnapshot(), before);
  }
});
test('splits blended import from draft future without upgrading execution or altering occupancy', async () => {
 const { repository, input } = setup(); input.patch = { contractEndOn: '2025-09-30' }; input.addition = { ...input.addition!, status: 'draft', contractStartOn: '2025-10-01' };
 const result = await applyOwnerLeaseReview(repository, input, context);
 assert.equal(result.updated?.contractEndOn, '2025-09-30'); assert.equal(result.created?.status, 'draft'); assert.equal(result.created?.signedOn, undefined);
});
