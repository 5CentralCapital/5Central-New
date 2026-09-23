import type { ForecastAssumptions } from "../../shared/forecasting/assumptions";
import type { ForecastCompareResponse, ForecastContribution, ForecastExplainResponse, ForecastSnapshotMeta } from "../../shared/forecasting/contracts";
import {
  CASH_CATEGORY_LABELS,
  FORECAST_ACCOUNT_BY_KEY,
  FORECAST_ACCOUNTS,
  type ForecastEvent,
  type ForecastResult,
} from "../../shared/forecasting/result";
import { ValidationCommandError } from "../company/commands/errors";

/**
 * Deterministic drilldown over a forecast result: every chart point or table
 * cell resolves to the dated events (and their assumption inputs) that
 * produced it. No language model is involved.
 */
const ZERO = BigInt(0);
const CASH = new Set(["cash_operating", "cash_restricted"]);
const big = (value: string | null | undefined) => BigInt(value ?? "0");
const text = (value: bigint) => value.toString();

function naturalOf(account: string, debit: bigint): bigint {
  const definition = FORECAST_ACCOUNT_BY_KEY[account];
  if (!definition) return ZERO;
  if (definition.type === "asset" || definition.type === "expense" || account === "distributions") return debit;
  return -debit;
}

function eventCash(event: ForecastEvent, accounts: ReadonlySet<string> = CASH): bigint {
  return event.entries.reduce((total, entry) => (accounts.has(entry.a) ? total + big(entry.c) : total), ZERO);
}

/** Net income contribution of one event (income positive). */
export function eventIncome(event: ForecastEvent): bigint {
  return event.entries.reduce((total, entry) => (FORECAST_ACCOUNT_BY_KEY[entry.a]?.cashFlowClass === "income_statement" ? total - big(entry.c) : total), ZERO);
}

/** The same per-line classification the engine uses for the indirect cash-flow statement. */
function cashFlowSections(event: ForecastEvent): { operating: bigint; investing: bigint; financing: bigint } {
  let operating = ZERO; let investing = ZERO; let financing = ZERO;
  for (const entry of event.entries) {
    const definition = FORECAST_ACCOUNT_BY_KEY[entry.a];
    if (!definition || definition.cashFlowClass === "cash") continue;
    const cents = big(entry.c);
    if (definition.cashFlowClass === "income_statement") {
      if (event.kind === "sale") investing -= cents; else operating -= cents;
      continue;
    }
    const cls = event.kind === "sale" && (entry.a === "accumulated_depreciation" || entry.a === "fixed_assets" || entry.a === "cip") ? "investing" : definition.cashFlowClass;
    if (cls === "operating") operating -= cents; else if (cls === "investing") investing -= cents; else financing -= cents;
  }
  return { operating, investing, financing };
}

const REVENUE_WEIGHTS: Readonly<Record<string, number>> = { rental_income_tenant: 1, rental_income_subsidy: 1, concessions: -1 };
const OPEX_WEIGHTS: Readonly<Record<string, number>> = Object.fromEntries(FORECAST_ACCOUNTS.filter(account => "group" in account && account.group === "operating_expense").map(account => [account.key, 1]));

function weightedNatural(event: ForecastEvent, weights: Readonly<Record<string, number>>): bigint {
  let total = ZERO;
  for (const entry of event.entries) {
    const weight = weights[entry.a];
    if (weight) total += BigInt(weight) * naturalOf(entry.a, big(entry.c));
  }
  return total;
}

/**
 * Balance-sheet composites shown in the composition chart (`bs.<key>`).
 * Weights apply to natural-sign balances; contra and deduction accounts are -1.
 */
export const BALANCE_COMPOSITES: Readonly<Record<string, { readonly label: string; readonly weights: Readonly<Record<string, number>>; readonly retainedEarnings?: true }>> = Object.freeze({
  cash_total: { label: "Cash", weights: { cash_operating: 1, cash_restricted: 1 } },
  receivables_total: { label: "Receivables and manager funds", weights: { rent_receivable: 1, subsidy_receivable: 1, pm_held_funds: 1 } },
  property_net: { label: "Property, net", weights: { fixed_assets: 1, accumulated_depreciation: -1, cip: 1 } },
  payables_total: { label: "Payables and deposits", weights: { accounts_payable: 1, project_payables: 1, retainage_payable: 1, deposits_held: 1, investor_payable: 1 } },
  equity_total: { label: "Equity", weights: { opening_equity: 1, contributed_capital: 1, distributions: -1 }, retainedEarnings: true },
});

interface LineDefinition {
  readonly label: string;
  readonly kind: "flow" | "balance";
  readonly amount: (event: ForecastEvent) => bigint;
  /** Balance lines: natural-sign balance at the start of the period. */
  readonly opening?: (start: string) => bigint;
  readonly monthOnly?: boolean;
  readonly filter?: (event: ForecastEvent) => boolean;
}

function lineDefinition(result: ForecastResult, line: string, debitBefore: (accounts: readonly string[], date: string) => bigint): LineDefinition {
  const [family, ...rest] = line.split(".");
  const key = rest.join(".");
  const incomeNatural = (event: ForecastEvent) => eventIncome(event);
  if (family === "cash") {
    if (key === "inflows") return { label: "Cash inflows", kind: "flow", amount: event => { const net = eventCash(event); return net > ZERO ? net : ZERO; } };
    if (key === "outflows") return { label: "Cash outflows", kind: "flow", amount: event => { const net = eventCash(event); return net < ZERO ? -net : ZERO; } };
    if (key === "net") return { label: "Net cash flow", kind: "flow", amount: event => eventCash(event) };
    if (key.startsWith("category.")) {
      const category = key.slice("category.".length);
      return { label: CASH_CATEGORY_LABELS[category as keyof typeof CASH_CATEGORY_LABELS] ?? category, kind: "flow", amount: event => ((event.cashCategory ?? "other") === category ? eventCash(event) : ZERO) };
    }
    const accounts = key === "available" ? ["cash_operating"] : key === "restricted" ? ["cash_restricted"] : ["cash_operating", "cash_restricted"];
    const label = key === "available" ? "Available cash" : key === "restricted" ? "Restricted cash" : key === "opening" ? "Opening cash" : "Closing cash";
    const set = new Set(accounts);
    return { label, kind: "balance", amount: event => (key === "opening" ? ZERO : eventCash(event, set)), opening: start => debitBefore(accounts, start), ...(key === "opening" ? { filter: () => false } : {}) };
  }
  if (family === "is") {
    if (key === "revenue") return { label: "Revenue", kind: "flow", monthOnly: true, amount: event => weightedNatural(event, REVENUE_WEIGHTS) };
    if (key === "operating_expenses") return { label: "Operating expenses", kind: "flow", monthOnly: true, amount: event => weightedNatural(event, OPEX_WEIGHTS) };
    if (key === "noi") return { label: "Net operating income", kind: "flow", monthOnly: true, amount: event => weightedNatural(event, REVENUE_WEIGHTS) - weightedNatural(event, OPEX_WEIGHTS) };
    if (key === "net_income") return { label: "Net income", kind: "flow", monthOnly: true, amount: incomeNatural };
    const definition = FORECAST_ACCOUNT_BY_KEY[key];
    if (!definition || definition.cashFlowClass !== "income_statement") throw new ValidationCommandError("Unknown income statement line", { reason: "forecast_line_unknown" });
    return { label: definition.label, kind: "flow", monthOnly: true, amount: event => weightedNatural(event, { [key]: 1 }) };
  }
  if (family === "bs") {
    if (key === "retained_earnings") {
      return { label: "Retained earnings since cutoff", kind: "balance", monthOnly: true, amount: incomeNatural,
        opening: start => -debitBefore(FORECAST_ACCOUNTS.filter(account => account.cashFlowClass === "income_statement").map(account => account.key), start) };
    }
    const composite = BALANCE_COMPOSITES[key];
    if (composite) {
      // Composite figures (balance-sheet composition) explain every account they add up.
      const accounts = Object.keys(composite.weights);
      const incomeAccounts = FORECAST_ACCOUNTS.filter(account => account.cashFlowClass === "income_statement").map(account => account.key);
      return {
        label: composite.label, kind: "balance", monthOnly: true,
        amount: event => weightedNatural(event, composite.weights) + (composite.retainedEarnings ? incomeNatural(event) : ZERO),
        opening: start => accounts.reduce((total, account) => total + BigInt(composite.weights[account]!) * naturalOf(account, debitBefore([account], start)), ZERO)
          - (composite.retainedEarnings ? debitBefore(incomeAccounts, start) : ZERO),
      };
    }
    const definition = FORECAST_ACCOUNT_BY_KEY[key];
    if (!definition || definition.cashFlowClass === "income_statement") throw new ValidationCommandError("Unknown balance sheet line", { reason: "forecast_line_unknown" });
    return { label: definition.label, kind: "balance", monthOnly: true, amount: event => weightedNatural(event, { [key]: 1 }), opening: start => naturalOf(key, debitBefore([key], start)) };
  }
  if (family === "cf") {
    if (key === "net") return { label: "Net change in cash", kind: "flow", monthOnly: true, amount: event => eventCash(event) };
    if (key.startsWith("direct.")) {
      const category = key.slice("direct.".length);
      return { label: CASH_CATEGORY_LABELS[category as keyof typeof CASH_CATEGORY_LABELS] ?? category, kind: "flow", monthOnly: true, amount: event => ((event.cashCategory ?? "other") === category ? eventCash(event) : ZERO) };
    }
    const section = key as "operating" | "investing" | "financing";
    const labels = { operating: "Operating activities", investing: "Investing activities", financing: "Financing activities" } as const;
    if (!(section in labels)) throw new ValidationCommandError("Unknown cash-flow line", { reason: "forecast_line_unknown" });
    return { label: labels[section], kind: "flow", monthOnly: true, amount: event => cashFlowSections(event)[section] };
  }
  if (line === "debt.service") {
    const scheduled = new Set(result.debt.loans.flatMap(loan => loan.payments.filter(row => row.kind === "scheduled").map(row => `loan-payment:${loan.loanId}:${row.date}`)));
    return { label: "Scheduled debt service", kind: "flow", monthOnly: true, amount: event => (scheduled.has(event.id) ? -eventCash(event, new Set(["cash_operating"])) : ZERO) };
  }
  if (line === "ops.scheduled_rent") return { label: "Scheduled rent", kind: "flow", monthOnly: true, amount: event => (event.kind === "rent_charge" ? eventIncome(event) : ZERO) };
  throw new ValidationCommandError("Unknown forecast line", { reason: "forecast_line_unknown" });
}

function resolveRef(ref: string, result: ForecastResult, assumptions: ForecastAssumptions | null): { ref: string; label: string; value: unknown } | null {
  if (ref.startsWith("opening.")) {
    const item = result.opening.items.find(entry => entry.key === ref.slice("opening.".length));
    return item ? { ref, label: item.label, value: item } : null;
  }
  if (!assumptions) return null;
  const match = /^([a-zA-Z]+)\[([^\]]+)\]/.exec(ref);
  if (!match) return null;
  const [, collection, id] = match as unknown as [string, string, string];
  const pick = <T extends Record<string, unknown>>(items: readonly T[], key: string) => items.find(item => item[key] === id);
  let value: Record<string, unknown> | undefined;
  switch (collection) {
    case "units": value = pick(assumptions.units, "unitId"); break;
    case "expenses": value = pick(assumptions.expenses, "id"); break;
    case "projects": value = pick(assumptions.projects, "projectId"); break;
    case "loans": value = pick(assumptions.loans, "id"); break;
    case "refinances": value = pick(assumptions.refinances, "id"); break;
    case "sales": value = pick(assumptions.sales, "id"); break;
    case "investorFlows": value = pick(assumptions.investorFlows, "id"); break;
    case "timeActuals": value = pick(assumptions.timeActuals, "id"); break;
    case "properties": value = pick(assumptions.properties, "propertyId"); break;
    case "overrides": {
      const [kind, target, month] = id.split(":");
      value = assumptions.overrides.find(item => item.kind === kind && (item.kind === "unit_rent" ? item.unitId === target : item.kind === "expense_amount" ? item.expenseId === target : false) && "month" in item && item.month === month);
      break;
    }
    default: value = undefined;
  }
  if (!value) return null;
  const label = typeof value.label === "string" ? value.label : typeof value.name === "string" ? value.name : typeof value.reason === "string" ? `Override: ${value.reason}` : ref;
  return { ref, label, value };
}

export function explainForecastLine(result: ForecastResult, assumptions: ForecastAssumptions | null, input: { line: string; period: string; limit: number; cursor?: string }): ForecastExplainResponse {
  const [periodKind, periodValue] = input.period.split(":") as ["W" | "M", string];
  const week = periodKind === "W" ? result.weeks.find(row => row.key === input.period) : undefined;
  const month = periodKind === "M" ? result.months.find(row => row.key === input.period) : undefined;
  if (!week && !month) throw new ValidationCommandError(`Period ${periodValue} is outside this forecast`, { reason: "forecast_period_not_found" });
  const start = (week ?? month)!.start;
  const end = (week ?? month)!.end;
  const openingDebit = new Map<string, bigint>();
  for (const account of FORECAST_ACCOUNTS) {
    const natural = big(result.opening.balances[account.key]);
    openingDebit.set(account.key, account.type === "asset" || account.key === "distributions" ? natural : account.cashFlowClass === "income_statement" ? ZERO : -natural);
  }
  const debitBefore = (accounts: readonly string[], date: string) => {
    const set = new Set(accounts);
    let total = accounts.reduce((sum, account) => sum + (openingDebit.get(account) ?? ZERO), ZERO);
    for (const event of result.events) {
      if (event.date >= date) break;
      for (const entry of event.entries) if (set.has(entry.a)) total += big(entry.c);
    }
    return total;
  };
  const definition = lineDefinition(result, input.line, debitBefore);
  if (definition.monthOnly && !month) throw new ValidationCommandError("This line is monthly; choose a month period", { reason: "forecast_period_monthly_only" });
  const all: ForecastContribution[] = [];
  let total = ZERO;
  for (const event of result.events) {
    if (event.date < start) continue;
    if (event.date > end) break;
    if (definition.filter && !definition.filter(event)) continue;
    const amount = definition.amount(event);
    if (amount === ZERO) continue;
    total += amount;
    all.push({ eventId: event.id, date: event.date as never, label: event.label, kind: event.kind, amountCents: text(amount) as never, ref: event.ref, modeled: event.modeled, sourceIds: [...(event.sourceIds ?? [])] });
  }
  const opening = definition.kind === "balance" && definition.opening ? definition.opening(start) : null;
  const offset = input.cursor ? Number(Buffer.from(input.cursor, "base64url").toString("utf8")) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ValidationCommandError("Forecast drilldown cursor is invalid", { reason: "invalid_forecast_cursor" });
  const page = all.slice(offset, offset + input.limit);
  const refs = Array.from(new Set(all.map(item => item.ref))).slice(0, 50);
  const inputs = refs.map(ref => resolveRef(ref, result, assumptions)).filter((item): item is NonNullable<typeof item> => item !== null);
  const sectionLines = month && input.line.startsWith("cf.") && ["cf.operating", "cf.investing", "cf.financing"].includes(input.line)
    ? month.cashFlow[input.line.slice(3) as "operating" | "investing" | "financing"].map(item => ({ key: item.key, label: item.label, cents: item.cents }))
    : [];
  return {
    line: input.line, period: input.period, label: definition.label, periodStart: start as never, periodEnd: end as never,
    totalCents: text((opening ?? ZERO) + total) as never, openingCents: opening === null ? null : text(opening) as never,
    contributions: page, contributionCount: all.length,
    nextCursor: offset + input.limit < all.length ? Buffer.from(String(offset + input.limit), "utf8").toString("base64url") : null,
    components: sectionLines as never, inputs,
  };
}

/** Readable JSON diff of two assumption documents; arrays of records are keyed by their ID field. */
export function diffAssumptions(before: unknown, after: unknown, limit = 500): { changes: { path: string; before: unknown; after: unknown }[]; truncated: boolean } {
  const changes: { path: string; before: unknown; after: unknown }[] = [];
  let truncated = false;
  const idOf = (value: unknown): string | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    for (const key of ["unitId", "projectId", "propertyId", "id"]) if (typeof record[key] === "string") return record[key] as string;
    return null;
  };
  const walk = (path: string, left: unknown, right: unknown) => {
    if (changes.length >= limit) { truncated = true; return; }
    if (JSON.stringify(left) === JSON.stringify(right)) return;
    if (Array.isArray(left) && Array.isArray(right) && left.every(item => idOf(item) !== null) && right.every(item => idOf(item) !== null)) {
      const leftMap = new Map(left.map(item => [idOf(item)!, item]));
      const rightMap = new Map(right.map(item => [idOf(item)!, item]));
      const ids = Array.from(new Set([...Array.from(leftMap.keys()), ...Array.from(rightMap.keys())])).sort();
      for (const id of ids) walk(`${path}[${id}]`, leftMap.get(id), rightMap.get(id));
      return;
    }
    if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
      const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort();
      for (const key of keys) walk(path ? `${path}.${key}` : key, (left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]);
      return;
    }
    changes.push({ path, before: left ?? null, after: right ?? null });
  };
  walk("", before, after);
  return { changes, truncated };
}

type CompareSide = { meta: ForecastSnapshotMeta & { scenarioName: string; scenarioKind: string }; result: ForecastResult; assumptions: unknown };

export function compareForecasts(a: CompareSide, b: CompareSide, limit: number): ForecastCompareResponse {
  const diff = diffAssumptions(a.assumptions, b.assumptions);
  const weekKeys = Array.from(new Set([...a.result.weeks.map(week => week.key), ...b.result.weeks.map(week => week.key)])).sort();
  const monthKeys = Array.from(new Set([...a.result.months.map(month => month.key), ...b.result.months.map(month => month.key)])).sort();
  const weekOf = (result: ForecastResult, key: string) => result.weeks.find(week => week.key === key);
  const monthOf = (result: ForecastResult, key: string) => result.months.find(month => month.key === key);
  const events = new Map<string, { label: string; kind: string; date: string; ref: string; aCash: bigint; bCash: bigint; aIncome: bigint; bIncome: bigint }>();
  const collect = (result: ForecastResult, side: "a" | "b") => {
    for (const event of result.events) {
      const entry = events.get(event.id) ?? { label: event.label, kind: event.kind, date: event.date, ref: event.ref, aCash: ZERO, bCash: ZERO, aIncome: ZERO, bIncome: ZERO };
      if (side === "a") { entry.aCash += eventCash(event); entry.aIncome += eventIncome(event); } else { entry.bCash += eventCash(event); entry.bIncome += eventIncome(event); }
      events.set(event.id, entry);
    }
  };
  collect(a.result, "a");
  collect(b.result, "b");
  const abs = (value: bigint) => (value < ZERO ? -value : value);
  const differing = Array.from(events.entries())
    .map(([id, entry]) => ({ id, ...entry, deltaCash: entry.bCash - entry.aCash, deltaIncome: entry.bIncome - entry.aIncome }))
    .filter(entry => entry.deltaCash !== ZERO || entry.deltaIncome !== ZERO)
    .sort((left, right) => {
      const cash = abs(right.deltaCash) - abs(left.deltaCash);
      if (cash !== ZERO) return cash > ZERO ? 1 : -1;
      const income = abs(right.deltaIncome) - abs(left.deltaIncome);
      if (income !== ZERO) return income > ZERO ? 1 : -1;
      return left.id < right.id ? -1 : 1;
    });
  const cents = (value: string | undefined | null) => (value === undefined || value === null ? null : value);
  return {
    a: a.meta as never, b: b.meta as never,
    assumptionChanges: diff.changes, assumptionChangesTruncated: diff.truncated,
    summary: { a: { ...a.result.summary }, b: { ...b.result.summary } },
    weekly: weekKeys.map(key => ({ key, aClosingCents: cents(weekOf(a.result, key)?.closingCashCents) as never, bClosingCents: cents(weekOf(b.result, key)?.closingCashCents) as never,
      aAvailableCents: cents(weekOf(a.result, key)?.availableClosingCents) as never, bAvailableCents: cents(weekOf(b.result, key)?.availableClosingCents) as never })),
    monthly: monthKeys.map(key => ({ key, aNoiCents: cents(monthOf(a.result, key)?.noiCents) as never, bNoiCents: cents(monthOf(b.result, key)?.noiCents) as never,
      aNetIncomeCents: cents(monthOf(a.result, key)?.netIncomeCents) as never, bNetIncomeCents: cents(monthOf(b.result, key)?.netIncomeCents) as never,
      aClosingCashCents: cents(monthOf(a.result, key)?.cashFlow.closingCashCents) as never, bClosingCashCents: cents(monthOf(b.result, key)?.cashFlow.closingCashCents) as never })),
    contributingEvents: differing.slice(0, limit).map(entry => ({
      eventId: entry.id, label: entry.label, kind: entry.kind, date: entry.date as never, ref: entry.ref,
      aCashCents: text(entry.aCash) as never, bCashCents: text(entry.bCash) as never, deltaCashCents: text(entry.deltaCash) as never,
      aIncomeCents: text(entry.aIncome) as never, bIncomeCents: text(entry.bIncome) as never, deltaIncomeCents: text(entry.deltaIncome) as never,
    })),
    contributingEventCount: differing.length,
  };
}

/** Drop the event calendar for API views. */
export function resultView(result: ForecastResult): Omit<ForecastResult, "events"> {
  const { events: _events, ...view } = result;
  return view;
}

