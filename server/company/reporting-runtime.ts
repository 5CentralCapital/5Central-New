import type { FixedReportName, RentOpsFilters } from '../../shared/rent-ops-contracts';
import { isoDateSchema, legalEntityIdSchema, propertyReferenceIdSchema } from '../../shared/company';
import type { ReportRunRequest, ReportingEngineContext } from '../../shared/reporting';
import type { AccountingServices } from '../accounting';
import {
  createQuickBooksReportingEngine, createRentalReportingEngine, createReportingRegistry,
  createCompanyDomainReportingEngines,
  PostgresReportingStore, ReportingError, ReportingService,
  type ForecastReportingReadPort, type ReportingAccess, type ReportingEngine, type ReportingPort,
} from '../reporting';
import { createMirrorCombinedFinancialReadPort, type ConsolidationMappingReadPort } from '../reporting/ports/mirror-financial';
import { createPostgresReportReferenceReader } from '../reporting/ports/references';
import { resolveRentalPropertyIds } from '../reporting/ports/scope';
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from '../rent-ops/repositories/postgres';
import { RentOpsService } from '../rent-ops/services/service';
import { authorizeCompanyRead, loadAuthenticatedPrincipal, type AuthenticatedPrincipal } from './authorization';
import { ProjectReadService } from '../projects/service';
import { createProjectFinanceReadPort } from '../projects/execution';
import { createProjectFinanceBindingStore } from '../projects/execution-store';
import { InvestorReadService } from '../investors/service';
import { createTransactionBoundTimeReadPort } from '../time/service';

const READ_ROLES = ['owner', 'admin', 'finance', 'operations_pm', 'project_manager', 'read_only_reviewer'] as const;

function periodBounds(period: ReportRunRequest['period']): { from: string; through: string } {
  if (period.mode === 'as_of') return { from: period.asOfDate, through: period.asOfDate };
  if (period.mode === 'range') return { from: period.fromDate, through: period.toDate };
  if (period.mode === 'month' || period.month) {
    const month = period.month!;
    const [year, number] = month.split('-').map(Number);
    return { from: `${month}-01`, through: `${month}-${String(new Date(Date.UTC(year, number, 0)).getUTCDate()).padStart(2, '0')}` };
  }
  const from = period.fromDate ?? period.asOfDate;
  const through = period.toDate ?? period.asOfDate;
  if (!from || !through) throw new ReportingError('report_validation', 'Choose a reporting period.', 400);
  return { from: isoDateSchema.parse(from), through: isoDateSchema.parse(through) };
}

/** Never turn an empty authorized property set into the rental reader's all-properties filter. */
async function readScopedRental(
  executor: RentOpsQueryExecutor, principal: AuthenticatedPrincipal,
  context: ReportingEngineContext, name: FixedReportName, filters: RentOpsFilters,
): Promise<unknown[]> {
  const { request } = context;
  const period = periodBounds(request.period);
  const filterProperties = filters.propertyIds?.length ? filters.propertyIds : filters.propertyId ? [filters.propertyId] : [];
  if (request.scope.propertyIds.length && filterProperties.some(id => !request.scope.propertyIds.includes(id as typeof request.scope.propertyIds[number]))) {
    throw new ReportingError('report_validation', 'Property filters must stay within the selected report scope.', 400);
  }
  let properties: string[];
  if (!filterProperties.length) {
    properties = [...await resolveRentalPropertyIds({ executor, principal }, context)];
  } else {
    const mappings = await executor.query<{ property_id: string; legal_entity_id: string; covers_period: boolean }>(
      `SELECT property_id,legal_entity_id,
        effective_from <= $2::date AND (effective_until IS NULL OR effective_until > $3::date) AS covers_period
        FROM company_property_entity_periods
        WHERE organization_id=$1 AND effective_from <= $3::date
          AND (effective_until IS NULL OR effective_until > $2::date)
          AND (cardinality($4::uuid[])=0 OR legal_entity_id=ANY($4::uuid[]))
          AND property_id=ANY($5::varchar[])`,
      [request.scope.organizationId, period.from, period.through, request.scope.legalEntityIds, filterProperties],
    );
    if (mappings.rows.some(row => !row.covers_period)) {
      throw new ReportingError('report_unavailable', 'A property changed entities during this period. Choose a period within one ownership interval.', 409);
    }
    properties = Array.from(new Set(mappings.rows.map(row => row.property_id)));
    for (const row of mappings.rows) authorizeCompanyRead(principal, {
      organizationId: principal.organizationId,
      legalEntityId: legalEntityIdSchema.parse(row.legal_entity_id), propertyId: propertyReferenceIdSchema.parse(row.property_id),
    }, READ_ROLES);
    if (filterProperties.some(id => !properties.includes(id))) throw new ReportingError('report_forbidden', 'A selected property is outside the company reporting period.', 403);
  }
  if (!properties.length) return [];
  const service = new RentOpsService(new PostgresRentOpsRepository(executor, true));
  return service.report(name, { ...filters, propertyId: undefined, propertyIds: properties });
}

export interface CompanyReportingPortOptions {
  /**
   * Versioned forecast scenario reader supplied by the forecasting service
   * (`createForecastReportingReadPort(transaction, { principal })`). The
   * factory receives the request's freshly loaded principal so forecast
   * authorization applies. Without it, the four forecast reports report
   * "No approved forecast scenario."
   */
  readonly forecastPort?: ForecastReportingReadPort | ((transaction: RentOpsQueryExecutor, principal: AuthenticatedPrincipal) => ForecastReportingReadPort);
  /** Approved canonical account mapping and eliminations for consolidated reports. */
  readonly consolidationPort?: ConsolidationMappingReadPort | ((transaction: RentOpsQueryExecutor) => ConsolidationMappingReadPort);
}

function resolveFactory<T>(value: T | ((transaction: RentOpsQueryExecutor) => T) | undefined, transaction: RentOpsQueryExecutor): T | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'function' ? (value as (transaction: RentOpsQueryExecutor) => T)(transaction) : value;
}

/** Compose domain reports with the same database and provider authority used by other company features. */
export function createCompanyReportingPort(executor: RentOpsQueryExecutor, accounting: AccountingServices, options: CompanyReportingPortOptions = {}): ReportingPort {
  const environment = accounting.qbo.status === 'configured' ? accounting.qbo.environment : null;

  function registry(transaction: RentOpsQueryExecutor, principal: AuthenticatedPrincipal) {
    const rental = createRentalReportingEngine({ report: async () => { throw new ReportingError('report_forbidden', 'Report access is required.', 403); } });
    const scopedRental: ReportingEngine = { ...rental, reportIds: [...rental.reportIds], run: async (context: ReportingEngineContext) => createRentalReportingEngine({ report: (name, filters = {}) => readScopedRental(transaction, principal, context, name, filters) }).run(context) };
    const connectionProbe = new Map<string, Promise<number>>();
    const qboEngine = createQuickBooksReportingEngine({
      ready: accounting.qbo.status === 'configured',
      reason: accounting.qbo.status === 'configured' ? undefined : 'Connect QuickBooks to run financial statements.',
      async resolveConnectionScope(organizationId, legalEntityId) {
        if (accounting.qbo.status !== 'configured') throw new ReportingError('report_unavailable', 'QuickBooks is not configured.', 409);
        const result = await transaction.query<{ realm_id: string }>(
          `SELECT realm_id FROM accounting_qbo_connections
           WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND revoked_at IS NULL`,
          [organizationId, legalEntityId, accounting.qbo.environment],
        );
        if (result.rows.length !== 1) throw new ReportingError('report_unavailable', 'This legal entity has no active QuickBooks connection.', 409, { dependency: 'verified_quickbooks_connection' });
        return { organizationId, legalEntityId, environment: accounting.qbo.environment, realmId: result.rows[0].realm_id };
      },
      createClient(scope) {
        if (accounting.qbo.status !== 'configured') throw new ReportingError('report_unavailable', 'QuickBooks is not configured.', 409);
        return accounting.qbo.createReportsClient(scope);
      },
    });
    const qbo: ReportingEngine = {
      ...qboEngine, reportIds: [...qboEngine.reportIds], dependency: 'verified_quickbooks_connection',
      async probe({ organizationId }) {
        if (environment === null) return { status: 'missing_data', reason: 'Connect QuickBooks to run financial statements.', dependency: 'verified_quickbooks_connection' };
        let count = connectionProbe.get(organizationId);
        if (!count) {
          count = transaction.query<{ count: string | number }>(`SELECT count(*)::text AS count FROM accounting_qbo_connections WHERE organization_id=$1 AND environment=$2 AND revoked_at IS NULL`, [organizationId, environment]).then(result => Number(result.rows[0]?.count ?? 0));
          connectionProbe.set(organizationId, count);
        }
        return await count ? { status: 'available' } : { status: 'missing_data', reason: 'No legal entity has an active QuickBooks connection.', dependency: 'verified_quickbooks_connection' };
      },
    };
    const mirror = accounting.mirror.forExecutor(transaction);
    const combinedFinancial = createMirrorCombinedFinancialReadPort({ executor: transaction, principal, environment, mirror, consolidation: resolveFactory(options.consolidationPort, transaction) });
    const domainEngines = createCompanyDomainReportingEngines({
      executor: transaction, principal,
      projectService: new ProjectReadService(transaction, createProjectFinanceReadPort(mirror, createProjectFinanceBindingStore(transaction), mirror)),
      investorService: new InvestorReadService(transaction, { sourceRead: mirror }),
      timeRead: createTransactionBoundTimeReadPort(transaction),
      domainPorts: { combinedFinancial, forecast: typeof options.forecastPort === 'function' ? options.forecastPort(transaction, principal) : options.forecastPort }, // forecasting: principal-bound
    });
    return createReportingRegistry({ engines: [scopedRental, qbo, ...domainEngines] });
  }

  async function within<T>(access: ReportingAccess, readOnly: boolean, work: (service: ReportingService, fresh: ReportingAccess) => Promise<T>): Promise<T> {
    if (!executor.transaction) throw new ReportingError('report_unavailable', 'Reporting requires a database transaction.', 503);
    return executor.transaction(async transaction => {
      const principal = await loadAuthenticatedPrincipal(transaction, {
        actorId: access.principal.actorId, organizationId: access.principal.organizationId, role: access.principal.role,
      });
      const fresh: ReportingAccess = {
        principal,
        async resolvePropertyLegalEntity(propertyId, requestedPeriod) {
          if (!requestedPeriod) return null;
          const period = periodBounds(requestedPeriod);
          const result = await transaction.query<{ legal_entity_id: string }>(
            `SELECT DISTINCT legal_entity_id FROM company_property_entity_periods
             WHERE organization_id=$1 AND property_id=$2
               AND effective_from <= $3::date
               AND (effective_until IS NULL OR effective_until > $4::date)`,
            [principal.organizationId, propertyId, period.from, period.through],
          );
          return result.rows.length === 1 ? result.rows[0].legal_entity_id : null;
        },
      };
      const service = new ReportingService({ registry: registry(transaction, principal), store: new PostgresReportingStore(transaction), references: createPostgresReportReferenceReader({ executor: transaction, environment, consolidation: resolveFactory(options.consolidationPort, transaction) }) });
      return work(service, fresh);
    }, { readOnly });
  }

  return {
    catalog: access => {
      if (!access) return Promise.resolve(createReportingRegistry().listEntries());
      return within(access, true, (service, fresh) => service.catalog(fresh));
    },
    references: (access, input) => within(access, true, (service, fresh) => service.references(fresh, input)),
    run: (access, input) => within(access, false, (service, fresh) => service.run(fresh, input)),
    page: (access, input) => within(access, true, (service, fresh) => service.page(fresh, input)),
    drilldown: (access, input) => within(access, true, (service, fresh) => service.drilldown(fresh, input)),
    createExport: (access, input) => within(access, false, (service, fresh) => service.createExport(fresh, input)),
    getExport: (access, id) => within(access, true, (service, fresh) => service.getExport(fresh, id)),
    savePreset: (access, input) => within(access, false, (service, fresh) => service.savePreset(fresh, input)),
    listPresets: access => within(access, true, (service, fresh) => service.listPresets(fresh)),
    getPreset: (access, id) => within(access, true, (service, fresh) => service.getPreset(fresh, id)),
    savePackage: (access, input) => within(access, false, (service, fresh) => service.savePackage(fresh, input)),
    listPackages: access => within(access, true, (service, fresh) => service.listPackages(fresh)),
    getPackage: (access, id) => within(access, true, (service, fresh) => service.getPackage(fresh, id)),
    runPackage: (access, id) => within(access, false, (service, fresh) => service.runPackage(fresh, id)),
    getPackageRun: (access, id) => within(access, true, (service, fresh) => service.getPackageRun(fresh, id)),
  };
}
