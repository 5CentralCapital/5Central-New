import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { z } from "zod";
import { commandEnvelopeSchema } from "../../shared/company";
import { ensureRentOpsSchema } from "../rent-ops/persistence";
import {
  authorizeCommand,
  createAuthenticatedPrincipal,
  loadAuthenticatedPrincipal,
  MRA_INGESTION_POLICY,
  attestTransport,
  type AuthenticatedPrincipal,
} from "./authorization";
import { ForbiddenCommandError, ValidationCommandError } from "./commands/errors";

const orgA = "10000000-0000-4000-8000-000000000001";
const orgB = "10000000-0000-4000-8000-000000000002";
const entityA = "20000000-0000-4000-8000-000000000001";
const entityB = "20000000-0000-4000-8000-000000000002";
const propertyA = "legacy-property-a";
const propertyB = "legacy-property-b";
const grantId = (n: number) => `30000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

const payloadSchema = z.object({ action: z.string() }).strict();
const envelope = (scope: Record<string, string>, operationId = grantId(900), idempotencyKey = "auth-test") =>
  commandEnvelopeSchema(payloadSchema).parse({
    operationId,
    idempotencyKey,
    scope,
    payload: { action: "review" },
  });

const propertyPolicy = {
  commandKind: "property.review",
  allowedRoles: ["finance"] as const,
  requiredScope: "property" as const,
};

function assertErrorCode(error: unknown, code: string): void {
  assert.equal((error as { code?: string }).code, code);
}

function propertyPrincipal(): AuthenticatedPrincipal {
  return createAuthenticatedPrincipal({
    actorId: "demo-admin",
    organizationId: orgA,
    role: "finance",
    authorizedScopes: [
      { legalEntityId: entityA, propertyId: propertyA },
      { legalEntityId: entityB, propertyId: propertyB },
    ],
  });
}

test("authorization keeps actor identity server-bound and pairs entity/property grants", async (t) => {
  const principal = propertyPrincipal();
  const web = attestTransport("web");

  await t.test("matching paired property scope is allowed", () => {
    authorizeCommand(principal, web, propertyPolicy, envelope({ organizationId: orgA, legalEntityId: entityA, propertyId: propertyA }));
  });

  await t.test("a property from another legal entity is not authorized by Cartesian projection", () => {
    assert.throws(
      () => authorizeCommand(principal, web, propertyPolicy, envelope({ organizationId: orgA, legalEntityId: entityA, propertyId: propertyB })),
      (error: unknown) => {
        assertErrorCode(error, "forbidden");
        return error instanceof ForbiddenCommandError;
      },
    );
  });

  await t.test("restricted grants cannot be promoted to an organization or entity command", () => {
    assert.throws(
      () => authorizeCommand(principal, web, { ...propertyPolicy, requiredScope: undefined }, envelope({ organizationId: orgA })),
      (error: unknown) => error instanceof ForbiddenCommandError,
    );
    assert.throws(
      () => authorizeCommand(principal, web, { ...propertyPolicy, requiredScope: undefined }, envelope({ organizationId: orgA, legalEntityId: entityA })),
      (error: unknown) => error instanceof ForbiddenCommandError,
    );
  });

  await t.test("principal and nested grant arrays are immutable after server attestation", () => {
    assert.equal(Object.isFrozen(principal), true);
    assert.equal(Object.isFrozen(principal.authorizedScopes), true);
    assert.equal(Object.isFrozen(principal.capabilities), true);
    assert.throws(() => (principal.authorizedScopes as unknown as Array<unknown>).push({}));
  });

  await t.test("the strict envelope rejects actor and surface spoofing", () => {
    const spoofed = commandEnvelopeSchema(payloadSchema).safeParse({
      ...envelope({ organizationId: orgA, legalEntityId: entityA, propertyId: propertyA }),
      actorId: "other-principal",
      surface: "web",
    });
    assert.equal(spoofed.success, false);
    assert.equal(principal.actorId, "demo-admin");
  });

  await t.test("forged transport metadata cannot select MRA surface", () => {
    const codex = attestTransport("codex_mcp", ["mra_ingestion"]);
    const mraPrincipal = createAuthenticatedPrincipal({
      actorId: "demo-admin",
      organizationId: orgA,
      role: "admin",
      authorizedScopes: principal.authorizedScopes,
    });
    authorizeCommand(mraPrincipal, codex, MRA_INGESTION_POLICY, envelope({ organizationId: orgA, legalEntityId: entityA, propertyId: propertyA }));
    assert.throws(
      () => authorizeCommand(mraPrincipal, web, MRA_INGESTION_POLICY, envelope({ organizationId: orgA, legalEntityId: entityA, propertyId: propertyA })),
      (error: unknown) => error instanceof ForbiddenCommandError,
    );
    assert.throws(
      () => authorizeCommand(mraPrincipal, attestTransport("codex_mcp"), MRA_INGESTION_POLICY, envelope({ organizationId: orgA, legalEntityId: entityA, propertyId: propertyA })),
      (error: unknown) => error instanceof ForbiddenCommandError,
    );
    assert.throws(
      () => authorizeCommand(mraPrincipal, { ...codex, attested: true } as typeof codex, MRA_INGESTION_POLICY, envelope({ organizationId: orgA, legalEntityId: entityA, propertyId: propertyA })),
      (error: unknown) => error instanceof ValidationCommandError,
    );
  });
});

test("active SQL grants load as paired, revocation-safe principal scopes", async () => {
  const db = new PGlite();
  try {
    await ensureRentOpsSchema({ apply: true, executor: async sql => { await db.exec(sql); } });
    await db.query("INSERT INTO company_organizations(id,name) VALUES ($1,'Example Company'),($2,'Other Company')", [orgA, orgB]);
    await db.query("INSERT INTO company_legal_entities(id,organization_id,name,entity_type,currency) VALUES ($1,$2,'Example LLC','llc','USD'),($3,$2,'Second LLC','llc','USD')", [entityA, orgA, entityB]);
    await db.query("INSERT INTO rent_ops_properties(id,slug) VALUES ($1,'property-a'),($2,'property-b')", [propertyA, propertyB]);
    await db.query(
      "INSERT INTO company_access_grants(id,organization_id,actor_id,role,legal_entity_id,property_id) VALUES ($1,$2,'grant-principal','finance',$3,$4),($5,$2,'grant-principal','finance',$6,$7)",
      [grantId(1), orgA, entityA, propertyA, grantId(2), entityB, propertyB],
    );
    await db.query("UPDATE company_access_grants SET revoked_at=now() WHERE id=$1", [grantId(3)]);

    const executor = {
      query: async <T = Record<string, unknown>>(text: string, values?: unknown[]) => db.query<T>(text, values),
    };
    const principal = await loadAuthenticatedPrincipal(executor, {
      actorId: "grant-principal",
      organizationId: orgA,
      role: "finance",
    });
    const transport = attestTransport("web");
    authorizeCommand(principal, transport, propertyPolicy, envelope({ organizationId: orgA, legalEntityId: entityA, propertyId: propertyA }, grantId(901), "grant-a"));
    authorizeCommand(principal, transport, propertyPolicy, envelope({ organizationId: orgA, legalEntityId: entityB, propertyId: propertyB }, grantId(902), "grant-b"));
    assert.throws(
      () => authorizeCommand(principal, transport, propertyPolicy, envelope({ organizationId: orgA, legalEntityId: entityA, propertyId: propertyB }, grantId(903), "grant-cross")),
      (error: unknown) => error instanceof ForbiddenCommandError,
    );
    await db.query("UPDATE company_access_grants SET revoked_at=now() WHERE id=$1", [grantId(1)]);
    const afterRevocation = await loadAuthenticatedPrincipal(executor, {
      actorId: "grant-principal",
      organizationId: orgA,
      role: "finance",
    });
    assert.throws(
      () => authorizeCommand(afterRevocation, transport, propertyPolicy, envelope({ organizationId: orgA, legalEntityId: entityA, propertyId: propertyA }, grantId(904), "grant-revoked")),
      (error: unknown) => error instanceof ForbiddenCommandError,
    );
  } finally {
    await db.close();
  }
});
