import type { ViewFilters } from '../types';

// Match the server's operational calendar, independently of the device time zone.
const businessDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
export function workspaceToday(now = new Date()): string {
  const parts = Object.fromEntries(businessDateFormatter.formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function rollWorkspaceDate(filters: ViewFilters, now = new Date()): ViewFilters {
  if (filters.asOfMode !== 'today') return filters;
  const today = workspaceToday(now);
  return filters.asOfDate === today ? filters : { ...filters, asOfDate: today };
}
export function selectWorkspaceToday(filters: ViewFilters, now = new Date()): ViewFilters {
  return rollWorkspaceDate(filters.asOfMode === 'today' ? filters : { ...filters, asOfMode: 'today' }, now);
}
export function pinWorkspaceDate(filters: ViewFilters, asOfDate: string): ViewFilters {
  return { ...filters, asOfDate, asOfMode: 'fixed' };
}

// Find the next New York date boundary, including 23/25-hour DST days.
export function millisecondsToNextWorkspaceDay(now = new Date()): number {
  const start = now.getTime();
  const today = workspaceToday(now);
  let low = start, high = start + 26 * 60 * 60 * 1000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (workspaceToday(new Date(middle)) === today) low = middle;
    else high = middle;
  }
  return high - start;
}

export function watchWorkspaceDate(
  onTick: (now: Date) => void,
  environment: {
    now: () => Date;
    schedule: (callback: () => void, delay: number) => unknown;
    cancel: (timer: unknown) => void;
    onResume: (callback: () => void) => () => void;
  },
): () => void {
  let timer: unknown;
  const tick = () => {
    environment.cancel(timer);
    const now = environment.now();
    onTick(now);
    timer = environment.schedule(tick, millisecondsToNextWorkspaceDay(now));
  };
  tick();
  const removeResume = environment.onResume(tick);
  return () => { environment.cancel(timer); removeResume(); };
}
