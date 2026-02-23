import 'dotenv/config';
import { db } from './db';
import { users, investors, investments } from '@shared/schema';
import { scrypt, randomBytes } from 'crypto';
import { promisify } from 'util';
import { eq } from 'drizzle-orm';

const scryptAsync = promisify(scrypt);

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString('hex')}.${salt}`;
}

// Convert Excel serial date to JS Date
function excelDateToJS(serial: number): Date {
  return new Date((serial - 25569) * 86400 * 1000);
}

interface InvestorData {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  investorType?: 'deal-investor' | 'company-partner';
  companyEquityPercentage?: number;
  investments: {
    propertyName: string;
    propertyAddress?: string;
    principal: number;
    balloonAmount?: number;
    monthlyPayment?: number;
    returnMultiple?: number;
    interestRate?: number;
    effectiveDate?: Date;
    maturityDate?: Date;
    term: string;
    investmentType: 'deal-specific' | 'general' | 'equity';
    notes?: string;
    // Equity investment fields
    equityPercentage?: number;
    initialInvestment?: number;
    currentEquityValue?: number;
    cashOutAtRefi?: number;
    projectedExitValue?: number;
    equityMultiple?: number;
  }[];
}

const investorData: InvestorData[] = [
  {
    firstName: 'Benny',
    lastName: 'Duverge',
    email: 'benny.com@icloud.com',
    phone: '860-389-7036',
    investments: [
      {
        propertyName: 'Sun Cove Apartments',
        propertyAddress: '5633 Crissman Dr N & 5680 28th St, St Petersburg, FL',
        principal: 20000,
        balloonAmount: 32000,
        returnMultiple: 1.6,
        effectiveDate: excelDateToJS(45656),
        term: '12 mo',
        investmentType: 'deal-specific',
        notes: 'Balloon at refi',
      },
    ],
  },
  {
    firstName: 'Mercedes',
    lastName: 'Gonzalez',
    email: 'mercedesgonzalez531@gmail.com',
    phone: '+1 (203) 954-9773',
    investments: [
      {
        propertyName: 'Sun Cove Apartments',
        propertyAddress: '5633 Crissman Dr N & 5680 28th St, St Petersburg, FL',
        principal: 39000,
        balloonAmount: 78000,
        returnMultiple: 2.0,
        effectiveDate: excelDateToJS(45604),
        term: '12 mo',
        investmentType: 'deal-specific',
        notes: 'Balloon at refi',
      },
    ],
  },
  {
    firstName: 'Marquez',
    lastName: 'Hamilton',
    email: 'marquezhamilton13@gmail.com',
    phone: '860-235-1263',
    investments: [
      {
        propertyName: 'Sun Cove Apartments',
        propertyAddress: '5633 Crissman Dr N & 5680 28th St, St Petersburg, FL',
        principal: 15000,
        balloonAmount: 30000,
        returnMultiple: 2.0,
        effectiveDate: excelDateToJS(46036),
        term: '12 mo',
        investmentType: 'deal-specific',
        notes: 'Per Sun Cove investor section',
      },
      {
        propertyName: 'Lucia Apartments',
        propertyAddress: 'Winter Haven, FL',
        principal: 25000,
        balloonAmount: 50000,
        returnMultiple: 2.0,
        effectiveDate: excelDateToJS(46031),
        term: '12 mo',
        investmentType: 'deal-specific',
        notes: 'Balloon at maturity 01/08/2027',
      },
    ],
  },
  {
    firstName: 'Mahendra',
    lastName: 'Patel',
    email: 'mpatel90@yahoo.com',
    phone: '860-501-2922',
    investments: [
      {
        propertyName: 'Sun Cove Apartments',
        propertyAddress: '5633 Crissman Dr N & 5680 28th St, St Petersburg, FL',
        principal: 35000,
        balloonAmount: 70000,
        returnMultiple: 2.0,
        effectiveDate: excelDateToJS(46036),
        term: '12 mo',
        investmentType: 'deal-specific',
        notes: 'Per Sun Cove investor section',
      },
    ],
  },
  {
    firstName: 'Vishwa',
    lastName: 'Patel',
    email: 'vishp203@gmail.com',
    phone: '+1 (860) 268-0567',
    investments: [
      {
        propertyName: 'Lucia Apartments',
        propertyAddress: 'Winter Haven, FL',
        principal: 32500,
        monthlyPayment: 1046.79,
        effectiveDate: excelDateToJS(46032),
        maturityDate: excelDateToJS(46784),
        term: '24 mo',
        investmentType: 'deal-specific',
        notes: 'Monthly payments (not balloon)',
      },
    ],
  },
  {
    firstName: 'Coty',
    lastName: 'Roberts',
    email: 'coty.roberts@gmail.com',
    phone: '+1 (860) 617-7053',
    investments: [
      {
        propertyName: 'Lucia Apartments',
        propertyAddress: 'Winter Haven, FL',
        principal: 50000,
        monthlyPayment: 1575.46,
        effectiveDate: excelDateToJS(46032),
        maturityDate: excelDateToJS(46784),
        term: '24 mo',
        investmentType: 'deal-specific',
        notes: 'Monthly payments (not balloon)',
      },
    ],
  },
  {
    firstName: 'Hector',
    lastName: 'Mesa',
    email: 'hector.mesa@email.com',
    investments: [
      {
        propertyName: 'Sun Cove Apartments',
        propertyAddress: '5633 Crissman Dr N & 5680 28th St, St Petersburg, FL',
        principal: 0,
        term: 'Equity',
        investmentType: 'equity',
        notes: '20% equity ownership in Sun Cove via Arcadia Vision Group',
        // Equity investment fields (from One Page Finances Excel)
        equityPercentage: 0.20,
        initialInvestment: 120000,
        currentEquityValue: 252000, // (4,200,000 - 2,940,000) × 20%
        cashOutAtRefi: 116219,      // 20% of $581,095 total cash-out at refi
        projectedExitValue: 218400, // 20% of $1,092,000 net sale proceeds
        equityMultiple: 5.30,       // Deal equity multiple
      },
    ],
  },
  {
    firstName: 'Pilar',
    lastName: 'Bailon',
    email: 'pilar.bailon@email.com',
    investments: [
      {
        propertyName: '5Central Capital - General',
        principal: 100000,
        monthlyPayment: 2169.85,
        interestRate: 0.2183,
        effectiveDate: new Date('2026-01-01'),
        term: 'Amortizing',
        investmentType: 'general',
        notes: 'Pilar & Jozeph Bailon. Payments start April 2026. Interest accrues Jan-Mar 2026 (deferral).',
      },
      {
        propertyName: '5Central Capital - Legacy',
        principal: 85000,
        monthlyPayment: 2330.15,
        interestRate: 0.3142,
        effectiveDate: new Date('2023-01-01'),
        term: 'Amortizing',
        investmentType: 'general',
        notes: 'Pilar Bailon (Legacy). Legacy loan from 2023.',
      },
    ],
  },
  {
    firstName: 'Teresa',
    lastName: 'Bailon',
    email: 'teresa.bailon@email.com',
    investments: [
      {
        propertyName: '5Central Capital - General',
        principal: 50000,
        monthlyPayment: 1667,
        interestRate: 0.3916,
        effectiveDate: new Date('2023-01-01'),
        term: 'Amortizing',
        investmentType: 'general',
        notes: 'Legacy loan from 2023.',
      },
    ],
  },
  {
    firstName: 'Jozeph',
    lastName: 'Bailon',
    email: 'jozephbailon@gmail.com',
    phone: '860-405-4132',
    investorType: 'company-partner',
    companyEquityPercentage: 0.20, // 20% company partner in 5Central Capital
    investments: [], // Company partners don't have deal-specific investments
  },
];

async function seed() {
  console.log('Seeding real investor data...\n');

  const defaultPassword = await hashPassword('investor123');

  for (const data of investorData) {
    console.log(`Processing: ${data.firstName} ${data.lastName}`);

    // Check if user already exists
    const existingUser = await db.select().from(users).where(eq(users.email, data.email));

    let userId: string;
    let investorId: string;

    if (existingUser.length > 0) {
      console.log(`  User already exists, updating...`);
      userId = existingUser[0].id;

      // Get or create investor profile
      const existingInvestor = await db.select().from(investors).where(eq(investors.userId, userId));
      if (existingInvestor.length > 0) {
        investorId = existingInvestor[0].id;
      } else {
        const totalInvested = data.investments.reduce((sum, inv) => sum + (inv.initialInvestment || inv.principal), 0);
        const [investor] = await db.insert(investors).values({
          userId,
          accreditedStatus: 'verified',
          investedAmount: totalInvested.toString(),
          phone: data.phone,
          investorType: data.investorType || 'deal-investor',
          companyEquityPercentage: data.companyEquityPercentage?.toString(),
        }).returning();
        investorId = investor.id;
      }
    } else {
      // Create user
      const [user] = await db.insert(users).values({
        email: data.email,
        password: defaultPassword,
        role: 'investor',
        firstName: data.firstName,
        lastName: data.lastName,
      }).returning();
      userId = user.id;
      console.log(`  Created user: ${data.email}`);

      // Create investor profile
      const totalInvested = data.investments.reduce((sum, inv) => sum + (inv.initialInvestment || inv.principal), 0);
      const [investor] = await db.insert(investors).values({
        userId,
        accreditedStatus: 'verified',
        investedAmount: totalInvested.toString(),
        phone: data.phone,
        investorType: data.investorType || 'deal-investor',
        companyEquityPercentage: data.companyEquityPercentage?.toString(),
      }).returning();
      investorId = investor.id;
      console.log(`  Created investor profile (${data.investorType || 'deal-investor'})`);
    }

    // Create investments (skip if already exists for this investor + property combo)
    const existingInvestments = await db.select().from(investments).where(eq(investments.investorId, investorId));
    for (const inv of data.investments) {
      const alreadyExists = existingInvestments.some(
        e => e.propertyName === inv.propertyName && e.principal === inv.principal.toString()
      );
      if (alreadyExists) {
        console.log(`  Skipped (already exists): ${inv.propertyName} - $${inv.principal.toLocaleString()}`);
        continue;
      }
      await db.insert(investments).values({
        investorId,
        propertyName: inv.propertyName,
        propertyAddress: inv.propertyAddress,
        principal: inv.principal.toString(),
        balloonAmount: inv.balloonAmount?.toString(),
        monthlyPayment: inv.monthlyPayment?.toString(),
        returnMultiple: inv.returnMultiple?.toString(),
        interestRate: inv.interestRate?.toString(),
        effectiveDate: inv.effectiveDate,
        maturityDate: inv.maturityDate,
        term: inv.term,
        status: 'active',
        investmentType: inv.investmentType,
        notes: inv.notes,
        // Equity investment fields
        equityPercentage: inv.equityPercentage?.toString(),
        initialInvestment: inv.initialInvestment?.toString(),
        currentEquityValue: inv.currentEquityValue?.toString(),
        cashOutAtRefi: inv.cashOutAtRefi?.toString(),
        projectedExitValue: inv.projectedExitValue?.toString(),
        equityMultiple: inv.equityMultiple?.toString(),
      });
      const amount = inv.initialInvestment || inv.principal;
      console.log(`  Added investment: ${inv.propertyName} - $${amount.toLocaleString()}${inv.investmentType === 'equity' ? ' (equity)' : ''}`);
    }
  }

  // Keep the admin user
  const adminExists = await db.select().from(users).where(eq(users.email, 'michael@5central.capital'));
  if (adminExists.length === 0) {
    const adminPassword = await hashPassword('password');
    await db.insert(users).values({
      email: 'michael@5central.capital',
      password: adminPassword,
      role: 'admin',
      firstName: 'Michael',
      lastName: 'McElwee',
    });
    console.log('\nCreated admin user: michael@5central.capital');
  }

  console.log('\n✓ Seeding complete!');
  console.log('\nInvestor accounts created with password: investor123');
  console.log('Admin account: michael@5central.capital / password');

  process.exit(0);
}

seed().catch((e) => {
  console.error('Seeding error:', e);
  process.exit(1);
});
