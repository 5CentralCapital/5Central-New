import { reportPeriodSchema, reportRunCompleteness, reportRunRecordSchema, type ReportPeriod } from "../../../shared/reporting";
import type { AuthenticatedPrincipal } from "../../company/authorization";
import type { RentOpsQueryExecutor } from "../../rent-ops/repositories/postgres";
import type { LenderPackageReadPort, LenderPackageReadResult } from "../lender-package-engine";

/** Required sections of the lender/management package, in presentation order. */
export const LENDER_PACKAGE_TEMPLATE = [
  { section: "balance_sheet", title: "Balance sheet", reportId: "balance-sheet", period: "as_of" },
  { section: "income_statement", title: "Income statement", reportId: "income-statement", period: "range" },
  { section: "property_t12", title: "Property T12", reportId: "property-t12", period: "range" },
  { section: "rent_roll", title: "Rent roll", reportId: "rent-roll", period: "as_of" },
  { section: "delinquency", title: "Delinquent tenants", reportId: "delinquency", period: "as_of" },
  { section: "owner_statement", title: "Rental owner statement", reportId: "rental-owner-statement", period: "range" },
] as const;
export const LENDER_PACKAGE_TEMPLATE_VERSION = "lender-package.v1";

function periodTargets(period: ReportPeriod): { asOf: string | null; from: string | null; to: string | null } {
  if (period.mode === "as_of") return { asOf: period.asOfDate, from: null, to: null };
  if (period.mode === "range") return { asOf: period.toDate, from: period.fromDate, to: period.toDate };
  if (period.mode === "month") return { asOf: null, from: null, to: null };
  return { asOf: period.toDate ?? period.asOfDate ?? null, from: period.fromDate ?? null, to: period.toDate ?? null };
}

/**
 * The package assembles already-run, immutable report snapshots by the same
 * actor. A section is ready only when a matching run exists for the package
 * period and entity scope and that run is complete; nothing is re-run or
 * guessed here.
 */
export function createFrozenRunLenderPackageReadPort(deps: { readonly executor: RentOpsQueryExecutor; readonly principal: AuthenticatedPrincipal }): LenderPackageReadPort {
  return {
    async read({ context }): Promise<LenderPackageReadResult> {
      const request = context.request;
      const targets = periodTargets(request.period);
      const entities = new Set(request.scope.legalEntityIds.map(String));
      const result = await deps.executor.query<{ id: string; payload: unknown; row_count: string | number }>(
        `SELECT run.id, run.payload, (SELECT count(*) FROM company_report_run_rows r WHERE r.run_id = run.id)::text AS row_count
           FROM company_report_runs run
          WHERE run.organization_id=$1 AND run.actor_id=$2 AND run.state='ready' AND run.report_id = ANY($3::text[])
            AND (run.expires_at IS NULL OR run.expires_at > $4::timestamptz)
          ORDER BY run.generated_at DESC
          LIMIT 500`,
        [request.scope.organizationId, deps.principal.actorId, LENDER_PACKAGE_TEMPLATE.map(item => item.reportId), context.now],
      );
      const runs = result.rows.flatMap(row => {
        const parsed = reportRunRecordSchema.safeParse(typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload);
        return parsed.success ? [{ run: parsed.data, rowCount: Number(row.row_count) }] : [];
      });
      const sections = LENDER_PACKAGE_TEMPLATE.map(template => {
        const candidates = runs.filter(({ run }) => {
          if (run.reportId !== template.reportId) return false;
          const period = reportPeriodSchema.parse(run.period);
          const periodMatches = template.period === "as_of"
            ? period.mode === "as_of" && targets.asOf !== null && period.asOfDate === targets.asOf
            : period.mode === "range" && targets.from !== null && targets.to !== null && period.fromDate === targets.from && period.toDate === targets.to;
          const runEntities = run.scope.legalEntityIds.map(String);
          const entityMatches = runEntities.length > 0 && runEntities.every(id => entities.has(id));
          return periodMatches && entityMatches;
        });
        const selected = candidates[0];
        if (!selected) return { section: template.section, title: template.title, reportId: template.reportId, runId: "", rowCount: 0, state: "unavailable" as const, reason: `Run ${template.title} for this period and these entities first.` };
        const coveredEntities = new Set(candidates.flatMap(candidate => candidate.run.scope.legalEntityIds.map(String)));
        const complete = reportRunCompleteness(selected.run) === "complete" && Array.from(entities).every(id => coveredEntities.has(id));
        const reason = complete ? null : Array.from(entities).some(id => !coveredEntities.has(id)) ? `${template.title} does not cover every selected entity.` : `${template.title} has incomplete source coverage.`;
        return { section: template.section, title: template.title, reportId: template.reportId, runId: selected.run.id, rowCount: selected.rowCount, state: complete ? "ready" as const : "partial" as const, reason };
      });
      const ready = sections.filter(section => section.state === "ready").length;
      const found = sections.filter(section => section.state !== "unavailable").length;
      return {
        sections,
        coverage: {
          state: found === 0 ? "unavailable" : ready === sections.length ? "complete" : "partial",
          evidence: "reproducible_snapshot",
          watermark: LENDER_PACKAGE_TEMPLATE_VERSION,
          reason: found === 0 ? "No saved report runs match this package period and entity scope." : ready === sections.length ? null : `${sections.length - ready} of ${sections.length} package sections are missing or incomplete.`,
        },
      };
    },
  };
}
