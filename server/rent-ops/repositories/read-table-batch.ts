import { HISTORICAL_LEASING_SNAPSHOT_SCHEMA } from "../../../shared/rent-ops-dashboard";

/** Fixed read-only operational catalog. Restricted source/history tables cannot enter this path. */
export const RENT_OPS_BATCH_TABLES = [
  "rent_ops_properties", "rent_ops_units", "rent_ops_people", "rent_ops_tenancies",
  "rent_ops_household_memberships", "rent_ops_lease_terms", "rent_ops_charge_definitions",
  "rent_ops_recurring_charge_schedules", "rent_ops_ledger_transactions", "rent_ops_payment_allocations",
  "rent_ops_security_deposits", "rent_ops_subsidy_contracts", "rent_ops_subsidy_tenants", "rent_ops_subsidy_payments",
  "rent_ops_applications", "rent_ops_application_household_members", "rent_ops_application_requirements",
  "rent_ops_documents", "rent_ops_activity_events",
] as const;
export type RentOpsBatchTable = typeof RENT_OPS_BATCH_TABLES[number];
export type RentOpsTableRows = Record<string, Record<string, unknown>[]>;
const allowedTables = new Set<string>(RENT_OPS_BATCH_TABLES);
// node-postgres decodes these timestamptz columns to Date objects. JSON SQL
// aggregation returns ISO text instead; restore the same top-level driver shape.
// Do not recurse into application answers or other user JSON.
const timestampColumns = new Set([
  "created_at", "updated_at", "ended_at", "resume_token_expires_at", "uploaded_at",
  "verified_at", "occurred_at", "source_updated_at",
]);

export function buildRentOpsTableBatchSql(tables: readonly string[]): string {
  if (!tables.length || tables.length > RENT_OPS_BATCH_TABLES.length || new Set(tables).size !== tables.length || tables.some(table => !allowedTables.has(table))) {
    throw new Error("Invalid Rent Operations table batch");
  }
  // One SELECT means one statement snapshot without opening a separate transaction.
  // Like the legacy SELECT *, aggregation retains the table scan's row order;
  // neither path promises an ORDER BY that the underlying reads never had.
  return `SELECT ${tables.map(table => `COALESCE((SELECT json_agg(row_to_json(r)) FROM ${table} AS r), '[]'::json) AS ${table}`).join(", ")}`;
}

export function decodeRentOpsTableBatch(value: unknown, tables: readonly string[]): RentOpsTableRows {
  buildRentOpsTableBatchSql(tables);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Rent Operations table batch result");
  const result: RentOpsTableRows = {};
  for (const table of tables) {
    let rows = (value as Record<string, unknown>)[table];
    // Drivers ordinarily parse json OIDs already. The string case supports
    // compatible executors with explicitly disabled JSON type parsing.
    if (typeof rows === "string") rows = JSON.parse(rows);
    if (!Array.isArray(rows)) throw new Error("Invalid Rent Operations table batch result");
    result[table] = rows.map(row => {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Invalid Rent Operations table batch row");
      const restored = {...row} as Record<string, unknown>;
      for (const column of Array.from(timestampColumns)) {
        const timestamp = restored[column];
        if (timestamp === null || timestamp === undefined || timestamp instanceof Date) continue;
        if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) throw new Error("Invalid Rent Operations table batch timestamp");
        restored[column] = new Date(timestamp);
      }
      return restored;
    });
  }
  return result;
}

/** Fixed report projection. No caller filters or identifiers enter this SQL. */
export const RENT_OPS_REPORT_TABLES = RENT_OPS_BATCH_TABLES.filter(table => table !== "rent_ops_documents");
export function buildRentOpsReportBatchSql(): string {
  return `SELECT ${RENT_OPS_REPORT_TABLES.map(table => {
    // Reports need the narrow balance-review activity set plus immutable
    // historical leasing observations.  The domain parser applies the exact
    // JSON schema; this LIKE only keeps those direct bodies in the snapshot
    // without admitting the full activity stream to financial reports.
    const predicate = table === "rent_ops_activity_events" ? ` WHERE type IN ('promise_to_pay', 'hold') OR (type = 'note' AND detail LIKE '%balance_review_v1%') OR (type = 'system' AND detail LIKE '%${HISTORICAL_LEASING_SNAPSHOT_SCHEMA}%')` : "";
    return `COALESCE((SELECT json_agg(row_to_json(r)) FROM ${table} AS r${predicate}), '[]'::json) AS ${table}`;
  }).join(", ")}`;
}
