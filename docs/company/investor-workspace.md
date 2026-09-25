# Investor workspace

This slice owns the company investor account, investment instrument, contract, debt, obligation, payment and activity domain. Its schema is registered as migration 37, `server/rent-ops/migrations/037_company_investors.sql`, and is not applied at process startup. The root integration owns migration registration, root routes, the manager navigation entry and persistence wiring.

## Shared command and read boundary

`shared/investors/contracts.ts` is the browser, HTTP and Codex contract. `InvestorReadService` and `executeInvestorCommand` are the only domain paths used by the adapters. `createInvestorPort` exposes those paths to both transports through the following seam:

- `registerInvestorRoutes` adds the company-scoped HTTP handlers.
- `registerInvestorMcpTools` registers read and command tools using the same port.
- `createInvestorPort(executor, options)` accepts `sourceReadFactory(transaction)` and `sourceResolverFactory(transaction)`. The factories are important: financial reads and source allocations must use the transaction that owns the company snapshot or command. `sourceRead` and `sourceResolver` remain compatibility injection points for tests and transitional wiring.
- `InvestorEntry` and `InvestorWorkspace` export the manager entry props used by root navigation. The tabs are `overview`, `payments` (Payment calendar), `capital` (Contributions & distributions), `debt` (Debt & maturities), `contracts` (Agreements) and `activity`.

All command envelopes are schema parsed, bind the authenticated principal inside a fresh transaction, enforce organization/legal-entity/property scope, and use operation idempotency plus expected record revisions. Historical payments and contract versions are append-only. A correction creates a reversal row and negative allocation; it does not edit the original payment. Editing an unverified manual payment uses the same append-only path and adds a replacement manual row; payments with QBO or bank evidence remain immutable.

## Investor and debt records

An account must link either an existing scoped `company_contacts` row or a newly created contact in the same account command. Instruments retain the legal entity, currency, properties and projects, with commitment and face principal stored independently. A debt row retains original principal, funded capital, outstanding principal, schedule, month-end rule, maturity, balloon and day-count basis. Funded capital and the current outstanding balance can remain null until supported by an authoritative statement; neither is inferred from face principal or an agreement.

Contract versions reference existing authorized company documents by ID. Active versions require a document reference and approval. A version stores explicit principal, interest, return-of-capital, distribution, fee, balloon and rate terms. Monthly, quarterly, annual and maturity schedules can be generated; custom schedules are rejected until a dated obligation set is supplied. Actual/360, actual/365 and 30/360 interest require the appropriate accrual period. An unknown opening funded principal never becomes zero by default.

The obligation generator creates a bounded month range with deterministic month-end dates and preserves the contract version used to calculate each row. Scheduled principal and maturity balloon are capped against known outstanding principal; ambiguous rate, interest-only or unsupported split terms fail validation instead of inventing an amortization.

## Monthly payment log

The log keeps contractual expected obligations, manual records, QBO-posted allocations and independent bank/Plaid settlement evidence separate. QBO posting alone never marks a payment settled. A partial QBO allocation is `partially_posted`; a manual record remains manual until a resolver returns verified provider evidence. Amount components are cents and retain principal, interest, return of capital, distribution, fee and balloon classifications. Allocation is capped per obligation and source, with unapplied overpayments retained. Currency, organization, legal entity, instrument, account and source scope must agree.

QBO commands accept only a complete source reference request. The caller cannot supply coverage, verification time, watermark or posted amount as proof. The accounting resolver re-reads the current mirrored line, verifies provider identity/version, posting state, direction, currency, amount, account, counterparty, legal entity and eligible provider object context, then reserves the requested amount through the central accounting allocator in the command transaction. Contributions require an eligible incoming `Deposit`/debit context. Outgoing investor payments require an eligible cash/check/ACH/wire `Purchase` or `BillPayment`/credit context. Generic journal entries, transfers, liability bills and arbitrary ledger lines stay unverified. Later source re-reads prevent stale or voided QBO evidence from remaining in verified rollups.

Bank/Plaid settlement uses a separate injected resolver and source identity. A manually recorded payment, a QBO-posted payment and a bank-settled payment are therefore different facts in the account rollup. Provider source totals are counted only when the stored attestation is still valid; local manual totals never masquerade as verified financial actuals. When a fresh QBO read is unavailable, stale or voided, the historical source remains visible with `postedSourceValidity`, while the payment and obligation surface shows `review_required` and excludes that source from verified posted totals.

`monthlyPayments` returns an opaque cursor and pages obligations by period, due date and ID. Each first page also returns `unscheduledPayments` for standalone contributions, distributions or other activity in the requested payment window, so the monthly log does not silently omit records without an obligation. QBO source-line reads use the same cursor contract across every mapped realm.

The current default source resolver is fail-closed. Production wiring must supply the scoped `FinancialSourceReadPort`, central `FinancialSourceAllocationPort`, provider-object context reader and settlement verifier. Synthetic fixtures cover partial allocations, unsupported transfers, incoming contributions, wrong entity/counterparty/currency, stale/voided lines, rollback and reversal behavior. No private investor records or real source IDs are seeded by this module.

## Root integration notes

Migration 37 follows the company foundation, contacts, legal entities, documents and project/property tables in the ordered migration chain. It should instantiate one port and pass the same authenticated executor into the HTTP and Codex registrations. Existing legacy investor storage and `/api/admin/investors` routes remain outside this module; any migration of a verified cohort needs an explicit identity and source reconciliation plan.

The source resolver's provider context callback must be backed by actual mirrored provider object data. It must establish the investor/contact or authorized remittance payee relationship, receiving legal entity, cash account, direction, currency, posting state and eligible transaction subtype before returning context. Matching a line's arbitrary counterparty back to itself is not an ownership proof. A source reference, prepared suggestion or bank posting without that context remains unverified.

## Rollforward, schedule and calendar (U11)

`shared/investors/rollforward.ts` is pure and exact:

- `buildAmortizationSchedule` projects debt service from the stored debt terms on the funded principal (original principal, flagged, when funding is undocumented): interest-only periods until `interestOnlyUntil`, then a level payment computed on exact rationals, a balloon at maturity, and 30/360, actual/360 or actual/365 interest. A documented balloon that differs from the computed remaining principal is flagged. Custom schedules stay unsupported.
- `buildInstrumentRollforward` rolls the balance monthly: closing = opening + funded − principal repaid − return of capital ± corrections. Reversals net against the reversed payment's kind. An unknown bank split (`unclassifiedCents`) never reduces principal. The derived outstanding balance is compared with the manual balance (`matches`, `mismatch`, `manual_missing`, `unknown`); a mismatch is flagged, never overwritten. A contractual fixed profit survives prepayment as guaranteed return remaining.
- `investorCalendarState` maps obligation status to scheduled, overdue, partial, recorded, posted, settled, overpaid, review or reversed.

Reads (same port for HTTP and MCP):

- `GET /api/company/:org/investor-instruments/:id/financials` — `get_investor_instrument_financials`
- `GET /api/company/:org/investor-payment-calendar?legalEntityId&fromMonth&throughMonth` — `list_investor_payment_calendar` (cursor paged)
- `GET /api/company/:org/investor-debt-maturities` — `list_investor_debt_maturities`

Posted and settled amounts count only while their QBO source re-reads as current (or a bank settlement source exists); otherwise the payment is treated as manually recorded in the rollforward.

## Interface

- **Payment calendar** — six months of obligations with state and remaining amount, above the recorded obligations table with its link, settle and reverse actions.
- **Contributions & distributions** — committed, contributed (recorded and verified), returned, distributed and net invested per instrument, and the capital activity list.
- **Debt & maturities** — maturity ladder with documented or estimated balloon and the balance check, then one instrument's debt service schedule and monthly rollforward.
- **Agreements** — agreements with versions (new version, generate obligations), QBO payee mappings and remittance instructions (create and archive).
