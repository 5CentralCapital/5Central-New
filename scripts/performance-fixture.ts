import { emptyRentOpsSnapshot, type RentOpsSnapshot } from '../shared/rent-ops-contracts';
import { syntheticRentOpsSnapshot } from '../server/rent-ops/fixtures/synthetic';

/** Deterministic synthetic portfolio, with a substantial retained ledger. */
export function performanceFixture(copies = 30, historyCopies = 40): RentOpsSnapshot {
  const original = syntheticRentOpsSnapshot();
  const ids = new Set(Object.values(original).flatMap(value => Array.isArray(value) ? value.map(row => row.id).filter((id): id is string => typeof id === 'string') : []));
  const fixture = emptyRentOpsSnapshot();
  for (let copy = 0; copy < copies; copy++) {
    const remap = (value: unknown): any => typeof value === 'string' ? ids.has(value) ? `${value}-p${copy}` : value
      : Array.isArray(value) ? value.map(remap)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, remap(entry)])) : value;
    const part = remap(original) as RentOpsSnapshot;
    for (const [name, rows] of Object.entries(part)) if (Array.isArray(rows)) (fixture[name as keyof RentOpsSnapshot] as unknown[]).push(...rows);
    const ledgerIds = new Set(part.ledgerTransactions.map(row => row.id));
    const historyDate = (value: string | null | undefined, months: number) => {
      if (!value) return value;
      const [year,month,day]=value.split('-').map(Number);
      const date=new Date(Date.UTC(year,month-1-months,1));
      const days=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();
      date.setUTCDate(Math.min(day,days));return date.toISOString().slice(0,10);
    };
    for (let history = 1; history < historyCopies; history++) {
      const ledgerId = (id: string | null | undefined) => id && ledgerIds.has(id) ? `${id}-h${history}` : id;
      fixture.ledgerTransactions.push(...part.ledgerTransactions.map(row => ({...row, id: `${row.id}-h${history}`, reversalOfId: ledgerId(row.reversalOfId),postedOn:historyDate(row.postedOn,history),dueOn:historyDate(row.dueOn,history)})));
      fixture.paymentAllocations.push(...part.paymentAllocations.map(row => ({...row, id: `${row.id}-h${history}`, paymentTransactionId: ledgerId(row.paymentTransactionId), creditTransactionId: ledgerId(row.creditTransactionId), chargeTransactionId: ledgerId(row.chargeTransactionId),allocatedOn:historyDate(row.allocatedOn,history)})));
    }
  }
  return fixture;
}
