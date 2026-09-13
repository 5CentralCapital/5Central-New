import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRentOpsAuth } from '../auth-ui';
import { loadRentOpsReport, postRentOpsMutation } from '../api';
import { handleRentOpsMutationError, RENT_OPS_CONFLICT_NOTICE } from '../ui';
import type { AdminUnitView, RentRollRow, ViewFilters } from '../types';
import { reportQueryKey } from './report-model';
import { READINESS_OPTIONS, unitOccupancyMap, unitReadinessDisplay, unitReadinessPayload, unitReadinessQuery } from './unit-readiness-model';
import './editor.css';

const ReadinessContext = createContext<{ occupancy: Map<string, string>; occupancyRows: RentRollRow[]; occupancyReady: boolean; occupancyError: boolean; open: (unit: AdminUnitView) => void }>({ occupancy: new Map(), occupancyRows: [], occupancyReady: false, occupancyError: false, open: () => {} });
export function useUnitReadiness() { return useContext(ReadinessContext); }
export function UnitReadinessBadge({ unit }: { unit: AdminUnitView }) {
  const { occupancy, open } = useUnitReadiness();
  const display = unitReadinessDisplay(unit, occupancy.get(unit.id ?? ''));
  return <button type="button" className={`rm-status rm-readiness-button ${display.status}`} aria-haspopup="dialog" aria-label={`Unit ${unit.unitNumber ?? ''}: ${display.label}. View readiness options`} disabled={!unit.id} onClick={event => { event.stopPropagation(); open(unit); }}>{display.label}</button>;
}
export function UnitReadinessProvider({ filters, readOnly, children }: { filters: ViewFilters; readOnly: boolean; children: ReactNode }) {
  const auth = useRentOpsAuth();
  const client = useQueryClient();
  const query = unitReadinessQuery(filters);
  const report = useQuery({ queryKey: reportQueryKey('rent-roll', query, auth.user?.id ?? ''), queryFn: ({ signal }) => loadRentOpsReport('rent-roll', query, signal), enabled: auth.status === 'authenticated' && !!filters.asOfDate, staleTime: 30_000, retry: false });
  const occupancy = unitOccupancyMap(report.isError ? [] : report.data);
  const [selected, setSelected] = useState<AdminUnitView>();
  const [notice, setNotice] = useState('');
  const refresh = () => client.invalidateQueries({ queryKey: ['rent-ops-workspace'] });
  return <ReadinessContext.Provider value={{ occupancy, occupancyRows: (report.isError ? [] : report.data ?? []) as RentRollRow[], occupancyReady: report.isSuccess, occupancyError: report.isError, open: unit => { setNotice(''); setSelected(unit); } }}>
    {notice && <p className="rm-warning" role="status">{notice}</p>}
    {report.isError && <p className="rm-warning" role="alert">Occupancy could not be loaded. <button className="rm-link-button" onClick={() => void report.refetch()}>Retry</button></p>}
    {children}
    {selected && createPortal(<ReadinessDialog unit={selected} occupancy={occupancy.get(selected.id ?? '')} readOnly={readOnly || auth.status !== 'authenticated'} asOfDate={filters.asOfDate} onClose={() => setSelected(undefined)} onSaved={() => { setSelected(undefined); setNotice('Unit readiness saved.'); void refresh(); }} onConflict={() => { setSelected(undefined); setNotice(RENT_OPS_CONFLICT_NOTICE); void refresh(); }} />, document.body)}
  </ReadinessContext.Provider>;
}
function ReadinessDialog({ unit, occupancy, readOnly, asOfDate, onClose, onSaved, onConflict }: { unit: AdminUnitView; occupancy?: string; readOnly: boolean; asOfDate: string; onClose: () => void; onSaved: () => void; onConflict: () => void }) {
  const [readiness, setReadiness] = useState(unit.readiness ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [discard, setDiscard] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const submitting = useRef(false);
  const dirty = readiness !== (unit.readiness ?? '');
  const close = () => { if (submitting.current) return; if (dirty) setDiscard(true); else onClose(); };
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; dialog.current?.querySelector<HTMLElement>('button')?.focus(); return () => previous?.focus(); }, []);
  useEffect(() => { if (!dirty && !saving) return; const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', protect); return () => window.removeEventListener('beforeunload', protect); }, [dirty, saving]);
  return <div className="rm-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><section ref={dialog} className="rm-dialog rm-readiness-dialog" role="dialog" aria-modal="true" aria-labelledby="rm-readiness-title" aria-describedby="rm-readiness-description" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab') { const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled)') ?? []); const first = items[0], last = items[items.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
  }}><header><h2 id="rm-readiness-title">Unit {unit.unitNumber} readiness</h2><button type="button" aria-label="Close readiness" disabled={saving} onClick={close}>×</button></header><form onSubmit={async event => {
    event.preventDefault(); if (readOnly || submitting.current || !dirty) return;
    submitting.current = true; setSaving(true); setError('');
    try { const result = await postRentOpsMutation({ action: 'save-unit', payload: unitReadinessPayload(unit, readiness) }); if (!result.ok) throw new Error(result.message ?? 'Readiness was not saved.'); onSaved(); }
    catch (cause) { handleRentOpsMutationError(cause, onConflict, setError); }
    finally { submitting.current = false; setSaving(false); }
  }}><p id="rm-readiness-description">{occupancy === 'current' ? `Occupied as of ${asOfDate}. Readiness describes the unit’s preparation status; changing it does not end the tenancy or make this unit vacant.` : occupancy ? `Occupancy as of ${asOfDate}: ${occupancy.replaceAll('_', ' ')}. Readiness changes do not change occupancy.` : 'Occupancy is not available. Readiness changes do not change occupancy.'}</p>
    <label className="rm-readiness-field">{occupancy === 'current' ? 'Underlying readiness' : 'Readiness'}<select aria-label={occupancy === 'current' ? 'Underlying readiness' : 'Readiness'} value={readiness} disabled={readOnly || saving} required onChange={event => setReadiness(event.target.value)}><option value="" disabled>Choose readiness</option>{!READINESS_OPTIONS.some(([key]) => key === readiness) && readiness && <option value={readiness} disabled>Not recorded</option>}{READINESS_OPTIONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    {readOnly && <p>Read-only preview.</p>}{error && <p role="alert" className="rm-dialog-error">{error}</p>}
    {discard && <div className="rm-dialog-discard" role="alert">Discard readiness changes? <button type="button" onClick={onClose}>Discard</button><button type="button" onClick={() => setDiscard(false)}>Keep editing</button></div>}
    <footer className="rm-dialog-footer"><button type="button" disabled={saving} onClick={close}>Cancel</button><button className="primary" disabled={readOnly || saving || !dirty || !unit.recordRevision}>{saving ? 'Saving…' : 'Save readiness'}</button></footer>
  </form></section></div>;
}
