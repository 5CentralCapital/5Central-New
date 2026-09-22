# Company reporting build

Reporting uses one versioned service for the browser and Codex. The service receives an authenticated principal, a versioned report request, and injected read ports. It validates the report-specific setup filters, reloads authorization when the root request wrapper provides a refresh hook, executes one registered engine, and stores an immutable run snapshot.

The shared catalog exposes all 53 canonical report definitions: 11 accepted Rent Operations reports and 42 planned reports. Planned definitions remain discoverable with their required source and dependency names. An entry becomes executable only when its registry engine is ready. The first engines are:

- `rental.operational`: the 11 existing rental reports, with legacy aliases retained by the existing adapter. Legacy numeric `*Cents` fields become canonical decimal strings at the reporting boundary.
- `quickbooks.native-reports`: native QuickBooks Online balance sheet, cash-flow, general ledger, income statement, detailed income statement, and trial balance requests. It requires one explicit legal entity, one verified connection, an explicit cash or accrual basis, and an explicit currency. Consolidation, property allocation, and cash-from-accrual inference are unavailable without their approved policies and mappings.

The native adapter applies account filters only to its verified account-capable endpoints and applies month/quarter/year grouped columns only to its verified statement endpoints; unsupported combinations return an unavailable result. It preserves provider account IDs and section/summary row kinds, and uses the provider-declared empty and truncation markers for coverage.

The browser receives the catalog first and does not execute a report until the user selects its period, named scope, and report-specific filters. Runs return metadata and a bounded first page. Later pages, drilldowns, and CSV/JSON/HTML exports read the same run and snapshot IDs. A report with incomplete source coverage carries a visible coverage state and missing-data record; an empty source response is never converted into a verified zero without source evidence.

Presets are private or shared and carry an immutable revision history. Updates require the current revision and use a database compare-and-swap. Packages freeze their constituent report definitions, filters, period, basis, currency, and scope. A package run stores each successful report run ID and records a failed item with a null run ID rather than fabricating a result.

`server/reporting/schema.sql` is an additive schema candidate for migration 38. It creates immutable run headers, paged run rows, drilldowns, exports, preset/package current records and revision history, and package runs. Organization and parent-record foreign keys, payload identity checks, bounded state/visibility/format checks, nonnegative row indexes, positive revisions, and an organization/actor/request unique index protect replay and mixed-company writes. The company migration coordinator owns registration and rollout; this module does not auto-apply the schema.

The root company runtime supplies a transaction-scoped `ReportingPort`, current principal, dated property-to-entity mapping, Rent Operations reader, and QuickBooks connection factory. `registerReportingHttpRoutes` and `registerReportingMcpTools` accept that port, so web and Codex share authorization and execution behavior. The reporting persistence candidate is registered as migration 38; `server/reporting/schema.sql` is retained as historical design context and is not applied by this module.

## Planned report execution matrix

The 42 planned definitions remain discoverable in the single library. A report is marked executable only when its engine has a real read port; source rows may still carry partial coverage and named missing-data reasons.

| Definition IDs | Current status | Source gap or execution seam |
| --- | --- | --- |
| `balance-sheet`, `cash-flow-statement`, `general-ledger`, `income-statement`, `income-statement-detailed`, `trial-balance` | Executable when QuickBooks is configured | Native QBO adapter, one verified entity connection and provider-shaped report response; unconfigured credentials return source-unavailable. |
| `current-tenants`, `rent-paid`, `renters-insurance`, `tenant-vehicles`, `unit-listings` | Domain engines executable; insurance and vehicles partial | Transaction-bound R-Ops snapshot and dated property/entity scope. Insurance has expiry only; vehicles come from application records and do not prove current status. |
| `project-performance`, `rehab-benchmark` | Domain engines executable with project read port | Project service supplies budgets/tasks/actuals. Posted actuals and scope links retain partial or unavailable coverage. Budget selection is latest version approved by the requested as-of date. |
| `contractor-exposure` | Executable only with dated commitment read port | Approved commitment rows need vendor identity, approval/commitment date, currency and project scope. Missing dates remain unavailable for the requested period. |
| `completed-tasks`, `open-tasks`, `tasks-performance`, `vendor-details` | Domain engines executable with project read port | Project tasks and draft costs are available; vendor/account identity and task assignment filters remain explicit gaps. |
| `work-sessions` | Domain engine executable with Time read port | Provider timesheets require live coverage, employee/jobcode mappings and conflict status. Unmapped assignment filters are rejected as unavailable. |
| `investor-owner-activity` | Domain engine executable with investor read port | Activity rows are filtered by occurred date. Owner ending balances and owner statements remain separate until dated ownership/accounting facts exist. |
| `balance-sheet-by-fund-type`, `balance-sheet-consolidated`, `budget-vs-actual`, `general-ledger-consolidated`, `income-statement-by-unit`, `income-statement-consolidated`, `property-statement`, `trial-balance-consolidated`, `portfolio-financials`, `property-t12`, `accounts-receivable`, `accounts-payable`, `cash-position` | Domain engines executable only with accounting mirror and mapping port | Statement semantics, accounting basis, dated property/unit/fund mappings, canonical realm-safe account identity, bank observations and explicit consolidation/translation/elimination policies are required. No cash-from-accrual inference. |
| `rental-owner-ending-balances`, `rental-owner-statement` | Blocked | Requires dated ownership agreements and owner asset/cash/reserve/liability accounting facts; investor payment rows are not substituted. |
| `leasing-agent`, `work-orders` | Blocked | No verified leasing attribution or company work-order source is modeled. |
| `cash-forecast-13-week`, `operating-growth-plan`, `debt-refinance`, `exit-scenarios` | Executable only with forecast read port | Versioned scenario/input/model records, verified actual boundary, explicit currency and model-specific inputs are required. The 13-week cash engine rejects noncontinuous or unreconciled weeks. |
| `lender-management-package` | Executable only with frozen package read port | Each section must reference an immutable report run and required template; incomplete sections remain partial. |

The remaining planned catalog entries (`balance-sheet-by-fund-type` through `lender-management-package` above) are definitions, not claims that data exists. The registry exposes blocked entries with their dependency reason until a request-scoped adapter is wired.
