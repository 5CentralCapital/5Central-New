# 5Central Ops rollout status — September 23, 2026

This records the audit of the code against `rollout-roadmap-2026-09-23.md` and what was built on branch `claude/5central-ops-rollout` in response. The product is now named **5Central Ops**; internal identifiers (`rent_ops_` tables, `/api/rent-ops` routes, `RENT_OPS_*` variables, `rent-ops:*` OAuth scopes, migration SQL) are unchanged so existing data, tokens and deployments keep working.

## Baseline (U00)

Source: device checkout `/Users/michaelmcelwee/Projects/r-ops` on `claude/rops-design-system`. The audit ran on `7d97a2d` plus its then-uncommitted QBO OAuth-discovery/callback changes; those were committed on the device as `e8f3e4c` during this work, and this branch is based on `e8f3e4c`. The Mac desktop workstream's files (`desktop/`, `src-tauri/`, the Tauri scripts and dependency in `package.json`, `docs/company/desktop-app.md`, `scripts/company/desktop-config.test.ts`) are not part of this branch and were not touched. Baseline checks: typecheck clean, 239 company tests and 1,210 rental tests passing, 42 migrations.

Audit findings that shaped the build:

- The new report screen could not run any of the 42 non-rental reports: it hid the period filters and then sent them empty while the server required them. The three setup defects in the roadmap were confirmed. The twelve "blocked" financial reports, four forecast reports and the lender package already had engines; nothing supplied their data.
- No durable worker, dispatcher, webhook route, change-data-capture sync, posting-method policy or PM gross-to-net model existed. The QBO write reconciler existed but was never called.
- "Needs review" was recomputed from ~50 raw codes on every read, with no persistent cases, queue or commands.
- The MRA intake and company-document services had no migration, no HTTP/MCP routes and unmounted screens.
- There was no forecast engine, scenario storage or Forecasting screen.
- Navigation had a one-item Dashboard dropdown, ~14 target destinations without pages and several disabled "Planned" entries.
- The MCP server exposed ~148 tools with no server instructions, all-or-nothing write annotations and several unbounded outputs.

## Packet status after this build

"Built" means implemented with automated tests against synthetic data. No packet is live-accepted: live acceptance needs the prerequisites in the last section.

| Packet | Status | What exists now |
|---|---|---|
| U00 Baseline | Done | Snapshot commit, audit above, baseline test counts. |
| U01 Contracts | Built | Migrations 043–048: MRA intake, company documents, review cases, durable jobs, accounting integration operations (webhook ledger, deletion tombstones, rental posting policies, PM settlements, widened write attempts), forecasting. Registered in the frozen registry with recovery notes; runtime grants and append-only classification updated. |
| U02 Review inventory | Built | `get_review_inventory` (HTTP, MCP, `scripts/company/review-inventory.ts`): counts by reason, materiality, state and affected-record overlap, with the remaining cases' missing evidence and next action. Live counts require the production database. |
| U03 Review resolution | Built | 23 reason codes with short labels; a deduplicating detector (one cause across many tenants is one case); persistent cases with append-only history; reopen on evidence change; guarded commands (research, evidence, propose, block, apply through the existing guarded writers with before-hash checks, verify by re-detection). Financial corrections are routed to Accounting, never applied from a case. Daily detection runs in the worker. Every generic "Needs review" label in the app was replaced with a specific status. |
| U04 Company activation | Partial | Grants, dated property/entity periods and realm bindings exist and are enforced. Bootstrapping the real organization, entities and grants needs verified ownership records and production access. |
| U05 QBO transport | Built | Postgres job queue (SKIP LOCKED leases, backoff, dead letters, checkpoints, operator requeue/cancel), outbox dispatcher, separate worker process (`npm run worker`, Render `type: worker`), CloudEvents webhook route with signature verification, per-event dedupe and multi-realm fan-out, CDC with 30-day window and scoped full replay plus deletion tombstones, connector health read. Tested against fakes only. |
| U06 Accounting bridge | Built | One rental posting method per entity and period (overlap rejected in code and database; native receivables requires confirmed invoice-delivery settings), summary-bridge preview with control totals, PM settlements with gross-to-net conservation ($1,000 collected / $100 costs / $900 remitted, never $1,900 income), durable write journal with prepare → validate → submit → readback. Production writes stay off by default. |
| U07 Navigation | Built | Ten categories, Dashboard as a direct link, one-level menus with only working destinations, toolbar actions, tenant status as a Directory filter, account menu, narrow-screen section selector, legacy-link aliases, browser smoke passing in Chromium. |
| U08 Connected views | Built | Property record tabs (Overview, Rent roll, Financials, Projects, Work orders, Documents); Financials shows distinct measures with basis and drilldowns, computed from the report derivation (tested equal to report totals); new pages for Performance, Collections, Leases & renewals, Move-ins & move-outs, Make-ready, Listings, Entities & ownership, People & vendors, Settings, Cost library. |
| U09 MRA | Built | Codex-only MCP tools to stage/map/preview/apply packets, read-only web results, per-account savepoints, harmless replay, resume without re-applying, revised packets never erase applied lines, held lines feed review cases. A genuine packet has not been run. |
| U10 Projects | Built | One canonical cost summary (original, changes, revised, committed, incurred, paid, remaining commitment, cost to complete, forecast final cost, variance), retainage rollforward, closeout checklist, templates, QBO line linking with allocation limits. |
| U11 Investors/debt | Built | Amortization with interest-only periods and balloons, monthly rollforward, derived balance compared with the manual balance, payment calendar, contributions and distributions, maturity ladder, agreement versions, obligation generation from the UI. Real agreements still need to be loaded. |
| U12 Time | Built | Posted payroll linking (allocation-checked), labor estimates replaced by posted payroll without double counting, DST and overnight shifts. The QuickBooks Time account connection and the four employee identities are not verified. |
| U13 Reports | Built | All 53 reports have implemented engines and report runtime status: available, missing data (with the exact reason) or not implemented (none). Period, forecast, consolidation, grouping and reference-filter defects fixed; scoped reference lookups; CSV formula-injection protection; printable output; multi-report package editor and run view; saved setups open with their filters. The generated 53-row inventory is in `reporting-contract.md`. QBO statement reports need a live connection. |
| U14 Model migration | Partial | Read-only workbook import for the documented Cashflow layout, tested on a generated workbook. The real `Portfolio Overview.xlsx` and `3YR Plan.xlsx` were not available here; `forecast-model.md` lists what must be verified against them. |
| U15 Forecast engine | Built | Deterministic double-entry engine: daily events, weekly and monthly buckets without double counting, linked income statement, balance sheet and cash flow with no plug, 13-week treasury view, scenarios, immutable assumption versions and reproducible snapshots, and invariant checks on every run. |
| U16 Forecast UI | Built | Reporting → Forecasting with Cash, Income, Balance sheet, Debt, Scenarios and Assumptions; charts drill to contributing events; unknown opening balances are shown as unknown. |
| U17 Packages/exports | Built | Presets, packages, immutable runs, exports matching on-screen totals. |
| U18 Agent parity | Built | Server name `5central-ops` with instructions, `get_ops_capabilities` discovery tool, per-operation annotations, bounded rental reads, generated `mcp-inventory.md` (232 tools) with a drift test, and `agent-setup.md` for Codex and Claude Code. Real client runs are not done. |
| U19 Company cutover | Not started | Excel/Airtable migration needs the source workbooks and tables. |
| U20 Release proof | Not started | Needs the prerequisites below. |

## Verification on this branch

On the final commit: typecheck clean; migration registry valid (48); `test:company` 426 passed, 3 skipped (they need a real PostgreSQL URL); `test:rent-ops` 1,264 passed, 3 skipped; `test:performance` and the QBO sandbox harness tests pass; production build succeeds; the navigation browser smoke passes in Chromium (WebKit is not installed in this environment). The report-setup browser smoke has one failure that also occurs on the untouched baseline: the demo tenant ledger returns no rows when filtered to current tenants, because the synthetic tenancy's status is evaluated against today's date.

## Prerequisites that remain outside the code

- Intuit production approval and each entity's OAuth grant; then the read-only comparison of opening balances, trial balance and PM clearing before any write type is enabled.
- A webhook verifier token per environment (`QBO_WEBHOOK_VERIFIER_TOKEN_SANDBOX`, `QBO_WEBHOOK_VERIFIER_TOKEN_PRODUCTION`) and the Render worker service.
- Applying migrations 043–048 to production through the reviewed migration process after a backup.
- A genuine, complete MRA packet run through Codex.
- The real investor agreements, the forecast workbooks and verified ownership dates.
- The QuickBooks Time subscription and employee mappings.
- Real Codex and Claude Code connections against the deployed endpoint, using the checklist in `agent-setup.md`.
- The Intuit app profile name, which should be updated to "5Central Ops" to match the legal pages (they note the former name).
