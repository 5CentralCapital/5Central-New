import type { AdminTenancyView } from '../types';
export type TenancyLifecycleMode = 'move-in' | 'notice' | 'move-out';
const knownFact = (value?: string) => value === undefined || value === 'source' || value === 'manual';
const datedOn = (value: string | undefined, today: string) => !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value && value <= today;
export function lifecycleEligible(tenancy: AdminTenancyView, mode: TenancyLifecycleMode, today: string): boolean {
  const links = [tenancy.propertyLinkKnowledge, tenancy.unitLinkKnowledge, tenancy.primaryPersonLinkKnowledge];
  if (!tenancy.id || !tenancy.propertyId || !tenancy.unitId || !tenancy.primaryPersonId || links.some(value => value !== undefined && value !== 'exact' && value !== 'manual')) return false;
  if (tenancy.operationalEndConfirmationKnowledge === 'manual' && datedOn(tenancy.operationalEndConfirmedOn, today)) return false;
  if (!knownFact(tenancy.statusKnowledge) || tenancy.actualMoveOutOn) return false;
  if (mode === 'move-in') return tenancy.status === 'future' && !datedOn(tenancy.actualMoveInOn, today);
  const movedIn = knownFact(tenancy.actualMoveInKnowledge) && datedOn(tenancy.actualMoveInOn, today);
  const observed = tenancy.occupancyConfirmationKnowledge === 'manual' && !tenancy.actualMoveInOn && datedOn(tenancy.occupancyConfirmedOn, today);
  return (tenancy.status === 'current' || tenancy.status === 'notice') && (movedIn || observed);
}
export function lifecyclePatch(tenancy: AdminTenancyView, mode: TenancyLifecycleMode, date: string, today: string, expectedMoveOutOn?: string) {
  const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
  if (!tenancy.id || !tenancy.propertyId || !tenancy.unitId || !tenancy.primaryPersonId || !tenancy.recordRevision) throw new Error('Refresh and select an exact tenancy with a current revision.');
  if (!validDate(today) || !validDate(date) || date > today) throw new Error('An actual event must have a valid date on or before today.');
  if (tenancy.actualMoveOutOn || tenancy.status === 'past' || tenancy.status === 'cancelled') throw new Error('This tenancy has ended. Select an active or future tenancy.');
  if (!lifecycleEligible(tenancy, mode, today)) throw new Error('This tenancy is not eligible for that move. Refresh and review current occupancy.');
  const base = { id: tenancy.id, revision: tenancy.recordRevision };
  if (mode === 'move-in') {
    if (tenancy.status !== 'future' || tenancy.actualMoveInOn && tenancy.actualMoveInOn <= today) throw new Error('Select a future tenancy that has not moved in.');
    return { ...base, status: 'current', actualMoveInOn: date };
  }
  if (!['current', 'notice'].includes(tenancy.status ?? '')) throw new Error('Select a current tenancy.');
  if (tenancy.actualMoveInOn && date < tenancy.actualMoveInOn) throw new Error('The event cannot predate actual move-in.');
  if (mode === 'notice') {
    if (!expectedMoveOutOn || !validDate(expectedMoveOutOn) || expectedMoveOutOn < date || expectedMoveOutOn < today) throw new Error('Expected departure must be today or later and cannot predate notice.');
    return { ...base, status: 'notice', noticeOn: date, expectedMoveOutOn };
  }
  return { ...base, status: 'past', actualMoveOutOn: date };
}
