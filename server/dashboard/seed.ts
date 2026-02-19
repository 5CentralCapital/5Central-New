import { DashboardData } from "./types";

export const seedData: DashboardData = {
  metrics: [
    { id: "m1", label: "Total Units", value: 55, format: "number", target: 135, trend: 0 },
    { id: "m2", label: "Assets Under Mgmt", value: 9160000, unit: "$", format: "currency", target: 23760000, trend: 4.2 },
    { id: "m3", label: "Total Equity", value: 3869895, unit: "$", format: "currency", target: 11629895, trend: 3.1 },
    { id: "m4", label: "Portfolio NOI", value: 617457, unit: "$", format: "currency", target: 2500000, trend: 2.5 },
    { id: "m5", label: "Occupancy", value: 78.2, unit: "%", format: "percent", target: 95, trend: 3.7 },
    { id: "m6", label: "DSCR", value: 1.126, format: "multiplier", target: 1.25, trend: -0.05 },
    { id: "m7", label: "Portfolio LTV", value: 59.2, unit: "%", format: "percent", target: 65 },
    { id: "m8", label: "Wtd Avg Rate", value: 10.11, unit: "%", format: "percent", target: 8, trend: 0 },
    { id: "m9", label: "Avg Yield on Cost", value: 10.34, unit: "%", format: "percent", target: 10, trend: 0.2 },
    { id: "m10", label: "Cash on Hand", value: 200000, unit: "$", format: "currency", target: 500000 },
    { id: "m11", label: "Total Debt", value: 5425105, unit: "$", format: "currency" },
    { id: "m12", label: "Break-Even Occ.", value: 87.5, unit: "%", format: "percent", target: 85 },
  ],

  properties: [
    {
      id: "p1", name: "Sun Cove Apartments", address: "Sun Cove Dr", city: "St. Petersburg", state: "FL",
      units: 21, acquisitionPrice: 1975000, rehabBudget: 502105, totalBasis: 2477105,
      currentDebt: 2102105, currentEquity: 2097895, lender: "Stormfield", interestRate: 11.25,
      maturityDate: "2027-01-01", annualNOI: 263861, yieldOnCost: 10.7, capRate: 6.28, dscr: 1.56,
      occupancyRate: 76.2, occupiedUnits: 16, phase: "rehab", refiTarget: "Q3 2026", refiProceeds: 581095,
    },
    {
      id: "p2", name: "Lucia Apartments", address: "658/670 Ave B NW", city: "Winter Haven", state: "FL",
      units: 16, acquisitionPrice: 1320000, rehabBudget: 219000, totalBasis: 1539000,
      currentDebt: 1406000, currentEquity: 1234000, lender: "Stormfield", interestRate: 11.25,
      maturityDate: "2027-02-01", annualNOI: 140853, yieldOnCost: 8.4, capRate: 5.34, dscr: 1.09,
      occupancyRate: 68.8, occupiedUnits: 11, phase: "lease_up", refiTarget: "Q2 2026", refiProceeds: 405040,
    },
    {
      id: "p3", name: "Hickory Landing", address: "2006 W Hickory St", city: "Lakeland", state: "FL",
      units: 8, acquisitionPrice: 665000, rehabBudget: 150000, totalBasis: 815000,
      currentDebt: 682000, currentEquity: 612812, lender: "Stormfield", interestRate: 11.25,
      maturityDate: "2026-09-01", annualNOI: 84163, yieldOnCost: 10.3, capRate: 6.5, dscr: 1.63,
      occupancyRate: 75.0, occupiedUnits: 6, phase: "stabilizing", refiTarget: "Q2 2026", refiProceeds: 269687,
    },
    {
      id: "p4", name: "MLK Apartments", address: "3408 E Dr MLK Blvd", city: "Tampa", state: "FL",
      units: 10, acquisitionPrice: 750000, rehabBudget: 450000, totalBasis: 1200000,
      currentDebt: 1235000, currentEquity: 665000, lender: "Sharestates", interestRate: 6.25,
      maturityDate: "2026-06-01", annualNOI: 128580, yieldOnCost: 10.7, capRate: 6.77, dscr: 1.66,
      occupancyRate: 100.0, occupiedUnits: 10, phase: "stabilized", refiTarget: "Q1 2026", refiProceeds: 345000,
    },
  ],

  rehab: [
    { id: "r1", property: "Sun Cove Apartments", project: "Full renovation - 21 units", budget: 502105, spent: 285000, completionPct: 57, status: "in_progress", targetDate: "2026-06-30", notes: "Q1-Q3 2026 timeline. Focus on unit turns and exterior." },
    { id: "r2", property: "Lucia Apartments", project: "Unit renovations & common areas", budget: 219000, spent: 142000, completionPct: 65, status: "in_progress", targetDate: "2026-04-30", notes: "Prioritize vacant units for rapid lease-up." },
    { id: "r3", property: "Hickory Landing", project: "Exterior + unit upgrades", budget: 150000, spent: 0, completionPct: 0, status: "not_started", targetDate: "2026-05-15", notes: "Budget allocated, draws not yet initiated." },
    { id: "r4", property: "MLK Apartments", project: "Post-rehab punch list", budget: 25000, spent: 22000, completionPct: 95, status: "in_progress", targetDate: "2026-03-15", notes: "Minor items remaining. Property stabilized." },
  ],

  occupancy: [
    { id: "o1", property: "Sun Cove Apartments", units: 21, occupied: 16, vacant: 5, occupancyRate: 76.2, monthlyRent: 16972, status: "watch" },
    { id: "o2", property: "Lucia Apartments", units: 16, occupied: 11, vacant: 5, occupancyRate: 68.8, monthlyRent: 13295, status: "critical" },
    { id: "o3", property: "Hickory Landing", units: 8, occupied: 6, vacant: 2, occupancyRate: 75.0, monthlyRent: 10528, status: "watch" },
    { id: "o4", property: "MLK Apartments", units: 10, occupied: 10, vacant: 0, occupancyRate: 100, monthlyRent: 16850, status: "stable" },
  ],

  kpis: [
    { id: "k1", name: "Portfolio Occupancy", current: 78.2, previous: 72.7, target: 95, unit: "%", format: "percent", date: "2026-03-01" },
    { id: "k2", name: "Portfolio DSCR", current: 1.126, previous: 1.08, target: 1.25, format: "multiplier", date: "2026-02-18" },
    { id: "k3", name: "Weighted Avg Rate", current: 10.11, previous: 10.11, target: 8.0, unit: "%", format: "percent", date: "2026-02-18" },
    { id: "k4", name: "Annual NOI", current: 617457, previous: 580000, target: 2500000, unit: "$", format: "currency", date: "2026-02-18" },
    { id: "k5", name: "Yield on Cost", current: 10.34, previous: 9.8, target: 10, unit: "%", format: "percent", date: "2026-02-18" },
    { id: "k6", name: "Equity per Unit", current: 70362, previous: 68000, target: 85000, unit: "$", format: "currency", date: "2026-02-18" },
    { id: "k7", name: "Break-Even Occ.", current: 87.5, previous: 89.2, target: 85, unit: "%", format: "percent", date: "2026-02-18" },
    { id: "k8", name: "Capital Recycled", current: 1.54, previous: 1.3, target: 2.0, format: "multiplier", date: "2026-02-18" },
    { id: "k9", name: "Cash on Hand", current: 200000, previous: 175000, target: 500000, unit: "$", format: "currency", date: "2026-02-18" },
  ],

  debt: [
    { id: "d1", property: "MLK Apartments", lender: "Sharestates", balance: 1235000, interestRate: 6.25, maturityDate: "2026-06-01", daysUntilMaturity: 103, urgency: "urgent", refiTarget: "Q1 2026", expectedProceeds: 345000 },
    { id: "d2", property: "Hickory Landing", lender: "Stormfield", balance: 682000, interestRate: 11.25, maturityDate: "2026-09-01", daysUntilMaturity: 195, urgency: "upcoming", refiTarget: "Q2 2026", expectedProceeds: 269687 },
    { id: "d3", property: "Sun Cove Apartments", lender: "Stormfield", balance: 2102105, interestRate: 11.25, maturityDate: "2027-01-01", daysUntilMaturity: 317, urgency: "safe", refiTarget: "Q3 2026", expectedProceeds: 581095 },
    { id: "d4", property: "Lucia Apartments", lender: "Stormfield", balance: 1406000, interestRate: 11.25, maturityDate: "2027-02-01", daysUntilMaturity: 348, urgency: "safe", refiTarget: "Q2 2026", expectedProceeds: 405040 },
  ],

  growth: [
    { id: "g1", year: 2024, targetUnits: 19, targetAUM: 4200000, targetEquity: 1500000, phase: "Foundation", status: "completed" },
    { id: "g2", year: 2025, targetUnits: 55, targetAUM: 9160000, targetEquity: 3870000, phase: "Acceleration", status: "completed" },
    { id: "g3", year: 2026, targetUnits: 135, targetAUM: 23760000, targetEquity: 11630000, phase: "Scale", status: "current" },
    { id: "g4", year: 2027, targetUnits: 215, targetAUM: 38500000, targetEquity: 17500000, phase: "Scale", status: "planned" },
    { id: "g5", year: 2028, targetUnits: 295, targetAUM: 53000000, targetEquity: 23300000, phase: "Scale", status: "planned" },
    { id: "g6", year: 2030, targetUnits: 455, targetAUM: 72800000, targetEquity: 23300000, phase: "Growth", status: "planned" },
    { id: "g7", year: 2035, targetUnits: 657, targetAUM: 146000000, targetEquity: 46800000, phase: "Institutional", status: "planned" },
    { id: "g8", year: 2040, targetUnits: 1000, targetAUM: 280000000, targetEquity: 100000000, phase: "Legacy", status: "planned" },
    { id: "g9", year: 2050, targetUnits: 2000, targetAUM: 606000000, targetEquity: 194000000, phase: "Generational", status: "planned" },
  ],

  tasks: [
    { id: "t1", title: "MLK Refinance - Submit package to lender", dueDate: "2026-02-27", cadence: "ad_hoc", status: "in_progress", property: "MLK Apartments", module: "reminders", priority: "critical", notes: "URGENT: 103 days to maturity. Agency financing target." },
    { id: "t2", title: "Lucia lease-up push - weekly marketing review", dueDate: "2026-02-21", cadence: "weekly", status: "open", property: "Lucia Apartments", module: "reminders", priority: "high", notes: "68.8% occupancy (11/16 units). Must hit 80% by Q2." },
    { id: "t3", title: "Sun Cove rehab progress check-in", dueDate: "2026-02-20", cadence: "weekly", status: "open", property: "Sun Cove Apartments", module: "reminders", priority: "high", notes: "Track contractor progress, budget vs actuals." },
    { id: "t4", title: "Monthly rent roll variance review", dueDate: "2026-02-25", cadence: "monthly", status: "open", property: "Portfolio-wide", module: "reminders", priority: "medium" },
    { id: "t5", title: "Payroll processing", dueDate: "2026-02-28", cadence: "monthly", status: "open", property: "Portfolio-wide", module: "reminders", priority: "medium" },
    { id: "t6", title: "Insurance renewal review - all properties", dueDate: "2026-03-15", cadence: "quarterly", status: "open", property: "Portfolio-wide", module: "reminders", priority: "medium" },
    { id: "t7", title: "Investor interest payments - Pilar & Teresa", dueDate: "2026-03-01", cadence: "monthly", status: "open", property: "Portfolio-wide", module: "reminders", priority: "high", notes: "Pilar: $25,261 interest. Teresa: $18,904 interest." },
    { id: "t8", title: "Hickory Landing refi package preparation", dueDate: "2026-03-15", cadence: "ad_hoc", status: "open", property: "Hickory Landing", module: "reminders", priority: "high", notes: "Matures Sep 2026. Start package early." },
    { id: "t10", title: "Close 40-unit Acquisition #1", dueDate: "2026-08-01", status: "open", property: "Growth Pipeline", module: "future_plans", priority: "high", notes: "Target: $1.28M capital. Apache Trail or similar." },
    { id: "t11", title: "Close 40-unit Acquisition #2", dueDate: "2026-11-01", status: "open", property: "Growth Pipeline", module: "future_plans", priority: "high", notes: "Target: $1.28M capital. Wilsonian or similar." },
    { id: "t12", title: "Underwrite Apache Trail (18 units, Clearwater)", status: "in_progress", property: "New Deals", module: "future_plans", priority: "medium", notes: "$1.62M purchase, $90K/unit. GPR $298K/yr." },
    { id: "t13", title: "Underwrite Wilsonian Building (18 units, Lakeland)", status: "open", property: "New Deals", module: "future_plans", priority: "medium", notes: "$1.575M purchase, $87.5K/unit. GPR $275K/yr." },
    { id: "t14", title: "Complete all 4 refinances - $1.6M cash-out pipeline", dueDate: "2026-09-30", status: "open", property: "Portfolio-wide", module: "future_plans", priority: "critical", notes: "MLK Q1, Lucia Q2, Hickory Q2, Sun Cove Q3." },
    { id: "t15", title: "Reach 135 units by EOY 2026", dueDate: "2026-12-31", status: "open", property: "Portfolio-wide", module: "future_plans", priority: "high", notes: "3x growth target. Requires 2 acquisitions + all refis." },
    { id: "t20", title: "Build to 455 units by 2030", status: "open", property: "Executive", module: "long_term", priority: "high", notes: "$72.8M AUM, $23.3M equity target." },
    { id: "t21", title: "Reduce portfolio weighted avg interest rate to 8%", status: "open", property: "Executive", module: "long_term", priority: "medium", notes: "Currently 10.11%. Each refi should bring this down." },
    { id: "t22", title: "Establish property management company", status: "open", property: "Executive", module: "long_term", priority: "medium", notes: "At 150+ units, in-house PM becomes viable." },
    { id: "t23", title: "Hire first full-time acquisition analyst", status: "open", property: "Executive", module: "long_term", priority: "low", notes: "Target at 200+ units." },
    { id: "t24", title: "Transition to institutional capital partners", status: "open", property: "Executive", module: "long_term", priority: "low", notes: "Target 2028-2030 for fund structure." },
    { id: "t30", title: "Smart lock installation across all properties", status: "open", property: "Portfolio-wide", module: "ideas_backlog", priority: "medium", notes: "Reduce key management, enable self-showing." },
    { id: "t31", title: "Resident mobile app for maintenance requests", status: "open", property: "Portfolio-wide", module: "ideas_backlog", priority: "low", notes: "Improve response time and tenant satisfaction." },
    { id: "t32", title: "Solar panel ROI analysis for Sun Cove", status: "open", property: "Sun Cove Apartments", module: "ideas_backlog", priority: "low", notes: "21-unit building, large roof. Could reduce expenses." },
    { id: "t33", title: "Washer/dryer income optimization", status: "open", property: "Portfolio-wide", module: "ideas_backlog", priority: "medium", notes: "Coin-op or in-unit W/D can boost NOI $50-100/unit/mo." },
    { id: "t34", title: "RUBS (Ratio Utility Billing) implementation", status: "open", property: "Portfolio-wide", module: "ideas_backlog", priority: "high", notes: "Bill back water/sewer/trash. $75-125/unit/mo NOI boost." },
    { id: "t35", title: "Pet rent policy standardization", status: "open", property: "Portfolio-wide", module: "ideas_backlog", priority: "medium", notes: "$25-50/pet/month across portfolio." },
    { id: "t36", title: "Covered parking / carport income", status: "open", property: "Sun Cove Apartments", module: "ideas_backlog", priority: "low", notes: "$50-75/space/month additional revenue." },
    { id: "t37", title: "Negotiate bulk insurance across all FL properties", status: "open", property: "Portfolio-wide", module: "ideas_backlog", priority: "medium", notes: "55 units should qualify for portfolio discount." },
  ],

  activity: [
    { id: "a1", ts: new Date().toISOString(), actor: "system", action: "init", entityType: "dashboard", entityId: "all", detail: "Dashboard initialized with live portfolio data" },
  ],
};
