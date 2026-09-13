import { filterTenantLedger, type TenantLedgerRow } from "./tenant-model";
export function tenantLedgerExportCsv(rows: TenantLedgerRow[], name: string, propertyLabel: string, from: string, through: string, search: string, propertyIds: string[]) {
  // Preserve account running balances calculated before filtering; a property or date slice is not a new account.
  const selected = filterTenantLedger(rows, search, from, through).filter(row => !propertyIds.length || propertyIds.includes(row.transaction.propertyId ?? ""));
  const escape = (value: unknown) => '"' + String(value ?? "").replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""') + '"';
  const showReference = rows.some(row => Boolean(row.reference));
  return [["5Central Capital"], [`Tenant transactions · ${name}`], [propertyLabel], [from || through ? `From ${from || "beginning"} through ${through || "latest"} (inclusive)` : "All dates"], [],
    ["Date", "Property", "Unit", ...(showReference ? ["Reference"] : []), "Description", "Charge", "Payment or credit", "Account running balance", "Status"],
    ...selected.map(row => [row.date, row.propertyName, row.unitLabel, ...(showReference ? [row.reference] : []), row.description, row.chargeCents == null ? "" : row.chargeCents / 100, row.paymentCents == null ? "" : row.paymentCents / 100, row.runningBalanceCents == null ? "Needs review" : row.runningBalanceCents / 100, row.status])]
    .map(row => row.map(escape).join(",")).join("\r\n");
}
