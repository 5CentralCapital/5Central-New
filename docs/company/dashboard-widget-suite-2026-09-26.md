# Dashboard widget suite and new default layout (Sept 26, 2026)

Michael asked for (1) the Sept 24 "dashboard v2" mockup (`5Central Capital/Claude outputs/dashboard-1.html`, Command preset) as his default dashboard and (2) a full library of resizable widgets, at least ten per category, about 75 in total.

## What changed

- **Default layout = the mockup's Command preset.** In order: Cash card · Rental summary · Rentals by property · QuickBooks summary · Coming up · Occupancy trend · Cashflow weekly plan · Project totals · Rehab progress · Schedule · Projects board.
- The old default is kept as the **Rentals** preset. The other presets are Tenant ops, Units, Cash, Projects, Books and Everything. Every preset is tested to tile the grid with no gaps.
- Saved layouts moved to the storage key `rent-ops-dashboard-layout:v2:<user>`, so everyone lands on the new default once. After that, customizations save as before.
- **114 widgets** in seven library tabs:
  - Tenants: 22
  - Units: 22
  - Cash: 17
  - Accounting: 14
  - QuickBooks: 16
  - Projects: 18
  - Company & tools: 5

  Every widget has two or more sizes. You can resize from the library, from the corner drag, or by right-clicking the widget.

## Where the data comes from (read only)

Rental widgets use the rows the dashboard already loads, plus these rental reports:

- lease-expiration
- security-deposit
- hap
- scheduled-vs-collected

Company-side widgets load their own data, and only when the widget is on the dashboard (`dashboard-sources.ts`):

| Area | Source |
|---|---|
| Projects | `listProjects`, `getProject` (tasks), `getDealCostReport` (sale forecast, profit, whole-deal cost) |
| QuickBooks | `accounting/health` picks one connection per legal entity: production before sandbox, retaining unavailable companies so missing data stays visible. From readable connections: native `income-statement` / `balance-sheet` YTD per entity (cache scoped to the exact connection), close checklist for last month, bills and bill payments, and the account, vendor and customer mirrors and transactions. |
| Accounting | PM settlements, the investor payment calendar (months as `YYYY-MM-01`), and debt maturities |
| Forecast | The most recently updated approved base scenario, previewed at its current assumption version. Draft and upside scenarios cannot silently substitute for it. Weekly widgets require a forecast covering the selected date. It supplies the weekly cash grid, runway, weekly net, in vs out, low point, cash lines, big moves, DSCR, maturity ladder and monthly NOI. |
| Company | `workspaces/dashboard` supplies obligations, maturities, review cases and work due. It shares a request with the Needs attention rows. |

Unknown amounts stay unknown: a missing or partial read shows "Unknown", "Unavailable", or an explicitly labeled lower bound. Complete confirmed zero remains $0. Totals never combine different currencies.

## Files

The widgets and their shared pieces live under `client/src/features/rent-ops/workspace/`:

| File | What it holds |
|---|---|
| `dashboard-kit.tsx` | Data contract, widget definition, tiles, rows, bars, tables, stat strip, SVG charts (columns, paired columns, line), ring, stack, pager, cents and date helpers |
| `dashboard-sources.ts` | Company-side data hooks |
| `dashboard-widgets-overview.tsx` | The mockup widgets |
| `dashboard-widgets-{tenants,units,cash,accounting,quickbooks,projects}.tsx` | The category libraries |
| `dashboard-widgets.tsx` | The existing rental widgets, recategorized, and the combined `WIDGETS` registry |
| `dashboard-widgets.css` | Widget visuals. Imported by `rm-dashboard.tsx`, so `node --test` never loads CSS. |
| `dashboard-presets.ts` | The presets |
| `dashboard-widgets-suite.test.tsx` | Suite size, resizability, default layout, rendering of every widget at every size with seeded company data and while loading, and the unknown-never-zero checks |

Changes to existing files:

- `rm-workspace.tsx` passes `organizationId` and `onOpenCompany` to the dashboard, so widgets can open projects, accounting, investors, forecasting, work orders and the review queue.
- The navigation and report-setup browser smokes now look for `rent-summary` and `rent-table`, the `occ-trend` chart, and `milestones`, instead of `attention` and `balances` and the old trend chart.

## Integration and audit

PR #12 is already on production. This branch includes that production revision and preserves its dashboard options in the scope bar.

The audit corrected incomplete and paginated source reads, company and QuickBooks connection selection, forecast approval and date coverage, payment subtraction, deposit and rent uncertainty, decimal interest-rate formatting, and aggregation of monthly remittances and forecast categories. Exact monetary strings stay exact in displayed totals. Chart inputs outside the safe numeric range are unknown.

The dashboard refresh now refreshes financial and forecast queries, saved layouts follow the signed-in user, and cash-card pages support keyboard and touch navigation. Focused regression tests cover the corrected behaviors alongside the all-widget rendering suite.
