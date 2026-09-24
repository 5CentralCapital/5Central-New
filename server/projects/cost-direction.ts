import type { FinancialSourceLineResolution } from "../../shared/accounting/source";

/** Cost refunds reserve a positive source amount but reduce project actuals. */
export function hasProjectCostDirection(line: FinancialSourceLineResolution): boolean {
  return (line.lineRole === "expense" || line.lineRole === "payable")
    && ((line.direction === "debit" && line.flow === "outgoing")
      || (line.direction === "credit" && line.flow === "incoming"));
}
