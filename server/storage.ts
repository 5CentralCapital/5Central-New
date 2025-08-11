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
        yearsHeld: "2.25",
        irr: "42.1",
        equityMultiple: "3.27",
        noi: "24000",
        debtService: "0",
        cashflow: "24000",
      },
      {
        name: "29 Brainard St",
        address: "29 Brainard St",
        city: "New London",
        state: "CT",
        zipCode: "06320",
        units: 1,
        acquisitionDate: new Date("2022-01-19"),
        acquisitionPrice: "329000",
        rehabCosts: "0",
        currentValue: "375000",
        salePrice: "375000",
        saleDate: new Date("2025-01-01"),
        totalCashflow: "30000",
        status: "sold",
        ownershipStructure: "House Doctors LLC",
        ownershipName: "House Doctors LLC",
        yearsHeld: "2.95",
        irr: "28.5",
        equityMultiple: "6.33",
        noi: "10000",
        debtService: "0",
        cashflow: "10000",
      },
      {
        name: "25 Huntington Pl",
        address: "25 Huntington Pl",
        city: "Norwich",
        state: "CT",
        zipCode: "06360",
        units: 1,
        acquisitionDate: new Date("2023-09-01"),
        acquisitionPrice: "319000",
        rehabCosts: "0",
        currentValue: "350000",
        salePrice: "350000",
        saleDate: new Date("2025-03-01"),
        totalCashflow: "36000",
        status: "sold",
        ownershipStructure: "100% by 5Central Rentals LLC",
        ownershipName: "175 Crystal Ave LLC",
        yearsHeld: "1.50",
        irr: "15.2",
        equityMultiple: "0.67",
        noi: "24000",
        debtService: "0",
        cashflow: "24000",
      },
      {
        name: "175 Crystal Ave",
        address: "175 Crystal Ave",
        city: "New London",
        state: "CT",
        zipCode: "06320",
        units: 2,
        acquisitionDate: new Date("2023-10-21"),
        acquisitionPrice: "280000",
        rehabCosts: "0",
        currentValue: "425000",
        salePrice: "425000",
        saleDate: new Date("2025-05-01"),
        totalCashflow: "97000",
        status: "sold",
        ownershipStructure: "100% by 5Central Rentals LLC",
        ownershipName: "5Central Rentals",
        yearsHeld: "1.53",
        irr: "95.4",
        equityMultiple: "9.68",
        noi: "48500",
        debtService: "0",
        cashflow: "48500",
      },
      {
        name: "35 Linden St",
        address: "35 Linden St",
        city: "New London",
        state: "CT",
        zipCode: "06320",
        units: 3,
        acquisitionDate: new Date("2023-11-01"),
        acquisitionPrice: "385000",
        rehabCosts: "0",
        currentValue: "440000",
        salePrice: "440000",
        saleDate: new Date("2025-04-01"),
        totalCashflow: "84000",
        status: "sold",
        ownershipStructure: "100% by 5Central Rentals LLC",
        ownershipName: "175 Crystal Ave LLC",
        yearsHeld: "1.42",
        irr: "27.8",
        equityMultiple: "1.23",
        noi: "28000",
        debtService: "0",
        cashflow: "28000",
      },
      {
        name: "145 Crystal Ave",
        address: "145 Crystal Ave",
        city: "New London",
        state: "CT",
        zipCode: "06320",
        units: 3,
        acquisitionDate: new Date("2022-11-01"),
        acquisitionPrice: "210000",
        rehabCosts: "50000",
        currentValue: "335000",
        salePrice: "335000",
        saleDate: new Date("2025-04-01"),
        totalCashflow: "90000",
        status: "sold",
        ownershipStructure: "100% by 5Central Rentals LLC",
        ownershipName: "175 Crystal Ave LLC",
        yearsHeld: "2.41",
        irr: "32.1",
        equityMultiple: "1.52",
        noi: "30000",
        debtService: "0",
        cashflow: "30000",
      },
      {
        name: "149 Crystal Ave",
        address: "149 Crystal Ave",
        city: "New London",
        state: "CT",
        zipCode: "06320",
        units: 3,
        acquisitionDate: new Date("2023-02-01"),
        acquisitionPrice: "230000",
        rehabCosts: "50000",
        currentValue: "335000",
        salePrice: "335000",
        saleDate: new Date("2025-04-01"),
        totalCashflow: "90000",
        status: "sold",
        ownershipStructure: "100% by 5Central Rentals LLC",
        ownershipName: "175 Crystal Ave LLC",
        yearsHeld: "2.16",
        irr: "28.7",
        equityMultiple: "1.26",
        noi: "30000",
        debtService: "0",
        cashflow: "30000",
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
