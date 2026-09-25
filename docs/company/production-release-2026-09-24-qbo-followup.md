# Production release addendum — QuickBooks receivables mirror (migration 050)

Date: September 24, 2026 · Followup branch: `codex/postcutover-financial-source-20260924`

This addendum covers the reviewed followup from schema 049 to 050. The production release
runbook in [`production-release-2026-09-23.md`](./production-release-2026-09-23.md) remains the
source of truth for the already released hosting, document-relocation and v049 cutover. Do not
apply this addendum by starting the application or by using `db:push` or `db:migrate`.

## Release gates

Before opening the followup window:

1. Before merging, set both production Render services to manual deployment and verify that no
   deploy is queued or running. Production currently auto-deploys after CI passes; merging first
   could start the schema-050 build against the schema-049 database. Keep the existing release
   serving while the protected review and backup preparation finish.
2. Merge the protected branch only after the required `Verify and build` check and review pass.
   The release branch freezes migration 050 with `RELEASED_THROUGH = 50`.
3. Confirm the frozen registry and rendered migration. The source checksum is
   `8eb43fdc0b7a8c901b739af2d2d241768f471f4614b4050a73f5f4eb594c2736`; the rendered checksum is
   `05edcddfdc927eca7809a2a474e226bdfed5940b1afdd8f5dd29670e5c841aa3`.
4. Keep QBO writes disabled (`QBO_WRITES_ENABLED=off` and `QBO_PRODUCTION_WRITES=off`). Freeze
   application writes and hold the worker while the schema and grants change.
5. Create and verify the reviewed Neon backup and off-platform dump/restore rehearsal. The old
   v049 grant manifest is not a v050 attestation: it covers 164 managed tables, while this branch
   manages 167.

## Rehearsal and production apply

Use the existing production-schema operator with the owner connection held in the named
environment variable. Review the output and retain each digest before proceeding:

```sh
npm run company:production-schema -- inspect --through 50
npm run company:production-schema -- apply --through 50 --confirm <planSha256> --apply-reviewed
```

Read `describe.roles` before planning grants. Production currently uses the runtime-only role;
add importer or auditor roles only when the live description proves they exist. Generate the plan
from this branch and review its SQL:

```sh
ROLES="--runtime-role rent_ops_production_web"
ATTEST="--environment production --database rent_ops_production --backup <backup-ref> --review <review-ref> --authorization <authorization-ref>"
npm run company:production-schema -- grants-plan $ROLES $ATTEST
npm run company:production-schema -- grants-apply $ROLES $ATTEST --confirm <grantSha256> --apply-reviewed
npm run company:production-schema -- grants-verify $ROLES $ATTEST
```

The expected runtime privileges are:

| Table | Runtime role |
| --- | --- |
| `accounting_qbo_receivable_documents` | `SELECT`, `INSERT`, `UPDATE` |
| `accounting_qbo_receivable_effects` | `SELECT`, `INSERT` |
| `accounting_qbo_receivable_applications` | `SELECT`, `INSERT` |

The new effects and applications tables are append-only. There must be no runtime `DELETE` or
`UPDATE` grant on them, and PUBLIC privileges must be revoked for all three tables. The generated
grant digest is the attestation; do not hand-edit the SQL or reuse the v049 artifact.

After `grants-verify` succeeds, deploy the followup build with the worker still held. Verify
`/readyz`, the runtime grant check, and the existing document readback. Then open the worker and
confirm a fresh `company_worker_heartbeats` row and successful bounded read-only QBO mirror work.
The mirror migration does not perform an initial provider replay by itself; provider acceptance
and reconciliation remain a separate read-only gate. Restore the prior Render auto-deploy policy
only after the web and worker acceptance checks succeed.

## Compatibility and rollback

`/readyz` confirms required tables exist and forbidden privileges are absent; it does not prove
that the three new tables have every required runtime grant. A successful `grants-verify` and the
worker heartbeat are required before reopening traffic.

If the followup must be rolled back, keep writes frozen and use only the v049 build and privilege
set proven compatible by the rehearsal. Keep the additive v050 tables unless a reviewed data
restore is required; never drop them or delete mirrored history as a rollback shortcut.
