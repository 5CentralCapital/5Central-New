import { centsFromBigInt, type MoneyCents } from "../../shared/company";
import {
  rentalBridgePreviewQuerySchema,
  rentalBridgePreviewSchema,
  type BridgeControlTotals,
  type RentalBridgePreview,
  type RentalPostingMethod,
} from "../../shared/accounting/operations";
import { authorizeCompanyRead, type AuthenticatedPrincipal } from "../company/authorization";
import { canonicalJsonSha256 } from "../company/commands/fingerprint";
import { ValidationCommandError } from "../company/commands/errors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { ACCOUNTING_READ_ROLES } from "./posting-policy";

const ZERO = BigInt(0);
const DEPOSIT_CATEGORIES = ["security_deposit", "refundable_pet_deposit"];

interface Totals {
  charges: bigint; chargeCount: number; credits: bigint;
  tenant: bigint; subsidy: bigint; other: bigint; receiptCount: number;
  depositReceipts: bigint; depositsReceived: bigint; depositsHeld: bigint;
  reversals: bigint; reversalOfReceipts: bigint; reversalOfCharges: bigint;
  debit: bigint; credit: bigint; voided: number; pending: number; unknown: number;
}

function empty(): Totals {
  return { charges: ZERO, chargeCount: 0, credits: ZERO, tenant: ZERO, subsidy: ZERO, other: ZERO, receiptCount: 0, depositReceipts: ZERO, depositsReceived: ZERO, depositsHeld: ZERO, reversals: ZERO, reversalOfReceipts: ZERO, reversalOfCharges: ZERO, debit: ZERO, credit: ZERO, voided: 0, pending: 0, unknown: 0 };
}

function add(target: Totals, source: Totals): void {
  target.charges += source.charges; target.chargeCount += source.chargeCount; target.credits += source.credits;
  target.tenant += source.tenant; target.subsidy += source.subsidy; target.other += source.other; target.receiptCount += source.receiptCount;
  target.depositReceipts += source.depositReceipts; target.depositsReceived += source.depositsReceived; target.depositsHeld += source.depositsHeld;
  target.reversals += source.reversals; target.reversalOfReceipts += source.reversalOfReceipts; target.reversalOfCharges += source.reversalOfCharges;
  target.debit += source.debit; target.credit += source.credit; target.voided += source.voided; target.pending += source.pending; target.unknown += source.unknown;
}

function finish(totals: Totals): BridgeControlTotals {
  const c = (value: bigint): MoneyCents => centsFromBigInt(value);
  const receipts = totals.tenant + totals.subsidy + totals.other;
  // A reversed receipt re-opens the receivable; a reversed charge closes it.
  const net = totals.charges - totals.credits - receipts + totals.reversalOfReceipts - totals.reversalOfCharges + totals.debit - totals.credit;
  return {
    chargesCents: c(totals.charges), chargeCount: totals.chargeCount, creditsCents: c(totals.credits),
    receipts: { tenantCents: c(totals.tenant), subsidyCents: c(totals.subsidy), otherCents: c(totals.other), totalCents: c(receipts), count: totals.receiptCount },
    depositReceiptsCents: c(totals.depositReceipts), depositsReceivedCents: c(totals.depositsReceived), depositsHeldAtEndCents: c(totals.depositsHeld),
    reversalsCents: c(totals.reversals), adjustments: { debitCents: c(totals.debit), creditCents: c(totals.credit) },
    netReceivableChangeCents: c(net), excludedVoidedCount: totals.voided, excludedPendingCount: totals.pending, excludedUnknownCount: totals.unknown,
  };
}

function big(value: unknown): bigint {
  if (value === null || value === undefined) return ZERO;
  const text = String(value);
  if (!/^-?\d+$/.test(text)) throw new ValidationCommandError("Rental ledger returned an invalid amount", { reason: "invalid_rental_amount" });
  return BigInt(text);
}

function day(value: string, offset: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

async function policyStatus(executor: RentOpsQueryExecutor, organizationId: string, legalEntityId: string, periodStart: string, periodEnd: string): Promise<{ method: RentalPostingMethod | null; status: RentalBridgePreview["status"]; reason: string | null }> {
  const rows = await executor.query<{ method: RentalPostingMethod; effective_from: unknown; effective_until: unknown }>(
    `SELECT method, effective_from, effective_until FROM accounting_rental_posting_policies
      WHERE organization_id = $1 AND legal_entity_id = $2 AND effective_from <= $4::date AND (effective_until IS NULL OR effective_until > $3::date)
      ORDER BY effective_from`,
    [organizationId, legalEntityId, periodStart, periodEnd],
  );
  if (!rows.rows.length) return { method: null, status: "no_policy", reason: "No rental accounting method is set for this entity and period." };
  const toDate = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : value === null || value === undefined ? null : String(value).slice(0, 10);
  const first = rows.rows[0]!;
  const covers = rows.rows.length === 1 && toDate(first.effective_from)! <= periodStart && (toDate(first.effective_until) === null || toDate(first.effective_until)! > periodEnd);
  if (!covers) return { method: rows.rows.length === 1 ? first.method : null, status: "mixed_policy", reason: "The rental accounting method changes inside this period. Preview each side of the cutoff separately." };
  if (first.method !== "summary_bridge") {
    return { method: first.method, status: "method_conflict", reason: first.method === "native_receivables" ? "This entity posts rental activity as native QuickBooks receivables; a summary bridge would double count it." : "Rental activity for this entity is not posted to QuickBooks." };
  }
  return { method: first.method, status: "ready", reason: null };
}

/**
 * Periodic summary-bridge preview for one entity and period, built from the
 * rental ledger with explicit control totals. Preview/export only: this
 * never prepares or posts a QuickBooks entry.
 */
export async function previewRentalBridge(executor: RentOpsQueryExecutor, principal: AuthenticatedPrincipal, input: { organizationId: string; legalEntityId: string; periodStart: string; periodEnd: string }, now: () => Date = () => new Date()): Promise<RentalBridgePreview> {
  const query = rentalBridgePreviewQuerySchema.parse(input);
  authorizeCompanyRead(principal, { organizationId: query.organizationId, legalEntityId: query.legalEntityId }, ACCOUNTING_READ_ROLES);
  const entity = await executor.query<{ currency: string }>(`SELECT currency FROM company_legal_entities WHERE organization_id = $1 AND id = $2`, [query.organizationId, query.legalEntityId]);
  if (!entity.rows[0]) throw new ValidationCommandError("Legal entity was not found in this company", { reason: "legal_entity_not_found" });
  const policy = await policyStatus(executor, query.organizationId, query.legalEntityId, query.periodStart, query.periodEnd);
  const mappings = await executor.query<{ property_id: string; property_name: string | null; effective_from: unknown; effective_until: unknown }>(
    `SELECT m.property_id, p.name AS property_name, m.effective_from, m.effective_until
       FROM company_property_entity_periods m JOIN rent_ops_properties p ON p.id = m.property_id
      WHERE m.organization_id = $1 AND m.legal_entity_id = $2 AND m.effective_from <= $4::date AND (m.effective_until IS NULL OR m.effective_until > $3::date)
      ORDER BY m.property_id, m.effective_from`,
    [query.organizationId, query.legalEntityId, query.periodStart, query.periodEnd],
  );
  const toDate = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : value === null || value === undefined ? null : String(value).slice(0, 10);
  const byProperty = new Map<string, { name: string | null; totals: Totals }>();
  for (const mapping of mappings.rows) {
    const from = [query.periodStart, toDate(mapping.effective_from)!].sort().at(-1)!;
    const until = toDate(mapping.effective_until);
    const through = until === null ? query.periodEnd : [query.periodEnd, day(until, -1)].sort()[0]!;
    if (through < from) continue;
    const ledger = await executor.query<Record<string, unknown>>(
      `SELECT t.kind, t.category, t.status, t.payer, t.adjustment_direction, o.kind AS reversed_kind, o.category AS reversed_category,
              COUNT(*) AS count, COUNT(*) FILTER (WHERE t.amount_cents IS NULL) AS unknown_amounts,
              COALESCE(SUM(t.amount_cents), 0)::bigint::text AS amount
         FROM rent_ops_ledger_transactions t
         LEFT JOIN rent_ops_ledger_transactions o ON o.id = t.reversal_of_id
        WHERE t.property_id = $1 AND t.posted_on BETWEEN $2::date AND $3::date
        GROUP BY t.kind, t.category, t.status, t.payer, t.adjustment_direction, o.kind, o.category`,
      [mapping.property_id, from, through],
    );
    const totals = empty();
    for (const row of ledger.rows) {
      const amount = big(row.amount);
      const rows = Number(row.count ?? 0);
      if (row.status === "voided") { totals.voided += rows; continue; }
      if (row.status === "pending") { totals.pending += rows; continue; }
      // Unknown status, category, amount or reversal target: excluded and reported, never counted as zero.
      if (row.status !== "posted" || row.category === null || row.category === undefined || (row.kind === "reversal" && !row.reversed_kind)) { totals.unknown += rows; continue; }
      const unknownAmounts = Number(row.unknown_amounts ?? 0);
      totals.unknown += unknownAmounts;
      const count = rows - unknownAmounts;
      if (count === 0) continue;
      const category = String(row.category);
      const deposit = DEPOSIT_CATEGORIES.includes(category);
      switch (row.kind) {
        case "charge": if (!deposit) { totals.charges += amount; totals.chargeCount += count; } break;
        case "credit": totals.credits += amount; break;
        case "payment":
          if (deposit) totals.depositReceipts += amount;
          else if (row.payer === "agency" || category === "subsidy") { totals.subsidy += amount; totals.receiptCount += count; }
          else if (row.payer === "tenant") { totals.tenant += amount; totals.receiptCount += count; }
          else { totals.other += amount; totals.receiptCount += count; }
          break;
        case "reversal":
          totals.reversals += amount;
          if (row.reversed_kind === "payment" && !DEPOSIT_CATEGORIES.includes(String(row.reversed_category))) totals.reversalOfReceipts += amount;
          else if (row.reversed_kind === "charge" && !DEPOSIT_CATEGORIES.includes(String(row.reversed_category))) totals.reversalOfCharges += amount;
          break;
        case "adjustment": if (row.adjustment_direction === "debit") totals.debit += amount; else totals.credit += amount; break;
        default: break;
      }
    }
    const deposits = await executor.query<{ received: unknown; held: unknown }>(
      `SELECT COALESCE(SUM(amount_held_cents) FILTER (WHERE received_on BETWEEN $2::date AND $3::date), 0)::bigint::text AS received,
              COALESCE(SUM(amount_held_cents) FILTER (WHERE received_on <= $3::date AND (disposition_status = 'held' OR disposed_on > $3::date)), 0)::bigint::text AS held
         FROM rent_ops_security_deposits WHERE property_id = $1`,
      [mapping.property_id, from, through],
    );
    totals.depositsReceived += big(deposits.rows[0]?.received);
    // Held deposits are a point-in-time balance; take it once per property at the latest mapped day.
    totals.depositsHeld = big(deposits.rows[0]?.held);
    const entry = byProperty.get(mapping.property_id) ?? { name: mapping.property_name, totals: empty() };
    const held = totals.depositsHeld;
    totals.depositsHeld = ZERO;
    add(entry.totals, totals);
    entry.totals.depositsHeld = held;
    byProperty.set(mapping.property_id, entry);
  }
  const overall = empty();
  for (const entry of Array.from(byProperty.values())) add(overall, entry.totals);
  const properties = Array.from(byProperty.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([propertyId, entry]) => ({ propertyId, propertyName: entry.name, controlTotals: finish(entry.totals) }));
  const controlTotals = finish(overall);
  const fingerprint = canonicalJsonSha256({ organizationId: query.organizationId, legalEntityId: query.legalEntityId, periodStart: query.periodStart, periodEnd: query.periodEnd, method: policy.method, controlTotals, byProperty: properties });
  const incomplete = policy.status === "ready" && overall.unknown > 0;
  return rentalBridgePreviewSchema.parse({
    organizationId: query.organizationId, legalEntityId: query.legalEntityId, periodStart: query.periodStart, periodEnd: query.periodEnd,
    currency: entity.rows[0].currency, postingMethod: policy.method,
    status: incomplete ? "incomplete_source" : policy.status,
    reason: incomplete ? `${overall.unknown} rental ledger entr${overall.unknown === 1 ? "y has" : "ies have"} an unknown amount, status or category and are excluded from these totals.` : policy.reason,
    controlTotals, byProperty: properties, fingerprint, generatedAt: now().toISOString(),
  });
}

const CSV_COLUMNS: readonly [string, (totals: BridgeControlTotals) => string | number][] = [
  ["charges_cents", totals => totals.chargesCents], ["charge_count", totals => totals.chargeCount], ["credits_cents", totals => totals.creditsCents],
  ["tenant_receipts_cents", totals => totals.receipts.tenantCents], ["subsidy_receipts_cents", totals => totals.receipts.subsidyCents],
  ["other_receipts_cents", totals => totals.receipts.otherCents], ["receipts_total_cents", totals => totals.receipts.totalCents],
  ["deposit_receipts_cents", totals => totals.depositReceiptsCents], ["deposits_received_cents", totals => totals.depositsReceivedCents],
  ["deposits_held_at_end_cents", totals => totals.depositsHeldAtEndCents], ["reversals_cents", totals => totals.reversalsCents],
  ["adjustment_debits_cents", totals => totals.adjustments.debitCents], ["adjustment_credits_cents", totals => totals.adjustments.creditCents],
  ["net_receivable_change_cents", totals => totals.netReceivableChangeCents], ["excluded_voided", totals => totals.excludedVoidedCount], ["excluded_pending", totals => totals.excludedPendingCount],
  ["excluded_unknown", totals => totals.excludedUnknownCount],
];

function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  // Neutralize spreadsheet formulas and quote separators.
  const safe = /^[=+\-@\t\r]/.test(text) && !/^-\d+$/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Deterministic CSV export of a preview (cents, no floating point). */
export function rentalBridgePreviewCsv(preview: RentalBridgePreview): string {
  const header = ["scope", "property_id", "property_name", ...CSV_COLUMNS.map(([name]) => name)];
  const rows = [
    ["entity", "", "", ...CSV_COLUMNS.map(([, read]) => read(preview.controlTotals))],
    ...preview.byProperty.map(property => ["property", property.propertyId, property.propertyName ?? "", ...CSV_COLUMNS.map(([, read]) => read(property.controlTotals))]),
  ];
  const meta = [`# 5Central Ops rental summary bridge preview`, `# entity ${preview.legalEntityId} period ${preview.periodStart}..${preview.periodEnd} currency ${preview.currency} status ${preview.status} fingerprint ${preview.fingerprint}`, "# Preview only; nothing was posted to QuickBooks."];
  return [...meta, header.join(","), ...rows.map(row => row.map(cell => csvCell(cell as string | number)).join(","))].join("\n") + "\n";
}
