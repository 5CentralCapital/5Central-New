# Integrated company build

Michael authorized the remaining project, investor/debt, MRA, employee-time and reporting implementation on September 21, 2026. This extends the existing manager interface and shared company database. QuickBooks supplies posted company accounting; local records supply operational context, contracts, obligations and forecasts.

## Integration rules

- Use one accounting source identity and verified read service across project costs, investor payments, debt activity, tenant/accounting reconciliation and reports. Retain organization, legal entity, environment, QBO realm, transaction and line identity, source revision, currency and synchronization watermark.
- A manual entry, intended payment, contract obligation, posted QBO transaction and bank-settled payment are separate facts. References and matching suggestions cannot establish posted or settled status. Unavailable financial coverage is never displayed as zero actuals.
- Shared allocation checks prevent the same source amount from being consumed more than once. Linked records enrich the same economic event; totals must not add local and QBO copies together.
- Allocate against the stable provider transaction/line across revisions, in the same database transaction as the consuming command. Preserve provider versions and detect changed or voided evidence on later reads.
- Verify financial purpose as well as amount. An investor funding receipt, distribution, principal repayment and project expense require the appropriate provider transaction, account, counterparty, direction and entity mapping. A generic debit or credit does not establish those facts.
- Financial writes remain behind supported provider capabilities and explicit accounting cutover. Unsupported capabilities stay unavailable while ordinary operational work continues.
- All normal business records have scoped manual and Codex workflows through the same command services. MRA intake, mapping, preview and apply remain Codex-only; the app shows results and affected records.
- Preserve the current dashboard structure, top dropdown navigation, charcoal/gold/cream palette, opaque financial tables, simple forms and report-specific setup before Run.

## Investor account

An investor account connects the company contact, investing and receiving legal entities, property/project interests, versioned agreements, debt instruments, obligations, distributions and payment history. Commitment and face principal are distinct from capital actually received.

The monthly payment log displays the contractual due date, period, obligation type, expected amount, recorded payment, verified posted allocation, settlement evidence and remaining due. Principal, interest, return of capital and profit distributions retain explicit classifications. Partial payments, unapplied overpayments, amendments, reversals, month-end schedules and balloons must be supported without silently changing history. The account and reports use the same calculations and source links.

Reviewed agreement structures require these additional cases. Keep private source documents outside code and test fixtures:

- A fixed maturity payment may contain principal plus a fixed contractual return, with no monthly installments. The total payment is not capped at principal.
- One monthly obligation can contain a bank installment and an investor spread. A documented, effective remittance instruction may authorize payment to the third-party bank and the investor; both satisfy the same obligation without duplicate credit.
- A known bank installment does not establish its principal/interest split. Preserve the total with unclassified components until the supporting bank evidence is available.
- A maturity payment can combine an unknown, statement-dependent bank payoff and a known fixed return, in addition to the last monthly installment. Unknown payoff is not zero and is not calculated from an approximate rate mentioned for context.
- Guaranteed interest may survive principal prepayment. Use explicit contract terms and dated obligations; do not automatically shorten the schedule or waive the guaranteed amount.
- Conflicting installment counts, maturity dates and final payment deadlines create a review exception. Preserve each source term and require a resolved schedule or amendment before treating it as authoritative. Contract presence does not prove execution, current validity, funding or payment.

## Parallel implementation

| Track | First delivery | Subsequent work |
| --- | --- | --- |
| Accounting | Secure QBO connections, provider reads/reports, durable synchronization, financial source references and allocation checks | Accounting workspace, reconciliation, supported posting and sandbox validation |
| Investors | Account, contracts, debt, monthly obligations/payment log, shared commands and manual workspace | Statements, ownership/capital reporting, distributions and source migration validation |
| Projects | Templates, assignment, inspections, commitments/changes/POs/draws and verified actual links | Employee-time records, approval and provider integration |
| Intake | Shared durable staging, source documents, duplicate detection, preview/apply and resumable operations | Actual MRA-format validation and tenant/accounting reconciliation |
| Reporting | Shared company report engine, source coverage, saved presets, immutable runs and reporting packages | Remaining rental/task/project/investor/financial/forecast definitions and export parity |

Up to three Luna Max workers implement independent file sets. Astra owns contracts, migration registration, cross-domain wiring, review and release gates. Later tracks start as a worker becomes available; shared dependencies are integrated before acceptance. No partial module is counted as a completed reporting engine merely because a screen renders.

The current employee-time implementation assumption is native QuickBooks Time/Workforce clock-in with review, corrections, mapping and project costing in R-ops. Its provider connection is separate from QBO accounting configuration. Estimated labor and posted payroll expense remain distinct. This assumption activates no subscription or employee access.

## Validation

The shared company service container now composes projects, accounting, investors, employee time and reporting. Browser and Codex adapters call those services. Company report reads reload grants and use a transaction-bound store; rental sources use dated company/property mappings. A report crossing an ownership change is held until its period is narrowed or a reviewed interval-aware engine is available.

Current Intuit API changes were rechecked against its official developer notices; engineering evidence is outside the repository at `r-ops-build-evidence/2026-09-21/accounting-api-current-research.md`. Modern report nulls, account hierarchy and removed drilldown parameters must be included in provider fixtures before acceptance.

Use synthetic data for source-controlled tests and disposable databases. Verify exact amounts, effective dates, source allocation limits, company/record authorization, command replay, concurrent updates, provider failures, corrections, UI/API/Codex parity, browser interactions and loading performance. Run the full regression suite after integration; do not repeatedly run it while workers are still changing modules.

Live QBO companies, genuine complete MRA packets, controlling investor contracts, reconciled opening positions, employee/provider configuration, signed Mac distribution and production load/restore evidence remain separate acceptance prerequisites. Continue all independent implementation while those prerequisites are unresolved.
