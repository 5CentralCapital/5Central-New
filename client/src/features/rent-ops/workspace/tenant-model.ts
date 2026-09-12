import { scheduleDisplayInterval } from "./schedule-display";
import type {
  AdminChargeDefinitionView,
  AdminHouseholdMembershipView,
  AdminLedgerRowView,
  AdminLedgerTransactionView,
  AdminLeaseTermView,
  AdminPersonView,
  AdminPropertyView,
  AdminRecurringScheduleView,
  AdminSnapshot,
  AdminTenancyView,
  AdminUnitView,
  TenantTab,
  TenantView,
} from "../types";
import type { FormValues, QuickAction } from "../form-payload";

export type RecurringChargeFilter = "all" | "current" | "future" | "ended";
export type RecurringChargeState = "current" | "future" | "ended" | "unknown";

export interface TenantContext {
  asOfDate: string;
  property?: AdminPropertyView;
  unit?: AdminUnitView;
  currentTenancy?: AdminTenancyView;
  tenancies: AdminTenancyView[];
  leaseTerms: AdminLeaseTermView[];
}

export interface TenantBalance {
  amountCents: number | null;
  reportedAmountCents: number | null;
  complete: boolean;
  uncertaintyCodes: string[];
  source: "delinquency" | "ledger" | "unavailable";
}

export interface TenantSummaryModel {
  displayName: string;
  propertyName: string;
  unitLabel: string;
  status: string;
  asOfDate: string;
  balance: TenantBalance;
  currentTenancy?: AdminTenancyView;
  primaryLease?: AdminLeaseTermView;
}

export interface HouseholdRow {
  membership: AdminHouseholdMembershipView;
  person?: AdminPersonView;
  name: string;
  role: string;
  relationship: string;
  responsibility: "Yes" | "No" | "Needs review";
}

export interface RecurringChargeScope {
  type: "tenant" | "unit" | "property" | "unknown";
  id?: string;
  label: string;
  identitySource: "explicit" | "inferred" | "unknown";
  inheritedIdentity: string;
  warning?: string;
}

export interface RecurringChargeRow {
  schedule: AdminRecurringScheduleView;
  id?: string;
  description: string;
  definitionName: string;
  category: string;
  amountCents: number | null;
  billingFrequency: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  active?: boolean | null;
  state: RecurringChargeState;
  scope: RecurringChargeScope;
  uncertaintyCodes: string[];
}

export interface TenantLedgerRow {
  source: AdminLedgerRowView;
  transaction: AdminLedgerTransactionView;
  key: string;
  rowType: "transaction" | "opening_balance";
  date?: string;
  unitLabel: string;
  reference: string;
  description: string;
  chargeCents: number | null;
  paymentCents: number | null;
  paymentLabel: "Payment" | "Credit" | null;
  runningBalanceCents: number | null;
  allocatedCents: number | null;
  openCents: number | null;
  status?: string;
  statusKnown: boolean;
  kind?: string;
  category?: string;
  payer?: string;
  dueOn?: string;
  paymentMethod?: string;
  reversalOfId?: string;
  uncertaintyCodes: string[];
}

export interface TenantEditAction {
  label: string;
  action: QuickAction;
  values: FormValues;
}

const TENANCY_CURRENT_STATUSES = new Set(["current", "active", "notice", "future", "preleased"]);
const CHARGE_SCOPE_TYPES = new Set(["tenant", "unit", "property"]);

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** Keep source date strings intact for edits while using a stable date-only key for comparisons. */
export function dateKey(value: string | null | undefined): string | undefined {
  const text = nonEmpty(value);
  if (!text) return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : undefined;
}

export function personDisplayName(person?: AdminPersonView, fallback = "Needs review"): string {
  if (!person) return fallback;
  const first = nonEmpty(person.firstName);
  const last = nonEmpty(person.lastName);
  const name = [first, last].filter(Boolean).join(" ");
  return name || fallback;
}

export function propertyDisplayName(property?: AdminPropertyView, fallback = "Needs review"): string {
  return nonEmpty(property?.name) ?? fallback;
}

export function unitDisplayName(unit?: AdminUnitView, fallback = "Needs review"): string {
  return nonEmpty(unit?.unitNumber) ?? fallback;
}

function tenancyIdentity(tenancy: AdminTenancyView): string {
  return [tenancy.id, tenancy.propertyId, tenancy.unitId, tenancy.primaryPersonId, tenancy.status, tenancy.actualMoveInOn, tenancy.createdAt].map((part) => String(part ?? "")).join(":");
}

export function getTenantTenancies(tenant: TenantView): AdminTenancyView[] {
  const values = [...(tenant.tenancies ?? []), ...(tenant.tenancy ? [tenant.tenancy] : [])];
  const seen = new Set<string>();
  return values.filter((tenancy) => {
    const key = tenancy.id ? `id:${tenancy.id}` : `shape:${tenancyIdentity(tenancy)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isCurrentTenancy(tenancy: AdminTenancyView, asOfDate?: string): boolean {
  const status = nonEmpty(tenancy.status)?.toLowerCase();
  const asOf = dateKey(asOfDate);
  const moveOut = dateKey(tenancy.actualMoveOutOn ?? tenancy.endedAt);
  if (moveOut && asOf && moveOut <= asOf) return false;
  if (status) return TENANCY_CURRENT_STATUSES.has(status);
  const moveIn = dateKey(tenancy.actualMoveInOn ?? tenancy.plannedMoveInOn);
  return Boolean(moveIn && asOf && moveIn <= asOf && !moveOut);
}

function findProperty(snapshot: AdminSnapshot, propertyId?: string): AdminPropertyView | undefined {
  return propertyId ? snapshot.snapshot.properties.find((property) => property.id === propertyId) : undefined;
}

function findUnit(snapshot: AdminSnapshot, unitId?: string): AdminUnitView | undefined {
  return unitId ? snapshot.snapshot.units.find((unit) => unit.id === unitId) : undefined;
}

export function resolveTenantContext(tenant: TenantView, snapshot: AdminSnapshot): TenantContext {
  const asOfDate = snapshot.summary.asOfDate;
  const tenancies = getTenantTenancies(tenant);
  // The profile selects the authoritative tenancy, including a historical selection.
  const currentTenancy = tenant.tenancy
    ?? tenancies.find((candidate) => isCurrentTenancy(candidate, asOfDate))
    ?? tenancies[0];
  const property = tenant.property ?? findProperty(snapshot, currentTenancy?.propertyId);
  const unit = tenant.unit ?? findUnit(snapshot, currentTenancy?.unitId);
  const tenancyIds = new Set(tenancies.map((candidate) => candidate.id).filter(Boolean));
  const leaseTerms = (tenant.leaseTerms ?? []).filter((term) => tenancyIds.size === 0 || !term.tenancyId || tenancyIds.has(term.tenancyId));
  return { asOfDate, property, unit, currentTenancy, tenancies, leaseTerms };
}

function balanceFromReport(tenant: TenantView, snapshot: AdminSnapshot): TenantBalance | undefined {
  const context = resolveTenantContext(tenant, snapshot);
  const candidates = snapshot.delinquency
    .filter((row) => {
      if (row.personId && row.personId !== tenant.person.id) return false;
      if (row.tenancyId && row.tenancyId !== context.currentTenancy?.id) return false;
      if (row.unitId && row.unitId !== context.unit?.id) return false;
      if (row.propertyId && row.propertyId !== context.property?.id) return false;
      return Boolean((row.personId && row.personId === tenant.person.id)
        || (row.tenancyId && row.tenancyId === context.currentTenancy?.id));
    })
    .map((row, index) => ({ row, index, score: (row.tenancyId && row.tenancyId === context.currentTenancy?.id ? 100 : 0)
      + (row.personId && row.personId === tenant.person.id ? 40 : 0)
      + (row.unitId && row.unitId === context.unit?.id ? 20 : 0)
      + (row.propertyId && row.propertyId === context.property?.id ? 10 : 0) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const candidate = candidates[0]?.row;
  if (!candidate) return undefined;
  const reported = candidate.netAccountBalanceCents ?? candidate.totalBalanceCents ?? candidate.grossBalanceCents ?? candidate.rentOnlyBalanceCents ?? null;
  const uncertaintyCodes = Array.from(new Set(candidate.balanceUncertaintyCodes ?? []));
  const complete = candidate.balanceComplete !== false && uncertaintyCodes.length === 0 && typeof reported === "number";
  return {
    amountCents: complete ? reported : null,
    reportedAmountCents: typeof reported === "number" ? reported : null,
    complete,
    uncertaintyCodes,
    source: "delinquency",
  };
}

function balanceFromLedger(tenant: TenantView): TenantBalance {
  const rows = tenant.ledger ?? [];
  const uncertaintyCodes = Array.from(new Set(rows.flatMap((row) => row.balanceUncertaintyCodes ?? [])));
  let latest: AdminLedgerRowView | undefined;
  let latestDate = "";
  rows.forEach((row) => {
    const date = dateKey(row.transaction?.postedOn ?? row.transaction?.dueOn) ?? "";
    if (!latest || date >= latestDate) {
      latest = row;
      latestDate = date;
    }
  });
  const reported = latest?.runningBalanceCents ?? (latest?.rowType === "opening_balance" ? latest.openingBalanceCents ?? null : null);
  const complete = Boolean(latest && latest.balanceComplete !== false && uncertaintyCodes.length === 0 && typeof reported === "number");
  return {
    amountCents: complete ? reported : null,
    reportedAmountCents: typeof reported === "number" ? reported : null,
    complete,
    uncertaintyCodes,
    source: rows.length ? "ledger" : "unavailable",
  };
}

export function resolveTenantBalance(tenant: TenantView, snapshot: AdminSnapshot): TenantBalance {
  return balanceFromReport(tenant, snapshot) ?? balanceFromLedger(tenant);
}

export function buildTenantSummary(tenant: TenantView, snapshot: AdminSnapshot): TenantSummaryModel {
  const context = resolveTenantContext(tenant, snapshot);
  const balance = resolveTenantBalance(tenant, snapshot);
  const primaryLease = tenant.primaryLease
    ?? context.leaseTerms.find((term) => term.tenancyId === context.currentTenancy?.id)
    ?? context.leaseTerms[0];
  return {
    displayName: personDisplayName(tenant.person),
    propertyName: propertyDisplayName(context.property),
    unitLabel: unitDisplayName(context.unit),
    status: nonEmpty(context.currentTenancy?.status) ?? "Needs review",
    asOfDate: context.asOfDate,
    balance,
    currentTenancy: context.currentTenancy,
    primaryLease,
  };
}

export function buildHouseholdRows(tenant: TenantView, snapshot: AdminSnapshot): HouseholdRow[] {
  return (tenant.household ?? []).map((membership) => {
    const person = membership.personId ? snapshot.snapshot.people.find((candidate) => candidate.id === membership.personId) : undefined;
    return {
      membership,
      person,
      name: personDisplayName(person, membership.personId ? "Needs review" : "Unlinked person"),
      role: nonEmpty(membership.role) ?? "Needs review",
      relationship: nonEmpty(membership.relationship) ?? "Needs review",
      responsibility: membership.isFinanciallyResponsible === true ? "Yes" : membership.isFinanciallyResponsible === false ? "No" : "Needs review",
    };
  });
}

function normalizedScopeType(value: string | null | undefined): "tenant" | "unit" | "property" | "unknown" {
  const normalized = nonEmpty(value)?.toLowerCase();
  if (normalized === "person" || normalized === "resident") return "tenant";
  return normalized && CHARGE_SCOPE_TYPES.has(normalized) ? normalized as "tenant" | "unit" | "property" : "unknown";
}

function scopeIdFor(schedule: AdminRecurringScheduleView, type: "tenant" | "unit" | "property" | "unknown"): string | undefined {
  if (schedule.scopeId) return schedule.scopeId;
  if (type === "tenant") return schedule.personId ?? schedule.tenancyId ?? undefined;
  if (type === "unit") return schedule.unitId ?? undefined;
  if (type === "property") return schedule.propertyId ?? undefined;
  return undefined;
}

export function recurringChargeScope(schedule: AdminRecurringScheduleView, tenant: TenantView, snapshot: AdminSnapshot): RecurringChargeScope {
  const explicitType = normalizedScopeType(schedule.scopeType);
  const type = explicitType === "unknown"
    ? schedule.personId || schedule.tenancyId ? "tenant" : schedule.unitId ? "unit" : schedule.propertyId ? "property" : "unknown"
    : explicitType;
  const id = scopeIdFor(schedule, type);
  let label = "Needs review";
  if (type === "tenant") {
    const personId = id && snapshot.snapshot.people.some((person) => person.id === id) ? id : schedule.personId;
    const person = personId ? snapshot.snapshot.people.find((candidate) => candidate.id === personId) : undefined;
    const linkedTenancy = schedule.tenancyId ? snapshot.snapshot.tenancies.find((candidate) => candidate.id === schedule.tenancyId) : undefined;
    const linkedPerson = linkedTenancy?.primaryPersonId ? snapshot.snapshot.people.find((candidate) => candidate.id === linkedTenancy.primaryPersonId) : undefined;
    label = personDisplayName(person ?? linkedPerson ?? (schedule.personId === tenant.person.id ? tenant.person : undefined));
  } else if (type === "unit") {
    const unit = findUnit(snapshot, id ?? schedule.unitId ?? undefined);
    const property = findProperty(snapshot, unit?.propertyId ?? schedule.propertyId ?? undefined);
    label = unit ? `${unitDisplayName(unit)} · ${propertyDisplayName(property)}` : "Needs review";
  } else if (type === "property") {
    label = propertyDisplayName(findProperty(snapshot, id ?? schedule.propertyId ?? undefined));
  }
  const identitySource = explicitType === "unknown" ? (type === "unknown" ? "unknown" : "inferred") : "explicit";
  const inheritedIdentity = type === "unknown"
    ? "Scope needs review"
    : identitySource === "explicit" ? `Direct ${type} scope` : `Inferred from ${type} link`;
  const warning = type === "unknown" || !id || label === "Needs review"
    ? schedule.scopeType && explicitType === "unknown" ? "The schedule has an unrecognized scope." : "The schedule is missing a confirmed scope."
    : undefined;
  return { type, id, label, identitySource, inheritedIdentity, warning };
}

export function classifyRecurringSchedule(schedule: AdminRecurringScheduleView, asOfDate: string): RecurringChargeState {
  if (schedule.active === false) return "ended";
  if (schedule.active !== true || ["unknown", "ambiguous", "inferred"].includes(schedule.activeKnowledge ?? "")) return "unknown";
  const asOf = dateKey(asOfDate);
  const effectiveFrom = dateKey(schedule.effectiveFrom);
  const effectiveTo = dateKey(schedule.effectiveTo);
  if (!asOf || !effectiveFrom || (schedule.effectiveTo && !effectiveTo)) return "unknown";
  if (effectiveFrom > asOf) return "future";
  if (effectiveTo && effectiveTo < asOf) return "ended";
  return "current";
}

function chargeUncertainty(schedule: AdminRecurringScheduleView, definition?: AdminChargeDefinitionView, scope?: RecurringChargeScope): string[] {
  const codes: string[] = [];
  if (!schedule.id) codes.push("schedule_reference_unknown");
  if (schedule.amountCents == null) codes.push("amount_unknown");
  if (!schedule.billingFrequency) codes.push("frequency_unknown");
  if (!schedule.effectiveFrom || !dateKey(schedule.effectiveFrom)) codes.push("effective_start_unknown");
  if (schedule.effectiveTo && !dateKey(schedule.effectiveTo)) codes.push("effective_end_unknown");
  if (schedule.active == null) codes.push("active_status_unknown");
  if (definition?.id && !definition.displayName) codes.push("charge_definition_name_unknown");
  if (schedule.chargeDefinitionId && !definition) codes.push("charge_definition_unknown");
  if (scope?.type === "unknown") codes.push("scope_unknown");
  if (scope?.warning) codes.push("scope_identity_unknown");
  if (schedule.descriptionKnowledge && ["unknown", "ambiguous", "inferred"].includes(schedule.descriptionKnowledge)) codes.push("description_uncertain");
  if (schedule.activeKnowledge && ["unknown", "ambiguous", "inferred"].includes(schedule.activeKnowledge)) codes.push("active_status_uncertain");
  return Array.from(new Set(codes));
}

export function buildRecurringChargeRows(tenant: TenantView, snapshot: AdminSnapshot, asOfDate = snapshot.summary.asOfDate): RecurringChargeRow[] {
  return (tenant.schedules ?? []).map((schedule) => {
    const display = scheduleDisplayInterval(schedule, asOfDate);
    const definition = schedule.chargeDefinitionId ? snapshot.chargeDefinitions.find((candidate) => candidate.id === schedule.chargeDefinitionId) : undefined;
    const scope = recurringChargeScope(schedule, tenant, snapshot);
    const description = nonEmpty(schedule.description) ?? nonEmpty(definition?.displayName) ?? "Needs review";
    const definitionName = nonEmpty(definition?.displayName) ?? "Needs review";
    const category = nonEmpty(schedule.category) ?? nonEmpty(definition?.category) ?? "Needs review";
    return {
      schedule,
      id: schedule.id,
      description,
      definitionName,
      category,
      amountCents: schedule.amountCents ?? null,
      billingFrequency: schedule.billingFrequency ?? null,
      effectiveFrom: schedule.effectiveFrom,
      effectiveTo: display.effectiveTo,
      active: schedule.active,
      state: display.state,
      scope,
      uncertaintyCodes: [...chargeUncertainty(schedule, definition, scope), ...display.uncertaintyCodes],
    };
  });
}

export const getRecurringChargeRows = buildRecurringChargeRows;

export function filterRecurringCharges(rows: RecurringChargeRow[], filter: RecurringChargeFilter): RecurringChargeRow[] {
  if (filter === "all") return rows;
  if (filter === "current") return rows.filter((row) => row.state === "current" || row.state === "unknown");
  return rows.filter((row) => row.state === filter);
}

function ledgerUnitLabel(transaction: AdminLedgerTransactionView, tenant: TenantView, snapshot: AdminSnapshot): string {
  const unit = findUnit(snapshot, transaction.unitId);
  if (unit) return unitDisplayName(unit);
  if (transaction.unitId && tenant.unit?.id === transaction.unitId) return unitDisplayName(tenant.unit);
  return "Needs review";
}

function ledgerEntryKind(kind: string | undefined): "charge" | "payment" | "credit" | "other" {
  const normalized = nonEmpty(kind)?.toLowerCase();
  if (normalized === "charge" || normalized === "debit") return "charge";
  if (normalized === "payment" || normalized === "receipt") return "payment";
  if (normalized === "credit" || normalized === "refund") return "credit";
  return "other";
}

export function buildLedgerRows(tenant: TenantView, snapshot: AdminSnapshot): TenantLedgerRow[] {
  return (tenant.ledger ?? []).map((source, index) => {
    const transaction = source.transaction;
    const entryKind = source.rowType === "opening_balance" ? "other" : ledgerEntryKind(transaction.kind);
    const amount = typeof transaction.amountCents === "number" ? transaction.amountCents : null;
    const uncertaintyCodes = Array.from(new Set([
      ...(source.balanceUncertaintyCodes ?? []),
      ...(source.balanceComplete === false ? ["balance_incomplete"] : []),
      ...(!nonEmpty(transaction.status) ? ["status_unknown"] : []),
    ]));
    return {
      source,
      transaction,
      key: nonEmpty(transaction.id) ?? `ledger-row-${index}`,
      rowType: source.rowType ?? "transaction",
      date: transaction.postedOn || transaction.dueOn,
      unitLabel: ledgerUnitLabel(transaction, tenant, snapshot),
      reference: ledgerEntryReference(transaction, source.rowType),
      description: source.rowType === "opening_balance" ? "Opening balance" : nonEmpty(transaction.description) ?? nonEmpty(transaction.category) ?? "Needs review",
      chargeCents: entryKind === "charge" ? amount : null,
      paymentCents: entryKind === "payment" || entryKind === "credit" ? amount : null,
      paymentLabel: entryKind === "payment" ? "Payment" : entryKind === "credit" ? "Credit" : null,
      runningBalanceCents: source.balanceComplete === false || (source.balanceUncertaintyCodes?.length ?? 0) > 0 ? null : source.runningBalanceCents ?? (source.rowType === "opening_balance" ? source.openingBalanceCents ?? null : null),
      allocatedCents: source.balanceComplete === false || (source.balanceUncertaintyCodes?.length ?? 0) > 0 ? null : source.allocatedCents ?? null,
      openCents: source.balanceComplete === false || (source.balanceUncertaintyCodes?.length ?? 0) > 0 ? null : source.openCents ?? null,
      status: transaction.status,
      statusKnown: nonEmpty(transaction.status) !== undefined,
      kind: transaction.kind,
      category: transaction.category,
      payer: transaction.payer,
      dueOn: transaction.dueOn,
      paymentMethod: transaction.paymentMethod,
      reversalOfId: transaction.reversalOfId,
      uncertaintyCodes,
    };
  });
}

export const getLedgerRows = buildLedgerRows;

function revision(value: number | undefined): number {
  return value ?? 1;
}

function personEditValues(tenant: TenantView): FormValues {
  return {
    id: tenant.person.id,
    revision: revision(tenant.person.recordRevision),
    firstName: tenant.person.firstName,
    lastName: tenant.person.lastName,
    email: tenant.person.email ?? "",
    phone: tenant.person.phone ?? "",
    renterInsuranceExpiresOn: tenant.person.renterInsuranceExpiresOn ?? "",
    ...(tenant.person.archived == null ? {} : { archived: tenant.person.archived }),
  };
}

export function buildTenantEditActions(tenant: TenantView, snapshot: AdminSnapshot, tab: TenantTab): TenantEditAction[] {
  const context = resolveTenantContext(tenant, snapshot);
  const actions: TenantEditAction[] = [];
  if (tab === "summary") actions.push({ label: "Edit resident", action: "save-person", values: personEditValues(tenant) });
  if (tab === "household") {
    (tenant.household ?? []).forEach((record, index) => actions.push({ label: `Edit household member ${index + 1}`, action: "save-household-membership", values: {
      id: record.id,
      revision: revision(record.recordRevision),
      tenancyId: record.tenancyId ?? "",
      personId: record.personId,
      role: record.role ?? "",
      relationship: record.relationship ?? "",
      isFinanciallyResponsible: record.isFinanciallyResponsible ?? "",
    } }));
  }
  if (tab === "tenancy") {
    context.tenancies.forEach((record, index) => actions.push({ label: `Edit tenancy ${index + 1}`, action: "save-tenancy", values: {
      id: record.id,
      revision: revision(record.recordRevision),
      propertyId: record.propertyId,
      unitId: record.unitId,
      primaryPersonId: record.primaryPersonId,
      status: record.status,
      plannedMoveInOn: record.plannedMoveInOn ?? "",
      actualMoveInOn: record.actualMoveInOn ?? "",
      noticeOn: record.noticeOn ?? "",
      expectedMoveOutOn: record.expectedMoveOutOn ?? "",
      actualMoveOutOn: record.actualMoveOutOn ?? "",
    } }));
    context.leaseTerms.forEach((term, index) => actions.push({ label: `Edit lease ${index + 1}`, action: "save-lease-term", values: {
      id: term.id,
      revision: revision(term.recordRevision),
      tenancyId: term.tenancyId,
      status: term.status,
      contractStartOn: term.contractStartOn,
      contractEndOn: term.contractEndOn ?? "",
      signedOn: term.signedOn ?? "",
      monthToMonth: term.monthToMonth,
    } }));
  }
  if (tab === "charges") {
    if (context.currentTenancy?.id && context.unit?.id && context.property?.id && tenant.person.id) {
      actions.push({ label: "Add recurring charge", action: "save-recurring-schedule", values: {
        propertyId: context.property.id,
        unitId: context.unit.id,
        tenancyId: context.currentTenancy.id,
        personId: tenant.person.id,
        scopeType: "tenant",
        scopeId: tenant.person.id,
      } });
    }
    (tenant.schedules ?? []).forEach((schedule, index) => {
      if (!schedule.id || schedule.lineageState !== "valid" || schedule.canScheduleSuccessor !== true) return;
      const scope = recurringChargeScope(schedule, tenant, snapshot);
      if (scope.warning) return;
      const scopeLabel = scope.type === "tenant" ? "charge" : `shared ${scope.type} charge`;
      const values = { predecessorId: schedule.id, expectedRevision: revision(schedule.recordRevision) };
      actions.push({ label: `Replace ${scopeLabel} ${index + 1}`, action: "replace-recurring-schedule", values: { ...values, amountDollars: "", effectiveFrom: "" } });
      actions.push({ label: `End ${scopeLabel} ${index + 1}`, action: "end-recurring-schedule", values: { ...values, effectiveFrom: "" } });
    });
  }
  if (tab === "ledger") actions.push({ label: "Add transaction", action: "post-ledger-transaction", values: {
    propertyId: context.property?.id,
    unitId: context.unit?.id,
    tenancyId: context.currentTenancy?.id,
    personId: tenant.person.id,
  } });
  if (tab === "deposits") {
    (tenant.deposits ?? []).forEach((deposit, index) => actions.push({ label: `Edit deposit ${index + 1}`, action: "save-security-deposit", values: {
      id: deposit.id,
      revision: revision(deposit.recordRevision),
      propertyId: deposit.propertyId,
      unitId: deposit.unitId ?? "",
      tenancyId: deposit.tenancyId ?? "",
      personId: deposit.personId,
      type: deposit.type ?? "",
      amountDollars: typeof deposit.amountHeldCents === "number" ? String(deposit.amountHeldCents / 100) : "",
      receivedOn: deposit.receivedOn ?? "",
      dispositionStatus: deposit.dispositionStatus ?? "",
      disposedOn: deposit.disposedOn ?? "",
      dispositionNotes: deposit.dispositionNotes ?? "",
    } }));
    if (context.property?.id && tenant.person.id) actions.push({ label: "Add deposit", action: "save-security-deposit", values: {
      propertyId: context.property.id,
      unitId: context.unit?.id ?? "",
      tenancyId: context.currentTenancy?.id ?? "",
      personId: tenant.person.id,
      type: "security",
    } });
  }
  if (tab === "housing-assistance") {
    (tenant.subsidyContracts ?? []).forEach((contract, index) => actions.push({ label: `Edit HAP contract ${index + 1}`, action: "save-subsidy-contract", values: {
      id: contract.id,
      revision: revision(contract.recordRevision),
      propertyId: contract.propertyId,
      unitId: contract.unitId,
      tenancyId: contract.tenancyId,
      agencyName: contract.agencyName,
      contractNumber: contract.contractNumber ?? "",
      effectiveFrom: contract.effectiveFrom ?? "",
      effectiveTo: contract.effectiveTo ?? "",
      agencyDollars: typeof contract.agencyObligationCents === "number" ? String(contract.agencyObligationCents / 100) : "",
      tenantDollars: typeof contract.tenantObligationCents === "number" ? String(contract.tenantObligationCents / 100) : "",
      status: contract.status ?? "",
    } }));
  }
  if (tab === "activity") actions.push({ label: "Add activity", action: "save-activity", values: {
    propertyId: context.property?.id,
    unitId: context.unit?.id,
    tenancyId: context.currentTenancy?.id,
    personId: tenant.person.id,
  } });
  return actions;
}

export const getTenantEditActions = buildTenantEditActions;

export function tenancyDates(tenancy: AdminTenancyView): Array<{ label: string; value?: string }> {
  return [
    { label: "Planned move-in", value: tenancy.plannedMoveInOn },
    { label: "Actual move-in", value: tenancy.actualMoveInOn },
    { label: "Notice", value: tenancy.noticeOn },
    { label: "Expected move-out", value: tenancy.expectedMoveOutOn },
    { label: "Actual move-out", value: tenancy.actualMoveOutOn },
  ];
}

/** A total is only meaningful when every potentially current schedule has known cadence and activation. */
export function currentMonthlyTotal(rows: RecurringChargeRow[], candidatesComplete = true): number | null {
  if (!candidatesComplete || rows.some(row => row.state === "unknown")) return null;
  const current = rows.filter(row => row.state === "current");
  if (current.some(row => !row.billingFrequency || row.scope.warning)) return null;
  const monthly = current.filter(row => row.billingFrequency === "monthly");
  if (monthly.some(row => row.amountCents == null || !Number.isFinite(row.amountCents))) return null;
  return monthly.reduce((sum, row) => sum + row.amountCents!, 0);
}

export function ledgerActionEligibility(row: TenantLedgerRow, rows: TenantLedgerRow[]): { reverse: boolean; allocate: boolean } {
  const tx = row.transaction;
  const realPosted = Boolean(tx.id && !tx.id.startsWith("shared-application:") && row.rowType === "transaction"
    && tx.status === "posted" && !["unknown", "ambiguous", "inferred"].includes(tx.statusKnowledge ?? "")
    && tx.kind && ["charge", "payment", "credit", "adjustment"].includes(tx.kind) && !tx.reversalOfId
    && !rows.some(candidate => candidate.transaction.reversalOfId === tx.id && candidate.transaction.status !== "voided"));
  const amountKnown = typeof tx.amountCents === "number" && Number.isFinite(tx.amountCents);
  return {
    reverse: realPosted && amountKnown && Boolean(tx.category && tx.propertyId && tx.postedOn && tx.description),
    allocate: realPosted && tx.kind === "payment" && amountKnown && row.openCents !== null && row.openCents > 0,
  };
}

export function ledgerEntryReference(transaction: AdminLedgerTransactionView, rowType?: string): string {
  if (rowType === "opening_balance") return "Opening balance";
  if (transaction.id?.startsWith("shared-application:")) return "Shared payment";
  if (transaction.id?.startsWith("billing:")) return "Monthly billing";
  return ({ payment: "Payment", charge: "Charge", credit: "Credit", reversal: "Reversal", adjustment: "Adjustment" } as Record<string, string>)[transaction.kind ?? ""] ?? "—";
}

export function filterTenantLedger(rows: TenantLedgerRow[], search: string, from: string, to: string): TenantLedgerRow[] {
  const query = search.trim().toLowerCase();
  return rows.filter(row => {
    const date = dateKey(row.date);
    if ((from || to) && !date) return false;
    if (from && date! < from || to && date! > to) return false;
    return !query || [row.description, row.reference, row.unitLabel, row.status, row.payer, row.paymentMethod].some(value => value?.toLowerCase().includes(query));
  });
}
