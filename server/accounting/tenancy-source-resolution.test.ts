import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createCompanyDemoApp } from "../company/demo";
import { createSyntheticCompanyDatabase, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { linkTenancyToQboCustomer } from "./receivables-links";
import { resolveTenancyCustomer } from "./receivables-read";
import { resolveTenancySource } from "./tenancy-source-resolution";
import { createQboTokenCipher } from "./token-crypto";

const ENVIRONMENT = "production" as const;
const REALM = "4620816365000001";
let customerLinkSequence = 100;

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

async function seedCustomerLink(
  db: Awaited<ReturnType<typeof createSyntheticCompanyDatabase>>["db"],
  input: { tenancyId: string; customerObjectId: string; legalEntityId?: string; environment?: "sandbox" | "production"; realmId?: string; id?: string },
): Promise<void> {
  const environment = input.environment ?? ENVIRONMENT;
  const realmId = input.realmId ?? REALM;
  await db.query(
    `INSERT INTO company_external_identities
      (id,organization_id,legal_entity_id,provider,source_scope,record_kind,external_id,local_kind,local_id)
     VALUES ($1,$2,$3,'qbo',$4,'Customer',$5,'tenancy',$6)`,
    [input.id ?? `50000000-0000-4000-8000-${(customerLinkSequence++).toString(16).padStart(12, "0")}`, SYNTHETIC_COMPANY.organizationId,
      input.legalEntityId ?? SYNTHETIC_COMPANY.entityId, `qbo:${environment}:${realmId}`, input.customerObjectId, input.tenancyId],
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

test("a tenant inherited at acquisition resolves to the acquiring entity for the owned period", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    await fixture.db.exec(`
      INSERT INTO rent_ops_properties(id,name,slug) VALUES ('resolver-acquired-property','Acquired property','resolver-acquired-property');
      INSERT INTO rent_ops_units(id,property_id,unit_number) VALUES ('resolver-acquired-unit','resolver-acquired-property','1');
      INSERT INTO company_property_entity_periods(id,organization_id,legal_entity_id,property_id,effective_from)
        VALUES ('30000000-0000-4000-8000-000000000052','${SYNTHETIC_COMPANY.organizationId}','${SYNTHETIC_COMPANY.entityId}','resolver-acquired-property','2025-06-01');
    `);
    // Moved in under the prior owner, still in place after the acquisition.
    await seedTenancy(fixture.db, { id: "resolver-inherited", propertyId: "resolver-acquired-property", unitId: "resolver-acquired-unit", personId: "resolver-person-inherited", status: "current", moveIn: "2022-03-01" });
    const result = await resolveTenancySource(fixture.executor, {
      organizationId: SYNTHETIC_COMPANY.organizationId,
      tenancyId: "resolver-inherited",
      environment: ENVIRONMENT,
      asOf: "2026-09-26",
    });
    assert.ok(result);
    assert.equal(result.ownership.coverageComplete, true);
    assert.equal(result.ownership.effectiveLegalEntityId, SYNTHETIC_COMPANY.entityId);
    assert.notEqual(result.currentState, "ownership_review");

    // A tenancy that ended before the acquisition is not attributed to the acquirer.
    await seedTenancy(fixture.db, { id: "resolver-pre-acquisition", propertyId: "resolver-acquired-property", unitId: "resolver-acquired-unit", personId: "resolver-person-pre", status: "past", moveIn: "2021-01-01", moveOut: "2024-12-31" });
    const prior = await resolveTenancySource(fixture.executor, {
      organizationId: SYNTHETIC_COMPANY.organizationId,
      tenancyId: "resolver-pre-acquisition",
      environment: ENVIRONMENT,
      asOf: "2026-09-26",
    });
    assert.equal(prior?.ownership.effectiveLegalEntityId, null);
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

test("an existing QBO link stays readable with a missing-date warning while effective ownership remains null", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    await seedTenancy(fixture.db, { id: "resolver-linked-no-dates", propertyId: SYNTHETIC_COMPANY.propertyId, unitId: SYNTHETIC_COMPANY.unitId, personId: "resolver-person-linked-no-dates", status: "past" });
    await seedLedger(fixture.db, "resolver-linked-no-dates", SYNTHETIC_COMPANY.propertyId, SYNTHETIC_COMPANY.unitId, "resolver-person-linked-no-dates");
    await seedBindingAndConnection(fixture.db);
    await fixture.db.query(
      `INSERT INTO company_external_identities
        (id,organization_id,legal_entity_id,provider,source_scope,record_kind,external_id,local_kind,local_id)
       VALUES ('50000000-0000-4000-8000-000000000071',$1,$2::uuid,'qbo',$3,'CompanyInfo','synthetic-company','legal_entity',$2::text)`,
      [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId, `qbo:${ENVIRONMENT}:${REALM}`],
    );

    await assert.rejects(fixture.executor.transaction!(transaction => linkTenancyToQboCustomer(transaction, {
      scope: { provider: "qbo", organizationId: SYNTHETIC_COMPANY.organizationId, legalEntityId: SYNTHETIC_COMPANY.entityId, environment: ENVIRONMENT, realmId: REALM },
      tenancyId: "resolver-linked-no-dates",
      customerObjectId: "customer-no-dates",
      asOf: "2026-09-26",
    })), (error: unknown) => error instanceof Error && /not found/.test(error.message));

    await seedCustomerLink(fixture.db, { tenancyId: "resolver-linked-no-dates", customerObjectId: "customer-no-dates" });
    const result = await resolveTenancySource(fixture.executor, {
      organizationId: SYNTHETIC_COMPANY.organizationId,
      tenancyId: "resolver-linked-no-dates",
      environment: ENVIRONMENT,
      asOf: "2026-09-26",
    });
    assert.ok(result);
    assert.equal(result.currentState, "linked");
    assert.equal(result.qbo.state, "linked");
    assert.equal(result.ownership.state, "linked_dates_missing");
    assert.equal(result.ownership.coverageComplete, false);
    assert.equal(result.ownership.effectiveLegalEntityId, null);
    assert.equal(result.ownership.effectiveLegalEntityName, null);
    assert.deepEqual(result.qbo.scope, {
      provider: "qbo",
      organizationId: SYNTHETIC_COMPANY.organizationId,
      legalEntityId: SYNTHETIC_COMPANY.entityId,
      environment: ENVIRONMENT,
      realmId: REALM,
    });
    assert.deepEqual(result.qbo.customerLink, { customerObjectId: "customer-no-dates", legalEntityId: SYNTHETIC_COMPANY.entityId });
    assert.ok(result.reasons.some(reason => /Move-in and move-out dates missing/.test(reason)));
    assert.equal(result.reasons.some(reason => /No historical legal-entity assignment overlaps/.test(reason)), false);

    const customer = await resolveTenancyCustomer(fixture.executor, {
      organizationId: SYNTHETIC_COMPANY.organizationId,
      tenancyId: "resolver-linked-no-dates",
      environment: ENVIRONMENT,
      asOf: "2026-09-26",
    });
    assert.deepEqual(customer, {
      scope: { provider: "qbo", organizationId: SYNTHETIC_COMPANY.organizationId, legalEntityId: SYNTHETIC_COMPANY.entityId, environment: ENVIRONMENT, realmId: REALM },
      customerObjectId: "customer-no-dates",
      propertyId: SYNTHETIC_COMPANY.propertyId,
      linkedLegalEntityId: SYNTHETIC_COMPANY.entityId,
      ownershipWarning: "Move-in and move-out dates missing. Add them to confirm ownership.",
    });
  } finally {
    await fixture.close();
  }
});

test("mapped-period boundaries reject expired and gap dates but preserve inherited pre-acquisition occupancy", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    await fixture.db.exec(`
      INSERT INTO rent_ops_properties(id,name,slug) VALUES
        ('resolver-expired-end','Expired end','resolver-expired-end'),
        ('resolver-current-expired','Current expired','resolver-current-expired'),
        ('resolver-start-gap','Start gap','resolver-start-gap'),
        ('resolver-inherited-missing-end','Inherited missing end','resolver-inherited-missing-end');
      INSERT INTO rent_ops_units(id,property_id,unit_number) VALUES
        ('resolver-expired-end-unit','resolver-expired-end','1'),
        ('resolver-current-expired-unit','resolver-current-expired','1'),
        ('resolver-start-gap-unit','resolver-start-gap','1'),
        ('resolver-inherited-missing-end-unit','resolver-inherited-missing-end','1');
      INSERT INTO company_property_entity_periods(id,organization_id,legal_entity_id,property_id,effective_from,effective_until) VALUES
        ('30000000-0000-4000-8000-000000000071','${SYNTHETIC_COMPANY.organizationId}','${SYNTHETIC_COMPANY.entityId}','resolver-expired-end','2020-01-01','2025-01-01'),
        ('30000000-0000-4000-8000-000000000072','${SYNTHETIC_COMPANY.organizationId}','${SYNTHETIC_COMPANY.entityId}','resolver-current-expired','2020-01-01','2025-01-01'),
        ('30000000-0000-4000-8000-000000000073','${SYNTHETIC_COMPANY.organizationId}','${SYNTHETIC_COMPANY.entityId}','resolver-start-gap','2020-01-01','2022-01-01'),
        ('30000000-0000-4000-8000-000000000074','${SYNTHETIC_COMPANY.organizationId}','${SYNTHETIC_COMPANY.entityId}','resolver-start-gap','2025-01-01',NULL),
        ('30000000-0000-4000-8000-000000000075','${SYNTHETIC_COMPANY.organizationId}','${SYNTHETIC_COMPANY.entityId}','resolver-inherited-missing-end','2020-01-01',NULL);
    `);
    await seedTenancy(fixture.db, { id: "resolver-end-after-expiry", propertyId: "resolver-expired-end", unitId: "resolver-expired-end-unit", personId: "resolver-person-end-after-expiry", status: "past", moveOut: "2025-02-01" });
    await seedTenancy(fixture.db, { id: "resolver-current-after-expiry", propertyId: "resolver-current-expired", unitId: "resolver-current-expired-unit", personId: "resolver-person-current-after-expiry", status: "current" });
    await seedTenancy(fixture.db, { id: "resolver-start-in-gap", propertyId: "resolver-start-gap", unitId: "resolver-start-gap-unit", personId: "resolver-person-start-in-gap", status: "past", moveIn: "2023-01-01" });
    await seedTenancy(fixture.db, { id: "resolver-inherited-missing-end", propertyId: "resolver-inherited-missing-end", unitId: "resolver-inherited-missing-end-unit", personId: "resolver-person-inherited-missing-end", status: "past", moveIn: "2019-01-01" });
    await seedCustomerLink(fixture.db, { tenancyId: "resolver-end-after-expiry", customerObjectId: "customer-expired-end" });
    await seedCustomerLink(fixture.db, { tenancyId: "resolver-current-after-expiry", customerObjectId: "customer-current-expired" });
    await seedCustomerLink(fixture.db, { tenancyId: "resolver-start-in-gap", customerObjectId: "customer-start-gap" });
    await seedCustomerLink(fixture.db, { tenancyId: "resolver-inherited-missing-end", customerObjectId: "customer-inherited-missing-end" });

    const resolve = (tenancyId: string) => resolveTenancyCustomer(fixture.executor, {
      organizationId: SYNTHETIC_COMPANY.organizationId, tenancyId, environment: ENVIRONMENT, asOf: "2026-09-26",
    });
    assert.equal((await resolve("resolver-end-after-expiry"))?.scope, null, "known move-out after ownership expired is a conflict");
    assert.equal((await resolve("resolver-current-after-expiry"))?.scope, null, "a current tenancy cannot extend beyond the mapped ownership period");
    assert.equal((await resolve("resolver-start-in-gap"))?.scope, null, "a known move-in in a later ownership gap is a conflict");
    const inherited = await resolve("resolver-inherited-missing-end");
    assert.ok(inherited?.scope, "a pre-acquisition move-in can still be inherited");
    assert.equal(inherited?.ownershipWarning, "Move-out or termination date missing. Add it to confirm ownership.");
  } finally {
    await fixture.close();
  }
});

test("an existing link is returned for review on multi-owner, mismatched-entity, and duplicate identities", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    await fixture.db.exec(`
      INSERT INTO company_legal_entities(id,organization_id,name,entity_type,currency)
        VALUES('20000000-0000-4000-8000-000000000071','${SYNTHETIC_COMPANY.organizationId}','Second Property LLC','llc','USD');
      INSERT INTO rent_ops_properties(id,name,slug) VALUES ('resolver-two-owner-property','Two owner property','resolver-two-owner-property');
      INSERT INTO rent_ops_units(id,property_id,unit_number) VALUES ('resolver-two-owner-unit','resolver-two-owner-property','1');
      INSERT INTO company_property_entity_periods(id,organization_id,legal_entity_id,property_id,effective_from,effective_until)
        VALUES ('30000000-0000-4000-8000-000000000076','${SYNTHETIC_COMPANY.organizationId}','${SYNTHETIC_COMPANY.entityId}','resolver-two-owner-property','2020-01-01','2023-01-01'),
               ('30000000-0000-4000-8000-000000000077','${SYNTHETIC_COMPANY.organizationId}','20000000-0000-4000-8000-000000000071','resolver-two-owner-property','2023-01-01',NULL);
    `);
    await seedTenancy(fixture.db, { id: "resolver-multi-owner-link", propertyId: "resolver-two-owner-property", unitId: "resolver-two-owner-unit", personId: "resolver-person-multi-owner-link", status: "past" });
    await seedTenancy(fixture.db, { id: "resolver-mismatched-link", propertyId: SYNTHETIC_COMPANY.propertyId, unitId: SYNTHETIC_COMPANY.unitId, personId: "resolver-person-mismatched-link", status: "past", moveIn: "2021-01-01", moveOut: "2022-01-01" });
    await seedCustomerLink(fixture.db, { tenancyId: "resolver-multi-owner-link", customerObjectId: "customer-multi-owner" });
    await seedCustomerLink(fixture.db, { tenancyId: "resolver-mismatched-link", customerObjectId: "customer-mismatched", legalEntityId: "20000000-0000-4000-8000-000000000071" });

    const multi = await resolveTenancySource(fixture.executor, {
      organizationId: SYNTHETIC_COMPANY.organizationId, tenancyId: "resolver-multi-owner-link", environment: ENVIRONMENT, asOf: "2026-09-26",
    });
    assert.equal(multi?.ownership.state, "review");
    assert.equal(multi?.ownership.effectiveLegalEntityId, null);
    assert.equal(multi?.qbo.state, "ownership_review");
    assert.equal(multi?.qbo.scope, null);
    assert.deepEqual(multi?.qbo.customerLink, { customerObjectId: "customer-multi-owner", legalEntityId: SYNTHETIC_COMPANY.entityId });
    assert.ok((await resolveTenancyCustomer(fixture.executor, {
      organizationId: SYNTHETIC_COMPANY.organizationId, tenancyId: "resolver-multi-owner-link", environment: ENVIRONMENT,
    }))?.ownershipWarning);

    const mismatch = await resolveTenancySource(fixture.executor, {
      organizationId: SYNTHETIC_COMPANY.organizationId, tenancyId: "resolver-mismatched-link", environment: ENVIRONMENT, asOf: "2026-09-26",
    });
    assert.equal(mismatch?.ownership.state, "review");
    assert.equal(mismatch?.qbo.scope, null);
    assert.deepEqual(mismatch?.qbo.customerLink, { customerObjectId: "customer-mismatched", legalEntityId: "20000000-0000-4000-8000-000000000071" });
    const mismatchedRead = await resolveTenancyCustomer(fixture.executor, {
      organizationId: SYNTHETIC_COMPANY.organizationId, tenancyId: "resolver-mismatched-link", environment: ENVIRONMENT,
    });
    assert.ok(mismatchedRead);
    assert.equal(mismatchedRead.scope, null);
    assert.equal(mismatchedRead.linkedLegalEntityId, "20000000-0000-4000-8000-000000000071");
    assert.ok(mismatchedRead.ownershipWarning);

    await seedCustomerLink(fixture.db, { tenancyId: "resolver-multi-owner-link", customerObjectId: "customer-duplicate", realmId: "4620816365000002" });
    await assert.rejects(resolveTenancySource(fixture.executor, {
      organizationId: SYNTHETIC_COMPANY.organizationId, tenancyId: "resolver-multi-owner-link", environment: ENVIRONMENT, asOf: "2026-09-26",
    }), (error: unknown) => error instanceof Error && /more than one QuickBooks customer/.test(error.message));
    await assert.rejects(resolveTenancyCustomer(fixture.executor, {
      organizationId: SYNTHETIC_COMPANY.organizationId, tenancyId: "resolver-multi-owner-link", environment: ENVIRONMENT,
    }), (error: unknown) => error instanceof Error && /more than one QuickBooks customer/.test(error.message));
  } finally {
    await fixture.close();
  }
});

test("a legal entity mapped in another company blocks missing-date fallback without leaking foreign ownership", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    await fixture.db.exec(`
      INSERT INTO company_organizations(id,name) VALUES('10000000-0000-4000-8000-000000000071','Other Synthetic Company');
      INSERT INTO company_legal_entities(id,organization_id,name,entity_type,currency)
        VALUES('20000000-0000-4000-8000-000000000072','10000000-0000-4000-8000-000000000071','Foreign Owner LLC','llc','USD');
      INSERT INTO company_property_entity_periods(id,organization_id,legal_entity_id,property_id,effective_from,effective_until)
        VALUES('30000000-0000-4000-8000-000000000078','10000000-0000-4000-8000-000000000071','20000000-0000-4000-8000-000000000072','${SYNTHETIC_COMPANY.propertyId}','2010-01-01','2020-01-01');
    `);
    await seedTenancy(fixture.db, { id: "resolver-cross-company-link", propertyId: SYNTHETIC_COMPANY.propertyId, unitId: SYNTHETIC_COMPANY.unitId, personId: "resolver-person-cross-company-link", status: "past" });
    await seedCustomerLink(fixture.db, { tenancyId: "resolver-cross-company-link", customerObjectId: "customer-cross-company" });
    const result = await resolveTenancySource(fixture.executor, {
      organizationId: SYNTHETIC_COMPANY.organizationId, tenancyId: "resolver-cross-company-link", environment: ENVIRONMENT, asOf: "2026-09-26",
    });
    assert.equal(result?.ownership.state, "review");
    assert.equal(result?.qbo.scope, null);
    assert.deepEqual(result?.qbo.customerLink, { customerObjectId: "customer-cross-company", legalEntityId: SYNTHETIC_COMPANY.entityId });
    assert.equal(JSON.stringify(result).includes("20000000-0000-4000-8000-000000000072"), false);
    const read = await resolveTenancyCustomer(fixture.executor, {
      organizationId: SYNTHETIC_COMPANY.organizationId, tenancyId: "resolver-cross-company-link", environment: ENVIRONMENT,
    });
    assert.equal(read?.scope, null);
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
      propertyId: SYNTHETIC_COMPANY.propertyId,
      linkedLegalEntityId: SYNTHETIC_COMPANY.entityId,
      ownershipWarning: null,
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

test("the HTTP resolver defaults to the deployment's configured QuickBooks environment", async () => {
  const fixture = await createCompanyDemoApp({
    accountingQbo: {
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "http://localhost:4178/api/accounting/qbo/callback",
      environment: "sandbox",
      tokenCipher: createQboTokenCipher(Buffer.alloc(32, 7)),
      discovery: false,
    },
  });
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
    // Only a production binding exists. A sandbox deployment must not select it.
    await fixture.database.executor.query(
      `INSERT INTO accounting_qbo_realm_bindings
        (organization_id,legal_entity_id,environment,realm_id,provider_company_id,provider_company_name,evidence_version,company_info_hash,confirmed_by)
       VALUES ($1,$2,'production',$3,'synthetic-company','Synthetic QBO','v1',$4,'synthetic-admin')`,
      [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId, REALM, "c".repeat(64)],
    );
    const port = (listener.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/api/company/${SYNTHETIC_COMPANY.organizationId}/accounting/qbo/receivables/tenancy-source-resolution?${new URLSearchParams({ tenancyId: tenancy.id, asOf: "2026-09-26" })}`;
    const response = await fetch(url);
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as { qbo: { environment: string; binding: unknown; scope: unknown } };
    assert.equal(body.qbo.environment, "sandbox");
    assert.equal(body.qbo.binding, null);
    assert.equal(body.qbo.scope, null);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await fixture.close();
  }
});
