# Existing 5Central Ops interface

Michael clarified the design direction on September 21, 2026: preserve the current manager dashboard's tables, charts, arrangement and workflows, while modernizing its appearance. The earlier rejected replacement dashboard remains outside this checkout at `/Users/michaelmcelwee/Projects/r-ops-design-work/`; it is not the implementation target.

## Navigation (roadmap §5, packet U07)

Manager navigation is one floating top bar with ten categories in this order: Dashboard, Properties, Tenants, Units, Accounting, Projects, Work Orders, Investors, Reporting and Company. Dashboard is a direct link; every other category is a one-level menu. `client/src/features/rent-ops/workspace/navigation.ts` is the single configuration. Every entry names a canonical route that `rm-workspace.tsx` renders — there are no disabled or "Planned" entries — and `navigation.test.ts` fails if a destination has no view.

| Category | Destinations |
|---|---|
| Properties | All properties · Performance · Rent roll · Documents & compliance |
| Tenants | Directory · Collections · Leases & renewals · Move-ins & move-outs · Applications |
| Units | All units · Availability · Make-ready · Listings |
| Accounting | Overview · Transactions · Bills & payments · Banking & reconciliation · PM settlements · Period close |
| Projects | All projects · Schedule · Budgets & costs · Commitments & changes · Draws · Cost library |
| Work Orders | Open work · Schedule · Completed work |
| Investors | Accounts · Payment calendar · Contributions & distributions · Debt & maturities · Agreements |
| Reporting | Report library · Saved reports · Packages · Forecasting |
| Company | Review queue · Entities & ownership · People & vendors · Team & time · Documents · MRA packets · Settings |

Actions live in page toolbars, not menus: New work order (work-order workspace), Record receipt and the charge/allocation/reversal actions (Collections), Record move (Move-ins & move-outs and the dashboard move panel), Add property (All properties). Current/future/former/all tenants is the Directory status filter. Preventive maintenance is not listed because the work-order model has no recurrence yet.

The account menu on the trailing edge (the user's initials) holds Appearance → Transparency (System/Reduced, a device preference), the 5Central website, the Classic workspace (`?ui=classic`) and Sign out. At 1100px and below the categories collapse behind a section selector button showing the current category and page; it opens a single column of categories, each opening its menu. There is no sidebar and no open-record strip; their CSS was removed. The browser tab reads "5Central Ops — <page>".

## Routes and bookmarks

`workspace-state.ts` owns the query-string route: `section`, `record`, `kind`, `tab`, `report`, `company`, `projectTab`, `investorTab`, `woView`, `acctView`, `tenantStatus`, `reportId`, and for Forecasting `tab`, `scenario` and `entity`; the shared filters are `scope`, `property`, `asOf`, `status` and `search`. Old bookmarks resolve through an alias table and are rewritten in canonical form: `section=income` → Collections, `section=banking` → Accounting › Banking & reconciliation, `section=documents` → Documents & compliance, `projectTab=scope|costs` → Budgets & costs, `projectTab=execution` → Commitments & changes, `investorTab=activity` → Contributions & distributions. `propertyTab` values `general/units/marketing` open the property Overview and `occupancy/recurring` open Rent roll. The recurring-charge register (`section=recurring`) remains a canonical view reached from Collections and the property Rent roll tab.

Company views keep the selected company (`company`) while moving between company destinations; rental views do not carry it. Where the project, investor and accounting workspaces do not yet accept a new tab or view, `client/src/features/workspaces/views.ts` opens the nearest existing one (for example Budgets & costs → Scope & Budget) until those workspaces add it.

## Pages and record views (packet U08)

New pages live in `client/src/features/workspaces/` and read through `server/workspaces/` endpoints (rental figures need the manager session; company figures also need an active company grant, reloaded inside a read-only snapshot):

- Property record tabs: Overview, Rent roll, Financials, Projects, Work orders, Documents. Financials shows distinct measures for a month — scheduled rent, other scheduled charges, charges posted, tenant collections, subsidy collections, other payers, arrears, deposits held, manager collections/fees/expenses/remittances/held funds (from PM statements) and project spending — each with its basis and a drill-down to contributing records. Rental measures come from the same report derivation as the report pages; unknown amounts are shown as unknown or "At least …", never $0. QuickBooks references appear only in record detail.
- Properties › Performance, Documents & compliance; Tenants › Collections, Leases & renewals, Move-ins & move-outs; Units › Make-ready, Listings; Work Orders › Schedule; Projects › Cost library; Reporting › Saved reports, Packages; Company › Entities & ownership, People & vendors, Settings.
- Review queue, MRA packets (read-only results), Company documents and Forecasting are other lanes' workspaces, mounted through `client/src/features/workspaces/lane-mounts.tsx`, which shows "Unavailable" when a module is not installed.

The dashboard keeps its RM-style panels and adds a compact row for upcoming investor obligations and maturities, open review cases by reason (hidden when review cases cannot be read), work due in the next 14 days and a cash-outlook link to Forecasting.

## Design

The visual layer follows the approved [Apple design skill](https://github.com/SudewaJay/apple-design-skill/tree/57bfab7daf8766a9a45cfc405790e749c71eda30/apple-design) at its pinned revision (see `docs/company/design/`). `rops-system.css` holds the tokens; page styles use them: opaque content, glass only on the navigation bar, hierarchy from type and spacing, hairline tables, one filled action per view, tabular figures and 44px targets on coarse pointers. OS reduced-transparency, increased-contrast, forced-colors and reduced-motion settings have fallbacks. No private records or credentials belong in styling fixtures or screenshots.

## Entry points and verification

The manager entry is `client/src/pages/rent-ops.tsx`, which selects `RmWorkspace` from `client/src/features/rent-ops/workspace/rm-workspace.tsx`; `?ui=classic` preserves the older workspace. `client/src/App.tsx` keeps `/tenant` and `/apply` independent.

Local browser verification uses `server/company/demo.ts` (synthetic data only) and a built client (`npm run build`). `company:navigation-smoke` checks every menu destination, keyboard/focus behavior, legacy bookmarks, the account menu and appearance preference, responsive widths, reduced motion/transparency, forced colors and the original dashboard panels. Set `ROPS_BROWSERS=chromium` to run one engine and `ROPS_CHROMIUM_EXECUTABLE` to use a locally installed Chromium. `company:browser-smoke` exercises project editing and uncertain-save retry.
