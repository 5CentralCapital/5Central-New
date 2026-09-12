import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTransactionFilters, filterTransactions, transactionPage, transactionsCsv, type ResidentTransaction } from './transactions-view';
const rows: ResidentTransaction[] = Array.from({ length: 137 }, (_, index) => ({ id: `private-${index}`, date: `2026-09-${String(index % 28 + 1).padStart(2, '0')}`, kind: index % 2 ? 'payment' : 'rent_charge', description: index % 2 ? 'Payment' : 'Rent', status: 'posted', amountCents: 10000, balanceCents: 987654 + index, chargeCents: index % 2 ? 0 : 10000, paymentCreditCents: index % 2 ? 10000 : 0, propertyName: 'Oak Homes', unitNumber: '2', reference: index === 130 ? 'CHECK 120' : null }));
test('all available history remains pageable beyond 120 entries', () => {
  const filtered = filterTransactions(rows, emptyTransactionFilters);
  assert.equal(filtered.length, 137);
  const final = transactionPage(filtered, 6, 25);
  assert.equal(final.rows.length, 12);
  assert.equal(final.current, 6);
  assert.equal(transactionPage(filtered, 99, 25).current, 6);
});
test('filtering and pagination preserve server running balance and input order', () => {
  const original = structuredClone(rows);
  const filtered = filterTransactions(rows, { search: 'oak', kind: 'payment', from: '2026-09-10', to: '2026-09-20' });
  assert.ok(filtered.length > 0);
  for (const row of transactionPage(filtered, 2, 5).rows) assert.equal(row.balanceCents, rows.find(source => source.id === row.id)!.balanceCents);
  assert.deepEqual(rows, original);
  assert.equal(filterTransactions(rows, { ...emptyTransactionFilters, search: 'CHECK 120' }).length, 1);
  assert.equal(filterTransactions(rows, { ...emptyTransactionFilters, search: 'private-' }).length, 0);
});
test('export includes entire filtered result and only public columns', () => {
  const filtered = filterTransactions(rows, { ...emptyTransactionFilters, kind: 'payment' });
  const csv = transactionsCsv(filtered);
  assert.equal(csv.split('\r\n').length, filtered.length + 1);
  assert.ok(!csv.includes('private-'));
  assert.ok(csv.includes('9876.55'));
  assert.ok(!csv.includes('rent_charge'));
});
test('unknown values stay unverified and CSV neutralizes formulas and quotes', () => {
  const row = { ...rows[0], description: '=SUM(1,2) "quoted"', balanceCents: null, chargeCents: null, paymentCreditCents: null };
  const csv = transactionsCsv([row]);
  assert.ok(csv.includes('"\'=SUM(1,2) ""quoted"""'));
  assert.equal(csv.match(/Unverified/g)?.length, 3);
  assert.equal(filterTransactions([{ ...row, date: null }], { ...emptyTransactionFilters, from: '2026-01-01' }).length, 0);
});
