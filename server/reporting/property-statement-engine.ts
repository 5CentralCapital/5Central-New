import { centsFromBigInt } from "../../shared/company";
import type { ReportMissingData, ReportSourceCoverage, ReportTotal, ReportingEngineContext, ReportingEngineResult } from "../../shared/reporting";
import { ReportingError } from "./errors";
import type { PmSettlementRecord } from "./owner-statement-engine";
import { periodBounds, reportColumns, resultFromRecords, sourceCoverage } from "./source-engine-utils";
import type { ReportingEngine } from "./registry";

export const PROPERTY_STATEMENT_ENGINE_REPORT_IDS = ["property-statement"] as const;

type SourceState = { readonly state: ReportSourceCoverage["state"]; readonly reason?: string | null };

export interface PropertyStatementReadResult {
  readonly properties: readonly { readonly propertyId: string; readonly propertyName: string | null; readonly legalEntityId: string | null }[];
  /** Rent-ops collections in the period by property. `null` means the rental source is unavailable. */
  readonly rentalCollections: readonly { readonly propertyId: string; readonly amountCents: string | null; readonly currency: string }[] | null;
  readonly rentalCoverage: SourceState;
  /** PM settlements for the scoped properties whose periods overlap the report period; ones extending beyond it are flagged and excluded. */
  readonly settlements: readonly PmSettlementRecord[];
  readonly settlementCoverage: SourceState;
  /** QuickBooks actuals attributed to a property by a dated mapping. `null` means unavailable. */
  readonly bookActuals: readonly { readonly propertyId: string; readonly category: "income" | "expense"; readonly amountCents: string; readonly currency: string }[] | null;
  /** Properties whose book actuals are unknown because some in-scope lines carry no property attribution. */
  readonly bookUnknownPropertyIds?: readonly string[];
  readonly bookCoverage: SourceState;
}

export interface PropertyStatementReadPort {
  read(input: { readonly context: ReportingEngineContext; readonly from: string; readonly through: string }): Promise<PropertyStatementReadResult>;
}

export const PROPERTY_STATEMENT_MEASURES = [
  { id: "rental_collections", label: "Rental collections (operating records)", kind: "collections", source: "rental_operational_records" },
  { id: "gross_collections", label: "Gross collections (PM statement)", kind: "collections", source: "pm_settlements" },
  { id: "pm_fees", label: "PM fees", kind: "deduction", source: "pm_settlements" },
  { id: "pm_expenses", label: "PM-paid expenses", kind: "deduction", source: "pm_settlements" },
  { id: "other_deductions", label: "Other PM deductions", kind: "deduction", source: "pm_settlements" },
  { id: "net_to_owner", label: "Net due to owner", kind: "net", source: "pm_settlements" },
  { id: "owner_remittance", label: "Owner remittance", kind: "remittance", source: "pm_settlements" },
  { id: "pm_held_change", label: "Change in cash held by PM", kind: "held_balance", source: "pm_settlements" },
  { id: "book_income", label: "Book income (QuickBooks)", kind: "book", source: "quickbooks_accounting_mirror" },
  { id: "book_expenses", label: "Book expenses (QuickBooks)", kind: "book", source: "quickbooks_accounting_mirror" },
  { id: "collections_variance", label: "Operating collections less PM gross", kind: "reconciliation", source: "rental_operational_records" },
] as const;
type MeasureId = (typeof PROPERTY_STATEMENT_MEASURES)[number]["id"];

const big = (value: string): bigint => BigInt(value);

/**
 * Property operating statement. Rental collections, PM gross-to-net activity
 * and QuickBooks actuals are separate measures from separate sources. Gross
 * collections, PM fees/expenses and the owner remittance are never added
 * together as income: $1,000 collected, $100 of PM costs and $900 remitted is
 * $1,000 of collections, $100 of deductions and a $900 remittance.
 */
export function createPropertyStatementReportingEngine(read: PropertyStatementReadPort): ReportingEngine {
  return {
    key: "combined.property-statement",
    reportIds: [...PROPERTY_STATEMENT_ENGINE_REPORT_IDS],
    ready: true,
    async run(context): Promise<ReportingEngineResult> {
      const bounds = periodBounds(context);
      if (!bounds.from || !bounds.through) throw new ReportingError("report_validation", "Choose a statement period.", 400);
      const source = await read.read({ context, from: bounds.from, through: bounds.through });
      if (!source.properties.length) throw new ReportingError("report_unavailable", "No properties are mapped to the selected scope for this period.", 409, { dependency: "effective_property_entity_mapping" });
      if (source.rentalCollections === null && !source.settlements.length && source.bookActuals === null) throw new ReportingError("report_unavailable", "Rental collections, PM settlements and QuickBooks actuals are all unavailable for this scope.", 409, { dependency: "property_statement_sources" });
      const missing: ReportMissingData[] = [];
      const records: Record<string, unknown>[] = [];
      const totalsByMeasure = new Map<MeasureId, { amount: bigint; unknown: boolean; currency: string | null }>();
      const currencies = new Set<string>();
      const addTotal = (measure: MeasureId, amount: bigint | null, currency: string | null) => {
        const current = totalsByMeasure.get(measure) ?? { amount: BigInt(0), unknown: false, currency };
        if (amount === null) current.unknown = true; else current.amount += amount;
        if (currency) current.currency = current.currency ?? currency;
        totalsByMeasure.set(measure, current);
      };
      for (const property of [...source.properties].sort((left, right) => String(left.propertyName ?? left.propertyId).localeCompare(String(right.propertyName ?? right.propertyId)))) {
        const settlements = source.settlements.filter(item => item.propertyId === property.propertyId && item.periodStart >= bounds.from! && item.periodEnd <= bounds.through!);
        const straddling = source.settlements.filter(item => item.propertyId === property.propertyId && (item.periodStart < bounds.from! || item.periodEnd > bounds.through!));
        if (straddling.length) missing.push({ code: "pm_settlement_straddles_period", state: "partial", message: `${property.propertyName ?? property.propertyId}: ${straddling.length} PM settlement${straddling.length === 1 ? " extends" : "s extend"} beyond the statement period and ${straddling.length === 1 ? "is" : "are"} excluded.`, scope: property.propertyId });
        const collections = source.rentalCollections === null ? null : source.rentalCollections.filter(item => item.propertyId === property.propertyId);
        const collectionCurrency = collections?.[0]?.currency ?? settlements[0]?.currency ?? null;
        const values = new Map<MeasureId, bigint | null>();
        // An unknown receipt amount, or no recorded receipts at all, leaves the
        // property's collections unknown; the rental source cannot prove zero.
        values.set("rental_collections", collections === null || !collections.length || collections.some(item => item.amountCents === null) ? null : collections.reduce((sum, item) => sum + big(item.amountCents!), BigInt(0)));
        if (collections?.some(item => item.amountCents === null)) missing.push({ code: "rental_collection_amount_unknown", state: "unknown", message: `${property.propertyName ?? property.propertyId}: at least one receipt has an unknown amount.`, scope: property.propertyId });
        else if (collections && !collections.length) missing.push({ code: "rental_collections_not_recorded", state: "unknown", message: `${property.propertyName ?? property.propertyId}: no rent receipts are recorded for this period.`, scope: property.propertyId });
        if (settlements.length) {
          const sum = (field: "grossCollectionsCents" | "pmFeesCents" | "pmExpensesCents" | "otherDeductionsCents" | "ownerRemittanceCents") => settlements.reduce((acc, item) => acc + big(item[field]), BigInt(0));
          values.set("gross_collections", sum("grossCollectionsCents"));
          values.set("pm_fees", sum("pmFeesCents"));
          values.set("pm_expenses", sum("pmExpensesCents"));
          values.set("other_deductions", sum("otherDeductionsCents"));
          values.set("net_to_owner", sum("grossCollectionsCents") - sum("pmFeesCents") - sum("pmExpensesCents") - sum("otherDeductionsCents"));
          values.set("owner_remittance", sum("ownerRemittanceCents"));
          values.set("pm_held_change", settlements.reduce((acc, item) => acc + big(item.closingHeldCents) - big(item.openingHeldCents), BigInt(0)));
          if (settlements.some(item => item.state !== "reconciled")) missing.push({ code: "pm_settlement_not_reconciled", state: "partial", message: `${property.propertyName ?? property.propertyId}: at least one PM settlement is not reconciled.`, scope: property.propertyId });
        } else {
          for (const measure of ["gross_collections", "pm_fees", "pm_expenses", "other_deductions", "net_to_owner", "owner_remittance", "pm_held_change"] as const) values.set(measure, null);
          missing.push({ code: "pm_settlement_missing", state: "unknown", message: `${property.propertyName ?? property.propertyId}: no PM settlement covers this period.`, scope: property.propertyId });
        }
        const bookUnattributed = source.bookActuals !== null && (source.bookUnknownPropertyIds ?? []).includes(property.propertyId);
        if (bookUnattributed) missing.push({ code: "book_actuals_not_attributed", state: "unknown", message: `${property.propertyName ?? property.propertyId}: QuickBooks lines are not attributed to this property by a single dated mapping, so book actuals are unknown.`, scope: property.propertyId });
        const book = source.bookActuals === null || bookUnattributed ? null : source.bookActuals.filter(item => item.propertyId === property.propertyId);
        values.set("book_income", book === null ? null : book.filter(item => item.category === "income").reduce((sum, item) => sum + big(item.amountCents), BigInt(0)));
        values.set("book_expenses", book === null ? null : book.filter(item => item.category === "expense").reduce((sum, item) => sum + big(item.amountCents), BigInt(0)));
        const rental = values.get("rental_collections");
        const gross = values.get("gross_collections");
        values.set("collections_variance", rental === null || rental === undefined || gross === null || gross === undefined ? null : rental - gross);
        if (rental !== null && rental !== undefined && gross !== null && gross !== undefined && rental !== gross) missing.push({ code: "collections_do_not_tie", state: "partial", message: `${property.propertyName ?? property.propertyId}: operating collections differ from the PM statement gross collections.`, scope: property.propertyId });
        const currency = collectionCurrency ?? book?.[0]?.currency ?? null;
        if (currency) currencies.add(currency);
        for (const measure of PROPERTY_STATEMENT_MEASURES) {
          const amount = values.get(measure.id) ?? null;
          records.push({ propertyId: property.propertyId, propertyName: property.propertyName ?? property.propertyId, measure: measure.label, measureId: measure.id, measureKind: measure.kind, source: measure.source, amountCents: amount === null ? null : centsFromBigInt(amount), currency });
          if (measure.id !== "collections_variance") addTotal(measure.id, amount, currency);
        }
      }
      if (source.rentalCollections === null) missing.push({ code: "rental_collections_unavailable", state: "unavailable", message: source.rentalCoverage.reason ?? "Rental collections are unavailable for this scope." });
      if (source.bookActuals === null) missing.push({ code: "book_actuals_unavailable", state: "unavailable", message: source.bookCoverage.reason ?? "QuickBooks actuals are not mapped to these properties." });
      const totals: ReportTotal[] = [];
      if (currencies.size <= 1) {
        const currency = Array.from(currencies)[0] ?? null;
        // A total is complete only when its own source is complete; a partial
        // source (the QuickBooks mirror always is) never yields "complete".
        const sourceState: Record<string, SourceState["state"]> = { rental_operational_records: source.rentalCoverage.state, pm_settlements: source.settlementCoverage.state, quickbooks_accounting_mirror: source.bookCoverage.state };
        for (const [measure, value] of Array.from(totalsByMeasure.entries())) {
          const measureSource = PROPERTY_STATEMENT_MEASURES.find(item => item.id === measure)!.source;
          const partial = sourceState[measureSource] !== "complete" || missing.some(item => item.state === "partial");
          totals.push({ key: measure, amountCents: value.unknown ? null : centsFromBigInt(value.amount), currency: (value.currency ?? currency) as ReportTotal["currency"], state: value.unknown ? "unknown" : partial ? "partial" : "complete" });
        }
      } else missing.push({ code: "property_statement_multiple_currencies", state: "partial", message: "Properties use more than one currency, so no portfolio totals are shown." });
      const columns = reportColumns([
        { id: "propertyName", label: "Property", type: "text" }, { id: "measure", label: "Measure", type: "text" }, { id: "measureKind", label: "Kind", type: "status" },
        { id: "amountCents", label: "Amount", type: "money" }, { id: "source", label: "Source", type: "status" },
      ]);
      const result = resultFromRecords(context, records, { source: "property_statement", basis: "mixed", missingData: missing, totals, columns, rowId: (_record, _index, values) => `property-statement:${String(values.propertyId)}:${String(values.measureId)}` });
      const coverageFor = (name: string, state: SourceState) => sourceCoverage(context, { source: name, state: state.state, evidence: "reproducible_snapshot", basis: "mixed", rowCount: result.rows.length, reason: state.reason ?? null });
      return { ...result, coverage: [coverageFor("rental_operational_records", source.rentalCoverage), coverageFor("pm_settlements", source.settlementCoverage), coverageFor("quickbooks_accounting_mirror", source.bookCoverage)] };
    },
  };
}
