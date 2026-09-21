# Reporting contract

This is the implementation contract for the reporting expansion. A shared discovery catalog and searchable library are implemented; new financial calculations, QBO reporting, immutable report runs and export jobs remain planned. It records Michael’s September 21, 2026 catalog clarification and extends the canonical R-ops Build Plan, section 9 and packets R01/R02. The supplied screenshots specify report depth and names; they do not request a copy of the blue, verbose interface. Only the labels explicitly supplied below are screenshot requirements; no clipped or unreadable screenshot details are inferred.

The read-only Buildium reference review is recorded in [reporting-reference-review.md](reporting-reference-review.md) and copied into the canonical plan folder as `R-ops Reporting Reference Review.md`. It is a source of useful functionality patterns, not an exhaustive requirement list or a product-scope ceiling.

## Existing implementation to extend

| Surface | Existing code and behavior |
|---|---|
| Shared discovery | `shared/report-catalog.ts` supplies 53 definitions: 11 available rental engines and 42 planned entries. Authenticated `GET /api/rent-ops/report-catalog` and read-scope MCP `get_report_catalog` return the same schema-validated metadata, including supported report keys and existing MCP aliases. Metadata contains no business rows; actual report authorization remains enforced at execution. Availability means an engine is implemented, not that any result is complete or QBO reconciled. |
| Report library | `client/src/features/rent-ops/workspace/report-library.tsx`, reached through Reporting → Report library (`section=report-library`), reads that catalog and provides search, category/availability filters and per-user browser favorites. Available entries open existing reports with the current portfolio/date context; planned entries cannot run. |
| Rental report calculations | `server/rent-ops/domain/reports.ts`, reached through the rental service’s `report` method. Preserve its operational balances, receipt allocations, opening balances and uncertainty semantics. |
| Rental REST | `server/rent-ops/routes.ts`: authenticated `GET /api/rent-ops/reports/:report` returns the serialized report/filters/rows envelope; `GET /api/rent-ops/reports/:report/csv` returns CSV. These are fixed report routes, not a new catalog/job API. |
| Rental transport | `server/rent-ops/presentation/reports.ts` and `shared/rent-ops-contracts`: allowlisted fields, report names and compatibility aliases. Client decoding lives in `client/src/features/rent-ops/api.ts`. |
| Codex/MCP | `server/rent-ops/mcp/tools.ts`: `get_report` invokes the same rental service and serializes report rows; `get_tenant_ledger` accepts an exact tenancy ID. Current `get_report` names are `rent-roll`, `occupancy`, `scheduled-income`, `collected-income`, `scheduled-vs-collected`, `delinquency`, `tenant-ledger`, `lease-expirations`, `deposits`, `applicant-pipeline`, `hap`. |
| Rental UI/export | `client/src/features/rent-ops/workspace/reports-workspace.tsx`, `report-model.ts`, `report-export.ts` and export dialog. UI grouping, local filtering and curated columns exist; CSV and printable HTML exports exist. Do not assume these client transformations already match every raw REST/MCP result. |
| Company/project API | `server/company/routes.ts` and `server/company/mcp.ts`: company context, paginated project lists, project detail and shared project commands. Project detail contains scope, approved budget history, tasks and draft costs. These are not completed company financial reports. |
| QBO boundary | `server/integrations/quickbooks` contains transport work. As documented in `docs/company/project-workspace.md`, durable sync, verified company-to-realm persistence and accounting mirrors remain separate implementation packets. Project draft costs are not QBO posted actuals. |

The current fixed rental report routes return rows without immutable report runs, cursor pages or an export job lifecycle. The discovery catalog now advertises their actual HTTP/MCP mappings. Do not register duplicate rental report engines or advertise the remaining proposed operations as callable today. The expansion must reuse the existing calculations and adapters, then move applicable presentation/filter behavior into a versioned shared service with compatibility tests.

Existing UI period modes are: as-of for rent roll, occupancy, delinquency, lease expiration, security deposit and applicant pipeline; month for scheduled income, scheduled versus collected and HAP; inclusive date range for collected income and tenant ledger. Existing REST/presentation compatibility aliases include `lease-expirations`/`lease-expiration` and `deposits`/`security-deposit`. Preserve them. Canonical future catalog IDs below use `lease-expiration` and `security-deposit`; adapters resolve the existing aliases.

## Catalog and definition rules

Every ID below is a stable proposed catalog ID unless identified as an existing rental ID. An ID identifies business meaning; a separate definition version identifies changes in calculation/schema. A variant has its own discoverable entry but may reuse the same engine. Display-name changes never change IDs. Favorites persist IDs and authorized filter presets, not stale output rows.

Each definition declares supported scope, period mode, basis, actual/forecast mode, required source coverage, columns, sortable/filterable fields, grouping, exact total rules, permission requirements, supported exports and drilldowns. Scope IDs cover organization, legal entity/QBO realm, property, unit, tenant/tenancy, owner/investor, project, vendor and staff as applicable. Names are display fields, never join keys.

Financial actuals require explicit legal entities, declared cash or accrual basis and currency. Stocks use an as-of date; flows use inclusive from/to dates and a declared business timezone. Unsupported combinations return structured validation errors. No silent basis/date/scope substitution. Forecasts additionally require scenario ID, input version and model version. Comparison periods are explicit.

### Financial catalog — screenshot requirements

All entries below are planned. QBO-backed means verified posted books per realm, not bank-feed suggestions or project drafts. Each financial row exposes stable account/group IDs, entity/realm IDs, currency and exact amounts; allocated rows also expose property/unit and allocation identity where supported.

| Stable ID | Display title | Scope and time | Minimum content and drilldown |
|---|---|---|---|
| `balance-sheet-by-fund-type` | Balance sheet by fund type | Entity/property and approved fund classification; as-of | Assets, liabilities, equity by effective fund mapping; unmapped bucket; account balances → posted lines. Fund types require an approved mapping, never inference from account names. |
| `balance-sheet-consolidated` | Balance sheet consolidated | Explicit consolidation group; as-of | Entity columns, pre-elimination, elimination and consolidated balances; ownership/NCI policy; account → entity → journal/elimination. |
| `budget-vs-actual` | Budget vs actual | Entity/property/project; range | Approved budget version, actual, variance amount/percent and remaining budget; matching account/scope basis; budget line and posted actual drilldowns. Zero budget produces undefined percentage, not infinity. |
| `general-ledger` | General ledger | Entity, optional account/property; range with opening balance | Date, account, source transaction/line, payee, memo, debit, credit, running/closing balance; posted transaction. |
| `general-ledger-consolidated` | General ledger consolidated | Consolidation group; range | Entity-tagged GL lines plus separately identified eliminations and reconciled group opening/closing balances. |
| `income-statement` | Income statement | Entity; range | Income, operating expense, NOI under approved definition, other income/expense and net income; account → posted lines. |
| `income-statement-by-unit` | Income statement by unit | Entity/property/unit; range | Income/expense/net by unit, approved allocation method and unallocated balance; source line → allocation evidence. Incomplete mapping is visible. |
| `income-statement-consolidated` | Income statement consolidated | Consolidation group; range | Entity actuals, reciprocal-flow eliminations, group net income and ownership policy. |
| `income-statement-detailed` | Income statement detailed | Entity/property; range | Account/subaccount detail with posted transaction drill-through; same totals as ordinary statement for equal scope/basis. |
| `property-statement` | Property statement | Effective property ownership/entity scope; range | Property income/expenses, opening/closing cash where supported, CapEx and financing separately; unallocated entity bridge and source lines. |
| `rental-owner-ending-balances` | Rental owner ending balances | Authorized owners and effective interests; as-of | Owner/entity/property, payable or capital classification, verified ending balance, property reserves, held liabilities, restricted/available distinctions; owner activity and agreement. |
| `rental-owner-statement` | Rental owner statement | Owner/entity/property; range plus opening/closing | Contributions, operating results where attributable, returns of capital, distributions, obligations and ending balance; agreement/activity/posted cash drilldowns. |
| `trial-balance` | Trial balance | Entity; as-of, optional movement range | Account, opening, debits, credits, ending debit/credit; balanced controls and GL drill-through. |
| `trial-balance-consolidated` | Trial balance consolidated | Consolidation group; same period convention | Entity TBs, eliminations and consolidated debit/credit controls; individual account and elimination detail. |

### Rental catalog — screenshot requirements

Authority is current R-ops operational records and preserved historical evidence, linked to QBO postings where applicable. A rental report is not automatically a financial statement. Existing IDs indicate a starting calculation, not complete screenshot catalog coverage.

| Stable ID | Display title | Scope and time | Minimum content and drilldown / implementation starting point |
|---|---|---|---|
| `current-tenants` | Current tenants | Property/unit; as-of | Tenant/tenancy, unit, effective status, lease dates and current rent; tenant and lease records. Planned catalog entry over current operational records. |
| `delinquency` | Delinquent tenants | Property/unit/tenant; as-of | Rent/nonrent balance, credits, unapplied cash, aging, oldest due date and uncertainty; tenant ledger/charges/receipts. Existing report. |
| `lease-expiration` | Leases ending | Property/unit; as-of plus explicit expiry window | Tenant, end date, month-to-month, notice deadline/status and rent; lease record. Existing report; any new window filter must be implemented consistently. |
| `leasing-agent` | Leasing agent | Property/agent; range | Agent, draft-lease activation date, activated leases, applications, signed leases, move-ins and credited activity under declared attribution; application/lease evidence. Planned. |
| `rent-paid` | Rent paid | Property/unit/tenant; range with opening and closing | Lease dates, recurring charges, opening/prior balance, charges, credits, previous/current payments and closing rent due; receipt and charge IDs, tenant-paid versus subsidy, rent/deposit/fee allocation and posting state. Planned detailed variant reusing existing collected-income and tenant-ledger engines; reconcile its movement bridge rather than rename a receipts-only table. |
| `rent-roll` | Rent roll | Property/unit; as-of | Unit, tenant, occupancy, lease dates, market rent, recurring rent and other charges, credits, subsidy, deposits held, balance and exception state; unit/tenant/lease/ledger. Existing report. |
| `renters-insurance` | Renters insurance | Property/unit/tenant; as-of | Policy/provider, coverage dates, required coverage, expiry/compliance and missing evidence; authorized policy/document. Planned. |
| `security-deposit` | Security deposit and liabilities | Property/unit/tenant; as-of | Refundable types, held/applied/refunded amounts and unknown balances; deposit ledger → linked QBO liability/reconciliation. Existing rental report; QBO reconciliation remains planned. |
| `tenant-ledger` | Tenant statement | Tenant/tenancy and selected property scope; range | Opening balance, dated charges/payments/credits, allocations and closing balance; source transaction and receipt. Existing ledger engine; statement rendering shares its definition. |
| `tenant-vehicles` | Tenant vehicles | Property/unit/tenant; as-of | Vehicle description, authorized plate/access fields, permit/status and tenant link; privacy-controlled vehicle records. Planned. |
| `unit-listings` | Unit listings | Property/unit; as-of | Unit type, beds/baths, advertised rent, listing/readiness, availability and listing link; unit/listing record. Planned catalog entry. |
| `occupancy` | Vacant units | Property/unit; as-of | Vacancy status, days vacant, readiness, future lease and unit type; unit/tenancy. Existing occupancy engine; explicit vacancy preset, without treating signed future occupancy as current occupancy. |

### Task catalog — screenshot requirements

These catalog reports remain planned even though project task records already exist. Work orders use the future O01 operational record service; no legacy Rent Manager connection is implied.

| Stable ID | Display title | Scope and time | Minimum content and drilldown |
|---|---|---|---|
| `completed-tasks` | Completed tasks | Property/project/assignee/task type; completion range | Task, status, due/completed dates, assignee, linked work order/project; task history. |
| `open-tasks` | Open tasks | Property/project/assignee/task type; as-of | Open status, priority, due date, overdue age, blocker and assignee; task/history. |
| `tasks-performance` | Tasks performance | Team/staff/property/task type; range | Assigned/completed counts, overdue counts, completion/cycle times, reopened work and explicit denominator/attribution; underlying tasks. |
| `vendor-details` | Vendor details | Vendor/entity/property; as-of, activity range optional | Contact, service category, authorized custom fields, approved compliance state, linked work and posted spend with separate open commitments; vendor/work/bill records. |
| `work-orders` | Work orders | Property/unit/vendor/assignee/work-order type/status; as-of or declared activity range | Issue, status, priority, requested/scheduled/completed dates, linked tasks, costs and chargebacks; work-order record and financial links. |
| `work-sessions` | Work Sessions | Staff/task/work-order/property; range | Staff time-entry ID, start/end, duration, approval and linked task/work order; time-entry history. Duration is not payroll cost; payroll costing requires a separate authorized rate/source. |

### Additional existing-plan coverage

These entries come from Build Plan section 9, not inferred screenshot content. They remain planned except the identified rental engines. R01 covers book reports/allocations/consolidation, R02 the forecast engine, R04 estimating comparables, O01 work orders, and V01–V03 investor authority/activity/statements. R03 is company agreements/workflows, not a substitute reporting engine.

| Stable ID | Coverage and required distinctions |
|---|---|
| `balance-sheet` | Ordinary entity balance sheet, as-of, same account/posted-line controls as consolidated variant. |
| `cash-flow-statement` | Entity operating/investing/financing flows, range, beginning/ending cash tie-out and declared supported book method. |
| `portfolio-financials` | Ownership-aware entity statements with explicit eliminations and retained pre-elimination totals. |
| `property-t12` | Trailing 12 monthly property operating statements, account detail, approved adjustments and separate CapEx/financing. |
| `accounts-receivable` | Entity/tenant aging and bridge to rental balances by declared posting mode; credits, unapplied receipts and subsidies stay distinct. |
| `accounts-payable` | Entity/vendor unpaid bills, due dates and retainage; posted A/P separated from commitments/incurred-unbilled exposure. |
| `contractor-exposure` | Project/vendor posted unpaid cost, unconsumed commitment, incurred-unbilled and dated forecast need with overlap removed. |
| `project-performance` | Original/revised budget, posted actual, recognized operational cost, paid, open commitment, cost-to-complete, forecast variance and dates. |
| `rehab-benchmark` | Comparable scope/specification/unit costs with quantities, dates, sample count/range and underlying verified costs. |
| `cash-position` | Per-entity bank-observed, QBO book, PM-held, restricted, pending and available cash, each with source/time and no duplicate stock balance. |
| `cash-forecast-13-week` | Entity/scenario dated inflows/outflows, reserve floor, minimum cash, funding gap, draws and obligations; actual versus forecast explicit. |
| `operating-growth-plan` | Versioned 36-month scenario with acquisitions, lease-up, capital deployment and reserves. |
| `debt-refinance` | Instrument/entity balances, principal/interest, maturity, payoff evidence, DSCR/LTV and modeled net proceeds separate from cash available. |
| `exit-scenarios` | Flip/sale/hold assumptions, dated cash flows, economic profit, cash invested, break-even, ROI and equity multiple. |
| `investor-owner-activity` | Agreement/effective-ownership-based contributions, obligations, return of capital and distributions; actual payment separate from proposal. |
| `lender-management-package` | Versioned selection of statements, rent roll, draw/rehab, REO/PFS and required templates. Generation never authorizes sending to a lender. |
| `scheduled-income`, `collected-income`, `scheduled-vs-collected`, `hap`, `applicant-pipeline` | Preserve existing rental reports and period conventions within the searchable catalog. |

## Accounting, joins and completeness

QBO posted transactions and supported official reports supply per-realm financial totals at a verified synchronization watermark. R-ops supplies tenant, lease, unit, project, work-order, ownership and operational allocation context. Posted R-ops-derived receipts/costs linked to QBO are one economic event: enrich or reconcile the QBO posting, never add it a second time. Draft cost, invoice, payment allocation, PM settlement, bank settlement and forecast are distinct states. Bank feeds/Plaid provide bank observations, not an additional income/expense ledger.

Use verified organization/entity/realm identities and effective-dated property/ownership mappings. Property transfers and ownership changes apply on their actual effective dates. Do not allocate all historical income using current ownership. Entity-to-property and property-to-unit splits require an approved, versioned method and evidence. Show unallocated amounts and incomplete coverage; allocated plus unallocated must reconcile to the entity total. Never estimate a unit allocation simply to fill a report.

Cash-basis reports use supported QBO native cash-basis behavior with verified posting-mode fixtures. Do not derive cash P&L by subtracting A/R changes from an accrual statement. Summarized posting bridges must declare their validated basis limitations. Unsupported native reports require a reviewed supported export/source path, not invented endpoint support.

Consolidation requires an explicit entity set, period, basis, currency, ownership/NCI policy and elimination version. Retain entity and pre-elimination totals. Match reciprocal due-to/due-from and flows by verified intercompany identity; record separate eliminations with traceable lines. Missing counterpart, unequal amount or unsynchronized realm prevents a complete consolidated claim. Do not eliminate unrelated equal amounts. Mixed currencies require an approved translation policy/rates; otherwise reject the combination.

Unknown, unavailable, stale, partial, not applicable and verified zero are different states. Null money carries reason codes, source coverage and known subtotal where useful. Ratios use underlying amounts and declared denominator/rounding; opening/closing stocks are not summed as flows. Output signs, rounding and totals are definition-controlled.

## One versioned service for UI, REST and Codex

The following are required capabilities. Basic catalog discovery is implemented as described above; the richer run/page/drilldown/export/job contract remains planned. Implement those through one authenticated report service; choose transport names in the implementation packet and retain existing rental aliases.

| Capability | Required contract |
|---|---|
| Catalog | Authorized searchable/grouped definitions; stable ID/version, period/basis/scope/filter schemas, column types, supported formats and honest availability. |
| Run | Validated report definition/version, canonical scope and filters, date/basis/currency/scenario, request ID; return a bounded result or queued run ID. |
| Page | Stable cursor and deterministic sort with row-ID tiebreaker against the same immutable run; bounded limit, row count/coverage and separately defined whole-run totals. |
| Drilldown | Same run snapshot and authorized scope; stable source/line/allocation IDs and bounded children; source evidence without dumping full records. |
| Export | Same snapshot, columns, filters, basis, sorting, rounding and totals as the UI/API; explicit format and authorized download artifact. |
| Job/status | Queued/running/ready/failed/cancelled/expired states, progress when meaningful, request/run IDs, retryability, structured errors and expiry. A queued job is not a completed report. |

Run envelopes include service/definition versions, request ID, run/snapshot ID, canonical filters, generated time, source watermarks/realm freshness, currency/basis, row/column schema, row IDs, totals, completeness/missing-data codes and next cursor. Financial money crosses the company boundary as signed decimal strings of integer minor units plus currency; never floating-point dollars. Preserve legacy rental integer-cent interfaces through explicit compatible adapters and reject unsafe-integer conversion. Durations, percentages, quantities and money have separate types.

Persist or reproducibly reference immutable input revisions, QBO watermarks, allocation/ownership/elimination versions and forecast inputs. Re-running an immutable snapshot reproduces the result; a fresh run receives a new snapshot. Cache keys include permissions, definition, normalized scope, period, basis, currency, scenario and all source versions. Never reuse another actor’s broader result.

The UI, REST and MCP enforce the same organization/entity/property/record and field permissions. Validate permission again on pages, drilldowns, export creation and download; opaque IDs are not authorization. Revocation invalidates access to old runs/artifacts. Restrict tenant statements, insurance, vehicles, staff time and owner information appropriately. No unrestricted SQL, entire-database dump or giant serialized ledger exposed to Codex. Large reports run as bounded jobs with pagination and retention limits.

## Interface

Use a grouped searchable library with Financial, Rental, Tasks and appropriate Project/Investor/Forecast collections, short report titles and favorites. Choosing a report opens its scoped filters and result. Provide advanced columns, basis/mapping/completeness detail and drilldown through progressive disclosure. Keep financial tables opaque, readable and keyboard accessible. Use company charcoal, gold and cream with restrained controls; do not recreate the screenshot’s colors, dense navigation copy or explanatory blocks.

Report setup is setup-first: selecting a report opens the audited, report-specific filter definition before Run report is available. The shared definition is the contract for the browser, REST, and Codex surfaces; dependent controls such as collected-income month versus activity range, lookup references, multi-select status arrays, and report-specific defaults are described by the same metadata. The current matrix is `docs/company/report-filter-matrix.md`. A catalog entry remains planned until its executable engine, validated server filters, and HTTP/Codex parity exist, so planned entries do not advertise runnable filters.

Display material basis/scope/period and missing-data states where needed to interpret figures. Keep technical provenance and audit evidence in the service/details surface, outside authored deliverables. Preserve required third-party templates. Do not add decorative covers, footnotes, source tabs or commentary to exported deliverables unless requested. Favorites never bypass access checks. Export/download is separate from sending a communication.

## Acceptance gates

1. Catalog coverage: every explicitly named screenshot report is independently discoverable with its stable ID or deliberate compatible variant; additional plan entries are tracked separately. Planned entries cannot pretend to produce live reports.
2. Exact parity: fixed fixtures show matching rows, totals, null states, grouping and exports through UI, REST and Codex for the same versioned run. Existing report aliases and bookmarks still work; no parallel calculation engine.
3. Scope/permission coverage: all entity/property/unit/tenant/date/status/basis filters work across run/page/drilldown/export; unauthorized users and revoked grants cannot recover cached results or export URLs.
4. Financial controls: individual LLC reports tie to verified QBO source reports at declared basis and watermark. Cash and accrual fixtures, summarized-bridge limitations, partial realm sync, effective ownership changes and missing allocations are tested.
5. Consolidation: entity/pre-elimination/elimination/final totals reconcile; reciprocal mismatch and missing counterpart cannot silently disappear; currency and NCI policy are explicit.
6. Cash integrity: posted receipts, allocation, settlement, bank cash, deposits, subsidy, CapEx, draft project costs and commitments are not double counted. Actual cash never includes modeled refinance proceeds.
7. Missing data: true zero, null, partial coverage, stale source, zero denominators and inaccessible fields remain distinguishable in UI, API and export. Unit reports do not invent allocations.
8. Reproducibility and operations: stable pages with no omitted/duplicate rows, snapshot repeatability, freshness invalidation, bounded memory/output, cancellation/retry/expiry and permission-safe job recovery. Meet canonical plan performance budgets at initial and 10× fixtures with concurrent/background load; local smoke timing alone is not launch acceptance.
9. Usability: keyboard and screen-reader access, clear active filters, empty/error/loading states, mobile table scrolling and meaningful financial columns. No browser-only report logic that Codex cannot request through the same authorized service.

R01 financial acceptance still requires its Q02/Q03 source and posting evidence gates; the independently useful catalog does not satisfy them. R02 adds forecast calculations without replacing actuals. The catalog/library slice creates no schema migration, QBO connection, background worker or live accounting change. Future code must replace planned metadata only when the associated engine and parity tests actually work.
