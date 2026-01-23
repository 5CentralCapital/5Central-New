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
