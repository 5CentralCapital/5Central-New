/**
 * Data seed script — loads actual financial data into the 5Central command center.
 * Sources: Hickory Landing payroll tracker, St Pete rehab cost PDF, Portfolio Overview.
 *
 * Run: npx tsx scripts/seed-data.ts
 * Or via the API by calling POST /api/seed (if wired up)
 */

const BASE = process.env.API_URL || "http://localhost:5000";

async function post(path: string, body: any) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: "connect.sid=admin" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`  FAILED ${path}:`, text);
  }
  return res;
}

async function seedWorkers() {
  console.log("\n=== Seeding Workers ===");
  const workers = [
    { name: "Henry Ramos", role: "lead", defaultRate: "25", paymentMethod: "zelle", status: "active", hireDate: "2026-02-03" },
    { name: "Giovanni", role: "helper", defaultRate: "25", paymentMethod: "zelle", status: "active", hireDate: "2026-02-03" },
    { name: "Marvin", role: "helper", defaultRate: "20", paymentMethod: "zelle", status: "active", hireDate: "2026-02-03" },
    { name: "Rubierto", role: "helper", defaultRate: "20", paymentMethod: "zelle", status: "active", hireDate: "2026-02-03" },
    { name: "Maritza", role: "cleaner", defaultRate: "16", paymentMethod: "zelle", status: "active", hireDate: "2026-02-10" },
  ];
  for (const w of workers) {
    await post("/api/workers", w);
    console.log(`  + ${w.name} ($${w.defaultRate}/hr)`);
  }
}

async function seedPayrollEntries() {
  console.log("\n=== Seeding Payroll Entries (Hickory Landing) ===");

  // Week 1: Feb 3-8, 2026
  const week1Entries = [
    // Henry - 44hrs
    { task: "demo_kitchens", date: "2026-02-03", hours: "8", rate: "25", weekEnding: "2026-02-08" },
    { task: "demo_kitchens", date: "2026-02-04", hours: "8", rate: "25", weekEnding: "2026-02-08" },
    { task: "framing", date: "2026-02-05", hours: "8", rate: "25", weekEnding: "2026-02-08" },
    { task: "framing", date: "2026-02-06", hours: "8", rate: "25", weekEnding: "2026-02-08" },
    { task: "framing", date: "2026-02-07", hours: "8", rate: "25", weekEnding: "2026-02-08" },
    { task: "electrical_rough", date: "2026-02-08", hours: "4", rate: "25", weekEnding: "2026-02-08" },
    // Giovanni - 44hrs
    { task: "demo_kitchens", date: "2026-02-03", hours: "8", rate: "25", weekEnding: "2026-02-08" },
    { task: "demo_kitchens", date: "2026-02-04", hours: "8", rate: "25", weekEnding: "2026-02-08" },
    { task: "drywall_repair", date: "2026-02-05", hours: "8", rate: "25", weekEnding: "2026-02-08" },
    { task: "drywall_repair", date: "2026-02-06", hours: "8", rate: "25", weekEnding: "2026-02-08" },
    { task: "plumbing_rough", date: "2026-02-07", hours: "8", rate: "25", weekEnding: "2026-02-08" },
    { task: "plumbing_rough", date: "2026-02-08", hours: "4", rate: "25", weekEnding: "2026-02-08" },
    // Marvin - 40hrs
    { task: "demo_bathrooms", date: "2026-02-03", hours: "8", rate: "20", weekEnding: "2026-02-08" },
    { task: "demo_bathrooms", date: "2026-02-04", hours: "8", rate: "20", weekEnding: "2026-02-08" },
    { task: "painting_prep", date: "2026-02-05", hours: "8", rate: "20", weekEnding: "2026-02-08" },
    { task: "painting_prep", date: "2026-02-06", hours: "8", rate: "20", weekEnding: "2026-02-08" },
    { task: "painting", date: "2026-02-07", hours: "8", rate: "20", weekEnding: "2026-02-08" },
    // Rubierto - 40hrs
    { task: "demo_bathrooms", date: "2026-02-03", hours: "8", rate: "20", weekEnding: "2026-02-08" },
    { task: "hauling_debris", date: "2026-02-04", hours: "8", rate: "20", weekEnding: "2026-02-08" },
    { task: "painting_prep", date: "2026-02-05", hours: "8", rate: "20", weekEnding: "2026-02-08" },
    { task: "painting", date: "2026-02-06", hours: "8", rate: "20", weekEnding: "2026-02-08" },
    { task: "flooring_prep", date: "2026-02-07", hours: "8", rate: "20", weekEnding: "2026-02-08" },
  ];

  // Week 2: Feb 10-15, 2026
  const week2Entries = [
    // Henry - 44hrs
    { task: "electrical_finish", date: "2026-02-10", hours: "8", rate: "25", weekEnding: "2026-02-15" },
    { task: "electrical_finish", date: "2026-02-11", hours: "8", rate: "25", weekEnding: "2026-02-15" },
    { task: "cabinet_install", date: "2026-02-12", hours: "8", rate: "25", weekEnding: "2026-02-15" },
    { task: "cabinet_install", date: "2026-02-13", hours: "8", rate: "25", weekEnding: "2026-02-15" },
    { task: "countertop_install", date: "2026-02-14", hours: "8", rate: "25", weekEnding: "2026-02-15" },
    { task: "countertop_install", date: "2026-02-15", hours: "4", rate: "25", weekEnding: "2026-02-15" },
    // Giovanni - 44hrs
    { task: "plumbing_finish", date: "2026-02-10", hours: "8", rate: "25", weekEnding: "2026-02-15" },
    { task: "plumbing_finish", date: "2026-02-11", hours: "8", rate: "25", weekEnding: "2026-02-15" },
    { task: "tile_work", date: "2026-02-12", hours: "8", rate: "25", weekEnding: "2026-02-15" },
    { task: "tile_work", date: "2026-02-13", hours: "8", rate: "25", weekEnding: "2026-02-15" },
    { task: "fixture_install", date: "2026-02-14", hours: "8", rate: "25", weekEnding: "2026-02-15" },
    { task: "fixture_install", date: "2026-02-15", hours: "4", rate: "25", weekEnding: "2026-02-15" },
    // Marvin - 44hrs
    { task: "painting", date: "2026-02-10", hours: "8", rate: "20", weekEnding: "2026-02-15" },
    { task: "painting", date: "2026-02-11", hours: "8", rate: "20", weekEnding: "2026-02-15" },
    { task: "flooring_install", date: "2026-02-12", hours: "8", rate: "20", weekEnding: "2026-02-15" },
    { task: "flooring_install", date: "2026-02-13", hours: "8", rate: "20", weekEnding: "2026-02-15" },
    { task: "flooring_install", date: "2026-02-14", hours: "8", rate: "20", weekEnding: "2026-02-15" },
    { task: "punch_list", date: "2026-02-15", hours: "4", rate: "20", weekEnding: "2026-02-15" },
    // Rubierto - 44hrs
    { task: "flooring_prep", date: "2026-02-10", hours: "8", rate: "20", weekEnding: "2026-02-15" },
    { task: "flooring_install", date: "2026-02-11", hours: "8", rate: "20", weekEnding: "2026-02-15" },
    { task: "flooring_install", date: "2026-02-12", hours: "8", rate: "20", weekEnding: "2026-02-15" },
    { task: "baseboard_trim", date: "2026-02-13", hours: "8", rate: "20", weekEnding: "2026-02-15" },
    { task: "baseboard_trim", date: "2026-02-14", hours: "8", rate: "20", weekEnding: "2026-02-15" },
    { task: "punch_list", date: "2026-02-15", hours: "4", rate: "20", weekEnding: "2026-02-15" },
    // Maritza - 16hrs (joined week 2)
    { task: "deep_clean", date: "2026-02-14", hours: "8", rate: "16", weekEnding: "2026-02-15" },
    { task: "deep_clean", date: "2026-02-15", hours: "8", rate: "16", weekEnding: "2026-02-15" },
  ];

  // We need worker IDs — fetch them first
  const workersRes = await fetch(`${BASE}/api/workers`, { headers: { Cookie: "connect.sid=admin" } });
  const workers = await workersRes.json();
  const byName = (name: string) => workers.find((w: any) => w.name.toLowerCase().includes(name.toLowerCase()))?.id;

  const workerAssignments: Record<number, string> = {};
  // Week 1: Henry 0-5, Giovanni 6-11, Marvin 12-16, Rubierto 17-21
  for (let i = 0; i <= 5; i++) workerAssignments[i] = byName("Henry");
  for (let i = 6; i <= 11; i++) workerAssignments[i] = byName("Giovanni");
  for (let i = 12; i <= 16; i++) workerAssignments[i] = byName("Marvin");
  for (let i = 17; i <= 21; i++) workerAssignments[i] = byName("Rubierto");

  for (let i = 0; i < week1Entries.length; i++) {
    const e = week1Entries[i];
    await post("/api/payroll/entries", {
      ...e,
      workerId: workerAssignments[i],
      propertyId: "hickory",
      total: String(Number(e.hours) * Number(e.rate)),
    });
  }
  console.log(`  + ${week1Entries.length} entries for Week 1 (Feb 3-8)`);

  // Week 2 assignments
  const w2Assignments: Record<number, string> = {};
  for (let i = 0; i <= 5; i++) w2Assignments[i] = byName("Henry");
  for (let i = 6; i <= 11; i++) w2Assignments[i] = byName("Giovanni");
  for (let i = 12; i <= 17; i++) w2Assignments[i] = byName("Marvin");
  for (let i = 18; i <= 23; i++) w2Assignments[i] = byName("Rubierto");
  for (let i = 24; i <= 25; i++) w2Assignments[i] = byName("Maritza");

  for (let i = 0; i < week2Entries.length; i++) {
    const e = week2Entries[i];
    await post("/api/payroll/entries", {
      ...e,
      workerId: w2Assignments[i],
      propertyId: "hickory",
      total: String(Number(e.hours) * Number(e.rate)),
    });
  }
  console.log(`  + ${week2Entries.length} entries for Week 2 (Feb 10-15)`);
}

async function seedPayrollPayments() {
  console.log("\n=== Seeding Payroll Payments ===");
  const workersRes = await fetch(`${BASE}/api/workers`, { headers: { Cookie: "connect.sid=admin" } });
  const workers = await workersRes.json();
  const byName = (name: string) => workers.find((w: any) => w.name.toLowerCase().includes(name.toLowerCase()))?.id;

  const payments = [
    { workerId: byName("Henry"), amount: "1100", paymentMethod: "zelle", periodStart: "2026-02-03", periodEnd: "2026-02-08", paidAt: "2026-02-08", status: "paid", memo: "Week 1 - 44hrs" },
    { workerId: byName("Giovanni"), amount: "1100", paymentMethod: "zelle", periodStart: "2026-02-03", periodEnd: "2026-02-08", paidAt: "2026-02-08", status: "paid", memo: "Week 1 - 44hrs" },
    { workerId: byName("Marvin"), amount: "800", paymentMethod: "zelle", periodStart: "2026-02-03", periodEnd: "2026-02-08", paidAt: "2026-02-08", status: "paid", memo: "Week 1 - 40hrs" },
    { workerId: byName("Rubierto"), amount: "800", paymentMethod: "zelle", periodStart: "2026-02-03", periodEnd: "2026-02-08", paidAt: "2026-02-08", status: "paid", memo: "Week 1 - 40hrs" },
    { workerId: byName("Henry"), amount: "1100", paymentMethod: "zelle", periodStart: "2026-02-10", periodEnd: "2026-02-15", paidAt: "2026-02-15", status: "paid", memo: "Week 2 - 44hrs" },
    { workerId: byName("Giovanni"), amount: "1100", paymentMethod: "zelle", periodStart: "2026-02-10", periodEnd: "2026-02-15", paidAt: "2026-02-15", status: "paid", memo: "Week 2 - 44hrs" },
    { workerId: byName("Marvin"), amount: "880", paymentMethod: "zelle", periodStart: "2026-02-10", periodEnd: "2026-02-15", paidAt: "2026-02-15", status: "paid", memo: "Week 2 - 44hrs" },
    { workerId: byName("Rubierto"), amount: "880", paymentMethod: "zelle", periodStart: "2026-02-10", periodEnd: "2026-02-15", paidAt: "2026-02-15", status: "paid", memo: "Week 2 - 44hrs" },
    { workerId: byName("Maritza"), amount: "256", paymentMethod: "zelle", periodStart: "2026-02-14", periodEnd: "2026-02-15", paidAt: "2026-02-15", status: "paid", memo: "Week 2 - 16hrs" },
  ];

  for (const p of payments) {
    await post("/api/payroll/payments", p);
  }
  console.log(`  + ${payments.length} payments recorded`);
}

async function seedStPeteRehabItems() {
  console.log("\n=== Seeding St Pete Rehab Line Items ===");

  // Unit C1 - 5633 Crissman Ln
  const c1Items = [
    { unitNumber: "C1", taskName: "Kitchen Cabinets & Counters", contractorBaseline: "3200", inHouseLabor: "600", inHouseMaterials: "1450", status: "complete" },
    { unitNumber: "C1", taskName: "Bathroom Vanity & Tile", contractorBaseline: "2800", inHouseLabor: "500", inHouseMaterials: "890", status: "complete" },
    { unitNumber: "C1", taskName: "Flooring (LVP)", contractorBaseline: "2000", inHouseLabor: "350", inHouseMaterials: "720", status: "complete" },
    { unitNumber: "C1", taskName: "Paint Interior", contractorBaseline: "1200", inHouseLabor: "300", inHouseMaterials: "180", status: "complete" },
    { unitNumber: "C1", taskName: "Electrical Updates", contractorBaseline: "1800", inHouseLabor: "400", inHouseMaterials: "320", status: "complete" },
    { unitNumber: "C1", taskName: "Plumbing Updates", contractorBaseline: "1500", inHouseLabor: "350", inHouseMaterials: "280", status: "complete" },
    { unitNumber: "C1", taskName: "Appliances", contractorBaseline: "1400", inHouseLabor: "0", inHouseMaterials: "1380", status: "complete" },
  ];

  // Unit C2 - 5633 Crissman Ln
  const c2Items = [
    { unitNumber: "C2", taskName: "Kitchen Cabinets & Counters", contractorBaseline: "3200", inHouseLabor: "600", inHouseMaterials: "1450", status: "complete" },
    { unitNumber: "C2", taskName: "Bathroom Vanity & Tile", contractorBaseline: "2800", inHouseLabor: "500", inHouseMaterials: "890", status: "complete" },
    { unitNumber: "C2", taskName: "Flooring (LVP)", contractorBaseline: "2000", inHouseLabor: "350", inHouseMaterials: "720", status: "in_progress" },
    { unitNumber: "C2", taskName: "Paint Interior", contractorBaseline: "1200", inHouseLabor: "300", inHouseMaterials: "180", status: "in_progress" },
    { unitNumber: "C2", taskName: "Electrical Updates", contractorBaseline: "1800", inHouseLabor: "400", inHouseMaterials: "320", status: "not_started" },
    { unitNumber: "C2", taskName: "Plumbing Updates", contractorBaseline: "1500", inHouseLabor: "350", inHouseMaterials: "280", status: "not_started" },
    { unitNumber: "C2", taskName: "Appliances", contractorBaseline: "1400", inHouseLabor: "0", inHouseMaterials: "1380", status: "not_started" },
  ];

  // Unit C6 - 5633 Crissman Ln
  const c6Items = [
    { unitNumber: "C6", taskName: "Kitchen Full Gut", contractorBaseline: "3800", inHouseLabor: "800", inHouseMaterials: "1650", status: "in_progress" },
    { unitNumber: "C6", taskName: "Bathroom Remodel", contractorBaseline: "3200", inHouseLabor: "600", inHouseMaterials: "1100", status: "not_started" },
    { unitNumber: "C6", taskName: "Flooring (LVP)", contractorBaseline: "2000", inHouseLabor: "350", inHouseMaterials: "720", status: "not_started" },
    { unitNumber: "C6", taskName: "Paint Interior", contractorBaseline: "1200", inHouseLabor: "300", inHouseMaterials: "180", status: "not_started" },
    { unitNumber: "C6", taskName: "HVAC Repair", contractorBaseline: "2500", inHouseLabor: "0", inHouseMaterials: "2200", status: "not_started" },
  ];

  // Unit L2 - 5680 28th St
  const l2Items = [
    { unitNumber: "L2", taskName: "Kitchen Refresh", contractorBaseline: "2800", inHouseLabor: "450", inHouseMaterials: "1200", status: "in_progress" },
    { unitNumber: "L2", taskName: "Bathroom Refresh", contractorBaseline: "2200", inHouseLabor: "400", inHouseMaterials: "750", status: "not_started" },
    { unitNumber: "L2", taskName: "Flooring", contractorBaseline: "1800", inHouseLabor: "300", inHouseMaterials: "680", status: "not_started" },
    { unitNumber: "L2", taskName: "Paint", contractorBaseline: "1000", inHouseLabor: "250", inHouseMaterials: "160", status: "not_started" },
  ];

  // Unit L5 - 5680 28th St
  const l5Items = [
    { unitNumber: "L5", taskName: "Kitchen Refresh", contractorBaseline: "2800", inHouseLabor: "450", inHouseMaterials: "1200", status: "not_started" },
    { unitNumber: "L5", taskName: "Bathroom Refresh", contractorBaseline: "2200", inHouseLabor: "400", inHouseMaterials: "750", status: "not_started" },
    { unitNumber: "L5", taskName: "Flooring", contractorBaseline: "1800", inHouseLabor: "300", inHouseMaterials: "680", status: "not_started" },
    { unitNumber: "L5", taskName: "Paint", contractorBaseline: "1000", inHouseLabor: "250", inHouseMaterials: "160", status: "not_started" },
  ];

  const allItems = [...c1Items, ...c2Items, ...c6Items, ...l2Items, ...l5Items];
  for (const item of allItems) {
    await post("/api/rehab/st-pete/items", {
      propertyId: "st-pete",
      ...item,
    });
  }
  console.log(`  + ${allItems.length} rehab line items seeded across 5 units`);
}

async function seedPortfolioMonthlyData() {
  console.log("\n=== Seeding Portfolio Monthly Data ===");

  // From Portfolio Overview spreadsheet — actual financial data
  const monthlyData = [
    // Sun Cove - 21 units, stabilized
    { propertyId: "sun-cove", month: "2026-01", actualRentCollected: "17850", proformaRent: "18900", occupiedCount: 17, vacancyCount: 4, operatingExpenses: "6200", actualNOI: "11650", proformaNOI: "12700", debtServicePaid: "5800", netCashflow: "5850", rehabSpend: "0", varianceNotes: "4 vacancies — 2 units in turn" },
    { propertyId: "sun-cove", month: "2025-12", actualRentCollected: "18200", proformaRent: "18900", occupiedCount: 18, vacancyCount: 3, operatingExpenses: "5900", actualNOI: "12300", proformaNOI: "12700", debtServicePaid: "5800", netCashflow: "6500", rehabSpend: "2400" },
    { propertyId: "sun-cove", month: "2025-11", actualRentCollected: "17500", proformaRent: "18900", occupiedCount: 17, vacancyCount: 4, operatingExpenses: "6100", actualNOI: "11400", proformaNOI: "12700", debtServicePaid: "5800", netCashflow: "5600", rehabSpend: "3200" },

    // Lucia - 16 units
    { propertyId: "lucia", month: "2026-01", actualRentCollected: "13200", proformaRent: "14400", occupiedCount: 13, vacancyCount: 3, operatingExpenses: "4800", actualNOI: "8400", proformaNOI: "9600", debtServicePaid: "4200", netCashflow: "4200", rehabSpend: "1800", varianceNotes: "3 vacancies in lease-up phase" },
    { propertyId: "lucia", month: "2025-12", actualRentCollected: "12800", proformaRent: "14400", occupiedCount: 12, vacancyCount: 4, operatingExpenses: "4600", actualNOI: "8200", proformaNOI: "9600", debtServicePaid: "4200", netCashflow: "4000", rehabSpend: "4500" },
    { propertyId: "lucia", month: "2025-11", actualRentCollected: "11900", proformaRent: "14400", occupiedCount: 11, vacancyCount: 5, operatingExpenses: "4500", actualNOI: "7400", proformaNOI: "9600", debtServicePaid: "4200", netCashflow: "3200", rehabSpend: "6800" },

    // Hickory Landing - 8 units, in rehab
    { propertyId: "hickory", month: "2026-01", actualRentCollected: "4200", proformaRent: "7200", occupiedCount: 5, vacancyCount: 3, operatingExpenses: "2100", actualNOI: "2100", proformaNOI: "5100", debtServicePaid: "2800", netCashflow: "-700", rehabSpend: "5100", varianceNotes: "Heavy rehab — 3 units gutted" },
    { propertyId: "hickory", month: "2025-12", actualRentCollected: "3800", proformaRent: "7200", occupiedCount: 4, vacancyCount: 4, operatingExpenses: "2000", actualNOI: "1800", proformaNOI: "5100", debtServicePaid: "2800", netCashflow: "-1000", rehabSpend: "4200" },

    // MLK - 10 units
    { propertyId: "mlk", month: "2026-01", actualRentCollected: "7500", proformaRent: "9000", occupiedCount: 8, vacancyCount: 2, operatingExpenses: "3200", actualNOI: "4300", proformaNOI: "5800", debtServicePaid: "3100", netCashflow: "1200", rehabSpend: "0", varianceNotes: "2 vacancies — stable" },
    { propertyId: "mlk", month: "2025-12", actualRentCollected: "7200", proformaRent: "9000", occupiedCount: 8, vacancyCount: 2, operatingExpenses: "3100", actualNOI: "4100", proformaNOI: "5800", debtServicePaid: "3100", netCashflow: "1000", rehabSpend: "1200" },
  ];

  for (const d of monthlyData) {
    await post("/api/monthly-data", d);
  }
  console.log(`  + ${monthlyData.length} monthly data points seeded`);
}

async function seedDealPipeline() {
  console.log("\n=== Seeding Deal Pipeline ===");
  const deals = [
    {
      name: "Cypress Gardens 24-Unit", address: "1250 Cypress Ave", city: "Tampa", state: "FL",
      units: 24, askingPrice: "2400000", offerPrice: "2150000",
      projectedNOI: "192000", projectedCapRate: "0.0893", projectedIRR: "18.5",
      stage: "due_diligence", source: "broker", brokerName: "Marcus Williams", brokerContact: "marcus@cre-tampa.com",
      loiDate: "2026-02-01", contractDate: "2026-02-10", ddDeadline: "2026-03-15",
      equityNeeded: "650000", financingStrategy: "bridge",
      investmentThesis: "Value-add — below market rents, deferred maintenance. 30% rent upside post-rehab.",
    },
    {
      name: "Palm Shores 12-Unit", address: "890 Gulf Blvd", city: "St Petersburg", state: "FL",
      units: 12, askingPrice: "1650000",
      projectedNOI: "128000", projectedCapRate: "0.0776",
      stage: "underwriting", source: "off-market",
      equityNeeded: "450000", financingStrategy: "agency",
      investmentThesis: "Cash-flowing 12-unit, 92% occupied. Light value-add with unit upgrades.",
    },
    {
      name: "Bayshore Commons 32-Unit", address: "2100 Bayshore Dr", city: "Clearwater", state: "FL",
      units: 32, askingPrice: "3800000",
      projectedNOI: "285000", projectedCapRate: "0.0750",
      stage: "sourced", source: "broker", brokerName: "Lisa Chen", brokerContact: "lisa@pinellas-cre.com",
      equityNeeded: "950000", financingStrategy: "bridge",
      investmentThesis: "Potential portfolio anchor. 32 units, 3 buildings, surface parking. 65% occupied — significant upside.",
    },
  ];

  for (const d of deals) {
    await post("/api/deals", d);
    console.log(`  + ${d.name} (${d.stage})`);
  }
}

async function seedInvestorLeads() {
  console.log("\n=== Seeding Investor CRM Leads ===");
  const leads = [
    { firstName: "Robert", lastName: "Chen", email: "robert.chen@email.com", phone: "(813) 555-0142", company: "Chen Capital Partners", accreditedStatus: "verified", investableCapital: "500000", source: "referral", stage: "committed", interestLevel: "hot", lastContactDate: "2026-02-18", notes: "Committed to Cypress Gardens deal" },
    { firstName: "Sarah", lastName: "Williams", email: "sarah.w@gmail.com", phone: "(727) 555-0198", company: "Williams Family Office", accreditedStatus: "verified", investableCapital: "750000", source: "event", stage: "meeting_complete", interestLevel: "hot", lastContactDate: "2026-02-15", nextFollowUpDate: "2026-02-24" },
    { firstName: "James", lastName: "Martinez", email: "jmartinez@tech.co", phone: "(941) 555-0167", company: "TechVest LLC", accreditedStatus: "self_reported", investableCapital: "250000", source: "linkedin", stage: "qualified", interestLevel: "warm", lastContactDate: "2026-02-10", nextFollowUpDate: "2026-02-25" },
    { firstName: "Patricia", lastName: "Anderson", email: "panderson@ymail.com", phone: "(813) 555-0234", accreditedStatus: "unknown", investableCapital: "150000", source: "website", stage: "contacted", interestLevel: "warm", lastContactDate: "2026-02-08" },
    { firstName: "David", lastName: "Thompson", email: "david.t@outlook.com", phone: "(727) 555-0321", company: "Thompson Holdings", accreditedStatus: "verified", investableCapital: "1000000", source: "referral", referredBy: "Robert Chen", stage: "new", interestLevel: "hot", notes: "High net worth — referred by existing investor" },
  ];

  for (const l of leads) {
    await post("/api/crm/leads", l);
    console.log(`  + ${l.firstName} ${l.lastName} (${l.stage})`);
  }
}

// ─── Main ───────────────────────────────────────────────
async function main() {
  console.log("🏗️  5Central Capital — Data Seed Script");
  console.log("═".repeat(50));

  try {
    await seedWorkers();
    await seedPayrollEntries();
    await seedPayrollPayments();
    await seedStPeteRehabItems();
    await seedPortfolioMonthlyData();
    await seedDealPipeline();
    await seedInvestorLeads();

    console.log("\n" + "═".repeat(50));
    console.log("✅ Seed complete! All data loaded.");
  } catch (e) {
    console.error("\n❌ Seed failed:", e);
    process.exit(1);
  }
}

main();
