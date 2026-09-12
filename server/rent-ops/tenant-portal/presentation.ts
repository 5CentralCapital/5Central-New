import { deriveManagerAccountLedger } from "../domain/reports";
import { ledgerBalanceSign } from "../domain/invariants";
import { getAccountHistoryCoverage } from "../import/account-history-coverage";
export { tenantAccountLedgerRows } from "../domain/account-ledger";
import { isTenantLeaseFile, tenantLeaseFile } from "./lease-files";
import type { RentOpsSnapshot, RentOpsTenancy, RentOpsLedgerTransaction } from "../../../shared/rent-ops-contracts";
import type { TenantEligibleTenancy, TenantHome, TenantIdentity } from "../../../shared/tenant-portal-contracts";

function exactLink(knowledge: string | null | undefined, imported: boolean): boolean {
  return knowledge === "exact" || knowledge === "manual" || (!imported && knowledge === undefined);
}

function knownFact(knowledge: string | null | undefined, imported: boolean): boolean {
  return knowledge === "source" || knowledge === "manual" || knowledge === "confirmed" || (!imported && knowledge === undefined);
}

function sourceStrict(snapshot: RentOpsSnapshot, value: { source?: unknown }): boolean {
  return snapshot.modelVersion === 3 || !!value.source;
}

/** The account grant is fixed, never supplied by a tenant request. A source
 * reassignment or ambiguous import must revoke access in practice immediately. */
export function resolveTenantBinding(snapshot: RentOpsSnapshot, personId: string, tenancyId: string): RentOpsTenancy | undefined {
  const tenancy = snapshot.tenancies.find((row) => row.id === tenancyId);
  const person = snapshot.people.find((row) => row.id === personId);
  if (!tenancy || !person || person.archived === true || tenancy.primaryPersonId !== personId || tenancy.status === "cancelled") return undefined;
  const strict = sourceStrict(snapshot, tenancy);
  if (!exactLink(tenancy.primaryPersonLinkKnowledge, strict) || !exactLink(tenancy.propertyLinkKnowledge, strict) || !exactLink(tenancy.unitLinkKnowledge, strict)) return undefined;
  const unit = snapshot.units.find((row) => row.id === tenancy.unitId && row.propertyId === tenancy.propertyId);
  if (!unit || !exactLink(unit.propertyLinkKnowledge, sourceStrict(snapshot, unit)) || !snapshot.properties.some((row) => row.id === tenancy.propertyId)) return undefined;
  return tenancy;
}

export function eligibleTenantTenancies(snapshot: RentOpsSnapshot, asOfDate = new Intl.DateTimeFormat("en-CA", {timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date())): TenantEligibleTenancy[] {
  return snapshot.tenancies.flatMap((tenancy) => {
    if (tenancy.operationalEndConfirmationKnowledge === "manual" && tenancy.operationalEndConfirmedOn && tenancy.operationalEndConfirmedOn <= asOfDate) return [];
    if (!["current", "notice", "future"].includes(tenancy.status) || !knownFact(tenancy.statusKnowledge, sourceStrict(snapshot, tenancy))) return [];
    if (!resolveTenantBinding(snapshot, tenancy.primaryPersonId, tenancy.id)) return [];
    const person = snapshot.people.find((row) => row.id === tenancy.primaryPersonId)!;
    const property = snapshot.properties.find((row) => row.id === tenancy.propertyId)!;
    const unit = snapshot.units.find((row) => row.id === tenancy.unitId)!;
    return [{ personId: person.id, tenancyId: tenancy.id, personName: [person.firstName, person.lastName].filter(Boolean).join(" "),
      email: person.email ?? null, paymentReviewReason: person.paymentReviewReason ?? null, propertyName: property.name || "Property", unitNumber: unit.unitNumber || "Unit", status: tenancy.status }];
  });
}

function knownAmount(row: RentOpsLedgerTransaction, strict: boolean): boolean {
  return Number.isSafeInteger(row.amountCents) && row.amountCents! >= 0
    && (row.amountKnowledge === "known" || (!strict && row.amountKnowledge === undefined));
}

/** Whitelisted tenant view: no household contacts, activities, source IDs,
 * imported payloads, storage keys, passwords, or other tenancies. */
export function presentTenantHome(snapshot: RentOpsSnapshot, account: TenantIdentity, asOfDate: string): TenantHome | undefined {
  const tenancy = resolveTenantBinding(snapshot, account.personId, account.tenancyId);
  if (!tenancy) return undefined;
  const person = snapshot.people.find((row) => row.id === account.personId)!;
  const property = snapshot.properties.find((row) => row.id === tenancy.propertyId)!;
  const unit = snapshot.units.find((row) => row.id === tenancy.unitId)!;
  // Use precisely the manager account projection. Only the fixed verified grant
  // and exact account entries may extend this history across former leases.
  const statement = deriveManagerAccountLedger(snapshot, person.id, [tenancy.id], { asOfDate });
  const historyCoverage = getAccountHistoryCoverage(snapshot, person.id);
  const emptyHistoryKnown = person.source?.system !== "rent_manager" || historyCoverage.complete;
  const complete = statement.every(row => row.balanceComplete !== false) && (statement.length > 0 || (emptyHistoryKnown &&
    !snapshot.ledgerTransactions.some(row => row.personId === person.id && (!row.postedOn || row.postedOn <= asOfDate) && row.status !== "pending" && row.status !== "voided")));
  const balanceCents = statement.at(-1)?.runningBalanceCents ?? 0;
  const projectedTransactions = new Map(statement.map(row => [row.transaction.id, row.transaction]));
  const ledger = statement.map(entry => {
    const row = entry.transaction;
    const strict = sourceStrict(snapshot, row);
    const amountIsKnown = knownAmount(row, strict);
    const direction = ledgerBalanceSign(row, projectedTransactions);
    const linkedProperty = exactLink(row.propertyLinkKnowledge, strict) ? snapshot.properties.find(p => p.id === row.propertyId) : undefined;
    const linkedUnit = linkedProperty && exactLink(row.unitLinkKnowledge, strict) ? snapshot.units.find(u => u.id === row.unitId && u.propertyId === linkedProperty.id) : undefined;
    return { id: row.id, date: row.postedOn && knownFact(row.postedOnKnowledge, strict) ? row.postedOn : null,
      description: knownFact(row.descriptionKnowledge, strict) && row.description ? row.description.slice(0, 240) : (row.kind ? row.kind.charAt(0).toUpperCase() + row.kind.slice(1) : "Account entry"),
      kind: row.kind ?? "unknown", status: knownFact(row.statusKnowledge, strict) ? row.status : null,
      amountCents: amountIsKnown ? row.amountCents : null, balanceCents: entry.runningBalanceCents,
      reference: null, propertyName: linkedProperty?.name ?? null, unitNumber: linkedUnit?.unitNumber ?? null,
      chargeCents: amountIsKnown && direction > 0 ? row.amountCents : null,
      paymentCreditCents: amountIsKnown && direction < 0 ? row.amountCents : null,
      allocatedCents: entry.allocatedCents, openCents: entry.openCents,
      rowType: entry.rowType, openingBalanceCents: entry.openingBalanceCents,
      balanceUncertaintyCodes: entry.balanceUncertaintyCodes ?? [] };
  });
  const address = property.address;
  return {
    account: { id: account.id, email: account.email, personId: account.personId, tenancyId: account.tenancyId, status: "active" },
    resident: { firstName: person.firstName || "Resident", lastName: person.lastName || "" },
    tenancy: { id: tenancy.id, propertyId: tenancy.propertyId, unitId: tenancy.unitId, propertyName: property.name || "Property", unitNumber: unit.unitNumber || "Unit",
      address: address ? [address.line1, address.line2, address.city, address.state, address.postalCode].filter(Boolean).join(", ") : "", status: tenancy.status },
    balance: { amountCents: complete ? balanceCents : null, complete, asOfDate },
    historyCoverage: { status: historyCoverage.status, complete: historyCoverage.complete, ...(historyCoverage.observedOn ? { asOfDate: historyCoverage.observedOn } : {}) },
    ledger,
    leaseFiles: snapshot.documents.filter(document => isTenantLeaseFile(document, account, tenancy)).map(tenantLeaseFile),
    leases: snapshot.leaseTerms.filter((row) => row.tenancyId === tenancy.id && exactLink(row.tenancyLinkKnowledge, sourceStrict(snapshot, row)) && row.status !== "draft" && row.status !== "cancelled").map((row) => {
      const strict = sourceStrict(snapshot, row);
      return { id: row.id, status: knownFact(row.statusKnowledge, strict) ? row.status : "Unconfirmed",
        startDate: knownFact(row.contractStartKnowledge, strict) ? row.contractStartOn ?? null : null,
        endDate: knownFact(row.contractEndKnowledge, strict) ? row.contractEndOn ?? null : null,
        monthToMonth: knownFact(row.monthToMonthKnowledge, strict) ? row.monthToMonth : null };
    }),
    deposits: snapshot.securityDeposits.filter((row) => row.tenancyId === tenancy.id && row.personId === person.id && row.propertyId === tenancy.propertyId
      && (!row.unitId || row.unitId === tenancy.unitId)
      && exactLink(row.personLinkKnowledge, sourceStrict(snapshot, row))
      && exactLink(row.propertyLinkKnowledge, sourceStrict(snapshot, row))).map((row) => ({
      id: row.id, type: knownFact(row.typeKnowledge, sourceStrict(snapshot, row)) ? row.type ?? "Deposit" : "Deposit",
      amountHeldCents: typeof row.amountHeldCents === "number" && Number.isSafeInteger(row.amountHeldCents) && row.amountHeldCents >= 0 ? row.amountHeldCents : null,
      sourceBalanceCents: typeof row.sourceBalanceCents === "number" && Number.isSafeInteger(row.sourceBalanceCents) ? row.sourceBalanceCents : null, status: knownFact(row.dispositionStatusKnowledge, sourceStrict(snapshot, row)) ? row.dispositionStatus ?? "Unconfirmed" : "Unconfirmed",
    })),
  };
}
