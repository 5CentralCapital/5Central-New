# Project execution packet

This packet extends the existing project commands without changing their
envelopes, revision checks, replay handling, or manual/Codex parity. The
registered relational schema is [035_company_project_execution.sql](../../server/rent-ops/migrations/035_company_project_execution.sql).
It is additive. Production startup does not apply migrations.

## Domain coverage

The packet provides shared contracts and relational storage for reusable
project templates, template scope/tasks, assignment, milestones, inspections,
punch items, vendors, bids, commitments, change orders, purchase orders, draw
requests, draw request items, and finance source bindings.

Project templates copy scope and task intent into a project. They do not copy
budget approvals, commitments, actuals, draws, or source bindings. Assignments,
inspections, punch items, procurement records, and draws remain project-scoped
records with their own lifecycle status.

## Financial rules

All monetary values cross the domain boundary as canonical signed 64-bit cents
strings. Commitment `committedCents` must equal `originalCents` plus
`approvedChangeCents`. A purchase order references a commitment and is never
added as a second commitment.

The execution totals helper uses these definitions:

- `originalBudgetCents` is the earliest approved budget snapshot.
- `revisedBudgetCents` is the latest approved snapshot plus approved change
  orders whose `includedInBudgetVersionId` is still empty.
- `commitmentCents` is the sum of approved and closed commitment totals.
- `actualCents` comes only from posted, exact source lines returned by the
  shared accounting read port.
- `unspentCommitmentCents` subtracts linked posted actual allocations from
  commitments and is only authoritative with complete finance coverage.
- `remainingCents` is revised budget less actuals and unspent commitments,
  and stays unavailable when actual coverage is unavailable or partial.

This avoids adding the same economic event through a PO, a commitment, a
draw, and a QBO line. A draw request is an eligibility and retainage record;
it is not an actual cost.

## Finance adapter

`createProjectFinanceReadPort` in `server/projects/execution.ts` is the root
factory. It accepts the canonical `FinancialSourceReadPort`, a binding source,
and the transaction-bound `FinancialProviderCostContextPort`. Each binding
carries the full QBO source reference, a reserved `allocatedCents` amount,
eligibility, and binding status. The adapter:

1. checks source coverage;
2. resolves the exact source line and provider version;
3. accepts only verified, eligible, posted lines whose current provider Account
   context classifies them as `expense`, `cogs`, or `capitalized_cost`;
4. applies the reserved binding allocation rather than the whole source line;
5. excludes lines posted after an as-of date; and
6. downgrades coverage when a binding is missing, voided, stale, ineligible,
   or larger than the source line.

The read port returns `{ coverage, actuals }` for each call, so one project's
coverage cannot leak into another concurrent read. The unavailable port returns
an empty actual list with `coverage: "unavailable"`; consumers must render an
unavailable state rather than zero.

Binding commands use the same transaction-bound finance ports. A create command
resolves the current provider line without passing a historic version, compares
that result to the requested source identity, requires live provider coverage,
an outgoing expense/payable role, an eligible provider Account classification, a
matching project currency, a posted date at or before the effective date, and
reserves the requested allocation before
recording a verified binding. Partial aggregate sync coverage can still verify
an exact current line; the project read remains partial until coverage is
complete. A release command releases that central reservation and marks the
binding released/ineligible. Stale, voided, unverified, unknown-account, or
over-allocated
bindings downgrade coverage and do not become project actuals.

Draw items derive their eligibility from the selected commitment, approved
change order, or current verified finance binding. The command rejects caller
amounts that differ from the source eligibility and prevents the same source
from being requested across non-void, non-rejected draws more than once.

`createProjectExecutionAdapter` returns the transport-neutral domain port.
`createProjectExecutionHttpAdapter` and `createProjectExecutionMcpAdapter`
are intentionally thin aliases for root registration so HTTP and Codex use
the same reads and command source.

## Manager UI

`client/src/features/projects/execution-workspace.tsx` exports the execution
workspace, financial summary, procurement, quality, assignment, vendor,
commitment, and draw-request forms. `ProjectsApi` loads the execution detail
from the company execution route and sends every form action through the
project execution command route. Forms require an injected command callback
and remain disabled when the record is read-only. The execution read includes
named employee, person, team, and project-vendor options for assignment search;
the form never asks a manager to enter a raw assignee reference. They do not
claim persistence without a real adapter. The manager route values are
exported as `PROJECT_TABS` in `client/src/features/projects/types.ts`:

`overview`, `schedule`, `budget`, `commitments`, `draws`, plus the aliases
`scope` and `costs` (open Budgets & costs) and `execution` (opens Commitments).
`projectSectionFor` maps a route value to the visible section.

The execution UI uses the existing project charcoal/gold/cream tokens and
opaque content surfaces. It keeps QBO coverage visible beside the financial
values and does not use placeholder financial numbers.

## Canonical cost report (U10)

`shared/projects/cost-report.ts` computes one cost summary that the Overview,
Budgets & costs, Commitments and Draws sections all read
(`GET /api/company/:org/projects/:id/cost-report`, MCP
`get_project_cost_report`). Every value is exact signed cents; an unknown value
is `null`, never zero.

- Original budget is the first approved budget version; revised budget is the
  latest approved version plus approved change orders not yet included in a
  budget version. Approved changes = revised − original. With no approved
  budget both are zero and a warning is returned.
- Committed is approved and closed commitments (original + approved changes).
- Incurred = verified QBO actual (current finance bindings) + posted payroll
  labor + estimated labor. Estimated labor is shown separately and is replaced
  by posted payroll for the same timesheet, so payroll is never counted twice.
  An unavailable QBO mirror makes verified actual and incurred `null`; a partial
  mirror shows the known subtotal and withholds cost to complete and forecast.
- Paid uses mirror settlement (pro-rated for a partially paid line); a bound
  line without settlement leaves paid unknown.
- Remaining commitment = committed − linked actual per commitment (closed
  commitments release their unbilled balance).
- Cost to complete per line = max(revised − incurred, remaining commitment),
  unless an explicit ETC override with a reason exists. Forecast final cost =
  incurred + cost to complete; variance = revised − forecast.
- Schedule risk derives late tasks, dependency-driven slips and a projected
  finish from task dates and dependencies against the target date.
- The commitment ledger derives receipts from purchase-order receiving and
  invoices from bound QBO bill lines (with settlement state).
- Retainage payable is a rollforward over approved/paid draws: withheld per
  draw, released as the growth of requested-above-eligible, outstanding balance;
  draft/submitted draws are pending.
- The closeout checklist (commitments invoiced, retainage released, punch items
  closed, final draw paid, lien-waiver documents linked, tasks complete) is
  read-only. Lien waivers are verified company documents on the project tagged
  `lien waiver`.

Conservation: one QBO line allocated across projects, work orders and payroll
links sums through the central `accounting_qbo_source_line_allocations` ledger
and cannot exceed the line; a commitment, its bill and the bill payment are one
cost (tests in `shared/projects/cost-report.test.ts` and
`server/projects/cost-report.integration.test.ts`).

### Commands added

- `project.etc_override.set` / `project.etc_override.clear` (MCP
  `project_etc_override_set` / `_clear`). Stored as a draft project cost row
  with the reserved vendor marker `system:etc_override`; project reads exclude
  it from draft costs and user draft costs may not use the `system:` prefix.
- `project.template.create` now accepts inline `scopeItems` and `tasks`, or
  `fromProjectId` to copy a project's current lines and tasks (relative days
  from the project start).
- Draw capacity is checked net of retainage (sum of requested − retainage ≤
  eligible), so a retainage release is expressible on a later draw.

### Reads added

- `GET /api/company/:org/projects/:id/labor` (MCP `get_project_labor`):
  approved time mapped to the project by jobcode, with cost code → scope line.
- `GET /api/company/:org/cost-source-lines?legalEntityId&purpose=cost|payroll`
  (MCP `search_cost_source_lines`): current posted QBO lines with their
  unallocated balance, keyset paged. The finance binding picker uses it.

### Schema follow-ups

- A dedicated ETC override table (reason, author, history) instead of the
  reserved draft-cost marker.
- `company_document_links.link_kind` for `work_order`; lien-waiver documents
  currently rely on a tag.
