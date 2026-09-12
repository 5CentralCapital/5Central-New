import type { RentOpsSnapshot, RentOpsLedgerTransaction } from "../../../shared/rent-ops-contracts";

interface AccountLinkIndex {
  tenancies: Map<string, RentOpsSnapshot["tenancies"][number]>;
  units: Map<string, RentOpsSnapshot["units"][number]>;
  transactions: Map<string, RentOpsLedgerTransaction>;
}
export function isExactNativeAccountEntry(snapshot: RentOpsSnapshot, row: RentOpsLedgerTransaction, personId: string, index?: AccountLinkIndex): boolean {
  if (row.source || row.personId !== personId || !["exact","manual"].includes(row.personLinkKnowledge ?? "") || !["exact","manual"].includes(row.tenancyLinkKnowledge ?? "")) return false;
  const tenancy = index ? index.tenancies.get(row.tenancyId ?? "") : snapshot.tenancies.find(t => t.id === row.tenancyId);
  if (!tenancy || tenancy.primaryPersonId !== personId || !["exact","manual"].includes(tenancy.primaryPersonLinkKnowledge ?? "") || !["exact","manual"].includes(tenancy.propertyLinkKnowledge ?? "") || !["exact","manual"].includes(tenancy.unitLinkKnowledge ?? "") || !(index ? index.units.get(tenancy.unitId)?.propertyId === tenancy.propertyId : snapshot.units.some(unit => unit.id === tenancy.unitId && unit.propertyId === tenancy.propertyId)) || row.propertyId !== tenancy.propertyId || row.unitId !== tenancy.unitId || !["exact","manual"].includes(row.propertyLinkKnowledge ?? "") || !["exact","manual"].includes(row.unitLinkKnowledge ?? "")) return false;
  if (row.kind === "payment" || row.kind === "credit" || row.kind === "charge") return true;
  if (row.kind === "adjustment") return row.adjustmentDirection === "debit" || row.adjustmentDirection === "credit";
  const original = row.kind === "reversal" && (index ? index.transactions.get(row.reversalOfId ?? "") : snapshot.ledgerTransactions.find(r => r.id === row.reversalOfId));
  return !!original && original.kind !== "reversal" && isExactNativeAccountEntry(snapshot,original,personId,index);
}

/** Imported RM person identities represent TenantAccount roots. Only exact,
 * artifact-bound RM account entries can extend the current tenancy grant. */
export function tenantAccountLedgerRows(snapshot: RentOpsSnapshot, account: { personId: string; tenancyId?: string }): RentOpsLedgerTransaction[] {
  return createTenantAccountLedgerRowsReader(snapshot)(account);
}

/** Request-local indexes. Create again after snapshot changes; never cache globally. */
export function createTenantAccountLedgerRowsReader(snapshot: RentOpsSnapshot) {
  const index: AccountLinkIndex = { tenancies: new Map(snapshot.tenancies.map(row => [row.id, row])), units: new Map(snapshot.units.map(row => [row.id, row])), transactions: new Map(snapshot.ledgerTransactions.map(row => [row.id, row])) };
  const people = new Map(snapshot.people.map(row => [row.id, row]));
  const byPerson = new Map<string, RentOpsLedgerTransaction[]>(), byTenancy = new Map<string, RentOpsLedgerTransaction[]>();
  const order = new Map(snapshot.ledgerTransactions.map((row, i) => [row, i]));
  for (const row of snapshot.ledgerTransactions) {
    for (const [map, id] of [[byPerson, row.personId], [byTenancy, row.tenancyId]] as const) if (id) { const rows = map.get(id) ?? []; rows.push(row); map.set(id, rows); }
  }
  return (account: { personId: string; tenancyId?: string }): RentOpsLedgerTransaction[] => {
    const person = people.get(account.personId);
    const rmAccount = person?.source?.system === "rent_manager" && /^(?:tenant:)?[0-9]+$/.test(person.source.sourceId);
    const candidates = Array.from(new Set([...(byPerson.get(account.personId) ?? []), ...(account.tenancyId ? byTenancy.get(account.tenancyId) ?? [] : [])])).sort((a,b) => order.get(a)! - order.get(b)!);
    return candidates.filter(row => isExactNativeAccountEntry(snapshot,row,account.personId,index) || (!!account.tenancyId && isGrantedTenancyEntry(snapshot, row, account.personId, account.tenancyId,index)) || (
      rmAccount && row.source?.system === "rent_manager" && row.source.entityType === "ledger_transaction"
      && /^[a-f0-9]{64}$/.test(row.sourceArtifactSha256 ?? "")
      && row.personId === account.personId && row.personLinkKnowledge === "exact"
    ));
  };
}

/** Legacy native rows may omit evidence flags; imported/v3 links must be explicit.
 * A matching tenancy ID alone never overrides a conflicting account or location. */
function isGrantedTenancyEntry(snapshot: RentOpsSnapshot, row: RentOpsLedgerTransaction, personId: string, tenancyId: string, index?: AccountLinkIndex): boolean {
  const tenancy = index ? index.tenancies.get(tenancyId) : snapshot.tenancies.find(t => t.id === tenancyId);
  if (!tenancy || tenancy.primaryPersonId !== personId || row.tenancyId !== tenancyId || (row.personId && row.personId !== personId)
    || (row.propertyId && row.propertyId !== tenancy.propertyId) || (row.unitId && row.unitId !== tenancy.unitId)) return false;
  const strict = snapshot.modelVersion === 3 || !!row.source;
  const exact = (value: string | null | undefined) => value === "exact" || value === "manual" || (!strict && value === undefined);
  return exact(row.tenancyLinkKnowledge) && (!row.personId || exact(row.personLinkKnowledge));
}
