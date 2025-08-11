import { sql } from "drizzle-orm";
import { pgTable, text, varchar, decimal, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
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
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export const insertPropertySchema = createInsertSchema(properties).omit({
  id: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type Property = typeof properties.$inferSelect;
export type InsertProperty = z.infer<typeof insertPropertySchema>;
