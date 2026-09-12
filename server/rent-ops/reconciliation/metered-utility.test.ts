import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { syntheticRentOpsSnapshot } from '../fixtures/synthetic';
import { SyntheticRentOpsRepository } from '../repositories/synthetic';
import { meteredUtilitiesForTenancy } from '../domain/metered-utility';
import { applyOwnerMeteredUtility, type OwnerMeteredUtilityInput } from './metered-utility';
const context = { actorSubject: 'owner', occurredAt: '2026-09-12T12:00:00Z' };
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'metered-utility-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidenceText = 'Owner confirms metered water begins October 1; usage amount unknown.';
  const path = join(directory, 'owner.txt'); await writeFile(path, evidenceText);
  const snapshot = syntheticRentOpsSnapshot(); const tenancy = snapshot.tenancies[0];
  const input: OwnerMeteredUtilityInput = { id: 'water-observation', tenancyId: tenancy.id, personId: tenancy.primaryPersonId, propertyId: tenancy.propertyId, unitId: tenancy.unitId, expectedRevision: tenancy.recordRevision ?? 1, utility: 'water', billingMethod: 'metered', effectiveFrom: '2026-10-01', amountCents: null, amountKnowledge: 'unknown', evidence: { path, sha256: createHash('sha256').update(evidenceText).digest('hex'), reference: 'Owner confirmation' } };
  return { input, repository: new SyntheticRentOpsRepository(snapshot) };
}
test('metered water observation preserves unknown amount and every financial and lease record', async t => {
  const { input, repository } = await setup(t); const before = await repository.getSnapshot();
  const event = await applyOwnerMeteredUtility(repository, input, context); const after = await repository.getSnapshot();
  assert.equal(event.type, 'note');
  assert.deepEqual({ ...after, activityEvents: before.activityEvents }, before);
  const expected = [{ utility: 'water', billingMethod: 'metered', effectiveFrom: '2026-10-01', amountCents: null, amountKnowledge: 'unknown' }];
  assert.deepEqual(meteredUtilitiesForTenancy(after, input.tenancyId, '2026-09-12'), expected);
  assert.deepEqual(meteredUtilitiesForTenancy(after, input.tenancyId, '2026-10-01'), expected);
  assert.deepEqual(meteredUtilitiesForTenancy(after, input.tenancyId, '2026-09-11'), []);
  await assert.rejects(() => applyOwnerMeteredUtility(repository, input, context), /already exists/);
  assert.deepEqual(await repository.getSnapshot(), after);
});
test('wrong identity, revision, evidence, date or known amount fail before writes', async t => {
  const { input, repository } = await setup(t); const before = await repository.getSnapshot();
  for (const patch of [{ personId: 'wrong' }, { unitId: 'wrong' }, { expectedRevision: 99 }, { evidence: { ...input.evidence, sha256: 'a'.repeat(64) } }, { effectiveFrom: '2026-02-30' }, { amountCents: 0 }, { amountKnowledge: 'manual' }, { fixedChargeCents: 10000 }]) {
    await assert.rejects(() => applyOwnerMeteredUtility(repository, { ...input, ...patch } as OwnerMeteredUtilityInput, context));
    assert.deepEqual(await repository.getSnapshot(), before);
  }
});
test('projection rejects note metadata that does not match its immutable event identity', async t => {
  const { input, repository } = await setup(t); await applyOwnerMeteredUtility(repository, input, context);
  const snapshot = await repository.getSnapshot(); const event = snapshot.activityEvents.find(row => row.id === input.id)!;
  for (const patch of [{ personId: 'wrong' }, { actor: 'other' }, { occurredAt: '2026-09-11T12:00:00Z' }]) {
    const altered = structuredClone(snapshot); Object.assign(altered.activityEvents.find(row => row.id === input.id)!, patch);
    assert.deepEqual(meteredUtilitiesForTenancy(altered, input.tenancyId, '2026-10-01'), []);
  }
  event.detail = JSON.stringify({ ...JSON.parse(event.detail!), amountCents: 0 });
  assert.deepEqual(meteredUtilitiesForTenancy(snapshot, input.tenancyId, '2026-10-01'), []);
});
