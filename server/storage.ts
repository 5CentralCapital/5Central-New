import { type User, type InsertUser, type Property, type InsertProperty, type Investor, type InsertInvestor, type Investment, users, properties, investors, investments } from "@shared/schema";
import { db } from "./db";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "crypto";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  getAllProperties(): Promise<Property[]>;
  getProperty(id: string): Promise<Property | undefined>;
  getPropertyByName(name: string): Promise<Property | undefined>;
  createProperty(property: InsertProperty): Promise<Property>;
  getCurrentProperties(): Promise<Property[]>;
  getSoldProperties(): Promise<Property[]>;
  getInvestorByUserId(userId: string): Promise<Investor | undefined>;
  createInvestor(investor: InsertInvestor): Promise<Investor>;
  getInvestmentsByInvestorId(investorId: string): Promise<Investment[]>;
  getPropertiesByNames(names: string[]): Promise<Property[]>;
  getAllInvestors(): Promise<Investor[]>;
  getPortfolioMetrics(): Promise<{ totalValue: number; totalEquity: number; propertyCount: number }>;
}

export class DatabaseStorage implements IStorage {
  constructor() {}

  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(insertUser)
      .returning();
    return user;
  }

  async getInvestorByUserId(userId: string): Promise<Investor | undefined> {
    const [investor] = await db.select().from(investors).where(eq(investors.userId, userId));
    return investor || undefined;
  }

  async createInvestor(insertInvestor: InsertInvestor): Promise<Investor> {
    const [investor] = await db
      .insert(investors)
      .values(insertInvestor)
      .returning();
    return investor;
  }

  async getAllProperties(): Promise<Property[]> {
    return await db.select().from(properties);
  }

  async getProperty(id: string): Promise<Property | undefined> {
    const [property] = await db.select().from(properties).where(eq(properties.id, id));
    return property || undefined;
  }

  async createProperty(insertProperty: InsertProperty): Promise<Property> {
    const [property] = await db
      .insert(properties)
      .values(insertProperty)
      .returning();
    return property;
  }

  async getCurrentProperties(): Promise<Property[]> {
    return await db.select().from(properties).where(eq(properties.status, "current"));
  }

  async getSoldProperties(): Promise<Property[]> {
    return await db.select().from(properties).where(eq(properties.status, "sold"));
  }

  async getInvestmentsByInvestorId(investorId: string): Promise<Investment[]> {
    return await db.select().from(investments).where(eq(investments.investorId, investorId));
  }

  async getPropertyByName(name: string): Promise<Property | undefined> {
    const [property] = await db.select().from(properties).where(eq(properties.name, name));
    return property || undefined;
  }

  async getPropertiesByNames(names: string[]): Promise<Property[]> {
    if (names.length === 0) return [];
    return await db.select().from(properties).where(inArray(properties.name, names));
  }

  async getAllInvestors(): Promise<Investor[]> {
    return await db.select().from(investors);
  }

  async getPortfolioMetrics(): Promise<{ totalValue: number; totalEquity: number; propertyCount: number }> {
    const allProperties = await this.getCurrentProperties();
    const totalValue = allProperties.reduce((sum, p) => sum + parseFloat(p.currentValue || "0"), 0);
    const totalDebt = allProperties.reduce((sum, p) => sum + parseFloat(p.currentDebt || "0"), 0);
    const totalEquity = totalValue - totalDebt;
    return {
      totalValue,
      totalEquity,
      propertyCount: allProperties.length,
    };
  }
}

export const storage = new DatabaseStorage();
