import { centsFromBigInt, type IsoDate } from "../../shared/company";
import type { QuickBooksConnectionScope } from "../../shared/accounting/quickbooks";
import type { QuickBooksReportAccountingMethod, QuickBooksReportResponse, QuickBooksReportsClient } from "../integrations/quickbooks/reports";

/**
 * The small source boundary used by the forecast opening-position reader.
 *
 * A native BalanceSheet is useful evidence for an opening balance, but it is
 * not a reconciliation by itself.  The adapter therefore carries coverage,
 * freshness and reconciliation separately.  The database/source wiring can
 * add reconciliation evidence later without changing the provider parser.
 */
export type ForecastQboBalanceKind =
  | "operating_cash"
  | "restricted_cash"
  | "accounts_payable"
  | "property_cost"
  | "property_accumulated_depreciation"
  | "property_cip";

export interface ForecastQboAccountClassification {
  /** The immutable QBO Account.Id, never a display-name match. */
  readonly accountId: string;
  readonly kind: ForecastQboBalanceKind;
  /** Required for property-level classifications. */
  readonly propertyId?: string;
}

export type ForecastQboSourceState = "sourced" | "partial" | "unknown";
export type ForecastQboCoverage = "complete" | "partial" | "unavailable";
export type ForecastQboFreshness = "live_read" | "stale" | "unknown";
export type ForecastQboReconciliation = "reconciled" | "unreconciled";

export interface ForecastQboAmount {
  /** Exact signed cents, or null when the mapped amount cannot be established. */
  readonly amountCents: string | null;
  readonly state: ForecastQboSourceState;
  readonly asOf: string | null;
  readonly sourceIds: readonly string[];
  readonly note?: string;
}

export interface ForecastQboPropertyBookBalance {
  readonly propertyId: string;
  /** Null means no approved mapping or no verifiable provider line. */
  readonly costBasisCents: string | null;
  readonly accumulatedDepreciationCents: string | null;
  readonly constructionInProgressCents: string | null;
  readonly state: ForecastQboSourceState;
  readonly asOf: string | null;
  readonly sourceIds: readonly string[];
  readonly note?: string;
}

export interface ForecastQboOpeningBalance {
  readonly organizationId: string;
  /** Null for an explicit portfolio aggregate; inspect entityScope for its members. */
  readonly legalEntityId: string | null;
  readonly entityScope: readonly string[];
  readonly realmId: string | null;
  readonly environment: QuickBooksConnectionScope["environment"];
  readonly asOf: string;
  readonly basis: QuickBooksReportAccountingMethod;
  readonly currency: string;
  readonly observedAt: string;
  readonly freshness: ForecastQboFreshness;
  readonly coverage: ForecastQboCoverage;
  readonly mappingCoverage: Exclude<ForecastQboCoverage, "unavailable">;
  /** A native report alone never proves bank/ledger reconciliation. */
  readonly reconciliation: ForecastQboReconciliation;
  readonly reportSourceId: string;
  readonly operatingCash: ForecastQboAmount;
  readonly restrictedCash: ForecastQboAmount;
  readonly accountsPayable: ForecastQboAmount;
  readonly propertyBookBalances: Readonly<Record<string, ForecastQboPropertyBookBalance>>;
  readonly sourceIds: readonly string[];
  readonly note?: string;
}

export interface ForecastQboOpeningBalanceSource {
  read(input: { readonly organizationId: string; readonly asOf: IsoDate | string }): Promise<ForecastQboOpeningBalance>;
}

export interface QuickBooksForecastBalanceSourceOptions {
  readonly scope: QuickBooksConnectionScope;
  readonly client: QuickBooksReportsClient;
  readonly basis: QuickBooksReportAccountingMethod;
  readonly currency: string;
  readonly classifications: readonly ForecastQboAccountClassification[];
  /** Set only when an independent reconciliation has been performed. */
  readonly reconciliation?: ForecastQboReconciliation;
  /** Account mapping status is separate from provider report availability. */
  readonly mappingCoverage?: Exclude<ForecastQboCoverage, "unavailable">;
  readonly now?: () => string;
}

export interface QuickBooksForecastPortfolioBalanceSourceOptions {
  /** One explicitly configured native source per legal entity. */
  readonly entities: readonly QuickBooksForecastBalanceSourceOptions[];
  /** The complete in-scope legal-entity set required by the forecast. */
  readonly expectedLegalEntityIds: readonly string[];
  /** Set only when the complete aggregate has independent reconciliation evidence. */
  readonly reconciliation?: ForecastQboReconciliation;
  readonly now?: () => string;
}

interface ReportRow {
  readonly accountId: string;
  readonly amountCents: string | null;
}

interface ReportRows {
  readonly rows: ReportRow[];
  /** False when the report has no unambiguous/parseable amount column. */
  readonly amountsVerified: boolean;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;

function safeDate(value: string, field: string): string {
  if (!DATE_PATTERN.test(value)) throw new Error(`QuickBooks forecast ${field} is invalid`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`QuickBooks forecast ${field} is invalid`);
  return value;
}

function safeCurrency(value: string): string {
  if (!CURRENCY_PATTERN.test(value)) throw new Error("QuickBooks forecast currency is invalid");
  return value;
}

function safeAccountId(value: string): string {
  if (!ACCOUNT_ID_PATTERN.test(value)) throw new Error("QuickBooks forecast account mapping is invalid");
  return value;
}

/** Parse a provider money cell without routing it through JavaScript floating point. */
export function qboReportAmountToCents(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    // The production report transport uses lossless JSON numbers. A direct
    // adapter caller must still not pass an unsafe floating-point value.
    throw new Error("QuickBooks forecast money cell is not exact");
  }
  if (typeof value !== "string" && typeof value !== "number") throw new Error("QuickBooks forecast money cell is invalid");
  let text = String(value).trim();
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1);
  }
  // QBO display values can contain grouping commas. Validate their placement
  // before removing them so malformed values never become money.
  if (text.includes(",") && !/^\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$/.test(text)) throw new Error("QuickBooks forecast money cell is invalid");
  text = text.replaceAll(",", "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error("QuickBooks forecast money cell is invalid");
  const [whole, fraction = ""] = text.split(".");
  const cents = BigInt(whole) * BigInt(100) + BigInt((fraction + "00").slice(0, 2));
  return centsFromBigInt(negative ? -cents : cents);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function arrayOrObject(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function headerValue(response: QuickBooksReportResponse, key: string): unknown {
  const header = objectValue(response.raw.Header);
  if (!header) return undefined;
  if (header[key] !== undefined) return header[key];
  const options = header.Options ?? header.Option;
  for (const option of arrayOrObject(options)) {
    const row = objectValue(option);
    if (!row) continue;
    const name = row.Name ?? row.name ?? row.Key ?? row.key;
    if (name === key || (typeof name === "string" && name.toLowerCase() === key.toLowerCase())) return row.Value ?? row.value ?? row.SelectedValue ?? row.selectedValue;
  }
  return undefined;
}

/**
 * Select the only verifiable amount column in a native report. BalanceSheet
 * normally has Account + Total. A grouped/multi-column report must identify
 * its Total column explicitly; selecting the first non-empty cell can turn a
 * comparison period or another grouping into the opening balance.
 *
 * `undefined` means the provider omitted Columns metadata, in which case a
 * two-cell account/amount row is the only shape we accept. `null` means the
 * metadata was present but did not identify one unambiguous amount column.
 */
function moneyColumnIndex(response: QuickBooksReportResponse): number | null | undefined {
  const rawColumns = response.raw.Columns;
  if (rawColumns === undefined) return undefined;
  const columnsContainer = objectValue(rawColumns);
  if (!columnsContainer || columnsContainer.Column === undefined) return null;
  const columns = arrayOrObject(columnsContainer.Column).map(objectValue);
  if (!columns.length) return null;
  const moneyCandidates = columns.flatMap((column, index) => {
    if (!column || index === 0) return [];
    const type = typeof column.ColType === "string" ? column.ColType.trim().toLowerCase() : "";
    const title = typeof column.ColTitle === "string" ? column.ColTitle.trim().toLowerCase() : "";
    return type === "money" || title === "total" ? [{ index, title }] : [];
  });
  if (!moneyCandidates.length) return null;
  if (moneyCandidates.length === 1) return moneyCandidates[0]!.index;
  const totalCandidates = moneyCandidates.filter(candidate => candidate.title === "total");
  return totalCandidates.length === 1 ? totalCandidates[0]!.index : null;
}

function reportRows(response: QuickBooksReportResponse): ReportRows {
  const rootRows = objectValue(response.raw.Rows)?.Row ?? response.raw.Rows;
  const result: ReportRow[] = [];
  const amountIndex = moneyColumnIndex(response);
  let amountsVerified = amountIndex !== null;
  const candidateFromCells = (value: unknown): ReportRow | null => {
    if (!Array.isArray(value) || value.length === 0) return null;
    const first = objectValue(value[0]);
    const accountId = typeof first?.id === "string" ? first.id : typeof first?.Id === "string" ? first.Id : undefined;
    if (!accountId) return null;
    // When Columns metadata is absent, only the ordinary two-cell shape is
    // safe. For a metadata-backed report, use the selected Total column and
    // never substitute another populated monetary cell.
    const selectedIndex = amountIndex === undefined ? (value.length === 2 ? 1 : null) : amountIndex;
    let amount: string | null = null;
    if (selectedIndex !== null && selectedIndex < value.length) {
      const candidateCell = objectValue(value[selectedIndex]);
      const candidate = candidateCell?.value ?? candidateCell?.Value;
      if (candidate !== undefined && candidate !== "") {
        try {
          amount = qboReportAmountToCents(candidate);
        } catch {
          // A mapped row with an invalid amount must remain unknown. Keep
          // the row out of the sum rather than turning it into zero.
        }
      }
    }
    return { accountId, amountCents: amount };
  };
  /**
   * Walk one native report node and return every account ID below it. QBO can
   * put a real account line in Header.ColData while also returning a nested
   * contra-account (for example, buildings and accumulated depreciation).
   * Both account-bearing headers and child rows are retained. Summary.ColData
   * is deliberately never visited: it is a group subtotal and must not be
   * added to the account balances.
   */
  const walk = (value: unknown): Set<string> => {
    const row = objectValue(value);
    if (!row) return new Set();
    const candidates = [
      candidateFromCells(row.Header && objectValue(row.Header)?.ColData),
      candidateFromCells(row.ColData),
    ].filter((candidate): candidate is ReportRow => candidate !== null);
    // Native QBO groups use row.Rows.Row. Depending on the number of children,
    // Row can itself be an array or a single object, so accept both forms.
    const nestedRows = objectValue(row.Rows)?.Row ?? row.Rows;
    const descendantIds = new Set<string>();
    for (const child of arrayOrObject(nestedRows)) {
      walk(child).forEach(accountId => descendantIds.add(accountId));
    }
    const ownIds = new Set(candidates.map(candidate => candidate.accountId));
    for (const candidate of candidates) {
      if (candidate.amountCents === null) amountsVerified = false;
      // Retain an account row even when its amount is absent or malformed so
      // sumMapped can reject duplicate IDs instead of counting one valid row
      // and silently ignoring its ambiguous sibling.
      result.push(candidate);
    }
    ownIds.forEach(accountId => descendantIds.add(accountId));
    return descendantIds;
  };
  for (const row of arrayOrObject(rootRows)) walk(row);
  return { rows: result, amountsVerified };
}

function sumMapped(rows: readonly ReportRow[], accountIds: readonly string[]): { amountCents: string | null; sourceIds: string[]; complete: boolean } {
  const wanted = new Set(accountIds);
  if (!wanted.size) return { amountCents: null, sourceIds: [], complete: false };
  let total = BigInt(0);
  const sourceIds: string[] = [];
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!wanted.has(row.accountId)) continue;
    counts.set(row.accountId, (counts.get(row.accountId) ?? 0) + 1);
    if (row.amountCents !== null) total += BigInt(row.amountCents);
    sourceIds.push(`account:${row.accountId}`);
  }
  // A configured mapping is complete only when every mapped Account.Id is
  // present exactly once. Missing and duplicate rows are both ambiguous and
  // must not become a partially summed opening balance.
  const complete = Array.from(wanted).every(accountId => counts.get(accountId) === 1)
    && rows.every(row => !wanted.has(row.accountId) || row.amountCents !== null);
  return { amountCents: complete ? centsFromBigInt(total) : null, sourceIds, complete };
}

function validateClassifications(classifications: readonly ForecastQboAccountClassification[]): void {
  const seen = new Map<string, string>();
  const propertyKinds = new Set<ForecastQboBalanceKind>(["property_cost", "property_accumulated_depreciation", "property_cip"]);
  const knownKinds = new Set<ForecastQboBalanceKind>(["operating_cash", "restricted_cash", "accounts_payable", "property_cost", "property_accumulated_depreciation", "property_cip"]);
  for (const classification of classifications) {
    const accountId = safeAccountId(classification.accountId);
    if (!knownKinds.has(classification.kind)) throw new Error("QuickBooks forecast account mapping kind is invalid");
    if (propertyKinds.has(classification.kind) && !classification.propertyId) {
      throw new Error(`QuickBooks forecast ${classification.kind} requires a property ID`);
    }
    if (!propertyKinds.has(classification.kind) && classification.propertyId !== undefined) throw new Error(`QuickBooks forecast ${classification.kind} cannot carry a property ID`);
    const prior = seen.get(accountId);
    const identity = `${classification.kind}:${classification.propertyId ?? ""}`;
    if (prior && prior !== identity) throw new Error(`QuickBooks forecast account ${accountId} has conflicting classifications`);
    if (prior) throw new Error(`QuickBooks forecast account ${accountId} is mapped more than once`);
    seen.set(accountId, identity);
  }
}

function amountFor(
  rows: readonly ReportRow[],
  accountIds: readonly string[],
  asOf: string,
  state: ForecastQboSourceState,
  reportSourceId: string,
  note?: string,
): ForecastQboAmount {
  const mapped = sumMapped(rows, accountIds);
  const mappingNote = accountIds.length > 0 && !mapped.complete ? "One or more explicitly mapped QuickBooks Account.Id rows were missing or duplicated." : undefined;
  const fullNote = [note, mappingNote].filter((value): value is string => Boolean(value)).join(" ");
  return {
    amountCents: mapped.amountCents,
    state: mapped.amountCents === null ? "unknown" : state,
    asOf: mapped.amountCents === null ? null : asOf,
    sourceIds: [reportSourceId, ...mapped.sourceIds],
    ...(fullNote ? { note: fullNote } : {}),
  };
}

function stateFor(input: { readonly coverage: ForecastQboCoverage; readonly reconciliation: ForecastQboReconciliation; readonly mappingCoverage: Exclude<ForecastQboCoverage, "unavailable"> }): ForecastQboSourceState {
  return input.coverage === "complete" && input.mappingCoverage === "complete" && input.reconciliation === "reconciled" ? "sourced" : "partial";
}

function scopeMatches(response: QuickBooksReportResponse, scope: QuickBooksConnectionScope): boolean {
  const actual = response.scope;
  return actual.organizationId === scope.organizationId
    && actual.legalEntityId === scope.legalEntityId
    && actual.realmId === scope.realmId
    && actual.environment === scope.environment;
}

function unavailable(input: {
  readonly scope: QuickBooksConnectionScope;
  readonly asOf: string;
  readonly basis: QuickBooksReportAccountingMethod;
  readonly currency: string;
  readonly observedAt: string;
  readonly note: string;
}): ForecastQboOpeningBalance {
  const base = { amountCents: null, state: "unknown" as const, asOf: null, sourceIds: [] as const, note: input.note };
  return {
    organizationId: input.scope.organizationId, legalEntityId: input.scope.legalEntityId, entityScope: [input.scope.legalEntityId], realmId: input.scope.realmId, environment: input.scope.environment,
    asOf: input.asOf, basis: input.basis, currency: input.currency, observedAt: input.observedAt,
    freshness: "unknown", coverage: "unavailable", mappingCoverage: "partial", reconciliation: "unreconciled",
    reportSourceId: `qbo:${input.scope.environment}:${input.scope.realmId}:BalanceSheet:${input.asOf}`,
    operatingCash: base, restrictedCash: base, accountsPayable: base, propertyBookBalances: {}, sourceIds: [], note: input.note,
  };
}

function propertyBalances(
  rows: readonly ReportRow[],
  classifications: readonly ForecastQboAccountClassification[],
  asOf: string,
  state: ForecastQboSourceState,
  reportSourceId: string,
  note?: string,
): Readonly<Record<string, ForecastQboPropertyBookBalance>> {
  const properties = new Set(classifications.filter(item => item.propertyId && item.kind.startsWith("property_")).map(item => item.propertyId!));
  const result: Record<string, ForecastQboPropertyBookBalance> = {};
  for (const propertyId of Array.from(properties)) {
    const mappedForKind = (kind: ForecastQboBalanceKind) => {
      const accountIds = classifications.filter(item => item.propertyId === propertyId && item.kind === kind).map(item => item.accountId);
      return { accountIds, mapped: sumMapped(rows, accountIds) };
    };
    const costEntry = mappedForKind("property_cost");
    const accumulatedEntry = mappedForKind("property_accumulated_depreciation");
    const cipEntry = mappedForKind("property_cip");
    const cost = costEntry.mapped;
    const accumulated = accumulatedEntry.mapped;
    const cip = cipEntry.mapped;
    const known = [cost.amountCents, accumulated.amountCents, cip.amountCents].filter(value => value !== null).length;
    const propertyState: ForecastQboSourceState = known === 0 ? "unknown" : known === 3 ? state : "partial";
    const mappingNote = [costEntry, accumulatedEntry, cipEntry].some(entry => entry.accountIds.length > 0 && !entry.mapped.complete)
      ? "One or more explicitly mapped QuickBooks Account.Id rows were missing or duplicated."
      : undefined;
    const propertyNote = [note, mappingNote].filter((value): value is string => Boolean(value)).join(" ");
    result[propertyId] = {
      propertyId, costBasisCents: cost.amountCents, accumulatedDepreciationCents: accumulated.amountCents, constructionInProgressCents: cip.amountCents,
      state: propertyState, asOf: known === 0 ? null : asOf,
      sourceIds: [reportSourceId, ...cost.sourceIds, ...accumulated.sourceIds, ...cip.sourceIds],
      ...(propertyNote ? { note: propertyNote } : {}),
    };
  }
  return result;
}

/**
 * Build a read-only opening-balance source on top of the native QBO report
 * client. The caller must provide one legal-entity/realm scope and an
 * approved Account.Id classification. Names and current Customer balances
 * are intentionally never used.
 */
export function createQuickBooksForecastBalanceSource(options: QuickBooksForecastBalanceSourceOptions): ForecastQboOpeningBalanceSource {
  const scope = options.scope;
  const basis = options.basis;
  const currency = safeCurrency(options.currency);
  validateClassifications(options.classifications);
  const mappingCoverage = options.mappingCoverage ?? "partial";
  const reconciliation = options.reconciliation ?? "unreconciled";
  const now = options.now ?? (() => new Date().toISOString());
  const observedAt = (): string => {
    const value = now();
    if (Number.isNaN(new Date(value).getTime())) throw new Error("QuickBooks forecast observation time is invalid");
    return value;
  };
  const noteFor = (coverage: ForecastQboCoverage): string => [
    "QBO native BalanceSheet read; report balances are not a bank or ledger reconciliation.",
    mappingCoverage === "partial" ? "Account classification coverage is partial." : null,
    coverage !== "complete" ? "Provider report coverage is incomplete." : null,
  ].filter((value): value is string => value !== null).join(" ");

  return {
    async read(input) {
      const asOf = safeDate(String(input.asOf), "as-of date");
      const stamp = observedAt();
      if (input.organizationId !== scope.organizationId) return unavailable({ scope, asOf, basis, currency, observedAt: stamp, note: "QuickBooks forecast organization scope did not match the request." });
      const reportSourceId = `qbo:${scope.organizationId}:${scope.legalEntityId}:${scope.environment}:${scope.realmId}:BalanceSheet:${asOf}:${basis}:${currency}`;
      let response: QuickBooksReportResponse;
      try {
        response = await options.client.getReport("BalanceSheet", { endDate: asOf, accountingMethod: basis, expectedCurrency: currency });
      } catch (error) {
        // Provider error text can contain account names, request identifiers,
        // or other sensitive details. Keep user-facing provenance generic.
        void error;
        return unavailable({ scope, asOf, basis, currency, observedAt: stamp, note: "QuickBooks BalanceSheet read unavailable." });
      }
      const providerBasis = response.accountingMethod;
      const providerCurrency = response.currency ?? headerValue(response, "Currency");
      const providerEnd = headerValue(response, "EndPeriod") ?? headerValue(response, "ReportDate");
      if (!scopeMatches(response, scope) || providerBasis !== basis || providerCurrency !== currency || providerEnd !== asOf) {
        return unavailable({ scope, asOf, basis, currency, observedAt: stamp, note: "QuickBooks BalanceSheet context did not match the requested entity, date, basis, or currency." });
      }
      const parsedRows = reportRows(response);
      const providerRows = parsedRows.rows;
      const reportCoverage: ForecastQboCoverage = response.truncated
        ? "partial"
        : response.noReportData && providerRows.length === 0
          ? "complete"
          : providerRows.length > 0
            ? parsedRows.amountsVerified ? "complete" : "partial"
            : "unavailable";
      if (reportCoverage === "unavailable") return unavailable({ scope, asOf, basis, currency, observedAt: stamp, note: "QuickBooks returned no BalanceSheet rows without a provider-declared no-data marker." });
      const classifications = options.classifications;
      const operatingCashIds = classifications.filter(item => item.kind === "operating_cash").map(item => item.accountId);
      const restrictedCashIds = classifications.filter(item => item.kind === "restricted_cash").map(item => item.accountId);
      const payableIds = classifications.filter(item => item.kind === "accounts_payable").map(item => item.accountId);
      const propertyKinds: readonly ForecastQboBalanceKind[] = ["property_cost", "property_accumulated_depreciation", "property_cip"];
      const propertyIds = new Set(classifications.filter(item => item.propertyId && propertyKinds.includes(item.kind)).map(item => item.propertyId!));
      const mappedGroups = [operatingCashIds, restrictedCashIds, payableIds,
        ...Array.from(propertyIds).flatMap(propertyId => propertyKinds.map(kind => classifications.filter(item => item.propertyId === propertyId && item.kind === kind).map(item => item.accountId)))];
      const mappingsComplete = mappingCoverage === "complete" && mappedGroups.every(accountIds => sumMapped(providerRows, accountIds).complete);
      const coverage: ForecastQboCoverage = reportCoverage === "complete" && mappingsComplete ? "complete" : "partial";
      const state = stateFor({ coverage, mappingCoverage, reconciliation });
      const note = noteFor(coverage);
      return {
        organizationId: scope.organizationId, legalEntityId: scope.legalEntityId, entityScope: [scope.legalEntityId], realmId: scope.realmId, environment: scope.environment,
        asOf, basis, currency, observedAt: stamp, freshness: "live_read", coverage, mappingCoverage, reconciliation, reportSourceId,
        operatingCash: amountFor(providerRows, operatingCashIds, asOf, state, reportSourceId, note),
        restrictedCash: amountFor(providerRows, restrictedCashIds, asOf, state, reportSourceId, note),
        accountsPayable: amountFor(providerRows, payableIds, asOf, state, reportSourceId, note),
        propertyBookBalances: propertyBalances(providerRows, classifications, asOf, state, reportSourceId, note),
        sourceIds: [reportSourceId, ...providerRows.map(row => `account:${row.accountId}`)],
        note,
      };
    },
  };
}

function aggregateAmount(
  values: readonly ForecastQboAmount[],
  asOf: string,
  state: ForecastQboSourceState,
  sourceIds: readonly string[],
  note: string,
  usable: boolean,
): ForecastQboAmount {
  if (!usable || !values.length || values.some(value => value.amountCents === null)) {
    return { amountCents: null, state: "unknown", asOf: null, sourceIds, note };
  }
  const total = values.reduce((sum, value) => sum + BigInt(value.amountCents!), BigInt(0));
  return { amountCents: centsFromBigInt(total), state, asOf, sourceIds, note };
}

/**
 * Aggregate explicit per-entity reads for the company-wide forecast.  This is
 * intentionally opt-in: a single legal-entity report cannot stand in for the
 * portfolio, and a partial entity set cannot be summed into a complete value.
 */
export function createQuickBooksForecastPortfolioBalanceSource(options: QuickBooksForecastPortfolioBalanceSourceOptions): ForecastQboOpeningBalanceSource {
  if (new Set(options.expectedLegalEntityIds).size !== options.expectedLegalEntityIds.length) throw new Error("QuickBooks forecast portfolio has duplicate expected legal entities");
  const expected = [...options.expectedLegalEntityIds];
  if (!expected.length) throw new Error("QuickBooks forecast portfolio requires at least one legal entity");
  const entities = [...options.entities];
  if (!entities.length) throw new Error("QuickBooks forecast portfolio requires configured entity sources");
  const organizationId = entities[0]!.scope.organizationId;
  const scopeIds = entities.map(entity => entity.scope.legalEntityId);
  if (new Set(scopeIds).size !== scopeIds.length) throw new Error("QuickBooks forecast portfolio has duplicate legal-entity sources");
  const realmIds = entities.map(entity => entity.scope.realmId);
  if (new Set(realmIds).size !== realmIds.length) throw new Error("QuickBooks forecast portfolio has duplicate QuickBooks realm sources");
  if (entities.some(entity => entity.scope.organizationId !== organizationId)) throw new Error("QuickBooks forecast portfolio sources must share one organization");
  const environments = entities.map(entity => entity.scope.environment);
  if (new Set(environments).size !== 1) throw new Error("QuickBooks forecast portfolio sources must share one environment");
  const bases = entities.map(entity => entity.basis);
  if (new Set(bases).size !== 1) throw new Error("QuickBooks forecast portfolio sources must share one accounting basis");
  const currencies = entities.map(entity => entity.currency);
  if (new Set(currencies).size !== 1) throw new Error("QuickBooks forecast portfolio sources must share one currency");
  const missingEntities = expected.filter(entityId => !scopeIds.includes(entityId));
  const unexpectedEntities = scopeIds.filter(entityId => !expected.includes(entityId));
  if (unexpectedEntities.length) throw new Error("QuickBooks forecast portfolio contains an entity outside the requested scope");
  const now = options.now ?? (() => new Date().toISOString());
  const readers = entities.map(entity => createQuickBooksForecastBalanceSource({ ...entity, now: entity.now ?? now }));
  const mappingByProperty = new Map<string, string>();
  for (const entity of entities) {
    for (const classification of entity.classifications) {
      if (!classification.propertyId || !classification.kind.startsWith("property_")) continue;
      const prior = mappingByProperty.get(classification.propertyId);
      if (prior && prior !== entity.scope.legalEntityId) throw new Error(`QuickBooks forecast property ${classification.propertyId} is mapped in multiple legal entities`);
      mappingByProperty.set(classification.propertyId, entity.scope.legalEntityId);
    }
  }
  return {
    async read(input) {
      const asOf = safeDate(String(input.asOf), "as-of date");
      const observedAt = now();
      const results = await Promise.all(readers.map(reader => reader.read(input)));
      const basis = entities[0]!.basis;
      const currency = entities[0]!.currency;
      const organizationMismatch = input.organizationId !== organizationId;
      const mismatchedContext = results.some((result, index) => {
        const expectedScope = entities[index]!.scope;
        return result.organizationId !== organizationId
          || result.legalEntityId !== expectedScope.legalEntityId
          || result.realmId !== expectedScope.realmId
          || result.environment !== expectedScope.environment
          || result.asOf !== asOf
          || result.basis !== basis
          || result.currency !== currency;
      });
      const allEntityResults = !missingEntities.length && !organizationMismatch && !mismatchedContext;
      const allAmountsKnown = (result: ForecastQboOpeningBalance): boolean => result.operatingCash.amountCents !== null
        && result.restrictedCash.amountCents !== null
        && result.accountsPayable.amountCents !== null
        && Object.values(result.propertyBookBalances).every(balance => balance.costBasisCents !== null && balance.accumulatedDepreciationCents !== null && balance.constructionInProgressCents !== null);
      const allComplete = allEntityResults && results.every(result => result.coverage === "complete" && result.mappingCoverage === "complete" && allAmountsKnown(result));
      const anyAvailable = results.some(result => result.coverage !== "unavailable");
      const coverage: ForecastQboCoverage = allComplete ? "complete" : anyAvailable ? "partial" : "unavailable";
      const reconciliation = options.reconciliation === "reconciled" && results.every(result => result.reconciliation === "reconciled") ? "reconciled" : "unreconciled";
      const aggregateState: ForecastQboSourceState = coverage === "complete" && reconciliation === "reconciled" ? "sourced" : "partial";
      const reportSourceId = `qbo:portfolio:${organizationId}:BalanceSheet:${asOf}:${basis}:${currency}`;
      const allSourceIds = [reportSourceId, ...results.flatMap(result => result.sourceIds)];
      const note = [
        "QBO native BalanceSheet reads; aggregate balances are not a bank or ledger reconciliation.",
        missingEntities.length ? `Missing in-scope legal entity source(s): ${missingEntities.join(", ")}.` : null,
        coverage !== "complete" ? "One or more entity reports or account mappings are incomplete." : null,
      ].filter((value): value is string => value !== null).join(" ");
      const sourceAmounts = (key: "operatingCash" | "restrictedCash" | "accountsPayable") => results.map(result => result[key]);
      const propertyIds = new Set(results.flatMap(result => Object.keys(result.propertyBookBalances)));
      const propertyBookBalances: Record<string, ForecastQboPropertyBookBalance> = {};
      for (const propertyId of Array.from(propertyIds)) {
        const ownerEntity = mappingByProperty.get(propertyId);
        const result = results.find(item => item.legalEntityId === ownerEntity && item.propertyBookBalances[propertyId]);
        const balance = result?.propertyBookBalances[propertyId];
        if (!balance || !allComplete) {
          propertyBookBalances[propertyId] = { propertyId, costBasisCents: null, accumulatedDepreciationCents: null, constructionInProgressCents: null, state: "unknown", asOf: null, sourceIds: allSourceIds, note };
          continue;
        }
        propertyBookBalances[propertyId] = { ...balance, state: aggregateState === "sourced" ? balance.state : balance.state === "unknown" ? "unknown" : "partial", sourceIds: [reportSourceId, ...balance.sourceIds], ...(note ? { note } : {}) };
      }
      return {
        organizationId, legalEntityId: null, entityScope: expected, realmId: null, environment: entities[0]!.scope.environment,
        asOf, basis, currency, observedAt, freshness: allComplete ? "live_read" : "unknown", coverage,
        mappingCoverage: allComplete ? "complete" : "partial", reconciliation, reportSourceId,
        operatingCash: aggregateAmount(sourceAmounts("operatingCash"), asOf, aggregateState, allSourceIds, note, allComplete),
        restrictedCash: aggregateAmount(sourceAmounts("restrictedCash"), asOf, aggregateState, allSourceIds, note, allComplete),
        accountsPayable: aggregateAmount(sourceAmounts("accountsPayable"), asOf, aggregateState, allSourceIds, note, allComplete),
        propertyBookBalances,
        sourceIds: allSourceIds,
        note,
      };
    },
  };
}
