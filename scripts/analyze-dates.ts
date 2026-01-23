import XLSX from 'xlsx';

// Check acquisition dates for current properties from Portfolio Overview
const finWorkbook = XLSX.readFile('/Users/michaelmcelwee/Downloads/one page finances.xlsx');
const overviewSheet = finWorkbook.Sheets['Portfolio Overview'];
const data = XLSX.utils.sheet_to_json(overviewSheet, { header: 1 }) as any[][];

console.log("Looking for acquisition dates in Portfolio Overview...\n");

// Check debt maturity section (rows 23-27) for loan info
console.log("Debt info (rows 23-28):");
for (let i = 23; i <= 28; i++) {
  const row = data[i];
  if (row && row[0]) {
    console.log(`Row ${i}: ${JSON.stringify(row.slice(0, 10))}`);
  }
}

// Check return metrics (rows 40-44) for hold period
console.log("\nReturn metrics (rows 40-45):");
for (let i = 40; i <= 45; i++) {
  const row = data[i];
  if (row && row[0]) {
    console.log(`Row ${i}: Property: ${row[0]}, Hold Period: ${row[9]}`);
  }
}
