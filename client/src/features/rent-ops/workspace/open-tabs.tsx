import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { WorkspaceRoute } from './workspace-state';

/*
 * Browser-style strip of the records and pages opened this session, shown
 * under the top navigation. Switching tabs restores the exact view (sub-tab,
 * company, report) the record was left on. Kept per browser tab in
 * sessionStorage so a reload keeps the strip; storage failures are ignored.
 */

const MAX_TABS = 12;
const STORAGE_PREFIX = 'rops-open-tabs:';

/** One tab per record or page; sub-views (tenant tab, project tab, …) update that tab instead of opening another. */
export function openTabKey(route: WorkspaceRoute): string {
  return [route.section, route.organizationId ?? '', route.section === 'properties' ? route.kind ?? 'property' : '', route.recordId ?? '', route.section === 'reports' ? route.report : '', route.reportId ?? ''].join(':');
}

function readStored(identity: string): WorkspaceRoute[] {
  if (!identity) return [];
  try {
    const raw = window.sessionStorage.getItem(STORAGE_PREFIX + identity);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is WorkspaceRoute => Boolean(item && typeof item === 'object' && typeof (item as WorkspaceRoute).section === 'string')).slice(0, MAX_TABS) : [];
  } catch { return []; }
}

function writeStored(identity: string, tabs: readonly WorkspaceRoute[]) {
  if (!identity) return;
  try { window.sessionStorage.setItem(STORAGE_PREFIX + identity, JSON.stringify(tabs)); } catch { /* storage unavailable */ }
}

/** Adds or refreshes the tab for `route`; a list landing that turns into a record (e.g. Tenants → first tenant) becomes that record's tab. */
export function nextOpenTabs(tabs: readonly WorkspaceRoute[], route: WorkspaceRoute): WorkspaceRoute[] {
  const key = openTabKey(route);
  // Opening a record turns that section's list landing into the record's tab.
  // A landing opened before its company resolved has no organizationId; it is still the same section's landing.
  const landingKey = (tab: WorkspaceRoute, organizationId: string | undefined) => openTabKey({ ...tab, recordId: undefined, organizationId });
  const isLanding = (tab: WorkspaceRoute) => Boolean(route.recordId) && !tab.recordId && landingKey(tab, tab.organizationId) === landingKey(route, tab.organizationId ? route.organizationId : undefined);
  const landing = tabs.findIndex(isLanding);
  const base = landing >= 0 ? tabs.filter((tab, index) => index === landing || !isLanding(tab)) : tabs;
  const existing = base.findIndex(tab => openTabKey(tab) === key);
  if (existing >= 0) return base.filter(tab => !isLanding(tab)).map(tab => openTabKey(tab) === key ? route : tab);
  if (landing >= 0) return base.map(tab => isLanding(tab) ? route : tab);
  const next = [...tabs, route];
  return next.length > MAX_TABS ? next.slice(next.length - MAX_TABS) : next;
}

export function useOpenTabs(route: WorkspaceRoute, identity: string) {
  const [tabs, setTabs] = useState<WorkspaceRoute[]>(() => nextOpenTabs(readStored(identity), route));
  const loadedFor = useRef(identity);
  useEffect(() => {
    if (loadedFor.current !== identity) { loadedFor.current = identity; setTabs(nextOpenTabs(readStored(identity), route)); return; }
    setTabs(current => nextOpenTabs(current, route));
  }, [route, identity]);
  useEffect(() => { writeStored(identity, tabs); }, [identity, tabs]);
  const close = (key: string) => setTabs(current => current.filter(tab => openTabKey(tab) !== key));
  return { tabs, close };
}

export function OpenTabs({ tabs, active, labelFor, onActivate, onClose }: { tabs: readonly WorkspaceRoute[]; active: WorkspaceRoute; labelFor: (route: WorkspaceRoute) => string; onActivate: (route: WorkspaceRoute) => void; onClose: (key: string) => void }) {
  if (tabs.length < 2) return null;
  const activeKey = openTabKey(active);
  return <nav className="rops-open-tabs" aria-label="Open records">
    {tabs.map((tab, index) => {
      const key = openTabKey(tab);
      const label = labelFor(tab);
      const isActive = key === activeKey;
      return <div className={`rops-open-tab${isActive ? ' is-active' : ''}`} key={key}>
        <button type="button" className="rops-open-tab-label" title={label} aria-current={isActive ? 'page' : undefined} onClick={() => { if (!isActive) onActivate(tab); }}>{label}</button>
        <button type="button" className="rops-open-tab-close" aria-label={`Close ${label}`} onClick={() => {
          onClose(key);
          if (isActive) { const neighbor = tabs[index + 1] ?? tabs[index - 1]; if (neighbor) onActivate(neighbor); }
        }}><X size={12} /></button>
      </div>;
    })}
  </nav>;
}
