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

export function eligibleTenantTenancies(snapshot: RentOpsSnapshot): TenantEligibleTenancy[] {
  return snapshot.tenancies.flatMap((tenancy) => {
    if (!["current", "notice", "future"].includes(tenancy.status) || !knownFact(tenancy.statusKnowledge, sourceStrict(snapshot, tenancy))) return [];
    if (!resolveTenantBinding(snapshot, tenancy.primaryPersonId, tenancy.id)) return [];
    const person = snapshot.people.find((row) => row.id === tenancy.primaryPersonId)!;
    const property = snapshot.properties.find((row) => row.id === tenancy.propertyId)!;
    const unit = snapshot.units.find((row) => row.id === tenancy.unitId)!;
    return [{ personId: person.id, tenancyId: tenancy.id, personName: [person.firstName, person.lastName].filter(Boolean).join(" "),
      email: person.email ?? null, propertyName: property.name || "Property", unitNumber: unit.unitNumber || "Unit", status: tenancy.status }];
  });
}

function knownAmount(row: RentOpsLedgerTransaction, strict: boolean): boolean {
  return Number.isSafeInteger(row.amountCents) && row.amountCents! >= 0
    && (row.amountKnowledge === "known" || (!strict && row.amountKnowledge === undefined));
}

function sign(row: RentOpsLedgerTransaction, rows: Map<string, RentOpsLedgerTransaction>): number | null {
  if (row.kind === "charge") return 1;
  if (row.kind === "payment" || row.kind === "credit") return -1;
  if (row.kind === "adjustment") return row.adjustmentDirection === "debit" ? 1 : row.adjustmentDirection === "credit" ? -1 : null;
  if (row.kind === "reversal") {
    const original = rows.get(row.reversalOfId ?? "");
    if (!original || original.kind === "reversal" || original.status !== "posted" || original.amountCents !== row.amountCents) return null;
    const originalSign = sign(original, rows);
    return originalSign === null ? null : -originalSign;
  }
  return null;
}

/** Whitelisted tenant view: no household contacts, activities, source IDs,
 * imported payloads, storage keys, passwords, or other tenancies. */
export function presentTenantHome(snapshot: RentOpsSnapshot, account: TenantIdentity, asOfDate: string): TenantHome | undefined {
  const tenancy = resolveTenantBinding(snapshot, account.personId, account.tenancyId);
  if (!tenancy) return undefined;
  const person = snapshot.people.find((row) => row.id === account.personId)!;
  const property = snapshot.properties.find((row) => row.id === tenancy.propertyId)!;
  const unit = snapshot.units.find((row) => row.id === tenancy.unitId)!;
  let complete = true;
  const candidateRows = snapshot.ledgerTransactions.filter((row) => row.tenancyId === tenancy.id);
  // Preserve uncertainty when a person's imported account entries do not
  // resolve to a specific tenancy; never silently declare those amounts zero.
  if (snapshot.ledgerTransactions.some((row) => row.personId === person.id && (!row.tenancyId || !exactLink(row.tenancyLinkKnowledge, sourceStrict(snapshot, row))))) complete = false;
  const rows = candidateRows.filter((row) => {
    const strict = sourceStrict(snapshot, row);
    if (!exactLink(row.tenancyLinkKnowledge, strict) || (row.propertyId && row.propertyId !== tenancy.propertyId) || (row.unitId && row.unitId !== tenancy.unitId) || (row.personId && row.personId !== person.id)) {
      complete = false;
      return false;
    }
    return !row.postedOn || row.postedOn <= asOfDate;
  }).sort((a, b) => (a.postedOn ?? "9999").localeCompare(b.postedOn ?? "9999") || a.id.localeCompare(b.id));
  const rowMap = new Map(rows.map((row) => [row.id, row]));
  const reversed = new Set<string>();
  let balanceCents = 0;
  const ledger = rows.map((row) => {
    const strict = sourceStrict(snapshot, row);
    const amountIsKnown = knownAmount(row, strict);
    const dateIsKnown = !!row.postedOn && knownFact(row.postedOnKnowledge, strict);
    const statusIsKnown = knownFact(row.statusKnowledge, strict) && ["posted", "pending", "voided"].includes(row.status ?? "");
    const direction = sign(row, rowMap);
    if (!amountIsKnown || !dateIsKnown || !statusIsKnown || direction === null) complete = false;
    if (row.kind === "reversal" && row.status === "posted" && row.reversalOfId) {
      if (reversed.has(row.reversalOfId)) complete = false;
      reversed.add(row.reversalOfId);
    }
    if (row.status === "posted" && amountIsKnown && direction !== null) balanceCents += direction * row.amountCents!;
    if (!Number.isSafeInteger(balanceCents)) complete = false;
    return { id: row.id, date: dateIsKnown ? row.postedOn! : null,
      description: knownFact(row.descriptionKnowledge, strict) && row.description ? row.description.slice(0, 240) : "Account entry",
      kind: row.kind ?? "unknown", status: statusIsKnown ? row.status! : null, amountCents: amountIsKnown ? row.amountCents! : null,
      balanceCents: complete ? balanceCents : null };
  });
  // A missing or unknown entry invalidates every running total, including
  // earlier rows, because its date may be before those visible transactions.
  if (!complete) for (const entry of ledger) entry.balanceCents = null;
  const address = property.address;
  return {
    account: { id: account.id, email: account.email, personId: account.personId, tenancyId: account.tenancyId, status: "active" },
    resident: { firstName: person.firstName || "Resident", lastName: person.lastName || "" },
    tenancy: { id: tenancy.id, propertyId: tenancy.propertyId, unitId: tenancy.unitId, propertyName: property.name || "Property", unitNumber: unit.unitNumber || "Unit",
      address: address ? [address.line1, address.line2, address.city, address.state, address.postalCode].filter(Boolean).join(", ") : "", status: tenancy.status },
    balance: { amountCents: complete ? balanceCents : null, complete, asOfDate },
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
