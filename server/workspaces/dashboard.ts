import type { DashboardCompany } from "../../shared/workspaces/contracts";
import { addDays } from "./period";
import { authorizedEntities, authorizedPropertyMappings, centsValue, organizationWide, type WorkspaceReadContext } from "./access";

const OBLIGATION_LIMIT = 25;
const WORK_LIMIT = 25;

/**
 * Compact company rows for the manager dashboard. Unknown amounts stay null;
 * obligations with unknown components expose only their known minimum.
 * Paid is the signed sum of payment allocations to the obligation — the same
 * rule the investor pages use — so a reversal (negative allocations) nets its
 * original to zero and unapplied overpayment is not counted.
 */
export async function readDashboardCompany(context: WorkspaceReadContext, asOf: string): Promise<DashboardCompany> {
  const organizationId = context.principal.organizationId;
  const entities = (await authorizedEntities(context)).map(entity => entity.id);
  const through = addDays(asOf, 30);
  const obligations = entities.length ? await context.executor.query<{
    id: string; account_id: string; account_name: string; instrument_name: string; due_on: string; currency: string;
    total_expected_cents: unknown; known_minimum_cents: unknown; amount_complete: boolean; paid_cents: unknown;
  }>(
    `SELECT o.id, o.account_id, a.display_name AS account_name, i.name AS instrument_name, o.due_on::text AS due_on, o.currency,
            o.total_expected_cents, o.known_minimum_cents, o.amount_complete,
            coalesce((SELECT sum(a.allocated_cents) FROM company_investor_payment_allocations a
                       WHERE a.organization_id = o.organization_id AND a.obligation_id = o.id), 0)::text AS paid_cents
       FROM company_investor_obligations o
       JOIN company_investor_accounts a ON a.organization_id = o.organization_id AND a.id = o.account_id
       JOIN company_investor_instruments i ON i.organization_id = o.organization_id AND i.id = o.instrument_id
      WHERE o.organization_id = $1 AND o.legal_entity_id = ANY($2::uuid[]) AND o.due_on BETWEEN $3::date AND $4::date
      ORDER BY o.due_on, a.display_name, o.id LIMIT ${OBLIGATION_LIMIT + 1}`,
    [organizationId, entities, asOf, through],
  ) : { rows: [] };
  const maturities = entities.length ? await context.executor.query<{
    instrument_id: string; account_id: string; account_name: string; instrument_name: string; maturity_on: string; currency: string; outstanding_principal_cents: unknown; balloon_cents: unknown;
  }>(
    `SELECT i.id AS instrument_id, i.account_id, a.display_name AS account_name, i.name AS instrument_name, coalesce(d.maturity_on, i.maturity_on)::text AS maturity_on,
            i.currency, d.outstanding_principal_cents, d.balloon_cents
       FROM company_investor_instruments i
       JOIN company_investor_accounts a ON a.organization_id = i.organization_id AND a.id = i.account_id
       LEFT JOIN company_investor_debt d ON d.organization_id = i.organization_id AND d.instrument_id = i.id AND d.archived_at IS NULL
      WHERE i.organization_id = $1 AND i.legal_entity_id = ANY($2::uuid[]) AND i.status IN ('active','draft')
        AND coalesce(d.maturity_on, i.maturity_on) BETWEEN $3::date AND $4::date
      ORDER BY coalesce(d.maturity_on, i.maturity_on), a.display_name, i.id LIMIT 25`,
    [organizationId, entities, asOf, addDays(asOf, 180)],
  ) : { rows: [] };

  const mappings = await authorizedPropertyMappings(context, asOf);
  const propertyIds = Array.from(mappings.keys());
  const work = propertyIds.length ? await context.executor.query<{
    id: string; title: string; property_id: string; property_name: string | null; unit_id: string | null; unit_number: string | null;
    priority: string; status: string; scheduled_on: string | null; reported_on: string; open_count: unknown;
  }>(
    `SELECT w.id, w.title, w.property_id, p.name AS property_name, w.unit_id, u.unit_number, w.priority, w.status,
            w.scheduled_on::text AS scheduled_on, w.reported_on::text AS reported_on, count(*) OVER () AS open_count
       FROM company_work_orders w
       LEFT JOIN rent_ops_properties p ON p.id = w.property_id
       LEFT JOIN rent_ops_units u ON u.id = w.unit_id
      WHERE w.organization_id = $1 AND w.property_id = ANY($2::text[]) AND w.status NOT IN ('completed','canceled')
        AND (w.scheduled_on <= $3::date OR (w.scheduled_on IS NULL AND w.priority IN ('emergency','high')))
      ORDER BY w.scheduled_on NULLS FIRST, CASE w.priority WHEN 'emergency' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, w.reported_on, w.id
      LIMIT ${WORK_LIMIT}`,
    [organizationId, propertyIds, addDays(asOf, 14)],
  ) : { rows: [] };

  // Review cases (migration 045). The panel is hidden when the table cannot be
  // read; a savepoint keeps that failure from aborting the surrounding snapshot.
  let reviewCases: DashboardCompany["reviewCases"] = { available: false, openCount: 0, topReasons: [] };
  await context.executor.query("SAVEPOINT workspace_dashboard_review_cases");
  try {
    const orgWide = organizationWide(context.principal);
    const { rows } = await context.executor.query<{ reason_code: string; count: unknown; high: unknown }>(
      `SELECT reason_code, count(*) AS count, count(*) FILTER (WHERE materiality = 'high') AS high
         FROM company_review_cases
        WHERE organization_id = $1 AND state NOT IN ('applied','verified')
          AND ($2::boolean OR legal_entity_id = ANY($3::uuid[]))
        GROUP BY reason_code ORDER BY count(*) DESC, reason_code LIMIT 50`,
      [organizationId, orgWide, entities],
    );
    const counts = rows.map(row => ({ reasonCode: row.reason_code, count: Number(row.count), highMaterialityCount: Number(row.high) }));
    reviewCases = { available: true, openCount: counts.reduce((total, row) => total + row.count, 0), topReasons: counts.slice(0, 5) };
    await context.executor.query("RELEASE SAVEPOINT workspace_dashboard_review_cases");
  } catch {
    await context.executor.query("ROLLBACK TO SAVEPOINT workspace_dashboard_review_cases");
  }

  return {
    asOf,
    obligations: {
      items: obligations.rows.slice(0, OBLIGATION_LIMIT).map(row => ({
        obligationId: row.id, accountId: row.account_id, accountName: row.account_name, instrumentName: row.instrument_name, dueOn: row.due_on, currency: row.currency,
        expectedCents: row.amount_complete ? centsValue(row.total_expected_cents)?.toString() ?? null : null,
        knownMinimumCents: centsValue(row.known_minimum_cents)!.toString(),
        paidCents: centsValue(row.paid_cents)!.toString(),
        amountComplete: row.amount_complete === true,
      })),
      truncated: obligations.rows.length > OBLIGATION_LIMIT,
    },
    maturities: maturities.rows.map(row => ({
      instrumentId: row.instrument_id, accountId: row.account_id, accountName: row.account_name, instrumentName: row.instrument_name, maturityOn: row.maturity_on,
      currency: row.currency, outstandingPrincipalCents: centsValue(row.outstanding_principal_cents)?.toString() ?? null, balloonCents: centsValue(row.balloon_cents)?.toString() ?? null,
    })),
    reviewCases,
    workDue: {
      items: work.rows.map(row => ({
        id: row.id, title: row.title, propertyId: row.property_id, propertyName: row.property_name, unitId: row.unit_id, unitNumber: row.unit_number,
        priority: row.priority, status: row.status, scheduledOn: row.scheduled_on, reportedOn: row.reported_on,
        overdue: row.scheduled_on !== null && row.scheduled_on < asOf,
      })),
      openCount: work.rows.length ? Number(work.rows[0].open_count) : 0,
    },
  };
}

