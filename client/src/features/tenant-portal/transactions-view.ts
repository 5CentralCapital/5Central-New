import type { TenantLedgerEntry } from '@shared/tenant-portal-contracts';

export type ResidentTransaction = TenantLedgerEntry;
export type TransactionFilters = { search: string; kind: string; from: string; to: string };
export const emptyTransactionFilters: TransactionFilters = { search: '', kind: '', from: '', to: '' };
export function filterTransactions(rows: ResidentTransaction[], filters: TransactionFilters): ResidentTransaction[] {
  const query = filters.search.trim().toLocaleLowerCase();
  return rows.filter(row => (!filters.kind || row.kind === filters.kind)
    && (!filters.from || !!row.date && row.date.slice(0, 10) >= filters.from)
    && (!filters.to || !!row.date && row.date.slice(0, 10) <= filters.to)
    && (!query || [row.description, row.reference, row.propertyName, row.unitNumber, row.kind].filter(Boolean).join(' ').toLocaleLowerCase().includes(query)))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}
export function transactionPage(rows: ResidentTransaction[], page: number, size: number) {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(Math.max(1, page), pages);
  return { rows: rows.slice((current - 1) * size, current * size), current, pages };
}
function csvCell(value: string): string { return `"${(/^[=+@\-\t\r\n]/.test(value) ? "'" : '') + value.replaceAll('"', '""')}"`; }
function csvMoney(value: number | null | undefined): string { return Number.isSafeInteger(value) ? (value! / 100).toFixed(2) : 'Unverified'; }
export function transactionsCsv(rows: ResidentTransaction[]): string {
  return [['Date', 'Type', 'Status', 'Property', 'Unit', 'Reference', 'Description', 'Charge', 'Payment / credit', 'Balance'].map(csvCell).join(','),
    ...rows.map(row => [row.date ?? 'Unverified', row.kind.replaceAll('_', ' '), row.status ?? 'Unverified', row.propertyName ?? 'Unverified', row.unitNumber ?? 'Unverified', row.reference ?? '', row.description, csvMoney(row.chargeCents), csvMoney(row.paymentCreditCents), csvMoney(row.balanceCents)].map(csvCell).join(','))].join('\r\n');
}
