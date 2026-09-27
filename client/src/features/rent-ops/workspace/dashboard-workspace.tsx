import type { ReactNode } from "react";
import type { RentOpsWorkspaceDashboard } from "../api";
import type { AdminSnapshot, ReportKey, TenantTab, ViewFilters } from "../types";
import type { CompanySection, CompanyTarget } from "./dashboard-kit";

export interface DashboardWorkspaceProps {
  snapshot: AdminSnapshot;
  filters: ViewFilters;
  onReport: (report: ReportKey) => void;
  onOpenTenant?: (personId: string,tab?:TenantTab) => void;
  onOpenUnit?: (unitId: string) => void;
  onOpenProperty?: (propertyId:string)=>void;
  previews?: RentOpsWorkspaceDashboard["reports"];
  refreshing?: boolean;
  onManageMoves?: () => void;
  /** Company rows (obligations, exceptions, work due, cash outlook) placed below the operating panels. */
  companyPanels?: ReactNode;
  /** Company chosen in the route; company widgets fall back to the only company. */
  organizationId?: string;
  /** Opens a company page (projects, accounting, investors, forecasting…) from a widget. */
  onOpenCompany?: (section: CompanySection, organizationId: string | undefined, target?: CompanyTarget) => void;
}

export { RmDashboard as DashboardWorkspace } from "./rm-dashboard";
