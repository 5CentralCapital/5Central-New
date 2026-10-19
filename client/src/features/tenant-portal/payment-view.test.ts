import test from "node:test";
import assert from "node:assert/strict";
import { availableQuickBooksInvoices, formatQuickBooksCents, isCurrentTenantPaymentSession, noPaymentDueMessage, openQuickBooksInvoice, quickBooksUnavailableMessage, trustedQuickBooksInvoiceUrl } from "./payment-view";
const account = { tenancyId: "tenant:test", payableCents: 0, pendingCents: 0, available: false, reason: "no_payable_balance" };
test("paid account says no payment due without masking genuine unavailable states", () => {
  assert.equal(noPaymentDueMessage(account), "No payment is due.");
  assert.match(noPaymentDueMessage({ ...account, pendingCents: 100 })!, /in progress/);
  assert.match(noPaymentDueMessage({ ...account, payableCents: 25 })!, /at least \$0.50/);
  assert.equal(noPaymentDueMessage({ ...account, reason: "incomplete_ledger" }), undefined);
  assert.equal(noPaymentDueMessage(undefined), undefined);
});

test("assistance review explains tenant payable hold without declaring no balance", async () => {
  const {paymentReviewMessage}=await import("./payment-view");
  assert.match(paymentReviewMessage({...account,reason:"assistance_responsibility_unverified"})!,/confirming your share/);
  assert.equal(noPaymentDueMessage({...account,reason:"assistance_responsibility_unverified"}),undefined);
});

test("QuickBooks payment readiness stays generic until an approved invoice is available", () => {
  const invoice = { id: "invoice:opaque-id", number: "INV-1042", balanceCents: "123456", dueDate: "2026-10-01" };
  assert.equal(availableQuickBooksInvoices(undefined).length, 0);
  assert.equal(availableQuickBooksInvoices({ provider: "quickbooks", available: false, reasons: ["secret entity setup detail"], invoices: [invoice] }).length, 0);
  assert.equal(availableQuickBooksInvoices({ provider: "quickbooks", available: true, reasons: ["secret entity setup detail"], invoices: [] }).length, 0);
  assert.equal(quickBooksUnavailableMessage, "Online payments are not available yet.");
  assert.deepEqual(availableQuickBooksInvoices({ provider: "quickbooks", available: true, reasons: ["secret entity setup detail"], invoices: [invoice] }), [invoice]);
});

test("QuickBooks invoice amounts preserve exact cents and reject malformed balances", () => {
  assert.equal(formatQuickBooksCents("123456"), "$1,234.56");
  assert.equal(formatQuickBooksCents("900719925474099101"), "$9,007,199,254,740,991.01");
  assert.equal(formatQuickBooksCents("not-cents"), "Unavailable");
  const invoices = [
    { id: "i1", number: "1", balanceCents: "0", dueDate: null },
    { id: "i2", number: "2", balanceCents: "-100", dueDate: null },
    { id: "i3", number: "3", balanceCents: "1.5", dueDate: null },
    { id: "i4", number: "4", balanceCents: "100", dueDate: null },
  ];
  assert.deepEqual(availableQuickBooksInvoices({ provider: "quickbooks", available: true, reasons: [], invoices }), [invoices[3]]);
});

test("QuickBooks link must match its invoice and the hosted invoice URL format", () => {
  const hosted = "https://connect.intuit.com/portal/app/CommerceNetwork/view/invoice-token_1";
  assert.equal(trustedQuickBooksInvoiceUrl({ invoiceId: "invoice-1", url: hosted }, "invoice-1"), hosted);
  assert.equal(trustedQuickBooksInvoiceUrl({ invoiceId: "invoice-2", url: hosted }, "invoice-1"), undefined);
  for (const url of [
    "http://connect.intuit.com/portal/app/CommerceNetwork/view/token",
    "https://connect.intuit.com.evil.test/portal/app/CommerceNetwork/view/token",
    "https://user@connect.intuit.com/portal/app/CommerceNetwork/view/token",
    "https://connect.intuit.com:444/portal/app/CommerceNetwork/view/token",
    "https://connect.intuit.com/portal/app/CommerceNetwork/view/token#fragment",
    "https://connect.intuit.com/portal/app/CommerceNetwork/view/token?redirectUrl=https://evil.test",
    "javascript:alert(1)",
  ]) assert.equal(trustedQuickBooksInvoiceUrl({ invoiceId: "invoice-1", url }, "invoice-1"), undefined);
});

test("QuickBooks return navigation suppresses the referrer and removes its temporary link", () => {
  const link = { href: "", rel: "", referrerPolicy: "", hidden: false, clicked: false, removed: false };
  const anchor = {
    set href(value: string) { link.href = value; },
    set rel(value: string) { link.rel = value; },
    set referrerPolicy(value: string) { link.referrerPolicy = value; },
    set hidden(value: boolean) { link.hidden = value; },
    click() { link.clicked = true; },
    remove() { link.removed = true; },
  } as unknown as HTMLAnchorElement;
  const documentRef = {
    createElement: (tag: string) => { assert.equal(tag, "a"); return anchor; },
    body: { appendChild: () => undefined },
  } as unknown as Document;
  const url = "https://connect.intuit.com/portal/app/CommerceNetwork/view/token";
  assert.equal(openQuickBooksInvoice(documentRef, url), true);
  assert.deepEqual(link, { href: url, rel: "noreferrer", referrerPolicy: "no-referrer", hidden: true, clicked: true, removed: true });
  assert.equal(openQuickBooksInvoice(documentRef, "https://evil.test/pay"), false);
});

test("a late QuickBooks link cannot continue after the tenant session changes", () => {
  const started = { accountId: "tenant-a", generation: 4 };
  assert.equal(isCurrentTenantPaymentSession(started, started, "tenant-a"), true);
  assert.equal(isCurrentTenantPaymentSession({ accountId: "tenant-a", generation: 5 }, started, "tenant-a"), false);
  assert.equal(isCurrentTenantPaymentSession({ accountId: "tenant-b", generation: 5 }, started, "tenant-a"), false);
  assert.equal(isCurrentTenantPaymentSession(null, started, "tenant-a"), false);
});
