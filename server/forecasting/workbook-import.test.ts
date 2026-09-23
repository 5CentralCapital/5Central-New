import assert from "node:assert/strict";
import test from "node:test";
import { utils, write, type WorkSheet } from "xlsx";
import { forecastAssumptionsSchema } from "../../shared/forecasting/assumptions";
import { dollarsToCents, headerDate, parseWorkbookCashflow } from "./workbook-import";
import { syntheticForecastAssumptionsInput } from "./testing/fixture";

/** A synthetic workbook in the documented Cashflow layout (no company data). */
function syntheticWorkbook(): Buffer {
  const weekly = ["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19"];
  const rows: unknown[][] = [
    ["Cashflow", ...weekly, "2027-01", "2027-02"],
    ["Starting cash balance", 84250.5, null, null, null, null, null],
    ["Rental receipts"],
    ["Rent – Example Court", 12000, 0, 0, 0, 12000, 12000],
    ["RUBS", 450, 0, 0, 0, 450, 450],
    ["Operating"],
    ["Water and sewer", -310.25, -310.25, -310.25, -310.25, null, null],
    ["Property taxes", 0, 0, -2100, 0, 0, -2100],
    ["Current insurance", -900, 0, 0, 0, -900, -900],
    ["Labor (retired)"],
    ["Crew wages", -1500, -1500, -1500, -1500, 0, 0],
    ["Projects"],
    ["Materials – B-1 rehab", -4000, -2500, 0, 0, 0, 0],
    ["Debt"],
    ["Mortgage – Sample Bank", -3376.04, 0, 0, 0, -3376.04, -3376.04],
    ["Investor distribution", 0, 0, 0, -5000, 0, 0],
    ["Owner household draw", -2500, 0, 0, 0, -2500, -2500],
    ["Mystery line", 1, 0, 0, 0, 0, 0],
    ["Ending cash (before missing costs)", 79114.21, null, null, null, null, null],
  ];
  const sheet: WorkSheet = utils.aoa_to_sheet(rows);
  // Formula cells: one with a cached value, one without (not recalculated here).
  sheet["C19"] = { t: "n", f: "B19-SUM(C4:C18)", v: 76794.46 };
  sheet["D19"] = { t: "n", f: "C19-SUM(D4:D18)" };
  const book = utils.book_new();
  utils.book_append_sheet(book, utils.aoa_to_sheet([["Portfolio"], ["Example Court", 12]]), "Overview");
  utils.book_append_sheet(book, sheet, "Cashflow");
  utils.book_append_sheet(book, utils.aoa_to_sheet([["Growth"]]), "3YR");
  return write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

test("dates and amounts convert exactly", () => {
  assert.equal(headerDate({ t: "n", v: 46293 }), "2026-09-28");
  assert.equal(headerDate({ t: "s", v: "2027-01" }), "2027-01-01");
  assert.equal(headerDate({ t: "s", v: "10/5/2026" }), "2026-10-05");
  assert.equal(headerDate({ t: "s", v: "Total" }), null);
  assert.equal(dollarsToCents(-310.25), "-31025");
  assert.equal(dollarsToCents(0.1 + 0.2), "30");
  assert.equal(dollarsToCents("$(1,234.565)"), "-123457");
  assert.equal(dollarsToCents("n/a"), null);
});

test("the documented Cashflow layout maps to reviewable assumption drafts", async () => {
  const draft = await parseWorkbookCashflow(syntheticWorkbook(), { fileName: "Portfolio Overview.xlsx" });
  assert.equal(draft.format, "xlsx");
  assert.equal(draft.sheetName, "Cashflow");
  assert.deepEqual(draft.sheets.map(sheet => sheet.name), ["Overview", "Cashflow", "3YR"]);
  const cashflow = draft.sheets.find(sheet => sheet.name === "Cashflow")!;
  assert.equal(cashflow.formulas, 2);
  assert.equal(cashflow.formulasWithoutCachedValue, 1);
  assert.deepEqual(draft.periods.map(period => period.kind), ["week", "week", "week", "week", "month", "month"]);
  assert.equal(draft.periods[4]!.date, "2027-01-01");

  const mapping = Object.fromEntries(draft.lines.map(line => [line.label, line.mapping]));
  assert.equal(mapping["Rent – Example Court"], "rental_compare");
  assert.equal(mapping["RUBS"], "rental_compare");
  assert.equal(mapping["Water and sewer"], "expense");
  assert.equal(mapping["Current insurance"], "expense", "'current' is not rent");
  assert.equal(mapping["Crew wages"], "labor_retired");
  assert.equal(mapping["Materials – B-1 rehab"], "project_compare");
  assert.equal(mapping["Mortgage – Sample Bank"], "debt_compare");
  assert.equal(mapping["Investor distribution"], "investor");
  assert.equal(mapping["Owner household draw"], "owner");
  assert.equal(mapping["Mystery line"], "unmapped");
  assert.deepEqual(draft.retiredRows, ["Crew wages (row 11)"]);
  assert.ok(draft.warnings.some(warning => /row 19 .*without cached values/i.test(warning)));

  // Uniform weekly water becomes one weekly expense; irregular taxes become dated one-time items.
  const water = draft.assumptionDraft.expenses.filter(item => item.label === "Water and sewer");
  assert.equal(water.length, 1);
  assert.deepEqual({ frequency: water[0]!.frequency, amountCents: water[0]!.amountCents, firstOn: water[0]!.firstOn, endOn: water[0]!.endOn }, { frequency: "weekly", amountCents: "31025", firstOn: "2026-09-28", endOn: "2026-10-19" });
  const taxes = draft.assumptionDraft.expenses.filter(item => item.label === "Property taxes");
  assert.deepEqual(taxes.map(item => [item.firstOn, item.amountCents, item.category]), [["2026-10-12", "210000", "property_tax"], ["2027-02-01", "210000", "property_tax"]]);
  assert.ok(!draft.assumptionDraft.expenses.some(item => item.label === "Crew wages"), "retired labor stays retired");
  assert.deepEqual(draft.assumptionDraft.investorFlows.map(item => [item.kind, item.amountCents, item.firstOn]), [["distribution", "500000", "2026-10-19"]]);
  assert.equal(draft.assumptionDraft.ownerItems.length, 3);
  assert.equal(draft.assumptionDraft.ownerItems[0]!.amountCents, "-250000");
  assert.deepEqual(draft.openingBalanceSuggestions, [{ item: "cash_operating", amountCents: "8425050", cell: "B2", label: "Starting cash balance" }]);
  assert.equal(draft.endingCash!.values[0]!.amountCents, "7911421");
  assert.match(draft.endingCash!.note, /before missing costs/);
  assert.ok(draft.verification.some(item => /retired labor/i.test(item)));

  // Drafted items validate inside an assumption document once reviewed.
  const document = syntheticForecastAssumptionsInput();
  document.expenses = [...(document.expenses ?? []), ...draft.assumptionDraft.expenses as never[]];
  document.investorFlows = [...(document.investorFlows ?? []), ...draft.assumptionDraft.investorFlows as never[]];
  document.ownerItems = [...draft.assumptionDraft.ownerItems as never[]];
  document.actualsCutoff = "2026-09-27";
  assert.doesNotThrow(() => forecastAssumptionsSchema.parse(document));
});

test("CSV exports are accepted and a missing Cashflow sheet is reported, not guessed", async () => {
  const csv = "Category,2026-09-28,2026-10-05\nWater,-10.00,-10.00\nMaintenance repairs,-5.5,\n";
  const draft = await parseWorkbookCashflow(Buffer.from(csv, "utf8"), { fileName: "cashflow.csv" });
  assert.equal(draft.format, "csv");
  assert.equal(draft.periods.length, 2);
  assert.equal(draft.assumptionDraft.expenses.length, 2);
  const book = utils.book_new();
  utils.book_append_sheet(book, utils.aoa_to_sheet([["a"]]), "One");
  utils.book_append_sheet(book, utils.aoa_to_sheet([["b"]]), "Two");
  const none = await parseWorkbookCashflow(write(book, { type: "buffer", bookType: "xlsx" }) as Buffer, { fileName: "other.xlsx" });
  assert.equal(none.sheetName, null);
  assert.ok(none.warnings.some(warning => /No sheet named Cashflow/.test(warning)));
  await assert.rejects(parseWorkbookCashflow(Buffer.from([0x50, 0x4b, 0x03]), { fileName: "broken.xlsx" }), /could not be read/);
});
