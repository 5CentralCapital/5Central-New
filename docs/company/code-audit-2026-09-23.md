# Code audit — September 23, 2026

Section-by-section audit of `claude/qbo-production-release` before the Render cutover. Nine
auditors each read every non-test file in one section, fixed confirmed bugs with a regression test
(verified to fail before the fix), and removed dead code where it was local and covered by tests.
Result on the merged branch: typecheck clean; registry 49; full suite 1,906 passed, 0 failed,
6 opt-in skipped (the suite now also runs every test under `client/src`); performance 17/17;
build passes.

## Fixes that would have affected production

| Area | Fix |
|---|---|
| S3 documents | SigV4 string-to-sign was missing its `AWS4-HMAC-SHA256` line: every real S3 request would have been refused (403), so the web service could not start on Render and the document relocation could not copy. Now a pure function checked against AWS's published examples; query parameters sort by code point. The startup probe also reads the canary by exact version, which is how documents are read (`s3:GetObjectVersion`). |
| QuickBooks writes | A write refused before it reached Intuit (capability check, 429 pause, token failure) was recorded as "outcome unknown" and parked for manual review; it now returns to a retryable state. Read-back compared `200` to `200.0` as unequal. |
| QuickBooks sync | A full replay failed whenever QuickBooks had re-rendered reference names or balances without a new SyncToken (after any rename), so a company could never recover from a change-capture overflow. Reports now respect and trigger the per-company 429 pause. |
| Rent Manager import | HAP subsidy amounts (agency/tenant amounts, subsidy tenant and payment amounts) were copied from dollars into cents fields: $700 became $7.00, or "unknown" with cents. Recurring amounts had the reverse error. Imported decimal rents in application history went through floating point. |
| Reports | Reports without an explicit sort (the web app's default) came out in content-hash order; money sorted as text; QuickBooks section totals printed before their rows; missing budgets/actuals counted as zero; unmatched eliminations and unbudgeted actuals dropped silently. |
| Server stability | An upload streamed over the size limit crashed the process (reachable from the public applicant upload). A failed ROLLBACK returned a connection to the pool mid-transaction. |
| Data exposure | `/attached_assets` served property financial CSVs publicly (now images only). Sign-out left other users' cached data in the browser (manager and investor). Anonymous `/mcp` bodies were parsed before token verification. Legacy module routes returned raw database errors. |
| Authorization | Investor mapping/remittance edits crossed entities; reversed payments could still be linked to QBO or settled; MRA staging could read another entity's document and apply to another entity's tenancy; company documents could attach to another entity's project; property financials showed a former owner's PM statements. |
| Dates | Several "today" defaults used the UTC date (tomorrow after 8 p.m. Eastern); SQL `DATE` values shifted a day east of UTC; calendar display showed the previous day. |
| Email / legal | `RENT_OPS_EMAIL_ALLOWED_RECIPIENTS=*` allows every tenant (approved by Michael); the privacy policy and EULA now name Render, Neon and AWS instead of Replit. |

Removed: 11 unused one-off data scripts (four ran unconfirmed DELETE/UPDATE against `.env`
`DATABASE_URL`; one contained real tenant names), 38 unused UI files, about 70 unused exports and
aliases, and redundant helpers.

## Needs a decision or a follow-up

1. **HAP data already in production** was imported with the dollars-as-cents error: amounts are
   likely 100× too small or unknown. Needs a reviewed correction after cutover (re-import is
   blocked by append-only source records, by design).
2. **Git history** still contains the deleted scripts' tenant names and investor contact details
   in `server/seed-investors.ts` / `server/update-investor-contacts.ts`. Removing them from
   history means rewriting it.
3. **Vendor and employee lists** update only through webhooks (change capture and full replays
   skip them), so they stay stale until production webhooks are registered. Customers are added
   to change capture on `claude/qbo-financial-source`.
4. **Legacy Rent Manager dashboard module** (`server/dashboard/rentmanager.ts`, `/api/rm/*`):
   500-record page caps, invented defaults, float dollars, plain-text Plaid tokens in SQLite.
   Recommend retiring it after cutover rather than fixing.
5. **Authorization policy questions:** organization-wide records (project vendors, templates,
   investor accounts) are editable with an entity or property grant; draw items stay editable on
   approved/paid draws; review-case evidence and work-order attachments accept any verified
   organization document.
6. **Rent Manager timestamps without an offset** are parsed in the host time zone (affects
   import digests only). Pin to America/New_York if the importer is used again.
7. **Operator CLIs** in `scripts/rent-ops-corrections/` take `--database-url` on the command line;
   the newer tools take an environment variable name.
8. Unused npm dependencies (about 30) can be removed with a lockfile update.

Per-section reports are summarized in the session handoff; each fix is its own commit with the
reason in the message.
