import { z } from 'zod';
import {
  getReportFilterDefinition,
  McpReportSchema,
  ReportFilterDefinitionsSchema,
  ReportFilterNameSchema,
  ReportKeySchema,
} from './report-filter-definitions';

export { McpReportSchema, ReportFilterDefinitionSchema, ReportFilterDefinitionsSchema, ReportFilterNameSchema, ReportKeySchema } from './report-filter-definitions';
export type { McpReportKey, ReportFilterDefinition, ReportFilterName, ReportKey } from './report-filter-definitions';
const EntrySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  title: z.string().min(1),
  category: z.enum(['financial', 'rental', 'tasks', 'projects', 'investors', 'forecast']),
  period: z.enum(['as_of', 'range', 'month', 'custom']),
  /**
   * Transport only, never runtime capability: `available` reports also run
   * through the legacy rental report routes; `company_service` reports run
   * only through the company reporting service, whose catalog reports the
   * live status (available / missing data or connection / not implemented).
   */
  availability: z.enum(['available', 'company_service']),
  source: z.enum(['rental', 'quickbooks', 'combined', 'company']),
  reportKey: ReportKeySchema.optional(),
  mcpReport: McpReportSchema.optional(),
  /** Optional for parsing cached schema-v1 catalogs; current factory entries always include it. */
  filters: ReportFilterDefinitionsSchema.optional(),
  reason: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
  requiredSources: z.array(z.string().min(1)).min(1),
}).strict().superRefine((entry, context) => {
  if (entry.availability === 'available' && (!entry.reportKey || !entry.mcpReport)) context.addIssue({ code: 'custom', message: 'Available reports require both transport mappings.' });
  if (entry.availability === 'company_service' && (entry.reportKey || entry.mcpReport || entry.filters || !entry.reason)) context.addIssue({ code: 'custom', message: 'Company-service reports require a reason and cannot advertise legacy rental transport mappings.' });
});
export const ReportCatalogSchema = z.object({ schemaVersion: z.literal(1), reports: z.array(EntrySchema) }).strict().superRefine((catalog, context) => {
  if (new Set(catalog.reports.map(report => report.id)).size !== catalog.reports.length) context.addIssue({ code: 'custom', message: 'Report IDs must be unique.' });
});
export type ReportCatalog = z.infer<typeof ReportCatalogSchema>;
export type ReportCatalogEntry = ReportCatalog['reports'][number];

const available = (id: z.infer<typeof ReportKeySchema>, title: string, period: ReportCatalogEntry['period'], mcpReport: z.infer<typeof McpReportSchema>): ReportCatalogEntry => ({ id, title, category: 'rental', period, availability: 'available', source: 'rental', reportKey: id, mcpReport, filters: getReportFilterDefinition(id)!, requiredSources: ['rental_operational_records'] });
const companyService = (id: string, title: string, category: ReportCatalogEntry['category'], period: ReportCatalogEntry['period'], source: ReportCatalogEntry['source'], requiredSources: string[]): ReportCatalogEntry => ({ id, title, category, period, availability: 'company_service', source, requiredSources, reason: 'runtime_status_in_company_catalog' });
const financial = (id: string, title: string, period: ReportCatalogEntry['period'] = 'range', combined = false): ReportCatalogEntry => companyService(id, title, 'financial', period, combined ? 'combined' : 'quickbooks', combined ? ['verified_quickbooks_books', 'approved_operational_mappings'] : ['verified_quickbooks_books']);
const rental = (id: string, title: string, period: ReportCatalogEntry['period'] = 'as_of'): ReportCatalogEntry => companyService(id, title, 'rental', period, 'rental', ['rental_operational_records']);
const task = (id: string, title: string, period: ReportCatalogEntry['period']): ReportCatalogEntry => companyService(id, title, 'tasks', period, 'company', ['company_task_work_order_records']);

// Discovery metadata only. The transport marker does not bypass runtime
// scope/permission checks or assert completeness/freshness of any result; the
// company reporting catalog (/api/company/:org/reporting/catalog) reports the
// runtime capability of each of the 53 reports.
const catalog: ReportCatalog = {
  schemaVersion: 1,
  reports: [
    financial('balance-sheet-by-fund-type', 'Balance sheet by fund type', 'as_of', true),
    financial('balance-sheet-consolidated', 'Balance sheet consolidated', 'as_of', true),
    financial('budget-vs-actual', 'Budget vs actual', 'range', true),
    financial('general-ledger', 'General ledger'),
    financial('general-ledger-consolidated', 'General ledger consolidated', 'range', true),
    financial('income-statement', 'Income statement'),
    financial('income-statement-by-unit', 'Income statement by unit', 'range', true),
    financial('income-statement-consolidated', 'Income statement consolidated', 'range', true),
    financial('income-statement-detailed', 'Income statement detailed'),
    financial('property-statement', 'Property statement', 'range', true),
    companyService('rental-owner-ending-balances', 'Rental owner ending balances', 'investors', 'as_of', 'combined', ['verified_quickbooks_books', 'effective_owner_agreements']),
    companyService('rental-owner-statement', 'Rental owner statement', 'investors', 'range', 'combined', ['verified_quickbooks_books', 'effective_owner_agreements']),
    financial('trial-balance', 'Trial balance', 'as_of'),
    financial('trial-balance-consolidated', 'Trial balance consolidated', 'as_of', true),
    rental('current-tenants', 'Current tenants'),
    available('delinquency', 'Delinquent tenants', 'as_of', 'delinquency'),
    available('lease-expiration', 'Leases ending', 'as_of', 'lease-expirations'),
    rental('leasing-agent', 'Leasing agent', 'range'),
    rental('rent-paid', 'Rent paid', 'range'),
    available('rent-roll', 'Rent roll', 'as_of', 'rent-roll'),
    rental('renters-insurance', 'Renters insurance'),
    available('security-deposit', 'Security deposit and liabilities', 'as_of', 'deposits'),
    available('tenant-ledger', 'Tenant statement', 'range', 'tenant-ledger'),
    rental('tenant-vehicles', 'Tenant vehicles'),
    rental('unit-listings', 'Unit listings'),
    available('occupancy', 'Occupancy & vacancy', 'as_of', 'occupancy'),
    task('completed-tasks', 'Completed tasks', 'range'),
    task('open-tasks', 'Open tasks', 'as_of'),
    task('tasks-performance', 'Tasks performance', 'range'),
    task('vendor-details', 'Vendor details', 'custom'),
    task('work-orders', 'Work orders', 'custom'),
    task('work-sessions', 'Work Sessions', 'range'),
    financial('balance-sheet', 'Balance sheet', 'as_of'),
    financial('cash-flow-statement', 'Cash-flow statement'),
    financial('portfolio-financials', 'Portfolio financials', 'custom', true),
    financial('property-t12', 'Property T12', 'range', true),
    financial('accounts-receivable', 'Accounts receivable', 'as_of', true),
    financial('accounts-payable', 'Accounts payable', 'as_of'),
    companyService('contractor-exposure', 'Contractor exposure', 'projects', 'as_of', 'combined', ['verified_quickbooks_books', 'approved_commitments']),
    companyService('project-performance', 'Project performance', 'projects', 'range', 'combined', ['verified_quickbooks_books', 'approved_project_budgets']),
    companyService('rehab-benchmark', 'Rehab benchmark', 'projects', 'range', 'combined', ['verified_completed_costs', 'approved_scope_quantities']),
    companyService('cash-position', 'Cash position', 'financial', 'as_of', 'combined', ['verified_quickbooks_books', 'bank_observations', 'cash_reconciliation']),
    companyService('cash-forecast-13-week', '13-week cash forecast', 'forecast', 'custom', 'combined', ['verified_actuals', 'versioned_forecast_inputs']),
    companyService('operating-growth-plan', 'Operating and growth plan', 'forecast', 'custom', 'combined', ['verified_actuals', 'versioned_forecast_inputs']),
    companyService('debt-refinance', 'Debt and refinance', 'forecast', 'custom', 'combined', ['verified_quickbooks_books', 'debt_agreements', 'versioned_forecast_inputs']),
    companyService('exit-scenarios', 'Exit scenarios', 'forecast', 'custom', 'combined', ['verified_actuals', 'versioned_forecast_inputs']),
    companyService('investor-owner-activity', 'Investor and owner activity', 'investors', 'range', 'combined', ['verified_quickbooks_books', 'effective_owner_agreements']),
    companyService('lender-management-package', 'Lender and management package', 'financial', 'custom', 'combined', ['verified_book_reports', 'rental_operational_records', 'required_templates']),
    available('scheduled-income', 'Scheduled income', 'month', 'scheduled-income'),
    available('scheduled-vs-collected', 'Scheduled vs collected', 'month', 'scheduled-vs-collected'),
    available('collected-income', 'Collected income', 'range', 'collected-income'),
    available('hap', 'Housing assistance', 'month', 'hap'),
    available('applicant-pipeline', 'Applicant pipeline', 'as_of', 'applicant-pipeline'),
  ],
};

/** Returns an independently validated copy; callers cannot mutate shared metadata. */
export function getReportCatalog(): ReportCatalog {
  const parsed = ReportCatalogSchema.parse(catalog);
  if (parsed.reports.some((report) => report.availability === 'available' && !report.filters?.length)) {
    throw new Error('Available report catalog entries require filter definitions.');
  }
  return parsed;
}
