import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createCompanyDemoApp } from "../company/demo";
import { SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";

const ENVIRONMENT = "production";
const REALM = "4620816365000001";
const OTHER_ENTITY = "20000000-0000-4000-8000-000000000099";

type DemoFixture = Awaited<ReturnType<typeof createCompanyDemoApp>>;

async function seedTenancy(
  fixture: DemoFixture,
  input: { id: string; propertyId?: string; status?: string; moveIn?: string | null; moveOut?: string | null },
): Promise<void> {
  const personId = `person-${input.id}`;
  const unitId = `unit-${input.id}`;
  const propertyId = input.propertyId ?? SYNTHETIC_COMPANY.propertyId;
  await fixture.database.db.query(
    "INSERT INTO rent_ops_units(id,property_id,unit_number) VALUES ($1,$2,$3)",
    [unitId, propertyId, input.id],
  );
  await fixture.database.db.query(
    "INSERT INTO rent_ops_people(id,first_name,last_name) VALUES ($1,'Synthetic',$2)",
    [personId, input.id],
  );
  await fixture.database.db.query(
    `INSERT INTO rent_ops_tenancies
      (id,property_id,unit_id,primary_person_id,status,actual_move_in_on,actual_move_out_on,created_at,
       property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge,status_knowledge)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'2026-01-01T00:00:00Z','manual','manual','manual','manual')`,
    [input.id, propertyId, unitId, personId, input.status ?? "current", input.moveIn ?? null, input.moveOut ?? null],
  );
}

async function seedBindingAndConnection(fixture: DemoFixture, legalEntityId = SYNTHETIC_COMPANY.entityId): Promise<void> {
  await fixture.database.db.query(
    `INSERT INTO accounting_qbo_realm_bindings
      (organization_id,legal_entity_id,environment,realm_id,provider_company_id,provider_company_name,
       evidence_version,company_info_hash,confirmed_by)
     VALUES ($1,$2,$3,$4,'synthetic-company','Synthetic QBO','v1',$5,'synthetic-admin')`,
    [SYNTHETIC_COMPANY.organizationId, legalEntityId, ENVIRONMENT, REALM, "a".repeat(64)],
  );
  await fixture.database.db.query(
    `INSERT INTO accounting_qbo_connections
      (organization_id,legal_entity_id,environment,realm_id,
       encrypted_access_token,access_token_iv,access_token_auth_tag,
       encrypted_refresh_token,refresh_token_iv,refresh_token_auth_tag,
       access_token_expires_at,status)
     VALUES ($1,$2,$3,$4,'access','iv','tag','refresh','iv','tag',now() + interval '1 hour','active')`,
    [SYNTHETIC_COMPANY.organizationId, legalEntityId, ENVIRONMENT, REALM],
  );
}

async function seedCustomerLink(
  fixture: DemoFixture,
  tenancyId: string,
  legalEntityId = SYNTHETIC_COMPANY.entityId,
  customerObjectId = `customer-${tenancyId}`,
  sourceScope = `qbo:${ENVIRONMENT}:${REALM}`,
): Promise<void> {
  await fixture.database.db.query(
    `INSERT INTO company_external_identities
      (id,organization_id,legal_entity_id,provider,source_scope,record_kind,external_id,local_kind,local_id)
     VALUES ($1,$2,$3,'qbo',$4,'Customer',$5,'tenancy',$6)`,
    [randomUUID(), SYNTHETIC_COMPANY.organizationId, legalEntityId, sourceScope, customerObjectId, tenancyId],
  );
}

async function restrictDemoActor(fixture: DemoFixture, legalEntityId: string, propertyId: string): Promise<void> {
  await fixture.database.db.query(
    "UPDATE company_access_grants SET revoked_at=now() WHERE organization_id=$1 AND actor_id=$2 AND revoked_at IS NULL",
    [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.actorId],
  );
  await fixture.database.db.query(
    `INSERT INTO company_access_grants(id,organization_id,actor_id,role,legal_entity_id,property_id)
     VALUES ($1,$2,$3,'admin',$4,$5)`,
    [randomUUID(), SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.actorId, legalEntityId, propertyId],
  );
}

async function listen(fixture: DemoFixture): Promise<{ readonly origin: string; close(): Promise<void> }> {
  const listener = fixture.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  return {
    origin: `http://127.0.0.1:${(listener.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())),
  };
}

function tenancyLedgerUrl(origin: string, tenancyId: string): string {
  return `${origin}/api/company/${SYNTHETIC_COMPANY.organizationId}/accounting/qbo/receivables/tenancy-ledger?${new URLSearchParams({ tenancyId, environment: ENVIRONMENT, asOf: "2026-09-26" })}`;
}

function sourceResolutionUrl(origin: string, tenancyId: string): string {
  return `${origin}/api/company/${SYNTHETIC_COMPANY.organizationId}/accounting/qbo/receivables/tenancy-source-resolution?${new URLSearchParams({ tenancyId, environment: ENVIRONMENT, asOf: "2026-09-26" })}`;
}

test("an existing customer link with a uniquely mapped owner exposes the ledger and a missing-date warning", async () => {
  const fixture = await createCompanyDemoApp();
  const server = await listen(fixture);
  const tenancyId = "http-linked-dates-missing";
  try {
    await seedTenancy(fixture, { id: tenancyId });
    await seedBindingAndConnection(fixture);
    await seedCustomerLink(fixture, tenancyId);

    const ledgerResponse = await fetch(tenancyLedgerUrl(server.origin, tenancyId));
    assert.equal(ledgerResponse.status, 200, await ledgerResponse.clone().text());
    const ledger = await ledgerResponse.json() as {
      scope: { legalEntityId: string };
      customer: { objectId: string };
      entries: unknown[];
      totals: { endingBalanceCents: string };
      ownershipWarning: string;
    };
    assert.equal(ledger.scope.legalEntityId, SYNTHETIC_COMPANY.entityId);
    assert.equal(ledger.customer.objectId, `customer-${tenancyId}`);
    assert.deepEqual(ledger.entries, []);
    assert.equal(ledger.totals.endingBalanceCents, "0");
    assert.equal(ledger.ownershipWarning, "Move-in date missing. Add it to confirm ownership.");

    const resolutionResponse = await fetch(sourceResolutionUrl(server.origin, tenancyId));
    assert.equal(resolutionResponse.status, 200, await resolutionResponse.clone().text());
    const resolution = await resolutionResponse.json() as {
      ownership: { state: string; effectiveLegalEntityId: string | null };
      qbo: { state: string; scope: { legalEntityId: string; realmId: string } | null };
      currentState: string;
      reasons: string[];
    };
    assert.equal(resolution.ownership.state, "linked_dates_missing");
    assert.equal(resolution.ownership.effectiveLegalEntityId, null);
    assert.equal(resolution.qbo.state, "linked");
    assert.equal(resolution.currentState, "linked");
    assert.equal(resolution.qbo.scope?.legalEntityId, SYNTHETIC_COMPANY.entityId);
    assert.equal(resolution.qbo.scope?.realmId, REALM);
    assert.ok(resolution.reasons.includes("Move-in date missing. Add it to confirm ownership."));
  } finally {
    await server.close();
    await fixture.close();
  }
});

test("ledger and source-resolution routes reject a grant that covers the entity but not the linked property", async () => {
  const fixture = await createCompanyDemoApp();
  const server = await listen(fixture);
  const tenancyId = "http-linked-property-scope";
  try {
    await seedTenancy(fixture, { id: tenancyId });
    await seedBindingAndConnection(fixture);
    await seedCustomerLink(fixture, tenancyId);
    await restrictDemoActor(fixture, SYNTHETIC_COMPANY.entityId, "demo-property-b");

    for (const url of [tenancyLedgerUrl(server.origin, tenancyId), sourceResolutionUrl(server.origin, tenancyId)]) {
      const response = await fetch(url);
      assert.equal(response.status, 403, await response.clone().text());
      const body = await response.text();
      assert.doesNotMatch(body, new RegExp(`customer-${tenancyId}`));
      assert.doesNotMatch(body, /Move-in date missing/);
    }
  } finally {
    await server.close();
    await fixture.close();
  }
});

test("a link to a different entity returns an ownership-review response and stays private without that linked grant", async () => {
  const fixture = await createCompanyDemoApp();
  const server = await listen(fixture);
  const tenancyId = "http-linked-mismatched-entity";
  const customerObjectId = `customer-${tenancyId}`;
  try {
    await seedTenancy(fixture, { id: tenancyId, status: "past", moveIn: "2024-01-01", moveOut: "2025-01-01" });
    await fixture.database.db.query(
      "INSERT INTO company_legal_entities(id,organization_id,name,entity_type,currency) VALUES ($1,$2,'Other Synthetic LLC','llc','USD')",
      [OTHER_ENTITY, SYNTHETIC_COMPANY.organizationId],
    );
    await seedCustomerLink(fixture, tenancyId, OTHER_ENTITY, customerObjectId);

    const reviewResponse = await fetch(tenancyLedgerUrl(server.origin, tenancyId));
    assert.equal(reviewResponse.status, 409, await reviewResponse.clone().text());
    const review = await reviewResponse.json() as { code: string; message: string };
    assert.equal(review.code, "accounting_ownership_review");
    assert.match(review.message, /ownership|review|legal entity/i);
    assert.doesNotMatch(review.message, /not linked/i);

    const sourceResponse = await fetch(sourceResolutionUrl(server.origin, tenancyId));
    assert.equal(sourceResponse.status, 200, await sourceResponse.clone().text());
    const source = await sourceResponse.json() as {
      currentState: string;
      qbo: { state: string; scope: unknown; customerLink: { customerObjectId: string; legalEntityId: string } | null };
    };
    assert.equal(source.currentState, "ownership_review");
    assert.equal(source.qbo.state, "ownership_review");
    assert.equal(source.qbo.scope, null);
    assert.deepEqual(source.qbo.customerLink, { customerObjectId, legalEntityId: OTHER_ENTITY });

    await restrictDemoActor(fixture, SYNTHETIC_COMPANY.entityId, SYNTHETIC_COMPANY.propertyId);
    for (const url of [tenancyLedgerUrl(server.origin, tenancyId), sourceResolutionUrl(server.origin, tenancyId)]) {
      const response = await fetch(url);
      assert.equal(response.status, 403, await response.clone().text());
      const body = await response.text();
      assert.doesNotMatch(body, new RegExp(customerObjectId));
      assert.doesNotMatch(body, /ownership|review|Other Synthetic LLC/i);
    }
  } finally {
    await server.close();
    await fixture.close();
  }
});

test("a missing-date link is held for review when the property has multiple mapped owners", async () => {
  const fixture = await createCompanyDemoApp();
  const server = await listen(fixture);
  const tenancyId = "http-linked-multi-owner-unknown-date";
  try {
    await fixture.database.db.query(
      "INSERT INTO company_legal_entities(id,organization_id,name,entity_type,currency) VALUES ($1,$2,'Later Synthetic LLC','llc','USD')",
      [OTHER_ENTITY, SYNTHETIC_COMPANY.organizationId],
    );
    await fixture.database.db.query(
      `UPDATE company_property_entity_periods
          SET effective_until='2024-01-01'
        WHERE organization_id=$1 AND legal_entity_id=$2 AND property_id=$3`,
      [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId, SYNTHETIC_COMPANY.propertyId],
    );
    await fixture.database.db.query(
      `INSERT INTO company_property_entity_periods(id,organization_id,legal_entity_id,property_id,effective_from)
       VALUES ($1,$2,$3,$4,'2024-01-01')`,
      [randomUUID(), SYNTHETIC_COMPANY.organizationId, OTHER_ENTITY, SYNTHETIC_COMPANY.propertyId],
    );
    await seedTenancy(fixture, { id: tenancyId });
    await seedCustomerLink(fixture, tenancyId);

    const response = await fetch(tenancyLedgerUrl(server.origin, tenancyId));
    assert.equal(response.status, 409, await response.clone().text());
    const body = await response.json() as { code: string; message: string };
    assert.equal(body.code, "accounting_ownership_review");
    assert.match(body.message, /ownership is unresolved|review/i);
    assert.doesNotMatch(body.message, /not linked/i);
  } finally {
    await server.close();
    await fixture.close();
  }
});

test("a tenancy with no customer identity remains a not-linked 404", async () => {
  const fixture = await createCompanyDemoApp();
  const server = await listen(fixture);
  const tenancyId = "http-truly-unlinked";
  try {
    await seedTenancy(fixture, { id: tenancyId });
    const response = await fetch(tenancyLedgerUrl(server.origin, tenancyId));
    assert.equal(response.status, 404, await response.clone().text());
    const body = await response.json() as { code: string; message: string };
    assert.equal(body.code, "accounting_not_linked");
    assert.match(body.message, /not linked/i);
    assert.doesNotMatch(body.message, /ownership is unresolved/i);

    const unmappedTenancyId = "http-unmapped-link";
    await fixture.database.db.query("INSERT INTO rent_ops_properties(id,name,slug) VALUES ('http-unmapped','Unmapped Synthetic','http-unmapped')");
    await seedTenancy(fixture, { id: unmappedTenancyId, propertyId: "http-unmapped" });
    await seedCustomerLink(fixture, unmappedTenancyId);
    const unmappedResponse = await fetch(tenancyLedgerUrl(server.origin, unmappedTenancyId));
    assert.equal(unmappedResponse.status, 404, await unmappedResponse.clone().text());
    const unmapped = await unmappedResponse.json() as { code: string; message: string };
    assert.equal(unmapped.code, "accounting_not_found");
    assert.equal(unmapped.message, "The accounting record is unavailable in this company.");
    assert.doesNotMatch(unmapped.message, /not linked|customer-http/);
  } finally {
    await server.close();
    await fixture.close();
  }
});

test("multiple or malformed customer identities fail closed without returning ledger data", async () => {
  const multipleFixture = await createCompanyDemoApp();
  const multipleServer = await listen(multipleFixture);
  const multipleTenancyId = "http-duplicate-customer-links";
  try {
    await seedTenancy(multipleFixture, { id: multipleTenancyId });
    await seedCustomerLink(multipleFixture, multipleTenancyId, SYNTHETIC_COMPANY.entityId, "customer-first");
    await seedCustomerLink(multipleFixture, multipleTenancyId, SYNTHETIC_COMPANY.entityId, "customer-second");

    const response = await fetch(tenancyLedgerUrl(multipleServer.origin, multipleTenancyId));
    assert.equal(response.status, 409, await response.clone().text());
    const body = await response.text();
    assert.doesNotMatch(body, /customer-first|customer-second|endingBalanceCents|entries/);
  } finally {
    await multipleServer.close();
    await multipleFixture.close();
  }

  const malformedFixture = await createCompanyDemoApp();
  const malformedServer = await listen(malformedFixture);
  const malformedTenancyId = "http-malformed-customer-link";
  try {
    await seedTenancy(malformedFixture, { id: malformedTenancyId });
    await seedCustomerLink(malformedFixture, malformedTenancyId, SYNTHETIC_COMPANY.entityId, "customer-malformed", "qbo:production:invalid-realm");

    const response = await fetch(tenancyLedgerUrl(malformedServer.origin, malformedTenancyId));
    assert.equal(response.status, 503, await response.clone().text());
    const body = await response.text();
    assert.doesNotMatch(body, /customer-malformed|endingBalanceCents|entries/);
  } finally {
    await malformedServer.close();
    await malformedFixture.close();
  }
});
