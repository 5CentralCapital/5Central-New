import { buildRentOpsTableBatchSql, decodeRentOpsTableBatch } from "./repositories/read-table-batch";
import type { RentOpsQueryExecutor } from "./repositories/postgres";

/**
 * The Rent Operations web runtime is intentionally isolated from the host
 * application's database pool.  Keeping this boundary small makes it
 * possible to grant the web process only the permissions it needs while
 * retaining an explicit dependency seam for tests and local development.
 */

export interface RentOpsRuntimePoolClient {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  release(): void;
}

export interface RentOpsRuntimePool {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  connect(): Promise<RentOpsRuntimePoolClient>;
  end?(): Promise<void>;
}

export type RentOpsRuntimePoolFactory = (connectionString: string) => RentOpsRuntimePool | Promise<RentOpsRuntimePool>;

export interface RentOpsRuntimeDatabaseOptions {
  /** Explicit dependency seam. It is accepted only outside production. */
  sharedExecutor?: RentOpsQueryExecutor;
  /** Injectable environment for tests; production uses the process environment. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Injectable environment name for tests. */
  environment?: string;
  /** Injectable pool construction seam; production dynamically loads Neon. */
  poolFactory?: RentOpsRuntimePoolFactory;
}

export type RentOpsRuntimeDatabase = RentOpsQueryExecutor & { close(): Promise<void> };

export class RentOpsRuntimeDatabaseError extends Error {
  readonly code = "rent_ops_runtime_database_error";

  constructor(message: string) {
    super(message);
    this.name = "RentOpsRuntimeDatabaseError";
  }
}

/** Safe retry signal only; never retains database diagnostics or credentials. */
export class RentOpsRetryableConflict extends Error {
  readonly code = "rent_ops_retryable_conflict";
  readonly status = 409;
  constructor() { super("Rent Operations changed concurrently; retry the same request"); this.name = "RentOpsRetryableConflict"; }
}

const MISSING_CREDENTIAL_MESSAGE = "RENT_OPS_RUNTIME_DATABASE_URL must be configured for the Rent Operations runtime";
const INVALID_CREDENTIAL_MESSAGE = "RENT_OPS_RUNTIME_DATABASE_URL is invalid";
const INITIALIZATION_MESSAGE = "Rent Operations runtime database could not be initialized";
const OPERATION_MESSAGE = "Rent Operations database operation failed";

function configurationError(message: string): RentOpsRuntimeDatabaseError {
  return new RentOpsRuntimeDatabaseError(message);
}

function validatedConnectionString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw configurationError(INVALID_CREDENTIAL_MESSAGE);
  }
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") || !parsed.hostname) {
      throw new Error("unsupported connection string");
    }
  } catch {
    throw configurationError(INVALID_CREDENTIAL_MESSAGE);
  }
  return value;
}

function redactedOperationError(): RentOpsRuntimeDatabaseError {
  return new RentOpsRuntimeDatabaseError(OPERATION_MESSAGE);
}

async function safeQuery<T>(
  query: (text: string, values?: unknown[]) => Promise<{ rows: T[] }>,
  text: string,
  values?: unknown[],
): Promise<{ rows: T[] }> {
  try {
    return await query(text, values);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "40001") throw new RentOpsRetryableConflict();
    // Do not retain the driver error as `cause`: connection errors can embed
    // a full connection string or other credential-bearing diagnostics.
    throw redactedOperationError();
  }
}

/** Adapt a pool to the narrow executor consumed by the Rent Operations repository. */
export function createRentOpsPoolExecutor(pool: RentOpsRuntimePool): RentOpsRuntimeDatabase {
  const executor: RentOpsRuntimeDatabase = {
    async query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
      const result = await safeQuery<Record<string, unknown>>(pool.query.bind(pool), text, values);
      return { rows: result.rows as T[] };
    },

    async readTableBatch(tables) {
      // Validation happens before issuing SQL; identifiers come only from the fixed catalog.
      const sql = buildRentOpsTableBatchSql(tables);
      const result = await safeQuery<Record<string, unknown>>(pool.query.bind(pool), sql);
      try {
        if (result.rows.length !== 1) throw new Error("Invalid table batch envelope");
        return decodeRentOpsTableBatch(result.rows[0], tables);
      } catch { throw redactedOperationError(); }
    },

    async transaction<T>(
      work: (executor: RentOpsQueryExecutor) => Promise<T>,
      options: { readOnly?: boolean } = {},
    ): Promise<T> {
      let client: RentOpsRuntimePoolClient;
      try {
        client = await pool.connect();
      } catch {
        throw redactedOperationError();
      }

      const transactionExecutor: RentOpsQueryExecutor = {
        async query<Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: Row[] }> {
          const result = await safeQuery<Record<string, unknown>>(client.query.bind(client), text, values);
          return { rows: result.rows as Row[] };
        },
      };
      let began = false;
      try {
        await safeQuery(client.query.bind(client), `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ${options.readOnly ? " READ ONLY" : ""}`);
        began = true;
        const result = await work(transactionExecutor);
        await safeQuery(client.query.bind(client), "COMMIT");
        return result;
      } catch (error) {
        if (began) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // Preserve the original, already-redacted operation or application
            // error. Rollback diagnostics must not escape this boundary.
          }
        }
        throw error;
      } finally {
        client.release();
      }
    },

    close: async () => {
      if (!pool.end) return;
      try {
        await pool.end();
      } catch {
        throw redactedOperationError();
      }
    },
  };
  return executor;
}

async function createNeonPool(connectionString: string): Promise<RentOpsRuntimePool> {
  try {
    const [{ Pool, neonConfig }, wsModule] = await Promise.all([
      import("@neondatabase/serverless"),
      import("ws"),
    ]);
    neonConfig.webSocketConstructor = wsModule.default;
    return new Pool({ connectionString }) as unknown as RentOpsRuntimePool;
  } catch {
    throw new RentOpsRuntimeDatabaseError(INITIALIZATION_MESSAGE);
  }
}

/**
 * Create the dedicated Rent Operations web executor.
 *
 * Production deliberately has no shared-pool fallback. In development and
 * tests, a caller may pass an explicit shared executor, which keeps that
 * compromise visible at the call site instead of hidden in this factory.
 */
export async function createRentOpsRuntimeDatabase(
  options: RentOpsRuntimeDatabaseOptions = {},
): Promise<RentOpsRuntimeDatabase> {
  const env = options.env ?? process.env;
  const environment = options.environment ?? env.NODE_ENV ?? process.env.NODE_ENV ?? "development";
  if (options.sharedExecutor) {
    if (environment === "production") {
      throw configurationError(MISSING_CREDENTIAL_MESSAGE);
    }
    return { ...options.sharedExecutor, close: async () => {} };
  }

  const connectionString = validatedConnectionString(env.RENT_OPS_RUNTIME_DATABASE_URL);
  let pool: RentOpsRuntimePool;
  try {
    pool = options.poolFactory ? await options.poolFactory(connectionString) : await createNeonPool(connectionString);
  } catch (error) {
    if (error instanceof RentOpsRuntimeDatabaseError) throw error;
    throw new RentOpsRuntimeDatabaseError(INITIALIZATION_MESSAGE);
  }
  return createRentOpsPoolExecutor(pool);
}
