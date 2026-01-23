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

async function verify() {
  const allProperties = await db.select().from(properties);

  console.log(`\n=== DATABASE VERIFICATION ===`);
  console.log(`Total properties: ${allProperties.length}\n`);

  const current = allProperties.filter(p => p.status === 'current');
  const sold = allProperties.filter(p => p.status === 'sold');

  console.log(`CURRENT HOLDINGS (${current.length}):`);
  for (const p of current) {
    console.log(`  - ${p.name} | ${p.units} units | ${p.city}, ${p.state}`);
    console.log(`    Acquisition: $${Number(p.acquisitionPrice).toLocaleString()} | ARV: $${Number(p.currentValue).toLocaleString()}`);
    console.log(`    NOI: $${Number(p.noi).toLocaleString()} | Debt Service: $${Number(p.debtService).toLocaleString()} | Cashflow: $${Number(p.cashflow).toLocaleString()}`);
  }

  console.log(`\nSUCCESSFUL EXITS (${sold.length}):`);
  for (const p of sold) {
    console.log(`  - ${p.name} | ${p.units} units | ${p.city}, ${p.state}`);
    console.log(`    Bought: $${Number(p.acquisitionPrice).toLocaleString()} | Sold: $${Number(p.salePrice).toLocaleString()}`);
    console.log(`    IRR: ${Number(p.irr).toFixed(1)}% | Equity Multiple: ${Number(p.equityMultiple).toFixed(2)}x`);
  }

  await pool.end();
}

verify().catch(console.error);
