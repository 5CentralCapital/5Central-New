# Codex release audit — September 23, 2026

## Release scope

Reviewed Claude's `claude/5central-ops-rollout` at `ddfd08fde17b85047b945838868786b9331b502c`, based on `e8f3e4c`. The audit uses a separate checkout; the existing design-system checkout and its uncommitted Mac/Tauri work are excluded.

Michael's final instruction for this release is **audit, fix, and push to GitHub; Michael will deploy**. Provider changes are being handled in another task. This release does not activate live QuickBooks writes, apply tenant corrections, seed company demo data, or migrate a live database.

## Audit findings

The independent review identified and corrected four issues:

1. Review-case operational corrections were not constrained by the reason for the case. A financial receipt case could propose ending a recurring charge schedule. Explicit operation allowlists now validate the reason/operation relationship both when proposing and when applying a previously stored proposal. Unsupported operational corrections are rejected while evidence research and safe routing remain available.
2. An unclassified QuickBooks journal-entry create could avoid the rental posting-method check. Journal entries without rental posting context are now held at submission and worker execution. General non-rental journal-entry submission requires a separate explicit classification workflow before it can be enabled.
3. PM settlement reconciliation treated a typed bank reference and date as proof of receipt. There is no verified bank-observation adapter in this release. Positive-remittance statements must remain unreconciled until that verification is implemented; drafting and gross-to-net reporting remain available.
4. Webhook events that require a full catch-up rather than an individual object fetch could remain marked as routed after the catch-up completed. Event references now travel through catch-up processing, including object-not-found recovery. A retryable periodic finalizer checks durable job completion for every required company binding, separately for sandbox and production. It handles concurrent completion and crash recovery and rejects skipped, partial, or unanchored results. Object and catch-up handlers share the same 200-reference bound; a 101-reference recovery regression covers the previous mismatch.

## Independent baseline validation

On Claude's original tip, the audit ran:

| Check | Result |
| --- | --- |
| Full test suite | 1,788 passed; 6 skipped; 0 failed (1,794 total) |
| Performance evaluator tests | 16 passed; 0 failed |
| Typecheck | Passed |
| Migration registry | Passed; 48 migrations; latest version 48 |
| Production build | Passed; web and worker bundles produced |

These are independently observed counts from `npm run test:all`, not a restatement of the different total in Claude's handoff. Performance evaluator tests validate the measurement tooling; they do not establish production loading speeds. Production data, provider connectivity, and deployment performance remain unverified by this release audit.

Chromium browser acceptance passed for top navigation, legacy bookmarks, dashboard layout, keyboard navigation, report-library drilldown, synthetic project creation/schedule navigation, appearance controls, and responsive overflow checks. The report setup smoke passed for 11 rental reports, their report-specific period/filter controls, API/query parity, invalid-date rejection, dependent-filter clearing, reload behavior, CSV output, and mobile controls, with no page errors.

The first report-setup run timed out on external Google Fonts requests. A retry passed with only that font host forced offline in an external test wrapper; no app errors or assertions were suppressed. WebKit and production loading speeds were not verified. The synthetic navigation run measured approximately 6.26 seconds to its dashboard-ready assertion on this Mac; this is not a production performance certification.

## Final post-fix verification

| Check | Result |
| --- | --- |
| `npm run test:all` | Exit 0; 1,799 total, 1,793 passed, 6 skipped, 0 failed |
| `npm run test:performance` | Exit 0; 16 passed, 0 failed or skipped |
| `npm run check` | Exit 0 |
| `npm run company:migrations:verify` | Exit 0; 48 valid migrations; no live database attestation |
| `npm run build` | Exit 0; web, worker, and rendered migration artifacts produced |
| `git diff --check` | Passed |

Focused regressions also passed for review-case scope/reason protection, PM reconciliation and HTTP/MCP transports, journal-entry submission/execution, and webhook concurrent fanout, cross-environment isolation, incomplete-job handling, and larger-batch catch-up. The six skipped tests remain opt-in database/benchmark checks. The completed full run supersedes the intentionally interrupted preliminary run made while the last boundary fix was being prepared.

## Deploying this build

Use GitHub branch `codex/audit-ops-rollout-20260923` and the exact commit identified in the release message. Do not publish the unrelated local desktop checkout or assume Replit automatically follows a newly pushed branch. Inspect the existing Replit checkout first and preserve any unrelated uncommitted work. This push does not change the repository's default branch or deployment settings.

1. Record the currently deployed commit and take a restorable backup of the actual target database. Verify its migration versions and checksums before applying anything.
2. Run `npm ci`, `npm run company:migrations:verify`, and `npm run build` on the selected commit. The build renders reviewed SQL into `dist/migrations/` and creates `dist/index.js` and `dist/worker.js`.
3. If the target is at version 42, apply rendered migrations **043–048 in order** through the existing reviewed migration process, using the restricted migration identity. If its version differs, determine the exact missing chain rather than replaying the entire directory. Raw source SQL contains checksum placeholders and is not the deployment artifact. Do not use `db:push`, `db:migrate`, or startup migrations.
4. Review and update runtime privileges for the new tables against `server/rent-ops/security/deployment-security.ts`; retain the separate host, runtime, and migration roles, append-only protections, and startup checks. Verify the resulting schema and role permissions. Advance `RELEASED_THROUGH` in `scripts/company/refresh-migration-registry.ts` only once the corresponding migrations have actually shipped.
5. Preserve existing production authentication, storage, and domain configuration. Keep `QBO_WRITES_ENABLED=off` and `QBO_PRODUCTION_WRITES=off`. Company demo data is local/test-only. Owner-correction tooling is not a deployment step.
6. The current Replit configuration builds with `npm run build` and runs the web service with `npm run start`. It is sufficient for inspecting the web app after its database prerequisites are satisfied. A separate continuously running `npm run worker` is required for queued QuickBooks sync, webhook processing, outbox work, and scheduled review detection. Autoscale web deployment does not supply that worker; coordinate it with the separate provider task. Queued does not mean processed.
7. After publishing, verify `/healthz`, `/readyz`, manager login at `/ops`, the original dashboard and top navigation, report setup/results, forecast workspace, projects, investors, and accounting connection status. Confirm unauthenticated requests cannot read company or tenant information. Missing real company grants, mappings, provider data, or opening balances must stay visibly unavailable rather than be replaced with demo values.

On failure, stop activation of new jobs and financial writes, preserve new records, and use the recorded application rollback only after verifying its compatibility with the upgraded schema. Database recovery must use the reviewed recovery procedure; do not drop the new tables as a shortcut.

The source handoff remains `docs/company/handoff-2026-09-23.md`. Detailed local audit/test evidence is outside source control under `/Users/michaelmcelwee/Projects/r-ops-build-evidence/`.
