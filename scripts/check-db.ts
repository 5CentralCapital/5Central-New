import { readFileSync } from 'fs';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import * as schema from '../shared/schema';
import { properties } from '../shared/schema';

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

async function checkDatabase() {
  try {
    const allProperties = await db.select().from(properties);
    console.log(`Found ${allProperties.length} properties:\n`);

    console.log('=== Current Properties ===');
    allProperties.filter(p => p.status === 'current').forEach(p => {
      console.log(`${p.name}:`);
      console.log(`  Location: ${p.city}, ${p.state}`);
      console.log(`  Acquisition: ${p.acquisitionDate}`);
      console.log(`  Purchase: $${p.acquisitionPrice?.toLocaleString()}`);
      console.log(`  Rehab: $${p.rehabCosts?.toLocaleString()}`);
      console.log(`  ARV: $${p.currentValue?.toLocaleString()}`);
      console.log(`  NOI: $${p.noi?.toLocaleString()}`);
      console.log('');
    });

    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error("Error:", error);
    await pool.end();
    process.exit(1);
  }
}

checkDatabase();
