/**
 * Seed LIVE tenant data from Rent Manager PDF exports (02/22/2026)
 * Sources: Rent Roll & Recurring Charges, Vacancy Report, Delinquency Report
 */
const { Pool } = require("@neondatabase/serverless");
require("dotenv").config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Property IDs from database
const PROPS = {
  MLK: "ea28fe29-c3e4-4ccd-a68d-a38dbd6b52fb",       // 3408 E Dr MLK BLVD
  HICKORY: "48385b5c-791a-455d-a358-5f1947b448e3",    // Hickory Landing
  LUCIA: "4d7c6538-2f0d-42e2-8c40-6ec57b438a4a",      // Lucia Apartments
  SUNCOVE: "ba502e16-e1ee-4925-baff-1b156ad37133",     // Sun Cove Apartments
};

// All units from Rent Roll + Vacancy reports
const units = [
  // ═══ 3408 E Dr MLK BLVD (10 units, 10 occupied, 0 vacant) ═══
  { propertyId: PROPS.MLK, unitNumber: "#1", tenantName: "Smith, Tamara", monthlyRent: 1700, bedrooms: 2, bathrooms: "1", status: "occupied", notes: "DELINQUENT $300 (Rent $200 + Late $100) as of 2/22/26" },
  { propertyId: PROPS.MLK, unitNumber: "#2", tenantName: "Jones, Emily", monthlyRent: 1650, bedrooms: 2, bathrooms: "1", status: "occupied" },
  { propertyId: PROPS.MLK, unitNumber: "#3", tenantName: "Dupuis, Zachary", monthlyRent: 1550, bedrooms: 2, bathrooms: "1", status: "occupied", notes: "DELINQUENT $1,800 (Jan rent $50 + Jan late $100 + Feb rent $1,550 + Feb late $100) as of 2/22/26" },
  { propertyId: PROPS.MLK, unitNumber: "#4", tenantName: "Schramm, Amber", monthlyRent: 1650, bedrooms: 2, bathrooms: "1", status: "occupied", notes: "DELINQUENT $1,275 (Feb rent $1,175 + Late $100) as of 2/22/26" },
  { propertyId: PROPS.MLK, unitNumber: "#5", tenantName: "Simpkins, Antoine", monthlyRent: 1700, bedrooms: 2, bathrooms: "1", status: "occupied" },
  { propertyId: PROPS.MLK, unitNumber: "#6", tenantName: "Dixon, Lawrencia", monthlyRent: 1750, bedrooms: 2, bathrooms: "1", status: "occupied" },
  { propertyId: PROPS.MLK, unitNumber: "#7", tenantName: "Thomas, Trey", monthlyRent: 1700, bedrooms: 2, bathrooms: "1", status: "occupied", notes: "DELINQUENT $3,685 (Dec rent $85 + Dec late $100 + Jan rent $1,700 + Feb rent $1,700 + Feb late $100) as of 2/22/26. Highest delinquency in portfolio." },
  { propertyId: PROPS.MLK, unitNumber: "#8", tenantName: "Spain, Kiana", monthlyRent: 1750, bedrooms: 2, bathrooms: "1", status: "occupied" },
  { propertyId: PROPS.MLK, unitNumber: "#9", tenantName: "Schramm, Autumn", monthlyRent: 1650, bedrooms: 2, bathrooms: "1", status: "occupied" },
  { propertyId: PROPS.MLK, unitNumber: "#10", tenantName: "Copeland, Zanovia", monthlyRent: 1750, bedrooms: 2, bathrooms: "1", status: "occupied" },

  // ═══ Hickory Landing (8 units, 5 occupied, 3 vacant) ═══
  { propertyId: PROPS.HICKORY, unitNumber: "601 Plateau Ave", tenantName: "Howell, Carla", monthlyRent: 1225.99, bedrooms: 2, bathrooms: "1", status: "occupied" },
  { propertyId: PROPS.HICKORY, unitNumber: "603 Plateau Ave", tenantName: null, monthlyRent: null, bedrooms: 2, bathrooms: "1", status: "vacant", notes: "Vacant 149 days" },
  { propertyId: PROPS.HICKORY, unitNumber: "613 Plateau Ave", tenantName: null, monthlyRent: null, bedrooms: 2, bathrooms: "1", status: "vacant", notes: "Vacant 11 days" },
  { propertyId: PROPS.HICKORY, unitNumber: "615 Plateau Ave", tenantName: "Rivera, Alondra", monthlyRent: 1250.99, bedrooms: 2, bathrooms: "1", status: "occupied" },
  { propertyId: PROPS.HICKORY, unitNumber: "619 Plateau Ave", tenantName: null, monthlyRent: null, bedrooms: 2, bathrooms: "1", status: "vacant", notes: "Vacant 0 days — newly available" },
  { propertyId: PROPS.HICKORY, unitNumber: "2008 W Hickory St", tenantName: "Rothmann, Jake", monthlyRent: 1050.99, bedrooms: 2, bathrooms: "1", status: "occupied" },

  // ═══ Lucia Apartments (16 units, 9 occupied, 7 vacant) ═══
  { propertyId: PROPS.LUCIA, unitNumber: "124", tenantName: "Graham, Natasha", monthlyRent: 1385, bedrooms: 2, bathrooms: "1", status: "occupied" },
  { propertyId: PROPS.LUCIA, unitNumber: "124.5", tenantName: "Johnson, Darren", monthlyRent: 1275, bedrooms: 2, bathrooms: "1", status: "occupied" },
  { propertyId: PROPS.LUCIA, unitNumber: "658", tenantName: null, monthlyRent: null, bedrooms: 1, bathrooms: "1", sqft: 440, status: "vacant" },
  { propertyId: PROPS.LUCIA, unitNumber: "658.5", tenantName: "Valentin, Angelo", monthlyRent: 985, bedrooms: 1, bathrooms: "1", status: "occupied" },
  { propertyId: PROPS.LUCIA, unitNumber: "669 - 1", tenantName: "Stricker, John", monthlyRent: 525, bedrooms: 1, bathrooms: "1", sqft: 588, status: "occupied" },
  { propertyId: PROPS.LUCIA, unitNumber: "669 - 2", tenantName: null, monthlyRent: null, bedrooms: 1, bathrooms: "1", sqft: 588, status: "vacant" },
  { propertyId: PROPS.LUCIA, unitNumber: "669 - 3", tenantName: "Stewart, Mathurin", monthlyRent: 1225, bedrooms: 1, bathrooms: "1", sqft: 588, status: "occupied" },
  { propertyId: PROPS.LUCIA, unitNumber: "669 - 4", tenantName: null, monthlyRent: null, bedrooms: 1, bathrooms: "1", sqft: 588, status: "vacant" },
  { propertyId: PROPS.LUCIA, unitNumber: "669 - 5", tenantName: "Murdock, Leon", monthlyRent: 1150, bedrooms: 1, bathrooms: "1", sqft: 588, status: "occupied" },
  { propertyId: PROPS.LUCIA, unitNumber: "669 - 6", tenantName: null, monthlyRent: null, bedrooms: 1, bathrooms: "1", sqft: 588, status: "vacant" },
  { propertyId: PROPS.LUCIA, unitNumber: "669 - 7", tenantName: null, monthlyRent: null, bedrooms: 1, bathrooms: "1", sqft: 588, status: "vacant", notes: "Vacant 4 days" },
  { propertyId: PROPS.LUCIA, unitNumber: "669 - 8", tenantName: "Arnold, Shadae", monthlyRent: 1175, bedrooms: 1, bathrooms: "1", sqft: 588, status: "occupied" },
  { propertyId: PROPS.LUCIA, unitNumber: "669 - 9", tenantName: null, monthlyRent: null, bedrooms: 1, bathrooms: "1", sqft: 595, status: "vacant" },
  { propertyId: PROPS.LUCIA, unitNumber: "669 - 10", tenantName: null, monthlyRent: null, bedrooms: 1, bathrooms: "1", sqft: 595, status: "vacant" },
  { propertyId: PROPS.LUCIA, unitNumber: "670", tenantName: "Bell, Johnny", monthlyRent: 1350, bedrooms: 2, bathrooms: "1", status: "occupied" },
  { propertyId: PROPS.LUCIA, unitNumber: "672", tenantName: "Cruz, Soley", monthlyRent: 1325, bedrooms: 2, bathrooms: "1", status: "occupied" },

  // ═══ Sun Cove Apartments (21 units, 16 occupied, 5 vacant) ═══
  { propertyId: PROPS.SUNCOVE, unitNumber: "C1", tenantName: null, monthlyRent: null, bedrooms: 1, bathrooms: "1", status: "vacant" },
  { propertyId: PROPS.SUNCOVE, unitNumber: "C2", tenantName: null, monthlyRent: null, bedrooms: 1, bathrooms: "1", status: "vacant" },
  { propertyId: PROPS.SUNCOVE, unitNumber: "C3", tenantName: "Hale, David", monthlyRent: 1000, bedrooms: 1, bathrooms: "1", status: "occupied" },
  { propertyId: PROPS.SUNCOVE, unitNumber: "C4", tenantName: "Wynn, Delaney", monthlyRent: 975, bedrooms: 1, bathrooms: "1", status: "occupied", notes: "DELINQUENT $543 (Feb rent) as of 2/22/26" },
  { propertyId: PROPS.SUNCOVE, unitNumber: "C5", tenantName: "Smith, Johnny", monthlyRent: 900, bedrooms: 1, bathrooms: "1", status: "occupied", notes: "DELINQUENT $651 (Feb rent) as of 2/22/26" },
  { propertyId: PROPS.SUNCOVE, unitNumber: "C6", tenantName: null, monthlyRent: null, bedrooms: 1, bathrooms: "1", status: "vacant" },
  { propertyId: PROPS.SUNCOVE, unitNumber: "C7", tenantName: "Bodden, Rosalyn", monthlyRent: 1000, bedrooms: 1, bathrooms: "1", status: "occupied" },
  { propertyId: PROPS.SUNCOVE, unitNumber: "D1", tenantName: "Pennucci, Joshua", monthlyRent: 875, bedrooms: 1, bathrooms: "1", status: "occupied" },
  { propertyId: PROPS.SUNCOVE, unitNumber: "D2", tenantName: "Cundith, Patrick", monthlyRent: 1000, bedrooms: 1, bathrooms: "1", status: "occupied", notes: "DELINQUENT $1,000 (Feb rent) as of 2/22/26" },
  { propertyId: PROPS.SUNCOVE, unitNumber: "D3", tenantName: "Cruz, Ismael", monthlyRent: 1000, bedrooms: 1, bathrooms: "1", status: "occupied" },
  { propertyId: PROPS.SUNCOVE, unitNumber: "D4", tenantName: "Pierce, Elaine", monthlyRent: 1000, bedrooms: 1, bathrooms: "1", status: "occupied" },
  { propertyId: PROPS.SUNCOVE, unitNumber: "D5", tenantName: "Ponder, Karla", monthlyRent: 900, bedrooms: 1, bathrooms: "1", status: "occupied", notes: "DELINQUENT $900 (Feb rent) as of 2/22/26" },
  { propertyId: PROPS.SUNCOVE, unitNumber: "D6", tenantName: "Smith, Gerrard", monthlyRent: 1097, bedrooms: 1, bathrooms: "1", status: "occupied", notes: "DELINQUENT $1,097 (Feb rent) as of 2/22/26" },
  { propertyId: PROPS.SUNCOVE, unitNumber: "House", tenantName: "Shields-Riley, Kenya", monthlyRent: 1000, bedrooms: 2, bathrooms: "1", status: "occupied" },
  { propertyId: PROPS.SUNCOVE, unitNumber: "Lot 1", tenantName: "Lasek, Kenneth", monthlyRent: 1200, bedrooms: 2, bathrooms: "1", status: "occupied", notes: "DELINQUENT $954 (Feb rent) as of 2/22/26" },
  { propertyId: PROPS.SUNCOVE, unitNumber: "Lot 2", tenantName: null, monthlyRent: null, bedrooms: 1, bathrooms: "1", status: "vacant" },
  { propertyId: PROPS.SUNCOVE, unitNumber: "Lot 3", tenantName: "Ellis, Russell", monthlyRent: 1400, bedrooms: 1, bathrooms: "1", status: "occupied" },
  { propertyId: PROPS.SUNCOVE, unitNumber: "Lot 4", tenantName: "Venezolama, Yera", monthlyRent: 1050, bedrooms: 1, bathrooms: "1", status: "occupied" },
  { propertyId: PROPS.SUNCOVE, unitNumber: "Lot 5", tenantName: null, monthlyRent: null, bedrooms: 1, bathrooms: "1", status: "vacant", notes: "Vacant 38 days" },
  { propertyId: PROPS.SUNCOVE, unitNumber: "Lot 6", tenantName: "Akins, Michelle", monthlyRent: 950, bedrooms: 1, bathrooms: "1", status: "occupied" },
  { propertyId: PROPS.SUNCOVE, unitNumber: "Lot 7", tenantName: "Bartee, Herbert", monthlyRent: 1100, bedrooms: 1, bathrooms: "1", status: "occupied" },
];

async function seed() {
  const client = await pool.connect();
  try {
    console.log("Clearing old unit_rent_roll data...");
    await client.query("DELETE FROM vacancy_pipeline");
    await client.query("DELETE FROM unit_rent_roll");
    console.log("  Cleared.");

    console.log(`Inserting ${units.length} live units from Rent Manager...`);
    let inserted = 0;
    for (const u of units) {
      await client.query(
        `INSERT INTO unit_rent_roll
         (property_id, unit_number, tenant_name, monthly_rent, market_rent, bedrooms, bathrooms, sqft, status, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, NOW(), NOW())`,
        [
          u.propertyId,
          u.unitNumber,
          u.tenantName || null,
          u.monthlyRent || null,
          u.bedrooms || null,
          u.bathrooms || null,
          u.sqft || null,
          u.status,
          u.notes || null,
        ]
      );
      inserted++;
    }

    console.log(`  Inserted ${inserted} units.`);

    // Summary
    const res = await client.query(`
      SELECT
        p.name,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE ur.status = 'occupied') AS occupied,
        COUNT(*) FILTER (WHERE ur.status = 'vacant') AS vacant
      FROM unit_rent_roll ur
      JOIN properties p ON p.id = ur.property_id
      GROUP BY p.name
      ORDER BY p.name
    `);
    console.log("\n=== LIVE DATA SUMMARY ===");
    let totalAll = 0, occAll = 0, vacAll = 0;
    for (const row of res.rows) {
      console.log(`  ${row.name}: ${row.total} units (${row.occupied} occupied, ${row.vacant} vacant)`);
      totalAll += parseInt(row.total);
      occAll += parseInt(row.occupied);
      vacAll += parseInt(row.vacant);
    }
    console.log(`  TOTAL: ${totalAll} units (${occAll} occupied, ${vacAll} vacant)`);
    console.log(`  Vacancy Rate: ${((vacAll / totalAll) * 100).toFixed(1)}%`);
    console.log(`  Delinquent tenants: 10 ($12,205 total)`);
    console.log("\nDone!");
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(console.error);
