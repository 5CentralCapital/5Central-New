import XLSX from 'xlsx';

const finWorkbook = XLSX.readFile('/Users/michaelmcelwee/Downloads/one page finances.xlsx');

console.log("=== PORTFOLIO OVERVIEW - Key Metrics ===\n");
const overviewSheet = finWorkbook.Sheets['Portfolio Overview'];
const data = XLSX.utils.sheet_to_json(overviewSheet, { header: 1 }) as any[][];

// Return Metrics section (rows 40-45)
console.log("RETURN METRICS (row 40 headers):");
console.log(JSON.stringify(data[40], null, 2));

console.log("\n--- Property Data ---");
for (let i = 41; i <= 44; i++) {
  const row = data[i];
  if (row && row[0]) {
    console.log(`\n${row[0]}:`);
    console.log(`  Total Basis: ${row[1]}`);
    console.log(`  Sponsor Equity: ${row[2]}`);
    console.log(`  Equity Multiple: ${row[3]}`);
    console.log(`  Hold Period: ${row[9]}`);
    console.log(`  Purchase Price: ${row[10]}`);
    console.log(`  Rehab: ${row[11]}`);
    console.log(`  ARV: ${row[12]}`);
    console.log(`  Initial Debt: ${row[13]}`);
    console.log(`  Current Debt: ${row[14]}`);
    console.log(`  LTV: ${row[15]}`);
  }
}

// NOI section (rows 14-18)
console.log("\n\n=== NOI & CASHFLOW (rows 14-19) ===");
console.log("Headers:", JSON.stringify(data[14]));
for (let i = 15; i <= 18; i++) {
  const row = data[i];
  if (row && row[0]) {
    console.log(`${row[0]}: NOI=${row[1]}, Yield on Cost=${row[2]}, Cap Rate=${row[3]}, Debt Service=${row[6]}, Cashflow=${row[7]}`);
  }
}

// Rent Roll (rows 52-57)
console.log("\n\n=== RENT ROLL (rows 52-57) ===");
console.log("Headers:", JSON.stringify(data[52]));
for (let i = 53; i <= 56; i++) {
  const row = data[i];
  if (row && row[0]) {
    console.log(`${row[0]}: Units=${row[1]}, Occupied=${row[2]}, Occ%=${row[3]}, In-Place=${row[4]}, Proforma=${row[5]}`);
  }
}

// Debt section (rows 61-66)
console.log("\n\n=== DEBT (rows 61-66) ===");
console.log("Headers:", JSON.stringify(data[61]));
for (let i = 62; i <= 65; i++) {
  const row = data[i];
  if (row && row[0]) {
    console.log(`${row[0]}: Balance=${row[1]}, Rate=${row[2]}, Monthly=${row[4]}, Annual=${row[5]}, Maturity=${row[6]}`);
  }
}

// Check individual sheets for acquisition dates
console.log("\n\n=== INDIVIDUAL PROPERTY SHEETS - Acquisition Dates ===");
for (const sheetName of ['Sun Cove Apartments', 'Lucia Apartments', 'Hickory Landing', 'MLK Apartments']) {
  const sheet = finWorkbook.Sheets[sheetName];
  if (sheet) {
    const sheetData = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][];
    // Look for closing date in row 4
    const row4 = sheetData[4];
    const row9 = sheetData[9];
    if (row4) {
      console.log(`\n${sheetName}:`);
      console.log(`  Row 4: ${JSON.stringify(row4.slice(0, 10))}`);
      if (row9) {
        console.log(`  Row 9 (Acquisition Date): ${JSON.stringify(row9.slice(0, 20))}`);
      }
    }
  }
}
