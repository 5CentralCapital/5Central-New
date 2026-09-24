// Starting layouts for the widget dashboard (12 columns; sizes in dashboard-grid-model.ts).
// Each preset is tested to tile the grid with no overlaps and no empty cells.
import type { PresetEntry } from "./dashboard-grid-model";

export const DASHBOARD_PRESETS: Record<string, readonly PresetEntry[] | null> = {
  Command: [
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
    { id: "trend", x: 0, y: 12, size: "XT" }, { id: "rent-vs-market", x: 8, y: 12, size: "MT" },
  ],
  Cash: [
    { id: "cash", x: 0, y: 0, size: "MT" }, { id: "money-in-out", x: 4, y: 0, size: "MT" }, { id: "collections-by-property", x: 8, y: 0, size: "MT" },
    { id: "bank-activity", x: 0, y: 3, size: "XL" }, { id: "receipts", x: 8, y: 3, size: "L" },
    { id: "balances", x: 0, y: 7, size: "L" }, { id: "company", x: 4, y: 7, size: "L" }, { id: "notes", x: 8, y: 7, size: "L" },
  ],
  Everything: null,
};
