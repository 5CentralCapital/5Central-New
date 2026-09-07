import assert from "node:assert/strict";
import test from "node:test";
import type { RentOpsQueryExecutor } from "./repositories/postgres";
import {
  createRentOpsPoolExecutor,
  createRentOpsRuntimeDatabase,
  type RentOpsRuntimePool,
} from "./runtime-database";

class FakePool implements RentOpsRuntimePool {
  readonly poolCalls: string[] = [];
  readonly clientCalls: string[] = [];
  readonly rows: Record<string, unknown>[] = [{ ok: true }];
  released = 0;
  ended = 0;
  failWithSecret = false;

  async query<T = Record<string, unknown>>(text: string): Promise<{ rows: T[] }> {
    this.poolCalls.push(text);
    return { rows: this.rows as T[] };
  }

  async connect() {
    return {
      query: async <T = Record<string, unknown>>(text: string): Promise<{ rows: T[] }> => {
        this.clientCalls.push(text);
        if (this.failWithSecret && text === "SELECT secret") throw new Error("postgres://runtime-secret@db.invalid/rent_ops");
        return { rows: this.rows as T[] };
      },
      release: () => { this.released += 1; },
    };
  }

  async end(): Promise<void> { this.ended += 1; }
}

test("production requires the dedicated runtime credential and ignores the host credential", async () => {
  let poolFactoryCalls = 0;
  const hostSecret = "postgres://host-secret@db.invalid/host";
  await assert.rejects(
    () => createRentOpsRuntimeDatabase({
      environment: "production",
      env: { NODE_ENV: "production", DATABASE_URL: hostSecret },
      poolFactory: async () => { poolFactoryCalls += 1; return new FakePool(); },
    }),
    (error: unknown) => {
      assert.equal(poolFactoryCalls, 0);
      assert.equal(error instanceof Error && error.message.includes(hostSecret), false);
      assert.match(error instanceof Error ? error.message : String(error), /RENT_OPS_RUNTIME_DATABASE_URL/);
      return true;
    },
  );
});

test("a shared executor is only accepted when explicitly injected outside production", async () => {
  let poolFactoryCalls = 0;
  const shared: RentOpsQueryExecutor = { query: async () => ({ rows: [{ source: "shared" }] }) };
  const executor = await createRentOpsRuntimeDatabase({
    environment: "test",
    env: { NODE_ENV: "test", DATABASE_URL: "postgres://must-not-be-read@db.invalid/host" },
    sharedExecutor: shared,
    poolFactory: async () => { poolFactoryCalls += 1; return new FakePool(); },
  });
  assert.deepEqual((await executor.query("SELECT 1")).rows, [{ source: "shared" }]);
  await executor.close();
  assert.equal(poolFactoryCalls, 0);

  await assert.rejects(
    () => createRentOpsRuntimeDatabase({
      environment: "production",
      sharedExecutor: shared,
      env: { NODE_ENV: "production" },
    }),
    /RENT_OPS_RUNTIME_DATABASE_URL/,
  );
});

test("dedicated pool construction happens only after URL validation", async () => {
  const invalidCalls: string[] = [];
  await assert.rejects(
    () => createRentOpsRuntimeDatabase({
      environment: "production",
      env: { RENT_OPS_RUNTIME_DATABASE_URL: "not-a-postgres-url" },
      poolFactory: async (connectionString) => { invalidCalls.push(connectionString); return new FakePool(); },
    }),
    /RENT_OPS_RUNTIME_DATABASE_URL is invalid/,
  );
  assert.deepEqual(invalidCalls, []);

  const connectionString = "postgresql://runtime-secret@db.invalid/rent_ops";
  const pool = new FakePool();
  const received: string[] = [];
  const executor = await createRentOpsRuntimeDatabase({
    environment: "production",
    env: { RENT_OPS_RUNTIME_DATABASE_URL: connectionString },
    poolFactory: async (value) => { received.push(value); return pool; },
  });
  assert.deepEqual(received, [connectionString]);
  assert.deepEqual((await executor.query<{ ok: boolean }>("SELECT 1")).rows, [{ ok: true }]);
  await executor.close();
  assert.equal(pool.ended, 1);
});

test("pool executor provides repeatable-read atomic transactions with read-only mode", async () => {
  const pool = new FakePool();
  const executor = createRentOpsPoolExecutor(pool);
  const result = await executor.transaction(async (transactionExecutor) => {
    const rows = await transactionExecutor.query<{ ok: boolean }>("SELECT 1");
    return rows.rows[0]?.ok;
  }, { readOnly: true });
  assert.equal(result, true);
  assert.deepEqual(pool.clientCalls, [
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "SELECT 1",
    "COMMIT",
  ]);
  assert.equal(pool.released, 1);
});

test("driver errors are redacted and transactions roll back", async () => {
  const pool = new FakePool();
  pool.failWithSecret = true;
  const executor = createRentOpsPoolExecutor(pool);
  await assert.rejects(
    () => executor.transaction(async (transactionExecutor) => {
      await transactionExecutor.query("SELECT secret");
    }),
    (error: unknown) => {
      assert.equal(error instanceof Error && error.message.includes("runtime-secret"), false);
      assert.equal(error instanceof Error && error.message.includes("postgres://"), false);
      assert.match(error instanceof Error ? error.message : String(error), /database operation failed/);
      return true;
    },
  );
  assert.deepEqual(pool.clientCalls, [
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ",
    "SELECT secret",
    "ROLLBACK",
  ]);
  assert.equal(pool.released, 1);
});

test("pool initialization errors are redacted", async () => {
  const secret = "postgres://initialization-secret@db.invalid/rent_ops";
  await assert.rejects(
    () => createRentOpsRuntimeDatabase({
      environment: "production",
      env: { RENT_OPS_RUNTIME_DATABASE_URL: secret },
      poolFactory: async () => { throw new Error(`failed to connect using ${secret}`); },
    }),
    (error: unknown) => {
      assert.equal(error instanceof Error && error.message.includes(secret), false);
      assert.equal(error instanceof Error && error.message.includes("initialization-secret"), false);
      assert.match(error instanceof Error ? error.message : String(error), /could not be initialized/);
      return true;
    },
  );
});
