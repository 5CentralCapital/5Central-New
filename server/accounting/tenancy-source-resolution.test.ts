import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createCompanyDemoApp } from "../company/demo";
import { createSyntheticCompanyDatabase, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { linkTenancyToQboCustomer } from "./receivables-links";
import { resolveTenancyCustomer } from "./receivables-read";
import { resolveTenancySource } from "./tenancy-source-resolution";

const ENVIRONMENT = "production" as const;
const REALM = "4620816365000001";

async function seedTenancy(
  db: Awaited<ReturnType<typeof createSyntheticCompanyDatabase>>["db"],
  input: { id: string; propertyId: string; unitId: string; personId: string; status: string | null; moveIn?: string | null; moveOut?: string | null },
): Promise<void> {
  await db.query("INSERT INTO rent_ops_people(id,first_name,last_name) VALUES ($1,$2,$3)", [input.personId, "Synthetic", input.id]);
  await db.query(
    `INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,actual_move_in_on,actual_move_out_on,created_at,property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge,status_knowledge)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'2026-01-01T00:00:00Z','manual','manual','manual','manual')`,
    [input.id, input.propertyId, input.unitId, input.personId, input.status, input.moveIn ?? null, input.moveOut ?? null],
  );
}

async function seedLedger(
  db: Awaited<ReturnType<typeof createSyntheticCompanyDatabase>>["db"],
  tenancyId: string,
  propertyId: string,
  unitId: string,
  personId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO rent_ops_ledger_transactions
      (id,property_id,unit_id,tenancy_id,person_id,kind,category,status,amount_cents,posted_on,description,payer,
       amount_knowledge,category_knowledge,status_knowledge,posted_on_knowledge,description_knowledge,payer_knowledge,
       charge_definition_link_knowledge,property_link_knowledge,unit_link_knowledge,person_link_knowledge,tenancy_link_knowledge,
       due_on_knowledge,payment_method_knowledge)
     VALUES ($1,$2,$3,$4,$5,'charge','base_rent','posted',100000,'2026-01-02','Synthetic rent','tenant',
       'known','manual','manual','manual','manual','manual','unknown','manual','manual','manual','manual','unknown','unknown')`,
    [`ledger-${tenancyId}`, propertyId, unitId, tenancyId, personId],
  );
}

async function seedBindingAndConnection(db: Awaited<ReturnType<typeof createSyntheticCompanyDatabase>>["db"]): Promise<void> {
  await db.query(
    `INSERT INTO accounting_qbo_realm_bindings
      (organization_id,legal_entity_id,environment,realm_id,provider_company_id,provider_company_name,evidence_version,company_info_hash,confirmed_by)
     VALUES ($1,$2,$3,$4,'synthetic-company','Synthetic QBO','v1',$5,'synthetic-admin')`,
    [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId, ENVIRONMENT, REALM, "a".repeat(64)],
  );
  await db.query(
    `INSERT INTO accounting_qbo_connections
      (organization_id,legal_entity_id,environment,realm_id,
       encrypted_access_token,access_token_iv,access_token_auth_tag,
       encrypted_refresh_token,refresh_token_iv,refresh_token_auth_tag,
       access_token_expires_at,status)
     VALUES ($1,$2,$3,$4,'access','iv','tag','refresh','iv','tag',now() + interval '1 hour','active')`,
    [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId, ENVIRONMENT, REALM],
  );
}

test("former local Rent Ops history stays available when no QuickBooks company is connected", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    await seedTenancy(fixture.db, { id: "resolver-local-only", propertyId: SYNTHETIC_COMPANY.propertyId, unitId: SYNTHETIC_COMPANY.unitId, personId: "resolver-person-local-only", status: "past", moveIn: "2022-01-01", moveOut: "2023-01-01" });
    await seedLedger(fixture.db, "resolver-local-only", SYNTHETIC_COMPANY.propertyId, SYNTHETIC_COMPANY.unitId, "resolver-person-local-only");
    const result = await resolveTenancySource(fixture.executor, {
      organizationId: SYNTHETIC_COMPANY.organizationId,
      tenancyId: "resolver-local-only",
      environment: ENVIRONMENT,
      asOf: "2026-09-26",
    });
    assert.ok(result);
    assert.equal(result.currentState, "local_history_available");
    assert.equal(result.local.state, "local_history_available");
    assert.equal(result.qbo.state, "not_connected");
    assert.equal(result.qbo.scope, null);
    assert.equal(result.qbo.customerLink, null);
    assert.ok(result.reasons.some(reason => /Local Rent Ops history is available/.test(reason)));
  } finally {
    await fixture.close();
  }
});

test("tenant source resolution returns the historical owner, connected unlinked scope, and local history", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    await seedTenancy(fixture.db, { id: "resolver-current", propertyId: SYNTHETIC_COMPANY.propertyId, unitId: SYNTHETIC_COMPANY.unitId, personId: "resolver-person-current", status: "current", moveIn: "2024-01-01" });
    await seedLedger(fixture.db, "resolver-current", SYNTHETIC_COMPANY.propertyId, SYNTHETIC_COMPANY.unitId, "resolver-person-current");
    await seedBindingAndConnection(fixture.db);

    const result = await resolveTenancySource(fixture.executor, {
      organizationId: SYNTHETIC_COMPANY.organizationId,
      tenancyId: "resolver-current",
      environment: ENVIRONMENT,
      asOf: "2026-09-26",
    });
    assert.ok(result);
    assert.equal(result.currentState, "unlinked");
    assert.equal(result.local.state, "local_history_available");
    assert.equal(result.local.ledgerEntryCount, 1);
    assert.equal(result.ownership.state, "resolved");
    assert.equal(result.ownership.coverageComplete, true);
    assert.equal(result.ownership.effectiveLegalEntityId, SYNTHETIC_COMPANY.entityId);
    assert.deepEqual(result.qbo.scope, {
      provider: "qbo",
      organizationId: SYNTHETIC_COMPANY.organizationId,
      legalEntityId: SYNTHETIC_COMPANY.entityId,
      environment: ENVIRONMENT,
      realmId: REALM,
    });
    assert.equal(result.qbo.connection?.state, "active");
    assert.equal(result.qbo.customerLink, null);

    await fixture.db.query(
      `INSERT INTO company_external_identities
        (id,organization_id,legal_entity_id,provider,source_scope,record_kind,external_id,local_kind,local_id)
       VALUES ('50000000-0000-4000-8000-000000000051',$1,$2,'qbo',$3,'Customer','customer-77','tenancy',$4)`,
      [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId, `qbo:${ENVIRONMENT}:${REALM}`, "resolver-current"],
    );
    const linked = await resolveTenancySource(fixture.executor, {
      organizationId: SYNTHETIC_COMPANY.organizationId,
      tenancyId: "resolver-current",
      environment: ENVIRONMENT,
      asOf: "2026-09-26",
    });
    assert.equal(linked?.currentState, "linked");
    assert.deepEqual(linked?.qbo.customerLink, { customerObjectId: "customer-77", legalEntityId: SYNTHETIC_COMPANY.entityId });
  } finally {
    await fixture.close();
  }
});

test("an active holdover tenancy stays open through as-of after its last signed lease expires", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    await seedTenancy(fixture.db, {
      id: "resolver-holdover",
      propertyId: SYNTHETIC_COMPANY.propertyId,
      unitId: SYNTHETIC_COMPANY.unitId,
      personId: "resolver-person-holdover",
      status: "current",
      moveIn: "2024-01-01",
    });
    await fixture.db.query(
      `INSERT INTO rent_ops_lease_terms
        (id,tenancy_id,status,contract_start_on,contract_end_on,created_at)
       VALUES ('resolver-holdover-term','resolver-holdover','expired','2024-01-01','2024-12-31','2024-01-01T00:00:00Z')`,
    );
    const result = await resolveTenancySource(fixture.executor, {
      organizationId: SYNTHETIC_COMPANY.organizationId,
      tenancyId: "resolver-holdover",
      environment: ENVIRONMENT,
      asOf: "2026-09-26",
    });
    assert.ok(result);
    assert.equal(result.tenancy.endOn, null);
    assert.equal(result.ownership.coverageComplete, true);
    assert.equal(result.ownership.effectiveLegalEntityId, SYNTHETIC_COMPANY.entityId);
  } finally {
    await fixture.close();
  }
});

test("partial historical ownership coverage enters review instead of selecting the only overlapping owner", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    await fixture.db.exec(`
      INSERT INTO rent_ops_properties(id,name,slug) VALUES ('resolver-partial-property','Partial property','resolver-partial-property');
      INSERT INTO rent_ops_units(id,property_id,unit_number) VALUES ('resolver-partial-unit','resolver-partial-property','1');
      INSERT INTO company_property_entity_periods(id,organization_id,legal_entity_id,property_id,effective_from,effective_until)
        VALUES ('30000000-0000-4000-8000-000000000051','${SYNTHETIC_COMPANY.organizationId}','${SYNTHETIC_COMPANY.entityId}','resolver-partial-property','2020-01-01','2025-01-01');
    `);
    await seedTenancy(fixture.db, { id: "resolver-partial", propertyId: "resolver-partial-property", unitId: "resolver-partial-unit", personId: "resolver-person-partial", status: "past", moveIn: "2024-01-01", moveOut: "2026-01-01" });
    const result = await resolveTenancySource(fixture.executor, {
      organizationId: SYNTHETIC_COMPANY.organizationId,
      tenancyId: "resolver-partial",
      environment: ENVIRONMENT,
      asOf: "2026-09-26",
    });
    assert.ok(result);
    assert.equal(result.ownership.effectiveLegalEntityId, null);
    assert.equal(result.ownership.coverageComplete, false);
    assert.equal(result.currentState, "ownership_review");
    assert.equal(result.qbo.scope, null);
    assert.ok(result.reasons.some(reason => /full tenancy interval/.test(reason)));
  } finally {
    await fixture.close();
  }
});

test("missing archive dates and a null status remain local history with an explicit ownership review", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    await seedTenancy(fixture.db, { id: "resolver-unknown", propertyId: SYNTHETIC_COMPANY.propertyId, unitId: SYNTHETIC_COMPANY.unitId, personId: "resolver-person-unknown", status: null });
    await seedLedger(fixture.db, "resolver-unknown", SYNTHETIC_COMPANY.propertyId, SYNTHETIC_COMPANY.unitId, "resolver-person-unknown");
    const result = await resolveTenancySource(fixture.executor, {
      organizationId: SYNTHETIC_COMPANY.organizationId,
      tenancyId: "resolver-unknown",
      environment: ENVIRONMENT,
      asOf: "2026-09-26",
    });
    assert.ok(result);
    assert.equal(result.tenancy.status, null);
    assert.equal(result.tenancy.startOn, null);
    assert.equal(result.local.state, "local_history_available");
    assert.equal(result.currentState, "ownership_review");
    assert.ok(result.reasons.some(reason => /no verified move-in or lease start/.test(reason)));
  } finally {
    await fixture.close();
  }
});

test("an unknown historical status does not turn a missing termination date into ongoing occupancy", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    await seedTenancy(fixture.db, {
      id: "resolver-unknown-end",
      propertyId: SYNTHETIC_COMPANY.propertyId,
      unitId: SYNTHETIC_COMPANY.unitId,
      personId: "resolver-person-unknown-end",
      status: null,
      moveIn: "2024-01-01",
    });
    const result = await resolveTenancySource(fixture.executor, {
      organizationId: SYNTHETIC_COMPANY.organizationId,
      tenancyId: "resolver-unknown-end",
      environment: ENVIRONMENT,
      asOf: "2026-09-26",
    });
    assert.ok(result);
    assert.equal(result.tenancy.startOn, "2024-01-01");
    assert.equal(result.tenancy.endOn, null);
    assert.equal(result.ownership.coverageComplete, false);
    assert.equal(result.currentState, "ownership_review");
    assert.ok(result.reasons.some(reason => /no verified move-out/.test(reason)));
  } finally {
    await fixture.close();
  }
});

test("lease-only imported history stays unlinked until the historical customer link is attached", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    await seedTenancy(fixture.db, {
      id: "resolver-lease-only",
      propertyId: SYNTHETIC_COMPANY.propertyId,
      unitId: SYNTHETIC_COMPANY.unitId,
      personId: "resolver-person-lease-only",
      status: "past",
    });
    await fixture.db.query(
      `INSERT INTO rent_ops_lease_terms
        (id,tenancy_id,status,contract_start_on,contract_end_on,created_at)
       VALUES ('resolver-lease-only-term','resolver-lease-only','expired','2021-01-01','2021-12-31','2026-01-01T00:00:00Z')`,
    );
    await fixture.db.query(
      `INSERT INTO accounting_qbo_realm_bindings
        (organization_id,legal_entity_id,environment,realm_id,provider_company_id,provider_company_name,evidence_version,company_info_hash,confirmed_by)
       VALUES ($1,$2,$3,$4,'synthetic-company','Synthetic QBO','v1',$5,'synthetic-admin')`,
      [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId, ENVIRONMENT, REALM, "c".repeat(64)],
    );
    await fixture.db.query(
      `INSERT INTO accounting_qbo_connections
        (organization_id,legal_entity_id,environment,realm_id,
         encrypted_access_token,access_token_iv,access_token_auth_tag,
         encrypted_refresh_token,refresh_token_iv,refresh_token_auth_tag,
         access_token_expires_at,status)
       VALUES ($1,$2,$3,$4,'access','iv','tag','refresh','iv','tag',now() + interval '1 hour','active')`,
      [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId, ENVIRONMENT, REALM],
    );
    await fixture.db.query(
      `INSERT INTO company_external_identities
        (id,organization_id,legal_entity_id,provider,source_scope,record_kind,external_id,local_kind,local_id)
       VALUES
        ('50000000-0000-4000-8000-000000000061',$1,$2,'qbo',$3,'CompanyInfo','synthetic-company','legal_entity',$4)`,
      [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId, `qbo:${ENVIRONMENT}:${REALM}`, SYNTHETIC_COMPANY.entityId],
    );
    await fixture.db.query(
      `INSERT INTO accounting_qbo_source_objects
        (id,organization_id,legal_entity_id,environment,realm_id,object_type,object_id,object_version,body_hash,provider_body,provider_updated_at)
       VALUES ('60000000-0000-4000-8000-000000000061',$1,$2,$3,$4,'Customer','lease-customer','0',$5,'{"Id":"lease-customer","Active":true}',now())`,
      [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId, ENVIRONMENT, REALM, "d".repeat(64)],
    );

    const beforeLink = await resolveTenancySource(fixture.executor, {
      organizationId: SYNTHETIC_COMPANY.organizationId,
      tenancyId: "resolver-lease-only",
      environment: ENVIRONMENT,
      asOf: "2026-09-26",
    });
    assert.equal(beforeLink?.tenancy.startOn, "2021-01-01");
    assert.equal(beforeLink?.tenancy.endOn, "2021-12-31");
    assert.equal(beforeLink?.ownership.effectiveLegalEntityId, SYNTHETIC_COMPANY.entityId);
    assert.equal(beforeLink?.qbo.state, "unlinked");
    assert.equal(await resolveTenancyCustomer(fixture.executor, {
      organizationId: SYNTHETIC_COMPANY.organizationId,
      tenancyId: "resolver-lease-only",
      environment: ENVIRONMENT,
      asOf: "2026-09-26",
    }), null);

    const linked = await fixture.executor.transaction!(transaction => linkTenancyToQboCustomer(transaction, {
      scope: { provider: "qbo", organizationId: SYNTHETIC_COMPANY.organizationId, legalEntityId: SYNTHETIC_COMPANY.entityId, environment: ENVIRONMENT, realmId: REALM },
      tenancyId: "resolver-lease-only",
      customerObjectId: "lease-customer",
      asOf: "2026-09-26",
    }));
    assert.equal(linked.status, "linked");
    assert.deepEqual(await resolveTenancyCustomer(fixture.executor, {
      organizationId: SYNTHETIC_COMPANY.organizationId,
      tenancyId: "resolver-lease-only",
      environment: ENVIRONMENT,
      asOf: "2026-09-26",
    }), {
      scope: { provider: "qbo", organizationId: SYNTHETIC_COMPANY.organizationId, legalEntityId: SYNTHETIC_COMPANY.entityId, environment: ENVIRONMENT, realmId: REALM },
      customerObjectId: "lease-customer",
    });
    const afterLink = await resolveTenancySource(fixture.executor, {
      organizationId: SYNTHETIC_COMPANY.organizationId,
      tenancyId: "resolver-lease-only",
      environment: ENVIRONMENT,
      asOf: "2026-09-26",
    });
    assert.equal(afterLink?.qbo.state, "linked");
    assert.equal(afterLink?.currentState, "linked");
  } finally {
    await fixture.close();
  }
});

test("the HTTP resolver authorizes the historical entity and returns an unlinked historical scope", async () => {
  const fixture = await createCompanyDemoApp();
  const listener = fixture.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  try {
    const tenancy = (await fixture.database.executor.query<{ id: string }>(
      `SELECT t.id FROM rent_ops_tenancies t
        WHERE t.property_id=$1 AND EXISTS (
          SELECT 1 FROM company_property_entity_periods m
           WHERE m.organization_id=$2 AND m.property_id=t.property_id
        ) ORDER BY t.id LIMIT 1`,
      [SYNTHETIC_COMPANY.propertyId, SYNTHETIC_COMPANY.organizationId],
    )).rows[0];
    assert.ok(tenancy);
    await fixture.database.executor.query(
      `INSERT INTO accounting_qbo_realm_bindings
        (organization_id,legal_entity_id,environment,realm_id,provider_company_id,provider_company_name,evidence_version,company_info_hash,confirmed_by)
       VALUES ($1,$2,'production',$3,'synthetic-company','Synthetic QBO','v1',$4,'synthetic-admin')`,
      [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId, REALM, "b".repeat(64)],
    );
    await fixture.database.executor.query(
      `INSERT INTO accounting_qbo_connections
        (organization_id,legal_entity_id,environment,realm_id,
         encrypted_access_token,access_token_iv,access_token_auth_tag,
         encrypted_refresh_token,refresh_token_iv,refresh_token_auth_tag,
         access_token_expires_at,status)
       VALUES ($1,$2,'production',$3,'access','iv','tag','refresh','iv','tag',now() + interval '1 hour','active')`,
      [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId, REALM],
    );
    const listenerAddress = listener.address() as AddressInfo;
    const url = `http://127.0.0.1:${listenerAddress.port}/api/company/${SYNTHETIC_COMPANY.organizationId}/accounting/qbo/receivables/tenancy-source-resolution?${new URLSearchParams({ tenancyId: tenancy.id, environment: "production", asOf: "2026-09-26" })}`;
    const response = await fetch(url);
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as { currentState: string; qbo: { state: string; scope: { legalEntityId: string } | null } };
    assert.equal(body.currentState, "unlinked");
    assert.equal(body.qbo.state, "unlinked");
    assert.equal(body.qbo.scope?.legalEntityId, SYNTHETIC_COMPANY.entityId);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await fixture.close();
  }
});
