import { isoDateSchema } from "../../../shared/company";
import type { RentOpsQueryExecutor } from "../../rent-ops/repositories/postgres";
import type { AuthenticatedPrincipal } from "../../company/authorization";
import { ReportingError } from "../errors";
import { PM_SETTLEMENT_LINE_KINDS, type PmSettlementLineRecord, type PmSettlementReadPort, type PmSettlementRecord } from "../owner-statement-engine";
import { resolveDatedScopes, scopePredicate } from "./scope";

const MAX_SETTLEMENTS = 5_000;

function dateText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return isoDateSchema.parse(String(value).slice(0, 10));
}

function centsText(value: unknown, field: string): string {
  const text = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(text)) throw new ReportingError("report_unavailable", `Settlement ${field} is not a whole number of cents.`, 409, { dependency: "pm_settlements" });
  return text;
}

/**
 * Read-only port over accounting PM settlements (migration 047). With a
 * `from` date it returns every settlement overlapping [from, through],
 * including ones that start before or end after the period so the engine can
 * flag them; without one it returns settlements ending on or before
 * `through` (known balances as of that date). Rows are
 * limited to the request's dated entity/property scopes and the principal's
 * grants; the SQL never widens an empty scope to the organization.
 */
export function createPostgresPmSettlementReadPort(deps: { readonly executor: RentOpsQueryExecutor; readonly principal: AuthenticatedPrincipal }): PmSettlementReadPort {
  return {
    async hasSettlements(organizationId) {
      const result = await deps.executor.query<{ found: boolean }>(`SELECT EXISTS (SELECT 1 FROM accounting_pm_settlements WHERE organization_id=$1) AS found`, [organizationId]);
      return result.rows[0]?.found === true;
    },
    async read({ context, from, through }) {
      const scopes = await resolveDatedScopes(deps, context);
      const values: unknown[] = [context.request.scope.organizationId, through, from];
      const predicate = scopePredicate(scopes, values, "s.legal_entity_id", "s.property_id");
      values.push(MAX_SETTLEMENTS + 1);
      const result = await deps.executor.query<Record<string, unknown>>(
        `SELECT s.id, s.legal_entity_id, s.property_id, p.name AS property_name, s.manager_name, s.period_start, s.period_end, s.currency,
                s.opening_held_cents::text AS opening_held_cents, s.gross_collections_cents::text AS gross_collections_cents,
                s.pm_fees_cents::text AS pm_fees_cents, s.pm_expenses_cents::text AS pm_expenses_cents,
                s.other_deductions_cents::text AS other_deductions_cents, s.owner_remittance_cents::text AS owner_remittance_cents,
                s.closing_held_cents::text AS closing_held_cents, s.state, s.exception_reason, s.bank_settled_on, s.updated_at
           FROM accounting_pm_settlements s
           JOIN rent_ops_properties p ON p.id = s.property_id
          WHERE s.organization_id=$1
            AND (CASE WHEN $3::date IS NULL THEN s.period_end <= $2::date ELSE s.period_start <= $2::date AND s.period_end >= $3::date END)
            AND ${predicate}
          ORDER BY s.legal_entity_id, s.property_id, s.manager_name, s.period_start, s.id
          LIMIT $${values.length}`,
        values,
      );
      if (result.rows.length > MAX_SETTLEMENTS) throw new ReportingError("report_unavailable", "Too many settlements match; choose fewer properties or a shorter period.", 409, { maxRows: MAX_SETTLEMENTS });
      const ids = result.rows.map(row => String(row.id));
      const lines = ids.length ? await deps.executor.query<Record<string, unknown>>(
        `SELECT settlement_id, line_number, kind, description, amount_cents::text AS amount_cents, occurred_on, unit_id, tenancy_id
           FROM accounting_pm_settlement_lines
          WHERE organization_id=$1 AND settlement_id = ANY($2::uuid[])
          ORDER BY settlement_id, line_number`,
        [context.request.scope.organizationId, ids],
      ) : { rows: [] };
      const linesBySettlement = new Map<string, PmSettlementLineRecord[]>();
      for (const row of lines.rows) {
        const kind = String(row.kind);
        if (!(PM_SETTLEMENT_LINE_KINDS as readonly string[]).includes(kind)) throw new ReportingError("report_unavailable", "A settlement line has an unknown kind.", 409, { dependency: "pm_settlements" });
        const list = linesBySettlement.get(String(row.settlement_id)) ?? [];
        list.push({ lineNumber: Number(row.line_number), kind: kind as PmSettlementLineRecord["kind"], description: String(row.description), amountCents: centsText(row.amount_cents, "line amount"), occurredOn: dateText(row.occurred_on), unitId: row.unit_id === null ? null : String(row.unit_id), tenancyId: row.tenancy_id === null ? null : String(row.tenancy_id) });
        linesBySettlement.set(String(row.settlement_id), list);
      }
      const settlements: PmSettlementRecord[] = result.rows.map(row => ({
        id: String(row.id), legalEntityId: String(row.legal_entity_id), propertyId: String(row.property_id), propertyName: row.property_name === null ? null : String(row.property_name),
        managerName: String(row.manager_name), periodStart: dateText(row.period_start)!, periodEnd: dateText(row.period_end)!, currency: String(row.currency),
        openingHeldCents: centsText(row.opening_held_cents, "opening balance"), grossCollectionsCents: centsText(row.gross_collections_cents, "gross collections"),
        pmFeesCents: centsText(row.pm_fees_cents, "fees"), pmExpensesCents: centsText(row.pm_expenses_cents, "expenses"), otherDeductionsCents: centsText(row.other_deductions_cents, "other deductions"),
        ownerRemittanceCents: centsText(row.owner_remittance_cents, "remittance"), closingHeldCents: centsText(row.closing_held_cents, "closing balance"),
        state: String(row.state) as PmSettlementRecord["state"], exceptionReason: row.exception_reason === null ? null : String(row.exception_reason), bankSettledOn: dateText(row.bank_settled_on),
        lines: linesBySettlement.get(String(row.id)) ?? [],
      }));
      const latest = result.rows.map(row => row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? "")).sort().at(-1) ?? null;
      const unreconciled = settlements.filter(item => item.state !== "reconciled").length;
      return {
        settlements,
        coverage: {
          state: unreconciled ? "partial" : "complete",
          evidence: "reproducible_snapshot",
          watermark: latest,
          reason: unreconciled ? `${unreconciled} settlement${unreconciled === 1 ? " is" : "s are"} not reconciled.` : null,
        },
      };
    },
  };
}
