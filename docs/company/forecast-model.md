# Forecast model (fcst-1.0.0)

Deterministic forecast engine, scenarios and snapshots for 5Central Ops (roadmap §6, packets U14–U16). No language model and no probability is used anywhere in the calculation. The same model version, assumption version and source data always produce the same result, byte for byte (`result_sha256`).

Code: `shared/forecasting/` (contracts), `server/forecasting/` (engine, service, commands, HTTP, MCP, reporting port, workbook discovery), `client/src/features/forecasting/` (workspace). Storage: migration `048_company_forecasting.sql`.

## Money, percentages and rounding

- Money is exact signed bigint cents, encoded as decimal strings at every boundary. Unknown amounts are `null` and are never replaced with zero.
- Percentages are integer basis points (1% = 100 bps). Interest rates are annual basis points.
- **Rounding: half to even (banker's rounding), once per calculation, on an exact rational.** This applies to proration (`rent × days ÷ days-in-month`), percentages (`amount × bps ÷ 10,000`), growth steps and interest.
- Spreading one total over several periods (project cost by week) uses the largest-remainder allocation in `shared/company/allocation.ts`; parts always sum to the total. Tenant/subsidy splits of a prorated charge use the same allocation so they sum to the charge.
- Level loan payments are computed on exact rationals: `P·r·(1+r)^n / ((1+r)^n − 1)` with `r = bps / 120,000`, rounded once. Each period's principal is `payment − interest`, so principal plus interest is exact.

## Calendar and periods

- Opening position is as of the **actuals cutoff** (end of day). Forecast events are dated after the cutoff. The cutoff must be before the scenario start date and within a year of it.
- Weekly buckets run **Monday–Sunday** starting on the scenario start date (which must be a Monday) for `horizon_weeks`.
- Monthly buckets are calendar months starting with the month that contains the start date; the first month begins on the start date. Periods never overlap, so every dated event is counted exactly once in each view. The week containing January 1 and the January month are tested explicitly.
- Events between the cutoff and the start date roll into the opening of both views.
- Loan schedules run to maturity regardless of the view horizon, so balloons beyond the horizon still appear in the debt ladder.

## Model layers

1. **Opening position** (`server/forecasting/sources.ts`). Each item carries an as-of date and state (`sourced`, `partial`, `manual`, `unknown`). Unknown items are excluded and listed ("Opening position incomplete: …"); they are never zero.

   | Item | Source | Notes |
   |---|---|---|
   | Operating and restricted cash, accounts payable | Approved opening-balance override | QuickBooks balance-sheet reads are not connected yet, so these are `unknown` until set. |
   | Rental receivables | Rental delinquency balances | `partial` when balances are unresolved or when read on a date other than the cutoff. |
   | Security deposits held | `rent_ops_security_deposits` held at the cutoff | Partially disposed deposits without a remaining amount are excluded and flagged. |
   | Funds held by property managers | Latest reconciled PM settlement per property/manager | `partial` if the latest settlement ends before the cutoff. |
   | Investor obligations due | Obligations due by the cutoff less allocated, non-reversed payments | Incomplete obligation amounts are excluded and flagged. |
   | Open project commitments | Approved commitments | Disclosed only (memo); remaining project cost comes from project assumptions. |
   | Loan principal | Assumption, or `company_investor_debt.outstanding_principal_cents` via `sourceDebtId` | A loan with unknown principal is excluded from debt service and listed. |
   | Property book basis, construction in progress | Assumptions | Missing basis is listed as incomplete. |

   Opening book equity is derived as known assets minus known liabilities at the cutoff. It is the opening position's equity, not a balancing entry in any forecast period.

2. **Operating drivers.** Unit lease schedule: occupied units run to lease end (month-to-month if none), then either renew for the renewal term at `rent × (1 + growth)` or move out, stay vacant for make-ready plus vacancy days, and start a new lease at market rent (grown on each scenario anniversary). An existing tenancy's current-month rent was billed before the cutoff and sits in opening receivables, so its first forecast charge is the next 1st. Rent is charged on the 1st (prorated for partial months). Housing assistance is a portion of contract rent, never an addition. Tenant collections (`collectionsBps`) and bad debt (`badDebtBps`) apply to the tenant portion after concessions; any remainder stays in receivables. Managed properties collect into PM-held funds and remit each month's collections, net of the PM fee, after the remittance lag. Deposits are received at a new lease, returned after move-out, and transferred to a buyer on sale. Recurring costs accrue to payables and are paid after their lag; escrowed costs are paid from restricted cash.
3. **Project drivers.** Remaining cost is spread by week (weighted by days) between cost start and completion; labor is the estimated labor portion; retainage is held and released after completion; draws fund a share of each installment on the linked loan. Completion places accumulated cost in service and starts straight-line depreciation the next month. Moving the completion date moves unit readiness, lease start, rent, cost timing, draws, placement, depreciation and cash together.
4. **Financing and capital events.** Loans accrue interest on the exact daily balance (30/360, Actual/360 or Actual/365), are interest-only until the stated date, then amortize to a level payment, with any remaining balance due at maturity. Escrow deposits move cash to restricted cash. A refinance funds the new loan (gross proceeds), pays off listed loans (principal plus accrued interest), pays closing and prepayment costs, and funds reserves into restricted cash; `net usable = gross − payoff − costs − reserves`. A sale removes the property's book value and construction in progress, records the gain, pays off listed loans and transfers deposits. Refinance, sale and draw proceeds are marked **modeled**; a modeled event dated inside the actual period is excluded with a warning and never becomes actual cash.
5. **Three linked statements** (monthly). Every event is a balanced journal entry over the forecast chart of accounts (`FORECAST_ACCOUNTS`). The balance sheet is the opening balances plus all entries to date; retained earnings are cumulative net income since the cutoff; there is no balancing plug. The indirect cash-flow statement starts from net income and adds each non-cash balance change by class (operating, investing, financing); gains on sale are reclassified to investing. The direct statement sums cash entries by category and must equal the indirect result.
6. **Treasury** (weekly). Opening, inflows, outflows, net, closing, restricted and available cash, modeled inflows, and a reserve-floor flag on available cash.
7. **Scenarios.** Base, downside, upside, hold, sell, refinance and custom scenarios; immutable assumption versions; immutable snapshots with source fingerprint and result hash; comparison of any two snapshots.

Owner/personal items are summed into a separate owner view and never enter company statements (tested by hashing the company result with and without them).

Approved time actuals dated after the cutoff replace estimated labor for the same project (or labor cost) and week; time dated on or before the cutoff is already in the opening position. Retired items (for example the workbook's retired labor section) are never calculated.

## Invariant checks (every run)

`journal_balanced`, `balance_sheet_balances`, `cash_rollforward` (weeks and months), `direct_equals_indirect`, `retained_earnings_rollforward`, `debt_rollforward` (journal loan balances equal the schedules), `deposits_are_liabilities`, `subsidy_not_duplicated`, `weekly_monthly_agree`, `labor_not_duplicated`, `modeled_proceeds_not_actual`. A snapshot with any failed check cannot be approved.

## Scenarios, versions, snapshots and commands

A snapshot stores the statement views (weeks, months, debt, capital, opening position, checks) and the exact source data the run read, with the source fingerprint and the hash of the full result. The dated event calendar is not stored: explain and compare regenerate it from the immutable assumption version and the stored sources, and refuse (`forecast_snapshot_not_reproducible`) unless the regenerated result reproduces the recorded hash exactly. A 200-unit, ten-year scenario stores about 0.3 MB instead of about 30 MB, and every drilldown re-proves reproducibility. Snapshots made by an earlier model version keep their statements readable; event drilldown for them needs that model.

Forecasts are company-wide: reads need an organization-level grant for owner, admin, finance or read-only reviewer; writes need owner, admin or finance; approval needs owner or admin. All commands go through the shared command runner (idempotency key, expected revision, fresh grants inside the transaction).

| Command | Effect |
|---|---|
| `forecast.scenario.create` | New scenario with version 1 (empty, supplied, or duplicated from another scenario's current version). |
| `forecast.scenario.update` | Name, kind, start, horizons, reserve floor. An approved scenario returns to draft. |
| `forecast.scenario.archive` | Archive; history stays readable. |
| `forecast.scenario.approve` | Pin a snapshot of the current version and model whose checks all passed. |
| `forecast.assumptions.save` | New immutable version with a required reason, or restore an earlier version as a new one. |
| `forecast.override.set` | Add, replace or remove one override (opening balance, unit rent for a month, cost for a month). Author, date and reason are stamped by the server. |
| `forecast.snapshot.create` | Run and persist an immutable snapshot. |

HTTP (`/api/company/:org/…`): `GET forecast-scenarios`, `GET forecast-scenarios/:id`, `GET forecast-scenarios/:id/versions/:n`, `POST forecast-scenarios/:id/preview` (unsaved; saved version or draft document), `GET forecast-snapshots/:id`, `GET forecast-explain`, `GET forecast-compare`, `POST forecast-workbook-drafts` (raw file body; nothing saved), `POST forecast-commands/:kind`.

MCP: `list_forecast_scenarios`, `get_forecast_scenario`, `preview_forecast`, `get_forecast_snapshot` (bounded by `sections`), `compare_forecast_snapshots`, `explain_forecast_line`, and one tool per command (`create_forecast_scenario`, `update_forecast_scenario`, `archive_forecast_scenario`, `approve_forecast_scenario`, `save_forecast_assumptions`, `set_forecast_override`, `create_forecast_snapshot`).

### Explain lines

`line` × `period` (`W:<Monday>` or `M:<YYYY-MM>`): `cash.opening|closing|available|restricted|inflows|outflows|net|category.<category>`, `is.revenue|operating_expenses|noi|net_income|<account>`, `bs.<account>|retained_earnings`, `cf.operating|investing|financing|net|direct.<category>`, `debt.service`, `ops.scheduled_rent`. The response lists the dated events that make up the figure (balance lines: opening balance plus the period's movements), paged by cursor, and the assumption inputs they came from. Contributions always sum to the displayed figure (tested).

### Reporting port

`createForecastReportingReadPort(executorOrPort, { principal })` implements `ForecastReportingReadPort`. `inputVersion` is a snapshot ID or an assumption version (`3` / `v3`, latest snapshot of that version for the requested model). It returns the first 13 weekly rows, the known opening items as the actual boundary (dated at the cutoff), monthly growth metrics (currency values as exact dollar text, occupancy as percent text), loans (rate as an annual fraction, e.g. `0.0650`) and sale/refinance exit lines. Coverage is `complete` only when the opening position is complete and every check passed; evidence is `reproducible_snapshot`.

## U14 workbook discovery

`server/forecasting/workbook-import.ts` reads a workbook (or CSV export) read-only and returns a draft; nothing is saved.

Documented layout of the **Cashflow** sheet:

- Row 1 (or the first row within the first ten with at least two dates) holds period dates from column B: Excel date serials, `YYYY-MM-DD`, `YYYY-MM` or `M/D/YYYY`. Columns seven days apart are weeks; wider gaps are months.
- Column A holds the line label. A labeled row with no amounts is a section header.
- Amounts are dollars; inflows positive, outflows negative.
- Mapping by label and section: rent, RUBS, HAP and lease-up rows are **comparison only** (the model derives rent from units); materials, carry and rehab rows are comparison only (projects); mortgage, loan, principal and balloon rows are comparison only (loans); refinance and sale rows are comparison only; utilities, insurance, taxes, payroll, repairs and admin rows become draft operating costs (a uniform weekly row becomes one weekly cost, otherwise one dated cost per cell); investor rows become draft investor payments; owner or personal rows become owner planning items; "starting cash"/"beginning balance" becomes a suggested opening cash override (it still needs an approver and reason); "ending cash" is kept for reconciliation only; any labor row in a section labeled retired is excluded.
- Every sheet is inventoried (rows, columns, formulas, formulas without cached values). A formula without a cached value is reported, never recalculated and never treated as zero.

### Must be verified against the real workbooks (not available in this environment)

1. `Portfolio Overview.xlsx`: confirm the Cashflow sheet matches this layout (header row, label column, sign convention) and inventory all 15 sheets; reconcile the 1,581-formula count and the 7 formulas without cached values after native recalculation in Excel.
2. Manual starting balances: identify each hard-coded opening cell and confirm it against bank and QuickBooks balances at the cutoff before approving it as an opening override.
3. The labor section marked retired stays retired; confirm no other section feeds from it.
4. Ending cash is labeled "before missing costs": list the missing costs and reconcile the model's ending cash to the workbook with explained differences; do not force a match.
5. Weekly dates (Sep 25, 2026 – Jan 1, 2027) start on a Friday; the model's weeks start on Monday, so compare by date, not by column.
6. `3YR Plan.xlsx` (six sheets, June 2026): treat its growth and refinance assumptions as a scenario to review, not approved terms; inventory named ranges, hard-coded overrides and external links.

## Known simplifications (fcst-1.0.0)

- Interest is expensed when paid; interest accrued before the cutoff and paid after it is expensed in the forecast (there is no accrued-interest opening balance).
- Refinance closing costs are expensed at closing rather than amortized.
- Opening receivables are carried, not assumed collected.
- Security deposits for existing tenants are estimated from the unit deposit or deposit months when returned or transferred.
- Depreciation posts a full month at each month end after the cutoff.
- Draws on a 30/360 loan accrue on the draw-weighted balance (a warning is shown).
- Property and entity context parameters do not filter the company-wide forecast.
