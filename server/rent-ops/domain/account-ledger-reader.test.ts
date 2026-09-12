import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticRentOpsSnapshot } from '../fixtures/synthetic';
import { createAccountLedgerReader, deriveManagerAccountLedger } from './reports';
import type { RentOpsFilters } from '../../../shared/rent-ops-contracts';

test('request account reader deeply preserves direct projections across scopes and adversarial facts', () => {
  const cases = [structuredClone(syntheticRentOpsSnapshot())];
  const mutate = (change: (s: typeof cases[number]) => void) => { const s = structuredClone(cases[0]); change(s); cases.push(s); };
  mutate(s => { s.ledgerTransactions[0].personId = 'other-person'; s.ledgerTransactions[0].personLinkKnowledge = 'unknown'; });
  mutate(s => { s.ledgerTransactions[0].postedOn = null; s.paymentAllocations[0].amountCents = null; });
  mutate(s => { const p = s.ledgerTransactions.find(r => r.kind === 'payment')!; s.ledgerTransactions.push({ ...p, id: 'returned', kind: 'reversal', reversalOfId: p.id, postedOn: '2026-08-10' }); });
  mutate(s => { const p = s.ledgerTransactions.find(r => r.kind === 'payment')!; Object.assign(p, { allocationMode: 'multi_property', personId: 'external-account', tenancyId: null, propertyId: null, unitId: null }); s.ledgerTransactions.push({ ...p, id: 'returned-shared', kind: 'reversal', reversalOfId: p.id, postedOn: '2026-08-12' }); });
  mutate(s => { const c = s.ledgerTransactions.find(r => r.kind === 'charge')!; const credit = { ...c, id: 'credit', kind: 'credit' as const }; s.ledgerTransactions.push(credit); s.paymentAllocations.push({ id: 'credit-application', kind: 'credit_allocation', creditTransactionId: credit.id, chargeTransactionId: c.id, creditLinkKnowledge: 'exact', chargeLinkKnowledge: 'exact', allocatedOn: '2026-08-05', amountCents: 100 }); });
  for (const s of cases) for (const filters of [{ asOfDate: '2026-08-07' }, { asOfDate: '2026-08-16' }, { asOfDate: '2026-08-16', fromDate: '2026-08-10' }, { asOfDate: '2026-08-16', propertyId: 'demo-property-a' }, { asOfDate: '2026-08-16', unitId: 'demo-unit-a-1' }] as RentOpsFilters[]) {
    const read = createAccountLedgerReader(s, filters);
    for (const p of s.people) {
      const tenancyIds = s.tenancies.filter(t => t.primaryPersonId === p.id).map(t => t.id);
      assert.deepEqual(read(p.id, tenancyIds), deriveManagerAccountLedger(s, p.id, tenancyIds, filters));
    }
  }
});

test('new request readers observe mutation of the same snapshot', () => {
  const s = structuredClone(syntheticRentOpsSnapshot());
  const t = s.tenancies[0]; const filters = { asOfDate: '2026-08-16' };
  const first = createAccountLedgerReader(s, filters)(t.primaryPersonId, [t.id]);
  s.ledgerTransactions.find(r => r.tenancyId === t.id)!.amountCents! += 1;
  const next = createAccountLedgerReader(s, filters)(t.primaryPersonId, [t.id]);
  assert.notDeepEqual(first.map(r => r.runningBalanceCents), next.map(r => r.runningBalanceCents));
  assert.deepEqual(next, deriveManagerAccountLedger(s, t.primaryPersonId, [t.id], filters));
});

test('reusing account reader does not rescan full financial arrays for each account', () => {
  const s = structuredClone(syntheticRentOpsSnapshot());
  let fullScans = 0;
  for (const rows of [s.ledgerTransactions, s.paymentAllocations]) {
    const original = rows.filter.bind(rows);
    rows.filter = ((...args: Parameters<typeof original>) => { fullScans += 1; return original(...args); }) as typeof rows.filter;
  }
  const read = createAccountLedgerReader(s, { asOfDate: '2026-08-16' });
  const scansAfterBuild = fullScans;
  assert(scansAfterBuild > 0);
  for (let iteration = 0; iteration < 20; iteration++) for (const p of s.people) read(p.id, s.tenancies.filter(t => t.primaryPersonId === p.id).map(t => t.id));
  assert.equal(fullScans, scansAfterBuild);
});
