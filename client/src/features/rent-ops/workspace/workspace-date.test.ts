import assert from 'node:assert/strict';
import test from 'node:test';
import { millisecondsToNextWorkspaceDay, pinWorkspaceDate, rollWorkspaceDate, selectWorkspaceToday, watchWorkspaceDate, workspaceToday } from './workspace-date';
import { parseWorkspaceFilters, parseWorkspaceRoute, workspaceRouteSearch } from './workspace-state';
import { nowIsoDate } from '../../../../../server/rent-ops/domain/dates';

const before = new Date('2026-09-13T03:59:59.000Z');
const after = new Date('2026-09-13T04:00:00.000Z');
test('fresh pages follow New York today; calendar links remain pinned', () => {
  const fresh = parseWorkspaceFilters('?section=properties', before);
  assert.equal(fresh.asOfDate, '2026-09-12');
  assert.equal(fresh.asOfMode, 'today');
  const href = workspaceRouteSearch(parseWorkspaceRoute('?section=properties'), fresh);
  assert.match(href, /asOf=today/);
  assert.equal(parseWorkspaceFilters(href, after).asOfDate, '2026-09-13');
  const fixed = parseWorkspaceFilters('?asOf=2026-01-01', before);
  assert.equal(rollWorkspaceDate(fixed, after), fixed);
  assert.match(workspaceRouteSearch(parseWorkspaceRoute(''), fixed), /asOf=2026-01-01/);
});
test('midnight and DST boundaries agree with backend business dates', () => {
  for (const instant of ['2026-09-13T03:59:59Z', '2026-09-13T04:00:00Z', '2026-03-08T05:00:00Z', '2026-11-01T04:00:00Z']) {
    assert.equal(workspaceToday(new Date(instant)), nowIsoDate(new Date(instant)));
  }
  assert.equal(millisecondsToNextWorkspaceDay(before), 1000);
  assert.equal(millisecondsToNextWorkspaceDay(new Date('2026-03-08T05:00:00Z')), 23 * 3600000);
  assert.equal(millisecondsToNextWorkspaceDay(new Date('2026-11-01T04:00:00Z')), 25 * 3600000);
});
test('open workspace rolls at midnight, resuming catches sleep, fixed date survives, Today settles without updates', () => {
  let now = before;
  let filters = parseWorkspaceFilters('', now);
  let scheduled: (() => void) | undefined;
  let resume: (() => void) | undefined;
  let delay = 0;
  let count = 0;
  const stop = watchWorkspaceDate(date => { const next = rollWorkspaceDate(filters, date); if (next !== filters) count++; filters = next; }, {
    now: () => now,
    schedule: (callback, ms) => { scheduled = callback; delay = ms; return 1; },
    cancel: () => { scheduled = undefined; },
    onResume: callback => { resume = callback; return () => { resume = undefined; }; },
  });
  assert.equal(delay, 1000);
  now = after; scheduled!();
  assert.equal(filters.asOfDate, '2026-09-13');
  now = new Date('2026-09-16T16:00:00Z'); resume!();
  assert.equal(filters.asOfDate, '2026-09-16');
  filters = pinWorkspaceDate(filters, '2026-08-01');
  now = new Date('2026-09-17T16:00:00Z'); resume!();
  assert.equal(filters.asOfDate, '2026-08-01');
  filters = selectWorkspaceToday(filters, now);
  const current = filters;
  resume!(); resume!();
  assert.equal(filters, current);
  assert.equal(selectWorkspaceToday(filters, now), current);
  assert.equal(count, 2);
  stop(); assert.equal(resume, undefined); assert.equal(scheduled, undefined);
});
