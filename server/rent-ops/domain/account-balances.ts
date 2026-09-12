import type { DelinquencyRow, LedgerRow, RentOpsFilters, RentOpsPerson, RentOpsSnapshot, RentOpsTenancy } from "../../../shared/rent-ops-contracts";
import { nowIsoDate } from "./dates";
import { ledgerBalanceSign } from "./invariants";
import { confirmedTenancyFact, isOccupiedTenancyOn } from "./tenancy-occupancy";

type Status = NonNullable<DelinquencyRow["tenancyStatus"]>;
export interface AccountBalanceAllocation { parentTransactionId: string; chargeTransactionId: string; amountCents: number; }
type AllocationReader = (snapshot: RentOpsSnapshot, asOf: string) => AccountBalanceAllocation[];
type LedgerReader = (snapshot: RentOpsSnapshot, personId: string, tenancyIds: string[], filters: RentOpsFilters) => LedgerRow[];
const exact = (value: string | null | undefined, legacy: boolean) => value === "exact" || value === "manual" || (legacy && value === undefined);
const amountKnown = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

function statusOn(person: RentOpsPerson, tenancies: RentOpsTenancy[], asOf: string): Status {
  const facts = person.sourceAccountFacts;
  const observed = facts?.statusKnowledge === "source" && facts.observedOn <= asOf ? facts : undefined;
  const events: { on: string; status: Status }[] = [];
  for (const tenancy of tenancies) {
    if (isOccupiedTenancyOn(tenancy, asOf)) events.push({ on: tenancy.actualMoveInOn!, status: "current" });
    if (confirmedTenancyFact(tenancy.actualMoveOutKnowledge) && tenancy.actualMoveOutOn && tenancy.actualMoveOutOn <= asOf)
      events.push({ on: tenancy.actualMoveOutOn, status: "former" });
  }
  events.sort((a, b) => b.on.localeCompare(a.on) || (a.status === "former" ? -1 : 1));
  const latest = events[0];
  // A completed historical property interval remains former even when the same
  // account is currently resident elsewhere. New actual events supersede an
  // older account observation (including a previously future account).
  if (latest && (latest.status === "former" || !observed || latest.on >= observed.observedOn)) return latest.status;
  if (observed) {
    if (observed.status === "past" || observed.status === "cancelled") return "former";
    if (observed.status === "current" || observed.status === "notice") return "current";
    if (observed.status === "future") return "future";
  }
  if (latest) return latest.status;
  if (tenancies.some(t => confirmedTenancyFact(t.statusKnowledge) && confirmedTenancyFact(t.plannedMoveInKnowledge)
    && t.status === "future" && !!t.plannedMoveInOn && t.plannedMoveInOn > asOf)) return "future";
  return "unknown";
}

/** One row per exact resident account and historical property. The account
 * reader owns receipt sharing, reversals and source identity validation. */
export function deriveAccountBalances(snapshot: RentOpsSnapshot, filters: RentOpsFilters, readAccountLedger: LedgerReader, readAllocations?: AllocationReader): DelinquencyRow[] {
  const asOf = filters.asOfDate ?? nowIsoDate();
  const legacy = snapshot.modelVersion !== 3;
  const properties = new Map(snapshot.properties.map(p => [p.id, p]));
  const units = new Map(snapshot.units.map(u => [u.id, u]));
  const tenancyMap = new Map(snapshot.tenancies.map(t => [t.id, t]));
  const tenanciesByPerson = new Map<string, RentOpsTenancy[]>();
  for (const tenancy of snapshot.tenancies) {
    if (!tenancy.primaryPersonId || !exact(tenancy.primaryPersonLinkKnowledge, legacy)) continue;
    const list = tenanciesByPerson.get(tenancy.primaryPersonId) ?? [];
    list.push(tenancy); tenanciesByPerson.set(tenancy.primaryPersonId, list);
  }
  const accountIds = new Set(tenanciesByPerson.keys());
  for (const person of snapshot.people) if (person.sourceAccountFacts || (person.source?.system === "rent_manager" && /^(?:tenant:)?[0-9]+$/.test(person.source.sourceId))) accountIds.add(person.id);
  for (const transaction of snapshot.ledgerTransactions) if (transaction.personId && exact(transaction.personLinkKnowledge, legacy)) accountIds.add(transaction.personId);
  const heldTenancies = new Set(snapshot.activityEvents.filter(e => e.type === "promise_to_pay" || e.type === "hold").map(e => e.tenancyId));
  const selected = new Set([...(filters.propertyIds ?? []), ...(filters.propertyId ? [filters.propertyId] : [])]);
  const allocationsByParent = new Map<string, AccountBalanceAllocation[]>();
  for (const allocation of readAllocations?.(snapshot, asOf) ?? []) {
    const entries = allocationsByParent.get(allocation.parentTransactionId) ?? [];
    entries.push(allocation); allocationsByParent.set(allocation.parentTransactionId, entries);
  }
  const result: DelinquencyRow[] = [];
  for (const person of snapshot.people) {
    if (!accountIds.has(person.id)) continue;
    if (filters.personId && filters.personId !== person.id) continue;
    const tenancies = tenanciesByPerson.get(person.id) ?? [];
    const accountLedger = readAccountLedger(snapshot, person.id, tenancies.map(t => t.id), { asOfDate: asOf });
    const ledger = accountLedger.filter(r => r.rowType !== "opening_balance");
    const missingImportedHistory = ledger.length === 0 && person.source?.system === "rent_manager";
    const accountIncomplete = missingImportedHistory || accountLedger.some(r => r.balanceComplete === false);
    const accountCodes = accountLedger.flatMap(r => r.balanceUncertaintyCodes ?? []);
    if (missingImportedHistory) accountCodes.push("imported_account_history_unverified");
    const transactionMap = new Map(ledger.map(r => [r.transaction.id, r.transaction]));
    const groups = new Map<string | null, { tenancies: RentOpsTenancy[]; ledger: LedgerRow[] }>();
    const group = (id: string | null) => {
      let value = groups.get(id);
      if (!value) { value = { tenancies: [], ledger: [] }; groups.set(id, value); }
      return value;
    };
    for (const tenancy of tenancies) {
      if (filters.unitId && (tenancy.unitId !== filters.unitId || !exact(tenancy.unitLinkKnowledge, legacy))) continue;
      const propertyId = tenancy.propertyId && exact(tenancy.propertyLinkKnowledge, legacy) ? tenancy.propertyId : null;
      group(propertyId).tenancies.push(tenancy);
    }
    const location = (tx: LedgerRow["transaction"]) => {
      const linked = tenancyMap.get(tx.tenancyId ?? "");
      const exactTenancy = linked && linked.primaryPersonId === person.id && exact(tx.tenancyLinkKnowledge, legacy)
        && exact(linked.primaryPersonLinkKnowledge, legacy) ? linked : undefined;
      const linkedProperty = exactTenancy && exact(exactTenancy.propertyLinkKnowledge, legacy) ? exactTenancy.propertyId : null;
      const directProperty = tx.propertyId && exact(tx.propertyLinkKnowledge, legacy) ? tx.propertyId : null;
      const propertyId = directProperty && linkedProperty && directProperty !== linkedProperty ? null : directProperty || linkedProperty;
      const linkedUnit = exactTenancy && exact(exactTenancy.unitLinkKnowledge, legacy) ? exactTenancy.unitId : null;
      const directUnit = tx.unitId && exact(tx.unitLinkKnowledge, legacy) ? tx.unitId : null;
      const unitId = directUnit && linkedUnit && directUnit !== linkedUnit ? null : directUnit || linkedUnit;
      return { propertyId, unitId };
    };
    const add = (row: LedgerRow, at = location(row.transaction)) => {
      if (!filters.unitId || at.unitId === filters.unitId) group(at.propertyId).ledger.push(row);
    };
    for (const row of ledger) {
      const tx = row.transaction;
      if (tx.postedOn && tx.postedOn > asOf) continue;
      const allocations = (tx.kind === "payment" || tx.kind === "credit") ? allocationsByParent.get(tx.id) ?? [] : [];
      let applied = 0;
      if (amountKnown(tx.amountCents)) for (const allocation of allocations) {
        const charge = transactionMap.get(allocation.chargeTransactionId);
        // Only exact applications admitted to this same account can move cash.
        if (!charge || !amountKnown(allocation.amountCents)) continue;
        applied += allocation.amountCents;
        add({ ...row, allocatedCents: allocation.amountCents, openCents: 0,
          transaction: { ...tx, id: `balance-application:${tx.id}:${charge.id}`, amountCents: allocation.amountCents } }, location(charge));
      }
      add(applied ? { ...row, transaction: { ...tx, amountCents: tx.amountCents! - applied } } : row);
    }
    if (!groups.size && !filters.unitId) group(null);
    for (const [propertyId, value] of Array.from(groups.entries())) {
      if (selected.size && (!propertyId || !selected.has(propertyId))) continue;
      if (!selected.size && filters.propertyScope === "active" && (!propertyId || properties.get(propertyId)?.state !== "active")) continue;
      const tenancyStatus = statusOn(person, value.tenancies, asOf);
      if (filters.tenantStatus && filters.tenantStatus !== "all" && filters.tenantStatus !== tenancyStatus) continue;
      let total = 0, rent = 0, nonRent = 0, unapplied = 0;
      let complete = !accountIncomplete, detailComplete = true;
      let oldestUnpaidRentOn: string | undefined, lastPaymentOn: string | undefined;
      const codes = new Set<string>(accountCodes);
      const reversed = new Set(value.ledger.filter(r => r.transaction.kind === "reversal" && r.transaction.status === "posted").map(r => r.transaction.reversalOfId));
      for (const row of value.ledger) {
        const tx = row.transaction;
        if (tx.status === "voided" || tx.status === "pending") continue;
        for (const code of row.balanceUncertaintyCodes ?? []) codes.add(code);
        if (row.balanceComplete === false || !amountKnown(tx.amountCents) || !tx.postedOn || tx.status !== "posted") complete = false;
        if (amountKnown(tx.amountCents) && tx.status === "posted") total += ledgerBalanceSign(tx, transactionMap) * tx.amountCents;
        if (tx.kind === "payment" && !reversed.has(tx.id)) {
          if (tx.postedOn && (!lastPaymentOn || tx.postedOn > lastPaymentOn)) lastPaymentOn = tx.postedOn;
          if (amountKnown(row.openCents)) unapplied += row.openCents; else detailComplete = false;
        }
        if (tx.kind === "charge" || tx.kind === "credit" || tx.kind === "adjustment") {
          if (reversed.has(tx.id)) continue;
          const open = tx.kind === "adjustment" && amountKnown(tx.amountCents) ? ledgerBalanceSign(tx, transactionMap) * tx.amountCents : row.openCents;
          if (!amountKnown(open)) { detailComplete = false; continue; }
          if (!tx.category || (tx.categoryKnowledge !== undefined && !["source", "manual", "confirmed"].includes(tx.categoryKnowledge ?? ""))) {
            if (open !== 0) { detailComplete = false; codes.add("balance_category_unknown"); }
          } else if (tx.category === "base_rent") {
            rent += open;
            const due = tx.dueOn ?? tx.postedOn;
            if (open > 0 && due && (!oldestUnpaidRentOn || due < oldestUnpaidRentOn)) oldestUnpaidRentOn = due;
          } else nonRent += open;
        }
      }
      if (!Number.isSafeInteger(total)) { complete = false; codes.add("ledger_balance_out_of_range"); }
      if (!complete && !codes.size) codes.add("account_balance_unknown");
      if (filters.balanceStatus === "due" && (!complete || total <= 0)) continue;
      if (filters.balanceStatus === "zero" && (!complete || total !== 0)) continue;
      if (filters.balanceStatus === "credit" && (!complete || total >= 0)) continue;
      if (filters.balanceStatus === "unverified" && complete) continue;
      const onlyTenancy = value.tenancies.length === 1 ? value.tenancies[0] : undefined;
      const unitIds = new Set(value.tenancies.filter(t => exact(t.unitLinkKnowledge, legacy)).map(t => t.unitId));
      const unit = unitIds.size === 1 ? units.get(Array.from(unitIds)[0]) : undefined;
      const propertyName = propertyId ? properties.get(propertyId)?.name ?? "Unknown property" : "Unassigned account";
      const tenantName = `${person.firstName} ${person.lastName}`.trim();
      if (filters.search && !`${propertyName} ${unit?.unitNumber ?? ""} ${tenantName}`.toLowerCase().includes(filters.search.toLowerCase())) continue;
      result.push({ propertyId, propertyName, tenancyId: onlyTenancy?.id ?? null, personId: person.id, tenantName,
        unitId: unit?.id, unitNumber: unit?.unitNumber, tenancyStatus, balanceComplete: complete, balanceUncertaintyCodes: Array.from(codes).sort(),
        rentOnlyBalanceCents: complete && detailComplete ? rent : null, nonRentBalanceCents: complete && detailComplete ? nonRent : null,
        grossBalanceCents: complete && detailComplete ? rent + nonRent : null,
        totalBalanceCents: complete ? total : null, netAccountBalanceCents: complete ? total : null,
        creditBalanceCents: complete ? Math.max(0, -total) : null,
        unappliedCashCents: complete && detailComplete ? unapplied : null, prepaidCents: complete && detailComplete ? unapplied : null,
        oldestUnpaidRentOn: complete && detailComplete ? oldestUnpaidRentOn : undefined, lastPaymentOn,
        hasPromiseOrHold: value.tenancies.some(t => heldTenancies.has(t.id)), noticeStatus: value.tenancies.some(t => t.status === "notice") ? "notice_given" : undefined });
    }
  }
  return result.sort((a, b) => a.propertyName.localeCompare(b.propertyName) || a.tenantName.localeCompare(b.tenantName) || a.personId.localeCompare(b.personId));
}
