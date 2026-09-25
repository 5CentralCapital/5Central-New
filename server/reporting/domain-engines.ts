import type { ReportingEngine } from "./registry";
import { createUnavailableReportingEngine } from "./source-engine-utils";
import { createRentalExtendedReportingEngine, createRentalLeasingAgentEngine, RENTAL_EXTENDED_REPORT_IDS, type RentalSnapshotReadPort } from "./rental-expanded-engine";
import { createProjectReportingEngine, PROJECT_REPORT_IDS, type ProjectReportingReadPort } from "./project-engine";
import { createInvestorReportingEngine, INVESTOR_REPORT_IDS, type InvestorReportingReadPort } from "./investor-engine";
import { createTimeReportingEngine, TIME_REPORT_IDS, type TimeReportingReadPort } from "./time-engine";
import { createTaskReportingEngine, TASK_REPORT_IDS } from "./task-engine";
import type { ProjectReportingReadPort as TaskReportingReadPort } from "./project-engine";
import { createForecastReportingEngine, FORECAST_REPORT_IDS, type ForecastReportingReadPort } from "./forecast-engine";
import { createCombinedFinancialReportingEngine, COMBINED_FINANCIAL_REPORT_IDS, type CombinedFinancialReadPort } from "./combined-financial-engine";
import { createLenderManagementPackageEngine, type LenderPackageReadPort } from "./lender-package-engine";
import { createWorkOrderReportingEngine, WORK_ORDER_REPORT_IDS, type WorkOrderReportingReadPort } from "./work-order-engine";
import { createOwnerStatementReportingEngine, OWNER_STATEMENT_REPORT_IDS, type PmSettlementReadPort } from "./owner-statement-engine";
import { createPropertyStatementReportingEngine, PROPERTY_STATEMENT_ENGINE_REPORT_IDS, type PropertyStatementReadPort } from "./property-statement-engine";

export interface ReportingDomainEngineOptions {
  readonly rental?: RentalSnapshotReadPort;
  readonly projects?: ProjectReportingReadPort;
  readonly investors?: InvestorReportingReadPort;
  readonly time?: TimeReportingReadPort;
  readonly tasks?: TaskReportingReadPort;
  readonly workOrders?: WorkOrderReportingReadPort;
  readonly settlements?: PmSettlementReadPort;
  readonly propertyStatement?: PropertyStatementReadPort;
  /** Supplied by the forecasting service (`createForecastReportingReadPort`). */
  readonly forecast?: ForecastReportingReadPort;
  readonly combinedFinancial?: CombinedFinancialReadPort;
  readonly lenderPackage?: LenderPackageReadPort;
  readonly includeUnavailable?: boolean;
}

export const FORECAST_MISSING_REASON = "No approved forecast scenario.";

/**
 * Root company wiring passes request-scoped ports here without coupling the
 * reporting registry to any one service implementation. Every omitted port
 * becomes a "missing data" catalog entry with the exact missing source; it
 * is never represented as an empty report.
 */
export function createReportingDomainEngines(options: ReportingDomainEngineOptions = {}): readonly ReportingEngine[] {
  const includeUnavailable = options.includeUnavailable ?? true;
  const engines: ReportingEngine[] = [];
  engines.push(options.rental ? createRentalExtendedReportingEngine(options.rental) : createUnavailableReportingEngine({ key: "rental.operational-expanded", reportIds: RENTAL_EXTENDED_REPORT_IDS, reason: "Rental records are not connected for this request.", dependency: "rental_operational_records" }));
  engines.push(options.rental ? createRentalLeasingAgentEngine(options.rental) : createUnavailableReportingEngine({ key: "rental.leasing-agent", reportIds: ["leasing-agent"], reason: "Rental applications and activity are not connected for this request.", dependency: "rental_operational_records" }));
  engines.push(options.projects ? createProjectReportingEngine(options.projects) : createUnavailableReportingEngine({ key: "combined.projects", reportIds: PROJECT_REPORT_IDS, reason: "Project records are not connected for this request.", dependency: "company_projects" }));
  engines.push(options.investors ? createInvestorReportingEngine(options.investors) : createUnavailableReportingEngine({ key: "combined.investors", reportIds: INVESTOR_REPORT_IDS, reason: "Investor obligations and payments are not connected for this request.", dependency: "company_investor_obligations_and_payments" }));
  engines.push(options.settlements ? createOwnerStatementReportingEngine(options.settlements) : createUnavailableReportingEngine({ key: "combined.owner-statements", reportIds: OWNER_STATEMENT_REPORT_IDS, reason: "Property-manager settlements are not connected for this request.", dependency: "pm_settlements" }));
  engines.push(options.propertyStatement ? createPropertyStatementReportingEngine(options.propertyStatement) : createUnavailableReportingEngine({ key: "combined.property-statement", reportIds: PROPERTY_STATEMENT_ENGINE_REPORT_IDS, reason: "Rental collections and PM settlements are not connected for this request.", dependency: "property_statement_sources" }));
  engines.push(options.time ? createTimeReportingEngine(options.time) : createUnavailableReportingEngine({ key: "company.time", reportIds: TIME_REPORT_IDS, reason: "QuickBooks Time is not connected.", dependency: "quickbooks_time_entries" }));
  engines.push(options.tasks ? createTaskReportingEngine(options.tasks) : createUnavailableReportingEngine({ key: "company.tasks", reportIds: TASK_REPORT_IDS, reason: "Project tasks are not connected for this request.", dependency: "company_project_tasks" }));
  engines.push(options.workOrders ? createWorkOrderReportingEngine(options.workOrders) : createUnavailableReportingEngine({ key: "company.work-orders", reportIds: WORK_ORDER_REPORT_IDS, reason: "Work orders are not connected for this request.", dependency: "company_work_orders" }));
  engines.push(options.forecast ? createForecastReportingEngine(options.forecast) : createUnavailableReportingEngine({ key: "combined.forecast", reportIds: FORECAST_REPORT_IDS, reason: FORECAST_MISSING_REASON, dependency: "approved_forecast_scenario" }));
  engines.push(options.combinedFinancial ? createCombinedFinancialReportingEngine(options.combinedFinancial) : createUnavailableReportingEngine({ key: "combined.financial", reportIds: COMBINED_FINANCIAL_REPORT_IDS, reason: "The QuickBooks accounting mirror is not connected for this request.", dependency: "quickbooks_accounting_mirror" }));
  engines.push(options.lenderPackage ? createLenderManagementPackageEngine(options.lenderPackage) : createUnavailableReportingEngine({ key: "combined.lender-package", reportIds: ["lender-management-package"], reason: "Saved report runs are not connected for this request.", dependency: "frozen_report_runs" }));
  return includeUnavailable ? Object.freeze(engines) : Object.freeze(engines.filter(engine => engine.ready));
}

export * from "./combined-financial-engine";
export * from "./forecast-engine";
export * from "./investor-engine";
export * from "./lender-package-engine";
export * from "./owner-statement-engine";
export * from "./project-engine";
export * from "./property-statement-engine";
export * from "./rental-expanded-engine";
export * from "./task-engine";
export * from "./time-engine";
export * from "./work-order-engine";
