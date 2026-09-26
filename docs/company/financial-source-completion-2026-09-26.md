# Financial source reliability release

This change preserves immutable QuickBooks revisions while recording repeated Customer, Vendor, and Employee observations. Accepted read-time changes update the customer balance view. Material profile changes remain explicit exceptions. A change-data checkpoint cannot substitute for a full baseline of every required accounting and receivable stream.

Investor pages distinguish recorded, currently posted in QuickBooks, and bank-settled payments. Payment purpose and principal/interest components must agree; historical debt rollforwards exclude later payments. Investor agreement selection uses verified company and legal-entity scope, and legacy rental document endpoints cannot expose company documents.

The forecast balance-sheet adapter requires explicit account classifications and complete entity coverage. It keeps operating cash, restricted cash, payables, property cost, accumulated depreciation, and construction in progress separate. Native report data remains unreconciled without independent evidence. Production source configuration and financial data migration are separate acceptance steps.

Before production rollout:

1. Obtain the required independent pull-request approval and passing release checks.
2. Verify a fresh restorable backup and restore rehearsal of the actual production target under the existing release procedure.
3. Review and apply migration 054 with the production schema operator; apply and verify the append-only runtime grants. Production startup does not migrate.
4. Deploy the tested revision to web and worker, confirm readiness, then replay each connected company's complete source history.
5. Compare provider object counts, mirror counts, coverage, and exceptions. A successful job or matching total alone does not prove financial reconciliation. Retain failed-job history.
6. Read back customer histories and investor document access through the authorized interfaces. Configure forecast opening mappings only after the full entity/account scope has been reviewed.

Former tenants in entities without a connected QuickBooks company may retain explicitly identified local historical records under the approved source policy. Do not create another company or route those records into a different LLC merely to archive their history. Outstanding receivables and deposit liabilities remain reviewable.

Tenant source selection uses historical tenancy and ownership dates. Unknown dates, ownership gaps, and ambiguous company assignments stay reviewable; import timestamps are not tenancy dates. The read-only migration preview extracts existing persisted records and allocations with their source IDs and exact cents. It does not reimport historical rental records or apply QuickBooks entries.

Payment, CreditMemo, SalesReceipt, and RefundReceipt creation remains unsupported by the R-ops write adapter. Future enablement requires provider-verified record-only fields, matching transaction/posting-policy dates, and recovery that cannot resend ambiguous creates. Source tags are evidence identifiers, not assumed queryable provider keys. All production write switches remain off.

Private agreements, tenant archives, migration payloads, live diagnostics, and account classifications stay outside this public repository. This release does not itself post accounting transactions, settle payments, migrate the full workbook models, or declare the companies reconciled.
