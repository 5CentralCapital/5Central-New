import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticRentOpsSnapshot } from '../fixtures/synthetic';
import { presentTenantHome } from './presentation';
import { deriveManagerAccountLedger } from '../domain/reports';

function fixture() {
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  const tenancy = snapshot.tenancies[0];
  const base = snapshot.ledgerTransactions.find(row => row.tenancyId === tenancy.id)!;
  snapshot.ledgerTransactions = [{ ...base, id: 'charge', kind: 'charge', amountCents: 10000, status: 'posted', postedOn: '2026-08-01' }];
  snapshot.paymentAllocations = [];
  const account = { id: 'login', personId: tenancy.primaryPersonId, tenancyId: tenancy.id, email: 'resident@example.test', status: 'active' as const };
  return { snapshot, tenancy, account, charge: snapshot.ledgerTransactions[0] };
}
function parity(f: ReturnType<typeof fixture>, asOfDate: string) {
  const manager = deriveManagerAccountLedger(f.snapshot, f.account.personId, [f.tenancy.id], { asOfDate });
  const home = presentTenantHome(f.snapshot, f.account, asOfDate)!;
  assert.deepEqual(home.ledger.map(r => r.balanceCents), manager.map(r => r.runningBalanceCents));
  assert.equal(home.balance.amountCents, manager.at(-1)?.runningBalanceCents ?? 0);
  return home;
}

test('one projection preserves credits, adjustments and reversals with manager opening balance', () => {
  const f = fixture();
  const credit = { ...f.charge, id: 'credit', kind: 'credit' as const, amountCents: 2000, postedOn: '2026-08-05' };
  f.snapshot.ledgerTransactions.push(credit, { ...f.charge, id: 'adjustment', kind: 'adjustment', adjustmentDirection: 'debit', amountCents: 1000, postedOn: '2026-09-01' }, { ...credit, id: 'credit-return', kind: 'reversal', reversalOfId: credit.id, postedOn: '2026-09-02' });
  const home = parity(f, '2026-09-07');
  assert.deepEqual(home.ledger.map(r => r.balanceCents), [10000, 8000, 9000, 11000]);
  const ranged = deriveManagerAccountLedger(f.snapshot, f.account.personId, [f.tenancy.id], { asOfDate: '2026-09-07', fromDate: '2026-09-01' });
  assert.equal(ranged[0].openingBalanceCents, 8000);
  assert.equal(ranged.at(-1)?.runningBalanceCents, 11000);
});

test('shared application retains dated return and never exposes root metadata', () => {
  const f = fixture();
  const receipt = { ...f.charge, id: 'PRIVATE-OTHER-RECEIPT', tenancyId: null, personId: 'other-account', propertyId: null, unitId: null, kind: 'payment' as const, amountCents: 990000, postedOn: '2026-08-02', allocationMode: 'multi_property' as const, description: 'PRIVATE OTHER RESIDENT COMMENT', source: { system: 'rent_manager' as const, entityType: 'ledger_transaction' as const, sourceId: 'PRIVATE-SOURCE' } };
  f.snapshot.ledgerTransactions.push(receipt);
  f.snapshot.paymentAllocations.push({ id: 'application', paymentTransactionId: receipt.id, chargeTransactionId: f.charge.id, amountCents: 4000, allocatedOn: '2026-08-03' });
  f.snapshot.ledgerTransactions.push({ ...receipt, id: 'private-return', kind: 'reversal', reversalOfId: receipt.id, postedOn: '2026-09-02' });
  const before = parity(f, '2026-09-01');
  assert.equal(before.balance.amountCents, 6000);
  const after = parity(f, '2026-09-07');
  assert.deepEqual(after.ledger.map(r => [r.date, r.balanceCents]), [['2026-08-01', 10000], ['2026-08-03', 6000], ['2026-09-02', 10000]]);
  assert.equal(JSON.stringify(after).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(after).includes('990000'), false);
  assert.equal(after.ledger[1].openCents, 0);
});

test('ambiguous and mismatched reversals null all running balances', () => {
  const f = fixture();
  f.snapshot.ledgerTransactions.push({ ...f.charge, id: 'wrong-return', kind: 'reversal', reversalOfId: f.charge.id, amountCents: 1, postedOn: '2026-09-02' });
  const home = presentTenantHome(f.snapshot, f.account, '2026-09-07')!;
  assert.equal(home.balance.complete, false);
  assert.equal(home.balance.amountCents, null);
  assert(home.ledger.every(row => row.balanceCents === null));
  assert.deepEqual(home.ledger.map(r => r.balanceCents), deriveManagerAccountLedger(f.snapshot, f.account.personId, [f.tenancy.id], { asOfDate: '2026-09-07' }).map(r => r.runningBalanceCents));
});

test('conflicting account on a granted tenancy never appears in resident history', () => {
  const f = fixture();
  f.snapshot.ledgerTransactions.push({ ...f.charge, id: 'foreign-entry', personId: 'other-account', description: 'PRIVATE OTHER ACCOUNT' });
  assert.equal(JSON.stringify(parity(f, '2026-09-07')).includes('PRIVATE'), false);
});

test('overflow at an intermediate balance invalidates every total and range opening', () => {
  const f = fixture();
  f.charge.amountCents = Number.MAX_SAFE_INTEGER;
  f.snapshot.ledgerTransactions.push({ ...f.charge, id: 'second-charge', amountCents: 1, postedOn: '2026-08-02' }, { ...f.charge, id: 'payment', kind: 'payment', amountCents: 1, postedOn: '2026-08-03' });
  const home = presentTenantHome(f.snapshot, f.account, '2026-09-07')!;
  assert.equal(home.balance.complete, false);
  assert(home.ledger.every(row => row.balanceCents === null));
  const ranged = deriveManagerAccountLedger(f.snapshot, f.account.personId, [f.tenancy.id], { asOfDate: '2026-09-07', fromDate: '2026-09-01' });
  assert.equal(ranged[0].openingBalanceCents, null);
  assert.equal(ranged[0].balanceComplete, false);
});

test('empty imported account history is unverified rather than a known zero', () => {
  const f = fixture();
  const person = f.snapshot.people.find(row => row.id === f.account.personId)!;
  person.source = { system: 'rent_manager', entityType: 'person', sourceId: 'tenant:887' };
  f.snapshot.ledgerTransactions = [];
  const home = presentTenantHome(f.snapshot, f.account, '2026-09-07')!;
  assert.deepEqual(home.ledger, []);
  assert.deepEqual(home.balance, { amountCents: null, complete: false, asOfDate: '2026-09-07' });
  assert.deepEqual(home.historyCoverage, { status: 'unverified', complete: false });
  assert.equal(JSON.stringify(home.historyCoverage).includes('887'), false);
});

test('history coverage stays distinct from known imported financial amounts', () => {
  const f = fixture();
  f.snapshot.people.find(row => row.id === f.account.personId)!.source = { system: 'rent_manager', entityType: 'person', sourceId: 'tenant:887' };
  f.charge.description = null;
  const home = presentTenantHome(f.snapshot, f.account, '2026-09-07')!;
  assert.equal(home.balance.amountCents, 10000);
  assert.equal(home.balance.complete, true);
  assert.equal(home.historyCoverage?.complete, false);
  assert.equal(home.ledger[0].description, 'Charge');
});
