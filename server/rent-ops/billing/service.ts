import { createHash } from "node:crypto";
import type { IsoMonth, RentOpsLedgerTransaction, RentOpsSnapshot } from "../../../shared/rent-ops-contracts";
import { financialMonthInterval, projectFinancialOccupancy, projectFinancialSchedules, resolveEffectiveScheduleVersions } from "../domain/financial-projection";

export interface BillingReceipt {
  lineageRootId: string;
  scheduleId: string;
  billingOn: string;
  ledgerTransactionId: string;
  tenancyId: string;
  amountCents: number;
  previewToken: string;
  actorSubject: string;
  postedAt: string;
}

export interface BillingData { snapshot: RentOpsSnapshot; receipts: BillingReceipt[] }
export interface BillingWriteContext {
  read(month: IsoMonth): Promise<BillingData>;
  insert(transaction: RentOpsLedgerTransaction, receipt: BillingReceipt): Promise<void>;
}
export interface BillingStore {
  read(month: IsoMonth): Promise<BillingData>;
  transaction<T>(month: IsoMonth, work: (context: BillingWriteContext) => Promise<T>): Promise<T>;
}

export interface BillingPreviewRow {
  scheduleId: string;
  propertyName: string;
  unitNumber: string;
  tenantName: string;
  description: string;
  amountCents: number | null;
  billingOn: string;
  status: "ready" | "blocked" | "posted" | "excluded";
  reasons: string[];
}
export interface BillingPreview {
  month: IsoMonth;
  billingOn: string;
  previewToken: string;
  rows: BillingPreviewRow[];
  readyCount: number;
  readyCents: number;
  blockedCount: number;
  postedCount: number;
  postedCents: number;
}
export interface BillingPostResult {
  postedCount: number;
  postedCents: number;
  alreadyPostedCount: number;
  preview: BillingPreview;
}

export class BillingError extends Error {
  constructor(readonly code: "invalid_input" | "preview_changed" | "billing_busy" | "no_ready_charges" | "billing_unavailable", readonly status: number) {
    super(code);
    this.name = "BillingError";
  }
}

const MONTH = /^(?:19|20|21)\d{2}-(?:0[1-9]|1[0-2])$/;
export function parseBillingMonth(value: unknown): IsoMonth {
  if (typeof value !== "string" || !MONTH.test(value)) throw new BillingError("invalid_input", 400);
  return value as IsoMonth;
}

const billableCategories = new Set(["base_rent", "recurring_fee"]);
const sum = (rows: BillingPreviewRow[]): number => {
  const total = rows.reduce((value, row) => value + (row.amountCents ?? 0), 0);
  if (!Number.isSafeInteger(total)) throw new BillingError("billing_unavailable", 409);
  return total;
};
export function recurringLedgerId(lineageRootId: string, billingOn: string): string {
  return `billing:${createHash("sha256").update(JSON.stringify([lineageRootId, billingOn])).digest("hex")}`;
}

interface PlannedCharge { row: BillingPreviewRow; transaction?: RentOpsLedgerTransaction; lineageRootId: string }

/** Billing is deliberately narrower than the monthly forecast. Only exact,
 * full-month tenant obligations become immutable ledger charges. */
function planBilling(data: BillingData, month: IsoMonth): { preview: BillingPreview; charges: PlannedCharge[] } {
  const { snapshot } = data;
  const interval = financialMonthInterval(month);
  const receipts = data.receipts.filter((receipt) => receipt.billingOn === interval.start);
  const projection = projectFinancialSchedules(snapshot, month);
  const schedules = new Map(snapshot.recurringSchedules.map((schedule) => [schedule.id, schedule]));
  const prior = new Map(receipts.map((receipt) => [receipt.lineageRootId, receipt]));
  const charges: PlannedCharge[] = [];
  const shownReceipts = new Set<string>();

  const postedRow = (receipt: BillingReceipt): PlannedCharge => {
    const transaction = snapshot.ledgerTransactions.find((entry) => entry.id === receipt.ledgerTransactionId);
    const tenancy = snapshot.tenancies.find((entry) => entry.id === receipt.tenancyId);
    const person = snapshot.people.find((entry) => entry.id === transaction?.personId || entry.id === tenancy?.primaryPersonId);
    shownReceipts.add(receipt.lineageRootId);
    return { lineageRootId: receipt.lineageRootId, row: {
      scheduleId: receipt.scheduleId,
      propertyName: snapshot.properties.find((entry) => entry.id === transaction?.propertyId)?.name ?? "Needs review",
      unitNumber: snapshot.units.find((entry) => entry.id === transaction?.unitId)?.unitNumber ?? "Needs review",
      tenantName: person ? `${person.firstName ?? ""} ${person.lastName ?? ""}`.trim() : "Needs review",
      description: transaction?.description ?? "Monthly charge",
      amountCents: receipt.amountCents, billingOn: receipt.billingOn, status: "posted", reasons: [],
    } };
  };

  for (const projected of projection.rows) {
    const schedule = projected.scheduleId ? schedules.get(projected.scheduleId) : undefined;
    if (!schedule) continue;
    const lineageRootId = schedule.lineageRootId ?? schedule.id;
    const existingReceipt = prior.get(lineageRootId);
    if (existingReceipt) {
      if (!shownReceipts.has(lineageRootId)) charges.push(postedRow(existingReceipt));
      continue;
    }
    const row: BillingPreviewRow = {
      scheduleId: schedule.id, propertyName: projected.propertyName ?? "Needs review",
      unitNumber: projected.unitNumber ?? "Needs review", tenantName: projected.tenantName ?? "Needs review",
      description: projected.description ?? "Needs review", amountCents: projected.amountCents,
      billingOn: interval.start, status: "ready", reasons: [],
    };
    const plan: PlannedCharge = { row, lineageRootId };
    charges.push(plan);
    if (schedule.category && !billableCategories.has(schedule.category)) {
      row.status = "excluded";
      row.reasons = ["Use the separate workflow for subsidy, deposits, and one-time charges."];
      continue;
    }
    const reasons = row.reasons;
    if (projected.known !== true) reasons.push("Schedule facts or tenant assignment need review.");
    if (typeof projected.amountCents !== "number" || !Number.isSafeInteger(projected.amountCents) || projected.amountCents <= 0 || projected.amountKnowledge !== "known") reasons.push("A confirmed positive amount is required.");
    if (!schedule.category || !billableCategories.has(schedule.category)) reasons.push("Charge category needs review.");
    if (!schedule.description?.trim()) reasons.push("Charge description is missing.");
    if (!schedule.effectiveFrom || schedule.effectiveFrom > interval.start || (schedule.effectiveTo && schedule.effectiveTo < interval.end)) reasons.push("Partial-month schedule requires an explicit manual charge.");
    const tenancy = snapshot.tenancies.find((entry) => entry.id === projected.tenancyId);
    const unit = snapshot.units.find((entry) => entry.id === projected.unitId);
    const property = snapshot.properties.find((entry) => entry.id === projected.propertyId);
    if (!tenancy || !["current", "notice"].includes(tenancy.status) || !unit || !projected.personId || !projected.propertyId) reasons.push("An active tenancy with exact property, unit, and tenant links is required.");
    if (!property || property.state !== "active") reasons.push("Property must be active.");
    if (unit) {
      const occupancy = projectFinancialOccupancy(snapshot, unit, month);
      if (occupancy.occupancy !== "current" || occupancy.tenancyId !== tenancy?.id) reasons.push("Occupancy needs review.");
      if (occupancy.partialMonth) reasons.push("Partial-month occupancy requires an explicit manual charge.");
    }
    if (tenancy && snapshot.leaseTerms.some((term) => term.tenancyId === tenancy.id && ["executed", "month_to_month"].includes(term.status)
      && term.contractStartOn <= interval.end && (!term.contractEndOn || term.contractEndOn >= interval.start)
      && (term.contractStartOn > interval.start || (term.contractEndOn && term.contractEndOn < interval.end && !term.monthToMonth && term.status !== "month_to_month")))) {
      reasons.push("Partial-month lease requires an explicit manual charge.");
    }
    // Imported/manual charges do not carry our billing receipt. Never guess
    // that an existing charge represents this schedule, or charge twice.
    const otherCharge = snapshot.ledgerTransactions.some((entry) => entry.kind === "charge"
      && entry.tenancyId === projected.tenancyId && entry.status !== "voided"
      && (!entry.postedOn || entry.postedOn.slice(0, 7) === month || entry.dueOn?.slice(0, 7) === month)
      && (entry.chargeDefinitionId === schedule.chargeDefinitionId || !entry.category || entry.category === schedule.category)
      && !receipts.some((receipt) => receipt.ledgerTransactionId === entry.id));
    if (otherCharge) reasons.push("An existing charge may cover this month; reconcile it before posting.");
    row.reasons = Array.from(new Set(reasons));
    if (row.reasons.length) { row.status = "blocked"; continue; }
    plan.transaction = {
      id: recurringLedgerId(lineageRootId, interval.start), propertyId: projected.propertyId!,
      unitId: projected.unitId!, tenancyId: projected.tenancyId!, personId: projected.personId!,
      kind: "charge", category: schedule.category!, categoryKnowledge: "manual", status: "posted", statusKnowledge: "manual",
      amountCents: projected.amountCents!, amountKnowledge: "known", postedOn: interval.start, postedOnKnowledge: "manual",
      dueOn: interval.start, dueOnKnowledge: "manual", description: `${month} ${schedule.description}`.slice(0, 240), descriptionKnowledge: "manual",
      paymentMethod: null, paymentMethodKnowledge: "unknown",
      payer: "tenant", payerKnowledge: "manual", propertyLinkKnowledge: "manual", unitLinkKnowledge: "manual", tenancyLinkKnowledge: "manual", personLinkKnowledge: "manual",
      chargeDefinitionId: schedule.chargeDefinitionId, chargeDefinitionLinkKnowledge: "manual",
    };
  }

  // The forecast removes end-tombstones altogether. An end during the month
  // still needs a human proration decision; surface that omission explicitly.
  const versions = resolveEffectiveScheduleVersions(snapshot.recurringSchedules, month, { strictLineage: snapshot.modelVersion === 3 });
  for (const schedule of versions.endedSchedules) {
    const root = schedule.lineageRootId ?? schedule.id;
    if (!schedule.effectiveFrom || schedule.effectiveFrom <= interval.start || schedule.effectiveFrom > interval.end || prior.has(root) || (schedule.category && !billableCategories.has(schedule.category))) continue;
    charges.push({ lineageRootId: root, row: {
      scheduleId: schedule.id, propertyName: snapshot.properties.find((entry) => entry.id === schedule.propertyId)?.name ?? "Needs review",
      unitNumber: snapshot.units.find((entry) => entry.id === schedule.unitId)?.unitNumber ?? "Needs review",
      tenantName: "Needs review", description: schedule.description ?? "Monthly charge", amountCents: null,
      billingOn: interval.start, status: "blocked", reasons: ["Schedule ends during this month; enter the confirmed partial-month charge manually."],
    } });
  }
  for (const receipt of receipts) if (!shownReceipts.has(receipt.lineageRootId)) charges.push(postedRow(receipt));
  charges.sort((a, b) => a.row.propertyName.localeCompare(b.row.propertyName) || a.row.unitNumber.localeCompare(b.row.unitNumber) || a.row.scheduleId.localeCompare(b.row.scheduleId));
  const lineageCounts = new Map<string, number>();
  for (const charge of charges) if (charge.row.status === "ready") lineageCounts.set(charge.lineageRootId, (lineageCounts.get(charge.lineageRootId) ?? 0) + 1);
  for (const charge of charges) if (charge.row.status === "ready" && (lineageCounts.get(charge.lineageRootId) ?? 0) > 1) {
    charge.row.status = "blocked";
    charge.row.reasons.push("Schedule resolves to multiple charges; confirm a separate schedule for each obligation.");
    delete charge.transaction;
  }
  const rows = charges.map((charge) => charge.row);
  const ready = rows.filter((row) => row.status === "ready");
  const posted = rows.filter((row) => row.status === "posted");
  const previewToken = createHash("sha256").update(JSON.stringify({ month, charges })).digest("hex");
  return { charges, preview: {
    month, billingOn: interval.start, previewToken, rows, readyCount: ready.length, readyCents: sum(ready),
    blockedCount: rows.filter((row) => row.status === "blocked").length, postedCount: posted.length, postedCents: sum(posted),
  } };
}

export function previewRecurringBilling(data: BillingData, month: string): BillingPreview {
  return planBilling(data, parseBillingMonth(month)).preview;
}

export class RecurringBillingService {
  constructor(private readonly store: BillingStore, private readonly now: () => Date = () => new Date()) {}
  async preview(month: string): Promise<BillingPreview> {
    const parsed = parseBillingMonth(month);
    return previewRecurringBilling(await this.store.read(parsed), parsed);
  }
  async post(input: { month: string; previewToken: string; actorSubject: string }): Promise<BillingPostResult> {
    const month = parseBillingMonth(input.month);
    if (!/^[a-f0-9]{64}$/.test(input.previewToken) || !input.actorSubject.trim()) throw new BillingError("invalid_input", 400);
    return this.store.transaction(month, async (context) => {
      const data = await context.read(month);
      const plan = planBilling(data, month);
      const replay = data.receipts.filter((receipt) => receipt.previewToken === input.previewToken);
      if (replay.length) return { postedCount: 0, postedCents: 0, alreadyPostedCount: replay.length, preview: plan.preview };
      if (plan.preview.previewToken !== input.previewToken) throw new BillingError("preview_changed", 409);
      const ready = plan.charges.filter((charge) => charge.row.status === "ready" && charge.transaction);
      if (!ready.length) throw new BillingError("no_ready_charges", 409);
      for (const charge of ready) {
        const transaction = charge.transaction!;
        const receipt: BillingReceipt = {
          lineageRootId: charge.lineageRootId, scheduleId: charge.row.scheduleId, billingOn: transaction.postedOn!,
          ledgerTransactionId: transaction.id, tenancyId: transaction.tenancyId!, amountCents: transaction.amountCents!,
          previewToken: input.previewToken, actorSubject: input.actorSubject, postedAt: this.now().toISOString(),
        };
        await context.insert(transaction, receipt);
        data.snapshot.ledgerTransactions.push(transaction);
        data.receipts.push(receipt);
      }
      return { postedCount: ready.length, postedCents: plan.preview.readyCents, alreadyPostedCount: 0, preview: planBilling(data, month).preview };
    });
  }
}
