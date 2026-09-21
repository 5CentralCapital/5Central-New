import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { ensureRentOpsSchema } from "../rent-ops/persistence";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import {
  attestTransport,
  loadAuthenticatedPrincipal,
  type AuthenticatedPrincipal,
} from "../company/authorization";
import type { CompanyScope } from "../../shared/company";
import { executeProjectCommand } from "./commands";

// This suite is deliberately opt-in. It must never discover or reuse the
// application/runtime database credentials.
const connectionString = process.env.ROPS_PROJECT_TEST_DATABASE_URL?.trim() || undefined;
const skipReason = process.env.NODE_ENV === "production"
  ? "real PostgreSQL project tests are disabled in production"
  : connectionString === undefined
    ? "set ROPS_PROJECT_TEST_DATABASE_URL to run real PostgreSQL project tests"
    : undefined;

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const LEGAL_ENTITY_ID = "20000000-0000-4000-8000-000000000001";
const PROPERTY_ID = "project-concurrency-property";
const ACTOR_ID = "project-concurrency-admin";
const PROJECT_ID = "50000000-0000-4000-8000-000000000001";
const SCOPE_ITEM_ID = "51000000-0000-4000-8000-000000000001";
const TASK_A_ID = "52000000-0000-4000-8000-000000000001";
const TASK_B_ID = "52000000-0000-4000-8000-000000000002";

const scope = {
  organizationId: ORGANIZATION_ID,
  legalEntityId: LEGAL_ENTITY_ID,
  propertyId: PROPERTY_ID,
} as CompanyScope;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

type QueryRows = Record<string, unknown>;

interface IsolatedDatabase {
  readonly schema: string;
  readonly executor: RentOpsQueryExecutor;
  query<T extends QueryRows = QueryRows>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

function scopedExecutor(pool: pg.Pool, schema: string): IsolatedDatabase["executor"] & { close(): Promise<void> } {
  const quotedSchema = quoteIdentifier(schema);
  const setSearchPath = async (client: pg.PoolClient): Promise<void> => {
    await client.query(`SET search_path TO ${quotedSchema}`);
    await client.query("SET statement_timeout = '15s'");
    await client.query("SET idle_in_transaction_session_timeout = '30s'");
  };
  const query = async <T = QueryRows>(text: string, values?: unknown[]): Promise<{ rows: T[] }> => {
    const client = await pool.connect();
    try {
      await setSearchPath(client);
      const result = await client.query<T>(text, values as unknown[] as never[]);
      return { rows: result.rows };
    } finally {
      client.release();
    }
  };
  const transaction = async <T>(work: (executor: RentOpsQueryExecutor) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await setSearchPath(client);
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const transactionExecutor: RentOpsQueryExecutor = {
        query: async <Row = QueryRows>(text: string, values?: unknown[]) => {
          const result = await client.query<Row>(text, values as unknown[] as never[]);
          return { rows: result.rows };
        },
      };
      const result = await work(transactionExecutor);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original failure; cleanup must not hide it.
      }
      throw error;
    } finally {
      client.release();
    }
  };
  return {
    query,
    transaction,
    close: async () => {
      await pool.end();
    },
  };
}

async function openIsolatedDatabase(): Promise<IsolatedDatabase> {
  assert.ok(connectionString, "ROPS_PROJECT_TEST_DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString, max: 8 });
  const schema = `rops_project_test_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const quotedSchema = quoteIdentifier(schema);
  try {
    const setup = await pool.connect();
    try {
      await setup.query(`CREATE SCHEMA ${quotedSchema}`);
      await setup.query(`SET search_path TO ${quotedSchema}`);
      await ensureRentOpsSchema({
        apply: true,
        // Query-less application intentionally applies the complete migration
        // chain in this newly created schema. No public/runtime schema is read.
        executor: async (statement) => { await setup.query(statement); },
      });
      await setup.query(
        `INSERT INTO company_organizations (id, name) VALUES ($1, 'Project concurrency test')`,
        [ORGANIZATION_ID],
      );
      await setup.query(
        `INSERT INTO company_legal_entities (id, organization_id, name, entity_type, currency)
         VALUES ($1, $2, 'Project concurrency LLC', 'llc', 'USD')`,
        [LEGAL_ENTITY_ID, ORGANIZATION_ID],
      );
      await setup.query(
        `INSERT INTO rent_ops_properties (id, name, slug)
         VALUES ($1, 'Project concurrency property', $1)`,
        [PROPERTY_ID],
      );
      await setup.query(
        `INSERT INTO company_property_entity_periods
          (id, organization_id, legal_entity_id, property_id, effective_from)
         VALUES ($1, $2, $3, $4, '2020-01-01')`,
        ["30000000-0000-4000-8000-000000000001", ORGANIZATION_ID, LEGAL_ENTITY_ID, PROPERTY_ID],
      );
      await setup.query(
        `INSERT INTO company_access_grants (id, organization_id, actor_id, role)
         VALUES ($1, $2, $3, 'admin')`,
        ["40000000-0000-4000-8000-000000000001", ORGANIZATION_ID, ACTOR_ID],
      );
    } finally {
      setup.release();
    }
    const base = scopedExecutor(pool, schema);
    return {
      schema,
      executor: base,
      query: base.query,
      close: async () => {
        const cleanup = await pool.connect();
        try {
          await cleanup.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
        } finally {
          cleanup.release();
          await pool.end();
        }
      },
    };
  } catch (error) {
    const cleanup = await pool.connect().catch(() => undefined);
    if (cleanup) {
      try {
        await cleanup.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      } finally {
        cleanup.release();
      }
    }
    await pool.end();
    throw error;
  }
}

function transactionBarrier(count: number): { wait(): Promise<void> } {
  let entered = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  return {
    async wait(): Promise<void> {
      entered += 1;
      if (entered === count) resolveReady();
      if (entered === count) release();
      await ready;
      await released;
    },
  };
}

function simultaneousExecutor(base: RentOpsQueryExecutor, count = 2): RentOpsQueryExecutor {
  const barrier = transactionBarrier(count);
  return {
    query: base.query,
    transaction: (work) => base.transaction!(async (transaction) => {
      // BEGIN alone does not establish a PostgreSQL snapshot. Both sides
      // must read before either is released into the competing mutation.
      await transaction.query('SELECT count(*) FROM company_projects');
      await barrier.wait();
      return work(transaction);
    }),
  };
}

async function principalFor(executor: RentOpsQueryExecutor): Promise<AuthenticatedPrincipal> {
  return loadAuthenticatedPrincipal(executor, {
    actorId: ACTOR_ID,
    organizationId: ORGANIZATION_ID,
    role: "admin",
  });
}

function commandEnvelope(payload: Record<string, unknown>, expectedRevision = 1): Record<string, unknown> {
  return {
    operationId: randomUUID(),
    idempotencyKey: randomUUID(),
    scope,
    expectedRevision,
    effectiveDate: "2026-09-21",
    payload,
  };
}

function commandOptions(principal: AuthenticatedPrincipal) {
  return {
    principal,
    transport: attestTransport("web"),
    resolvePrincipal: (transaction: RentOpsQueryExecutor) => principalFor(transaction),
  };
}

function isExpectedConcurrencyRejection(error: unknown): boolean {
  const candidate = error as { code?: string; details?: { reason?: string } };
  return candidate.code === "40001"
    || candidate.code === "conflict"
    || candidate.details?.reason === "revision_conflict"
    || candidate.details?.reason === "project_archived"
    || candidate.details?.reason === "task_dependency_cycle";
}

async function seedProject(database: IsolatedDatabase, options: { scopeItem?: boolean; tasks?: boolean } = {}): Promise<void> {
  await database.query(
    `INSERT INTO company_projects
      (id, organization_id, legal_entity_id, property_id, name, project_type, status, currency)
     VALUES ($1, $2, $3, $4, 'Concurrency project', 'rehab', 'planning', 'USD')`,
    [PROJECT_ID, ORGANIZATION_ID, LEGAL_ENTITY_ID, PROPERTY_ID],
  );
  if (options.scopeItem) {
    await database.query(
      `INSERT INTO company_project_scope_items
        (id, organization_id, project_id, description, quantity, rate_cents, estimated_cents)
       VALUES ($1, $2, $3, 'Original scope', '1', '10000', '10000')`,
      [SCOPE_ITEM_ID, ORGANIZATION_ID, PROJECT_ID],
    );
  }
  if (options.tasks) {
    await database.query(
      `INSERT INTO company_project_tasks
        (id, organization_id, project_id, title, status)
       VALUES ($1, $2, $3, 'Task A', 'not_started'), ($4, $2, $3, 'Task B', 'not_started')`,
      [TASK_A_ID, ORGANIZATION_ID, PROJECT_ID, TASK_B_ID],
    );
  }
}

async function runPair(
  database: IsolatedDatabase,
  leftKind: Parameters<typeof executeProjectCommand>[1],
  leftPayload: Record<string, unknown>,
  rightKind: Parameters<typeof executeProjectCommand>[1],
  rightPayload: Record<string, unknown>,
): Promise<PromiseSettledResult<Awaited<ReturnType<typeof executeProjectCommand>>>[]> {
  const principal = await principalFor(database.executor);
  const executor = simultaneousExecutor(database.executor);
  const options = commandOptions(principal);
  return Promise.allSettled([
    executeProjectCommand(executor, leftKind, commandEnvelope(leftPayload), options),
    executeProjectCommand(executor, rightKind, commandEnvelope(rightPayload), options),
  ]);
}

test("project tuple fence serializes opposing dependency edges", { skip: skipReason ?? false }, async () => {
  const database = await openIsolatedDatabase();
  try {
    await seedProject(database, { tasks: true });
    const results = await runPair(
      database,
      "project.task.dependencies.set",
      { taskId: TASK_A_ID, dependencyTaskIds: [TASK_B_ID] },
      "project.task.dependencies.set",
      { taskId: TASK_B_ID, dependencyTaskIds: [TASK_A_ID] },
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected" && isExpectedConcurrencyRejection(rejected.reason));
    const edges = await database.query<{ task_id: string; depends_on_task_id: string }>(
      `SELECT task_id, depends_on_task_id
         FROM company_project_task_dependencies
        WHERE organization_id = $1 AND project_id = $2`,
      [ORGANIZATION_ID, PROJECT_ID],
    );
    assert.equal(edges.rows.length, 1);
    assert.notEqual(edges.rows[0]?.task_id, edges.rows[0]?.depends_on_task_id);
  } finally {
    await database.close();
  }
});

test("project tuple fence prevents a scope edit and budget approval from using one stale revision", { skip: skipReason ?? false }, async () => {
  const database = await openIsolatedDatabase();
  try {
    await seedProject(database, { scopeItem: true });
    const results = await runPair(
      database,
      "project.scope_item.update",
      { scopeItemId: SCOPE_ITEM_ID, description: "Edited scope" },
      "project.budget.approve",
      { projectId: PROJECT_ID },
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected" && isExpectedConcurrencyRejection(rejected.reason));
    const state = await database.query<{ project_revision: number; description: string; approved_count: number; total_estimated_cents: string | null }>(
      `SELECT p.record_revision AS project_revision, i.description,
              (SELECT count(*) FROM company_project_budget_versions b
                WHERE b.organization_id = p.organization_id AND b.project_id = p.id AND b.status = 'approved')::int AS approved_count,
              (SELECT total_estimated_cents::text FROM company_project_budget_versions b
                WHERE b.organization_id = p.organization_id AND b.project_id = p.id AND b.status = 'approved') AS total_estimated_cents
         FROM company_projects p
         JOIN company_project_scope_items i ON i.organization_id = p.organization_id AND i.project_id = p.id
        WHERE p.organization_id = $1 AND p.id = $2`,
      [ORGANIZATION_ID, PROJECT_ID],
    );
    assert.equal(state.rows[0]?.project_revision, 2);
    const row = state.rows[0];
    assert.ok(row);
    assert.ok(
      (row.description === "Edited scope" && row.approved_count === 0)
      || (row.description === "Original scope" && row.approved_count === 1 && row.total_estimated_cents === "10000"),
    );
  } finally {
    await database.close();
  }
});

test("project tuple fence prevents archive and child insert from committing an invalid state", { skip: skipReason ?? false }, async () => {
  const database = await openIsolatedDatabase();
  try {
    await seedProject(database);
    const results = await runPair(
      database,
      "project.archive",
      { projectId: PROJECT_ID },
      "project.scope_item.create",
      { projectId: PROJECT_ID, description: "Child scope", quantity: "1", rateCents: "10000" },
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected" && isExpectedConcurrencyRejection(rejected.reason));
    const state = await database.query<{ status: string; child_count: number }>(
      `SELECT p.status,
              (SELECT count(*) FROM company_project_scope_items i
                WHERE i.organization_id = p.organization_id AND i.project_id = p.id)::int AS child_count
         FROM company_projects p
        WHERE p.organization_id = $1 AND p.id = $2`,
      [ORGANIZATION_ID, PROJECT_ID],
    );
    const row = state.rows[0];
    assert.ok(row);
    assert.ok(
      (row.status === "archived" && row.child_count === 0)
      || (row.status === "planning" && row.child_count === 1),
    );
  } finally {
    await database.close();
  }
});
