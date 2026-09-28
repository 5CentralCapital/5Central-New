import assert from "node:assert/strict";
import test from "node:test";
import {
  createQboHostedPaymentService,
  qboCustomerInvoiceQueryIsComplete,
  qboHostedConfigFromEnv,
  type QboHostedPaymentsConfig,
} from "./qbo-hosted";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../repositories/postgres";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import type { TenantIdentity } from "../../../shared/tenant-portal-contracts";

const organizationId = "10000000-0000-4000-8000-000000000001";
const legalEntityId = "20000000-0000-4000-8000-000000000001";

function envConfig(readiness: Record<string, boolean> = {}) {
  return JSON.stringify({ entities: [{
    organizationId,
    legalEntityId,
    environment: "production",
    realmId: "4620816365001234567",
    readiness,
    invoices: [{
      invoiceId: "invoice-1", invoiceNumber: "INV-1", invoiceSyncToken: "4", balanceCents: "12500",
      customerId: "customer-1", tenancyId: "tenancy-1", personId: "person-1", tenantAccountId: "account-1",
      tenantEmail: "resident@example.test", expiresAt: "2027-01-01T00:00:00.000Z",
    }],
  }] });
}

test("hosted payments stay off unless both the existing checkout switch and the QB switch are explicitly enabled", () => {
  const absent = qboHostedConfigFromEnv({});
  assert.equal(absent.enabled, false);
  assert.equal(absent.tenantCheckoutEnabled, false);
  assert.equal(absent.configurationValid, true);
  assert.deepEqual(absent.entities, []);

  const qboOnly = qboHostedConfigFromEnv({ RENT_OPS_QBO_HOSTED_PAYMENTS_ENABLED: "true", RENT_OPS_QBO_HOSTED_PAYMENTS_CONFIG_JSON: envConfig() });
  assert.equal(qboOnly.enabled, false);
  assert.equal(qboOnly.tenantCheckoutEnabled, false);
  assert.equal(qboOnly.entities[0]?.readiness.receiptReconciliationVerified, false);

  const both = qboHostedConfigFromEnv({ RENT_OPS_TENANT_CHECKOUT_ENABLED: "true", RENT_OPS_QBO_HOSTED_PAYMENTS_ENABLED: "true", RENT_OPS_QBO_HOSTED_PAYMENTS_CONFIG_JSON: envConfig() });
  assert.equal(both.enabled, true);
  assert.equal(both.entities[0]?.readiness.enrolled, false);
  assert.equal(both.entities[0]?.readiness.businessVerified, false);
  assert.equal(both.entities[0]?.readiness.payoutBankVerified, false);
  assert.equal(both.entities[0]?.readiness.receiptEmailsAllowed, false);
  assert.equal(both.entities[0]?.readiness.receiptReconciliationVerified, false);
});

test("malformed or duplicate hosted-invoice configuration fails closed without retaining provider data", () => {
  const malformed = qboHostedConfigFromEnv({
    RENT_OPS_TENANT_CHECKOUT_ENABLED: "true",
    RENT_OPS_QBO_HOSTED_PAYMENTS_ENABLED: "true",
    RENT_OPS_QBO_HOSTED_PAYMENTS_CONFIG_JSON: "{not-json",
  });
  assert.equal(malformed.enabled, false);
  assert.equal(malformed.configurationValid, false);
  assert.deepEqual(malformed.entities, []);

  const duplicated = qboHostedConfigFromEnv({
    RENT_OPS_TENANT_CHECKOUT_ENABLED: "true",
    RENT_OPS_QBO_HOSTED_PAYMENTS_ENABLED: "true",
    RENT_OPS_QBO_HOSTED_PAYMENTS_CONFIG_JSON: JSON.stringify({ entities: [JSON.parse(envConfig()).entities[0], JSON.parse(envConfig()).entities[0]] }),
  });
  assert.equal(duplicated.enabled, false);
  assert.equal(duplicated.configurationValid, false);
  assert.deepEqual(duplicated.entities, []);
});

test("manager readiness reports independent blockers without invoice links, realm IDs, customer IDs or tenant emails", () => {
  const config = qboHostedConfigFromEnv({
    RENT_OPS_TENANT_CHECKOUT_ENABLED: "true",
    RENT_OPS_QBO_HOSTED_PAYMENTS_ENABLED: "true",
    RENT_OPS_QBO_HOSTED_PAYMENTS_CONFIG_JSON: envConfig({ enrolled: true, businessVerified: true, payoutBankVerified: true, receiptEmailsAllowed: true }),
  });
  const service = createQboHostedPaymentService({
    executor: { async query() { throw new Error("unexpected database call"); } },
    config,
    clientFor() { throw new Error("unexpected QuickBooks call"); },
  });
  const readiness = service.getReadiness();
  assert.equal(readiness.enabled, false);
  assert.deepEqual(readiness.entities[0]?.blockers, ["receipt_reconciliation_unverified"]);
  assert.equal(readiness.entities[0]?.approvedInvoiceCount, 1);
  const serialized = JSON.stringify(readiness);
  assert.doesNotMatch(serialized, /4620816365001234567|customer-1|resident@example\.test|connect\.intuit\.com|invoice-1/);
});

test("QBO short first pages use returned-row maxResults metadata", () => {
  assert.equal(qboCustomerInvoiceQueryIsComplete({ entities: [{ Id: "only-row" }], startPosition: 1, maxResults: 1 }), true);
  assert.equal(qboCustomerInvoiceQueryIsComplete({ entities: [], startPosition: 1, maxResults: 0 }), true);
  assert.equal(qboCustomerInvoiceQueryIsComplete({ entities: [{ Id: "only-row" }], startPosition: 1, maxResults: 1000 }), false);
  assert.equal(qboCustomerInvoiceQueryIsComplete({ entities: [{ Id: "only-row" }], startPosition: 2, maxResults: 1 }), false);
});

const testOrganizationId = "10000000-0000-4000-8000-000000000001";
const testLegalEntityId = "20000000-0000-4000-8000-000000000001";
const testRealmId = "4620816365001234567";
const testAccountId = "30000000-0000-4000-8000-000000000001";
const testPersonId = "40000000-0000-4000-8000-000000000001";
const testTenancyId = "50000000-0000-4000-8000-000000000001";
const testEmail = "resident@synthetic-payments.demo";
const testInvoiceId = "invoice-1";
const testNow = new Date("2026-09-27T12:00:00.000Z");
const testInvoiceUrl = "https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-testInvoice";

interface HostedTestOverrides {
  readonly identity?: TenantIdentity;
  readonly legalEntityId?: string;
  readonly approval?: Record<string, unknown>;
  readonly customer?: Record<string, unknown>;
  readonly invoice?: Record<string, unknown>;
  readonly queryInvoices?: Record<string, unknown>[];
  readonly snapshot?: ReturnType<typeof syntheticRentOpsSnapshot>;
  readonly tenantCheckoutEnabled?: boolean;
  readonly hostedEnabled?: boolean;
}

function hostedTestFixture(overrides: HostedTestOverrides = {}) {
  const identity: TenantIdentity = overrides.identity ?? {
    id: testAccountId, personId: testPersonId, tenancyId: testTenancyId, email: testEmail, status: "active",
  };
  const invoice: Record<string, unknown> = {
    Id: testInvoiceId,
    SyncToken: "4",
    CustomerRef: { value: "customer-1" },
    DocNumber: "INV-1",
    Balance: "125.00",
    CurrencyRef: { value: "USD" },
    BillEmail: { Address: testEmail },
    AllowOnlinePayment: true,
    DueDate: "2026-10-01",
    InvoiceLink: testInvoiceUrl,
    ...overrides.invoice,
  };
  const queryInvoice = { ...invoice, InvoiceLink: undefined };
  const customer: Record<string, unknown> = {
    Id: "customer-1",
    Active: true,
    PrimaryEmailAddr: { Address: testEmail },
    Balance: "125.00",
    ...overrides.customer,
  };
  const queryInvoices = overrides.queryInvoices ?? [queryInvoice];
  const approval = {
    invoiceId: testInvoiceId,
    invoiceNumber: "INV-1",
    invoiceSyncToken: "4",
    balanceCents: "12500",
    customerId: "customer-1",
    tenancyId: testTenancyId,
    personId: testPersonId,
    tenantAccountId: testAccountId,
    tenantEmail: testEmail,
    expiresAt: "2027-01-01T00:00:00.000Z",
    ...overrides.approval,
  };
  const readiness = { enrolled: true, businessVerified: true, payoutBankVerified: true, receiptEmailsAllowed: true, receiptReconciliationVerified: true };
  const rawConfig = JSON.stringify({ entities: [{
    organizationId: testOrganizationId,
    legalEntityId: overrides.legalEntityId ?? testLegalEntityId,
    environment: "production",
    realmId: testRealmId,
    readiness,
    invoices: [approval],
  }] });
  const config = qboHostedConfigFromEnv({
    RENT_OPS_TENANT_CHECKOUT_ENABLED: overrides.tenantCheckoutEnabled === false ? "false" : "true",
    RENT_OPS_QBO_HOSTED_PAYMENTS_ENABLED: overrides.hostedEnabled === false ? "false" : "true",
    RENT_OPS_QBO_HOSTED_PAYMENTS_CONFIG_JSON: rawConfig,
  });
  const snapshot = overrides.snapshot ?? (() => {
    const value = structuredClone(syntheticRentOpsSnapshot());
    const property = value.properties[0]!;
    const unit = value.units[0]!;
    const person = value.people[0]!;
    const tenancy = value.tenancies[0]!;
    value.properties = [property];
    value.units = [{ ...unit, propertyLinkKnowledge: "manual" }];
    value.people = [{ ...person, id: testPersonId, email: testEmail, source: undefined, paymentReviewReason: null }];
    value.tenancies = [{
      ...tenancy,
      id: testTenancyId,
      primaryPersonId: testPersonId,
      status: "current",
      statusKnowledge: "manual",
      propertyLinkKnowledge: "manual",
      unitLinkKnowledge: "manual",
      primaryPersonLinkKnowledge: "manual",
    }];
    value.subsidyContracts = [];
    value.paymentAllocations = [];
    value.securityDeposits = [];
    value.ledgerTransactions = [{
      id: "current-rent",
      propertyId: property.id,
      unitId: unit.id,
      tenancyId: testTenancyId,
      personId: testPersonId,
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
      payer: "tenant",
      payerKnowledge: "manual",
      description: "September rent",
      descriptionKnowledge: "manual",
      propertyLinkKnowledge: "manual",
      unitLinkKnowledge: "manual",
      tenancyLinkKnowledge: "manual",
      personLinkKnowledge: "manual",
    }];
    return value;
  })();

  const providerCalls: string[] = [];
  const executor: RentOpsQueryExecutor = {
    async query<T>(sql: string, values: unknown[] = []) {
      if (sql.includes("FROM rent_ops_tenant_accounts")) {
        const matches = values[0] === testAccountId && values[1] === testEmail && values[2] === testPersonId && values[3] === testTenancyId;
        return { rows: (matches ? [{ id: testAccountId, email: testEmail, person_id: testPersonId, tenancy_id: testTenancyId, status: "active" }] : []) as T[] };
      }
      if (sql.includes("FROM rent_ops_tenant_payments")) return { rows: [] as T[] };
      if (sql.includes("FROM rent_ops_tenancies t")) {
        const matches = values[0] === testOrganizationId && values[1] === testTenancyId;
        return { rows: (matches ? [{ id: testTenancyId, status: "current", property_id: "property-1", property_name: "Synthetic House", unit_id: "unit-1", start_on: "2025-01-01", end_on: null, ledger_entry_count: 1 }] : []) as T[] };
      }
      if (sql.includes("FROM company_property_entity_periods m")) return { rows: [{ id: "period-1", legal_entity_id: testLegalEntityId, legal_entity_name: "Synthetic LLC", effective_from: "2020-01-01", effective_until: null }] as T[] };
      if (sql.includes("FROM company_external_identities")) return { rows: [{ external_id: "customer-1", legal_entity_id: testLegalEntityId, source_scope: `qbo:production:${testRealmId}` }] as T[] };
      if (sql.includes("FROM accounting_qbo_realm_bindings")) return { rows: [{ realm_id: testRealmId, provider_company_name: "Synthetic Books" }] as T[] };
      if (sql.includes("FROM accounting_qbo_connections c")) return { rows: [{ realm_id: testRealmId, status: "active", revoked_at: null, updated_at: "2026-09-01T00:00:00.000Z", read_capability_enabled: true }] as T[] };
      throw new Error("Unexpected synthetic database query");
    },
  };
  const client = {
    async read(entity: string, id: string) {
      providerCalls.push(`read:${entity}:${id}`);
      return { entity: customer };
    },
    async readInvoiceWithLink(id: string) {
      providerCalls.push(`invoice-link:${id}`);
      return id === testInvoiceId ? invoice : null;
    },
    async query() {
      providerCalls.push("query:customer-invoices");
      return { entities: queryInvoices, startPosition: 1, maxResults: queryInvoices.length };
    },
  };
  const service = createQboHostedPaymentService({
    executor,
    config,
    clientFor(scope) {
      assert.equal(scope.organizationId, testOrganizationId);
      assert.equal(scope.legalEntityId, testLegalEntityId);
      assert.equal(scope.realmId, testRealmId);
      return client;
    },
    now: () => testNow,
  });
  return { service, identity, providerCalls, snapshot };
}

async function withHostedSnapshot<T>(snapshot: ReturnType<typeof syntheticRentOpsSnapshot>, work: () => Promise<T>): Promise<T> {
  const original = PostgresRentOpsRepository.prototype.getOperationalSnapshot;
  PostgresRentOpsRepository.prototype.getOperationalSnapshot = async function () { return snapshot; };
  try { return await work(); }
  finally { PostgresRentOpsRepository.prototype.getOperationalSnapshot = original; }
}

test("service returns only the reviewed same-tenant hosted invoice and exact URL", async () => {
  const fixture = hostedTestFixture();
  await withHostedSnapshot(fixture.snapshot, async () => {
    const view = await fixture.service.getTenantView({ organizationId: testOrganizationId, identity: fixture.identity });
    assert.equal(view.available, true);
    assert.deepEqual(view.invoices, [{ id: testInvoiceId, number: "INV-1", balanceCents: "12500", dueDate: "2026-10-01" }]);
    assert.deepEqual(await fixture.service.getInvoiceLink({ organizationId: testOrganizationId, identity: fixture.identity, invoiceId: testInvoiceId }), { invoiceId: testInvoiceId, url: testInvoiceUrl });
    assert.equal(fixture.providerCalls.filter(call => call.startsWith("invoice-link:")).length, 2);
  });
});

test("service gates entity, customer, authenticated identity, expiry, global checkout, and HAP before returning a link", async () => {
  const cases: Array<{ name: string; options: HostedTestOverrides }> = [
    { name: "entity ownership mismatch", options: { legalEntityId: "30000000-0000-4000-8000-000000000001" } },
    { name: "customer mapping mismatch", options: { approval: { customerId: "customer-other" } } },
    { name: "authenticated email mismatch", options: { identity: { id: testAccountId, personId: testPersonId, tenancyId: testTenancyId, email: "other@synthetic-payments.demo", status: "active" } } },
    { name: "authenticated tenancy mismatch", options: { identity: { id: testAccountId, personId: testPersonId, tenancyId: "60000000-0000-4000-8000-000000000001", email: testEmail, status: "active" } } },
    { name: "expired invoice approval", options: { approval: { expiresAt: "2026-09-01T00:00:00.000Z" } } },
    { name: "global checkout cutover disabled", options: { tenantCheckoutEnabled: false } },
  ];
  for (const entry of cases) {
    const fixture = hostedTestFixture(entry.options);
    await withHostedSnapshot(fixture.snapshot, async () => {
      const view = await fixture.service.getTenantView({ organizationId: testOrganizationId, identity: fixture.identity });
      assert.equal(view.available, false, entry.name);
      assert.equal(fixture.providerCalls.length, 0, entry.name);
    });
  }

  const hapSnapshot = hostedTestFixture().snapshot;
  hapSnapshot.subsidyContracts = [{
    id: "hap-contract", propertyId: "demo-property-a", unitId: "demo-unit-a-1", tenancyId: testTenancyId,
    agencyName: "Synthetic Agency", effectiveFrom: "2026-01-01", agencyObligationCents: 1000, tenantObligationCents: 11500, status: "active",
  } as never];
  const hapFixture = hostedTestFixture({ snapshot: hapSnapshot });
  await withHostedSnapshot(hapSnapshot, async () => {
    const view = await hapFixture.service.getTenantView({ organizationId: testOrganizationId, identity: hapFixture.identity });
    assert.equal(view.available, false, "assisted tenancy is held for review");
    assert.equal(hapFixture.providerCalls.length, 0);
  });
});

test("service requires isolated native balance, live customer email and status, online method, and no extra invoice recipients", async () => {
  const cases: Array<{ name: string; options: HostedTestOverrides }> = [
    { name: "stale local balance", options: { snapshot: (() => { const snapshot = hostedTestFixture().snapshot; snapshot.ledgerTransactions[0]!.amountCents = 13000; return snapshot; })() } },
    { name: "inactive QBO customer", options: { customer: { Active: false } } },
    { name: "wrong QBO customer ID", options: { customer: { Id: "customer-other" } } },
    { name: "wrong QBO primary email", options: { customer: { PrimaryEmailAddr: { Address: "other@synthetic-payments.demo" } } } },
    { name: "wrong invoice BillEmail", options: { invoice: { BillEmail: { Address: "other@synthetic-payments.demo" } } } },
    { name: "invoice copied to another email", options: { invoice: { BillEmailCc: { Address: "other@synthetic-payments.demo" } } } },
    { name: "invoice copied with BCC", options: { invoice: { BillEmailBcc: { Address: "other@synthetic-payments.demo" } } } },
    { name: "customer AR exceeds isolated invoice", options: { customer: { Balance: "250.00" } } },
    { name: "hosted method disabled", options: { invoice: { AllowOnlinePayment: false, AllowOnlineACHPayment: false, AllowOnlineCreditCardPayment: false } } },
    { name: "fractional cent amount rejected", options: { invoice: { Balance: 125.001 } } },
  ];
  for (const entry of cases) {
    const fixture = hostedTestFixture(entry.options);
    await withHostedSnapshot(fixture.snapshot, async () => {
      const view = await fixture.service.getTenantView({ organizationId: testOrganizationId, identity: fixture.identity });
      assert.equal(view.available, false, entry.name);
    });
  }

  const queryRows = [
    { ...hostedTestFixture().snapshot.ledgerTransactions[0], Id: testInvoiceId, SyncToken: "4", CustomerRef: { value: "customer-1" }, DocNumber: "INV-1", Balance: "125.00", CurrencyRef: { value: "USD" }, BillEmail: { Address: testEmail } },
    { Id: "other-open-invoice", SyncToken: "1", CustomerRef: { value: "customer-1" }, DocNumber: "OLD-2", Balance: "0.00", CurrencyRef: { value: "USD" }, BillEmail: { Address: testEmail } },
  ];
  const crossInvoiceFixture = hostedTestFixture({ queryInvoices: queryRows });
  await withHostedSnapshot(crossInvoiceFixture.snapshot, async () => {
    const view = await crossInvoiceFixture.service.getTenantView({ organizationId: testOrganizationId, identity: crossInvoiceFixture.identity });
    assert.equal(view.available, false, "an unapproved closed customer invoice can appear in the hosted portal");
  });
});
