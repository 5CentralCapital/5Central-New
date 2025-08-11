import { type User, type InsertUser, type Property, type InsertProperty } from "@shared/schema";
import { randomUUID } from "crypto";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  getAllProperties(): Promise<Property[]>;
  getProperty(id: string): Promise<Property | undefined>;
  createProperty(property: InsertProperty): Promise<Property>;
  getCurrentProperties(): Promise<Property[]>;
  getSoldProperties(): Promise<Property[]>;
}

export class MemStorage implements IStorage {
  private users: Map<string, User>;
  private properties: Map<string, Property>;

  constructor() {
    this.users = new Map();
    this.properties = new Map();
    this.initializeProperties();
  }

  private initializeProperties() {
    // Initialize with real data from CSV
    const propertiesData: Omit<Property, 'id'>[] = [
      // Current properties
      {
        name: "157 Crystal Ave",
        address: "157 Crystal Ave",
        city: "New London",
        state: "CT",
        zipCode: "06320",
        units: 5,
        acquisitionDate: new Date("2023-06-01"),
        acquisitionPrice: "376000",
        rehabCosts: "10000",
        currentValue: "700000",
        salePrice: null,
        saleDate: null,
        totalCashflow: "72500",
        status: "current",
        ownershipStructure: "100% House Doctors",
        ownershipName: "House Doctors",
        yearsHeld: "1.5",
        irr: "15.5",
        equityMultiple: "3.31",
        noi: "72500",
        debtService: "57000",
        cashflow: "15500",
      },
      {
        name: "1 Harmony St",
        address: "1 Harmony St",
        city: "Stonington",
        state: "CT",
        zipCode: "06378",
        units: 4,
        acquisitionDate: new Date("2024-10-01"),
        acquisitionPrice: "1075000",
        rehabCosts: "80000",
        currentValue: "1500000",
        salePrice: null,
        saleDate: null,
        totalCashflow: "119000",
        status: "current",
        ownershipStructure: "100% 5Central Capital",
        ownershipName: "5Central Capital",
        yearsHeld: "0.2",
        irr: "21.8",
        equityMultiple: "2.74",
        noi: "119000",
        debtService: "97200",
        cashflow: "21800",
      },
      {
        name: "3408 E Dr MLK BLVD",
        address: "3408 E Dr MLK BLVD",
        city: "Tampa",
        state: "FL",
        zipCode: "33610",
        units: 10,
        acquisitionDate: new Date("2024-11-01"),
        acquisitionPrice: "750000",
        rehabCosts: "450000",
        currentValue: "1900000",
        salePrice: null,
        saleDate: null,
        totalCashflow: "135000",
        status: "current",
        ownershipStructure: "100% 5Central Capital",
        ownershipName: "5Central Capital",
        yearsHeld: "0.3",
        irr: "-1.1",
        equityMultiple: "5.64",
        noi: "135000",
        debtService: "148200",
        cashflow: "-13200",
      },
      // Sold properties
      {
        name: "41 Stuart Ave",
        address: "41 Stuart Ave",
        city: "New London",
        state: "CT",
        zipCode: "06320",
        units: 3,
        acquisitionDate: new Date("2020-05-01"),
        acquisitionPrice: "195000",
        rehabCosts: "20000",
        currentValue: "375000",
        salePrice: "375000",
        saleDate: new Date("2024-05-01"),
        totalCashflow: "144000",
        status: "sold",
        ownershipStructure: "100% by 5Central Rentals LLC",
        ownershipName: "Michael McElwee",
        yearsHeld: "4.0",
        irr: "85.3",
        equityMultiple: "3.04",
        noi: "36000",
        debtService: "0",
        cashflow: "36000",
      },
      {
        name: "52 Summit Ave",
        address: "52 Summit Ave",
        city: "New London",
        state: "CT",
        zipCode: "06320",
        units: 2,
        acquisitionDate: new Date("2022-07-01"),
        acquisitionPrice: "315000",
        rehabCosts: "10000",
        currentValue: "375000",
        salePrice: "375000",
        saleDate: new Date("2024-10-01"),
        totalCashflow: "48000",
        status: "sold",
        ownershipStructure: "100% by 5Central Rentals LLC",
        ownershipName: "5Central Rentals",
        yearsHeld: "2.3",
        irr: "42.1",
        equityMultiple: "2.98",
        noi: "24000",
        debtService: "0",
        cashflow: "24000",
      },
    ];

    propertiesData.forEach(propertyData => {
      const id = randomUUID();
      const property: Property = { id, ...propertyData };
      this.properties.set(id, property);
    });
  }

  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username,
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    const user: User = { ...insertUser, id };
    this.users.set(id, user);
    return user;
  }

  async getAllProperties(): Promise<Property[]> {
    return Array.from(this.properties.values());
  }

  async getProperty(id: string): Promise<Property | undefined> {
    return this.properties.get(id);
  }

  async createProperty(insertProperty: InsertProperty): Promise<Property> {
    const id = randomUUID();
    const property: Property = { id, ...insertProperty };
    this.properties.set(id, property);
    return property;
  }

  async getCurrentProperties(): Promise<Property[]> {
    return Array.from(this.properties.values()).filter(p => p.status === "current");
  }

  async getSoldProperties(): Promise<Property[]> {
    return Array.from(this.properties.values()).filter(p => p.status === "sold");
  }
}

export const storage = new MemStorage();
