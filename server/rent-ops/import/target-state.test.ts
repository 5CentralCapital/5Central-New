import assert from "node:assert/strict";
import test from "node:test";
import { RENT_OPS_REQUIRED_TABLES } from "../persistence";
import { RENT_OPS_APPLICATION_TABLES } from "../security/deployment-security";
import type { RentOpsQueryExecutor } from "../repositories/postgres";
import {
  assertEmptyRentOpsTargetState,
  assertIdenticalRentOpsTargetState,
  captureRentOpsTargetState,
  RENT_OPS_TARGET_STATE_IDENTITY_COLUMNS,
  RENT_OPS_TARGET_STATE_TABLES,
  RentOpsTargetStateError,
  restoreRequired,
} from "./target-state";

class FixtureExecutor implements RentOpsQueryExecutor {
  constructor(readonly data: Record<string, Array<Record<string, unknown>>>, readonly transactional = true) {}

  async query<T = Record<string, unknown>>(text: string): Promise<{ rows: T[] }> {
    const table = RENT_OPS_TARGET_STATE_TABLES.find((candidate) => text.includes(`FROM ${candidate} AS t`));
    if (!table) throw new Error("unexpected query");
    return { rows: (this.data[table] ?? []).map((row) => ({ row })) as T[] };
  }

  transaction = async <T>(work: (executor: RentOpsQueryExecutor) => Promise<T>, options?: { readOnly?: boolean }): Promise<T> => {
    if (!this.transactional) throw new Error("transactions disabled");
    assert.equal(options?.readOnly, true);
    return work(this);
  };
}

function fixture(overrides: Record<string, Array<Record<string, unknown>>> = {}): Record<string, Array<Record<string, unknown>>> {
  return Object.fromEntries(RENT_OPS_TARGET_STATE_TABLES.map((table) => [table, overrides[table] ?? []]));
}

test("target state covers RM tables and excludes migration ledgers and application-only tables", async () => {
  assert.deepEqual(new Set(RENT_OPS_TARGET_STATE_TABLES), new Set(Object.keys(RENT_OPS_TARGET_STATE_IDENTITY_COLUMNS)));
  const state = await captureRentOpsTargetState(new FixtureExecutor(fixture()));
  assert.equal(state.rowCount, 0);
  for (const table of RENT_OPS_APPLICATION_TABLES) assert.equal(state.tables.some(row => row.table === table), false);
  assert.equal(state.tables.length, RENT_OPS_REQUIRED_TABLES.length - 2 - RENT_OPS_APPLICATION_TABLES.length);
  assert.equal(state.tables.some((table) => table.table === "rent_ops_schema_meta"), false);
  assert.equal(state.tables.some((table) => table.table === "rent_ops_schema_migrations"), false);
  assert.equal(RENT_OPS_TARGET_STATE_IDENTITY_COLUMNS.rent_ops_charge_definitions, "id");
  assert.equal(RENT_OPS_TARGET_STATE_IDENTITY_COLUMNS.rent_ops_financial_semantic_crosswalks, "id");
  assert.equal(state.tables.some((table) => table.table === "rent_ops_charge_definitions"), true);
  assert.equal(state.tables.some((table) => table.table === "rent_ops_financial_semantic_crosswalks"), true);
  assertEmptyRentOpsTargetState(state);
});

test("target state orders verified document bindings by document_id", async () => {
  const state = await captureRentOpsTargetState(new FixtureExecutor(fixture({
    rent_ops_document_objects: [
      { document_id: "document-b", checksum_sha256: "b".repeat(64), size_bytes: 2 },
      { document_id: "document-a", checksum_sha256: "a".repeat(64), size_bytes: 1 },
    ],
  })));
  const documentObjects = state.tables.find((table) => table.table === "rent_ops_document_objects");
  assert.equal(documentObjects?.rowCount, 2);
  assert.equal(documentObjects?.orderedRowsSha256, state.tables.find((table) => table.table === "rent_ops_document_objects")?.orderedRowsSha256);
});

test("target state is order-independent and includes exact money controls", async () => {
  const left = await captureRentOpsTargetState(new FixtureExecutor(fixture({
    rent_ops_ledger_transactions: [
      { id: "ledger-b", amount_cents: "2500", description: "private-two" },
      { id: "ledger-a", amount_cents: -500, description: "private-one" },
    ],
    rent_ops_security_deposits: [{ id: "deposit-a", amount_held_cents: 125000 }],
  })));
  const right = await captureRentOpsTargetState(new FixtureExecutor(fixture({
    rent_ops_ledger_transactions: [
      { id: "ledger-a", amount_cents: -500, description: "private-one" },
      { id: "ledger-b", amount_cents: "2500", description: "private-two" },
    ],
    rent_ops_security_deposits: [{ id: "deposit-a", amount_held_cents: 125000 }],
  })));
  assertIdenticalRentOpsTargetState(left, right);
  assert.equal(left.tables.find((table) => table.table === "rent_ops_ledger_transactions")?.moneyTotals.amount_cents, "2000");
  assert.equal(left.tables.find((table) => table.table === "rent_ops_security_deposits")?.moneyTotals.amount_held_cents, "125000");
  assert.throws(() => assertEmptyRentOpsTargetState(left), (error: unknown) => error instanceof RentOpsTargetStateError && error.reasons.includes("target_not_empty"));
});

test("true database-state idempotency detects stale, removed, and altered rows", async () => {
  const before = await captureRentOpsTargetState(new FixtureExecutor(fixture({
    rent_ops_properties: [{ id: "property-a", name: "A" }],
  })));
  const altered = await captureRentOpsTargetState(new FixtureExecutor(fixture({
    rent_ops_properties: [{ id: "property-a", name: "B" }],
  })));
  const extra = await captureRentOpsTargetState(new FixtureExecutor(fixture({
    rent_ops_properties: [{ id: "property-a", name: "A" }, { id: "stale-row", name: "stale" }],
  })));
  assert.throws(() => assertIdenticalRentOpsTargetState(before, altered), (error: unknown) => error instanceof RentOpsTargetStateError && error.reasons.includes("target_state_digest_changed"));
  assert.throws(() => assertIdenticalRentOpsTargetState(before, extra), (error: unknown) => error instanceof RentOpsTargetStateError && error.reasons.includes("target_state_row_count_changed"));
});

test("capture fails closed without a coherent transaction or with unsafe row shapes", async () => {
  const noTransaction = new FixtureExecutor(fixture());
  noTransaction.transaction = undefined as unknown as FixtureExecutor["transaction"];
  await assert.rejects(() => captureRentOpsTargetState(noTransaction), (error: unknown) => error instanceof RentOpsTargetStateError && error.reasons.includes("target_state_transaction_required"));
  await assert.rejects(
    () => captureRentOpsTargetState(new FixtureExecutor(fixture({ rent_ops_people: [{ id: "duplicate" }, { id: "duplicate" }] }))),
    (error: unknown) => error instanceof RentOpsTargetStateError && error.reasons.includes("target_row_identity_duplicate"),
  );
  await assert.rejects(
    () => captureRentOpsTargetState(new FixtureExecutor(fixture({ rent_ops_ledger_transactions: [{ id: "ledger-a", amount_cents: "1.2" }] }))),
    (error: unknown) => error instanceof RentOpsTargetStateError && error.reasons.includes("target_money_value_invalid"),
  );
});

test("restore-required evidence is redacted and binds pre/post database digests", async () => {
  const before = await captureRentOpsTargetState(new FixtureExecutor(fixture()));
  const after = await captureRentOpsTargetState(new FixtureExecutor(fixture({ rent_ops_properties: [{ id: "property-a", name: "private" }] })));
  const result = restoreRequired("audit_failed", before, after);
  assert.deepEqual(Object.keys(result).sort(), ["observedTablesSha256", "preApplyTablesSha256", "safeReason", "status"]);
  assert.equal(result.status, "restore_required");
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(restoreRequired("unsafe tenant detail\n", before).safeReason, "postcommit_audit_failed");
});
