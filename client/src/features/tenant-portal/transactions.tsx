import { usdCurrencyFormatter } from '../../lib/rent-ops-formatters';
import { useState } from 'react';
import { FileDown } from 'lucide-react';
import type { TenantHome } from '@shared/tenant-portal-contracts';
import { emptyTransactionFilters, filterTransactions, hasTransactionReferences, transactionSide, transactionPage, transactionsCsv, type ResidentTransaction } from './transactions-view';
function money(value: number | null | undefined) { return Number.isSafeInteger(value) ? usdCurrencyFormatter.format(value! / 100) : 'Unverified'; }
function date(value: string | null) { if (!value) return 'Unverified'; const parsed = new Date(`${value.slice(0, 10)}T12:00:00`); return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unverified'; }
function label(value: string) { return value.replaceAll('_', ' ').replace(/^./, x => x.toUpperCase()); }
function sideMoney(row: ResidentTransaction, side: 'chargeCents' | 'paymentCreditCents') {
  const value = transactionSide(row, side);
  return value === 'not-applicable' ? '—' : value === 'unverified' ? 'Unverified' : money(value);
}
export function TransactionTable({ rows, compact = false, showReference = hasTransactionReferences(rows) }: { rows: ResidentTransaction[]; compact?: boolean; showReference?: boolean }) {
  return <div className="tp-table-wrap" tabIndex={0} aria-label="Transactions"><table><thead><tr><th>Date</th><th>Description</th>{!compact && <><th>Type</th><th>Status</th><th>Property / unit</th>{showReference && <th>Reference</th>}</>}<th className="tp-money">Charge</th><th className="tp-money">Payment / credit</th><th className="tp-money">Balance</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td>{date(row.date)}</td><td>{row.description}</td>{!compact && <><td>{label(row.kind)}</td><td>{row.status ? label(row.status) : "Unverified"}</td><td>{row.propertyName ?? 'Unverified'}{row.unitNumber ? ` · ${row.unitNumber}` : ''}</td>{showReference && <td>{row.reference?.trim() || '—'}</td>}</>}<td className="tp-money">{sideMoney(row, 'chargeCents')}</td><td className="tp-money">{sideMoney(row, 'paymentCreditCents')}</td><td className="tp-money">{money(row.balanceCents)}</td></tr>)}</tbody></table></div>;
}
export function ResidentTransactions({ home }: { home: TenantHome }) {
  const [filters, setFilters] = useState(emptyTransactionFilters);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const rows: ResidentTransaction[] = home.ledger;
  const filtered = filterTransactions(rows, filters);
  const result = transactionPage(filtered, page, size);
  function filter(key: keyof typeof filters, value: string) { setFilters(previous => ({ ...previous, [key]: value })); setPage(1); }
  function download() { const url = URL.createObjectURL(new Blob(['\uFEFF', transactionsCsv(filtered)], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = 'transactions.csv'; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
  return <section className="tp-transactions" aria-labelledby="transactions-title"><div className="tp-page-heading"><h1 id="transactions-title">Transactions</h1><button className="tp-secondary" onClick={download} disabled={!filtered.length}><FileDown />Export</button></div><div className="tp-transaction-filters"><label>Search<input type="search" value={filters.search} onChange={event => filter('search', event.target.value)} /></label><label>Type<select value={filters.kind} onChange={event => filter('kind', event.target.value)}><option value="">All types</option>{Array.from(new Set(rows.map(row => row.kind))).sort().map(kind => <option key={kind} value={kind}>{label(kind)}</option>)}</select></label><label>From<input type="date" value={filters.from} max={filters.to || undefined} onChange={event => filter('from', event.target.value)} /></label><label>To<input type="date" value={filters.to} min={filters.from || undefined} onChange={event => filter('to', event.target.value)} /></label><button className="tp-secondary" onClick={() => { setFilters(emptyTransactionFilters); setPage(1); }}>Clear</button></div><div className="tp-card tp-transaction-list">{filtered.length ? <TransactionTable rows={result.rows} showReference={hasTransactionReferences(filtered)} /> : <p>No transactions found.</p>}<div className="tp-pagination"><span>{filtered.length ? `${(result.current - 1) * size + 1}–${Math.min(result.current * size, filtered.length)} of ${filtered.length}` : '0 transactions'}</span><label>Rows<select value={size} onChange={event => { setSize(Number(event.target.value)); setPage(1); }}>{[25, 50, 100].map(value => <option key={value} value={value}>{value}</option>)}</select></label><button className="tp-secondary" disabled={result.current === 1} onClick={() => setPage(result.current - 1)}>Previous</button><button className="tp-secondary" disabled={result.current === result.pages} onClick={() => setPage(result.current + 1)}>Next</button></div></div></section>;
}
