import { sql } from "drizzle-orm";
import { pgTable, text, varchar, decimal, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  role: text("role").notNull().default("investor"), // "admin" or "investor"
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const investors = pgTable("investors", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  accreditedStatus: text("accredited_status").notNull().default("pending"), // "pending" or "verified"
  investedAmount: decimal("invested_amount", { precision: 12, scale: 2 }).default("0"),
  phone: text("phone"),
  investorType: text("investor_type").notNull().default("deal-investor"), // "deal-investor" | "company-partner"
  companyEquityPercentage: decimal("company_equity_percentage", { precision: 5, scale: 4 }),
});

export const investments = pgTable("investments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  investorId: varchar("investor_id").notNull().references(() => investors.id),
  propertyName: text("property_name").notNull(),
  propertyAddress: text("property_address"),
  principal: decimal("principal", { precision: 12, scale: 2 }).notNull(),
  balloonAmount: decimal("balloon_amount", { precision: 12, scale: 2 }),
  monthlyPayment: decimal("monthly_payment", { precision: 12, scale: 2 }),
  returnMultiple: decimal("return_multiple", { precision: 4, scale: 2 }),
  interestRate: decimal("interest_rate", { precision: 5, scale: 4 }),
  effectiveDate: timestamp("effective_date"),
  maturityDate: timestamp("maturity_date"),
  term: text("term"),
  status: text("status").notNull().default("active"), // "active", "paid", "defaulted"
  investmentType: text("investment_type").notNull().default("deal-specific"), // "deal-specific", "general", or "equity"
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  // Equity investment fields
  equityPercentage: decimal("equity_percentage", { precision: 5, scale: 4 }),
  propertyId: varchar("property_id"),
  initialInvestment: decimal("initial_investment", { precision: 12, scale: 2 }),
  currentEquityValue: decimal("current_equity_value", { precision: 12, scale: 2 }),
  cashOutAtRefi: decimal("cash_out_at_refi", { precision: 12, scale: 2 }),
  projectedExitValue: decimal("projected_exit_value", { precision: 12, scale: 2 }),
  equityMultiple: decimal("equity_multiple", { precision: 4, scale: 2 }),
});

export const properties = pgTable("properties", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  address: text("address").notNull(),
  city: text("city").notNull(),
  state: text("state").notNull(),
  zipCode: text("zip_code").notNull(),
  units: integer("units").notNull(),
  acquisitionDate: timestamp("acquisition_date").notNull(),
  acquisitionPrice: decimal("acquisition_price", { precision: 12, scale: 2 }).notNull(),
  rehabCosts: decimal("rehab_costs", { precision: 12, scale: 2 }).default("0"),
  currentValue: decimal("current_value", { precision: 12, scale: 2 }),
  salePrice: decimal("sale_price", { precision: 12, scale: 2 }),
  saleDate: timestamp("sale_date"),
  totalCashflow: decimal("total_cashflow", { precision: 12, scale: 2 }).default("0"),
  status: text("status").notNull().default("current"), // "current" or "sold"
  ownershipStructure: text("ownership_structure").notNull(),
  ownershipName: text("ownership_name").notNull(),
  yearsHeld: decimal("years_held", { precision: 4, scale: 2 }),
  irr: decimal("irr", { precision: 5, scale: 2 }),
  equityMultiple: decimal("equity_multiple", { precision: 4, scale: 2 }),
  noi: decimal("noi", { precision: 12, scale: 2 }),
  debtService: decimal("debt_service", { precision: 12, scale: 2 }),
  cashflow: decimal("cashflow", { precision: 12, scale: 2 }),
  // Debt and timeline fields
  currentDebt: decimal("current_debt", { precision: 12, scale: 2 }),
  refiDate: timestamp("refi_date"),
  projectedSaleDate: timestamp("projected_sale_date"),
  imageUrl: text("image_url"),

  // === DETAILED PROPERTY METRICS ===

  // Deal Overview
  yearBuilt: text("year_built"),
  buildingSF: text("building_sf"),
  closingDate: text("closing_date"),
  investmentThesis: text("investment_thesis"),

  // Operational Metrics
  inPlaceNOI: decimal("in_place_noi", { precision: 12, scale: 2 }),
  stabilizedNOI: decimal("stabilized_noi", { precision: 12, scale: 2 }),
  noiUpside: decimal("noi_upside", { precision: 12, scale: 2 }),
  capRateInPlace: decimal("cap_rate_in_place", { precision: 6, scale: 4 }),
  capRateStabilized: decimal("cap_rate_stabilized", { precision: 6, scale: 4 }),

  // Valuation
  entryCapRate: decimal("entry_cap_rate", { precision: 6, scale: 4 }),
  exitCapRate: decimal("exit_cap_rate", { precision: 6, scale: 4 }),
  capRateSpread: decimal("cap_rate_spread", { precision: 6, scale: 4 }),
  valueCreation: decimal("value_creation", { precision: 12, scale: 2 }),
  entryPerUnit: decimal("entry_per_unit", { precision: 12, scale: 2 }),
  exitPerUnit: decimal("exit_per_unit", { precision: 12, scale: 2 }),
  arvPerUnit: decimal("arv_per_unit", { precision: 12, scale: 2 }),
  arvTotal: decimal("arv_total", { precision: 12, scale: 2 }),

  // Financing Details
  bridgeLoan: decimal("bridge_loan", { precision: 12, scale: 2 }),
  ltvPurchase: decimal("ltv_purchase", { precision: 6, scale: 4 }),
  ltc: decimal("ltc", { precision: 6, scale: 4 }),
  interestRate: decimal("interest_rate", { precision: 6, scale: 4 }),
  rehabHoldback: decimal("rehab_holdback", { precision: 12, scale: 2 }),
  totalCommitment: decimal("total_commitment", { precision: 12, scale: 2 }),
  monthlyPI: decimal("monthly_pi", { precision: 12, scale: 2 }),
  annualDebtService: decimal("annual_debt_service", { precision: 12, scale: 2 }),
  maturityDate: text("maturity_date"),
  loanType: text("loan_type"),

  // Returns & Performance
  irrLevered: text("irr_levered"),
  moic: decimal("moic", { precision: 6, scale: 2 }),
  yieldOnCost: decimal("yield_on_cost", { precision: 6, scale: 4 }),
  cashYieldStabilized: decimal("cash_yield_stabilized", { precision: 6, scale: 4 }),
  paybackPeriod: decimal("payback_period", { precision: 6, scale: 1 }),
  holdPeriod: text("hold_period"),
  refiMonth: integer("refi_month"),
  sponsorEquity: decimal("sponsor_equity", { precision: 12, scale: 2 }),

  // Risk Metrics
  breakevenOccupancy: decimal("breakeven_occupancy", { precision: 6, scale: 4 }),
  dscrStabilized: decimal("dscr_stabilized", { precision: 6, scale: 2 }),
  debtYield: decimal("debt_yield", { precision: 6, scale: 4 }),

  // Exit Analysis
  cashOutAtRefi: decimal("cash_out_at_refi", { precision: 12, scale: 2 }),
  netCashFromSale: decimal("net_cash_from_sale", { precision: 12, scale: 2 }),
  totalProfit: decimal("total_profit", { precision: 12, scale: 2 }),

  // Rent Roll
  totalUnits: integer("total_units"),
  occupiedUnits: integer("occupied_units"),
  occupancyRate: decimal("occupancy_rate", { precision: 6, scale: 4 }),
  inPlaceRent: decimal("in_place_rent", { precision: 12, scale: 2 }),
  proformaRent: decimal("proforma_rent", { precision: 12, scale: 2 }),
  rentUpside: decimal("rent_upside", { precision: 12, scale: 2 }),

  // Refinance Step
  refiLTV: decimal("refi_ltv", { precision: 6, scale: 4 }),
  refiLoanAmount: decimal("refi_loan_amount", { precision: 12, scale: 2 }),
  refiCashOut: decimal("refi_cash_out", { precision: 12, scale: 2 }),
  newMonthlyPI: decimal("new_monthly_pi", { precision: 12, scale: 2 }),
  equityAfterRefi: decimal("equity_after_refi", { precision: 12, scale: 2 }),
  refiTargetMonth: integer("refi_target_month"),

  // Exit Step
  projectedSalePrice: decimal("projected_sale_price", { precision: 12, scale: 2 }),
  projectedNetProceeds: decimal("projected_net_proceeds", { precision: 12, scale: 2 }),
  projectedTotalProfit: decimal("projected_total_profit", { precision: 12, scale: 2 }),
  holdPeriodMonths: integer("hold_period_months"),

  // Photos (JSON arrays)
  beforePhotos: text("before_photos"), // JSON array
  afterPhotos: text("after_photos"), // JSON array

  // Sold Property Details
  initialCapitalRequired: decimal("initial_capital_required", { precision: 12, scale: 2 }),
  totalCashflowCollected: decimal("total_cashflow_collected", { precision: 12, scale: 2 }),
  saleProceeds: decimal("sale_proceeds", { precision: 12, scale: 2 }),
  cashOnCash: decimal("cash_on_cash", { precision: 8, scale: 2 }),
  totalReturnPercent: decimal("total_return_percent", { precision: 8, scale: 2 }),
  appreciationPercent: decimal("appreciation_percent", { precision: 8, scale: 2 }),
  pricePerUnit: decimal("price_per_unit", { precision: 12, scale: 2 }),
  totalBasis: decimal("total_basis", { precision: 12, scale: 2 }),
  grossProfit: decimal("gross_profit", { precision: 12, scale: 2 }),
  roc: decimal("roc", { precision: 8, scale: 2 }),
  avgAnnualReturn: decimal("avg_annual_return", { precision: 8, scale: 2 }),
  profitPerUnit: decimal("profit_per_unit", { precision: 12, scale: 2 }),

  // Dashboard operational fields (shared with admin dashboard)
  phase: text("phase"), // rehab, lease_up, stabilizing, stabilized, sold
  lender: text("lender"),
  refiTarget: text("refi_target"), // e.g. "Q3 2026"
  monthlyRent: decimal("monthly_rent", { precision: 12, scale: 2 }),
  occupancyStatus: text("occupancy_status"), // stable, watch, critical
});

// === DASHBOARD-SPECIFIC TABLES (admin dashboard data in PostgreSQL) ===

export const dashboardTasks = pgTable("dashboard_tasks", {
  id: varchar("id").primaryKey(),
  title: text("title").notNull(),
  dueDate: text("due_date"),
  cadence: text("cadence"), // daily, weekly, monthly, quarterly, ad_hoc
  status: text("status").notNull().default("open"), // open, in_progress, done, blocked
  property: text("property"),
  module: text("module").notNull().default("reminders"), // reminders, long_term, future_plans, ideas_backlog, rehab
  priority: text("priority").default("medium"), // low, medium, high, critical
  notes: text("notes"),
});

export const dashboardRehab = pgTable("dashboard_rehab", {
  id: varchar("id").primaryKey(),
  property: text("property").notNull(),
  project: text("project").notNull(),
  budget: decimal("budget", { precision: 12, scale: 2 }).notNull(),
  spent: decimal("spent", { precision: 12, scale: 2 }).notNull().default("0"),
  completionPct: integer("completion_pct").notNull().default(0),
  status: text("status").notNull().default("not_started"), // not_started, in_progress, complete, blocked
  targetDate: text("target_date"),
  notes: text("notes"),
});

export const dashboardGrowth = pgTable("dashboard_growth", {
  id: varchar("id").primaryKey(),
  year: integer("year").notNull(),
  targetUnits: integer("target_units").notNull(),
  targetAUM: decimal("target_aum", { precision: 14, scale: 2 }).notNull(),
  targetEquity: decimal("target_equity", { precision: 14, scale: 2 }).notNull(),
  phase: text("phase").notNull(),
  status: text("status").notNull().default("planned"), // completed, current, planned
});

export const dashboardKpis = pgTable("dashboard_kpis", {
  id: varchar("id").primaryKey(),
  name: text("name").notNull(),
  current: decimal("current_value", { precision: 14, scale: 4 }).notNull(),
  previous: decimal("previous_value", { precision: 14, scale: 4 }).notNull(),
  target: decimal("target_value", { precision: 14, scale: 4 }).notNull(),
  unit: text("unit"),
  format: text("format"), // currency, percent, number, multiplier
  property: text("property"),
  date: text("date"),
});

export const dashboardMetrics = pgTable("dashboard_metrics", {
  id: varchar("id").primaryKey(),
  label: text("label").notNull(),
  value: decimal("value", { precision: 14, scale: 4 }).notNull(),
  unit: text("unit"),
  trend: decimal("trend", { precision: 8, scale: 4 }),
  target: decimal("target", { precision: 14, scale: 4 }),
  format: text("format"), // currency, percent, number, multiplier
});

export const dashboardActivity = pgTable("dashboard_activity", {
  id: varchar("id").primaryKey(),
  ts: timestamp("ts").defaultNow().notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  detail: text("detail").notNull(),
});

// ============================================================
// === MODULE 1: LABOR & PAYROLL OPS ===
// ============================================================

export const workers = pgTable("workers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  role: text("role").notNull(), // laborer, lead, electrician, plumber, painter, general
  phone: text("phone"),
  email: text("email"),
  defaultRate: decimal("default_rate", { precision: 8, scale: 2 }).notNull(), // hourly rate
  paymentMethod: text("payment_method").notNull().default("zelle"), // zelle, check, ach, cash
  paymentHandle: text("payment_handle"), // zelle email/phone, bank info ref
  status: text("status").notNull().default("active"), // active, inactive, terminated
  hireDate: timestamp("hire_date").defaultNow().notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const payrollEntries = pgTable("payroll_entries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  workerId: varchar("worker_id").notNull().references(() => workers.id),
  propertyId: varchar("property_id").references(() => properties.id),
  unitNumber: text("unit_number"), // which unit worked on
  task: text("task").notNull(), // demo, paint, flooring, plumbing, electrical, etc.
  date: text("date").notNull(), // YYYY-MM-DD
  hours: decimal("hours", { precision: 5, scale: 2 }).notNull(),
  rate: decimal("rate", { precision: 8, scale: 2 }).notNull(),
  total: decimal("total", { precision: 10, scale: 2 }).notNull(), // hours * rate
  weekEnding: text("week_ending"), // YYYY-MM-DD for weekly rollup
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const payrollPayments = pgTable("payroll_payments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  workerId: varchar("worker_id").notNull().references(() => workers.id),
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  paymentMethod: text("payment_method").notNull(), // zelle, check, ach, cash
  memo: text("memo"), // e.g. "Hickory wk ending 2/20"
  reference: text("reference"), // confirmation # or check #
  periodStart: text("period_start").notNull(), // YYYY-MM-DD
  periodEnd: text("period_end").notNull(), // YYYY-MM-DD
  paidAt: timestamp("paid_at").defaultNow().notNull(),
  status: text("status").notNull().default("paid"), // pending, paid, failed
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ============================================================
// === MODULE 2: DUAL REHAB COST ENGINE ===
// ============================================================

export const rehabLineItems = pgTable("rehab_line_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  propertyId: varchar("property_id").notNull().references(() => properties.id),
  unitNumber: text("unit_number"), // null = common area / whole property
  scopeItem: text("scope_item").notNull(), // e.g. "Kitchen demo", "LVP flooring", "Bathroom tile"
  category: text("category").notNull(), // demo, flooring, paint, plumbing, electrical, hvac, roofing, appliances, cabinets, countertops, exterior, other
  contractorBaselineCost: decimal("contractor_baseline_cost", { precision: 10, scale: 2 }), // what a contractor would charge
  inHouseLaborCost: decimal("in_house_labor_cost", { precision: 10, scale: 2 }).default("0"),
  inHouseMaterialCost: decimal("in_house_material_cost", { precision: 10, scale: 2 }).default("0"),
  totalInHouseCost: decimal("total_in_house_cost", { precision: 10, scale: 2 }).default("0"), // labor + material
  savingsVsContractor: decimal("savings_vs_contractor", { precision: 10, scale: 2 }).default("0"),
  savingsPercent: decimal("savings_percent", { precision: 5, scale: 2 }).default("0"),
  status: text("status").notNull().default("planned"), // planned, in_progress, complete, blocked, cancelled
  assignedWorkerId: varchar("assigned_worker_id").references(() => workers.id),
  plannedStartDate: text("planned_start_date"),
  plannedEndDate: text("planned_end_date"),
  actualStartDate: text("actual_start_date"),
  actualEndDate: text("actual_end_date"),
  slipDays: integer("slip_days").default(0),
  isCriticalPath: boolean("is_critical_path").default(false),
  blockerReason: text("blocker_reason"), // material, labor, inspection, access, weather
  proofUrl: text("proof_url"), // photo/receipt link
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const rehabMaterialLog = pgTable("rehab_material_log", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  propertyId: varchar("property_id").notNull().references(() => properties.id),
  lineItemId: varchar("line_item_id").references(() => rehabLineItems.id),
  description: text("description").notNull(), // e.g. "LVP flooring - 600 sqft"
  vendor: text("vendor"), // Home Depot, Lowes, etc.
  cost: decimal("cost", { precision: 10, scale: 2 }).notNull(),
  receiptUrl: text("receipt_url"),
  purchaseDate: text("purchase_date").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const rehabPhotos = pgTable("rehab_photos", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  propertyId: varchar("property_id").notNull().references(() => properties.id),
  unitNumber: text("unit_number"),
  lineItemId: varchar("line_item_id").references(() => rehabLineItems.id),
  photoUrl: text("photo_url").notNull(),
  caption: text("caption"),
  phase: text("phase").notNull(), // before, during, after
  takenAt: timestamp("taken_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ============================================================
// === MODULE 3: LEASE-UP MISSION CONTROL ===
// ============================================================

export const unitRentRoll = pgTable("unit_rent_roll", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  propertyId: varchar("property_id").notNull().references(() => properties.id),
  unitNumber: text("unit_number").notNull(),
  bedrooms: integer("bedrooms"),
  bathrooms: decimal("bathrooms", { precision: 3, scale: 1 }),
  sqft: integer("sqft"),
  tenantName: text("tenant_name"),
  leaseStart: text("lease_start"), // YYYY-MM-DD
  leaseEnd: text("lease_end"), // YYYY-MM-DD
  monthlyRent: decimal("monthly_rent", { precision: 8, scale: 2 }),
  marketRent: decimal("market_rent", { precision: 8, scale: 2 }),
  securityDeposit: decimal("security_deposit", { precision: 8, scale: 2 }),
  status: text("status").notNull().default("vacant"), // occupied, vacant, notice, eviction, renovation
  moveInDate: text("move_in_date"),
  moveOutDate: text("move_out_date"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const vacancyPipeline = pgTable("vacancy_pipeline", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  unitId: varchar("unit_id").notNull().references(() => unitRentRoll.id),
  propertyId: varchar("property_id").notNull().references(() => properties.id),
  unitNumber: text("unit_number").notNull(),
  vacancyStartDate: text("vacancy_start_date").notNull(), // YYYY-MM-DD
  daysVacant: integer("days_vacant").default(0), // auto-calculated
  turnStatus: text("turn_status").notNull().default("not_started"),
  // not_started, rehab_in_progress, punch_clean, photos_pending, listing_live, showing_scheduled, application_received, approved, lease_sent, lease_signed, move_in_scheduled, complete
  targetReadyDate: text("target_ready_date"),
  targetLeaseDate: text("target_lease_date"),
  askingRent: decimal("asking_rent", { precision: 8, scale: 2 }),
  marketComps: decimal("market_comps", { precision: 8, scale: 2 }),
  showingsCount: integer("showings_count").default(0),
  applicationsCount: integer("applications_count").default(0),
  urgency: text("urgency").default("normal"), // normal, yellow (>7 days), red (>14 days)
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const turnChecklist = pgTable("turn_checklist", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  vacancyId: varchar("vacancy_id").notNull().references(() => vacancyPipeline.id),
  step: text("step").notNull(),
  // Steps: move_out_inspection, scope_approved, rehab_complete, punch_clean, photos_complete, listing_live, showings_scheduled, application_screening, lease_sent, lease_signed, move_in_scheduled
  sortOrder: integer("sort_order").notNull(),
  isComplete: boolean("is_complete").default(false),
  completedAt: timestamp("completed_at"),
  completedBy: text("completed_by"),
  dueDate: text("due_date"),
  notes: text("notes"),
});

// ============================================================
// === MODULE 4: PM OPERATING LAYER ===
// ============================================================

export const pmNotes = pgTable("pm_notes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  propertyId: varchar("property_id").notNull().references(() => properties.id),
  author: text("author").notNull(), // PM name or "michael"
  date: text("date").notNull(), // YYYY-MM-DD
  content: text("content").notNull(),
  category: text("category").default("general"), // general, maintenance, tenant, leasing, financial, emergency
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const pmEscalations = pgTable("pm_escalations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  propertyId: varchar("property_id").references(() => properties.id),
  title: text("title").notNull(),
  description: text("description").notNull(),
  priority: text("priority").notNull().default("medium"), // low, medium, high, critical
  trigger: text("trigger").notNull(), // spend_over_limit, rent_concession, vendor_change, tenant_issue, emergency, maintenance
  status: text("status").notNull().default("open"), // open, acknowledged, resolved, dismissed
  escalatedBy: text("escalated_by").notNull(),
  resolvedBy: text("resolved_by"),
  resolvedAt: timestamp("resolved_at"),
  spendAmount: decimal("spend_amount", { precision: 10, scale: 2 }), // if spend-triggered
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const slaTimers = pgTable("sla_timers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  propertyId: varchar("property_id").references(() => properties.id),
  slaType: text("sla_type").notNull(), // lead_response, maintenance_first_touch, turn_completion, lease_processing
  targetHours: integer("target_hours").notNull(), // SLA target in hours
  startedAt: timestamp("started_at").notNull(),
  completedAt: timestamp("completed_at"),
  isBreached: boolean("is_breached").default(false),
  relatedEntityType: text("related_entity_type"), // vacancy, maintenance_request, lead
  relatedEntityId: varchar("related_entity_id"),
  assignedTo: text("assigned_to"),
  notes: text("notes"),
});

// ============================================================
// === MODULE 5: INVESTOR DOCUMENT DELIVERY ===
// ============================================================

export const investorDocuments = pgTable("investor_documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  investorId: varchar("investor_id").references(() => investors.id), // null = all investors
  propertyId: varchar("property_id").references(() => properties.id), // null = company-level
  title: text("title").notNull(),
  description: text("description"),
  docType: text("doc_type").notNull(), // k1, operating_agreement, quarterly_report, subscription_doc, distribution_notice, tax_doc, other
  fileUrl: text("file_url").notNull(),
  fileName: text("file_name").notNull(),
  fileSize: integer("file_size"), // bytes
  year: integer("year"),
  quarter: integer("quarter"), // 1-4
  status: text("status").notNull().default("available"), // draft, available, archived
  uploadedBy: text("uploaded_by").notNull(),
  downloadCount: integer("download_count").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ============================================================
// === MODULE 6: DISTRIBUTION TRACKING & WATERFALL ===
// ============================================================

export const distributions = pgTable("distributions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  investorId: varchar("investor_id").notNull().references(() => investors.id),
  investmentId: varchar("investment_id").references(() => investments.id),
  propertyId: varchar("property_id").references(() => properties.id),
  amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
  distributionType: text("distribution_type").notNull(), // preferred_return, return_of_capital, profit_share, promote, refinance_proceeds, sale_proceeds
  period: text("period"), // "2025-Q1", "2025-03", etc.
  paymentMethod: text("payment_method"), // ach, wire, check
  paymentReference: text("payment_reference"),
  status: text("status").notNull().default("pending"), // pending, processing, paid, failed
  paidAt: timestamp("paid_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const waterfallTiers = pgTable("waterfall_tiers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  investmentId: varchar("investment_id").references(() => investments.id),
  propertyId: varchar("property_id").references(() => properties.id),
  tierOrder: integer("tier_order").notNull(), // 1, 2, 3...
  tierName: text("tier_name").notNull(), // "Preferred Return", "Return of Capital", "Catch-Up", "Promote Split"
  hurdleRate: decimal("hurdle_rate", { precision: 6, scale: 4 }), // e.g. 0.08 for 8% pref
  lpSplit: decimal("lp_split", { precision: 5, scale: 2 }), // e.g. 100, 80, 70
  gpSplit: decimal("gp_split", { precision: 5, scale: 2 }), // e.g. 0, 20, 30
  description: text("description"),
});

// ============================================================
// === MODULE 7: CAPITAL ACCOUNTS ===
// ============================================================

export const capitalAccounts = pgTable("capital_accounts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  investorId: varchar("investor_id").notNull().references(() => investors.id),
  investmentId: varchar("investment_id").references(() => investments.id),
  propertyId: varchar("property_id").references(() => properties.id),
  period: text("period").notNull(), // "2025-Q1", "2025-12", etc.
  beginningBalance: decimal("beginning_balance", { precision: 14, scale: 2 }).notNull(),
  contributions: decimal("contributions", { precision: 12, scale: 2 }).default("0"),
  distributionsPaid: decimal("distributions_paid", { precision: 12, scale: 2 }).default("0"),
  allocatedIncome: decimal("allocated_income", { precision: 12, scale: 2 }).default("0"),
  allocatedLoss: decimal("allocated_loss", { precision: 12, scale: 2 }).default("0"),
  appreciationAllocation: decimal("appreciation_allocation", { precision: 12, scale: 2 }).default("0"),
  endingBalance: decimal("ending_balance", { precision: 14, scale: 2 }).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ============================================================
// === MODULE 8: MONTHLY TIME-SERIES DATA ===
// ============================================================

export const propertyMonthlyData = pgTable("property_monthly_data", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  propertyId: varchar("property_id").notNull().references(() => properties.id),
  month: text("month").notNull(), // "2025-01"
  actualRentCollected: decimal("actual_rent_collected", { precision: 12, scale: 2 }),
  proformaRent: decimal("proforma_rent", { precision: 12, scale: 2 }),
  vacancyCount: integer("vacancy_count"),
  occupiedCount: integer("occupied_count"),
  operatingExpenses: decimal("operating_expenses", { precision: 12, scale: 2 }),
  actualNOI: decimal("actual_noi", { precision: 12, scale: 2 }),
  proformaNOI: decimal("proforma_noi", { precision: 12, scale: 2 }),
  debtServicePaid: decimal("debt_service_paid", { precision: 12, scale: 2 }),
  netCashflow: decimal("net_cashflow", { precision: 12, scale: 2 }),
  distributionsPaid: decimal("distributions_paid", { precision: 12, scale: 2 }),
  rehabSpend: decimal("rehab_spend", { precision: 12, scale: 2 }),
  varianceNotes: text("variance_notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ============================================================
// === MODULE 9: DEAL PIPELINE / ACQUISITION TRACKER ===
// ============================================================

export const dealPipeline = pgTable("deal_pipeline", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(), // property/deal name
  address: text("address"),
  city: text("city"),
  state: text("state"),
  units: integer("units"),
  askingPrice: decimal("asking_price", { precision: 12, scale: 2 }),
  offerPrice: decimal("offer_price", { precision: 12, scale: 2 }),
  projectedNOI: decimal("projected_noi", { precision: 12, scale: 2 }),
  projectedCapRate: decimal("projected_cap_rate", { precision: 6, scale: 4 }),
  projectedIRR: decimal("projected_irr", { precision: 6, scale: 2 }),
  stage: text("stage").notNull().default("sourced"),
  // sourced, underwriting, loi_submitted, under_contract, due_diligence, financing, closing, closed, dead
  source: text("source"), // broker, off-market, auction, wholesaler, direct
  brokerName: text("broker_name"),
  brokerContact: text("broker_contact"),
  loiDate: text("loi_date"),
  contractDate: text("contract_date"),
  ddDeadline: text("dd_deadline"),
  closingDate: text("closing_date"),
  deadReason: text("dead_reason"), // price, condition, financing, title, competition, other
  equityNeeded: decimal("equity_needed", { precision: 12, scale: 2 }),
  financingStrategy: text("financing_strategy"), // bridge, agency, seller_finance, cash, portfolio_loan
  investmentThesis: text("investment_thesis"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ============================================================
// === MODULE 10: INVESTOR CRM & COMMUNICATIONS ===
// ============================================================

export const investorLeads = pgTable("investor_leads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  company: text("company"),
  accreditedStatus: text("accredited_status").default("unknown"), // unknown, self_reported, verified, not_accredited
  investableCapital: decimal("investable_capital", { precision: 14, scale: 2 }),
  source: text("source"), // website, referral, event, linkedin, cold_outreach
  referredBy: text("referred_by"),
  stage: text("stage").notNull().default("new"),
  // new, contacted, qualified, meeting_scheduled, meeting_complete, docs_sent, committed, funded, inactive
  interestLevel: text("interest_level").default("medium"), // cold, warm, hot
  notes: text("notes"),
  lastContactDate: text("last_contact_date"),
  nextFollowUpDate: text("next_follow_up_date"),
  convertedToInvestorId: varchar("converted_to_investor_id").references(() => investors.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const investorCommunications = pgTable("investor_communications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  investorId: varchar("investor_id").references(() => investors.id),
  leadId: varchar("lead_id").references(() => investorLeads.id),
  type: text("type").notNull(), // email, phone, meeting, report, distribution_notice, k1_delivery, text, other
  direction: text("direction").notNull().default("outbound"), // inbound, outbound
  subject: text("subject"),
  content: text("content"),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
  sentBy: text("sent_by"),
  status: text("status").default("sent"), // draft, sent, delivered, read, bounced
  relatedDocumentId: varchar("related_document_id").references(() => investorDocuments.id),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ============================================================
// === MODULE 11: PROPERTY LOANS / MORTGAGE OBLIGATIONS ===
// ============================================================

export const loans = pgTable("loans", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  propertyName: text("property_name").notNull(),
  propertyId: varchar("property_id").references(() => properties.id),
  lender: text("lender").notNull(),
  loanType: text("loan_type").default("bridge"), // bridge, conventional, seller_note, hard_money, refi, construction
  balance: decimal("balance", { precision: 14, scale: 2 }).notNull(),
  interestRate: decimal("interest_rate", { precision: 8, scale: 5 }),
  monthlyPayment: decimal("monthly_payment", { precision: 12, scale: 2 }),
  maturityDate: text("maturity_date"),
  term: text("term"), // "12 mo", "30-yr fixed", etc.
  interestOnly: boolean("interest_only").default(true),
  originationFee: decimal("origination_fee", { precision: 10, scale: 2 }),
  exitFee: decimal("exit_fee", { precision: 8, scale: 4 }), // as decimal e.g. 0.0125 for 1.25%
  loanToValue: decimal("loan_to_value", { precision: 6, scale: 4 }),
  status: text("status").notNull().default("active"), // active, paid_off, refinanced, defaulted
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ============================================================
// === MODULE 12: MAINTENANCE REQUESTS (for PM layer) ===
// ============================================================

export const maintenanceRequests = pgTable("maintenance_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  propertyId: varchar("property_id").notNull().references(() => properties.id),
  unitNumber: text("unit_number"),
  tenantName: text("tenant_name"),
  title: text("title").notNull(),
  description: text("description").notNull(),
  category: text("category").notNull(), // plumbing, electrical, hvac, appliance, pest, structural, cosmetic, emergency, other
  priority: text("priority").notNull().default("medium"), // low, medium, high, emergency
  status: text("status").notNull().default("open"), // open, assigned, in_progress, parts_ordered, scheduled, complete, cancelled
  assignedTo: text("assigned_to"), // worker name or vendor
  estimatedCost: decimal("estimated_cost", { precision: 10, scale: 2 }),
  actualCost: decimal("actual_cost", { precision: 10, scale: 2 }),
  reportedAt: timestamp("reported_at").defaultNow().notNull(),
  acknowledgedAt: timestamp("acknowledged_at"),
  scheduledDate: text("scheduled_date"),
  completedAt: timestamp("completed_at"),
  photoUrls: text("photo_urls"), // JSON array
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ============================================================
// === INSERT SCHEMAS & TYPE EXPORTS ===
// ============================================================

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
});

export const insertPropertySchema = createInsertSchema(properties).omit({
  id: true,
});

export const insertInvestorSchema = createInsertSchema(investors).omit({
  id: true,
});

export const insertInvestmentSchema = createInsertSchema(investments).omit({
  id: true,
  createdAt: true,
});

export const insertTaskSchema = createInsertSchema(dashboardTasks);
export const insertRehabSchema = createInsertSchema(dashboardRehab);
export const insertGrowthSchema = createInsertSchema(dashboardGrowth);
export const insertKpiSchema = createInsertSchema(dashboardKpis);
export const insertMetricSchema = createInsertSchema(dashboardMetrics);
export const insertActivitySchema = createInsertSchema(dashboardActivity);

// New module insert schemas
export const insertWorkerSchema = createInsertSchema(workers).omit({ id: true, createdAt: true });
export const insertPayrollEntrySchema = createInsertSchema(payrollEntries).omit({ id: true, createdAt: true });
export const insertPayrollPaymentSchema = createInsertSchema(payrollPayments).omit({ id: true, createdAt: true });
export const insertRehabLineItemSchema = createInsertSchema(rehabLineItems).omit({ id: true, createdAt: true, updatedAt: true });
export const insertRehabMaterialSchema = createInsertSchema(rehabMaterialLog).omit({ id: true, createdAt: true });
export const insertRehabPhotoSchema = createInsertSchema(rehabPhotos).omit({ id: true, createdAt: true });
export const insertUnitRentRollSchema = createInsertSchema(unitRentRoll).omit({ id: true, createdAt: true, updatedAt: true });
export const insertVacancyPipelineSchema = createInsertSchema(vacancyPipeline).omit({ id: true, createdAt: true, updatedAt: true });
export const insertTurnChecklistSchema = createInsertSchema(turnChecklist).omit({ id: true });
export const insertPmNoteSchema = createInsertSchema(pmNotes).omit({ id: true, createdAt: true });
export const insertPmEscalationSchema = createInsertSchema(pmEscalations).omit({ id: true, createdAt: true });
export const insertSlaTimerSchema = createInsertSchema(slaTimers).omit({ id: true });
export const insertInvestorDocumentSchema = createInsertSchema(investorDocuments).omit({ id: true, createdAt: true });
export const insertDistributionSchema = createInsertSchema(distributions).omit({ id: true, createdAt: true });
export const insertWaterfallTierSchema = createInsertSchema(waterfallTiers).omit({ id: true });
export const insertCapitalAccountSchema = createInsertSchema(capitalAccounts).omit({ id: true, createdAt: true });
export const insertPropertyMonthlyDataSchema = createInsertSchema(propertyMonthlyData).omit({ id: true, createdAt: true });
export const insertDealPipelineSchema = createInsertSchema(dealPipeline).omit({ id: true, createdAt: true, updatedAt: true });
export const insertInvestorLeadSchema = createInsertSchema(investorLeads).omit({ id: true, createdAt: true, updatedAt: true });
export const insertInvestorCommunicationSchema = createInsertSchema(investorCommunications).omit({ id: true, createdAt: true });
export const insertMaintenanceRequestSchema = createInsertSchema(maintenanceRequests).omit({ id: true, createdAt: true });
export const insertLoanSchema = createInsertSchema(loans).omit({ id: true, createdAt: true, updatedAt: true });

// === EXISTING TYPES ===
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type Property = typeof properties.$inferSelect;
export type InsertProperty = z.infer<typeof insertPropertySchema>;
export type Investor = typeof investors.$inferSelect;
export type InsertInvestor = z.infer<typeof insertInvestorSchema>;
export type Investment = typeof investments.$inferSelect;
export type InsertInvestment = z.infer<typeof insertInvestmentSchema>;
export type DashboardTask = typeof dashboardTasks.$inferSelect;
export type DashboardRehab = typeof dashboardRehab.$inferSelect;
export type DashboardGrowth = typeof dashboardGrowth.$inferSelect;
export type DashboardKpi = typeof dashboardKpis.$inferSelect;
export type DashboardMetric = typeof dashboardMetrics.$inferSelect;
export type DashboardActivityLog = typeof dashboardActivity.$inferSelect;

// === NEW MODULE TYPES ===
export type Worker = typeof workers.$inferSelect;
export type InsertWorker = z.infer<typeof insertWorkerSchema>;
export type PayrollEntry = typeof payrollEntries.$inferSelect;
export type InsertPayrollEntry = z.infer<typeof insertPayrollEntrySchema>;
export type PayrollPayment = typeof payrollPayments.$inferSelect;
export type InsertPayrollPayment = z.infer<typeof insertPayrollPaymentSchema>;
export type RehabLineItem = typeof rehabLineItems.$inferSelect;
export type InsertRehabLineItem = z.infer<typeof insertRehabLineItemSchema>;
export type RehabMaterial = typeof rehabMaterialLog.$inferSelect;
export type InsertRehabMaterial = z.infer<typeof insertRehabMaterialSchema>;
export type RehabPhoto = typeof rehabPhotos.$inferSelect;
export type InsertRehabPhoto = z.infer<typeof insertRehabPhotoSchema>;
export type UnitRentRoll = typeof unitRentRoll.$inferSelect;
export type InsertUnitRentRoll = z.infer<typeof insertUnitRentRollSchema>;
export type VacancyPipeline = typeof vacancyPipeline.$inferSelect;
export type InsertVacancyPipeline = z.infer<typeof insertVacancyPipelineSchema>;
export type TurnChecklist = typeof turnChecklist.$inferSelect;
export type InsertTurnChecklist = z.infer<typeof insertTurnChecklistSchema>;
export type PmNote = typeof pmNotes.$inferSelect;
export type InsertPmNote = z.infer<typeof insertPmNoteSchema>;
export type PmEscalation = typeof pmEscalations.$inferSelect;
export type InsertPmEscalation = z.infer<typeof insertPmEscalationSchema>;
export type SlaTimer = typeof slaTimers.$inferSelect;
export type InsertSlaTimer = z.infer<typeof insertSlaTimerSchema>;
export type InvestorDocument = typeof investorDocuments.$inferSelect;
export type InsertInvestorDocument = z.infer<typeof insertInvestorDocumentSchema>;
export type Distribution = typeof distributions.$inferSelect;
export type InsertDistribution = z.infer<typeof insertDistributionSchema>;
export type WaterfallTier = typeof waterfallTiers.$inferSelect;
export type InsertWaterfallTier = z.infer<typeof insertWaterfallTierSchema>;
export type CapitalAccount = typeof capitalAccounts.$inferSelect;
export type InsertCapitalAccount = z.infer<typeof insertCapitalAccountSchema>;
export type PropertyMonthlyData = typeof propertyMonthlyData.$inferSelect;
export type InsertPropertyMonthlyData = z.infer<typeof insertPropertyMonthlyDataSchema>;
export type DealPipelineDeal = typeof dealPipeline.$inferSelect;
export type InsertDealPipelineDeal = z.infer<typeof insertDealPipelineSchema>;
export type InvestorLead = typeof investorLeads.$inferSelect;
export type InsertInvestorLead = z.infer<typeof insertInvestorLeadSchema>;
export type InvestorCommunication = typeof investorCommunications.$inferSelect;
export type InsertInvestorCommunication = z.infer<typeof insertInvestorCommunicationSchema>;
export type MaintenanceRequest = typeof maintenanceRequests.$inferSelect;
export type InsertMaintenanceRequest = z.infer<typeof insertMaintenanceRequestSchema>;
export type Loan = typeof loans.$inferSelect;
export type InsertLoan = z.infer<typeof insertLoanSchema>;
