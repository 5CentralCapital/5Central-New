import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { ViewFilters } from '../types';
import { rollWorkspaceDate, watchWorkspaceDate, workspaceToday } from './workspace-date';

export function useWorkspaceDate(setFilters: Dispatch<SetStateAction<ViewFilters>>) {
  const [calendarDay, setCalendarDay] = useState(() => workspaceToday());
  useEffect(() => watchWorkspaceDate(now => {
    setCalendarDay(workspaceToday(now));
    setFilters(current => rollWorkspaceDate(current, now));
  }, {
    now: () => new Date(),
    schedule: (callback, delay) => window.setTimeout(callback, delay),
    cancel: timer => window.clearTimeout(timer as number | undefined),
    onResume: callback => {
      const visible = () => { if (document.visibilityState === 'visible') callback(); };
      window.addEventListener('focus', callback);
      document.addEventListener('visibilitychange', visible);
      return () => {
        window.removeEventListener('focus', callback);
        document.removeEventListener('visibilitychange', visible);
      };
    },
  }), [setFilters]);
  // This clock stays current even when the displayed report date is pinned.
  // Callers use it to reload server-owned mutation dates, never to supply them.
  return calendarDay;
}
