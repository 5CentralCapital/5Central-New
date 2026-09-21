import { z } from 'zod';

const ReportKeySchema = z.enum(['rent-roll', 'occupancy', 'scheduled-income', 'collected-income', 'scheduled-vs-collected', 'delinquency', 'tenant-ledger', 'lease-expiration', 'security-deposit', 'applicant-pipeline', 'hap']);
const McpReportSchema = z.enum(['rent-roll', 'occupancy', 'scheduled-income', 'collected-income', 'scheduled-vs-collected', 'delinquency', 'tenant-ledger', 'lease-expirations', 'deposits', 'applicant-pipeline', 'hap']);
const EntrySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  title: z.string().min(1),
  category: z.enum(['financial', 'rental', 'tasks', 'projects', 'investors', 'forecast']),
  period: z.enum(['as_of', 'range', 'month', 'custom']),
  availability: z.enum(['available', 'planned']),
  source: z.enum(['rental', 'quickbooks', 'combined', 'company']),
  reportKey: ReportKeySchema.optional(),
  mcpReport: McpReportSchema.optional(),
  reason: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
  requiredSources: z.array(z.string().min(1)).min(1),
}).strict().superRefine((entry, context) => {
  if (entry.availability === 'available' && (!entry.reportKey || !entry.mcpReport)) context.addIssue({ code: 'custom', message: 'Available reports require both transport mappings.' });
  if (entry.availability === 'planned' && (entry.reportKey || entry.mcpReport || !entry.reason)) context.addIssue({ code: 'custom', message: 'Planned reports require a reason and cannot advertise executable mappings.' });
});
export const ReportCatalogSchema = z.object({ schemaVersion: z.literal(1), reports: z.array(EntrySchema) }).strict().superRefine((catalog, context) => {
  if (new Set(catalog.reports.map(report => report.id)).size !== catalog.reports.length) context.addIssue({ code: 'custom', message: 'Report IDs must be unique.' });
});
export type ReportCatalog = z.infer<typeof ReportCatalogSchema>;
export type ReportCatalogEntry = ReportCatalog['reports'][number];

const available = (id: z.infer<typeof ReportKeySchema>, title: string, period: ReportCatalogEntry['period'], mcpReport: z.infer<typeof McpReportSchema>): ReportCatalogEntry => ({ id, title, category: 'rental', period, availability: 'available', source: 'rental', reportKey: id, mcpReport, requiredSources: ['rental_operational_records'] });
const planned = (id: string, title: string, category: ReportCatalogEntry['category'], period: ReportCatalogEntry['period'], source: ReportCatalogEntry['source'], requiredSources: string[]): ReportCatalogEntry => ({ id, title, category, period, availability: 'planned', source, requiredSources, reason: 'report_not_implemented' });
const financial = (id: string, title: string, period: ReportCatalogEntry['period'] = 'range', combined = false): ReportCatalogEntry => planned(id, title, 'financial', period, combined ? 'combined' : 'quickbooks', combined ? ['verified_quickbooks_books', 'approved_operational_mappings'] : ['verified_quickbooks_books']);
const rental = (id: string, title: string, period: ReportCatalogEntry['period'] = 'as_of'): ReportCatalogEntry => planned(id, title, 'rental', period, 'rental', ['rental_operational_records']);
const task = (id: string, title: string, period: ReportCatalogEntry['period']): ReportCatalogEntry => planned(id, title, 'tasks', period, 'company', ['company_task_work_order_records']);

// Discovery metadata only. Availability does not bypass runtime scope/permission checks
// or assert completeness/freshness of any specific report result.
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
    planned('rental-owner-ending-balances', 'Rental owner ending balances', 'investors', 'as_of', 'combined', ['verified_quickbooks_books', 'effective_owner_agreements']),
    planned('rental-owner-statement', 'Rental owner statement', 'investors', 'range', 'combined', ['verified_quickbooks_books', 'effective_owner_agreements']),
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
    planned('contractor-exposure', 'Contractor exposure', 'projects', 'as_of', 'combined', ['verified_quickbooks_books', 'approved_commitments']),
    planned('project-performance', 'Project performance', 'projects', 'range', 'combined', ['verified_quickbooks_books', 'approved_project_budgets']),
    planned('rehab-benchmark', 'Rehab benchmark', 'projects', 'range', 'combined', ['verified_completed_costs', 'approved_scope_quantities']),
    planned('cash-position', 'Cash position', 'financial', 'as_of', 'combined', ['verified_quickbooks_books', 'bank_observations', 'cash_reconciliation']),
    planned('cash-forecast-13-week', '13-week cash forecast', 'forecast', 'custom', 'combined', ['verified_actuals', 'versioned_forecast_inputs']),
    planned('operating-growth-plan', 'Operating and growth plan', 'forecast', 'custom', 'combined', ['verified_actuals', 'versioned_forecast_inputs']),
    planned('debt-refinance', 'Debt and refinance', 'forecast', 'custom', 'combined', ['verified_quickbooks_books', 'debt_agreements', 'versioned_forecast_inputs']),
    planned('exit-scenarios', 'Exit scenarios', 'forecast', 'custom', 'combined', ['verified_actuals', 'versioned_forecast_inputs']),
    planned('investor-owner-activity', 'Investor and owner activity', 'investors', 'range', 'combined', ['verified_quickbooks_books', 'effective_owner_agreements']),
    planned('lender-management-package', 'Lender and management package', 'financial', 'custom', 'combined', ['verified_book_reports', 'rental_operational_records', 'required_templates']),
    available('scheduled-income', 'Scheduled income', 'month', 'scheduled-income'),
    available('scheduled-vs-collected', 'Scheduled vs collected', 'month', 'scheduled-vs-collected'),
    available('collected-income', 'Collected income', 'range', 'collected-income'),
    available('hap', 'Housing assistance', 'month', 'hap'),
    available('applicant-pipeline', 'Applicant pipeline', 'as_of', 'applicant-pipeline'),
  ],
};

/** Returns an independently validated copy; callers cannot mutate shared metadata. */
export function getReportCatalog(): ReportCatalog { return ReportCatalogSchema.parse(catalog); }
