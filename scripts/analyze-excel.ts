import XLSX from 'xlsx';

// Analyze sold properties - REO sheet
console.log("=== SOLD PROPERTIES (REO Sheet) ===");
const soldWorkbook = XLSX.readFile('/Users/michaelmcelwee/Downloads/sold properties.xlsx');
const reoSheet = soldWorkbook.Sheets['REO'];
const reoData = XLSX.utils.sheet_to_json(reoSheet, { header: 1 }) as any[][];

console.log("\nAll rows:");
reoData.forEach((row, i) => {
  const nonEmpty = row.filter(cell => cell !== undefined && cell !== null && cell !== '');
  if (nonEmpty.length > 0) {
    console.log(`Row ${i}: ${JSON.stringify(row)}`);
  }
});

// Analyze Portfolio Overview
console.log("\n\n=== PORTFOLIO OVERVIEW ===");
const finWorkbook = XLSX.readFile('/Users/michaelmcelwee/Downloads/one page finances.xlsx');
const overviewSheet = finWorkbook.Sheets['Portfolio Overview'];
const overviewData = XLSX.utils.sheet_to_json(overviewSheet, { header: 1 }) as any[][];

console.log("\nAll non-empty rows (first 60):");
let count = 0;
overviewData.forEach((row, i) => {
  const nonEmpty = row.filter(cell => cell !== undefined && cell !== null && cell !== '');
  if (nonEmpty.length > 0 && count < 60) {
    console.log(`Row ${i}: ${JSON.stringify(row)}`);
    count++;
  }
});
