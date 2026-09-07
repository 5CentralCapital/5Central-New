import { canonicalJson, sha256 } from "../export/hash";
import { RENT_OPS_REQUIRED_TABLES } from "../persistence";
import { RENT_OPS_APPLICATION_TABLES } from "../security/deployment-security";
import type { RentOpsQueryExecutor } from "../repositories/postgres";

export const RENT_OPS_TARGET_STATE_VERSION = "rent-ops-target-state/v1" as const;

const SCHEMA_TABLES = new Set(["rent_ops_schema_meta", "rent_ops_schema_migrations"]);
const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,160}$/;
const MAX_ROWS = 750_000;
const MAX_CANONICAL_BYTES = 512 * 1024 * 1024;

/** RM target tables only; application accounts, receipts and counters are outside importer access. */
export const RENT_OPS_TARGET_STATE_TABLES = RENT_OPS_REQUIRED_TABLES.filter((table) => !SCHEMA_TABLES.has(table) && !(RENT_OPS_APPLICATION_TABLES as readonly string[]).includes(table));

/**
 * The target-state query must order by the actual primary-key column of each
 * table.  The verified-document binding is keyed by document_id; all other
 * current business/restricted tables use id.  Keep this allowlist exhaustive
 * so a newly required table cannot silently fall back to an unsafe query.
 */
export const RENT_OPS_TARGET_STATE_IDENTITY_COLUMNS = {
  rent_ops_properties: "id",
  rent_ops_units: "id",
  rent_ops_people: "id",
  rent_ops_tenancies: "id",
  rent_ops_household_memberships: "id",
  rent_ops_lease_terms: "id",
  rent_ops_charge_definitions: "id",
  rent_ops_recurring_charge_schedules: "id",
  rent_ops_ledger_transactions: "id",
  rent_ops_payment_allocations: "id",
  rent_ops_security_deposits: "id",
  rent_ops_subsidy_contracts: "id",
  rent_ops_subsidy_tenants: "id",
  rent_ops_subsidy_payments: "id",
  rent_ops_applications: "id",
  rent_ops_application_household_members: "id",
  rent_ops_application_requirements: "id",
  rent_ops_documents: "id",
  rent_ops_document_objects: "document_id",
  rent_ops_activity_events: "id",
  rent_ops_record_changes: "id",
  rent_ops_source_records: "id",
  rent_ops_import_runs: "id",
  rent_ops_source_payloads: "id",
  rent_ops_source_binaries: "id",
  rent_ops_restricted_parity_observations: "id",
  rent_ops_restricted_parity_collection_occurrences: "id",
  rent_ops_restricted_parity_row_occurrences: "id",
  rent_ops_financial_semantic_crosswalks: "id",
  rent_ops_prospects: "id",
  rent_ops_application_history: "id",
  rent_ops_application_interests: "id",
  rent_ops_application_participants: "id",
  rent_ops_application_requirement_occurrences: "id",
  rent_ops_application_template_definitions: "id",
  rent_ops_application_template_sections: "id",
  rent_ops_application_template_fields: "id",
  rent_ops_application_answer_occurrences: "id",
  rent_ops_application_history_documents: "id",
  rent_ops_application_history_activities: "id",
  rent_ops_application_history_blockers: "id",
  rent_ops_application_history_aggregates: "id",
} as const;

const missingIdentityColumns = RENT_OPS_TARGET_STATE_TABLES.filter((table) => !(table in RENT_OPS_TARGET_STATE_IDENTITY_COLUMNS));
if (missingIdentityColumns.length > 0) throw new Error("Rent Operations target-state identity inventory is incomplete");

const MONEY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  rent_ops_units: ["market_rent_cents", "default_deposit_cents"],
  rent_ops_recurring_charge_schedules: ["amount_cents"],
  rent_ops_ledger_transactions: ["amount_cents"],
  rent_ops_payment_allocations: ["amount_cents"],
  rent_ops_security_deposits: ["amount_held_cents"],
  rent_ops_subsidy_contracts: ["agency_obligation_cents", "tenant_obligation_cents"],
  rent_ops_subsidy_tenants: ["amount_cents"],
  rent_ops_subsidy_payments: ["amount_cents"],
  rent_ops_application_interests: ["rent_cents"],
};

export interface RentOpsTargetTableState {
  table: string;
  rowCount: number;
  orderedRowsSha256: string;
  canonicalBytes: number;
  moneyTotals: Readonly<Record<string, string>>;
}

export interface RentOpsTargetState {
  version: typeof RENT_OPS_TARGET_STATE_VERSION;
  rowCount: number;
  canonicalBytes: number;
  tablesSha256: string;
  tables: readonly RentOpsTargetTableState[];
}

export class RentOpsTargetStateError extends Error {
  readonly reasons: string[];

  constructor(reasons: readonly string[]) {
    const safe = Array.from(new Set(reasons.map((reason) => SAFE_CODE.test(reason) ? reason : "target_state_failed"))).sort();
    super(`Rent Operations target-state proof failed: ${safe.join("; ")}`);
    this.name = "RentOpsTargetStateError";
    this.reasons = safe;
  }
}

function rowObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RentOpsTargetStateError(["target_row_shape_invalid"]);
  return value as Record<string, unknown>;
}

function rowId(row: Record<string, unknown>, identityColumn: string): string {
  const value = row[identityColumn];
  if (typeof value !== "string" || value.length === 0 || value.length > 500 || /[\u0000\r\n]/.test(value)) {
    throw new RentOpsTargetStateError(["target_row_identity_invalid"]);
  }
  return value;
}

function cents(value: unknown): bigint {
  if (value === null || value === undefined || value === "") return BigInt(0);
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  throw new RentOpsTargetStateError(["target_money_value_invalid"]);
}

function tableState(table: string, rawRows: readonly unknown[]): RentOpsTargetTableState {
  const identityColumn = RENT_OPS_TARGET_STATE_IDENTITY_COLUMNS[table as keyof typeof RENT_OPS_TARGET_STATE_IDENTITY_COLUMNS];
  if (!identityColumn) throw new RentOpsTargetStateError(["target_state_identity_column_missing"]);
  const rows = rawRows.map(rowObject).sort((left, right) => rowId(left, identityColumn).localeCompare(rowId(right, identityColumn)));
  for (let index = 1; index < rows.length; index += 1) {
    if (rowId(rows[index - 1], identityColumn) === rowId(rows[index], identityColumn)) throw new RentOpsTargetStateError(["target_row_identity_duplicate"]);
  }
  let canonicalBytes = 0;
  const rowHashes = rows.map((row) => {
    const canonical = canonicalJson(row);
    canonicalBytes += Buffer.byteLength(canonical, "utf8");
    return sha256(canonical);
  });
  const moneyTotals: Record<string, string> = {};
  for (const column of MONEY_COLUMNS[table] ?? []) {
    moneyTotals[column] = rows.reduce((total, row) => total + cents(row[column]), BigInt(0)).toString();
  }
  return {
    table,
    rowCount: rows.length,
    orderedRowsSha256: sha256(canonicalJson(rowHashes)),
    canonicalBytes,
    moneyTotals,
  };
}

async function capture(executor: RentOpsQueryExecutor): Promise<RentOpsTargetState> {
  const tables: RentOpsTargetTableState[] = [];
  let rowCount = 0;
  let canonicalBytes = 0;
  for (const table of RENT_OPS_TARGET_STATE_TABLES) {
    let result: { rows: Array<{ row?: unknown }> };
    try {
      // Table names come only from the compile-time allowlist above. JSONB is
      // kept inside this process and is reduced immediately to redacted hashes.
      const identityColumn = RENT_OPS_TARGET_STATE_IDENTITY_COLUMNS[table as keyof typeof RENT_OPS_TARGET_STATE_IDENTITY_COLUMNS];
      if (!identityColumn) throw new RentOpsTargetStateError(["target_state_identity_column_missing"]);
      result = await executor.query<{ row?: unknown }>(`SELECT to_jsonb(t) AS row FROM ${table} AS t ORDER BY ${identityColumn}`);
    } catch {
      throw new RentOpsTargetStateError(["target_state_query_failed"]);
    }
    const state = tableState(table, result.rows.map((entry) => entry.row));
    rowCount += state.rowCount;
    canonicalBytes += state.canonicalBytes;
    if (rowCount > MAX_ROWS) throw new RentOpsTargetStateError(["target_state_row_limit_exceeded"]);
    if (canonicalBytes > MAX_CANONICAL_BYTES) throw new RentOpsTargetStateError(["target_state_byte_limit_exceeded"]);
    tables.push(state);
  }
  const tableControls = tables.map(({ table, rowCount: count, orderedRowsSha256, moneyTotals }) => ({ table, rowCount: count, orderedRowsSha256, moneyTotals }));
  return {
    version: RENT_OPS_TARGET_STATE_VERSION,
    rowCount,
    canonicalBytes,
    tablesSha256: sha256(canonicalJson(tableControls)),
    tables,
  };
}

/** Capture one coherent, read-only fingerprint of every imported table. */
export async function captureRentOpsTargetState(executor: RentOpsQueryExecutor): Promise<RentOpsTargetState> {
  if (typeof executor.transaction !== "function") throw new RentOpsTargetStateError(["target_state_transaction_required"]);
  try {
    return await executor.transaction((transactionExecutor) => capture(transactionExecutor), { readOnly: true });
  } catch (error) {
    if (error instanceof RentOpsTargetStateError) throw error;
    throw new RentOpsTargetStateError(["target_state_capture_failed"]);
  }
}

/** First full import may run only against a business-empty/disposable target. */
export function assertEmptyRentOpsTargetState(state: RentOpsTargetState): void {
  if (state.version !== RENT_OPS_TARGET_STATE_VERSION || !hasExpectedTableSet(state)) {
    throw new RentOpsTargetStateError(["target_state_shape_invalid"]);
  }
  const nonEmpty = state.tables.reduce((count, table) => count + (table.rowCount > 0 ? 1 : 0), 0);
  if (state.rowCount !== 0 || nonEmpty !== 0) throw new RentOpsTargetStateError(["target_not_empty"]);
}

/** A second import is idempotent only when the database itself is unchanged. */
export function assertIdenticalRentOpsTargetState(before: RentOpsTargetState, after: RentOpsTargetState): void {
  const reasons: string[] = [];
  if (before.version !== RENT_OPS_TARGET_STATE_VERSION || after.version !== RENT_OPS_TARGET_STATE_VERSION) reasons.push("target_state_version_mismatch");
  if (!hasExpectedTableSet(before) || !hasExpectedTableSet(after)) reasons.push("target_state_table_set_mismatch");
  if (before.rowCount !== after.rowCount) reasons.push("target_state_row_count_changed");
  if (before.canonicalBytes !== after.canonicalBytes) reasons.push("target_state_canonical_bytes_changed");
  if (before.tablesSha256 !== after.tablesSha256) reasons.push("target_state_digest_changed");
  if (before.tables.length !== RENT_OPS_TARGET_STATE_TABLES.length || after.tables.length !== RENT_OPS_TARGET_STATE_TABLES.length) reasons.push("target_state_table_count_mismatch");
  if (reasons.length > 0) throw new RentOpsTargetStateError(reasons);
}

function hasExpectedTableSet(state: RentOpsTargetState): boolean {
  if (!Array.isArray(state.tables) || state.tables.length !== RENT_OPS_TARGET_STATE_TABLES.length) return false;
  const actual = state.tables.map((table) => table.table).sort();
  const expected = [...RENT_OPS_TARGET_STATE_TABLES].sort();
  return actual.every((table, index) => table === expected[index]);
}

export interface RentOpsRestoreRequirement {
  status: "restore_required";
  safeReason: string;
  preApplyTablesSha256: string;
  observedTablesSha256?: string;
}

/** Redacted, explicit state for any post-commit audit failure. */
export function restoreRequired(
  reason: string,
  preApply: RentOpsTargetState,
  observed?: RentOpsTargetState,
): RentOpsRestoreRequirement {
  return {
    status: "restore_required",
    safeReason: SAFE_CODE.test(reason) ? reason : "postcommit_audit_failed",
    preApplyTablesSha256: preApply.tablesSha256,
    ...(observed ? { observedTablesSha256: observed.tablesSha256 } : {}),
  };
}
