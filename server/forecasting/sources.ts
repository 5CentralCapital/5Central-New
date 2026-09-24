import { legacyNumberToCents } from "../../shared/company";
import { OPENING_ITEM_LABELS, type OpeningItemKey } from "../../shared/forecasting/assumptions";
import type { ForecastOpeningItem } from "../../shared/forecasting/result";
import type { DelinquencyRow } from "../../shared/rent-ops-contracts";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { RentOpsService } from "../rent-ops/services/service";
import { RentOpsInvariantError } from "../rent-ops/domain/invariants";
import type { ForecastSourceData } from "./engine";

/**
 * Reads the actual opening position for a forecast from existing company
 * services, as of the actuals cutoff. Every item carries an as-of date and a
 * completeness state; an item without a supported source is `unknown` (never
 * zero) and must be supplied as an approved opening-balance override.
 */
export interface ForecastSourceReader {
  read(input: { organizationId: string; asOf: string; debtIds: readonly string[]; today: string }): Promise<ForecastSourceData>;
}

const unknownItem = (key: OpeningItemKey, source: string, note?: string): ForecastOpeningItem => ({
  key, label: OPENING_ITEM_LABELS[key], amountCents: null, asOf: null, state: "unknown", source, sourceIds: [], ...(note ? { note } : {}),
});

async function mappedProperties(executor: RentOpsQueryExecutor, organizationId: string, asOf: string): Promise<string[]> {
  const result = await executor.query<{ property_id: string }>(
    `SELECT DISTINCT property_id FROM company_property_entity_periods
      WHERE organization_id = $1 AND effective_from <= $2::date AND (effective_until IS NULL OR effective_until > $2::date)
      ORDER BY property_id`,
    [organizationId, asOf],
  );
  return result.rows.map(row => row.property_id);
}

/** Held at the cutoff: still held, or disposed only after it. */
const HELD_AT_CUTOFF = "(disposition_status = 'held' OR disposed_on > $2::date)";

export async function depositsHeld(executor: RentOpsQueryExecutor, properties: readonly string[], asOf: string): Promise<ForecastOpeningItem> {
  if (!properties.length) return unknownItem("deposits_held", "No properties are mapped to this company at the cutoff");
  // Imported deposits can lack a receipt date or a held amount (a negative
  // source balance). Those are excluded and flagged, never counted as zero.
  const result = await executor.query<{ held: string | null; partial: string; undated: string; unknown_amount: string; count: string }>(
    `SELECT sum(amount_held_cents) FILTER (WHERE received_on <= $2::date AND ${HELD_AT_CUTOFF})::text AS held,
            count(*) FILTER (WHERE received_on <= $2::date AND disposition_status = 'partially_disposed' AND disposed_on <= $2::date)::text AS partial,
            count(*) FILTER (WHERE received_on IS NULL AND ${HELD_AT_CUTOFF})::text AS undated,
            count(*) FILTER (WHERE amount_held_cents IS NULL AND received_on <= $2::date AND ${HELD_AT_CUTOFF})::text AS unknown_amount,
            count(*) FILTER (WHERE received_on <= $2::date)::text AS count
       FROM rent_ops_security_deposits
      WHERE property_id = ANY($1::varchar[])`,
    [properties, asOf],
  );
  const row = result.rows[0];
  const partial = Number(row?.partial ?? 0);
  const undated = Number(row?.undated ?? 0);
  const unknownAmount = Number(row?.unknown_amount ?? 0);
  const notes = [
    partial > 0 ? `${partial} partially disposed deposit(s) have no remaining amount recorded and are excluded.` : null,
    undated > 0 ? `${undated} held deposit(s) have no receipt date and are excluded.` : null,
    unknownAmount > 0 ? `${unknownAmount} deposit(s) have no held amount recorded and are excluded.` : null,
  ].filter((note): note is string => note !== null);
  return {
    key: "deposits_held", label: OPENING_ITEM_LABELS.deposits_held, amountCents: row?.held ?? "0", asOf, state: notes.length ? "partial" : "sourced",
    source: "Rental security deposit records", sourceIds: [`rent_ops_security_deposits:${row?.count ?? 0}`],
    ...(notes.length ? { note: notes.join(" ") } : {}),
  };
}

async function rentalReceivables(executor: RentOpsQueryExecutor, properties: readonly string[], asOf: string, today: string): Promise<ForecastOpeningItem> {
  if (!properties.length) return unknownItem("rental_receivables", "No properties are mapped to this company at the cutoff");
  const service = new RentOpsService(new PostgresRentOpsRepository(executor, true));
  let rows: DelinquencyRow[];
  try {
    rows = await service.report("delinquency", { propertyIds: [...properties] }) as DelinquencyRow[];
  } catch (error) {
    // Rental data that fails its own invariants is not a balance; surface it.
    if (error instanceof RentOpsInvariantError) return unknownItem("rental_receivables", "Rental balances could not be derived", error.message.slice(0, 300));
    throw error;
  }
  let total = BigInt(0);
  let incomplete = 0;
  for (const row of rows) {
    if (row.totalBalanceCents === null || row.totalBalanceCents === undefined || row.balanceComplete === false) { incomplete += 1; continue; }
    if (row.totalBalanceCents > 0) total += BigInt(legacyNumberToCents(row.totalBalanceCents));
  }
  const notes: string[] = [];
  if (incomplete) notes.push(`${incomplete} tenant balance(s) are unresolved and excluded.`);
  if (today !== asOf) notes.push(`Rental balances are current balances as of ${today}, not balances at the cutoff.`);
  return {
    key: "rental_receivables", label: OPENING_ITEM_LABELS.rental_receivables, amountCents: total.toString(), asOf: today,
    state: notes.length ? "partial" : "sourced", source: "Rental delinquency balances", sourceIds: [`rent_ops_delinquency:${rows.length}`],
    ...(notes.length ? { note: notes.join(" ") } : {}),
  };
}

async function pmHeldFunds(executor: RentOpsQueryExecutor, organizationId: string, asOf: string): Promise<ForecastOpeningItem> {
  const result = await executor.query<{ id: string; closing_held_cents: string; period_end: string }>(
    `SELECT DISTINCT ON (property_id, manager_name) id, closing_held_cents::text AS closing_held_cents, period_end::text AS period_end
       FROM accounting_pm_settlements
      WHERE organization_id = $1 AND state = 'reconciled' AND period_end <= $2::date
      ORDER BY property_id, manager_name, period_end DESC, id`,
    [organizationId, asOf],
  );
  if (!result.rows.length) return unknownItem("pm_held_funds", "No reconciled property-manager settlements at the cutoff");
  const total = result.rows.reduce((sum, row) => sum + BigInt(row.closing_held_cents), BigInt(0));
  const oldest = result.rows.reduce((min, row) => (row.period_end < min ? row.period_end : min), asOf);
  return {
    key: "pm_held_funds", label: OPENING_ITEM_LABELS.pm_held_funds, amountCents: total.toString(), asOf: oldest,
    state: oldest < asOf ? "partial" : "sourced", source: "Reconciled property-manager settlements", sourceIds: result.rows.map(row => `accounting_pm_settlements:${row.id}`),
    ...(oldest < asOf ? { note: `The latest reconciled settlement ends ${oldest}; activity after it is not included.` } : {}),
  };
}

async function investorObligations(executor: RentOpsQueryExecutor, organizationId: string, asOf: string): Promise<ForecastOpeningItem> {
  const instruments = await executor.query<{ count: string }>(`SELECT count(*)::text AS count FROM company_investor_instruments WHERE organization_id = $1 AND archived_at IS NULL`, [organizationId]);
  if (Number(instruments.rows[0]?.count ?? 0) === 0) return unknownItem("investor_obligations", "No investor records");
  const result = await executor.query<{ unpaid: string | null; incomplete: string; count: string }>(
    `WITH eligible_obligations AS (
       SELECT o.*, ROW_NUMBER() OVER (PARTITION BY o.contract_id,o.period_month ORDER BY v.effective_from DESC,o.id DESC) AS version_rank
         FROM company_investor_obligations o
         JOIN company_investor_contract_versions v ON v.organization_id=o.organization_id AND v.contract_id=o.contract_id AND v.id=o.contract_version_id
        WHERE o.organization_id = $1 AND v.status IN ('active','superseded','expired')
          AND o.due_on >= v.effective_from AND (v.effective_to IS NULL OR o.due_on < v.effective_to)
     ), paid AS (
       SELECT o.contract_id, o.period_month, sum(a.allocated_cents) AS allocated
         FROM company_investor_payment_allocations a
         JOIN company_investor_payments p ON p.organization_id = a.organization_id AND p.id = a.payment_id
         JOIN company_investor_obligations o ON o.organization_id = a.organization_id AND o.id = a.obligation_id
         JOIN company_investor_contract_versions pv ON pv.organization_id=o.organization_id AND pv.contract_id=o.contract_id AND pv.id=o.contract_version_id
        WHERE a.organization_id = $1 AND pv.status IN ('active','superseded','expired')
          -- The selected obligation enforces the effective interval. Payment
          -- history also needs superseded rows whose allocations were made
          -- before an amendment replaced that period.
          AND p.status <> 'reversed' AND p.payment_on <= $2::date
          AND NOT EXISTS (
            SELECT 1 FROM company_investor_payments reversal
             WHERE reversal.organization_id=p.organization_id AND reversal.reverses_payment_id=p.id AND reversal.payment_on <= $2::date
          )
        GROUP BY o.contract_id, o.period_month)
       SELECT sum(GREATEST(o.total_expected_cents - COALESCE(paid.allocated, 0), 0)) FILTER (WHERE o.amount_complete)::text AS unpaid,
            count(*) FILTER (WHERE NOT o.amount_complete)::text AS incomplete,
            count(*)::text AS count
       FROM eligible_obligations o
       LEFT JOIN paid ON paid.contract_id = o.contract_id AND paid.period_month = o.period_month
      WHERE o.version_rank=1 AND o.due_on <= $2::date`,
    [organizationId, asOf],
  );
  const row = result.rows[0];
  const incomplete = Number(row?.incomplete ?? 0);
  return {
    key: "investor_obligations", label: OPENING_ITEM_LABELS.investor_obligations, amountCents: row?.unpaid ?? "0", asOf,
    state: incomplete > 0 ? "partial" : "sourced", source: "Investor obligations less allocated payments", sourceIds: [`company_investor_obligations:${row?.count ?? 0}`],
    ...(incomplete > 0 ? { note: `${incomplete} obligation(s) due by the cutoff have incomplete amounts and are excluded.` } : {}),
  };
}

async function projectCommitments(executor: RentOpsQueryExecutor, organizationId: string, asOf: string): Promise<ForecastOpeningItem> {
  const result = await executor.query<{ committed: string | null; count: string }>(
    `SELECT sum(c.committed_cents)::text AS committed, count(*)::text AS count
       FROM company_project_commitments c
       JOIN company_projects p ON p.organization_id = c.organization_id AND p.id = c.project_id
      WHERE c.organization_id = $1 AND c.status = 'approved' AND p.archived_at IS NULL AND c.created_at::date <= $2::date`,
    [organizationId, asOf],
  );
  const row = result.rows[0];
  if (Number(row?.count ?? 0) === 0) return unknownItem("project_commitments", "No approved project commitments");
  return {
    key: "project_commitments", label: OPENING_ITEM_LABELS.project_commitments, amountCents: row?.committed ?? "0", asOf, state: "partial",
    source: "Approved project commitments", sourceIds: [`company_project_commitments:${row?.count ?? 0}`],
    note: "Gross approved commitments; invoiced amounts are not netted. Disclosed only; remaining project cost comes from project assumptions.",
  };
}

async function debtBalances(executor: RentOpsQueryExecutor, organizationId: string, debtIds: readonly string[]): Promise<ForecastSourceData["debtBalances"]> {
  if (!debtIds.length) return {};
  const result = await executor.query<{ id: string; outstanding: string | null }>(
    `SELECT id, outstanding_principal_cents::text AS outstanding FROM company_investor_debt
      WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND archived_at IS NULL ORDER BY id`,
    [organizationId, [...debtIds]],
  );
  return Object.fromEntries(result.rows.map(row => [row.id, { principalCents: row.outstanding, sourceIds: [`company_investor_debt:${row.id}`] }]));
}

/** Database-backed reader over the rental, PM settlement, investor and project records. */
export function createForecastSourceReader(executor: RentOpsQueryExecutor): ForecastSourceReader {
  return {
    async read({ organizationId, asOf, debtIds, today }) {
      const properties = await mappedProperties(executor, organizationId, asOf);
      const ledger = "QuickBooks balance-sheet reads are not connected; enter an approved opening balance";
      const items: ForecastOpeningItem[] = [
        unknownItem("cash_operating", ledger),
        unknownItem("cash_restricted", ledger),
        await rentalReceivables(executor, properties, asOf, today),
        await pmHeldFunds(executor, organizationId, asOf),
        unknownItem("accounts_payable", ledger),
        await depositsHeld(executor, properties, asOf),
        await investorObligations(executor, organizationId, asOf),
        await projectCommitments(executor, organizationId, asOf),
      ];
      return { items, debtBalances: await debtBalances(executor, organizationId, debtIds) };
    },
  };
}
