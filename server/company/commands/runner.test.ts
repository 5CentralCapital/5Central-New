import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { z } from "zod";
import {
  commandEnvelopeSchema,
  parseRevision,
  RevisionConflictError,
} from "../../../shared/company";
import { ensureRentOpsSchema } from "../../rent-ops/persistence";
import {
  createAuthenticatedPrincipal,
  attestTransport,
  type AuthenticatedPrincipal,
} from "../authorization";
import {
  ConflictCommandError,
  ForbiddenCommandError,
  ValidationCommandError,
} from "./errors";
import { runCompanyCommand } from "./runner";
import type { RentOpsQueryExecutor } from "../../rent-ops/repositories/postgres";

const orgA = "10000000-0000-4000-8000-000000000001";
const orgB = "10000000-0000-4000-8000-000000000002";
const entityA = "20000000-0000-4000-8000-000000000001";
const entityB = "20000000-0000-4000-8000-000000000002";
const propertyA = "legacy-property-a";
const uuid = (n: number) => `30000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

const payloadSchema = z.object({
  action: z.string(),
  value: z.string().optional(),
}).strict();
type TestPayload = z.infer<typeof payloadSchema>;

const policy = {
  commandKind: "company.test",
  allowedRoles: ["admin"] as const,
};

function makeEnvelope(
  operationId: string,
  idempotencyKey: string,
  action = "save",
  scope: Record<string, string> = { organizationId: orgA },
  expectedRevision?: number,
) {
  return commandEnvelopeSchema(payloadSchema).parse({
    operationId,
    idempotencyKey,
    scope,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    payload: { action },
  });
}

function principalFor(organizationId: string, scopes: readonly { legalEntityId?: string; propertyId?: string }[] = [{}]): AuthenticatedPrincipal {
  return createAuthenticatedPrincipal({
    actorId: `principal-${organizationId.slice(-1)}`,
    organizationId,
    role: "admin",
    authorizedScopes: scopes,
  });
}

function adapt(connection: any): RentOpsQueryExecutor {
  return {
    query: (text, values) => connection.query(text, values),
    transaction: (work) => connection.transaction((tx: any) => work(adapt(tx))),
  };
}

function assertCommandError(error: unknown, code: string): void {
  assert.equal((error as { code?: string }).code, code);
  assert.equal((error as { status?: number }).status, code === "validation" ? 400 : code === "forbidden" ? 403 : 409);
}

function result(state: "saved_in_rops" | "queued", outbox?: { eventKey: string; topic: string; payload: Record<string, unknown> }) {
  return {
    state,
    affectedRecordIds: [] as string[],
    resultingRevisions: [],
    ...(outbox === undefined ? {} : { outbox }),
  };
}

test("durable command runner provides atomic receipt, replay, and outbox contracts", async (t) => {
  const db = new PGlite();
  try {
    await ensureRentOpsSchema({ apply: true, executor: async sql => { await db.exec(sql); } });
    await db.query("INSERT INTO company_organizations(id,name) VALUES ($1,'Example Company'),($2,'Other Company')", [orgA, orgB]);
    await db.query("INSERT INTO company_legal_entities(id,organization_id,name,entity_type,currency) VALUES ($1,$2,'Example LLC','llc','USD'),($3,$4,'Other LLC','llc','USD')", [entityA, orgA, entityB, orgB]);
    await db.query("INSERT INTO rent_ops_properties(id,slug) VALUES ($1,'example-property')", [propertyA]);
    await db.exec("CREATE TABLE company_command_test_markers (marker text PRIMARY KEY, operation_id uuid NOT NULL, payload jsonb NOT NULL)");

    const executor = adapt(db);
    const principalA = principalFor(orgA);
    const principalB = principalFor(orgB);
    const transport = attestTransport("web");
    const fresh = (principal: AuthenticatedPrincipal) => async (_transactionExecutor: RentOpsQueryExecutor) => principal;
    const run = <TPayload>(envelope: ReturnType<typeof makeEnvelope>, principal: AuthenticatedPrincipal, handler: Parameters<typeof runCompanyCommand<TPayload>>[1]["handler"], resolve = fresh(principal)) =>
      runCompanyCommand(executor, { envelope: envelope as never, principal, resolvePrincipal: resolve, transport, policy, handler });

    await t.test("business and receipt writes roll back together", async () => {
      const failed = makeEnvelope(uuid(1), "rollback-key");
      await assert.rejects(
        run(failed, principalA, async ({ executor: tx, envelope }) => {
          await tx.query("INSERT INTO company_command_test_markers(marker,operation_id,payload) VALUES ($1,$2,$3::jsonb)", ["rollback", envelope.operationId, JSON.stringify(envelope.payload)]);
          throw new Error("business failure");
        }),
        /business failure/,
      );
      assert.equal((await db.query<{ count: number }>("SELECT count(*)::int AS count FROM company_command_test_markers")).rows[0].count, 0);
      assert.equal((await db.query<{ count: number }>("SELECT count(*)::int AS count FROM company_command_receipts")).rows[0].count, 0);
    });

    await t.test("successful response-loss replay returns the exact receipt without rerunning the handler", async () => {
      const first = makeEnvelope(uuid(2), "replay-key");
      let calls = 0;
      const handler = async ({ executor: tx, envelope }: { executor: RentOpsQueryExecutor; envelope: typeof first }) => {
        calls += 1;
        await tx.query("INSERT INTO company_command_test_markers(marker,operation_id,payload) VALUES ($1,$2,$3::jsonb)", ["replay", envelope.operationId, JSON.stringify(envelope.payload)]);
        return result("saved_in_rops");
      };
      const persisted = await run(first, principalA, handler);
      const replay = await run(makeEnvelope(uuid(3), "replay-key"), principalA, handler);
      assert.deepEqual(replay, persisted);
      assert.equal(calls, 1);
      assert.equal((await db.query<{ count: number }>("SELECT count(*)::int AS count FROM company_command_test_markers WHERE marker='replay'")).rows[0].count, 1);
    });

    await t.test("same idempotency key with altered input is a conflict", async () => {
      const altered = makeEnvelope(uuid(4), "replay-key", "altered");
      await assert.rejects(run(altered, principalA, () => result("saved_in_rops")), (error: unknown) => {
        assertCommandError(error, "conflict");
        return error instanceof ConflictCommandError;
      });
    });

    await t.test("authorization is rechecked before replay lookup after revocation", async () => {
      let revoked = false;
      const replayEnvelope = makeEnvelope(uuid(5), "replay-key");
      const resolve = async () => revoked ? principalFor(orgA, []) : principalA;
      const replayed = await run(replayEnvelope, principalA, () => result("saved_in_rops"), resolve);
      assert.equal(replayed.state, "saved_in_rops");
      revoked = true;
      await assert.rejects(
        run(replayEnvelope, principalA, () => result("saved_in_rops"), resolve),
        (error: unknown) => {
          assertCommandError(error, "forbidden");
          return error instanceof ForbiddenCommandError;
        },
      );
    });

    await t.test("duplicate operation IDs do not disclose another organization receipt", async () => {
      const crossOrg = makeEnvelope(uuid(2), "other-org-key", "save", { organizationId: orgB });
      await assert.rejects(run(crossOrg, principalB, () => result("saved_in_rops")), (error: unknown) => {
        assertCommandError(error, "conflict");
        return error instanceof ConflictCommandError;
      });
      const visible = await db.query<{ organization_id: string; idempotency_key: string }>("SELECT organization_id,idempotency_key FROM company_command_receipts");
      assert.deepEqual(visible.rows, [{ organization_id: orgA, idempotency_key: "replay-key" }]);
    });

    await t.test("expected revisions remain a handler decision and stale revisions roll back", async () => {
      const stale = makeEnvelope(uuid(6), "revision-key", "save", { organizationId: orgA }, 2);
      await assert.rejects(
        run(stale, principalA, async ({ executor: tx, envelope }) => {
          await tx.query("INSERT INTO company_command_test_markers(marker,operation_id,payload) VALUES ($1,$2,$3::jsonb)", ["stale", envelope.operationId, JSON.stringify(envelope.payload)]);
          throw new RevisionConflictError(parseRevision(envelope.expectedRevision!), parseRevision(3));
        }),
        (error: unknown) => {
          assertCommandError(error, "conflict");
          return error instanceof ConflictCommandError;
        },
      );
      assert.equal((await db.query<{ count: number }>("SELECT count(*)::int AS count FROM company_command_test_markers WHERE marker='stale'")).rows[0].count, 0);
    });

    await t.test("queued work requires a local outbox and verifies conflicting event keys", async () => {
      const queued = makeEnvelope(uuid(7), "queued-key");
      const event = { eventKey: "company.test.queued", topic: "company.test", payload: { value: "one" } };
      const queuedReceipt = await run(queued, principalA, () => result("queued", event));
      assert.equal(queuedReceipt.state, "queued");
      const conflictEnvelope = makeEnvelope(uuid(8), "queued-conflict-key");
      await assert.rejects(
        run(conflictEnvelope, principalA, async ({ executor: tx, envelope }) => {
          await tx.query("INSERT INTO company_command_test_markers(marker,operation_id,payload) VALUES ($1,$2,$3::jsonb)", ["outbox-conflict", envelope.operationId, JSON.stringify(envelope.payload)]);
          return result("queued", { ...event, payload: { value: "changed" } });
        }),
        (error: unknown) => {
          assertCommandError(error, "conflict");
          return error instanceof ConflictCommandError;
        },
      );
      assert.equal((await db.query<{ count: number }>("SELECT count(*)::int AS count FROM company_command_test_markers WHERE marker='outbox-conflict'")).rows[0].count, 0);
    });

    await t.test("direct API envelopes with actor fields fail before transaction work", async () => {
      const spoofed = { ...makeEnvelope(uuid(9), "spoofed-key"), actorId: "attacker" } as never;
      await assert.rejects(run(spoofed, principalA, () => result("saved_in_rops")), (error: unknown) => {
        assertCommandError(error, "validation");
        return error instanceof ValidationCommandError;
      });
      assert.equal((await db.query<{ count: number }>("SELECT count(*)::int AS count FROM company_command_test_markers WHERE marker='spoofed'")).rows[0].count, 0);
    });
  } finally {
    await db.close();
  }
});

test("runner refuses an executor without transaction support", async () => {
  const principal = principalFor(orgA);
  const envelope = makeEnvelope(uuid(100), "no-transaction");
  const noTransaction = { query: async () => ({ rows: [] }) } as RentOpsQueryExecutor;
  await assert.rejects(
    runCompanyCommand(noTransaction, {
      envelope,
      principal,
      resolvePrincipal: async () => principal,
      transport: attestTransport("web"),
      policy,
      handler: () => result("saved_in_rops"),
    }),
    (error: unknown) => {
      assertCommandError(error, "validation");
      return error instanceof ValidationCommandError;
    },
  );
});
