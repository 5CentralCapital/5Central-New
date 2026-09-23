# Production release — audited ops rollout + QuickBooks production (Replit)

Date: September 23, 2026 · Branch: `claude/qbo-production-release`

This release deploys the audited rollout (`codex/audit-ops-rollout-20260923` @ `73e5230`, see
`codex-release-audit-2026-09-23.md`) to the existing Replit deployment at
`https://5central.capital`, adds a continuously running worker, applies migrations 043–048, and
connects QuickBooks **production** read-only. Render remains the next hosting move
(`hosting-render` handoff); nothing here blocks it.

Hard limits for this release:

- `QBO_WRITES_ENABLED=off` and `QBO_PRODUCTION_WRITES=off`. No `QBO_WRITE_TYPES`.
- No tenant or owner corrections are applied. No company demo data.
- No `db:push`, `db:migrate` or startup migration. Migrations go through
  `npm run company:production-schema` only.

## What this branch adds on top of `73e5230`

| Change | Why |
|---|---|
| `claude/qbo-production-keys` merged: `npm run company:qbo-preflight`, `docs/company/qbo-production.md` | Catches QBO secret typos before connecting a company. An explicit `off` for the write switches now reads as the intended state. |
| `npm run company:production-schema` (`server/company/operations/production-schema.ts`) | The reviewed migration operator: inspect → digest-bound apply in one transaction under an advisory lock with ledger readback; manifest-derived runtime grants with live privilege verification; backup-copy comparison. Tested on PGlite, including rollback of a failed batch. |
| `npm start` → `scripts/deploy/start.mjs` with `RENT_OPS_PROCESS_ROLE` (`web` default, `worker`) | One build and one run command for both deployments. A second Replit deployment of the same repo runs the worker by setting a single environment value. |
| `RELEASED_THROUGH = 48` | Migrations 043–048 ship in this release, so their registry entries freeze. |
| Mac app (`desktop/`, `src-tauri/`) committed | Loads `https://5central.capital/ops` (was the Replit host), is named 5Central Ops, and its Go menu is drift-tested against the web navigation. |

## Facts established before the release (September 23)

- The live ops database is **not** Replit's "Production Database" (that one holds only the legacy
  website tables). The runtime identity points at Neon project *Updated Website - claude code*
  (`long-wave-42463880`, AWS us-east-1, Postgres 17), branch **`rent-ops-replacement-20260907`**,
  database **`rent_ops_production`**. Confirm this in step 1 before changing anything: the host in
  the deployment's `RENT_OPS_RUNTIME_DATABASE_URL` must be that branch's endpoint.
- Previous practice for v42 was a pre-change backup branch (`rops-pre-v42-20260922`) and a
  rehearsal branch (`rops-v42-rehearsal-20260922`). This release follows the same pattern.
- Neon history retention on this project is 6 hours, so the branch snapshot is the backup of record.
- Replit's deployment type cannot change from Autoscale to Reserved VM without unpublishing, which
  would interrupt `5central.capital`. The web app therefore stays Autoscale and the worker is a
  **second deployment** (Reserved VM, background worker) against the same database.
- Intuit portal: app "5Central Rent Ops" is In Production; the production redirect URI
  `https://5central.capital/api/accounting/qbo/callback` was registered on September 23.
- `/readyz` answers 200 on `5central.capital`; Replit intercepts `/healthz`.

## Operator steps

Commands run in a shell that has this branch checked out with dependencies installed (the Replit
workspace shell, or `~/Projects/r-ops` on the Mac). Connection strings go into environment
variables by name; the tool never prints them. Use the **owner** role (`neondb_owner`) URLs from
Neon ▸ Connect, selecting the branch and database each time.

### 1. Identify and describe (read-only)

```sh
export RENT_OPS_MIGRATION_DATABASE_URL='<owner URL: branch rent-ops-replacement-20260907, db rent_ops_production>'
npm run company:production-schema -- describe
npm run company:production-schema -- inspect --through 48
```

Expected: `installedThrough: 42`, pending `43…48`, and a `planSha256`. Record the runtime,
importer and auditor role names from `describe.roles` (the runtime role is the user in
`RENT_OPS_RUNTIME_DATABASE_URL`). If `installedThrough` is not 42, stop: the tool refuses drift,
gaps and databases ahead of the build, and nothing else should be improvised.

### 2. Back up and prove the backup

1. Neon ▸ Branches ▸ New branch: parent `rent-ops-replacement-20260907`, "current point in time",
   name `rops-pre-v48-20260923`.
2. ```sh
   export RENT_OPS_BACKUP_DATABASE_URL='<owner URL: branch rops-pre-v48-20260923, db rent_ops_production>'
   npm run company:production-schema -- compare-backup --backup-url-env RENT_OPS_BACKUP_DATABASE_URL
   ```
   Expected `matches: true` (same ledger, identical row counts for every ops table). If live writes
   land between the branch and the comparison, a few counts can differ; re-run immediately. Keep the
   `ledgerSha256` as the backup attestation.

### 3. Rehearse on a disposable branch

1. Neon ▸ New branch from `rops-pre-v48-20260923`, name `rops-v48-rehearsal-20260923`.
2. Point `RENT_OPS_MIGRATION_DATABASE_URL` at the rehearsal branch and run the full sequence in
   step 4 there first, including `grants-verify`. Delete the rehearsal branch afterwards.

### 4. Apply 043–048 and runtime grants to production

```sh
export RENT_OPS_MIGRATION_DATABASE_URL='<owner URL: live branch>'
npm run company:production-schema -- inspect --through 48          # copy planSha256
npm run company:production-schema -- apply --through 48 --confirm <planSha256> --apply-reviewed

ROLES="--runtime-role <runtime> --importer-role <importer> --auditor-role <auditor>"
ATTEST="--backup neon:rops-pre-v48-20260923:<ledgerSha256-prefix> --review <reviewer-ref> --authorization michael-20260923-release"
npm run company:production-schema -- grants-plan  $ROLES $ATTEST   # review the SQL, copy grantSha256
npm run company:production-schema -- grants-apply $ROLES $ATTEST --confirm <grantSha256> --apply-reviewed
npm run company:production-schema -- grants-verify $ROLES $ATTEST  # expect verified: true
npm run company:production-schema -- inspect --through 48          # expect installedThrough 48, nothing pending
```

The apply is one transaction: any failure rolls back every pending version. The grant step is one
transaction that refuses missing roles and rolls back unless the live privileges then equal the
manifest exactly. The currently published build keeps working against the upgraded schema (the
new tables are additive), so there is no outage between this step and the publish.

### 5. Deploy the web app (existing Replit deployment, Autoscale)

1. Replit workspace ▸ Shell: `git status` (preserve any unrelated work), then
   `git fetch origin && git checkout claude/qbo-production-release && git pull --ff-only`.
2. Publishing ▸ Adjust settings ▸ **Production app secrets** (values entered by Michael):

   | Name | Value |
   |---|---|
   | `QBO_ENVIRONMENT` | `production` |
   | `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` | production keys from the Intuit portal |
   | `QBO_REDIRECT_URI` | `https://5central.capital/api/accounting/qbo/callback` (already set; keep exact) |
   | `QBO_TOKEN_ENCRYPTION_KEY` | new: `echo "base64:$(openssl rand -base64 32)"`. Store it in the password manager: the worker, Render and every future deployment must use the identical value or stored tokens become unreadable. |
   | `QBO_WRITES_ENABLED`, `QBO_PRODUCTION_WRITES` | `off` |
   | `RENT_OPS_PROCESS_ROLE` | leave unset (web) |

   Leave "Copy development database to production" unchecked.
3. Publish. Then verify: `https://5central.capital/readyz` → 200, manager sign-in at `/ops`,
   the original dashboard and top navigation, report setup and a report run, Forecasting,
   Projects, Investors, and Accounting ▸ Overview showing the **Production** badge.

### 6. Deploy the worker (second Replit deployment)

1. Replit ▸ Import from GitHub ▸ `5CentralCapital/5Central-New`, branch
   `claude/qbo-production-release`, name it `5Central-Ops-Worker`.
2. Secrets for its deployment: `NODE_ENV=production`, `RENT_OPS_PROCESS_ROLE=worker`,
   `RENT_OPS_RUNTIME_DATABASE_URL` (identical to the web app), every `QBO_*` value identical to the
   web app (including the same `QBO_TOKEN_ENCRYPTION_KEY`), `WORKER_SHUTDOWN_GRACE_MS=25000`.
   The worker never reads `DATABASE_URL` in production.
3. Publish ▸ **Reserved VM ▸ Background worker** (no port), build `npm ci && npm run build`,
   run `npm run start`. Confirm the monthly cost in Replit's dialog.
4. Verify in its logs: `starting 5Central Ops process` with `role: worker`, then periodic job
   activity; a stopped worker leaves queued work waiting, never lost.

### 7. Connect each LLC to QuickBooks production (read-only)

For Capital, then Lucia, then Arcadia — one company per session, signed in to Intuit as that
company's admin:

1. Accounting ▸ Connect QuickBooks. On return, compare the CompanyInfo name and legal name with the
   legal entity before confirming the binding (a realm cannot be rebound).
2. Run the read probe and a sync (UI, or the `sync_accounting_source` MCP tool).
3. Reconcile one closed month: mirror totals vs. QuickBooks P&L and trial balance. Explain every
   difference; unsupported objects appear as sync exceptions, never as zero.

### 8. Webhooks

1. Intuit portal ▸ Production ▸ Webhooks: endpoint
   `https://5central.capital/api/integrations/quickbooks/webhook/production`, CloudEvents payload,
   entities Account, Bill, BillPayment, Customer, Deposit, Employee, Purchase, Vendor (the mirrored
   set; add Invoice, Payment, CreditMemo, JournalEntry, Transfer when the receivable mirror ships).
2. Put the verifier token in the web deployment's `QBO_WEBHOOK_VERIFIER_TOKEN_PRODUCTION` and
   republish. Without it the endpoint answers 503 by design.
3. Make a trivial edit in one company (for example a vendor memo) and confirm a row in
   `accounting_qbo_webhook_events` and a completed fetch job. The periodic CDC catch-up is the
   backstop for missed deliveries.
4. Intuit's questionnaire answered "No" for webhooks and CDC; tell the Intuit case contact before
   enabling so the app profile stays accurate.

## Rollback

- **Before step 4:** nothing changed.
- **After step 4, before publish:** leave the schema at 48; the current build runs on it.
- **After publish:** Replit ▸ Publishing ▸ roll back to the previous deployment (`99a72394`), which
  runs on the additive schema. Stop the worker deployment. Keep the QBO connections; they are
  environment-scoped and harmless while writes are off.
- **Data restore** only for proven corruption, from `rops-pre-v48-20260923` through Neon's branch
  restore, accepting loss of writes made after the snapshot. Never drop the new tables as a shortcut.

## Remaining blockers outside the code

- Michael enters every secret value (Replit, Intuit verifier token) and approves the Reserved VM cost.
- Each LLC's Intuit admin sign-in and CompanyInfo binding confirmation.
- Webhook registration in the Intuit portal and the note to the Intuit case contact.
- Owner-attested tenant corrections remain `PREPARED_NOT_APPLIED`.
