import { readFileSync } from 'fs';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import * as schema from '../shared/schema';
import { properties } from '../shared/schema';
import { eq } from 'drizzle-orm';

// Load .env manually
const envPath = new URL('../.env', import.meta.url);
const envContent = readFileSync(envPath, 'utf-8');
for (const line of envContent.split('\n')) {
  const [key, ...valueParts] = line.split('=');
  if (key && valueParts.length) {
    process.env[key.trim()] = valueParts.join('=').trim();
  }
}

neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

async function fixData() {
  console.log('Fixing property data...\n');

  // 1. Fix Hickory Landing location (Lakeland FL, not Denton TX)
  console.log('1. Fixing Hickory Landing location to Lakeland, FL...');
  await db.update(properties)
    .set({ city: 'Lakeland', state: 'FL', zipCode: '33801' })
    .where(eq(properties.name, 'Hickory Landing'));

  // 2. Fix acquisition dates for current properties (based on Excel "24 months" hold period = Jan 2024)
  console.log('2. Fixing acquisition dates for current properties...');

  // Sun Cove - acquired around Jan 2024
  await db.update(properties)
    .set({ acquisitionDate: new Date('2024-01-15') })
    .where(eq(properties.name, 'Sun Cove Apartments'));

  // Lucia - acquired around Jan 2024
  await db.update(properties)
    .set({ acquisitionDate: new Date('2024-02-01') })
    .where(eq(properties.name, 'Lucia Apartments'));

  // Hickory Landing - acquired around Jan 2024
  await db.update(properties)
    .set({ acquisitionDate: new Date('2024-03-01') })
    .where(eq(properties.name, 'Hickory Landing'));

  // MLK - acquired around Jan 2024
  await db.update(properties)
    .set({ acquisitionDate: new Date('2024-01-01') })
    .where(eq(properties.name, 'MLK Apartments'));

  console.log('\n✓ Data fixes complete!');

  // Verify
  const updated = await db.select().from(properties).where(eq(properties.status, 'current'));
  console.log('\nUpdated current properties:');
  for (const p of updated) {
    console.log(`  - ${p.name}: ${p.city}, ${p.state} | Acquired: ${p.acquisitionDate}`);
  }

  await pool.end();
}

fixData().catch(console.error);
