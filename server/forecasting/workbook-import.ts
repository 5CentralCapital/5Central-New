import { read, utils, SSF, type CellObject, type WorkBook, type WorkSheet } from "xlsx";
import { isIsoDate, legacyNumberToDecimal, multiplyDecimalToCents } from "../../shared/company";
import { EXPENSE_CATEGORIES, type ExpenseCategory, type OpeningItemKey } from "../../shared/forecasting/assumptions";
import { dayNumber } from "../../shared/forecasting/calendar";
import { ValidationCommandError } from "../company/commands/errors";

/**
 * U14 read-only workbook discovery.
 *
 * Maps the documented "Cashflow" sheet layout (docs/company/forecast-model.md)
 * into assumption drafts: dates across row 1 from column B, one category per
 * row in column A, section header rows with no amounts, inflows positive and
 * outflows negative. Nothing is saved; a person reviews the draft, then saves
 * it as an assumption version with a reason. Formula cells are inventoried
 * and their cached values used only when present; a formula without a cached
 * value is reported, never recalculated or treated as zero.
 */
export type WorkbookLineMapping =
  | "rental_compare" | "project_compare" | "debt_compare" | "capital_compare"
  | "expense" | "investor" | "owner" | "labor_retired" | "starting_balance" | "ending_cash" | "unmapped";

export interface WorkbookSheetInventory {
  readonly name: string;
  readonly rows: number;
  readonly columns: number;
  readonly formulas: number;
  readonly formulasWithoutCachedValue: number;
}

export interface WorkbookLine {
  readonly row: number;
  readonly label: string;
  readonly section: string | null;
  readonly mapping: WorkbookLineMapping;
  readonly expenseCategory?: ExpenseCategory;
  readonly formulas: number;
  readonly missingCachedValues: number;
  readonly totalCents: string;
  readonly values: readonly { readonly date: string; readonly amountCents: string; readonly cell: string; readonly formula: boolean }[];
}

export interface WorkbookCashflowDraft {
  readonly fileName: string;
  readonly format: "xlsx" | "csv";
  readonly sheetName: string | null;
  readonly sheets: readonly WorkbookSheetInventory[];
  readonly periods: readonly { readonly column: string; readonly date: string; readonly kind: "week" | "month" }[];
  readonly lines: readonly WorkbookLine[];
  readonly assumptionDraft: {
    readonly expenses: readonly Record<string, unknown>[];
    readonly investorFlows: readonly Record<string, unknown>[];
    readonly ownerItems: readonly Record<string, unknown>[];
  };
  readonly openingBalanceSuggestions: readonly { readonly item: OpeningItemKey; readonly amountCents: string; readonly cell: string; readonly label: string }[];
  readonly endingCash: { readonly label: string; readonly values: readonly { readonly date: string; readonly amountCents: string }[]; readonly note: string } | null;
  readonly retiredRows: readonly string[];
  readonly verification: readonly string[];
  readonly warnings: readonly string[];
}

const MAX_ROWS = 2_000;
const MAX_COLUMNS = 400;

function cellText(cell: CellObject | undefined): string {
  if (!cell || cell.v === undefined || cell.v === null) return "";
  return String(cell.w ?? cell.v).trim();
}

/** Header date: an Excel serial, an ISO date, or US m/d/yyyy text. */
export function headerDate(cell: CellObject | undefined): string | null {
  if (!cell || cell.v === undefined || cell.v === null || cell.v === "") return null;
  if (typeof cell.v === "number" && Number.isFinite(cell.v) && cell.v > 20_000 && cell.v < 80_000) {
    const parts = SSF.parse_date_code(cell.v);
    if (!parts) return null;
    return `${String(parts.y).padStart(4, "0")}-${String(parts.m).padStart(2, "0")}-${String(parts.d).padStart(2, "0")}`;
  }
  const value = String(cell.v).trim();
  // A header such as "13/45/2026" or "2026-02-30" is not a period date.
  const real = (date: string) => (isIsoDate(date) ? date : null);
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match) return real(value);
  match = /^(\d{4})-(\d{2})$/.exec(value);
  if (match) return real(`${value}-01`);
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (match) return real(`${match[3]}-${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}`);
  return null;
}

/** Dollars (number or text) to exact cents, half away from zero at the cent. */
export function dollarsToCents(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  let decimal: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    decimal = legacyNumberToDecimal(value);
  } else {
    const cleaned = String(value).trim().replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
    decimal = cleaned;
  }
  return multiplyDecimalToCents(decimal, "1");
}

function classify(label: string, section: string | null): { mapping: WorkbookLineMapping; expenseCategory?: ExpenseCategory } {
  const text = `${section ?? ""} ${label}`.toLowerCase();
  const own = label.toLowerCase();
  if (/retired/.test(text) && /labor|labour/.test(text)) return { mapping: "labor_retired" };
  if (/(starting|beginning|opening)\s+(cash|balance)/.test(own)) return { mapping: "starting_balance" };
  if (/ending\s+cash/.test(own)) return { mapping: "ending_cash" };
  if (/owner|personal|household/.test(text)) return { mapping: "owner" };
  if (/investor|distribution/.test(text)) return { mapping: "investor" };
  if (/refinanc|sale proceeds|sale of|closing/.test(text)) return { mapping: "capital_compare" };
  if (/mortgage|loan|debt service|balloon|principal/.test(text)) return { mapping: "debt_compare" };
  if (/\b(rent|rents|rental|rubs|hap)\b|subsid|lease-up|first month/.test(text)) return { mapping: "rental_compare" };
  if (/material|carry|rehab|construction|project/.test(text)) return { mapping: "project_compare" };
  if (/utilit|water|electric|gas|sewer|trash/.test(text)) return { mapping: "expense", expenseCategory: "utilities" };
  if (/insurance/.test(text)) return { mapping: "expense", expenseCategory: "insurance" };
  if (/\btax(es)?\b/.test(text)) return { mapping: "expense", expenseCategory: "property_tax" };
  if (/payroll|labor|labour|wage/.test(text)) return { mapping: "expense", expenseCategory: "payroll" };
  if (/repair|maint/.test(text)) return { mapping: "expense", expenseCategory: "repairs" };
  if (/admin|office|software|legal|accounting/.test(text)) return { mapping: "expense", expenseCategory: "admin" };
  return { mapping: "unmapped" };
}

function inventory(workbook: WorkBook): WorkbookSheetInventory[] {
  return workbook.SheetNames.map(name => {
    const sheet = workbook.Sheets[name]!;
    const range = sheet["!ref"] ? utils.decode_range(sheet["!ref"]) : null;
    let formulas = 0; let missing = 0;
    for (const address of Object.keys(sheet)) {
      if (address.startsWith("!")) continue;
      const cell = sheet[address] as CellObject;
      if (cell.f) { formulas += 1; if (cell.v === undefined || cell.v === null || cell.v === "") missing += 1; }
    }
    return { name, rows: range ? range.e.r - range.s.r + 1 : 0, columns: range ? range.e.c - range.s.c + 1 : 0, formulas, formulasWithoutCachedValue: missing };
  });
}

function findCashflowSheet(workbook: WorkBook): string | null {
  return workbook.SheetNames.find(name => name.trim().toLowerCase() === "cashflow")
    ?? workbook.SheetNames.find(name => /cash\s*flow/i.test(name))
    ?? (workbook.SheetNames.length === 1 ? workbook.SheetNames[0]! : null);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "row";
}

export async function parseWorkbookCashflow(bytes: Uint8Array, options: { fileName: string }): Promise<WorkbookCashflowDraft> {
  const format: "xlsx" | "csv" = /\.csv$/i.test(options.fileName) ? "csv" : "xlsx";
  const header = Buffer.from(bytes.subarray(0, 4)).toString("hex");
  if (format === "xlsx" && header !== "504b0304" && header !== "d0cf11e0") {
    throw new ValidationCommandError("The file could not be read as a workbook or CSV.", { reason: "forecast_workbook_unreadable" });
  }
  let workbook: WorkBook;
  try {
    workbook = format === "csv"
      ? read(Buffer.from(bytes).toString("utf8"), { type: "string", raw: true })
      : read(Buffer.from(bytes), { type: "buffer", cellFormula: true, cellDates: false, cellNF: false });
  } catch {
    throw new ValidationCommandError("The file could not be read as a workbook or CSV.", { reason: "forecast_workbook_unreadable" });
  }
  const sheets = inventory(workbook);
  const warnings: string[] = [];
  const verification = [
    "Recalculate the workbook natively (Excel) before import; formulas without cached values are listed, not recalculated here.",
    "Confirm manual starting balances against bank and QuickBooks balances at the cutoff before approving them as opening overrides.",
    "Confirm the retired labor section is still retired; it is excluded from the model.",
    "Ending cash in the workbook is labeled before missing costs; reconcile differences, do not force a match.",
    "Rental, project, debt and capital rows are comparison-only: the model derives them from unit, project and loan records.",
  ];
  const sheetName = findCashflowSheet(workbook);
  if (!sheetName) {
    warnings.push("No sheet named Cashflow was found.");
    return { fileName: options.fileName, format, sheetName: null, sheets, periods: [], lines: [], assumptionDraft: { expenses: [], investorFlows: [], ownerItems: [] }, openingBalanceSuggestions: [], endingCash: null, retiredRows: [], verification, warnings };
  }
  const sheet: WorkSheet = workbook.Sheets[sheetName]!;
  const range = utils.decode_range(sheet["!ref"] ?? "A1:A1");
  const lastRow = Math.min(range.e.r, MAX_ROWS);
  const lastColumn = Math.min(range.e.c, MAX_COLUMNS);
  if (range.e.r > MAX_ROWS || range.e.c > MAX_COLUMNS) warnings.push(`Only the first ${MAX_ROWS} rows and ${MAX_COLUMNS} columns were read.`);
  // Header row: find the first row with at least two date cells from column B.
  let headerRow = -1;
  for (let row = range.s.r; row <= Math.min(lastRow, range.s.r + 10) && headerRow < 0; row += 1) {
    let dates = 0;
    for (let column = 1; column <= lastColumn; column += 1) if (headerDate(sheet[utils.encode_cell({ r: row, c: column })])) dates += 1;
    if (dates >= 2) headerRow = row;
  }
  if (headerRow < 0) {
    warnings.push("No header row of dates was found in the first rows of the Cashflow sheet.");
    return { fileName: options.fileName, format, sheetName, sheets, periods: [], lines: [], assumptionDraft: { expenses: [], investorFlows: [], ownerItems: [] }, openingBalanceSuggestions: [], endingCash: null, retiredRows: [], verification, warnings };
  }
  const periods: { column: string; columnIndex: number; date: string; kind: "week" | "month" }[] = [];
  for (let column = 1; column <= lastColumn; column += 1) {
    const date = headerDate(sheet[utils.encode_cell({ r: headerRow, c: column })]);
    if (date) periods.push({ column: utils.encode_col(column), columnIndex: column, date, kind: "week" });
  }
  periods.forEach((period, index) => {
    const next = periods[index + 1];
    const previous = periods[index - 1];
    const gaps = [next ? dayNumber(next.date) - dayNumber(period.date) : null, previous ? dayNumber(period.date) - dayNumber(previous.date) : null].filter((gap): gap is number => gap !== null);
    period.kind = gaps.length && Math.min(...gaps) >= 28 ? "month" : "week";
    if (previous && period.date <= previous.date) warnings.push(`Column ${period.column} is not after column ${previous.column}.`);
  });

  const lines: WorkbookLine[] = [];
  const retiredRows: string[] = [];
  let section: string | null = null;
  let sectionRetired = false;
  for (let row = headerRow + 1; row <= lastRow; row += 1) {
    const label = cellText(sheet[utils.encode_cell({ r: row, c: 0 })]);
    const values: { date: string; amountCents: string; cell: string; formula: boolean }[] = [];
    let formulas = 0; let missing = 0;
    for (const period of periods) {
      const address = utils.encode_cell({ r: row, c: period.columnIndex });
      const cell = sheet[address] as CellObject | undefined;
      if (!cell) continue;
      if (cell.f) formulas += 1;
      if (cell.f && (cell.v === undefined || cell.v === null || cell.v === "")) { missing += 1; continue; }
      const cents = dollarsToCents(cell.v);
      if (cents === null) continue;
      if (cents !== "0") values.push({ date: period.date, amountCents: cents, cell: address, formula: Boolean(cell.f) });
    }
    if (!label && !values.length) continue;
    if (label && !values.length && !formulas) {
      section = label;
      sectionRetired = /retired/i.test(label);
      continue;
    }
    const classified = sectionRetired && /labor|labour/i.test(`${section} ${label}`) ? { mapping: "labor_retired" as const } : classify(label, section);
    if (classified.mapping === "labor_retired") retiredRows.push(`${label || "(unlabeled)"} (row ${row + 1})`);
    if (missing) warnings.push(`Row ${row + 1} (${label}) has ${missing} formula cell(s) without cached values.`);
    const total = values.reduce((sum, value) => sum + BigInt(value.amountCents), BigInt(0));
    lines.push({ row: row + 1, label, section, mapping: classified.mapping, ...(classified.expenseCategory ? { expenseCategory: classified.expenseCategory } : {}),
      formulas, missingCachedValues: missing, totalCents: total.toString(), values: values.slice(0, 400) });
  }

  // Drafts: outflows are negative in the workbook and become positive amounts.
  const expenses: Record<string, unknown>[] = [];
  const investorFlows: Record<string, unknown>[] = [];
  const ownerItems: Record<string, unknown>[] = [];
  const uniform = (line: WorkbookLine) => {
    const weekly = line.values.filter(value => periods.find(period => period.date === value.date)?.kind === "week");
    const weeklyPeriods = periods.filter(period => period.kind === "week");
    return weekly.length === weeklyPeriods.length && weekly.length > 1 && weekly.every(value => value.amountCents === weekly[0]!.amountCents) && weekly.length === line.values.length ? weekly : null;
  };
  for (const line of lines) {
    const base = `wb-r${line.row}-${slug(line.label)}`;
    if (line.mapping === "expense") {
      const category = line.expenseCategory && (EXPENSE_CATEGORIES as readonly string[]).includes(line.expenseCategory) ? line.expenseCategory : "other";
      if (line.values.some(value => BigInt(value.amountCents) > BigInt(0))) {
        warnings.push(`Row ${line.row} (${line.label}) has inflows in an expense row; those cells are not drafted. Review the sign convention.`);
      }
      const outflows = line.values.filter(value => BigInt(value.amountCents) < BigInt(0));
      const recurring = outflows.length === line.values.length ? uniform(line) : null;
      if (recurring) {
        expenses.push({ id: base, label: line.label, category, amountCents: (-BigInt(recurring[0]!.amountCents)).toString(), frequency: "weekly", firstOn: recurring[0]!.date, endOn: recurring.at(-1)!.date, note: `Workbook row ${line.row}` });
      } else {
        for (const value of outflows) expenses.push({ id: `${base}-${value.date}`, label: line.label, category, amountCents: (-BigInt(value.amountCents)).toString(), frequency: "once", firstOn: value.date, note: `Workbook ${value.cell}` });
      }
    } else if (line.mapping === "investor") {
      const kind = /interest/i.test(line.label) ? "investor_interest" : /contribut/i.test(line.label) ? "contribution" : "distribution";
      for (const value of line.values) {
        const amount = BigInt(value.amountCents);
        investorFlows.push({ id: `${base}-${value.date}`, label: line.label, kind, amountCents: (amount < BigInt(0) ? -amount : amount).toString(), frequency: "once", firstOn: value.date });
      }
    } else if (line.mapping === "owner") {
      for (const value of line.values) ownerItems.push({ id: `${base}-${value.date}`, label: line.label, amountCents: value.amountCents, frequency: "once", firstOn: value.date });
    }
  }
  const starting = lines.find(line => line.mapping === "starting_balance");
  const ending = lines.find(line => line.mapping === "ending_cash");
  return {
    fileName: options.fileName, format, sheetName, sheets,
    periods: periods.map(({ column, date, kind }) => ({ column, date, kind })),
    lines,
    assumptionDraft: { expenses, investorFlows, ownerItems },
    openingBalanceSuggestions: starting && starting.values[0] ? [{ item: "cash_operating", amountCents: starting.values[0].amountCents, cell: starting.values[0].cell, label: starting.label }] : [],
    endingCash: ending ? { label: ending.label, values: ending.values.map(({ date, amountCents }) => ({ date, amountCents })), note: "Workbook ending cash is before missing costs; use it to reconcile, not to overwrite the model." } : null,
    retiredRows,
    verification,
    warnings: Array.from(new Set(warnings)),
  };
}
