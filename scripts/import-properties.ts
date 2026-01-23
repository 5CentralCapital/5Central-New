import XLSX from 'xlsx';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import * as schema from '../shared/schema';
import { properties } from '../shared/schema';
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

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

// Convert Excel serial date to JavaScript Date
function excelDateToJS(serial: number): Date {
  // Excel dates start from Jan 1, 1900 (serial 1)
  // But Excel incorrectly treats 1900 as a leap year, so subtract 1 for dates after Feb 28, 1900
  const utc_days = Math.floor(serial - 25569);
  const utc_value = utc_days * 86400;
  return new Date(utc_value * 1000);
}

// Parse sold properties from REO sheet
function parseSoldProperties(workbook: XLSX.WorkBook) {
  const sheet = workbook.Sheets['REO'];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][];

  const soldProperties: any[] = [];

  // Process 2026 sold property (row 4)
  const row2026 = data[4];
  if (row2026 && row2026[2]) {
    soldProperties.push({
      name: row2026[2],
      address: row2026[4]?.trim() || row2026[2],
      city: row2026[5]?.trim() || '',
      state: row2026[6]?.trim() || '',
      zipCode: String(row2026[7] || '').trim(),
      units: row2026[3] || 1,
      ownershipStructure: row2026[8]?.trim() || '',
      ownershipName: row2026[9]?.trim() || '',
      acquisitionDate: excelDateToJS(row2026[10]),
      acquisitionPrice: row2026[11] || 0,
      rehabCosts: row2026[12] || 0,
      salePrice: row2026[13] || 0,
      totalCashflow: row2026[15] || 0,
      yearsHeld: row2026[17] || 0,
      equityMultiple: row2026[19] || 0,
      irr: row2026[21] ? row2026[21] * 100 : 0, // Convert to percentage
      status: 'sold',
      saleDate: new Date(), // 2026
    });
  }

  // Process 2025 sold properties (rows 14-22)
  for (let i = 14; i <= 22; i++) {
    const row = data[i];
    if (row && row[2] && typeof row[2] === 'string') {
      soldProperties.push({
        name: row[2],
        address: row[4]?.trim() || row[2],
        city: row[5]?.trim() || '',
        state: row[6]?.replace('`', '').trim() || '', // Remove backticks
        zipCode: String(row[7] || '').trim(),
        units: row[3] || 1,
        ownershipStructure: row[8]?.trim() || '',
        ownershipName: row[9]?.trim() || '',
        acquisitionDate: excelDateToJS(row[10]),
        acquisitionPrice: row[11] || 0,
        rehabCosts: row[12] || 0,
        salePrice: row[13] || 0,
        totalCashflow: row[15] || 0,
        yearsHeld: row[17] || 0,
        equityMultiple: row[19] || 0,
        irr: row[21] ? row[21] * 100 : 0, // Convert to percentage
        status: 'sold',
        saleDate: new Date('2025-01-01'), // 2025 sales
      });
    }
  }

  return soldProperties;
}

// Parse current properties from Portfolio Overview
function parseCurrentProperties(workbook: XLSX.WorkBook) {
  const sheet = workbook.Sheets['Portfolio Overview'];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][];

  // Property details from rows 41-44 (RETURN METRICS section)
  // Row 40 has headers, rows 41-44 have data
  const propertyRows = [
    { row: 41, name: 'Sun Cove Apartments', address: '1701 Crissman Dr & 28th St', city: 'Tampa', state: 'FL', zip: '33605' },
    { row: 42, name: 'Lucia Apartments', address: '669 Ave B NW', city: 'Winter Haven', state: 'FL', zip: '33881' },
    { row: 43, name: 'Hickory Landing', address: '2006 W Hickory St', city: 'Denton', state: 'TX', zip: '76201' },
    { row: 44, name: 'MLK Apartments', address: '3408 E Dr MLK Blvd', city: 'Tampa', state: 'FL', zip: '33610' },
  ];

  // NOI and debt service from rows 15-18
  const noiData: Record<string, { noi: number; debtService: number; cashflow: number }> = {};
  for (let i = 15; i <= 18; i++) {
    const row = data[i];
    if (row && row[0]) {
      noiData[row[0]] = {
        noi: row[1] || 0,
        debtService: row[6] || 0,
        cashflow: row[7] || 0,
      };
    }
  }

  // Unit counts from rows 53-56
  const unitData: Record<string, { units: number; occupancy: number }> = {};
  for (let i = 53; i <= 56; i++) {
    const row = data[i];
    if (row && row[0]) {
      unitData[row[0]] = {
        units: row[1] || 0,
        occupancy: row[3] || 0,
      };
    }
  }

  const currentProperties: any[] = [];

  for (const prop of propertyRows) {
    const row = data[prop.row];
    if (!row) continue;

    const noi = noiData[prop.name] || { noi: 0, debtService: 0, cashflow: 0 };
    const units = unitData[prop.name] || { units: 10, occupancy: 0 };

    // Row structure (from row 40 headers):
    // 0: Property, 1: Total Basis, 2: Sponsor Equity, 3: Equity Multiple, 4: Cash-on-Cash (Refi),
    // 5: Cash-on-Cash (Sale), 6: Cash-Out at Refi, 7: Net Cash from Sale, 8: Total Profit,
    // 9: Hold Period, 10: Purchase Price, 11: Rehab, 12: ARV

    currentProperties.push({
      name: prop.name,
      address: prop.address,
      city: prop.city,
      state: prop.state,
      zipCode: prop.zip,
      units: units.units,
      ownershipStructure: '100% 5Central Capital',
      ownershipName: '5Central Capital',
      acquisitionDate: new Date('2024-01-15'), // Approximate - 24 months ago per "Hold Period"
      acquisitionPrice: row[10] || 0, // Purchase Price
      rehabCosts: row[11] || 0, // Rehab
      currentValue: row[12] || 0, // ARV
      totalCashflow: noi.cashflow * 2 || 0, // 2 years of cashflow
      yearsHeld: 2, // 24 months
      equityMultiple: row[3] || 0,
      irr: 0, // Not sold yet
      noi: noi.noi,
      debtService: noi.debtService,
      cashflow: noi.cashflow,
      status: 'current',
    });
  }

  return currentProperties;
}

async function importProperties() {
  console.log('Starting property import...\n');

  // Read Excel files
  const soldWorkbook = XLSX.readFile('/Users/michaelmcelwee/Downloads/sold properties.xlsx');
  const currentWorkbook = XLSX.readFile('/Users/michaelmcelwee/Downloads/one page finances.xlsx');

  // Parse properties
  const soldProperties = parseSoldProperties(soldWorkbook);
  const currentProperties = parseCurrentProperties(currentWorkbook);

  console.log(`Found ${soldProperties.length} sold properties`);
  console.log(`Found ${currentProperties.length} current properties\n`);

  // Clear existing properties
  console.log('Clearing existing properties...');
  await db.delete(properties);

  // Insert sold properties
  console.log('\nInserting sold properties:');
  for (const prop of soldProperties) {
    console.log(`  - ${prop.name} (${prop.units} units, ${prop.city}, ${prop.state})`);
    await db.insert(properties).values(prop);
  }

  // Insert current properties
  console.log('\nInserting current properties:');
  for (const prop of currentProperties) {
    console.log(`  - ${prop.name} (${prop.units} units, ${prop.city}, ${prop.state})`);
    await db.insert(properties).values(prop);
  }

  console.log('\n✓ Import complete!');
  console.log(`Total: ${soldProperties.length + currentProperties.length} properties imported`);

  await pool.end();
}

importProperties().catch(console.error);
