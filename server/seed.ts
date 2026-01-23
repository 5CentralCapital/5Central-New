import 'dotenv/config';
import { db } from './db';
import { users, investors } from '@shared/schema';
import { scrypt, randomBytes } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString('hex')}.${salt}`;
}

async function seed() {
  console.log('Seeding database with test users...');

  try {
    // Create admin user
    const adminPassword = await hashPassword('password');
    const [adminUser] = await db.insert(users).values({
      email: 'michael@5central.capital',
      password: adminPassword,
      role: 'admin',
      firstName: 'Michael',
      lastName: 'McElwee',
    }).onConflictDoNothing().returning();

    if (adminUser) {
      console.log('Created admin user:', adminUser.email);
    } else {
      console.log('Admin user already exists');
    }

    // Create investor user
    const investorPassword = await hashPassword('password');
    const [investorUser] = await db.insert(users).values({
      email: 'investor@test.com',
      password: investorPassword,
      role: 'investor',
      firstName: 'John',
      lastName: 'Doe',
    }).onConflictDoNothing().returning();

    if (investorUser) {
      console.log('Created investor user:', investorUser.email);

      // Create investor profile
      await db.insert(investors).values({
        userId: investorUser.id,
        accreditedStatus: 'verified',
        investedAmount: '250000',
        phone: '555-123-4567',
      });
      console.log('Created investor profile for:', investorUser.email);
    } else {
      console.log('Investor user already exists');
    }

    console.log('Seeding complete!');
    console.log('\nTest accounts:');
    console.log('  Admin: michael@5central.capital / password');
    console.log('  Investor: investor@test.com / password');

  } catch (error) {
    console.error('Seeding error:', error);
    throw error;
  }

  process.exit(0);
}

seed();
