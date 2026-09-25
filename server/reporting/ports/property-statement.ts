import { legacyNumberToCents } from "../../../shared/company";
import type { ReportingEngineContext } from "../../../shared/reporting";
import { deriveCollectedIncome } from "../../rent-ops/domain/reports";
import type { CombinedFinancialReadPort } from "../combined-financial-engine";
import { ReportingError } from "../errors";
import type { PmSettlementReadPort } from "../owner-statement-engine";
import type { PropertyStatementReadPort, PropertyStatementReadResult } from "../property-statement-engine";
import type { RentalSnapshotReadPort } from "../rental-expanded-engine";

export interface PropertyStatementPortOptions {
  readonly rental: RentalSnapshotReadPort;
  readonly settlements: PmSettlementReadPort;
  /** Optional; without it book actuals are reported as unavailable. */
  readonly financial?: CombinedFinancialReadPort;
  /** Currency for rental collections, which rent-ops stores without one. */
  readonly rentalCurrency?: string;
}

/**
 * Composes the three independent sources of a property statement. Each source
 * keeps its own coverage; one source failing leaves its measures unknown and
 * never turns them into zero.
 */
export function createPropertyStatementReadPort(options: PropertyStatementPortOptions): PropertyStatementReadPort {
  return {
    async read({ context, from, through }): Promise<PropertyStatementReadResult> {
      const rental = await options.rental.readSnapshot({ context, filters: { fromDate: from as never, toDate: through as never } });
      const snapshot = rental.snapshot;
      const scope = context.request.scope;
      const properties = snapshot.properties
        .filter(property => !scope.propertyIds.length || scope.propertyIds.includes(property.id as typeof scope.propertyIds[number]))
        .map(property => ({ propertyId: property.id, propertyName: property.name ?? null, legalEntityId: null }));
      const currency = options.rentalCurrency ?? context.request.currency ?? "USD";
      let rentalCollections: PropertyStatementReadResult["rentalCollections"] = null;
      let rentalReason: string | null = rental.coverage?.reason ?? null;
      try {
        const rows = deriveCollectedIncome(snapshot, { fromDate: from as never, toDate: through as never, propertyIds: properties.map(item => item.propertyId) });
        rentalCollections = rows.filter(row => row.propertyId).map(row => ({ propertyId: row.propertyId!, amountCents: row.amountCents === null ? null : legacyNumberToCents(row.amountCents), currency }));
      } catch (error) {
        rentalReason = error instanceof Error ? error.message.slice(0, 400) : "Rental collections could not be derived.";
      }
      const settlementResult = await options.settlements.read({ context, from, through });
      const settlements = settlementResult.settlements.filter(item => properties.some(property => property.propertyId === item.propertyId));
      let bookActuals: PropertyStatementReadResult["bookActuals"] = null;
      let bookReason: string | null = "QuickBooks actuals are not connected for these properties.";
      let bookState: "unavailable" | "partial" | "complete" = "unavailable";
      let bookUnknownPropertyIds: string[] = [];
      if (options.financial && scope.legalEntityIds.length && (context.request.basis === "cash" || context.request.basis === "accrual")) {
        const financialContext: ReportingEngineContext = { ...context, request: { ...context.request } };
        try {
          const book = await options.financial.read({ context: financialContext, reportId: "property-t12", legalEntityIds: scope.legalEntityIds.map(String), propertyIds: properties.map(item => item.propertyId), unitIds: [], accountIds: [] });
          if (book.coverage.state !== "unavailable") {
            bookActuals = book.lines.filter(line => line.propertyId && (line.category === "income" || line.category === "expense") && line.date >= from && line.date <= through).map(line => ({ propertyId: line.propertyId!, category: line.category as "income" | "expense", amountCents: line.amountCents, currency: line.currency }));
            bookState = book.coverage.state;
            // Only a property whose lines are fully attributed has known book
            // actuals; without attribution evidence none do.
            const attributed = new Set(book.propertyAttribution?.attributedPropertyIds ?? []);
            bookUnknownPropertyIds = properties.map(item => item.propertyId).filter(id => !attributed.has(id));
          }
          bookReason = book.coverage.reason ?? null;
          if (bookUnknownPropertyIds.length) bookReason = ["QuickBooks lines are not attributed to every selected property by a single dated property mapping, so book actuals for those properties are unknown.", bookReason].filter(Boolean).join(" ").slice(0, 500);
        } catch (error) {
          bookReason = error instanceof ReportingError ? error.message : "QuickBooks actuals could not be read.";
        }
      } else if (options.financial && !scope.legalEntityIds.length) {
        bookReason = "Choose legal entities to include QuickBooks actuals.";
      } else if (options.financial) {
        bookReason = "Choose cash or accrual basis to include QuickBooks actuals.";
      }
      return {
        properties,
        rentalCollections,
        rentalCoverage: { state: rentalCollections === null ? "unavailable" : rental.coverage?.state ?? "partial", reason: rentalReason },
        settlements,
        settlementCoverage: { state: settlements.length ? settlementResult.coverage.state : "unavailable", reason: settlements.length ? settlementResult.coverage.reason ?? null : "No PM settlements fall within this period." },
        bookActuals,
        bookUnknownPropertyIds,
        bookCoverage: { state: bookState, reason: bookReason },
      };
    },
  };
}
