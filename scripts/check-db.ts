import { readFileSync } from 'fs';

// Load .env manually
const envPath = new URL('../.env', import.meta.url);
const envContent = readFileSync(envPath, 'utf-8');
for (const line of envContent.split('\n')) {
  const [key, ...valueParts] = line.split('=');
  if (key && valueParts.length) {
    process.env[key.trim()] = valueParts.join('=').trim();
  }
}

import { db } from "../server/db";
import { properties } from "../shared/schema";

async function checkDatabase() {
  try {
    const allProperties = await db.select().from(properties);
    console.log(`Found ${allProperties.length} properties:`);
    allProperties.forEach(p => {
      console.log(`- ${p.name} | ${p.city}, ${p.state} | ${p.status}`);
    });
    process.exit(0);
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

checkDatabase();
