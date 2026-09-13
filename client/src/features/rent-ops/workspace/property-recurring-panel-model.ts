import type { AdminSnapshot, AdminUnitView, OperationalScheduleRegister } from '../types';
import { knownLink, recurringSchedulesForProperty, recurringSchedulesForUnit } from './property-unit-model';
import { selectRecurringRegisterRows, type RecurringRegisterView } from './recurring-register-model';
import { scheduleDisplayInterval } from './schedule-display';

export function propertyRecurringRows(snapshot: AdminSnapshot, propertyId: string | undefined, unit: AdminUnitView | undefined, metadata: OperationalScheduleRegister, view: RecurringRegisterView) {
  const records = unit ? (unit.propertyId === propertyId ? recurringSchedulesForUnit(snapshot, unit) : []) : recurringSchedulesForProperty(snapshot, propertyId);
  const selected = selectRecurringRegisterRows(records.map(record => record.schedule), metadata, view);
  return selected.map((row, index) => {
    const tenancy = row.tenancyId ? snapshot.snapshot.tenancies.find(candidate => candidate.id === row.tenancyId && candidate.propertyId === propertyId && knownLink(candidate.propertyId, candidate.propertyLinkKnowledge)) : undefined;
    const personId = row.personId ?? (row.scopeType === 'tenant' ? row.scopeId : undefined) ?? (tenancy && knownLink(tenancy.primaryPersonId, tenancy.primaryPersonLinkKnowledge) ? tenancy.primaryPersonId : undefined);
    const person = snapshot.snapshot.people.find(candidate => candidate.id === personId);
    const unitId = row.scopeType === 'property' ? undefined : row.unitId ?? (row.scopeType === 'unit' ? row.scopeId : undefined) ?? (tenancy && knownLink(tenancy.unitId, tenancy.unitLinkKnowledge) ? tenancy.unitId : undefined);
    const linkedUnit = snapshot.snapshot.units.find(candidate => candidate.id === unitId && candidate.propertyId === propertyId && knownLink(candidate.propertyId, candidate.propertyLinkKnowledge));
    const definition = snapshot.chargeDefinitions.find(candidate => candidate.id === row.chargeDefinitionId);
    return {
      ...row,
      key: row.id ?? `schedule:${index}`,
      linkedUnitId: linkedUnit?.id,
      linkedPersonId: person?.id,
      unitName: row.scopeType === 'property' ? 'All units' : linkedUnit?.unitNumber ?? 'Unverified',
      tenantName: row.scopeType === 'property' || row.scopeType === 'unit' ? 'Shared charge' : person ? [person.firstName, person.lastName].filter(Boolean).join(' ') || 'Unverified' : 'Unverified',
      chargeName: definition?.displayName ?? (row.category ? row.category.replaceAll('_', ' ') : 'Unverified'),
      scopeLabel: row.scopeType === 'property' ? 'Shared property charge' : row.scopeType === 'unit' ? 'Shared unit charge' : row.scopeType === 'tenant' ? 'Tenant charge' : 'Needs review',
      scheduledEnd: scheduleDisplayInterval(row, metadata.asOfDate).effectiveTo,
    };
  });
}
