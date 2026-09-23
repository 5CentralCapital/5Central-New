import assert from "node:assert/strict";
import test from "node:test";
import { QBO_WRITES_DISABLED, qboWriteHeldReason, recordOnlyInvoiceReason, recordOnlyInvoiceViolation } from "./qbo-write";

const complete = { AllowOnlineCreditCardPayment: false, AllowOnlineACHPayment: false, AllowIPNPayment: false, EmailStatus: "NotSet", CustomerRef: { value: "58" }, Line: [] };

test("invoice writes are record-only: explicit no-online-payment and no email queue", () => {
  assert.equal(recordOnlyInvoiceReason({ entity: "Invoice", operation: "create", fields: complete }), null);
  assert.match(recordOnlyInvoiceReason({ entity: "Invoice", operation: "create", fields: { CustomerRef: { value: "58" } } })!, /state .*explicitly/);
  assert.match(recordOnlyInvoiceReason({ entity: "Invoice", operation: "create", fields: { ...complete, AllowOnlineACHPayment: true } })!, /AllowOnlineACHPayment false/);
  assert.match(recordOnlyInvoiceReason({ entity: "Invoice", operation: "update", fields: { EmailStatus: "NeedToSend" } })!, /NotSet/);
  assert.match(recordOnlyInvoiceReason({ entity: "Invoice", operation: "update", fields: { DeliveryInfo: { DeliveryType: "Email" } } })!, /DeliveryInfo/);
  assert.equal(recordOnlyInvoiceReason({ entity: "Invoice", operation: "update", fields: { PrivateNote: "corrected" } }), null);
  assert.equal(recordOnlyInvoiceReason({ entity: "Bill", operation: "create", fields: {} }), null);
});

test("the saved invoice is verified, and the guard applies before any write switch", () => {
  assert.equal(recordOnlyInvoiceViolation({ ...complete }), null);
  assert.match(recordOnlyInvoiceViolation({ ...complete, AllowOnlineCreditCardPayment: true })!, /on/);
  assert.match(recordOnlyInvoiceViolation({ ...complete, EmailStatus: "EmailSent" })!, /EmailSent/);
  assert.match(recordOnlyInvoiceViolation({ ...complete, InvoiceLink: "https://example.invalid/pay" })!, /InvoiceLink/);
  assert.match(recordOnlyInvoiceViolation(null)!, /did not return/);
  const scope = { organizationId: "10000000-0000-4000-8000-000000000001", legalEntityId: "20000000-0000-4000-8000-000000000001", environment: "production" as const, realmId: "1" };
  const held = qboWriteHeldReason({ scope, operationKey: "k", entity: "Invoice", operation: "create", fields: { CustomerRef: { value: "58" } } }, QBO_WRITES_DISABLED);
  assert.match(held!, /explicitly/);
  const off = qboWriteHeldReason({ scope, operationKey: "k", entity: "Invoice", operation: "create", fields: complete, rentalPosting: { activityDate: "2026-09-01", method: "native_receivables" } }, QBO_WRITES_DISABLED);
  assert.match(off!, /QBO_WRITES_ENABLED/);
});
