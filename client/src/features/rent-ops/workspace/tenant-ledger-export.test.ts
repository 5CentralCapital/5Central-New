import assert from "node:assert/strict";
import test from "node:test";
import { tenantLedgerExportCsv } from "./tenant-ledger-export-model";
import type { TenantLedgerRow } from "./tenant-model";
test("tenant CSV exports inclusive property slice while retaining the full account running balance", () => {
  const rows = [
    { transaction: { propertyId: "p1" }, date: "2026-08-31", description: "Before range", runningBalanceCents: 10000 },
    { transaction: { propertyId: "p1" }, date: "2026-09-01", description: "First day", chargeCents: 20000, runningBalanceCents: 30000 },
    { transaction: { propertyId: "p1" }, date: "2026-09-10", description: "Last day", paymentCents: 5000, runningBalanceCents: 25000 },
    { transaction: { propertyId: "p2" }, date: "2026-09-10", description: "Other property", runningBalanceCents: null },
  ] as TenantLedgerRow[];
  const csv = tenantLedgerExportCsv(rows, "Resident", "One", "2026-09-01", "2026-09-10", "", ["p1"]);
  assert.match(csv, /5Central Capital/); assert.match(csv, /First day/); assert.match(csv, /Last day/);
  assert.doesNotMatch(csv, /Before range|Other property/); assert.match(csv, /"300"/); assert.match(csv, /"250"/);
  const all = tenantLedgerExportCsv(rows, "Resident", "All", "", "", "", []);
  assert.match(all, /Before range/); assert.match(all, /Needs review/);
});
