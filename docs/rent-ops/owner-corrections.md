# Owner-attested corrections: guarded application runbook

This runbook turns an owner-attested research package (for example `needs-review-research-2026-09-23/`) into reviewed changes in 5Central Ops. The package is research. It is `PREPARED_NOT_APPLIED`, forbids automatic execution and requires a fresh read before any change. The tooling here never applies anything by itself.

Keep every file this process writes, including snapshots, packs, plans, reviews and readbacks, in the private evidence folder. The folder must be outside the repository; the CLIs refuse an output directory inside the checkout. Do not paste names, amounts or IDs from these files into commits, issues or chat.

## What the tooling can and cannot change

| Package research status | Converted into | Guard |
|---|---|---|
| `OCCUPANCY_RESOLVED_OWNER_ATTESTED` | `tenancy-status` → `cancelled` on the one imported non-cancelled tenancy in the researched unit | Revision, before-hash, source identity; imported dates and history preserved |
| `ZERO_BALANCE_RESOLVED_OWNER_ATTESTED` | `balance-review` with operational/tenant balance 0 and agency balance **unknown** | Tenancy guard, ledger fingerprint (a later ledger change makes the review stale) |
| `ZERO_CHARGE_CORRECTION_RESOLVED_OWNER_INSTRUCTED` | Linked reversals of the exact open charges (ledger plan) **and** `tenancy-status` → `cancelled` | Charge-edit revision, before-hash, account ledger fingerprint, total equal to the researched total, no payments/credits/allocations on the account |
| `UNIT_AND_FUTURE_TERM_RESOLVED` | `future-tenancy-unit-link`: links the existing future tenancy to the signed unit and planned start | Needs a filled resolutions file; destination unit guard; no occupancy, move-in, charge, deposit or receipt |
| Any `*_OPEN` status, unknown status, remaining-evidence item | Nothing. Listed in the held file with the reason | — |

A case is always held when:

- its fresh readback differs from the package "before" state (`changed-since-research`);
- the account or tenancy cannot be found exactly;
- it needs payment, deposit or housing-assistance matching;
- an amount is unknown. Unknown amounts are never treated as zero.

The tooling never creates a payment, receipt, credit or deposit record, and it never deletes or rewrites an original entry.

Held reasons: `payment-matching-required`, `housing-assistance-open`, `deposit-allocation-open`, `identity-mapping-open`, `history-reconciliation-open`, `remaining-evidence-listed`, `changed-since-research`, `charge-reversal-not-instructed`, `structured-resolution-missing`, `unsupported-research-status`, `account-not-found`, `ambiguous-tenancy`, `charge-not-reversible`, `unknown-amount`, `unit-link-unresolved`, `package-case-applied`.

## Steps (on the Mac, against the live database)

Use one business day for steps 3–8. Reversal dates, balance-review dates and plan tokens depend on `--occurred-at`, so pass the same value to every command. `$T` is one ISO timestamp taken just before step 4 (`T=$(date -u +%FT%TZ)`). `$PRIVATE` is a new dated folder inside the private evidence folder. `$PKG` is the package directory. `$URL` is the runtime database URL.

1. **Read the checklist.** `owner-correction-checklist-<as-of>.json` lists each case's disposition, supported actions and required fresh readbacks. It also lists held items with reasons. To regenerate it from the package alone:
   `npx tsx scripts/rent-ops-corrections/build-owner-correction-plan.ts --checklist-only --package "$PKG" --out "$PRIVATE/checklist" --occurred-at "$(date -u +%FT%TZ)"`
2. **Fill structured resolutions (optional).** For a future-term unit link, copy `resolutionsTemplate` from the checklist to `$PRIVATE/resolutions.json`. Fill `unitNumber`, `plannedMoveInOn` (signed lease start) and `evidenceReference` from the signed lease. If any field is blank, validation fails and the case stays held.
3. **Back up the database** and verify that the backup restores, using the provider snapshot or `pg_dump` with a restore test. Record the backup identifier in `$PRIVATE/backup.txt`.
4. **Build from a fresh live read.** This step only reads.
   `npx tsx scripts/rent-ops-corrections/build-owner-correction-plan.ts --package "$PKG" --database-url "$URL" --resolutions "$PRIVATE/resolutions.json" --out "$PRIVATE/build" --occurred-at "$T"`
   It writes these files:
   - `baseline-snapshot.json`
   - `owner-correction-pack.json`
   - `owner-charge-reversal-plan.json`
   - `owner-correction-held.json`
   - `build-summary.json`, which records the paths and SHA-256 values used below

   Read the held file. Every case you expected to change must be in the pack or the reversal plan. If a case is held as `changed-since-research`, re-research it; do not edit the pack.
5. **Plan without applying.** Every phase and the reversal plan run in a transaction that is rolled back.
   `npx tsx scripts/rent-ops-corrections/plan-owner-corrections.ts --pack <pack> --pack-sha <sha> --baseline <baseline> --baseline-sha <sha> --ledger-plan <plan> --ledger-plan-sha <sha> --actor <operator-id> --occurred-at "$T" --database-url "$URL" --out "$PRIVATE/plan"`
   Review `owner-corrections-plan-review-*.json`, which has the full before/after for each target. Then record the phase token and the reversal token.
6. **Apply the operational pack** with the existing maintenance CLI. Plan and apply need separate `--out` folders because output files are create-only. The CLI reads the database from `RENT_OPS_RUNTIME_DATABASE_URL`.
   - Plan: `RENT_OPS_RUNTIME_DATABASE_URL="$URL" npx tsx scripts/rent-ops-maintenance.ts plan --pack <pack> --pack-sha <sha> --baseline <baseline> --baseline-sha <sha> --phases owner-corrections-1 --actor <operator-id> --occurred-at "$T" --out "$PRIVATE/maint-plan"`
   - Compare the token in `owner-corrections-1-plan.json` with the step 5 token. They must be identical.
   - Apply: `... apply <same options> --plan "$PRIVATE/maint-plan/owner-corrections-1-plan.json" --plan-sha <sha256 of that file> --approved-token <token> --apply-reviewed --out "$PRIVATE/maint-apply"`
   - The CLI saves `-before`, `-execution`, `-after` and `-verified` files. `-verified.json` confirms the saved readback: only the targeted records changed, and the ledger and allocations are unchanged.
   - If the pack has more than one phase, apply them in order. Use each phase's `-after.json` as the next `--baseline`, or use `execute-reviewed --phases all --apply-reviewed` after every phase has been planned.
7. **Apply the charge reversals** through the audited service.
   - Plan: `npx tsx scripts/rent-ops-corrections/apply-owner-charge-reversals.ts plan --ledger-plan <plan> --ledger-plan-sha <sha> --database-url "$URL" --actor <operator-id> --occurred-at "$T" --out "$PRIVATE/reversal-plan"`
   - Apply: `... apply <same options> --approved-token <token> --apply-reviewed --out "$PRIVATE/reversal-apply"`
   - Apply rechecks every charge's revision, before-hash and account ledger fingerprint. It posts one linked reversal per charge with `RentOpsService.reverseLedgerTransaction` and saves a readback, `owner-charge-reversal-readback-*.json`. The readback shows each original unchanged, only reversal rows added and allocations unchanged.
8. **Read back.**
   - Rerun step 4 into a new folder with a new `$T`. No applied case may appear in the new pack or reversal plan. Each one is held, usually as `changed-since-research`; an already-cancelled tenancy is held as `ambiguous-tenancy` because no non-cancelled tenancy remains. This proves nothing can be applied twice.
   - In 5Central Ops, open Account balances with all tenant statuses and all imported properties, and open each affected tenant ledger. Confirm the operational and posted totals the owner stated.
   - Save screenshots or exports in `$PRIVATE/readback`.
9. **If a readback fails,** stop. Operational changes are revisioned: a new reviewed pack can undo a specific change. A posted reversal cannot itself be reversed, so undoing one means restoring the step 3 backup and confirming the restore. Never correct anything with direct SQL.

## Guarantees and limits

- The pack is a standard maintenance pack. Its operations target records by exact ID, guard the researched fields and carry `packageEvidence` (`path`, `sha256`, `reference`) for the package files. The plan runner re-hashes that evidence before planning.
- The pack's `initialBaselineSha256`, snapshot counts and the maintenance CLI's live-snapshot hash check refuse any drift between build and apply.
- Reversal entries list each exact charge ID with the following:
  - the amount, as a decimal cents string;
  - the posted date and category;
  - the charge-edit revision issued by the audited editor;
  - the before-hash;
  - a deterministic reversal ID.

  The entries must add up to the researched total.
- A reversal is an operator entry. It has manual provenance and no source-artifact binding, like the audited charge-correction path. The imported original remains in the ledger.
- The tooling does not match payments, deposits or housing-assistance remittances. Those cases stay held until they are researched and supported by a separate, reviewed workflow.
- Posting to QuickBooks is outside this runbook.
