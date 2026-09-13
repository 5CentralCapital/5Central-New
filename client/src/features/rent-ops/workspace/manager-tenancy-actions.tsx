import { useState, type FormEvent } from 'react';
import type { AdminSnapshot } from '../types';
import { postRentOpsMutation } from '../api';
import { lifecycleEligible, lifecyclePatch, type TenancyLifecycleMode } from './tenancy-lifecycle';
export function ManagerTenancyActions({ snapshot, businessDate, onSaved, mode: initialMode, onClose, propertyId = 'all', personId }: { snapshot: AdminSnapshot; businessDate: string; onSaved: () => Promise<void>; mode?: TenancyLifecycleMode; onClose?: () => void; propertyId?: string; personId?: string }) {
  const [mode, setMode] = useState<TenancyLifecycleMode>(initialMode ?? 'move-in');
  const [tenancyId, setTenancyId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [saved, setSaved] = useState(false);
  const rows = snapshot.snapshot.tenancies.filter(row => row.id && (propertyId === 'all' || row.propertyId === propertyId) && (!personId || row.primaryPersonId === personId) && lifecycleEligible(row, mode, businessDate));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(''); setBusy(true);
    try {
      const tenancy = rows.find(row => row.id === tenancyId);
      if (!tenancy) throw new Error('Select the exact resident, property and unit.');
      const data = new FormData(event.currentTarget);
      const payload = lifecyclePatch(tenancy, mode, String(data.get('date')), businessDate, String(data.get('expectedMoveOutOn') ?? ''));
      const result = await postRentOpsMutation({ action: 'save-tenancy', payload });
      if (!result.ok) throw new Error(result.message ?? 'The tenancy was not saved.');
      setSaved(true);
      try { await onSaved(); setMessage(mode === 'notice' ? 'Notice saved. Occupancy continues until an actual move-out is recorded.' : 'Actual move recorded and current occupancy refreshed.'); }
      catch { setMessage('Move saved, but the refreshed occupancy could not be loaded. Refresh before making another change.'); }
    } catch (error) { setMessage(error instanceof Error ? error.message : 'The move could not be saved.'); }
    finally { setBusy(false); }
  }
  return <section className="ro-panel" aria-label="Move-in and move-out"><h2>Move-in and move-out</h2><form className="ro-income-form" onSubmit={submit}><fieldset disabled={busy || saved}><div className="ro-form-grid">
    <label>Action<select value={mode} onChange={event => { setMode(event.target.value as TenancyLifecycleMode); setTenancyId(''); setMessage(''); }}><option value="move-in">Record actual move-in</option><option value="notice">Record notice / planned departure</option><option value="move-out">Record actual move-out</option></select></label>
    <label>Resident · property · unit<select required value={tenancyId} onChange={event => setTenancyId(event.target.value)}><option value="">Select exact tenancy…</option>{rows.map(row => { const person = snapshot.snapshot.people.find(person => person.id === row.primaryPersonId); const unit = snapshot.snapshot.units.find(unit => unit.id === row.unitId); const property = snapshot.snapshot.properties.find(property => property.id === row.propertyId); return <option value={row.id} key={row.id}>{person?.firstName} {person?.lastName} · {property?.name} · Unit {unit?.unitNumber} · {row.status}</option>; })}</select></label>
    <label>{mode === 'notice' ? 'Notice received date' : 'Actual move date'}<input required name="date" type="date" max={businessDate} defaultValue={businessDate}/></label>
    {mode === 'notice' && <label>Expected move-out date<input required name="expectedMoveOutOn" type="date" min={businessDate}/></label>}
    </div><p>{mode === 'move-in' ? 'Select an existing future tenancy. Create or assign the tenancy first if it is missing.' : mode === 'notice' ? 'A planned departure keeps the resident occupied.' : 'Confirm the resident has physically moved out. Recurring charges require separate review; posted money and deposit records are retained.'}</p><label><input type="checkbox" required/> I confirm this resident, unit and event date.</label><div className="ro-actions"><button className="primary" disabled={!businessDate || !rows.length}>{busy ? 'Saving…' : mode === 'notice' ? 'Save notice' : 'Record actual move'}</button></div></fieldset></form>{message && <p role="status">{message}</p>}{onClose && <button className="rm-button" disabled={busy} onClick={onClose}>Close</button>}</section>;
}
