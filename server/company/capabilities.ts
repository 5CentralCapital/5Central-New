import type { RentOpsQueryExecutor } from '../rent-ops/repositories/postgres';
import { readCompanyContext } from './context';
import { loadAuthenticatedPrincipal } from './authorization';
import type { ReportingPort } from '../reporting';
import type { ReviewCasePort } from '../review-cases/port';
import { organizationIdSchema } from '../../shared/company/identifiers';

/**
 * Small, bounded discovery entry point so an agent can find the organization,
 * the modules that work right now and the right workflow without guessing
 * among ~200 tools. Each probe is independent; a failing probe reports
 * "unavailable" with its reason rather than failing the whole read.
 */
export const OPS_WORKFLOW_GUIDE = [
  { intent: 'Find a tenant, unit, lease or property', tools: ['search', 'fetch', 'get_tenant', 'get_unit'] },
  { intent: 'Rental reports (rent roll, delinquency, collections)', tools: ['get_report_catalog', 'get_report'] },
  { intent: 'Company and financial reports, presets, packages', tools: ['list_company_reports', 'list_company_report_references', 'run_company_report', 'get_company_report_page', 'export_company_report'] },
  { intent: 'Resolve data exceptions', tools: ['list_review_cases', 'get_review_case', 'run_review_detection', 'get_review_inventory'] },
  { intent: 'QuickBooks connection, sync and health', tools: ['get_accounting_connector_health', 'sync_accounting_source', 'get_accounting_coverage'] },
  { intent: 'QuickBooks writes and background jobs', tools: ['submit_qbo_write', 'get_job', 'list_jobs', 'requeue_job', 'cancel_job'] },
  { intent: 'PM statements and settlements', tools: ['list_pm_settlements', 'get_pm_settlement'] },
  { intent: 'MRA owner packets (Codex only)', tools: ['stage_mra_packet', 'map_mra_packet', 'preview_mra_packet', 'apply_mra_packet', 'get_mra_packet'] },
  { intent: 'Projects, budgets, commitments and draws', tools: ['list_projects', 'get_project', 'get_project_execution', 'get_project_cost_report'] },
  { intent: 'Investors, obligations and debt', tools: ['list_investors', 'get_investor', 'list_investor_payment_calendar', 'list_investor_debt_maturities', 'get_investor_instrument_financials'] },
  { intent: 'Forecast scenarios and cash outlook', tools: ['list_forecast_scenarios', 'preview_forecast', 'create_forecast_snapshot', 'compare_forecast_snapshots', 'explain_forecast_line'] },
  { intent: 'Work orders', tools: ['list_work_orders', 'get_work_order', 'create_work_order'] },
  { intent: 'Company documents', tools: ['list_company_documents', 'get_company_document'] },
] as const;

export interface OpsCapabilitiesOptions {
  readonly executor: RentOpsQueryExecutor;
  readonly actorId: string;
  readonly reporting?: ReportingPort;
  readonly reviewCases?: ReviewCasePort;
  readonly toolNames: () => readonly string[];
}

type Probe<T> = { readonly status: 'available'; readonly value: T } | { readonly status: 'unavailable'; readonly reason: string };

async function probe<T>(work: () => Promise<T>): Promise<Probe<T>> {
  try { return { status: 'available', value: await work() }; } catch (error) {
    const message = error instanceof Error ? error.message : 'Unavailable';
    return { status: 'unavailable', reason: message.slice(0, 200) };
  }
}

export async function readOpsCapabilities(options: OpsCapabilitiesOptions, organizationId?: string) {
  const context = await readCompanyContext(options.executor, options.actorId, 'admin');
  const organizations = context.organizations.filter(item => !organizationId || item.id === organizationId).slice(0, 10);
  const registered = new Set(options.toolNames());
  const details = [];
  for (const organization of organizations) {
    const principal = () => loadAuthenticatedPrincipal(options.executor, { actorId: options.actorId, organizationId: organization.id, role: 'admin' });
    const reports = options.reporting ? await probe(async () => {
      const entries = await options.reporting!.catalog({ principal: await principal() } as Parameters<ReportingPort['catalog']>[0]);
      const counts: Record<string, number> = {};
      for (const entry of entries) counts[entry.runtimeStatus] = (counts[entry.runtimeStatus] ?? 0) + 1;
      return { total: entries.length, byStatus: counts };
    }) : { status: 'unavailable' as const, reason: 'Reporting is not configured.' };
    const review = options.reviewCases ? await probe(async () => {
      const inventory = await options.reviewCases!.inventory(await principal(), { scope: { organizationId: organizationIdSchema.parse(organization.id) }, limit: 5 });
      return { ...inventory.totals, topReasons: inventory.byReason.slice(0, 5) };
    }) : { status: 'unavailable' as const, reason: 'Review cases are not configured.' };
    details.push({
      organizationId: organization.id,
      name: organization.name,
      legalEntities: organization.entities.length,
      properties: organization.entities.reduce((total, entity) => total + (entity.properties?.length ?? 0), 0),
      reports,
      reviewCases: review,
    });
  }
  return {
    product: '5Central Ops',
    organizations: details,
    organizationsTruncated: context.organizations.length > organizations.length && !organizationId,
    workflows: OPS_WORKFLOW_GUIDE.map(item => ({ intent: item.intent, tools: item.tools.filter(name => registered.has(name)) })).filter(item => item.tools.length > 0),
    conventions: {
      money: 'Integer cents encoded as decimal strings or integers; an unknown amount is null, never 0.',
      writes: 'Company commands take an envelope with operationId, idempotencyKey and expectedRevision. Retry an uncertain save with the same operationId and idempotencyKey.',
      paging: 'List and report reads are bounded; follow nextCursor to continue.',
      accounting: 'QuickBooks is the accounting authority. Queued, posted and bank-settled are different states.',
    },
  };
}
