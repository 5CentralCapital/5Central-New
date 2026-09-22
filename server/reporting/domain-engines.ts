import type { ReportingEngine } from "./registry";
import { createUnavailableReportingEngine } from "./source-engine-utils";
import { createRentalExtendedReportingEngine, createRentalLeasingAgentEngine, type RentalSnapshotReadPort } from "./rental-expanded-engine";
import { createProjectReportingEngine, PROJECT_REPORT_IDS, type ProjectReportingReadPort } from "./project-engine";
import { createInvestorReportingEngine, createUnavailableInvestorOwnerEngine, INVESTOR_REPORT_IDS, type InvestorReportingReadPort } from "./investor-engine";
import { createTimeReportingEngine, TIME_REPORT_IDS, type TimeReportingReadPort } from "./time-engine";
import { createTaskReportingEngine, TASK_REPORT_IDS, createUnavailableWorkOrderEngine } from "./task-engine";
import type { ProjectReportingReadPort as TaskReportingReadPort } from "./project-engine";
import { createForecastReportingEngine, FORECAST_REPORT_IDS, type ForecastReportingReadPort } from "./forecast-engine";
import { createCombinedFinancialReportingEngine, COMBINED_FINANCIAL_REPORT_IDS, PROPERTY_STATEMENT_REPORT_IDS, type CombinedFinancialReadPort } from "./combined-financial-engine";
import { createLenderManagementPackageEngine, type LenderPackageReadPort } from "./lender-package-engine";

export interface ReportingDomainEngineOptions {
  readonly rental?: RentalSnapshotReadPort;
  readonly projects?: ProjectReportingReadPort;
  readonly investors?: InvestorReportingReadPort;
  readonly time?: TimeReportingReadPort;
  readonly tasks?: TaskReportingReadPort;
  readonly forecast?: ForecastReportingReadPort;
  readonly combinedFinancial?: CombinedFinancialReadPort;
  readonly lenderPackage?: LenderPackageReadPort;
  readonly includeUnavailable?: boolean;
}

/**
 * Root company wiring can pass request-scoped ports here without coupling the
 * reporting registry to any one service implementation. Every omitted port
 * becomes a blocked catalog entry with a concrete dependency reason when
 * includeUnavailable is enabled; it is never represented as an empty report.
 */
export function createReportingDomainEngines(options: ReportingDomainEngineOptions = {}): readonly ReportingEngine[] {
  const includeUnavailable = options.includeUnavailable ?? true;
  const engines: ReportingEngine[] = [];
  engines.push(options.rental ? createRentalExtendedReportingEngine(options.rental) : createUnavailableReportingEngine({ key: "rental.operational-expanded", reportIds: RENTAL_EXTENDED_REPORT_IDS, reason: "Rental adjunct records are not registered for this request.", dependency: "rental_operational_records" }));
  engines.push(options.rental ? createRentalLeasingAgentEngine() : createUnavailableReportingEngine({ key: "rental.leasing-agent", reportIds: ["leasing-agent"], reason: "No verified leasing-agent attribution source is registered.", dependency: "agent_attribution" }));
  engines.push(options.projects ? createProjectReportingEngine(options.projects) : createUnavailableReportingEngine({ key: "combined.projects", reportIds: PROJECT_REPORT_IDS, reason: "Project detail, budget, and actual read ports are not registered.", dependency: "company_projects" }));
  engines.push(options.investors ? createInvestorReportingEngine(options.investors) : createUnavailableReportingEngine({ key: "combined.investors", reportIds: INVESTOR_REPORT_IDS, reason: "Investor obligation and payment read ports are not registered.", dependency: "effective_owner_agreements" }));
  engines.push(createUnavailableInvestorOwnerEngine());
  engines.push(options.time ? createTimeReportingEngine(options.time) : createUnavailableReportingEngine({ key: "company.time", reportIds: TIME_REPORT_IDS, reason: "QuickBooks Time read port is not registered.", dependency: "time_entries" }));
  engines.push(options.tasks ? createTaskReportingEngine(options.tasks) : createUnavailableReportingEngine({ key: "company.tasks", reportIds: TASK_REPORT_IDS, reason: "Project task and vendor read ports are not registered.", dependency: "company_task_work_order_records" }));
  engines.push(createUnavailableWorkOrderEngine());
  engines.push(options.forecast ? createForecastReportingEngine(options.forecast) : createUnavailableReportingEngine({ key: "combined.forecast", reportIds: FORECAST_REPORT_IDS, reason: "No versioned forecast scenario reader is registered.", dependency: "versioned_forecast_inputs" }));
  if (options.combinedFinancial) {
    engines.push(createCombinedFinancialReportingEngine(options.combinedFinancial));
    engines.push(createUnavailableReportingEngine({ key: "combined.financial.property-statement", reportIds: PROPERTY_STATEMENT_REPORT_IDS, reason: "Property statement requires a verified property cash statement with opening/closing cash, receipts, disbursements, and reserves.", dependency: "property_cash_statement_source" }));
  } else {
    engines.push(createUnavailableReportingEngine({ key: "combined.financial", reportIds: COMBINED_FINANCIAL_REPORT_IDS, reason: "No accounting mirror and dated allocation reader is registered.", dependency: "verified_quickbooks_books" }));
  }
  engines.push(options.lenderPackage ? createLenderManagementPackageEngine(options.lenderPackage) : createUnavailableReportingEngine({ key: "combined.lender-package", reportIds: ["lender-management-package"], reason: "No book-report and required-template reader is registered.", dependency: "required_templates" }));
  return includeUnavailable ? Object.freeze(engines) : Object.freeze(engines.filter(engine => engine.ready));
}

const RENTAL_EXTENDED_REPORT_IDS = ["current-tenants", "rent-paid", "renters-insurance", "tenant-vehicles", "unit-listings"] as const;

export * from "./combined-financial-engine";
export * from "./forecast-engine";
export * from "./investor-engine";
export * from "./lender-package-engine";
export * from "./project-engine";
export * from "./rental-expanded-engine";
export * from "./task-engine";
export * from "./time-engine";
