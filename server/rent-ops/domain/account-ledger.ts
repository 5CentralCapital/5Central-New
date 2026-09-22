import type { RentOpsSnapshot, RentOpsLedgerTransaction } from "../../../shared/rent-ops-contracts";

export function isExactNativeAccountEntry(snapshot: RentOpsSnapshot, row: RentOpsLedgerTransaction, personId: string): boolean {
  if (row.source || row.personId !== personId || !["exact","manual"].includes(row.personLinkKnowledge ?? "") || !["exact","manual"].includes(row.tenancyLinkKnowledge ?? "")) return false;
  const tenancy = snapshot.tenancies.find(t => t.id === row.tenancyId && t.primaryPersonId === personId);
  if (!tenancy || !["exact","manual"].includes(tenancy.primaryPersonLinkKnowledge ?? "") || !["exact","manual"].includes(tenancy.propertyLinkKnowledge ?? "") || !["exact","manual"].includes(tenancy.unitLinkKnowledge ?? "") || !snapshot.units.some(unit => unit.id === tenancy.unitId && unit.propertyId === tenancy.propertyId) || row.propertyId !== tenancy.propertyId || row.unitId !== tenancy.unitId || !["exact","manual"].includes(row.propertyLinkKnowledge ?? "") || !["exact","manual"].includes(row.unitLinkKnowledge ?? "")) return false;
  if (row.kind === "payment" || row.kind === "credit" || row.kind === "charge") return true;
  if (row.kind === "adjustment") return row.adjustmentDirection === "debit" || row.adjustmentDirection === "credit";
  const original = row.kind === "reversal" && snapshot.ledgerTransactions.find(r => r.id === row.reversalOfId);
  return !!original && original.kind !== "reversal" && isExactNativeAccountEntry(snapshot,original,personId);
}

/** Imported RM person identities represent TenantAccount roots. Only exact,
 * artifact-bound RM account entries can extend the current tenancy grant. */
export function tenantAccountLedgerRows(snapshot: RentOpsSnapshot, account: { personId: string; tenancyId?: string }): RentOpsLedgerTransaction[] {
  const person = snapshot.people.find(row => row.id === account.personId);
  const rmAccount = person?.source?.system === "rent_manager" && /^(?:tenant:)?[0-9]+$/.test(person.source.sourceId);
  return snapshot.ledgerTransactions.filter(row => (rmAccount && isExactNativeAccountEntry(snapshot,row,account.personId)) || (!!account.tenancyId && row.tenancyId === account.tenancyId) || (
    rmAccount && row.source?.system === "rent_manager" && row.source.entityType === "ledger_transaction"
    && /^[a-f0-9]{64}$/.test(row.sourceArtifactSha256 ?? "")
    && row.personId === account.personId && row.personLinkKnowledge === "exact"
  ));
}
