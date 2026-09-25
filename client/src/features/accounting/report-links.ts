import type { CompanyContextOrganization } from "@shared/company/context";
import { reportRunRequestSchema, type ReportRunRequest } from "@shared/reporting";
import type { DashboardSetup } from "./dashboard-model";
const NATIVE_REPORTS = ["income-statement", "balance-sheet", "cash-flow-statement", "general-ledger", "trial-balance"];
export function financialReportHref(organizationId: string, legalEntityId: string, reportId: string, setup?: DashboardSetup): string {
  return `/ops?${new URLSearchParams({ section: "company-reports", company: organizationId, reportId, financialEntity: legalEntityId,
    ...(setup ? { financialFrom: setup.from, financialThrough: setup.through, financialBasis: setup.basis } : {}) })}`;
}
/** A dashboard link seeds the report setup; it never bypasses setup or authorization. */
export function requestFromFinancialLink(search: string, organization: CompanyContextOrganization, reportId: string | undefined): ReportRunRequest | undefined {
  const params = new URLSearchParams(search);
  if (!reportId || !NATIVE_REPORTS.includes(reportId) || params.get("company") !== organization.id || params.get("reportId") !== reportId) return undefined;
  const entity = organization.entities.find(item => item.id === params.get("financialEntity"));
  if (!entity) return undefined;
  const from = params.get("financialFrom"), through = params.get("financialThrough"), basis = params.get("financialBasis");
  if (!from || !through || !basis) return undefined;
  const parsed = reportRunRequestSchema.safeParse({ reportId, definitionVersion: "1", scope: { organizationId: organization.id, legalEntityIds: [entity.id] }, filters: {},
    period: reportId === "balance-sheet" || reportId === "trial-balance" ? { mode: "as_of", asOfDate: through } : { mode: "range", fromDate: from, toDate: through }, basis, currency: entity.currency });
  return parsed.success ? parsed.data : undefined;
}
