# RM Workspace Overhaul

Goal: implement the approved RM workflow/design/performance overhaul while preserving every working MVP feature. Work swiftly through 03:00 America/New_York on 2026-09-12; use compute for useful implementation and verification.

Baseline: clean upstream codex/rent-ops-tenant-portal fd4673585e26f9972cb65d44bc2b9a3f0b0d4ce5. Existing release credentials/live acceptance are separate, not assumed complete. No live tenant writes, sends, real payments, migrations, or credential changes for development.

Models: root Astra Max orchestration and difficult architecture. All active workers use Astra Medium per Michael's latest instruction. Earlier Luna Max and Astra Low workers are interrupted or idle. Explicit user swarm authorization is present.

Approach: preserve original manager workspace as classic compatibility surface; build a compact RM workspace with disjoint components, original server mutation validation, and narrowed page-loading endpoints. Use staging synthetic browser QA, unit/domain/security regressions, typecheck, and production build. Current branch is isolated from original release checkout.

Visual contract: charcoal #3A3A3C, gold #D4A843, cream #F5F0E8, near-black text. Compact sans typography, record lists, summary bars, record tabs, dense tables, contextual actions, consistent save/cancel. Preserve uncertainty alongside financial amounts. No giant raw object cards or opaque identifiers as primary labels.

Work packets: baseline/release inventory; performance API/repository; shared grid; brand CSS; tenant record; property/unit records; report/dashboard; applications/documents; editor improvements; independent QA. Root owns integration shell, record routing, caching and entrypoint.

Ownership: all agents get explicit files, operate on separate worktrees, commit only owned files, and return commits for sequential integration. No concurrent deployment or schema ownership. Shared API/types changes need root agreement.

Verification: baseline existing suite then affected tests and combined suite, TypeScript, production build, synthetic browser save/reopen, financial consistency and concurrency, published read-only smoke if deployment path is available. Stage only scoped files. No real-business-data fixtures or credentials in commits.

Completion: deliver functioning integrated workspace with validated core edits and improved measured loading, deployed only after compatibility checks; report prepared/local/published states precisely and remaining blockers. Preserve full objective if the time or account budget expires.
