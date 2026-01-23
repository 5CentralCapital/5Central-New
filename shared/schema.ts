import { sql } from "drizzle-orm";
import { pgTable, text, varchar, decimal, integer, timestamp } from "drizzle-orm/pg-core";
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
});

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

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type Property = typeof properties.$inferSelect;
export type InsertProperty = z.infer<typeof insertPropertySchema>;
export type Investor = typeof investors.$inferSelect;
export type InsertInvestor = z.infer<typeof insertInvestorSchema>;
export type Investment = typeof investments.$inferSelect;
export type InsertInvestment = z.infer<typeof insertInvestmentSchema>;
