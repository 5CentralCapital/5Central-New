import test from "node:test";
import assert from "node:assert/strict";
import { isQuickBooksHostedInvoiceUrl, qboTenantPaymentLinkSchema } from "./tenant-qbo-payment-contracts";

const hosted = "https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-synthetic";
test("only an Intuit hosted invoice link can leave the tenant portal", () => {
  assert.equal(isQuickBooksHostedInvoiceUrl(hosted), true);
  assert.equal(isQuickBooksHostedInvoiceUrl(`${hosted}?locale=en_US`), true);
  for (const value of [
    "javascript:alert(1)", "https://evil.example/invoice", hosted.replace("https:", "http:"),
    hosted.replace("connect.intuit.com", "connect.intuit.com.evil.example"),
    hosted.replace("connect.intuit.com", "connect.intuit.com@evil.example"),
    hosted.replace("connect.intuit.com", "user@connect.intuit.com"),
    hosted.replace("connect.intuit.com", "connect.intuit.com:444"),
    hosted.replace("/view/", "/redirect/"), `${hosted}/next`, `${hosted}#next`,
    `${hosted}?redirect_uri=https://evil.example`, `${hosted}?returnUrl=https://evil.example`,
    `${hosted}?%6eext=https://evil.example`, `${hosted}\n`, `${hosted}\\next`,
    hosted.replace("scs-v1-synthetic", "%2e%2e%2fredirect"), null, {},
  ]) assert.equal(isQuickBooksHostedInvoiceUrl(value), false, String(value));
});

test("link requests cannot override tenant, entity, amount, or redirect", () => {
  assert.deepEqual(qboTenantPaymentLinkSchema.parse({ invoiceId: "123" }), { invoiceId: "123" });
  for (const extra of ["organizationId", "entityId", "tenancyId", "customerId", "realmId", "amountCents", "email", "url"]) {
    assert.equal(qboTenantPaymentLinkSchema.safeParse({ invoiceId: "123", [extra]: "other" }).success, false);
  }
  for (const invoiceId of ["", "../123", "123?include=invoiceLink", "1' OR true", "x".repeat(161)]) {
    assert.equal(qboTenantPaymentLinkSchema.safeParse({ invoiceId }).success, false);
  }
});
