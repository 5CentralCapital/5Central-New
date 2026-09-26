import { createAccountingServices, type AccountingServices, type AccountingServicesOptions } from '../accounting';
import type { RentOpsQueryExecutor } from '../rent-ops/repositories/postgres';
import { createCompanyProjectPort } from './project-port';
import type { CompanyProjectPort } from './routes';
import { createInvestorPort, createAccountingInvestorSourceResolver, type InvestorPort } from '../investors';
import { createProjectFinanceReadPort } from '../projects/execution';
import { createProjectFinanceBindingStore } from '../projects/execution-store';
import { createTimeServices, type TimeServices, type TimeServicesOptions } from '../time/service';
import { createCompanyReportingPort } from './reporting-runtime';
import type { ReportingPort } from '../reporting';
import { createWorkOrderPort, type WorkOrderPort } from '../work-orders/port';
import { createCompanyPropertyPort, type CompanyPropertyPort } from './property-port';
import { createCompanyLegalEntityPort, type CompanyLegalEntityPort } from './legal-entity-port';
// lane-b-accounting
import { createJobsPort, type JobsPort } from '../jobs/operator';
// lane-c-review
import type { ContentAddressedObjectStore } from '../rent-ops/storage';
import { createReviewCasePort, type ReviewCasePort } from '../review-cases/port';
import { createIntakePort, type IntakePort } from '../intake/port';
import { createCompanyDocumentsPort, type CompanyDocumentsPort } from '../company-documents/port';
// lane-d-forecast
import { createForecastingPort, type ForecastingPort } from '../forecasting/port';
import { createForecastReportingReadPort } from '../forecasting/reporting-port';
import { createProjectInsightsPort, type ProjectInsightsPort } from '../projects/insights'; // lane-f

/** The browser and Codex share these services and the same company database. */
export interface CompanyServices {
  readonly executor: RentOpsQueryExecutor;
  readonly projects: CompanyProjectPort;
  readonly accounting: AccountingServices;
  readonly investors: InvestorPort;
  readonly time: TimeServices;
  readonly reporting: ReportingPort;
  readonly workOrders: WorkOrderPort;
  readonly properties: CompanyPropertyPort;
  readonly legalEntities: CompanyLegalEntityPort;
  // lane-b-accounting
  readonly jobs: JobsPort;
  // lane-c-review
  readonly reviewCases: ReviewCasePort;
  readonly intake: IntakePort;
  readonly documents: CompanyDocumentsPort;
  readonly forecasting: ForecastingPort; // lane-d-forecast
  readonly projectInsights: ProjectInsightsPort; // lane-f
}

export function createCompanyServices(executor: RentOpsQueryExecutor, options: {
  accounting?: AccountingServicesOptions;
  time?: TimeServicesOptions;
  // lane-c-review: verified private object store for company documents, MRA packets and review evidence.
  documentStorage?: ContentAddressedObjectStore;
} = {}): CompanyServices {
  const accounting = createAccountingServices(executor, options.accounting);
  // lane-f: payroll links and work-order cost links reserve QBO lines through the shared mirror ledger.
  const costFinanceFactory = (transaction: RentOpsQueryExecutor) => {
    const mirror = accounting.mirror.forExecutor(transaction);
    return { source: mirror, allocations: mirror, costContext: mirror };
  };
  const time = createTimeServices(executor, { ...options.time, financeFactory: options.time?.financeFactory ?? costFinanceFactory }); // lane-f
  const investors = createInvestorPort(executor, {
    sourceReadFactory: transaction => accounting.mirror.forExecutor(transaction),
    sourceResolverFactory: transaction => {
      const mirror = accounting.mirror.forExecutor(transaction);
      return createAccountingInvestorSourceResolver({ read: mirror, allocations: mirror, paymentContext: mirror });
    },
  });
  const projects = createCompanyProjectPort(executor, {
    financeFactory: transaction => {
      const mirror = accounting.mirror.forExecutor(transaction);
      return createProjectFinanceReadPort(mirror, createProjectFinanceBindingStore(transaction), mirror);
    },
    commandFinanceFactory: transaction => {
      const mirror = accounting.mirror.forExecutor(transaction);
      return { source: mirror, allocations: mirror, costContext: mirror };
    },
  });
  const reporting = createCompanyReportingPort(executor, accounting, { forecastPort: (transaction, principal) => createForecastReportingReadPort(transaction, { principal }) });
  const workOrders = createWorkOrderPort(executor, { financeFactory: costFinanceFactory }); // lane-f
  // lane-f: project cost report, labor allocation and QBO line picker reads.
  const projectInsights = createProjectInsightsPort(executor, {
    financeFactory: transaction => {
      const mirror = accounting.mirror.forExecutor(transaction);
      return createProjectFinanceReadPort(mirror, createProjectFinanceBindingStore(transaction), mirror);
    },
  });
  const jobs = createJobsPort(executor); // lane-b-accounting
  // lane-c-review
  const reviewCases = createReviewCasePort(executor, { documentStorage: options.documentStorage });
  const intake = createIntakePort(executor, { documentStorage: options.documentStorage });
  const documents = createCompanyDocumentsPort(executor, { documentStorage: options.documentStorage });
  const forecasting = createForecastingPort(executor); // lane-d-forecast
  const properties = createCompanyPropertyPort(executor);
  const legalEntities = createCompanyLegalEntityPort(executor);
  return { executor, accounting, investors, projects, time, reporting, workOrders, properties, legalEntities, jobs, reviewCases, intake, documents, forecasting, projectInsights };
}
