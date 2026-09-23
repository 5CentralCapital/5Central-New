# Production release — audited ops rollout + QuickBooks production on Render

Date: September 23, 2026 · Branch: `claude/qbo-production-release`

This release deploys the audited rollout (`codex/audit-ops-rollout-20260923` @ `73e5230`, see
`codex-release-audit-2026-09-23.md`) to Render with an always-on worker, applies migrations
043–048, and connects QuickBooks **production** read-only for each LLC. The Render, AWS and
Google accounts are being configured separately (Codex handoff); this runbook covers the code and
database side. `render-cutover-audit-2026-09-23.md` lists what is ready and what is still open;
`qbo-production-compliance-2026-09-23.md` maps the integration to Intuit's requirements.

Hard limits for this release:

- `QBO_WRITES_ENABLED=off` and `QBO_PRODUCTION_WRITES=off` (set in the Blueprint's shared group). No `QBO_WRITE_TYPES`.
- No tenant or owner corrections are applied. No company demo data.
- No `db:push`, `db:migrate`, preDeploy or startup migration. Migrations go through
  `npm run company:production-schema` only.
- Migration 049 (receivables mirror) is on the follow-up branch `claude/qbo-financial-source`
  and is **not** part of this release.

## What this branch adds on top of `73e5230`

| Change | Why |
|---|---|
| `claude/qbo-production-keys` merged: `npm run company:qbo-preflight`, `docs/company/qbo-production.md` | Catches QBO secret typos before connecting a company. An explicit `off` for the write switches reads as the intended state. |
| `npm run company:production-schema` (`server/company/operations/production-schema.ts`) | Reviewed migration operator: inspect → digest-bound apply in one transaction under an advisory lock with ledger readback; manifest-derived runtime grants with live privilege verification; backup-copy comparison. Tested on PGlite, including rollback of a failed batch. |
| `render.yaml` rewritten; `.github/workflows/ci.yml`; `engines.node` 22 | Paid web + worker in `virginia` (next to Neon us-east-1), `production` branch with `autoDeployTrigger: checksPass`, `/readyz`, Node 22 pinned, QBO values on both services. |
| Graceful web shutdown (`server/graceful-shutdown.ts`) | Render sends SIGTERM on every deploy; in-flight OAuth callbacks and webhook acknowledgements now finish. |
| `npm start` → `scripts/deploy/start.mjs` (`RENT_OPS_PROCESS_ROLE`, default `web`) | One build and start command for any host; Render uses `npm run worker` directly. |
| QBO list queries include inactive records | QuickBooks hides inactive accounts/customers unless the query names `Active`; a full replay previously tombstoned them. |
| Record-only Invoice write guard | Any future Invoice write must disable online payment and email explicitly and is verified on the saved record. Writes remain off. |
| `RELEASED_THROUGH = 48` | Migrations 043–048 ship in this release. |
| Mac app (`desktop/`, `src-tauri/`) committed | Loads `https://5central.capital/ops`, named 5Central Ops, Go menu drift-tested against the web navigation. |

## Facts established on September 23

- Live ops database: Neon project *Updated Website - claude code* (`long-wave-42463880`, AWS
  us-east-1, Postgres 17), branch **`rent-ops-replacement-20260907`**, database
  **`rent_ops_production`**. Confirm before changing anything: the host in the current
  `RENT_OPS_RUNTIME_DATABASE_URL` must be that branch's endpoint. (Replit's own "Production
  Database" holds only the legacy website tables.)
- Previous practice (v42): backup branch `rops-pre-v42-20260922` + rehearsal branch
  `rops-v42-rehearsal-20260922`. Follow the same pattern.
- Neon history retention is 6 hours; the branch snapshot is the backup of record.
- Intuit portal: app is In Production; production redirect URI
  `https://5central.capital/api/accounting/qbo/callback` is registered.

## Operator steps

Run the database commands from any shell with this branch checked out and `npm ci` done (the Mac
checkout, or a Render shell). Connection strings go into environment variables by name; the tool
never prints them. Use the Neon **owner** role URLs (Neon ▸ Connect, choose branch and database).

### 1. Describe and inspect (read-only)

```sh
export RENT_OPS_MIGRATION_DATABASE_URL='<owner URL: branch rent-ops-replacement-20260907, db rent_ops_production>'
npm run company:production-schema -- describe
npm run company:production-schema -- inspect --through 48
```

Expected: `installedThrough: 42`, pending `43…48`, a `planSha256`. Record the runtime, importer and
auditor role names from `describe.roles`. Any other state: stop.

### 2. Back up and prove the backup

1. Neon ▸ Branches ▸ New branch from `rent-ops-replacement-20260907`, current point in time,
   name `rops-pre-v48-20260923`.
2. `export RENT_OPS_BACKUP_DATABASE_URL='<owner URL: rops-pre-v48-20260923 / rent_ops_production>'`
   then `npm run company:production-schema -- compare-backup --backup-url-env RENT_OPS_BACKUP_DATABASE_URL`.
   Expect `matches: true`; keep `ledgerSha256`.

### 3. Rehearse

Branch `rops-v48-rehearsal-20260923` from the backup, point `RENT_OPS_MIGRATION_DATABASE_URL` at it,
run step 4 in full including `grants-verify`, and point a Render **staging** web service at it for
a smoke test if desired. Delete it afterwards.

### 4. Apply 043–048 and runtime grants

```sh
export RENT_OPS_MIGRATION_DATABASE_URL='<owner URL: live branch>'
npm run company:production-schema -- inspect --through 48          # copy planSha256
npm run company:production-schema -- apply --through 48 --confirm <planSha256> --apply-reviewed
ROLES="--runtime-role <runtime> --importer-role <importer> --auditor-role <auditor>"
ATTEST="--backup neon:rops-pre-v48-20260923 --review <reviewer-ref> --authorization michael-20260923-release"
npm run company:production-schema -- grants-plan  $ROLES $ATTEST   # review SQL, copy grantSha256
npm run company:production-schema -- grants-apply $ROLES $ATTEST --confirm <grantSha256> --apply-reviewed
npm run company:production-schema -- grants-verify $ROLES $ATTEST  # verified: true
```

The currently published build keeps working on the upgraded schema (additive tables), so this can
run before the Render cutover.

### 5. Render

1. Create a `production` branch at the reviewed tip of this branch and protect it (require PR + the
   `CI / verify` check). Render follows `production` only.
2. Blueprint from `render.yaml`. Enter every `sync: false` value. Copy the existing
   `SESSION_SECRET`/`RENT_OPS_SESSION_SECRET` from Replit to keep sessions and limiter keys.
   `QBO_TOKEN_ENCRYPTION_KEY`: generate once (`echo "base64:$(openssl rand -base64 32)"`), store in
   the password manager, and enter the **same** value on web and worker.
3. QBO values: `QBO_ENVIRONMENT=production`, production `QBO_CLIENT_ID`/`QBO_CLIENT_SECRET`,
   `QBO_REDIRECT_URI=https://5central.capital/api/accounting/qbo/callback` on both services.
   `QBO_WEBHOOK_VERIFIER_TOKEN_PRODUCTION` on web after step 8.
4. Verify on the `onrender.com` URL: `/readyz` 200; worker log shows job activity.
5. DNS: add `5central.capital` and `www` as custom domains, point records as Render instructs,
   wait for the certificate. Stop (do not delete) the Replit deployment; keep it and its bucket
   30 days.

### 6. Verify on `https://5central.capital`

Public site, manager sign-in at `/ops`, dashboard and top navigation, report setup and a run,
Forecasting, Projects, Investors, legal pages (`/legal/eula`, `/legal/privacy`,
`/quickbooks/disconnected`), document download, MCP sign-in, Accounting ▸ Overview showing the
**Production** badge. Mac app: launch and confirm it opens the same manager.

### 7. Connect each LLC to QuickBooks production (read-only)

Capital, then Lucia, then Arcadia — one per session, signed in as that company's QuickBooks admin:
Accounting ▸ Connect QuickBooks; compare CompanyInfo with the legal entity before confirming the
binding (a realm cannot be rebound); run the read probe and a sync; reconcile one closed month
against QuickBooks' P&L and trial balance. Unsupported objects appear as sync exceptions, never
zero.

### 8. Webhooks

1. **First** tell the Intuit case contact that webhooks and change-data-capture are being enabled
   (the questionnaire answered "No" to both) so the app profile stays accurate.
2. Intuit portal ▸ Production ▸ Webhooks: CloudEvents format, endpoint
   `https://5central.capital/api/integrations/quickbooks/webhook/production`, entities Account, Bill,
   BillPayment, Customer, Deposit, Employee, Purchase, Vendor.
3. Put the verifier token in `QBO_WEBHOOK_VERIFIER_TOKEN_PRODUCTION` (web) and redeploy.
4. Edit a vendor memo in QuickBooks; confirm a row in `accounting_qbo_webhook_events` and a completed
   fetch job. Hourly change-data-capture is the backstop.

## Rollback

- Before DNS: nothing user-facing changed; point nothing.
- After DNS: point DNS back to Replit (keep its deployment stopped-not-deleted for this). The Replit
  build runs on the additive schema.
- Data restore only for proven corruption, from `rops-pre-v48-20260923`, accepting loss of later
  writes. Never drop the new tables as a shortcut.
