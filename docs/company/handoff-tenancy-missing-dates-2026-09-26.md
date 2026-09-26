# Handoff for Codex: tenancies with missing dates (PR #11 follow-up)

Owner: Codex. Requested by Michael, 2026-09-26. Written by Claude after the PR #11 audit.
Base: `production` after PR #11 merges (or `codex/financial-completion` at `7206243` or later).

## Problem

PR #11 made tenant QuickBooks source selection use historical tenancy and ownership dates
(`server/accounting/tenancy-source-resolution.ts`, `resolveTenancyHistory`). That is correct
for choosing an LLC, but it has a side effect on tenancies that are **already linked** to a
QuickBooks customer:

- If a tenancy has no `actual_move_in_on`, no `planned_move_in_on`, and no non-cancelled
  lease term start, `startOn` is null.
- If a tenancy is not `current`/`notice`/`future` and has no `actual_move_out_on`,
  `ended_at`, or lease end, the interval end is null.
- Either case makes `coverageComplete` false, so `effectiveLegalEntityId` is null.

Consequences today:

1. `resolveTenancyCustomer` (`server/accounting/receivables-read.ts`) returns null, so
   `GET .../receivables/tenancy-ledger` answers 404 "not linked" even though a
   `company_external_identities` link exists. The message is wrong as well as unhelpful.
2. `resolveTenancySource` reports `ownership_review`, and the tenant QuickBooks tab
   (`client/src/features/rent-ops/workspace/tenant-quickbooks.tsx`) withholds the ledger.
3. `linkTenancyToQboCustomer` (`server/accounting/receivables-links.ts`) refuses new links.

Before PR #11 the old SQL fell back to `created_at` (an import timestamp) and the current
date, which is why those tenancies used to show. PR #11 deliberately stopped doing that:
import timestamps are not tenancy dates. Do not reintroduce that fallback.

Already fixed in PR #11 (do not redo): tenants who moved in before the LLC's first ownership
date (inherited at acquisition) now resolve to the acquiring LLC. Coverage is measured from
the later of move-in and the property's first `company_property_entity_periods.effective_from`.

## Goal

Nothing that is visible today disappears, and no new link is created without evidence.

1. **Existing links stay visible, with a warning.** When a tenancy already has exactly one
   `qbo` `Customer` identity for the requested environment, the dates are unknown, and the
   property has exactly one legal entity whose period set could have owned it, show that
   customer's ledger with a clear notice such as "Move-in date missing. Add it to confirm
   ownership." Keep the existing refusal when:
   - the link's legal entity is not one of the property's mapped entities;
   - two or more entities have owned the property (ambiguous);
   - there are dates and they resolve to a different entity (a real mismatch).
2. **New links still require dates.** `linkTenancyToQboCustomer` keeps requiring a fully
   resolved historical owner.
3. **Measure the gap in production** (read-only), then backfill what can be proven.

## Implementation notes

- Add a distinct state instead of overloading `resolved`, for example
  `ownership.state = "linked_dates_missing"` or a `datesMissing: true` flag in
  `shared/accounting/tenant-source-resolution.ts`. Keep `effectiveLegalEntityId` null in that
  case so no other caller treats it as proven ownership; expose the linked scope separately.
- In `resolveTenancyCustomer`, allow the existing link only under rule 1 above, and return a
  marker so `readCustomerLedger`'s response (or the HTTP layer) can carry the warning. Do not
  change `readCustomerLedger`'s balance math.
- Authorization in `server/accounting/http.ts` for the tenancy-ledger and source-resolution
  routes must still check the linked legal entity (`authorizeCompanyRead` with that
  `legalEntityId` and the property).
- Client: in `tenant-quickbooks.tsx`, render the ledger with a warning `Notice` for the new
  state; keep the "ownership needs review" notice for true ambiguity or mismatch.
- Fix the 404 wording: when a link exists but ownership is unresolved, say so instead of
  "not linked".
- Tests (extend `server/accounting/tenancy-source-resolution.test.ts`,
  `receivables.test.ts`, `tenant-quickbooks.test.tsx`):
  - linked + no move-in + single-entity property → ledger shown with warning;
  - linked + no move-in + two entities over time → review, no ledger;
  - linked to entity B but dates resolve to entity A → review;
  - unlinked + no dates → cannot link (unchanged);
  - past tenancy with no end date → same rules as missing move-in.

## Production measurement (read-only; run before and after)

Run against production with the **runtime (read-only use)** connection, not the owner URL.
Report counts only; do not paste tenant names into the PR or chat.

```sql
WITH t AS (
  SELECT t.id, t.property_id, t.status,
         COALESCE(t.actual_move_in_on, t.planned_move_in_on, l.first_start_on) AS start_on,
         COALESCE(t.actual_move_out_on, (t.ended_at AT TIME ZONE 'America/New_York')::date, l.last_end_on) AS end_on
    FROM rent_ops_tenancies t
    LEFT JOIN LATERAL (
      SELECT MIN(contract_start_on) AS first_start_on, MAX(contract_end_on) AS last_end_on
        FROM rent_ops_lease_terms lt
       WHERE lt.tenancy_id = t.id AND lt.status IS DISTINCT FROM 'cancelled'
    ) l ON true
), linked AS (
  SELECT DISTINCT local_id FROM company_external_identities
   WHERE provider = 'qbo' AND record_kind = 'Customer' AND local_kind = 'tenancy'
)
SELECT (start_on IS NULL) AS missing_start,
       (end_on IS NULL AND status NOT IN ('current','notice','future')) AS missing_end,
       (t.id IN (SELECT local_id FROM linked)) AS qbo_linked,
       COUNT(*)
  FROM t
 GROUP BY 1, 2, 3
 ORDER BY 1, 2, 3;
```

Also run the per-property version (group by `property_id`) so Michael can see which
buildings are affected.

## Backfill (separate, reviewed step)

- Candidate sources, in order of trust: signed lease terms already in `rent_ops_lease_terms`;
  Rent Manager import source records (`rent_ops_source_records`, move-in/move-out fields);
  MRA ingestion records. Never use `created_at` or import timestamps.
- Produce a dry-run CSV of proposed dates with the source record ID for each, for Michael's
  review. Apply only after approval, through the normal revision-checked patch path so each
  change is audited. The remainder becomes a short manual list for Michael.

## Out of scope / guardrails

- Do not change the inherited-tenant rule or the multi-owner review rule.
- Do not post anything to QuickBooks. All write switches stay off.
- No production data changes without Michael's explicit approval of the dry run.
