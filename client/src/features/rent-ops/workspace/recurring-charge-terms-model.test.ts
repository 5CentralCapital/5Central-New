import assert from 'node:assert/strict';
import test from 'node:test';
import { chargeTermLabel, decodeRecurringChargeTerms, recurringChargeTermsQueryKey, recurringChargeTermsRequests } from './recurring-charge-terms-model';
const row = { scheduleId: 'schedule:a', reviewRevision: 1, latestReviewRevision: 1, appliesFrom: '2026-09-12', verifiedRateFrom: '2025-04-01', rateFromKnowledge: 'verified', leaseFrom: '2025-04-01', leaseFromKnowledge: 'verified', leaseThrough: '2027-03-31', leaseThroughKnowledge: 'verified', reviewedAt: '2026-09-12T12:00:00.000Z' };
test('term dates come from verified terms, not reconciliation or audit dates', () => {
  const [parsed] = decodeRecurringChargeTerms({ rows: [row] }, ['schedule:a']);
  assert.equal(chargeTermLabel(parsed, 'start', 'ready'), '2025-04-01');
  assert.equal(chargeTermLabel(parsed, 'through', 'ready'), '2027-03-31');
  assert.equal(chargeTermLabel(parsed, 'start', 'loading'), 'Loading…');
  assert.equal(chargeTermLabel(parsed, 'through', 'error'), 'Unavailable');
});
test('unknown and month to month do not assert an open-ended billing interval', () => {
  const [parsed] = decodeRecurringChargeTerms({ rows: [{ ...row, verifiedRateFrom: null, rateFromKnowledge: 'unknown', leaseThrough: null, leaseThroughKnowledge: 'month_to_month' }] }, ['schedule:a']);
  assert.equal(chargeTermLabel(parsed, 'start', 'ready'), 'Unverified');
  assert.equal(chargeTermLabel(parsed, 'through', 'ready'), 'Month to month');
  assert.equal(chargeTermLabel(undefined, 'through', 'ready'), 'Unverified');
  assert.equal(chargeTermLabel(undefined, 'through', 'ready', 'property'), 'Not applicable');
});
test('safe DTO strips source aliases and raw evidence at every level', () => {
  const parsed = decodeRecurringChargeTerms({ sourceId: 'secret', rows: [{ ...row, evidenceReference: 'private', sourceId: 'secret', metadata: { sourceAlias: 'secret' } }] }, ['schedule:a']);
  assert.deepEqual(parsed, [row]);
  assert.ok(!JSON.stringify(parsed).includes('secret'));
});
test('malformed, inconsistent, duplicate, or differently bound terms are rejected', () => {
  for (const rows of [[{ ...row, verifiedRateFrom: '2026-02-30' }], [{ ...row, rateFromKnowledge: 'unknown' }], [{ ...row, leaseThroughKnowledge: 'month_to_month' }], [row, row], [{ ...row, scheduleId: 'schedule:other' }]]) {
    assert.throws(() => decodeRecurringChargeTerms({ rows }, ['schedule:a']), /unavailable/);
  }
});
test('query cache separates identities, dates, and exact schedules with stable order', () => {
  assert.deepEqual(recurringChargeTermsQueryKey('a', ['y', 'x', 'x'], '2026-09-12'), recurringChargeTermsQueryKey('a', ['x', 'y'], '2026-09-12'));
  assert.notDeepEqual(recurringChargeTermsQueryKey('a', ['x'], '2026-09-12'), recurringChargeTermsQueryKey('b', ['x'], '2026-09-12'));
  assert.notDeepEqual(recurringChargeTermsQueryKey('a', ['x'], '2026-09-12'), recurringChargeTermsQueryKey('a', ['x'], '2026-10-01'));
});

test('batched requests use the mounted route and bound encoded long IDs without dropping records', () => {
  const ids = Array.from({ length: 450 }, (_, index) => `schedule:${index}:${'é'.repeat(120)}`);
  const requests = recurringChargeTermsRequests(ids, '2026-09-12');
  assert.deepEqual(requests.flatMap(request => request.ids), ids);
  assert.ok(requests.length > 3);
  for (const request of requests) {
    assert.ok(request.path.length <= 6000);
    assert.ok(request.ids.length <= 200);
    const url = new URL(request.path, 'https://example.test');
    assert.equal(url.pathname, '/api/rent-ops/recurring-charge-terms');
    assert.equal(url.searchParams.get('asOfDate'), '2026-09-12');
    assert.deepEqual(url.searchParams.get('scheduleIds')?.split(','), request.ids);
  }
  assert.deepEqual(recurringChargeTermsRequests([], '2026-09-12'), []);
  const short = recurringChargeTermsRequests(Array.from({ length: 401 }, (_, i) => String(i)), '2026-09-12');
  assert.deepEqual(short.map(request => request.ids.length), [200, 200, 1]);
});
