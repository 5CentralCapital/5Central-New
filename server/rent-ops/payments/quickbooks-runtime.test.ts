import test from "node:test";
import assert from "node:assert/strict";
import type { AccountingServices } from "../../accounting";
import { createTenantQuickBooksPayments } from "./quickbooks-runtime";
import type { TenantIdentity } from "../../../shared/tenant-portal-contracts";

const identity: TenantIdentity = { id: "account", personId: "person", tenancyId: "tenancy", email: "synthetic@example.test", status: "active" };
const organizationId = "10000000-0000-4000-8000-000000000001";
test("missing or invalid server organization cannot reach a provider or database", async () => {
  for (const organization of [undefined, "", "client-chosen-org"]) {
    let accesses = 0;
    const service = createTenantQuickBooksPayments({
      executor: { async query() { accesses++; throw new Error("must not query"); } },
      accounting: { qbo: { status: "configured", createAccountingClient() { accesses++; throw new Error("must not reach QBO"); } } } as unknown as AccountingServices,
      env: { RENT_OPS_QBO_TENANT_PAYMENTS_ORGANIZATION_ID: organization, RENT_OPS_QBO_HOSTED_PAYMENTS_ENABLED: "true" },
    });
    assert.deepEqual(await service.list(identity), { provider: "quickbooks", available: false, reasons: ["payments_not_configured"], invoices: [] });
    await assert.rejects(service.link(identity, "123"), /quickbooks_payments_unavailable/);
    assert.equal(accesses, 0);
  }
});
test("unconfigured QuickBooks never falls back to another provider", async () => {
  const service = createTenantQuickBooksPayments({
    executor: { async query() { throw new Error("must not query"); } },
    accounting: { qbo: { status: "unconfigured", reason: "missing_configuration" } } as AccountingServices,
    env: { RENT_OPS_QBO_TENANT_PAYMENTS_ORGANIZATION_ID: organizationId, RENT_OPS_QBO_HOSTED_PAYMENTS_ENABLED: "true" },
  });
  assert.equal((await service.list(identity)).available, false);
  await assert.rejects(service.link(identity, "123"), /quickbooks_payments_unavailable/);
});
