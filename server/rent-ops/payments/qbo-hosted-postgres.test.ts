import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../../company/testing/synthetic-database";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../repositories/postgres";
import type { TenantIdentity } from "../../../shared/tenant-portal-contracts";
import { createQboHostedPaymentService, qboHostedConfigFromEnv } from "./qbo-hosted";

const REALM = "4620816365001234567";
const PERSON_ID = "synthetic-qbo-person";
const TENANCY_ID = "synthetic-qbo-tenancy";
const ACCOUNT_ID = "synthetic-qbo-account";
const CUSTOMER_ID = "synthetic-qbo-customer";
const INVOICE_ID = "synthetic-qbo-invoice";
const EMAIL = "resident@synthetic-payments.demo";
const NOW = new Date("2026-09-27T12:00:00.000Z");
const LINK = "https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-synthetic";

function runtimeExecutor(connection: any): RentOpsQueryExecutor {
  return {
    async query<T>(sql: string, values?: unknown[]) {
      // PGlite runs the fixture as its database owner. Match the runtime-role
      // privilege result expected by PostgresRentOpsRepository; every other
      // query still executes against the real disposable database.
      if (sql.includes("has_table_privilege")) {
        return { rows: ((values?.[0] as string[]) ?? []).map(table_name => ({
          table_name, can_select: false, can_insert: false, can_update: false, can_delete: false,
          can_truncate: false, can_references: false, can_trigger: false,
        })) as T[] };
      }
      return connection.query(sql, values?.map(value => value === undefined ? null : value));
    },
    transaction<T>(work: (executor: RentOpsQueryExecutor) => Promise<T>) {
      return connection.transaction
        ? connection.transaction((transaction: any) => work(runtimeExecutor(transaction)))
        : work(runtimeExecutor(connection));
    },
  };
}

async function createNativeTenantFixture() {
  const database = await createSyntheticCompanyDatabase();
  const ownerExecutor = runtimeExecutor(database.db);
  const repository = new PostgresRentOpsRepository(ownerExecutor);
  try {
    await database.db.query("INSERT INTO rent_ops_people(id,first_name,last_name,email) VALUES ($1,'Synthetic','Resident',$2)", [PERSON_ID, EMAIL]);
    await database.db.query("UPDATE rent_ops_units SET property_link_knowledge='manual' WHERE id=$1", [SYNTHETIC_COMPANY.unitId]);
    await database.db.query(
      `INSERT INTO rent_ops_tenancies
         (id,property_id,unit_id,primary_person_id,status,actual_move_in_on,created_at,
          property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge,status_knowledge,actual_move_in_knowledge)
       VALUES ($1,$2,$3,$4,'current','2026-01-01','2026-01-01T00:00:00Z','manual','manual','manual','manual','manual')`,
      [TENANCY_ID, SYNTHETIC_COMPANY.propertyId, SYNTHETIC_COMPANY.unitId, PERSON_ID],
    );
    await database.db.query(
      "INSERT INTO rent_ops_tenant_accounts(id,email,person_id,tenancy_id,status,password_hash) VALUES ($1,$2,$3,$4,'active',$5)",
      [ACCOUNT_ID, EMAIL, PERSON_ID, TENANCY_ID, `scrypt.v1.${"a".repeat(64)}.${"b".repeat(128)}`],
    );
    await database.db.query(
      `INSERT INTO accounting_qbo_realm_bindings
         (organization_id,legal_entity_id,environment,realm_id,provider_company_id,provider_company_name,evidence_version,company_info_hash,confirmed_by)
       VALUES ($1,$2,'production',$3,'synthetic-provider-company','Synthetic QBO','v1',$4,'synthetic-test')`,
      [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId, REALM, "a".repeat(64)],
    );
    await database.db.query(
      `INSERT INTO accounting_qbo_connections
         (organization_id,legal_entity_id,environment,realm_id,
          encrypted_access_token,access_token_iv,access_token_auth_tag,
          encrypted_refresh_token,refresh_token_iv,refresh_token_auth_tag,access_token_expires_at,status)
       VALUES ($1,$2,'production',$3,'ciphertext','iv','tag','ciphertext','iv','tag',now()+interval '1 hour','active')`,
      [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId, REALM],
    );
    await database.db.query(
      `INSERT INTO accounting_qbo_capabilities
         (organization_id,legal_entity_id,environment,realm_id,capability,enabled,evidence,evidence_version,verified_at)
       VALUES ($1,$2,'production',$3,'accounting.read',true,'live_provider_readback','synthetic-test',now())`,
      [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId, REALM],
    );
    await database.db.query(
      `INSERT INTO company_external_identities
         (id,organization_id,legal_entity_id,provider,source_scope,record_kind,external_id,local_kind,local_id)
       VALUES ('60000000-0000-4000-8000-000000000001',$1,$2,'qbo',$3,'Customer',$4,'tenancy',$5)`,
      [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId, `qbo:production:${REALM}`, CUSTOMER_ID, TENANCY_ID],
    );
    await repository.saveLedgerTransaction({
      id: "synthetic-native-rent",
      propertyId: SYNTHETIC_COMPANY.propertyId,
      unitId: SYNTHETIC_COMPANY.unitId,
      tenancyId: TENANCY_ID,
      personId: PERSON_ID,
      kind: "charge",
      category: "base_rent",
      categoryKnowledge: "manual",
      status: "posted",
      statusKnowledge: "manual",
      amountCents: 12500,
      amountKnowledge: "known",
      postedOn: "2026-09-01",
      postedOnKnowledge: "manual",
      dueOn: "2026-09-01",
      dueOnKnowledge: "manual",
      description: "Synthetic September rent",
      descriptionKnowledge: "manual",
      payer: "tenant",
      payerKnowledge: "manual",
      propertyLinkKnowledge: "manual",
      unitLinkKnowledge: "manual",
      tenancyLinkKnowledge: "manual",
      personLinkKnowledge: "manual",
      chargeDefinitionId: null,
      chargeDefinitionLinkKnowledge: "unknown",
      paymentMethod: null,
      paymentMethodKnowledge: "unknown",
    });
    const executor = await createSyntheticRuntimeExecutor(database.db);
    return { database, executor };
  } catch (error) {
    await database.close();
    throw error;
  }
}

function providerInvoice(overrides: Record<string, unknown> = {}) {
  return {
    Id: INVOICE_ID,
    SyncToken: "4",
    CustomerRef: { value: CUSTOMER_ID },
    DocNumber: "SYNTHETIC-INV-1",
    Balance: "125.00",
    CurrencyRef: { value: "USD" },
    BillEmail: { Address: EMAIL },
    AllowOnlinePayment: true,
    DueDate: "2026-10-01",
    InvoiceLink: LINK,
    ...overrides,
  };
}

function providerCustomer(overrides: Record<string, unknown> = {}) {
  return {
    Id: CUSTOMER_ID,
    Active: true,
    PrimaryEmailAddr: { Address: EMAIL },
    Balance: "125.00",
    ...overrides,
  };
}

function createService(executor: RentOpsQueryExecutor, state: { invoice: Record<string, unknown>; customer: Record<string, unknown> }, providerCalls: string[]) {
  const identity: TenantIdentity = { id: ACCOUNT_ID, personId: PERSON_ID, tenancyId: TENANCY_ID, email: EMAIL, status: "active" };
  const config = qboHostedConfigFromEnv({
    RENT_OPS_TENANT_CHECKOUT_ENABLED: "true",
    RENT_OPS_QBO_HOSTED_PAYMENTS_ENABLED: "true",
    RENT_OPS_QBO_HOSTED_PAYMENTS_CONFIG_JSON: JSON.stringify({ entities: [{
      organizationId: SYNTHETIC_COMPANY.organizationId,
      legalEntityId: SYNTHETIC_COMPANY.entityId,
      environment: "production",
      realmId: REALM,
      readiness: { enrolled: true, businessVerified: true, payoutBankVerified: true, receiptEmailsAllowed: true, receiptReconciliationVerified: true },
      invoices: [{
        invoiceId: INVOICE_ID,
        invoiceNumber: "SYNTHETIC-INV-1",
        invoiceSyncToken: "4",
        balanceCents: "12500",
        customerId: CUSTOMER_ID,
        tenancyId: TENANCY_ID,
        personId: PERSON_ID,
        tenantAccountId: ACCOUNT_ID,
        tenantEmail: EMAIL,
        expiresAt: "2027-01-01T00:00:00.000Z",
      }],
    }] }),
  });
  const client = {
    async read(entity: string, id: string) {
      providerCalls.push(`read:${entity}:${id}`);
      return { entity: state.customer };
    },
    async readInvoiceWithLink(id: string) {
      providerCalls.push(`link:${id}`);
      return id === INVOICE_ID ? state.invoice : null;
    },
    async query() {
      providerCalls.push("query:invoice-history");
      const { InvoiceLink: _ignored, ...row } = state.invoice;
      return { entities: [row], startPosition: 1, maxResults: 1 };
    },
  };
  const service = createQboHostedPaymentService({
    executor,
    config,
    clientFor(scope) {
      assert.deepEqual(scope, {
        provider: "qbo",
        organizationId: SYNTHETIC_COMPANY.organizationId,
        legalEntityId: SYNTHETIC_COMPANY.entityId,
        environment: "production",
        realmId: REALM,
      });
      return client;
    },
    now: () => NOW,
  });
  return { service, identity };
}

test("hosted service executes tenant, ownership, realm, connection, and customer-map SQL on real schema", async () => {
  const fixture = await createNativeTenantFixture();
  const state = { invoice: providerInvoice(), customer: providerCustomer() };
  const calls: string[] = [];
  const { service, identity } = createService(fixture.executor, state, calls);
  try {
    const view = await service.getTenantView({ organizationId: SYNTHETIC_COMPANY.organizationId, identity });
    assert.deepEqual(view.invoices, [{ id: INVOICE_ID, number: "SYNTHETIC-INV-1", balanceCents: "12500", dueDate: "2026-10-01" }], JSON.stringify({ reasons: view.reasons, calls }));
    assert.equal(calls.length, 3, "the exact current binding reaches the read-only provider client");

    calls.length = 0;
    const wrongIdentity = { ...identity, email: "other@synthetic-payments.demo" };
    const wrong = await service.getTenantView({ organizationId: SYNTHETIC_COMPANY.organizationId, identity: wrongIdentity });
    assert.equal(wrong.available, false);
    assert.equal(calls.length, 0, "an account identity mismatch blocks before provider work");

    await fixture.database.db.query("UPDATE rent_ops_tenant_accounts SET status='revoked',password_hash=NULL WHERE id=$1", [ACCOUNT_ID]);
    const revoked = await service.getTenantView({ organizationId: SYNTHETIC_COMPANY.organizationId, identity });
    assert.equal(revoked.available, false);
    assert.equal(calls.length, 0, "a deactivated native tenant binding blocks before provider work");
  } finally {
    await fixture.database.close();
  }
});

test("hosted service revalidates native invoice and customer after GET before link POST", async () => {
  for (const mutation of [
    { label: "invoice SyncToken", apply: (state: { invoice: Record<string, unknown>; customer: Record<string, unknown> }) => { state.invoice.SyncToken = "5"; } },
    { label: "customer email", apply: (state: { invoice: Record<string, unknown>; customer: Record<string, unknown> }) => { state.customer.PrimaryEmailAddr = { Address: "changed@synthetic-payments.demo" }; } },
  ]) {
    const fixture = await createNativeTenantFixture();
    try {
      const state = { invoice: providerInvoice(), customer: providerCustomer() };
      const calls: string[] = [];
      const { service, identity } = createService(fixture.executor, state, calls);
      const view = await service.getTenantView({ organizationId: SYNTHETIC_COMPANY.organizationId, identity });
      assert.equal(view.available, true, `${mutation.label}: initial GET is available`);
      mutation.apply(state);
      await assert.rejects(
        () => service.getInvoiceLink({ organizationId: SYNTHETIC_COMPANY.organizationId, identity, invoiceId: INVOICE_ID }),
        error => typeof error === "object" && error !== null && "status" in error && error.status === 404,
        `${mutation.label}: stale native state must refuse the link POST`,
      );
    } finally {
      await fixture.database.close();
    }
  }
});
