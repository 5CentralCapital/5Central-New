# Tenant QuickBooks payments

The tenant portal can request an approved QuickBooks-hosted invoice link through its existing authenticated session. This is a disabled preparation path. It does not enroll merchants, verify businesses, connect banks, create invoices, enable invoice payment flags, send messages, record receipts, or change tenant balances.

## Runtime controls

Both `RENT_OPS_TENANT_CHECKOUT_ENABLED` and `RENT_OPS_QBO_HOSTED_PAYMENTS_ENABLED` must explicitly be `true`. Missing or malformed configuration fails closed. `RENT_OPS_QBO_TENANT_PAYMENTS_ORGANIZATION_ID` is the server-selected organization UUID, never a tenant request parameter.

`RENT_OPS_QBO_HOSTED_PAYMENTS_CONFIG_JSON` contains an `entities` array. Each production entity needs an exact organization, legal entity and realm binding; independent enrollment, business verification, payout-bank, receipt-email and receipt-reconciliation approvals; and expiring approvals for individual invoices. There is no wildcard customer or invoice approval.

```json
{
  "entities": [{
    "organizationId": "10000000-0000-4000-8000-000000000001",
    "legalEntityId": "20000000-0000-4000-8000-000000000001",
    "environment": "production",
    "realmId": "1234567890",
    "readiness": {
      "enrolled": false,
      "businessVerified": false,
      "payoutBankVerified": false,
      "receiptEmailsAllowed": false,
      "receiptReconciliationVerified": false
    },
    "invoices": []
  }]
}
```

The example is synthetic and disabled. Keep real tenant identities, contact addresses and invoice approvals in restricted deployment configuration, outside Git and logs. An invoice approval binds `invoiceId`, `invoiceNumber`, `invoiceSyncToken`, exact decimal-string `balanceCents`, `customerId`, `tenancyId`, `personId`, `tenantAccountId`, `tenantEmail`, and `expiresAt`. The email approval attests that the address belongs to this authenticated tenant; copying an address from a directory alone is insufficient.

## Tenant flow

`GET /api/tenant/payments/quickbooks` returns safe invoice summaries without payment URLs. `POST /api/tenant/payments/quickbooks/link` accepts only `invoiceId`, requires the tenant session and CSRF token, and repeats the ownership, identity, balance and native invoice checks immediately before returning a link. Responses are not cacheable. Provider details are not exposed in failures.

The service requires current verified property ownership, the exact tenant/customer binding, an active read-capable QBO connection, verified tenant responsibility, and no unresolved Stripe attempt. Record-only opening invoices, HAP or mixed-payer accounts, ambiguous balances, changed approvals, other customer invoices and untrusted redirects remain unavailable. The permitted hosted origin is `https://connect.intuit.com`, with the native `portal/app/CommerceNetwork/view` invoice path.

The client keeps legacy payment history, clears readiness on account changes, ignores late requests after sign-out or unmount, and suppresses the referrer during navigation. A failed QuickBooks request cannot fall back to a new Stripe charge. Existing Stripe webhooks and historical settlement/reversal reconciliation remain intact; the runtime disables new Stripe checkout and recovery-session creation.

## Required before activation

1. Complete merchant enrollment, business verification and payout-bank setup separately for each legal entity.
2. Confirm permission for native payment receipts. App invitations, invoice sends and reminders remain separately controlled.
3. Verify tenant mailbox ownership, current lease responsibility and exact entity/customer mapping. Resolve missing or invalid contact addresses.
4. Reconcile each payable invoice to the tenant's current due. Opening migration invoices stay record-only, and agency receivables stay separate.
5. Implement and verify the tenant financial read projection against the approved accounting cutoff and opening-balance bridge. QBO receivable mirrors currently feed the manager's QBO ledger; the tenant home still uses the R-ops operational ledger. Do not add the two balances or insert mirrored payments into the operational ledger without an approved deduplication/allocation design.
6. Verify payment, partial payment, refund, void, delayed ACH failure, duplicate event and customer-reassignment behavior against provider evidence. Posted payment, bank settlement and browser return are distinct states. Only then set `receiptReconciliationVerified`.
7. Obtain normal code review, deploy with both checkout switches off, verify tenant access and unavailable states, then approve a bounded activation configuration. Do not reuse an exception granted to another pull request.

Turning either checkout switch off immediately prevents new hosted links after restart. Previously issued native invoice URLs can remain usable at QuickBooks; revoke their native online-payment flags separately if required. An app switch does not revoke an already-issued provider link.
