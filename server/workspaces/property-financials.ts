import type {
  CollectedIncomeRow, DelinquencyRow, DepositLiabilityRow, RentOpsFilters, RentOpsSnapshot, ScheduledIncomeRow,
} from "../../shared/rent-ops-contracts";
import type { FinancialMeasure, FinancialMeasureKey, FinancialMeasureRecord, PropertyFinancials, WorkspaceRecordLink } from "../../shared/workspaces/contracts";
import { deriveFixedReport } from "../rent-ops/domain/reports";
import { userDraftCostPredicate } from "../projects/helpers";
import { RECORD_LIMIT, centsOf, monthBounds } from "./period";
import type { ProjectFinanceReadPort } from "../../shared/projects";
import { centsText, centsValue, dateText, type PropertyEntityMapping, type WorkspaceReadContext } from "./access";
import { readProjectPostings, readWorkspaceProjects, type ProjectPostings } from "./project-postings";

/**
 * Property financials join rental operating detail and company records for one
 * month. Each rental measure is derived from the same report function the
 * report pages and agents use (deriveFixedReport), over one snapshot, so the
 * totals agree with the reports. Distinct measures stay distinct: scheduled
 * rent is not collections, collections are not remittances, and nothing here
 * is labelled "income".
 */

interface Accumulator { known: bigint; unknown: number; uncertain: boolean; records: FinancialMeasureRecord[]; count: number }
const accumulator = (): Accumulator => ({ known: BigInt(0), unknown: 0, uncertain: false, records: [], count: 0 });

function add(target: Accumulator, amount: bigint | null, record: Omit<FinancialMeasureRecord, "amountCents">, uncertain = false): void {
  target.count += 1;
  if (amount === null) target.unknown += 1; else target.known += amount;
  if (uncertain) target.uncertain = true;
  if (target.records.length < RECORD_LIMIT) target.records.push({ ...record, amountCents: centsText(amount) });
}

function measure(
  key: FinancialMeasureKey, label: string, group: FinancialMeasure["group"], basis: string, value: Accumulator, report: string | null = null,
): FinancialMeasure {
  return {
    key, label, group, basis, state: "available", unavailableReason: null,
    // A total with unknown contributors is shown as the known part and marked incomplete; a
    // measure whose only contributors are unknown has no amount at all.
    amountCents: value.count > 0 && value.unknown === value.count ? null : value.known.toString(),
    complete: value.unknown === 0 && !value.uncertain,
    unknownCount: value.unknown, recordCount: value.count, records: value.records, report,
  };
}

function unavailable(key: FinancialMeasureKey, label: string, group: FinancialMeasure["group"], basis: string, reason: string): FinancialMeasure {
  return { key, label, group, basis, state: "unavailable", unavailableReason: reason, amountCents: null, complete: false, unknownCount: 0, recordCount: 0, records: [], report: null };
}

const tenantLink = (personId: string | null | undefined, view: string): WorkspaceRecordLink | null => personId ? { kind: "tenant", id: personId, view } : null;
const unitLabel = (unitNumber: string | null | undefined) => unitNumber ? `Unit ${unitNumber}` : null;

/** Filters shared by every monthly rental measure; identical to the report page filters for one property. */
export function propertyReportFilters(propertyId: string, month: string, asOf: string): { monthly: RentOpsFilters; asOf: RentOpsFilters } {
  return {
    monthly: { propertyScope: "all", propertyId, month: month as RentOpsFilters["month"], asOfDate: asOf as RentOpsFilters["asOfDate"] },
    asOf: { propertyScope: "all", propertyId, asOfDate: asOf as RentOpsFilters["asOfDate"] },
  };
}

export function computeRentalMeasures(snapshot: RentOpsSnapshot, propertyId: string, month: string, asOf: string): FinancialMeasure[] {
  const filters = propertyReportFilters(propertyId, month, asOf);
  const { from, to } = monthBounds(month);
  const cutoff = asOf < to ? asOf : to;

  const scheduledRent = accumulator(); const scheduledOther = accumulator();
  for (const row of deriveFixedReport(snapshot, "scheduled-income", filters.monthly) as ScheduledIncomeRow[]) {
    const target = row.category === "base_rent" ? scheduledRent : scheduledOther;
    add(target, centsOf(row.amountCents), {
      label: row.tenantName ?? unitLabel(row.unitNumber) ?? "Unassigned schedule",
      detail: [unitLabel(row.unitNumber), row.description].filter(Boolean).join(" · ") || null,
      date: null, link: tenantLink(row.personId, "charges"), sourceReferences: [],
    }, row.uncertain === true || row.temporalUncertainty === true || row.unclassified === true);
  }

  const chargesPosted = accumulator();
  const reversed = new Set(snapshot.ledgerTransactions
    .filter(entry => entry.kind === "reversal" && entry.status === "posted" && entry.reversalOfId && entry.postedOn && entry.postedOn <= cutoff)
    .map(entry => entry.reversalOfId!));
  const people = new Map(snapshot.people.map(person => [person.id, person]));
  const units = new Map(snapshot.units.map(unit => [unit.id, unit]));
  for (const entry of snapshot.ledgerTransactions) {
    if (entry.kind !== "charge" || entry.status !== "posted" || entry.propertyId !== propertyId) continue;
    if (!entry.postedOn || entry.postedOn < from || entry.postedOn > cutoff || reversed.has(entry.id)) continue;
    const person = entry.personId ? people.get(entry.personId) : undefined;
    add(chargesPosted, centsOf(entry.amountCents), {
      label: person ? [person.firstName, person.lastName].filter(Boolean).join(" ") || "Tenant" : unitLabel(units.get(entry.unitId ?? "")?.unitNumber) ?? "Charge",
      detail: [unitLabel(units.get(entry.unitId ?? "")?.unitNumber), entry.description].filter(Boolean).join(" · ") || null,
      date: entry.postedOn, link: tenantLink(entry.personId, "ledger"), sourceReferences: [],
    }, entry.category === null);
  }

  const payers = new Map(snapshot.ledgerTransactions.map(entry => [entry.id, entry.payer ?? null]));
  const tenantReceipts = accumulator(); const subsidyReceipts = accumulator(); const otherReceipts = accumulator();
  for (const row of deriveFixedReport(snapshot, "collected-income", filters.monthly) as CollectedIncomeRow[]) {
    const payer = row.paymentTransactionId ? payers.get(row.paymentTransactionId) : null;
    const target = payer === "tenant" ? tenantReceipts : payer === "agency" ? subsidyReceipts : otherReceipts;
    add(target, centsOf(row.amountCents), {
      label: row.tenantName ?? unitLabel(row.unitNumber) ?? "Receipt",
      detail: [unitLabel(row.unitNumber), row.description].filter(Boolean).join(" · ") || null,
      date: row.paymentOn, link: tenantLink(row.personId, "ledger"), sourceReferences: [],
    }, row.paymentOn === null);
  }

  const arrears = accumulator();
  for (const row of deriveFixedReport(snapshot, "delinquency", filters.asOf) as DelinquencyRow[]) {
    const balance = row.operationalBalanceCents;
    if (typeof balance === "number" && balance <= 0) continue;
    add(arrears, centsOf(balance ?? null), {
      label: row.tenantName, detail: unitLabel(row.unitNumber), date: row.oldestUnpaidRentOn ?? null,
      link: tenantLink(row.personId, "ledger"), sourceReferences: [],
    }, row.balanceComplete === false);
  }

  const deposits = accumulator();
  for (const row of deriveFixedReport(snapshot, "security-deposit", filters.asOf) as DepositLiabilityRow[]) {
    add(deposits, centsOf(row.totalHeldCents), {
      label: row.tenantName, detail: unitLabel(row.unitNumber), date: null, link: tenantLink(row.personId, "deposits"), sourceReferences: [],
    }, row.temporalUncertainty || (row.unknownHeldCount ?? 0) > 0);
  }

  return [
    measure("scheduled_rent", "Scheduled rent", "rental", `Base-rent schedules for ${month}`, scheduledRent, "scheduled-income"),
    measure("scheduled_other_charges", "Other scheduled charges", "rental", `Recurring fees and other schedules for ${month}`, scheduledOther, "scheduled-income"),
    measure("charges_posted", "Charges posted", "rental", `Tenant ledger charges posted ${from} to ${cutoff}, net of reversals`, chargesPosted),
    measure("tenant_collections", "Tenant collections", "collections", `Receipts from tenants applied to charges, received in ${month}`, tenantReceipts, "collected-income"),
    measure("subsidy_collections", "Subsidy collections", "collections", `Receipts from housing agencies applied to charges, received in ${month}`, subsidyReceipts, "collected-income"),
    measure("other_collections", "Other or unidentified payers", "collections", `Receipts from owners or payers not recorded, received in ${month}`, otherReceipts, "collected-income"),
    measure("arrears", "Arrears", "balances", `Operational balances due as of ${asOf}`, arrears, "delinquency"),
    measure("deposits_held", "Deposits held", "balances", `Refundable deposits held as of ${asOf}`, deposits, "security-deposit"),
  ];
}

export interface CompanyPropertyRows {
  readonly mapping: PropertyEntityMapping;
  readonly settlements: ReadonlyArray<Record<string, unknown>>;
  /** Posted project costs from the project finance read port, never the legacy importer table. */
  readonly postings: ProjectPostings;
  readonly drafts: ReadonlyArray<Record<string, unknown>>;
}

/** Company records for one property and month. The caller has already checked the grant. */
export async function readCompanyPropertyRows(
  context: WorkspaceReadContext, mapping: PropertyEntityMapping, from: string, to: string, through: string, finance: ProjectFinanceReadPort,
): Promise<CompanyPropertyRows> {
  const organizationId = context.principal.organizationId;
  const settlements = await context.executor.query<Record<string, unknown>>(
    `SELECT id, manager_name, period_start::text AS period_start, period_end::text AS period_end, currency, gross_collections_cents,
            pm_fees_cents, pm_expenses_cents, other_deductions_cents, owner_remittance_cents, closing_held_cents, state,
            exception_reason, bank_settled_on::text AS bank_settled_on, bank_observation_reference, qbo_references
       FROM accounting_pm_settlements
      WHERE organization_id = $1 AND property_id = $2 AND period_end BETWEEN $3::date AND $4::date
      ORDER BY period_end, manager_name, id LIMIT 200`,
    [organizationId, mapping.propertyId, from, to],
  );
  const projects = await readWorkspaceProjects(context, [mapping.propertyId]);
  const postings = await readProjectPostings(context, finance, projects.projects, { from, through, incomplete: projects.truncated || projects.uncovered > 0 });
  const drafts = await context.executor.query<Record<string, unknown>>(
    `SELECT d.id, d.project_id, p.name AS project_name, d.description, d.vendor_name, d.amount_cents, d.currency, d.incurred_on::text AS incurred_on
       FROM company_project_draft_costs d
       JOIN company_projects p ON p.organization_id = d.organization_id AND p.id = d.project_id
      WHERE d.organization_id = $1 AND p.property_id = $2 AND d.archived_at IS NULL AND ${userDraftCostPredicate("d")} AND d.incurred_on BETWEEN $3::date AND $4::date
      ORDER BY d.incurred_on, d.id LIMIT 500`,
    [organizationId, mapping.propertyId, from, to],
  );
  return { mapping, settlements: settlements.rows, postings, drafts: drafts.rows };
}

const COMPANY_MEASURES: ReadonlyArray<[FinancialMeasureKey, string, FinancialMeasure["group"], string]> = [
  ["pm_gross_collections", "Collected by manager", "manager", "Gross collections on PM statements ending in the period"],
  ["pm_fees", "Manager fees", "manager", "Management fees on PM statements ending in the period"],
  ["pm_expenses", "Manager-paid expenses", "manager", "Expenses and other deductions on PM statements ending in the period"],
  ["owner_remittances", "Owner remittances", "manager", "Amounts remitted to the owner on PM statements ending in the period"],
  ["manager_held_funds", "Held by manager", "manager", "Closing funds held on the latest PM statement in the period"],
  ["project_spending_posted", "Project spending", "projects", "Project costs posted in QuickBooks in the period"],
  ["project_costs_recorded", "Project costs not yet posted", "projects", "Project costs recorded here with no QuickBooks posting yet"],
];

export function companyUnavailableMeasures(reason: string): FinancialMeasure[] {
  return COMPANY_MEASURES.map(([key, label, group, basis]) => unavailable(key, label, group, basis, reason));
}

export function computeCompanyMeasures(rows: CompanyPropertyRows, currency = "USD"): FinancialMeasure[] {
  const settlements = rows.settlements.filter(row => row.currency === currency);
  const byKey = new Map<FinancialMeasureKey, FinancialMeasure>();
  const [gross, fees, expenses, remitted, held] = COMPANY_MEASURES.slice(0, 5);
  if (!settlements.length) {
    const reason = rows.settlements.length ? `PM statements in this period are not in ${currency}.` : "No property-manager statement ends in this period.";
    for (const [key, label, group, basis] of [gross, fees, expenses, remitted, held]) byKey.set(key, unavailable(key, label, group, basis, reason));
  } else {
    const values = { gross: accumulator(), fees: accumulator(), expenses: accumulator(), remitted: accumulator() };
    const settlementRecord = (row: Record<string, unknown>): Omit<FinancialMeasureRecord, "amountCents"> => ({
      label: String(row.manager_name),
      detail: `${dateText(row.period_start)} to ${dateText(row.period_end)} · ${row.state === "reconciled" ? "Reconciled" : row.state === "exception" ? "Exception" : "Not reconciled"}`,
      date: dateText(row.period_end), link: { kind: "settlement", id: String(row.id) },
      sourceReferences: [...(Array.isArray(row.qbo_references) ? row.qbo_references.slice(0, 10).map(value => `QBO ${typeof value === "string" ? value : JSON.stringify(value)}`.slice(0, 200)) : []),
        ...(typeof row.bank_observation_reference === "string" ? [`Bank ${row.bank_observation_reference}`.slice(0, 200)] : [])],
    });
    for (const row of settlements) {
      const unreconciled = row.state !== "reconciled";
      add(values.gross, centsValue(row.gross_collections_cents), settlementRecord(row), unreconciled);
      add(values.fees, centsValue(row.pm_fees_cents), settlementRecord(row), unreconciled);
      const expense = centsValue(row.pm_expenses_cents); const other = centsValue(row.other_deductions_cents);
      add(values.expenses, expense === null || other === null ? null : expense + other, settlementRecord(row), unreconciled);
      add(values.remitted, centsValue(row.owner_remittance_cents), settlementRecord(row), unreconciled || (row.bank_settled_on === null && centsValue(row.owner_remittance_cents) !== BigInt(0)));
    }
    const latest = settlements[settlements.length - 1];
    const heldValue = accumulator();
    add(heldValue, centsValue(latest.closing_held_cents), settlementRecord(latest), latest.state !== "reconciled");
    byKey.set("pm_gross_collections", measure(gross[0], gross[1], gross[2], gross[3], values.gross));
    byKey.set("pm_fees", measure(fees[0], fees[1], fees[2], fees[3], values.fees));
    byKey.set("pm_expenses", measure(expenses[0], expenses[1], expenses[2], expenses[3], values.expenses));
    byKey.set("owner_remittances", measure(remitted[0], remitted[1], remitted[2], remitted[3], values.remitted));
    byKey.set("manager_held_funds", measure(held[0], held[1], held[2], held[3], heldValue));
  }
  const posted = accumulator();
  for (const { project, actual } of rows.postings.actuals) {
    add(posted, actual.currency === currency ? BigInt(actual.amountCents) : null, {
      label: project.name, detail: actual.description, date: actual.postedOn,
      link: { kind: "project", id: project.id },
      sourceReferences: [`QBO ${actual.source.objectType} ${actual.source.objectId}${actual.source.lineId ? ` line ${actual.source.lineId}` : ""}`.slice(0, 200)],
    });
  }
  // Partial QuickBooks coverage is a minimum ("At least"), never a complete total.
  if (rows.postings.coverage !== "complete") posted.uncertain = true;
  const recorded = accumulator();
  for (const row of rows.drafts) {
    const sameCurrency = row.currency === currency;
    add(recorded, sameCurrency ? centsValue(row.amount_cents) : null, {
      label: String(row.project_name), detail: [row.vendor_name, row.description].filter(value => typeof value === "string" && value).join(" · ") || null,
      date: dateText(row.incurred_on), link: { kind: "project", id: String(row.project_id) }, sourceReferences: [],
    });
  }
  const [postedKey, recordedKey] = COMPANY_MEASURES.slice(5);
  byKey.set("project_spending_posted", rows.postings.coverage === "unavailable"
    ? unavailable(postedKey[0], postedKey[1], postedKey[2], postedKey[3], "QuickBooks postings for this property's projects are not available.")
    : measure(postedKey[0], postedKey[1], postedKey[2], postedKey[3], posted));
  byKey.set("project_costs_recorded", measure(recordedKey[0], recordedKey[1], recordedKey[2], recordedKey[3], recorded));
  return COMPANY_MEASURES.map(([key]) => byKey.get(key)!);
}

export function assemblePropertyFinancials(input: {
  snapshot: RentOpsSnapshot; propertyId: string; month: string; asOf: string;
  company: { organizationId: string; rows?: CompanyPropertyRows; unavailableReason?: string } | null;
}): PropertyFinancials {
  const property = input.snapshot.properties.find(candidate => candidate.id === input.propertyId);
  const { from, to } = monthBounds(input.month);
  const rental = computeRentalMeasures(input.snapshot, input.propertyId, input.month, input.asOf);
  const company = input.company?.rows
    ? computeCompanyMeasures(input.company.rows)
    : companyUnavailableMeasures(input.company?.unavailableReason ?? "Choose a company to include manager and project figures.");
  return {
    propertyId: input.propertyId,
    propertyName: property?.name ?? "Property",
    period: { month: input.month, from, to, asOf: input.asOf },
    currency: "USD",
    company: input.company ? {
      organizationId: input.company.organizationId,
      legalEntityId: input.company.rows?.mapping.legalEntityId ?? null,
      legalEntityName: input.company.rows?.mapping.legalEntityName ?? null,
    } : null,
    measures: [...rental, ...company],
  };
}
