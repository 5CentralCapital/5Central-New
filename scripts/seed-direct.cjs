const { Pool } = require("@neondatabase/serverless");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

(async () => {
  const client = await pool.connect();
  try {
    console.log("Connected to database. Starting seed...\n");

    // =============================================
    // Property IDs
    // =============================================
    const HICKORY   = "48385b5c-791a-455d-a358-5f1947b448e3";
    const LUCIA     = "4d7c6538-2f0d-42e2-8c40-6ec57b438a4a";
    const MLK       = "ea28fe29-c3e4-4ccd-a68d-a38dbd6b52fb";
    const SUN_COVE  = "ba502e16-e1ee-4925-baff-1b156ad37133";

    // =============================================
    // 1. WORKERS
    // =============================================
    console.log("--- Inserting workers ---");

    // Clean existing data first (in reverse dependency order)
    await client.query("DELETE FROM investor_communications");
    await client.query("DELETE FROM investor_leads");
    await client.query("DELETE FROM deal_pipeline");
    await client.query("DELETE FROM property_monthly_data");
    await client.query("DELETE FROM pm_escalations");
    await client.query("DELETE FROM pm_notes");
    await client.query("DELETE FROM maintenance_requests");
    await client.query("DELETE FROM unit_rent_roll");
    await client.query("DELETE FROM rehab_line_items");
    await client.query("DELETE FROM payroll_entries");
    await client.query("DELETE FROM workers");
    console.log("Cleared existing seed data.\n");

    const workersData = [
      { name: "Henry Ramos", role: "lead", rate: "25.00", payment: "zelle" },
      { name: "Giovanni", role: "helper", rate: "25.00", payment: "zelle" },
      { name: "Marvin", role: "helper", rate: "20.00", payment: "zelle" },
      { name: "Rubierto", role: "helper", rate: "20.00", payment: "zelle" },
      { name: "Maritza", role: "cleaner", rate: "16.00", payment: "zelle" },
    ];

    const workerIds = {};
    for (const w of workersData) {
      const res = await client.query(
        `INSERT INTO workers (name, role, default_rate, payment_method, status)
         VALUES ($1, $2, $3, $4, 'active')
         RETURNING id`,
        [w.name, w.role, w.rate, w.payment]
      );
      workerIds[w.name] = res.rows[0].id;
      console.log(`  Worker: ${w.name} -> ${workerIds[w.name]}`);
    }
    console.log(`Inserted ${workersData.length} workers.\n`);

    // =============================================
    // 2. PAYROLL ENTRIES
    // =============================================
    console.log("--- Inserting payroll entries ---");

    const payrollData = [
      // Week ending 2026-02-08
      { worker: "Henry Ramos", property: HICKORY, unit: "Unit 3", task: "demo", date: "2026-02-02", hours: 8, rate: 25, weekEnding: "2026-02-08" },
      { worker: "Henry Ramos", property: HICKORY, unit: "Unit 3", task: "demo", date: "2026-02-03", hours: 8, rate: 25, weekEnding: "2026-02-08" },
      { worker: "Henry Ramos", property: HICKORY, unit: "Unit 5", task: "framing", date: "2026-02-04", hours: 10, rate: 25, weekEnding: "2026-02-08" },
      { worker: "Henry Ramos", property: HICKORY, unit: "Unit 5", task: "framing", date: "2026-02-05", hours: 10, rate: 25, weekEnding: "2026-02-08" },
      { worker: "Henry Ramos", property: HICKORY, unit: "Unit 5", task: "framing", date: "2026-02-06", hours: 8, rate: 25, weekEnding: "2026-02-08" },

      { worker: "Giovanni", property: HICKORY, unit: "Unit 3", task: "demo", date: "2026-02-02", hours: 8, rate: 25, weekEnding: "2026-02-08" },
      { worker: "Giovanni", property: HICKORY, unit: "Unit 3", task: "demo", date: "2026-02-03", hours: 8, rate: 25, weekEnding: "2026-02-08" },
      { worker: "Giovanni", property: HICKORY, unit: "Unit 5", task: "drywall", date: "2026-02-04", hours: 10, rate: 25, weekEnding: "2026-02-08" },
      { worker: "Giovanni", property: HICKORY, unit: "Unit 5", task: "drywall", date: "2026-02-05", hours: 10, rate: 25, weekEnding: "2026-02-08" },
      { worker: "Giovanni", property: HICKORY, unit: "Unit 5", task: "drywall", date: "2026-02-06", hours: 8, rate: 25, weekEnding: "2026-02-08" },

      { worker: "Marvin", property: HICKORY, unit: "Unit 3", task: "demo", date: "2026-02-02", hours: 8, rate: 20, weekEnding: "2026-02-08" },
      { worker: "Marvin", property: HICKORY, unit: "Unit 3", task: "demo", date: "2026-02-03", hours: 8, rate: 20, weekEnding: "2026-02-08" },
      { worker: "Marvin", property: HICKORY, unit: "Unit 5", task: "paint", date: "2026-02-04", hours: 8, rate: 20, weekEnding: "2026-02-08" },
      { worker: "Marvin", property: HICKORY, unit: "Unit 5", task: "paint", date: "2026-02-05", hours: 8, rate: 20, weekEnding: "2026-02-08" },
      { worker: "Marvin", property: HICKORY, unit: "Unit 5", task: "paint", date: "2026-02-06", hours: 8, rate: 20, weekEnding: "2026-02-08" },

      { worker: "Rubierto", property: HICKORY, unit: "Unit 3", task: "demo", date: "2026-02-02", hours: 8, rate: 20, weekEnding: "2026-02-08" },
      { worker: "Rubierto", property: HICKORY, unit: "Unit 3", task: "hauling", date: "2026-02-03", hours: 8, rate: 20, weekEnding: "2026-02-08" },
      { worker: "Rubierto", property: HICKORY, unit: "Unit 5", task: "hauling", date: "2026-02-04", hours: 8, rate: 20, weekEnding: "2026-02-08" },
      { worker: "Rubierto", property: HICKORY, unit: "Unit 5", task: "hauling", date: "2026-02-05", hours: 8, rate: 20, weekEnding: "2026-02-08" },
      { worker: "Rubierto", property: HICKORY, unit: "Unit 5", task: "hauling", date: "2026-02-06", hours: 8, rate: 20, weekEnding: "2026-02-08" },

      // Week ending 2026-02-15
      { worker: "Henry Ramos", property: HICKORY, unit: "Unit 5", task: "electrical", date: "2026-02-09", hours: 10, rate: 25, weekEnding: "2026-02-15" },
      { worker: "Henry Ramos", property: HICKORY, unit: "Unit 5", task: "electrical", date: "2026-02-10", hours: 10, rate: 25, weekEnding: "2026-02-15" },
      { worker: "Henry Ramos", property: HICKORY, unit: "Unit 3", task: "cabinets", date: "2026-02-11", hours: 8, rate: 25, weekEnding: "2026-02-15" },
      { worker: "Henry Ramos", property: HICKORY, unit: "Unit 3", task: "cabinets", date: "2026-02-12", hours: 8, rate: 25, weekEnding: "2026-02-15" },
      { worker: "Henry Ramos", property: HICKORY, unit: "Unit 3", task: "cabinets", date: "2026-02-13", hours: 8, rate: 25, weekEnding: "2026-02-15" },

      { worker: "Giovanni", property: HICKORY, unit: "Unit 5", task: "plumbing", date: "2026-02-09", hours: 10, rate: 25, weekEnding: "2026-02-15" },
      { worker: "Giovanni", property: HICKORY, unit: "Unit 5", task: "plumbing", date: "2026-02-10", hours: 10, rate: 25, weekEnding: "2026-02-15" },
      { worker: "Giovanni", property: HICKORY, unit: "Unit 3", task: "tile", date: "2026-02-11", hours: 8, rate: 25, weekEnding: "2026-02-15" },
      { worker: "Giovanni", property: HICKORY, unit: "Unit 3", task: "tile", date: "2026-02-12", hours: 8, rate: 25, weekEnding: "2026-02-15" },
      { worker: "Giovanni", property: HICKORY, unit: "Unit 3", task: "tile", date: "2026-02-13", hours: 8, rate: 25, weekEnding: "2026-02-15" },

      { worker: "Marvin", property: HICKORY, unit: "Unit 5", task: "painting", date: "2026-02-09", hours: 10, rate: 20, weekEnding: "2026-02-15" },
      { worker: "Marvin", property: HICKORY, unit: "Unit 5", task: "painting", date: "2026-02-10", hours: 10, rate: 20, weekEnding: "2026-02-15" },
      { worker: "Marvin", property: HICKORY, unit: "Unit 3", task: "flooring", date: "2026-02-11", hours: 8, rate: 20, weekEnding: "2026-02-15" },
      { worker: "Marvin", property: HICKORY, unit: "Unit 3", task: "flooring", date: "2026-02-12", hours: 8, rate: 20, weekEnding: "2026-02-15" },
      { worker: "Marvin", property: HICKORY, unit: "Unit 3", task: "flooring", date: "2026-02-13", hours: 8, rate: 20, weekEnding: "2026-02-15" },

      { worker: "Rubierto", property: HICKORY, unit: "Unit 5", task: "flooring", date: "2026-02-09", hours: 10, rate: 20, weekEnding: "2026-02-15" },
      { worker: "Rubierto", property: HICKORY, unit: "Unit 5", task: "flooring", date: "2026-02-10", hours: 10, rate: 20, weekEnding: "2026-02-15" },
      { worker: "Rubierto", property: HICKORY, unit: "Unit 3", task: "baseboard", date: "2026-02-11", hours: 8, rate: 20, weekEnding: "2026-02-15" },
      { worker: "Rubierto", property: HICKORY, unit: "Unit 3", task: "baseboard", date: "2026-02-12", hours: 8, rate: 20, weekEnding: "2026-02-15" },
      { worker: "Rubierto", property: HICKORY, unit: "Unit 3", task: "baseboard", date: "2026-02-13", hours: 8, rate: 20, weekEnding: "2026-02-15" },

      { worker: "Maritza", property: HICKORY, unit: "Unit 1", task: "deep clean", date: "2026-02-10", hours: 8, rate: 16, weekEnding: "2026-02-15" },
      { worker: "Maritza", property: HICKORY, unit: "Unit 2", task: "deep clean", date: "2026-02-11", hours: 8, rate: 16, weekEnding: "2026-02-15" },
    ];

    let payrollCount = 0;
    for (const p of payrollData) {
      const total = (p.hours * p.rate).toFixed(2);
      await client.query(
        `INSERT INTO payroll_entries (worker_id, property_id, unit_number, task, date, hours, rate, total, week_ending, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [workerIds[p.worker], p.property, p.unit, p.task, p.date, p.hours, p.rate, total, p.weekEnding, null]
      );
      payrollCount++;
    }
    console.log(`Inserted ${payrollCount} payroll entries.\n`);

    // =============================================
    // 3. REHAB LINE ITEMS (Sun Cove)
    // =============================================
    console.log("--- Inserting rehab line items ---");

    const rehabItems = [
      // Unit A1 - all complete
      { property: SUN_COVE, unit: "A1", scope: "Kitchen Cabinets", category: "cabinets", contractor: 3200, labor: 600, material: 1450, status: "complete" },
      { property: SUN_COVE, unit: "A1", scope: "Bathroom Tile", category: "plumbing", contractor: 2800, labor: 500, material: 890, status: "complete" },
      { property: SUN_COVE, unit: "A1", scope: "Flooring LVP", category: "flooring", contractor: 2000, labor: 350, material: 720, status: "complete" },
      { property: SUN_COVE, unit: "A1", scope: "Paint Interior", category: "paint", contractor: 1200, labor: 300, material: 180, status: "complete" },
      // Unit A3 - mixed
      { property: SUN_COVE, unit: "A3", scope: "Kitchen Cabinets", category: "cabinets", contractor: 3200, labor: 600, material: 1450, status: "in_progress" },
      { property: SUN_COVE, unit: "A3", scope: "Bathroom Tile", category: "plumbing", contractor: 2800, labor: 500, material: 890, status: "not_started" },
      { property: SUN_COVE, unit: "A3", scope: "Flooring LVP", category: "flooring", contractor: 2000, labor: 350, material: 720, status: "not_started" },
      // Unit B2 - mixed
      { property: SUN_COVE, unit: "B2", scope: "Kitchen Full Gut", category: "cabinets", contractor: 3800, labor: 800, material: 1650, status: "in_progress" },
      { property: SUN_COVE, unit: "B2", scope: "Bathroom Remodel", category: "plumbing", contractor: 3200, labor: 600, material: 1100, status: "not_started" },
      { property: SUN_COVE, unit: "B2", scope: "HVAC Replacement", category: "hvac", contractor: 2500, labor: 0, material: 2200, status: "not_started" },
    ];

    let rehabCount = 0;
    for (const r of rehabItems) {
      const totalInHouse = r.labor + r.material;
      const savings = r.contractor - totalInHouse;
      const savingsPercent = r.contractor > 0 ? ((savings / r.contractor) * 100).toFixed(2) : "0.00";

      await client.query(
        `INSERT INTO rehab_line_items
         (property_id, unit_number, scope_item, category,
          contractor_baseline_cost, in_house_labor_cost, in_house_material_cost,
          total_in_house_cost, savings_vs_contractor, savings_percent, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [r.property, r.unit, r.scope, r.category,
         r.contractor, r.labor, r.material,
         totalInHouse, savings, savingsPercent, r.status]
      );
      rehabCount++;
    }
    console.log(`Inserted ${rehabCount} rehab line items.\n`);

    // =============================================
    // 4. UNIT RENT ROLL
    // =============================================
    console.log("--- Inserting unit rent roll ---");

    const rentRollData = [];

    // Hickory Landing: 8 units, 5 occupied, 3 vacant (renovation)
    const hickoryUnits = [
      { unit: "1", tenant: "Maria Gonzalez", rent: 750, market: 900, status: "occupied", leaseStart: "2025-09-01", leaseEnd: "2026-08-31", beds: 2, baths: 1, sqft: 850 },
      { unit: "2", tenant: "James Wilson", rent: 800, market: 900, status: "occupied", leaseStart: "2025-10-01", leaseEnd: "2026-09-30", beds: 2, baths: 1, sqft: 850 },
      { unit: "3", tenant: null, rent: null, market: 900, status: "renovation", leaseStart: null, leaseEnd: null, beds: 2, baths: 1, sqft: 900 },
      { unit: "4", tenant: "Kevin Brown", rent: 850, market: 900, status: "occupied", leaseStart: "2025-11-01", leaseEnd: "2026-10-31", beds: 2, baths: 1, sqft: 900 },
      { unit: "5", tenant: null, rent: null, market: 900, status: "renovation", leaseStart: null, leaseEnd: null, beds: 3, baths: 1, sqft: 1050 },
      { unit: "6", tenant: "Rosa Hernandez", rent: 900, market: 900, status: "occupied", leaseStart: "2025-08-01", leaseEnd: "2026-07-31", beds: 3, baths: 1, sqft: 1050 },
      { unit: "7", tenant: null, rent: null, market: 900, status: "renovation", leaseStart: null, leaseEnd: null, beds: 2, baths: 1, sqft: 850 },
      { unit: "8", tenant: "David Kim", rent: 900, market: 900, status: "occupied", leaseStart: "2025-12-01", leaseEnd: "2026-11-30", beds: 3, baths: 2, sqft: 1100 },
    ];
    hickoryUnits.forEach(u => rentRollData.push({ ...u, property: HICKORY }));

    // Lucia Apartments: 16 units, 13 occupied, 3 vacant
    const luciaUnits = [
      { unit: "1",  tenant: "Ana Rivera",      rent: 950,  market: 1100, status: "occupied", leaseStart: "2025-07-01", leaseEnd: "2026-06-30", beds: 2, baths: 1, sqft: 850 },
      { unit: "2",  tenant: "Carlos Mendez",   rent: 1000, market: 1100, status: "occupied", leaseStart: "2025-08-01", leaseEnd: "2026-07-31", beds: 2, baths: 1, sqft: 850 },
      { unit: "3",  tenant: "Lisa Chen",        rent: 1050, market: 1100, status: "occupied", leaseStart: "2025-09-01", leaseEnd: "2026-08-31", beds: 2, baths: 1, sqft: 900 },
      { unit: "4",  tenant: null,               rent: null, market: 1100, status: "vacant", leaseStart: null, leaseEnd: null, beds: 2, baths: 1, sqft: 900 },
      { unit: "5",  tenant: "Marcus Johnson",   rent: 1100, market: 1200, status: "occupied", leaseStart: "2025-06-01", leaseEnd: "2026-05-31", beds: 3, baths: 2, sqft: 1100 },
      { unit: "6",  tenant: "Fatima Al-Rashid", rent: 1050, market: 1100, status: "occupied", leaseStart: "2025-10-01", leaseEnd: "2026-09-30", beds: 2, baths: 1, sqft: 850 },
      { unit: "7",  tenant: "Brian Thompson",   rent: 750,  market: 1000, status: "occupied", leaseStart: "2025-03-01", leaseEnd: "2026-02-28", beds: 1, baths: 1, sqft: 650 },
      { unit: "8",  tenant: "Jennifer Park",    rent: 1000, market: 1100, status: "occupied", leaseStart: "2025-11-01", leaseEnd: "2026-10-31", beds: 2, baths: 1, sqft: 850 },
      { unit: "9",  tenant: null,               rent: null, market: 1200, status: "vacant", leaseStart: null, leaseEnd: null, beds: 3, baths: 2, sqft: 1100 },
      { unit: "10", tenant: "Diego Fernandez",  rent: 1100, market: 1200, status: "occupied", leaseStart: "2025-07-15", leaseEnd: "2026-07-14", beds: 3, baths: 2, sqft: 1100 },
      { unit: "11", tenant: "Keisha Williams",  rent: 950,  market: 1000, status: "occupied", leaseStart: "2025-09-01", leaseEnd: "2026-08-31", beds: 1, baths: 1, sqft: 700 },
      { unit: "12", tenant: "Tommy Nguyen",     rent: 1000, market: 1100, status: "occupied", leaseStart: "2025-08-15", leaseEnd: "2026-08-14", beds: 2, baths: 1, sqft: 900 },
      { unit: "13", tenant: null,               rent: null, market: 1000, status: "vacant", leaseStart: null, leaseEnd: null, beds: 1, baths: 1, sqft: 650 },
      { unit: "14", tenant: "Sarah Mitchell",   rent: 1050, market: 1100, status: "occupied", leaseStart: "2025-10-15", leaseEnd: "2026-10-14", beds: 2, baths: 1, sqft: 850 },
      { unit: "15", tenant: "Robert Davis",     rent: 1100, market: 1200, status: "occupied", leaseStart: "2025-05-01", leaseEnd: "2026-04-30", beds: 3, baths: 2, sqft: 1100 },
      { unit: "16", tenant: "Michelle Lee",     rent: 1100, market: 1200, status: "occupied", leaseStart: "2025-12-01", leaseEnd: "2026-11-30", beds: 3, baths: 2, sqft: 1100 },
    ];
    luciaUnits.forEach(u => rentRollData.push({ ...u, property: LUCIA }));

    // MLK Apartments: 10 units, 8 occupied, 2 vacant
    const mlkUnits = [
      { unit: "1",  tenant: "Anthony Harris",   rent: 850,  market: 950, status: "occupied", leaseStart: "2025-06-01", leaseEnd: "2026-05-31", beds: 2, baths: 1, sqft: 800 },
      { unit: "2",  tenant: "Sophia Martinez",  rent: 900,  market: 950, status: "occupied", leaseStart: "2025-08-01", leaseEnd: "2026-07-31", beds: 2, baths: 1, sqft: 800 },
      { unit: "3",  tenant: null,               rent: null,  market: 950, status: "vacant", leaseStart: null, leaseEnd: null, beds: 2, baths: 1, sqft: 850 },
      { unit: "4",  tenant: "Raymond Scott",    rent: 800,  market: 950, status: "occupied", leaseStart: "2025-04-01", leaseEnd: "2026-03-31", beds: 2, baths: 1, sqft: 800 },
      { unit: "5",  tenant: "Danielle Moore",   rent: 950,  market: 950, status: "occupied", leaseStart: "2025-10-01", leaseEnd: "2026-09-30", beds: 2, baths: 1, sqft: 850 },
      { unit: "6",  tenant: "Victor Reyes",     rent: 900,  market: 950, status: "occupied", leaseStart: "2025-07-01", leaseEnd: "2026-06-30", beds: 2, baths: 1, sqft: 850 },
      { unit: "7",  tenant: null,               rent: null,  market: 950, status: "vacant", leaseStart: null, leaseEnd: null, beds: 2, baths: 1, sqft: 800 },
      { unit: "8",  tenant: "Crystal Adams",    rent: 950,  market: 950, status: "occupied", leaseStart: "2025-11-01", leaseEnd: "2026-10-31", beds: 2, baths: 1, sqft: 850 },
      { unit: "9",  tenant: "Frank Turner",     rent: 950,  market: 950, status: "occupied", leaseStart: "2025-09-01", leaseEnd: "2026-08-31", beds: 2, baths: 1, sqft: 850 },
      { unit: "10", tenant: "Jasmine Washington", rent: 900, market: 950, status: "occupied", leaseStart: "2025-12-01", leaseEnd: "2026-11-30", beds: 2, baths: 1, sqft: 800 },
    ];
    mlkUnits.forEach(u => rentRollData.push({ ...u, property: MLK }));

    // Sun Cove: 21 units, 17 occupied, 4 vacant
    const sunCoveUnits = [
      { unit: "1",  tenant: "Angela Robinson",   rent: 900,  market: 1100, status: "occupied", leaseStart: "2025-05-01", leaseEnd: "2026-04-30", beds: 2, baths: 1, sqft: 850 },
      { unit: "2",  tenant: "Steven Clark",      rent: 950,  market: 1100, status: "occupied", leaseStart: "2025-06-01", leaseEnd: "2026-05-31", beds: 2, baths: 1, sqft: 850 },
      { unit: "3",  tenant: "Natalie Hughes",    rent: 1000, market: 1100, status: "occupied", leaseStart: "2025-07-01", leaseEnd: "2026-06-30", beds: 2, baths: 1, sqft: 900 },
      { unit: "4",  tenant: null,                rent: null,  market: 1100, status: "vacant", leaseStart: null, leaseEnd: null, beds: 2, baths: 1, sqft: 900 },
      { unit: "5",  tenant: "Luis Morales",      rent: 1050, market: 1100, status: "occupied", leaseStart: "2025-08-01", leaseEnd: "2026-07-31", beds: 2, baths: 1, sqft: 900 },
      { unit: "6",  tenant: "Patricia Foster",   rent: 800,  market: 1100, status: "occupied", leaseStart: "2025-03-01", leaseEnd: "2026-02-28", beds: 2, baths: 1, sqft: 850 },
      { unit: "7",  tenant: "George Walker",     rent: 1050, market: 1100, status: "occupied", leaseStart: "2025-09-01", leaseEnd: "2026-08-31", beds: 2, baths: 1, sqft: 900 },
      { unit: "8",  tenant: null,                rent: null,  market: 1100, status: "vacant", leaseStart: null, leaseEnd: null, beds: 2, baths: 1, sqft: 850 },
      { unit: "9",  tenant: "Carmen Diaz",       rent: 1050, market: 1100, status: "occupied", leaseStart: "2025-10-01", leaseEnd: "2026-09-30", beds: 3, baths: 2, sqft: 1050 },
      { unit: "10", tenant: "Wayne Jackson",     rent: 1000, market: 1100, status: "occupied", leaseStart: "2025-07-15", leaseEnd: "2026-07-14", beds: 2, baths: 1, sqft: 900 },
      { unit: "11", tenant: "Tiffany Young",     rent: 950,  market: 1100, status: "occupied", leaseStart: "2025-11-01", leaseEnd: "2026-10-31", beds: 2, baths: 1, sqft: 850 },
      { unit: "12", tenant: "Omar Sanchez",      rent: 1050, market: 1100, status: "occupied", leaseStart: "2025-08-15", leaseEnd: "2026-08-14", beds: 3, baths: 2, sqft: 1050 },
      { unit: "13", tenant: null,                rent: null,  market: 1100, status: "vacant", leaseStart: null, leaseEnd: null, beds: 2, baths: 1, sqft: 900 },
      { unit: "14", tenant: "Heather King",      rent: 1050, market: 1100, status: "occupied", leaseStart: "2025-09-15", leaseEnd: "2026-09-14", beds: 2, baths: 1, sqft: 900 },
      { unit: "15", tenant: "Ricardo Perez",     rent: 900,  market: 1100, status: "occupied", leaseStart: "2025-04-01", leaseEnd: "2026-03-31", beds: 2, baths: 1, sqft: 850 },
      { unit: "16", tenant: "Emily Collins",     rent: 1050, market: 1100, status: "occupied", leaseStart: "2025-12-01", leaseEnd: "2026-11-30", beds: 3, baths: 2, sqft: 1050 },
      { unit: "17", tenant: "Derek White",       rent: 1000, market: 1100, status: "occupied", leaseStart: "2025-10-15", leaseEnd: "2026-10-14", beds: 2, baths: 1, sqft: 900 },
      { unit: "18", tenant: null,                rent: null,  market: 1100, status: "vacant", leaseStart: null, leaseEnd: null, beds: 2, baths: 1, sqft: 850 },
      { unit: "19", tenant: "Nicole Evans",      rent: 1000, market: 1100, status: "occupied", leaseStart: "2025-06-15", leaseEnd: "2026-06-14", beds: 2, baths: 1, sqft: 900 },
      { unit: "20", tenant: "Marcus Bell",       rent: 950,  market: 1100, status: "occupied", leaseStart: "2025-11-15", leaseEnd: "2026-11-14", beds: 2, baths: 1, sqft: 850 },
      { unit: "21", tenant: "Vanessa Torres",    rent: 1050, market: 1100, status: "occupied", leaseStart: "2025-01-01", leaseEnd: "2025-12-31", beds: 3, baths: 2, sqft: 1050 },
    ];
    sunCoveUnits.forEach(u => rentRollData.push({ ...u, property: SUN_COVE }));

    let rentCount = 0;
    for (const r of rentRollData) {
      await client.query(
        `INSERT INTO unit_rent_roll
         (property_id, unit_number, bedrooms, bathrooms, sqft,
          tenant_name, lease_start, lease_end, monthly_rent, market_rent,
          status, security_deposit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [r.property, r.unit, r.beds, r.baths, r.sqft,
         r.tenant, r.leaseStart, r.leaseEnd, r.rent, r.market,
         r.status, r.rent ? r.rent : null]
      );
      rentCount++;
    }
    console.log(`Inserted ${rentCount} unit rent roll entries.\n`);

    // =============================================
    // 5. PROPERTY MONTHLY DATA
    // =============================================
    console.log("--- Inserting property monthly data ---");

    const monthlyData = [
      // Hickory Landing
      { property: HICKORY, month: "2025-11", rent: 3800,  opex: 1900, noi: 1900,  debt: 2800, cashflow: -900,  rehab: 8200 },
      { property: HICKORY, month: "2025-12", rent: 4000,  opex: 2000, noi: 2000,  debt: 2800, cashflow: -800,  rehab: 6500 },
      { property: HICKORY, month: "2026-01", rent: 4200,  opex: 2100, noi: 2100,  debt: 2800, cashflow: -700,  rehab: 5100 },

      // Lucia Apartments
      { property: LUCIA, month: "2025-11", rent: 12500, opex: 4600, noi: 7900,  debt: 4200, cashflow: 3700,  rehab: 2400 },
      { property: LUCIA, month: "2025-12", rent: 12800, opex: 4700, noi: 8100,  debt: 4200, cashflow: 3900,  rehab: 2100 },
      { property: LUCIA, month: "2026-01", rent: 13200, opex: 4800, noi: 8400,  debt: 4200, cashflow: 4200,  rehab: 1800 },

      // MLK Apartments
      { property: MLK, month: "2025-11", rent: 7000,  opex: 3000, noi: 4000,  debt: 3100, cashflow: 900,   rehab: null },
      { property: MLK, month: "2025-12", rent: 7200,  opex: 3100, noi: 4100,  debt: 3100, cashflow: 1000,  rehab: null },
      { property: MLK, month: "2026-01", rent: 7500,  opex: 3200, noi: 4300,  debt: 3100, cashflow: 1200,  rehab: null },

      // Sun Cove Apartments
      { property: SUN_COVE, month: "2025-11", rent: 16500, opex: 5800, noi: 10700, debt: 5800, cashflow: 4900,  rehab: null },
      { property: SUN_COVE, month: "2025-12", rent: 17200, opex: 6000, noi: 11200, debt: 5800, cashflow: 5400,  rehab: null },
      { property: SUN_COVE, month: "2026-01", rent: 17850, opex: 6200, noi: 11650, debt: 5800, cashflow: 5850,  rehab: null },
    ];

    let monthlyCount = 0;
    for (const m of monthlyData) {
      await client.query(
        `INSERT INTO property_monthly_data
         (property_id, month, actual_rent_collected, operating_expenses,
          actual_noi, debt_service_paid, net_cashflow, rehab_spend)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [m.property, m.month, m.rent, m.opex, m.noi, m.debt, m.cashflow, m.rehab]
      );
      monthlyCount++;
    }
    console.log(`Inserted ${monthlyCount} property monthly data entries.\n`);

    // =============================================
    // 6. DEAL PIPELINE
    // =============================================
    console.log("--- Inserting deal pipeline ---");

    const deals = [
      {
        name: "Cypress Gardens 24-Unit", address: "1450 Cypress Gardens Blvd", city: "Tampa", state: "FL",
        units: 24, asking: 2400000, offer: 2150000, stage: "due_diligence",
        source: "broker", brokerName: "Mark Sullivan", brokerContact: "msullivan@cbre.com",
        financing: "bridge", thesis: "Value-add with 40% rent upside. Bridge loan to stabilize, refi into agency debt at month 18.",
        projectedNOI: 192000, projectedCapRate: "0.0893", projectedIRR: "22.50",
        equityNeeded: 650000, loiDate: "2026-01-15", contractDate: "2026-02-01", ddDeadline: "2026-03-01"
      },
      {
        name: "Palm Shores 12-Unit", address: "820 Palm Shores Dr", city: "St Petersburg", state: "FL",
        units: 12, asking: 1650000, offer: null, stage: "underwriting",
        source: "off-market", brokerName: null, brokerContact: null,
        financing: "bridge", thesis: "Off-market deal from direct mail. Below-market rents with cosmetic rehab opportunity.",
        projectedNOI: 118000, projectedCapRate: "0.0715", projectedIRR: "19.80",
        equityNeeded: 425000, loiDate: null, contractDate: null, ddDeadline: null
      },
      {
        name: "Bayshore Commons 32-Unit", address: "3200 Bayshore Blvd", city: "Clearwater", state: "FL",
        units: 32, asking: 3800000, offer: null, stage: "sourced",
        source: "broker", brokerName: "Jennifer Walsh", brokerContact: "jwalsh@marcusmillichap.com",
        financing: null, thesis: "Large stabilized asset with below-market rents. Potential for operational improvements.",
        projectedNOI: 285000, projectedCapRate: "0.0750", projectedIRR: null,
        equityNeeded: null, loiDate: null, contractDate: null, ddDeadline: null
      },
    ];

    let dealCount = 0;
    for (const d of deals) {
      await client.query(
        `INSERT INTO deal_pipeline
         (name, address, city, state, units, asking_price, offer_price,
          projected_noi, projected_cap_rate, projected_irr,
          stage, source, broker_name, broker_contact,
          financing_strategy, investment_thesis, equity_needed,
          loi_date, contract_date, dd_deadline)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [d.name, d.address, d.city, d.state, d.units, d.asking, d.offer,
         d.projectedNOI, d.projectedCapRate, d.projectedIRR,
         d.stage, d.source, d.brokerName, d.brokerContact,
         d.financing, d.thesis, d.equityNeeded,
         d.loiDate, d.contractDate, d.ddDeadline]
      );
      dealCount++;
    }
    console.log(`Inserted ${dealCount} deal pipeline entries.\n`);

    // =============================================
    // 7. INVESTOR LEADS
    // =============================================
    console.log("--- Inserting investor leads ---");

    const leads = [
      { first: "Robert", last: "Chen", email: "robert.chen@gmail.com", phone: "813-555-1001", company: "Chen Capital Group", accredited: "verified", capital: 500000, source: "referral", referredBy: null, stage: "committed", interest: "hot", lastContact: "2026-02-18", nextFollowUp: "2026-02-25" },
      { first: "Sarah", last: "Williams", email: "sarah.williams@outlook.com", phone: "727-555-2002", company: "Williams Family Office", accredited: "self_reported", capital: 750000, source: "event", referredBy: null, stage: "meeting_complete", interest: "hot", lastContact: "2026-02-15", nextFollowUp: "2026-02-22" },
      { first: "James", last: "Martinez", email: "james.martinez@yahoo.com", phone: "813-555-3003", company: null, accredited: "unknown", capital: 250000, source: "linkedin", referredBy: null, stage: "qualified", interest: "warm", lastContact: "2026-02-10", nextFollowUp: "2026-02-24" },
      { first: "Patricia", last: "Anderson", email: "p.anderson@comcast.net", phone: "941-555-4004", company: "Anderson Ventures", accredited: "unknown", capital: 150000, source: "website", referredBy: null, stage: "contacted", interest: "warm", lastContact: "2026-02-05", nextFollowUp: "2026-02-20" },
      { first: "David", last: "Thompson", email: "david.thompson@proton.me", phone: "813-555-5005", company: "Thompson Holdings LLC", accredited: "verified", capital: 1000000, source: "referral", referredBy: "Robert Chen", stage: "new", interest: "hot", lastContact: null, nextFollowUp: "2026-02-23" },
    ];

    const leadIds = {};
    for (const l of leads) {
      const res = await client.query(
        `INSERT INTO investor_leads
         (first_name, last_name, email, phone, company, accredited_status,
          investable_capital, source, referred_by, stage, interest_level,
          last_contact_date, next_follow_up_date, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id`,
        [l.first, l.last, l.email, l.phone, l.company, l.accredited,
         l.capital, l.source, l.referredBy, l.stage, l.interest,
         l.lastContact, l.nextFollowUp, null]
      );
      leadIds[l.first + " " + l.last] = res.rows[0].id;
      console.log(`  Lead: ${l.first} ${l.last} -> ${leadIds[l.first + " " + l.last]}`);
    }
    console.log(`Inserted ${leads.length} investor leads.\n`);

    // =============================================
    // 8. INVESTOR COMMUNICATIONS
    // =============================================
    console.log("--- Inserting investor communications ---");

    const comms = [
      { lead: "Robert Chen", type: "email", direction: "outbound", subject: "5Central Capital - Cypress Gardens Opportunity", content: "Hi Robert, following up on our conversation about the Cypress Gardens 24-unit acquisition. Attached is the investment summary with projected returns.", sentBy: "Michael", status: "read", sentAt: "2026-02-10T10:30:00Z" },
      { lead: "Robert Chen", type: "phone", direction: "inbound", subject: "Follow-up call - commitment discussion", content: "Robert called to confirm his $500K commitment to the Cypress Gardens deal. Wants to review final docs next week.", sentBy: "Michael", status: "sent", sentAt: "2026-02-18T14:00:00Z" },
      { lead: "Sarah Williams", type: "meeting", direction: "outbound", subject: "In-person meeting - Tampa office", content: "Met with Sarah to walk through the portfolio overview and current deal pipeline. Very interested in the value-add strategy. Wants to see Sun Cove rehab progress.", sentBy: "Michael", status: "sent", sentAt: "2026-02-15T11:00:00Z" },
      { lead: "Sarah Williams", type: "email", direction: "outbound", subject: "Meeting follow-up + Sun Cove photos", content: "Hi Sarah, great meeting you today. As discussed, attached are the before/after photos of Sun Cove Unit A1 and the current portfolio performance summary.", sentBy: "Michael", status: "delivered", sentAt: "2026-02-15T16:00:00Z" },
      { lead: "James Martinez", type: "email", direction: "outbound", subject: "Introduction to 5Central Capital", content: "Hi James, thanks for connecting on LinkedIn. I'd love to share more about what we're building at 5Central Capital. Are you available for a 15-min call this week?", sentBy: "Michael", status: "read", sentAt: "2026-02-08T09:00:00Z" },
      { lead: "James Martinez", type: "phone", direction: "outbound", subject: "Intro call - investment criteria discussion", content: "Spoke with James for 20 minutes. He's looking for passive real estate investments in the $200-300K range. Interested in our next deal.", sentBy: "Michael", status: "sent", sentAt: "2026-02-10T15:30:00Z" },
      { lead: "Patricia Anderson", type: "email", direction: "inbound", subject: "RE: 5Central Capital website inquiry", content: "Patricia submitted a contact form on the website asking about investment minimums and current opportunities.", sentBy: "Patricia Anderson", status: "read", sentAt: "2026-02-05T08:00:00Z" },
      { lead: "David Thompson", type: "email", direction: "outbound", subject: "Introduction from Robert Chen", content: "Hi David, Robert Chen suggested I reach out. He mentioned you might be interested in our multifamily investment opportunities in the Tampa Bay area. Would love to set up a call.", sentBy: "Michael", status: "sent", sentAt: "2026-02-22T09:00:00Z" },
    ];

    let commCount = 0;
    for (const c of comms) {
      await client.query(
        `INSERT INTO investor_communications
         (lead_id, type, direction, subject, content, sent_by, status, sent_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [leadIds[c.lead], c.type, c.direction, c.subject, c.content, c.sentBy, c.status, c.sentAt]
      );
      commCount++;
    }
    console.log(`Inserted ${commCount} investor communications.\n`);

    // =============================================
    // 9. MAINTENANCE REQUESTS
    // =============================================
    console.log("--- Inserting maintenance requests ---");

    const maintenanceData = [
      { property: HICKORY, unit: "2", tenant: "James Wilson", title: "Leaking kitchen faucet", desc: "Kitchen sink faucet is dripping constantly. Water bill likely affected.", category: "plumbing", priority: "medium", status: "in_progress", assigned: "Henry Ramos", estCost: 150, actualCost: null, scheduledDate: "2026-02-20" },
      { property: HICKORY, unit: "4", tenant: "Kevin Brown", title: "Outlet not working in bedroom", desc: "Two outlets on the south wall of the master bedroom stopped working. Breaker doesn't seem tripped.", category: "electrical", priority: "high", status: "assigned", assigned: "Henry Ramos", estCost: 200, actualCost: null, scheduledDate: "2026-02-22" },
      { property: LUCIA, unit: "7", tenant: "Brian Thompson", title: "AC not cooling properly", desc: "AC runs but doesn't cool below 80 degrees. Filter was changed last month.", category: "hvac", priority: "high", status: "open", assigned: null, estCost: 500, actualCost: null, scheduledDate: null },
      { property: LUCIA, unit: "3", tenant: "Lisa Chen", title: "Dishwasher not draining", desc: "Dishwasher fills with water but won't drain at end of cycle. Standing water at the bottom.", category: "appliance", priority: "medium", status: "complete", assigned: "Vendor - Appliance Pro", estCost: 250, actualCost: 185, scheduledDate: "2026-02-12" },
      { property: MLK, unit: "1", tenant: "Anthony Harris", title: "Toilet running constantly", desc: "Toilet in the main bathroom runs non-stop. Tried jiggling the handle.", category: "plumbing", priority: "medium", status: "complete", assigned: "Giovanni", estCost: 75, actualCost: 45, scheduledDate: "2026-02-08" },
      { property: SUN_COVE, unit: "6", tenant: "Patricia Foster", title: "Water heater making noise", desc: "Hot water heater is making loud popping and banging sounds. Still producing hot water but concerned.", category: "plumbing", priority: "high", status: "assigned", assigned: "Vendor - Tampa Plumbing Co", estCost: 600, actualCost: null, scheduledDate: "2026-02-23" },
      { property: SUN_COVE, unit: "15", tenant: "Ricardo Perez", title: "Garbage disposal jammed", desc: "Garbage disposal is stuck and humming when turned on. Reset button doesn't fix it.", category: "appliance", priority: "low", status: "open", assigned: null, estCost: 100, actualCost: null, scheduledDate: null },
      { property: MLK, unit: "9", tenant: "Frank Turner", title: "Ceiling fan wobbling badly", desc: "Ceiling fan in living room wobbles significantly at any speed. Concerned it may fall.", category: "electrical", priority: "medium", status: "in_progress", assigned: "Marvin", estCost: 120, actualCost: null, scheduledDate: "2026-02-21" },
    ];

    let maintCount = 0;
    for (const m of maintenanceData) {
      await client.query(
        `INSERT INTO maintenance_requests
         (property_id, unit_number, tenant_name, title, description,
          category, priority, status, assigned_to, estimated_cost,
          actual_cost, scheduled_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [m.property, m.unit, m.tenant, m.title, m.desc,
         m.category, m.priority, m.status, m.assigned, m.estCost,
         m.actualCost, m.scheduledDate]
      );
      maintCount++;
    }
    console.log(`Inserted ${maintCount} maintenance requests.\n`);

    // =============================================
    // 10. PM NOTES
    // =============================================
    console.log("--- Inserting PM notes ---");

    const pmNotesData = [
      { property: HICKORY, author: "Michael", date: "2026-02-18", content: "Unit 3 rehab progressing well. Demo complete, framing done. Cabinets arriving next week. Henry's crew staying on schedule.", category: "maintenance" },
      { property: HICKORY, author: "Michael", date: "2026-02-15", content: "Spoke with Kevin in Unit 4 about parking situation. He's happy with the unit but wants better lighting in the parking area. Will get a quote for LED fixtures.", category: "tenant" },
      { property: LUCIA, author: "Michael", date: "2026-02-16", content: "Unit 4 and Unit 9 need to be filled ASAP. Listing is live on Zillow and Apartments.com. Showing scheduled for Unit 9 on Wednesday.", category: "leasing" },
      { property: MLK, author: "Michael", date: "2026-02-14", content: "Property is running smoothly. All units collecting rent on time. Two late payments from last month have been resolved. Consider raising rent on Unit 4 at lease renewal - currently $150 below market.", category: "general" },
      { property: SUN_COVE, author: "Michael", date: "2026-02-20", content: "Unit A1 rehab complete - turned out great. A3 kitchen in progress, should be done by end of month. B2 is the big project - full gut kitchen will take 3+ weeks.", category: "maintenance" },
      { property: SUN_COVE, author: "Michael", date: "2026-02-17", content: "Patricia in Unit 6 lease ending Feb 28. She wants to renew but is pushing back on rent increase to $1000. Current rent $800 is way below market. Minimum acceptable renewal at $950.", category: "tenant" },
    ];

    let pmNoteCount = 0;
    for (const n of pmNotesData) {
      await client.query(
        `INSERT INTO pm_notes (property_id, author, date, content, category)
         VALUES ($1,$2,$3,$4,$5)`,
        [n.property, n.author, n.date, n.content, n.category]
      );
      pmNoteCount++;
    }
    console.log(`Inserted ${pmNoteCount} PM notes.\n`);

    // =============================================
    // 11. PM ESCALATIONS
    // =============================================
    console.log("--- Inserting PM escalations ---");

    const escalations = [
      { property: HICKORY, title: "Unit 5 rehab over budget", desc: "Framing costs came in $800 over original estimate due to unexpected water damage behind walls. Need to approve additional spend.", priority: "high", trigger: "spend_over_limit", status: "open", escalatedBy: "Henry Ramos", spendAmount: 2800, notes: "Original framing budget was $2000. Water damage repair needed before continuing." },
      { property: LUCIA, title: "HVAC emergency - Unit 7", desc: "AC unit completely failed in Unit 7. Tenant Brian Thompson has health concerns. Need emergency HVAC replacement or repair.", priority: "critical", trigger: "emergency", status: "acknowledged", escalatedBy: "Michael", spendAmount: 3500, notes: "Got quote from Tampa HVAC Co for $3200 replacement. Need to authorize." },
      { property: SUN_COVE, title: "Tenant requesting rent concession", desc: "Patricia Foster in Unit 6 requesting $100/month concession for 3 months due to noise from B2 rehab work next door.", priority: "medium", trigger: "rent_concession", status: "open", escalatedBy: "Michael", spendAmount: 300, notes: "Rehab expected to take 3-4 more weeks. Concession would cost $300 total." },
      { property: MLK, title: "Unauthorized vendor at property", desc: "PM noticed an unknown vendor doing work at Unit 3 without authorization. Turned out to be a tenant's personal handyman working on cosmetic changes.", priority: "low", trigger: "vendor_change", status: "resolved", escalatedBy: "Michael", spendAmount: null, notes: "Spoke with tenant. They will not bring unauthorized workers to the property again. No damage done." },
    ];

    let escCount = 0;
    for (const e of escalations) {
      await client.query(
        `INSERT INTO pm_escalations
         (property_id, title, description, priority, trigger, status,
          escalated_by, spend_amount, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [e.property, e.title, e.desc, e.priority, e.trigger, e.status,
         e.escalatedBy, e.spendAmount, e.notes]
      );
      escCount++;
    }
    console.log(`Inserted ${escCount} PM escalations.\n`);

    console.log("===========================================");
    console.log("Seed complete! Summary:");
    console.log(`  Workers:            ${workersData.length}`);
    console.log(`  Payroll entries:    ${payrollCount}`);
    console.log(`  Rehab line items:   ${rehabCount}`);
    console.log(`  Unit rent roll:     ${rentCount}`);
    console.log(`  Monthly data:       ${monthlyCount}`);
    console.log(`  Deal pipeline:      ${dealCount}`);
    console.log(`  Investor leads:     ${leads.length}`);
    console.log(`  Communications:     ${commCount}`);
    console.log(`  Maintenance:        ${maintCount}`);
    console.log(`  PM notes:           ${pmNoteCount}`);
    console.log(`  PM escalations:     ${escCount}`);
    console.log("===========================================");

  } catch (err) {
    console.error("Seed failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
