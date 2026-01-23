import XLSX from 'xlsx';

// Analyze ALL data from both Excel files

console.log("=== SOLD PROPERTIES (Full Detail) ===\n");
const soldWorkbook = XLSX.readFile('/Users/michaelmcelwee/Downloads/sold properties.xlsx');
const reoSheet = soldWorkbook.Sheets['REO'];
const reoData = XLSX.utils.sheet_to_json(reoSheet, { header: 1 }) as any[][];

// Headers are in row 3
console.log("Headers (row 3):", reoData[3]);
console.log("\nSample sold property (row 14 - 41 Stuart Ave):");
console.log(JSON.stringify(reoData[14], null, 2));

console.log("\n\n=== CURRENT PROPERTIES (Full Detail) ===\n");
const finWorkbook = XLSX.readFile('/Users/michaelmcelwee/Downloads/one page finances.xlsx');

// Portfolio Overview - Return Metrics section
const overviewSheet = finWorkbook.Sheets['Portfolio Overview'];
const overviewData = XLSX.utils.sheet_to_json(overviewSheet, { header: 1 }) as any[][];

console.log("Return Metrics Headers (row 40):");
console.log(JSON.stringify(overviewData[40], null, 2));

console.log("\nSun Cove (row 41):");
console.log(JSON.stringify(overviewData[41], null, 2));

// Rent Roll section
console.log("\n\nRent Roll Headers (row 52):");
console.log(JSON.stringify(overviewData[52], null, 2));

console.log("\nRent Roll Data (rows 53-56):");
for (let i = 53; i <= 56; i++) {
  console.log(`Row ${i}:`, JSON.stringify(overviewData[i]));
}

// Debt section
console.log("\n\nDebt Section (rows 61-66):");
for (let i = 61; i <= 66; i++) {
  console.log(`Row ${i}:`, JSON.stringify(overviewData[i]));
}

// Check individual property sheets for more detail
console.log("\n\n=== INDIVIDUAL PROPERTY SHEETS ===");

for (const sheetName of ['Sun Cove Apartments', 'Lucia Apartments', 'Hickory Landing', 'MLK Apartments']) {
  const sheet = finWorkbook.Sheets[sheetName];
  if (sheet) {
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][];
    console.log(`\n--- ${sheetName} (first 30 non-empty rows) ---`);
    let count = 0;
    data.forEach((row, i) => {
      const nonEmpty = row.filter(cell => cell !== undefined && cell !== null && cell !== '');
      if (nonEmpty.length > 0 && count < 30) {
        console.log(`Row ${i}: ${JSON.stringify(row)}`);
        count++;
      }
    });
  }
}
