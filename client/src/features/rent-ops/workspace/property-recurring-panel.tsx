import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { loadOperationalScheduleRegister } from '../api';
import { useRentOpsAuth } from '../auth-ui';
import type { FormValues, QuickAction } from '../form-payload';
import type { AdminPropertyView, AdminSnapshot, AdminUnitView } from '../types';
import { DataGrid, type GridColumn } from './grid';
import { EntityLink, RecordLink } from './entity-link';
import { formatDate, formatLabel, formatMoney } from './display';
import { recurringRecordCreateValues, recurringRecordSuccessorValues } from './property-unit-model';
import { recurringRegisterQueryKey, type RecurringRegisterView } from './recurring-register-model';
import { propertyRecurringRows } from './property-recurring-panel-model';
import { useRecurringChargeTerms } from './use-recurring-charge-terms';

export interface PropertyRecurringPanelProps {
  snapshot: AdminSnapshot;
  property: AdminPropertyView;
  unit?: AdminUnitView;
  asOfDate: string;
  readOnly?: boolean;
  onEdit: (action: QuickAction, values?: FormValues) => void;
}

const views = [['current', 'Current charges'], ['history', 'Past charges'], ['future', 'Future charges'], ['all', 'All schedules']] as const;

/** Both record tabs use the same operational classification as the global register. */
export function PropertyRecurringPanel({ snapshot, property, unit, asOfDate, readOnly = false, onEdit }: PropertyRecurringPanelProps) {
  const [view, setView] = useState<RecurringRegisterView>('current');
  const auth = useRentOpsAuth();
  const metadata = useQuery({
    queryKey: recurringRegisterQueryKey(auth.user?.id ?? '', 'all', property.id ?? '', asOfDate),
    queryFn: ({ signal }) => loadOperationalScheduleRegister({ propertyScope: 'all', propertyId: property.id, asOfDate }, signal),
    enabled: auth.status === 'authenticated' && Boolean(property.id && asOfDate),
    staleTime: 60_000, gcTime: 300_000, retry: false,
  });
  const rows = metadata.data?.asOfDate === asOfDate ? propertyRecurringRows(snapshot, property.id, unit, metadata.data, view) : [];
  const terms = useRecurringChargeTerms(rows.map(row => row.id), asOfDate);
  const createValues = recurringRecordCreateValues(snapshot, property.id, unit);
  const canEdit = !readOnly && auth.status === 'authenticated';
  type Row = typeof rows[number];
  const columns: GridColumn<Row>[] = [
    { key: 'unitName', label: 'Unit', render: row => <RecordLink kind="unit" recordId={row.linkedUnitId}>{row.unitName}</RecordLink> },
    { key: 'tenantName', label: 'Tenant', render: row => <EntityLink personId={row.linkedPersonId} tab="charges">{row.tenantName}</EntityLink> },
    { key: 'category', label: 'Category', render: row => row.category ? formatLabel(row.category) : 'Unverified' },
    { key: 'chargeName', label: 'Charge' },
    { key: 'amountCents', label: 'Amount', align: 'right', render: row => <EntityLink personId={row.linkedPersonId} tab="charges">{formatMoney(row.amountCents)}</EntityLink> },
    { key: 'chargeStarts', label: 'Charge starts', render: row => terms.label(row.id, 'start', row.scopeType) },
    { key: 'leaseThrough', label: 'Lease through', render: row => terms.label(row.id, 'through', row.scopeType) },
    { key: 'scheduledEnd', label: 'Scheduled end', render: row => row.scheduledEnd ? formatDate(row.scheduledEnd) : '—' },
    { key: 'displayStatus', label: 'Status' },
    { key: 'scopeLabel', label: 'Applies to' },
    { key: 'actions', label: 'Actions', render: row => {
      const values = row.canChange ? recurringRecordSuccessorValues(snapshot, row) : undefined;
      return canEdit && values ? <div className="rm-actions"><button className="rm-button" onClick={() => onEdit('replace-recurring-schedule', values)}>Schedule change</button><button className="rm-button" onClick={() => onEdit('end-recurring-schedule', values)}>End</button></div> : '—';
    } },
  ];
  return <section className="rm-property-unit-tab-panel">
    <div className="rm-property-unit-panel-heading"><h3>Recurring charges</h3>{canEdit && <button className="rm-button rm-button-primary" disabled={!createValues} onClick={() => { if (createValues) onEdit('save-recurring-schedule', createValues); }}><Plus aria-hidden="true" /> Add recurring charge</button>}</div>
    <div className="rm-toolbar"><label>Show<select value={view} onChange={event => setView(event.target.value as RecurringRegisterView)}>{views.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    {metadata.error ? <div className="rm-error" role="alert">Current charge classifications are unavailable. <button className="rm-button" onClick={() => void metadata.refetch()}>Try again</button></div>
      : !metadata.data || metadata.data.asOfDate !== asOfDate ? <p role="status">Loading current charge classifications…</p>
      : <>{!metadata.data.complete && <p role="status">Current charges include only confirmed schedules. All schedules includes records needing review.</p>}<DataGrid rows={rows} columns={columns} getRowKey={row => row.key} emptyMessage="No recurring charges match this view." caption={unit ? 'Recurring charges for this unit' : 'Recurring charges at this property'} storageKey={unit ? 'rm-unit-recurring-v2' : 'rm-property-recurring-v2'} /></>}
  </section>;
}
