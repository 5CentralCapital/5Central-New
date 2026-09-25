# Handoff: design-audit fixes (September 24, 2026)

For Codex: push, merge and deploy. Prepared by Claude.

## State

- Branch `claude/design-audit-fixes` in `~/Projects/r-ops`. It is based on `origin/production` at `e35e5e0` (PR #7 merged in). It is **not pushed**: neither Claude environment has GitHub credentials.
- Only the branch ref exists. The working copy is still on `claude/rops-design-system`, and the uncommitted desktop/Tauri files are untouched.
- There are no migrations, schema, API or server changes. Two exceptions: the time module's client stops sending the premature request that returned a 400, and browser-smoke selectors changed. Money math, balances, posting, QBO write gates and the cash card are unchanged.

## Ship it

1. `cd ~/Projects/r-ops && git push -u origin claude/design-audit-fixes`
2. Open a PR into `production`. If `production` has moved, merge it into the branch first and re-run the checks below.
3. Wait for the required "Verify and build" check, then merge.
4. Render deploys `production` after checks pass. Check whether auto-deploy was restored after the schema-050 release; if not, deploy both services by hand. Keep the worker policy you already use.
5. Verify on https://5central.capital/ops:
   - The dashboard shows the KPIs, "Needs attention", "Balances due" and "Units by property".
   - The scope bar sits beside the title.
   - Unit C1's tenant record shows "Balance due $0.00" with a "Ledger shows $1,400.00" warning.
   - Accounting shows one status line, and "Disconnect QuickBooks…" is only in the ··· menu.
   - Rent roll shows results on open.

## Checks already run (cloud, Chromium)

| Check | Result |
|---|---|
| `npm run check` | Clean |
| `npm run company:migrations:verify` | Valid, 50 |
| `npm run test:all` | 2,084 tests: 2 failed, both fixed and re-run green |
| `npm run test:performance` | 17/17 |
| `npm run build` | Passes |
| `company:navigation-smoke`, `company:report-setup-smoke` | Pass, with selectors updated for the new dashboard |

On the untouched production build, the navigation smoke was already failing: it expected the Accounting menu item "Overview", but the label is now "Dashboard". Also, the demo Applications page shows "API returned an invalid response" on the untouched production build too, so that isn't a regression.

## Decisions from Michael

- **Unit C1 owes $0.** The reviewed operational balance wins in the tenant header. A differing posted ledger shows as a warning with a Reconcile link.
- **Cash card:** the gap between Current and Available is payments in processing. Leave it as is.
- He asked for every audit fix. That includes the dashboard restructure, which overrides the older `AGENTS.md` note to keep the RM-style dashboard layout; update that note when you merge.

## What changed (design audit IDs)

- **Foundations (F1–F8):**
  - Shared formatters in `client/src/lib/rent-ops-formatters.ts`: no ISO dates or seconds on screen; "Jun 1" in tables, "Sep 24, 2026" in headers.
  - Tenant balances are called "Balances due" everywhere.
  - Loading shows skeletons, never "Unknown". Real data gaps show "Not verified".
  - Gold is used only for the brand mark and the focus ring.
  - One filled button per screen.
  - Nothing smaller than 11px; labels are sentence case.
  - New `client/src/styles/ops-tokens.css`. Feature CSS reads `--ds-*` directly, and the per-module remap blocks are gone from `rops-system.css`.
  - Shared primitives in `client/src/features/rent-ops/workspace/ops-ui.tsx`.
- **Shell (S1–S4):** `scope-bar.tsx` replaces the old filter toolbar. The page-header "Add property" button was removed (it's now a + in the property list). The avatar shows real initials.
- **Sign-in (L1–L2):** `auth-ui.tsx` and `rent-ops.css`.
- **Dashboard (D1–D8):**
  - `rm-dashboard.tsx`, plus new `dashboard-attention.ts` with tests.
  - `dashboard-company.tsx` now renders rows inside Needs attention.
  - `dashboard-chart.tsx` has a metric switch, a time-scaled axis, a fitted range and a labeled endpoint.
  - `dashboard-kpis.ts` has a loading tone and shows exact cents for balances due.
- **Record screens:**
  - Properties (P1–P4): `property-unit-records.tsx`.
  - Tenant record (T1–T3): six tabs, and the old tab keys still route. Files: `tenant-record.tsx`, `tenant-model.ts`, `balance-review-display.ts`.
  - Tenant list (T4): `rm-workspace.tsx`.
  - Applications (A1–A3): `applications-workspace.tsx` and new `applications-view-model.ts`.
  - Leases (A4): `workspaces/leases-renewals.tsx`.
- **Collections (C1–C4):**
  - `workspaces/collections.tsx` and new `collections-model.ts`.
  - `payment-review-panel.tsx`.
  - The recurring register in `rm-workspace.tsx`.
  - The `grid.tsx` column picker.
- **Accounting (Q1–Q4):** `features/accounting/*` and `rm-banking.tsx`. Disconnect QuickBooks now requires typing the company name in an in-page confirmation.
- **Reports (R1–R3):** `report-setup*`, `reports-workspace.tsx`, `report-library.tsx`, `features/reporting/*`. Rent roll, Vacancies and Balances due run on open, and filters show as chips.
- **Modules (M1–M4):** empty states in `projects`, `investors`, `work-orders` and `time`.
- **Phone (X1–X2):** the scope bar stacks on a phone, and dashboard tables show a few rows plus "View all" instead of scrolling inside cards.

## Follow-ups (not blocking)

- Apply the retired-token approach (read `--ds-*` directly) to any feature CSS added later. `appearance.test.ts` now guards the main modules.
- Some module badges and table headers still set their own letter-spacing; that's cosmetic only.
- Notes still save in the browser only. Move them to the server if Michael wants them shared.

## Added on the same branch: the widget dashboard (September 24, evening)

Michael asked for the dashboard he reviewed as HTML mockups to ship in this same deploy. The dashboard is now a grid of widgets the manager arranges; nothing else on the branch changed.

- **Grid** (`dashboard-grid.tsx`, `dashboard-grid-model.ts`, `dashboard-grid.css`): square cells, 12 columns (4 on a phone). Every widget is one of a fixed set of sizes (Small 2×2 … Full 12×6, see `SIZES`), so the grid always tiles. Customize from the small corner button or the right-click menu: drag a title to move, drag the corner to snap between sizes, − removes, the library drawer adds by category. Right-click a widget for its sizes. Layouts save per user in `localStorage` (`rent-ops-dashboard-layout:<userId>`); saved layouts are validated and de-overlapped on load.
- **Widgets** (`dashboard-widgets.tsx`): 25 widgets, all on data the dashboard already loads plus the banking snapshot. Each renders for the size it was given (row counts come from the body height), so nothing scrolls inside a card except the two lists built to scroll (Needs attention, Company items).
- **Presets** (`dashboard-presets.ts`): Command (the audit layout, which is the default), Tenant ops, Cash, Everything. `dashboard-grid-model.test.ts` checks every preset tiles with no overlaps and no empty cells.
- **Data layer**: `rm-dashboard.tsx` keeps every request from the audit and hands one `DashboardData` object to the grid. `dashboard-kpis.ts`, `dashboard-attention.ts`, `dashboard-tiles.ts`, `dashboard-chart.tsx` and `dashboard-company.tsx` are unchanged.
- **Smokes**: the navigation and report-setup browser smokes now look for `.ops-widget[data-widget="attention"]` / `[data-widget="balances"]` instead of the old two-column row. `scripts/company/demo.ts` honors `ROPS_PUBLIC_DIR` like the smokes do.

Verified in the Cowork Linux VM: `tsc` clean; the dashboard unit tests pass (30, including 8 new); `vite build` passes; the synthetic company demo renders all four presets with no console errors, right-click resizing persists across reload, and the phone layout has no horizontal overflow. The full suite and the browser smokes should still be run by Codex before merging (the VM cannot run the repo's darwin esbuild binary for the whole suite).

Not in this deploy, because the app has no source for the data yet: the Excel Cashflow-tab widgets (15-week grid, weekly net, big money in/out, debt due), the flip projection widgets (rehab, gantt, profit, Cameryn split, editable projections) and the QuickBooks P&L widgets. Those need endpoints first; the mockups in the Cowork session are the spec.
