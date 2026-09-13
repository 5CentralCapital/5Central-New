import assert from 'node:assert/strict';
import test from 'node:test';
import { retryTenancyRefresh, saveTenancyAndRefresh, tenancySaveMessage, type TenancySave } from './manager-tenancy-actions';

const payload = { id: 'tenancy-1', revision: 4, status: 'past', actualMoveOutOn: '2026-09-12' };

test('a successful move reports refresh failure and retries readback without posting another mutation', async () => {
  let mutationCalls = 0;
  let refreshCalls = 0;
  const save: TenancySave = async mutation => {
    mutationCalls += 1;
    assert.equal(mutation.action, 'save-tenancy');
    assert.deepEqual(mutation.payload, payload);
    return { ok: true, id: 'tenancy-1' };
  };
  const refresh = async () => {
    refreshCalls += 1;
    if (refreshCalls === 1) throw new Error('workspace readback unavailable');
  };

  const refreshed = await saveTenancyAndRefresh(payload, save, refresh);
  assert.equal(refreshed, false);
  assert.equal(tenancySaveMessage('move-out', refreshed), 'Move saved, but the refreshed occupancy could not be loaded. Refresh before making another change.');
  assert.equal(mutationCalls, 1);
  assert.equal(refreshCalls, 1);

  assert.equal(await retryTenancyRefresh(refresh), true);
  assert.equal(mutationCalls, 1);
  assert.equal(refreshCalls, 2);
  assert.equal(tenancySaveMessage('move-out', true), 'Actual move recorded and current occupancy refreshed.');
});

test('a rejected tenancy save does not start a refresh', async () => {
  let refreshCalls = 0;
  const save: TenancySave = async () => ({ ok: false, message: 'revision conflict' });
  await assert.rejects(() => saveTenancyAndRefresh(payload, save, async () => { refreshCalls += 1; }), /revision conflict/);
  assert.equal(refreshCalls, 0);
});
