# Tenancy missing-date follow-up

Implements the PR #11 handoff from production commit `e4dbb2cb28dfd2d2758f448efe626d7a078b6804`.

An existing QuickBooks Customer identity can supply a read-only tenant ledger when required tenancy dates are missing and the property's complete ownership history contains only that linked legal entity. The ownership state is `linked_dates_missing`; the confirmed effective owner remains null. The tenant screen explains which dates need confirmation. The HTTP read authorizes the linked entity and property before returning ledger data or an ownership-review response.

Multiple identities, multiple owners, an unmapped linked entity, or conflicting known dates remain blocked. New customer links still require fully resolved tenancy dates and ownership. Import timestamps are never tenancy dates. The receivables balance calculation and QuickBooks write controls are unchanged.

Production measurement ran through the deployed Render runtime in read-only transactions at 7:37 PM Eastern on September 26. The handoff query counted 442 tenancies: 441 without missing required boundaries, zero missing starts, and one missing end. No QuickBooks Customer-to-tenancy identities existed in any environment. Per-property counts were saved in the private iCloud review folder.

The final read-only measurement at 8:05 PM Eastern on September 26 returned the same 442 tenancies, 0 missing starts, 1 missing end, and 0 customer-to-tenancy links. This is a before/after implementation-work checkpoint; the code has not been deployed.

The one missing end belongs to a cancelled QA record with a cancelled, unsigned lease and no executed document or import source reference. No date correction is supported. The proposed backfill CSV therefore contains no rows; a private manual-review CSV identifies the QA record to leave unchanged. Runtime access to `rent_ops_source_records` is denied, so no claim is made that those source records were inspected. No production data or permissions were changed.

`scripts/company/tenancy-date-counts.sql` reproduces the read-only overall and per-property measurement. Run it with the runtime connection before and after an approved release or data correction. Any future backfill needs an evidenced date, source record ID, and Michael's approval, then the normal revision-checked patch path.

This follow-up does not authorize a production deployment or a data backfill.
