// Starting layouts for the widget dashboard (12 columns; sizes in dashboard-grid-model.ts).
// Each preset is tested to tile the grid with no overlaps and no empty cells.
// "Command" is the default: the Sept 24 dashboard v2 mockup — cash card and
// rentals on top, then QuickBooks, what's coming up and occupancy, the weekly
// cash plan, and the projects block.
import type { PresetEntry } from "./dashboard-grid-model";

export const DEFAULT_DASHBOARD_PRESET = "Command";

export const DASHBOARD_PRESETS: Record<string, readonly PresetEntry[] | null> = {
  Command: [
    { id: "cash-card", x: 0, y: 0, size: "MT" }, { id: "rent-summary", x: 4, y: 0, size: "XT" },
    { id: "rent-table", x: 0, y: 3, size: "F" },
    { id: "qb-tiles", x: 0, y: 7, size: "MT" }, { id: "milestones", x: 4, y: 7, size: "MT" }, { id: "occ-trend", x: 8, y: 7, size: "MT" },
    { id: "cashflow-grid", x: 0, y: 10, size: "F6" },
    { id: "proj-kpis", x: 0, y: 16, size: "W" }, { id: "rehab-rings", x: 8, y: 16, size: "M" },
    { id: "gantt", x: 0, y: 18, size: "FT" },
    { id: "proj-board", x: 0, y: 21, size: "F6" },
  ],
  Rentals: [
    { id: "kpi-occupancy", x: 0, y: 0, size: "S" }, { id: "kpi-rent", x: 2, y: 0, size: "S" }, { id: "kpi-collected", x: 4, y: 0, size: "S" }, { id: "kpi-due", x: 6, y: 0, size: "S" }, { id: "cash", x: 8, y: 0, size: "M" },
    { id: "attention", x: 0, y: 2, size: "XT" }, { id: "units-by-property", x: 8, y: 2, size: "MT" },
    { id: "balances", x: 0, y: 5, size: "L" }, { id: "trend", x: 4, y: 5, size: "XL" },
    { id: "vacancy-list", x: 0, y: 9, size: "L" }, { id: "moves", x: 4, y: 9, size: "L" }, { id: "applications", x: 8, y: 9, size: "L" },
    { id: "company", x: 0, y: 13, size: "MT" }, { id: "delinquency-aging", x: 4, y: 13, size: "MT" }, { id: "notes", x: 8, y: 13, size: "MT" },
  ],
  "Tenant ops": [
    { id: "kpi-occupancy", x: 0, y: 0, size: "S" }, { id: "kpi-collected", x: 2, y: 0, size: "S" }, { id: "kpi-due", x: 4, y: 0, size: "S" }, { id: "vacancy-cost", x: 6, y: 0, size: "S" }, { id: "days-vacant", x: 8, y: 0, size: "M" },
    { id: "occupancy-by-property", x: 0, y: 2, size: "MT" }, { id: "collections-by-property", x: 4, y: 2, size: "MT" }, { id: "delinquency-aging", x: 8, y: 2, size: "MT" },
    { id: "balances", x: 0, y: 5, size: "L" }, { id: "vacancy-list", x: 4, y: 5, size: "L" }, { id: "receipts", x: 8, y: 5, size: "L" },
    { id: "moves", x: 0, y: 9, size: "MT" }, { id: "applications", x: 4, y: 9, size: "MT" }, { id: "due-by-property", x: 8, y: 9, size: "MT" },
    { id: "unpaid-tenants", x: 0, y: 12, size: "MT" }, { id: "top-delinquents", x: 4, y: 12, size: "MT" }, { id: "collection-rate", x: 8, y: 12, size: "MT" },
    { id: "lease-expirations", x: 0, y: 15, size: "L" }, { id: "month-to-month", x: 4, y: 15, size: "L" }, { id: "security-deposits", x: 8, y: 15, size: "L" },
    { id: "trend", x: 0, y: 19, size: "XT" }, { id: "rent-vs-market", x: 8, y: 19, size: "MT" },
  ],
  Units: [
    { id: "kpi-occupancy", x: 0, y: 0, size: "S" }, { id: "vacant-tile", x: 2, y: 0, size: "S" }, { id: "vacancy-cost", x: 4, y: 0, size: "S" }, { id: "unit-count", x: 6, y: 0, size: "M" }, { id: "days-vacant", x: 10, y: 0, size: "S" },
    { id: "unit-map", x: 0, y: 2, size: "XT" }, { id: "occ-trend", x: 8, y: 2, size: "MT" },
    { id: "vacancy-list", x: 0, y: 5, size: "L" }, { id: "long-vacancies", x: 4, y: 5, size: "L" }, { id: "units-by-property", x: 8, y: 5, size: "L" },
    { id: "unit-readiness", x: 0, y: 9, size: "MT" }, { id: "listings", x: 4, y: 9, size: "MT" }, { id: "loss-to-lease", x: 8, y: 9, size: "MT" },
    { id: "rent-by-property", x: 0, y: 12, size: "M" }, { id: "rent-by-bedroom", x: 4, y: 12, size: "M" }, { id: "missing-unit-data", x: 8, y: 12, size: "M" },
    { id: "unit-mix", x: 0, y: 14, size: "M" }, { id: "rent-vs-market", x: 4, y: 14, size: "M" }, { id: "preleased", x: 8, y: 14, size: "M" },
  ],
  Cash: [
    { id: "cash-card", x: 0, y: 0, size: "MT" }, { id: "cash-runway", x: 4, y: 0, size: "XT" },
    { id: "total-cash", x: 0, y: 3, size: "S" }, { id: "cash-low-point", x: 2, y: 3, size: "M" }, { id: "bank-accounts", x: 6, y: 3, size: "M" }, { id: "bank-pending", x: 10, y: 3, size: "S" },
    { id: "cashflow-grid", x: 0, y: 5, size: "F6" },
    { id: "cash-in-out", x: 0, y: 11, size: "MT" }, { id: "cash-big-moves", x: 4, y: 11, size: "MT" }, { id: "cash-lines", x: 8, y: 11, size: "MT" },
    { id: "bank-activity", x: 0, y: 14, size: "XL" }, { id: "bank-inflows", x: 8, y: 14, size: "L" },
    { id: "money-in-out", x: 0, y: 18, size: "MT" }, { id: "bank-outflows", x: 4, y: 18, size: "MT" }, { id: "bank-daily", x: 8, y: 18, size: "MT" },
  ],
  Projects: [
    { id: "proj-kpis", x: 0, y: 0, size: "W" }, { id: "rehab-rings", x: 8, y: 0, size: "M" },
    { id: "gantt", x: 0, y: 2, size: "FT" },
    { id: "proj-board", x: 0, y: 5, size: "F6" },
    { id: "proj-spend", x: 0, y: 11, size: "MT" }, { id: "proj-profit", x: 4, y: 11, size: "MT" }, { id: "proj-tasks", x: 8, y: 11, size: "MT" },
    { id: "proj-status", x: 0, y: 14, size: "M" }, { id: "proj-due-soon", x: 4, y: 14, size: "M" }, { id: "proj-blocked", x: 8, y: 14, size: "M" },
    { id: "proj-draft-costs", x: 0, y: 16, size: "M" }, { id: "proj-coverage", x: 4, y: 16, size: "M" }, { id: "proj-deal-cost", x: 8, y: 16, size: "M" },
    { id: "proj-budgets", x: 0, y: 18, size: "L" }, { id: "proj-sales", x: 4, y: 18, size: "L" }, { id: "proj-by-type", x: 8, y: 18, size: "L" },
  ],
  Books: [
    { id: "qb-tiles", x: 0, y: 0, size: "XT" }, { id: "close-checklist", x: 8, y: 0, size: "MT" },
    { id: "qb-pnl", x: 0, y: 3, size: "XL" }, { id: "qb-balance", x: 8, y: 3, size: "L" },
    { id: "qb-income", x: 0, y: 7, size: "M" }, { id: "qb-noi", x: 4, y: 7, size: "M" }, { id: "qb-net-income", x: 8, y: 7, size: "M" },
    { id: "qb-expenses", x: 0, y: 9, size: "M" }, { id: "qb-other-expenses", x: 4, y: 9, size: "M" }, { id: "qb-margin", x: 8, y: 9, size: "M" },
    { id: "qb-sync", x: 0, y: 11, size: "MT" }, { id: "bills-open", x: 4, y: 11, size: "MT" }, { id: "investor-payments", x: 8, y: 11, size: "MT" },
    { id: "pm-settlements", x: 0, y: 14, size: "L" }, { id: "debt-maturities", x: 4, y: 14, size: "XL" },
    { id: "debt-balances", x: 0, y: 18, size: "MT" }, { id: "debt-coverage", x: 4, y: 18, size: "MT" }, { id: "forecast-noi", x: 8, y: 18, size: "MT" },
    { id: "qb-exceptions", x: 0, y: 21, size: "M" }, { id: "review-queue", x: 4, y: 21, size: "M" }, { id: "bills-due", x: 8, y: 21, size: "M" },
    { id: "qb-transactions", x: 0, y: 23, size: "XL" }, { id: "qb-vendors", x: 8, y: 23, size: "L" },
  ],
  Everything: null,
};
