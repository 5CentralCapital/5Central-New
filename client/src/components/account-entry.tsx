import React from "react";
export const ACCOUNT_ENTRY_ROUTES = Object.freeze({ manager: "/ops", resident: "/tenant", investor: "/investor-dashboard", websiteAdmin: "/admin" });

export function legacyAccountDestination(role: string): string {
  return role === "admin" ? ACCOUNT_ENTRY_ROUTES.websiteAdmin : ACCOUNT_ENTRY_ROUTES.investor;
}

export function AccountEntryChoices({ onInvestor, onNavigate }: { onInvestor: () => void; onNavigate: () => void }) {
  return <div className="space-y-3 mt-4">
    <a href={ACCOUNT_ENTRY_ROUTES.manager} onClick={onNavigate} className="block rounded-md border border-border p-4 font-medium hover:bg-muted">Manager <span className="block text-sm font-normal text-muted-foreground">Property operations and manager dashboard</span></a>
    <a href={ACCOUNT_ENTRY_ROUTES.resident} onClick={onNavigate} className="block rounded-md border border-border p-4 font-medium hover:bg-muted">Resident <span className="block text-sm font-normal text-muted-foreground">Payments, leases, and resident account</span></a>
    <button type="button" onClick={onInvestor} className="w-full text-left rounded-md border border-border p-4 font-medium hover:bg-muted">Investor <span className="block text-sm font-normal text-muted-foreground">Investor account or existing website admin</span></button>
  </div>;
}

export function ManagerDashboardLink({ authenticated, onNavigate }: { authenticated: boolean; onNavigate?: () => void }) {
  return authenticated ? <a href={ACCOUNT_ENTRY_ROUTES.manager} onClick={onNavigate} className="text-sm font-medium text-warm-brass hover:underline" data-testid="manager-dashboard-link">Manager Dashboard</a> : null;
}
