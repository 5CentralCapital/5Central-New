# Audit: R-ops QBO Financial Source Plan — September 23, 2026

Audit of *R-ops QBO Financial Source Plan.md* (and `qbo-source-rollout-2026-09-23.json`) against
the code at `codex/audit-ops-rollout-20260923` and Intuit's current public API documentation,
followed by the first implementation slice on `claude/qbo-financial-source`.

## Verdict

The plan's architecture is sound and matches how the code is already built: QuickBooks is the
posted authority per LLC, 5Central Ops keeps a verified mirror, operational records stay local,
writes are prepared → approved → submitted once → read back, and unknown or partial data is never
shown as zero. The dependency graph is acyclic and the acceptance criteria are strong.

It needs amendments in four areas before the large packets (QS04 history import, QS05 deposits,
QS13 hosted payments) start: (1) Intuit API constraints that change how sync and import must be
built, (2) customer identity and naming rules in QuickBooks, (3) the risk and sequencing of
importing native history into books that are still being cleaned up, and (4) the hosting change
(a durable worker on Render is now part of the platform, not an option).

## Findings and recommended amendments

1. **Stale locations.** The plan points at `~/Projects/r-ops` and an iCloud plugin path. The
   authoritative code is GitHub `5CentralCapital/5Central-New`; releases deploy from a protected
   `production` branch on Render. Amend QS00 accordingly.
2. **Worker is mandatory.** QS02's durable webhook intake, CDC and resumable batches all run in
   `npm run worker`. The plan predates the Render move; the Blueprint now runs web + worker
   (`render.yaml`). Amend QS02/QS14 to treat worker uptime and job health as acceptance items.
3. **Intuit constraints the plan must name** (all verified against current public sources; see
   `qbo-production-compliance-2026-09-23.md`):
   - *Read metering*: the App Partner Program Builder tier includes 500,000 CorePlus reads per
     month per workspace and blocks above it. Full-history imports, readbacks and reports all
     count. Budget reads per batch; prefer CDC; never schedule full replays.
   - *Name-list queries hide inactive records* unless `Active` is named. The existing sync would
     have tombstoned every deactivated account and — once customers are mirrored — every former
     tenant. **Fixed** in this work.
   - *No `ORDERBY Id` or Id range filters*; *`AccountRef.name` is a full path* (match on value);
     *Reports v2* (parse by key, `""` is null); *CloudEvents-only webhooks*; *5-year refresh-token
     limit with a mandatory Reconnect URL*. The code already complies; the plan should state these
     as invariants so new packets keep them.
   - *`requestid` retention is undocumented*. The plan's rule "resolve an uncertain write by readback
     before retrying" is right. Add: every QuickBooks create that lacks a natural key (Invoice,
     Payment, CreditMemo, JournalEntry, Bill) carries the stable source-event id in `PrivateNote`
     (and `DocNumber` where free) so a lost response can be found by query instead of being held for
     manual review.
4. **Customer identity in QuickBooks (QS04).** `DisplayName` must be unique across Customers,
   Vendors and Employees, and sub-customers nest at most five levels. Define the naming scheme
   before import (for example `Tenant name · Property Unit · RM<id>`), map one tenancy to one
   customer (implemented: the identity map forbids a customer on two tenancies), and make former
   tenants inactive rather than deleting them.
5. **Items classify rent, fees and deposits.** Invoice lines carry `ItemRef`, not an account; the
   income or liability account lives on the Item. Mirror Items (and their accounts) before QS05 so
   deposits recorded through a liability item are not counted as rent, and so property/category
   attribution does not rely on line descriptions.
6. **Native history import is the highest-risk packet.** The three LLCs' books are mid-cleanup and
   already contain summary journals and MRA deposits for much of the RM period. Replacing them with
   native Invoice/Payment detail means reversing or reclassifying existing entries in closed
   periods. Amend QS04 to require, per entity-period: the QuickBooks book-close date read from
   Preferences; an "already represented" reconciliation; a reviewed batch preview with counts,
   amounts and the P&L/AR/cash deltas; a one-tenancy production pilot; and only then the batch.
   Keep the archive-only RM history visible as "not in QuickBooks" until then.
7. **Sales tax and bundles are refused, not approximated.** The receivables normalizer rejects
   documents with transaction tax, group (bundle) lines or unreconciled totals. If any entity
   charges tax, add explicit tax modeling before its import.
8. **Class/Location capacity.** QuickBooks Online Plus allows 40 classes and locations combined.
   Confirm each LLC's subscription before relying on classes for property attribution.
9. **Personal data in the mirror.** Provider bodies (including customer contact details) are stored
   in `accounting_qbo_source_objects`. The plan should state access rules and a retention period,
   and confirm tenant web access reads only the tenant's own ledger through the read service (the
   tenant portal must never query QuickBooks or the raw mirror).
10. **Intuit profile accuracy.** The app questionnaire answered "No" to webhooks and CDC. Notify
    Intuit before production CDC/webhooks run (added to the release runbook).
11. **Measurable acceptance.** Add numeric targets: webhook-to-mirror freshness (p95 under 5 min),
    CDC cadence (hourly now), maximum tolerated read usage per month, and complete-history page
    latency for the largest tenant.

## What was implemented on `claude/qbo-financial-source`

Built on the release branch (`claude/qbo-production-release`), tested on PGlite with the real
runtime-role grants. Migration 050 is a **reviewed proposal**: it must be applied with
`npm run company:production-schema` after 043–048 are live, never with the release.

| Piece | Packet | Files |
|---|---|---|
| Receivables mirror schema: current revision per document; append-only effects and payment applications per revision; runtime grants in the manifest | QS02 | `server/rent-ops/migrations/050_accounting_qbo_receivables.sql` |
| Normalizer for Invoice, CreditMemo, Payment, SalesReceipt, RefundReceipt and A/R JournalEntry lines, following QuickBooks' customer-balance rules; exact cents; whole-document refusal on anything not understood | QS02 | `server/integrations/quickbooks/normalize-receivables.ts` |
| Sync: customers and receivables in catch-up, CDC, webhooks and full replays (after Account identity); stale revisions ignored; deletions and unsupported revisions stop counting; anchor requires every stream | QS02 | `server/accounting/provider-sync.ts`, `receivables-store.ts` |
| Inactive-record query fix | QS02 | `server/accounting/provider-sync.ts` |
| Customer/tenant ledger read service: complete-history running balance before paging, change detection between pages, totals, QuickBooks open items and aging, verification against `Customer.Balance`, coverage | QS04 (read) | `server/accounting/receivables-read.ts` |
| Tenancy ↔ QuickBooks customer links through the immutable identity map | QS01/QS04 | `server/accounting/receivables-links.ts` |
| HTTP routes and `get_qbo_customer_ledger` MCP tool on the same service | QS04 | `server/accounting/http.ts`, `mcp.ts` |
| Record-only Invoice write guard with post-save verification (release branch) | QS03 | `server/accounting/qbo-write.ts` |

## Packet status (implementation, not acceptance)

| Packet | Status after this work | Next prerequisite |
|---|---|---|
| QS00 | Done: baseline facts, deployed/DB state, gaps (this document, compliance review, cutover audit) | — |
| QS01 | Existing identity/coverage contracts reused; receivables contracts added | Dated tenancy→property→entity attribution check on links |
| QS02 | Receivables mirror implemented and tested; cash mirror unchanged | Apply 050 (after the cutover release, which ships 049); sandbox run against a real company; Item/Class/Department mirrors |
| QS03 | Posting service existing; record-only Invoice guard added | Field-level edit maps per entity; `PrivateNote` source-event tagging; CreditMemo/Payment writes |
| QS04 | Read path, links, API and MCP implemented | Manager/tenant UI wiring; RM export inventory and batch previews per entity-period (finding 6) |
| QS05–QS12 | Not started | As listed in the plan, plus findings 5, 6 and 8 |
| QS13 | Not started | Merchant/funding verification per company |
| QS14 | Harness pieces exist (preflight, schema operator, CI) | Per-cohort cutover gates |

Nothing here posts to QuickBooks, imports history, applies corrections or enables payments. Live
imports, corrections and cutover keep their explicit release approvals.
