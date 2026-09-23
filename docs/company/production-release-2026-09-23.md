# Production release — audited ops rollout + QuickBooks production on Render

Date: September 23, 2026 · Branch: `claude/qbo-production-release` (on top of `hosting/render`)

This release deploys the audited rollout (`codex/audit-ops-rollout-20260923` @ `73e5230`, see
`codex-release-audit-2026-09-23.md`) to Render with an always-on worker, applies migrations
043–049, relocates the verified documents from Replit storage to S3, and connects QuickBooks
**production** read-only for each LLC. Hosting configuration and account setup are Codex's
`docs/RENDER_DEPLOYMENT.md`; `render-cutover-audit-2026-09-23.md` lists what is ready and what is
open; `qbo-production-compliance-2026-09-23.md` maps the integration to Intuit's requirements.

Hard limits for this release:

- `QBO_WRITES_ENABLED=off` and `QBO_PRODUCTION_WRITES=off` (pinned on both services in
  `render.yaml`). No `QBO_WRITE_TYPES`.
- No tenant or owner corrections are applied. No company demo data.
- No `db:push`, `db:migrate`, preDeploy or startup migration. Migrations go through
  `npm run company:production-schema` only.
- The production migration, the document relocation apply, the `production` branch and DNS need
  Michael's explicit approval for the cutover window.
- The receivables mirror (`claude/qbo-financial-source`, migration 050) is **not** in this release.

## Facts established on September 23

- Live ops database: Neon project `long-wave-42463880` (AWS us-east-1, Postgres 17), branch
  `rent-ops-replacement-20260907` (`br-flat-scene-ahvx8421`), database `rent_ops_production`,
  runtime role `rent_ops_production_web`; host database `neondb`, role `rent_ops_host_web`.
  Replit's own Oregon `DATABASE_URL` is not used.
- Schema registry v42 (42 rows). 1,509 `rent_ops_document_objects` rows on `replit-managed-gcs`.
- Previous practice (v42): backup branch `rops-pre-v42-20260922` + rehearsal branch
  `rops-v42-rehearsal-20260922`. Neon history retention is 6 hours; the branch is the backup of
  record.
- Intuit portal: app In Production; production redirect URI
  `https://5central.capital/api/accounting/qbo/callback` registered.

## Operator steps

Run database commands from a shell with this branch checked out and `npm ci` done. Connection
strings go into environment variables by name; the tools never print them. Use the Neon
**owner** URL (Neon ▸ Connect, choose branch and database) for `RENT_OPS_MIGRATION_DATABASE_URL`.

### 0. Before the window (no database writes)

1. Staging per `docs/RENDER_DEPLOYMENT.md`: isolated Neon branch, S3 canary, `/readyz` 200, upload
   and download, manager sign-in on the staging hostname, worker job, QBO **sandbox** connect.
2. Document copy from inside the Replit workspace (`document-relocation.md` steps 1–3). It only
   reads the database and writes content-addressed objects to S3.
3. Gmail sender credentials and the production groups filled in (the production web will not
   start without Gmail, see the audit, gate 5).
4. Lower the DNS TTL for `5central.capital` and `www` to 300 s the day before.

### 1. Describe and inspect (read-only)

```sh
export RENT_OPS_MIGRATION_DATABASE_URL='<owner URL: rent-ops-replacement-20260907 / rent_ops_production>'
npm run company:production-schema -- describe
npm run company:production-schema -- inspect --through 49
```

Expected: `installedThrough: 42`, pending `43…49`, a `planSha256`. From `describe.roles`, note
whether importer and auditor roles exist (today only `rent_ops_production_web` is expected). Any
other state: stop.

### 2. Freeze, back up and prove the backup

1. Freeze: pause Codex/Claude/MCP writes; announce the window.
2. Neon ▸ Branches ▸ New branch from `rent-ops-replacement-20260907`, current point in time,
   name `rops-pre-v49-20260923`.
3. `export RENT_OPS_BACKUP_DATABASE_URL='<owner URL: rops-pre-v49-20260923 / rent_ops_production>'`
   then `npm run company:production-schema -- compare-backup --backup-url-env RENT_OPS_BACKUP_DATABASE_URL`.
   Expect `matches: true`; keep `ledgerSha256`.

### 3. Rehearse

Branch `rops-v49-rehearsal-20260923` from the backup, point `RENT_OPS_MIGRATION_DATABASE_URL` at
it, and run step 4 in full including `grants-verify` and the relocation plan/apply against it
(the S3 objects are shared and content-addressed, so this is safe). Optionally point the staging
web at it for a smoke test. Delete it afterwards.

### 4. Apply 043–049 and runtime grants

```sh
export RENT_OPS_MIGRATION_DATABASE_URL='<owner URL: live branch>'
npm run company:production-schema -- inspect --through 49          # copy planSha256
npm run company:production-schema -- apply --through 49 --confirm <planSha256> --apply-reviewed
ROLES="--runtime-role rent_ops_production_web"                     # add --importer-role/--auditor-role only if both exist
ATTEST="--backup neon:rops-pre-v49-20260923 --review <reviewer-ref> --authorization michael-20260923-cutover"
npm run company:production-schema -- grants-plan  $ROLES $ATTEST   # review SQL (runtimeOnly: true), copy grantSha256
npm run company:production-schema -- grants-apply $ROLES $ATTEST --confirm <grantSha256> --apply-reviewed
npm run company:production-schema -- grants-verify $ROLES $ATTEST  # verified: true
```

The runtime-only plan manages `rent_ops_production_web` and PUBLIC revocations and leaves every
other role untouched.

### 5. Relocate documents

`document-relocation.md` steps 4–6: re-run the copy once (catches uploads made before the
freeze), `plan` (expect `missingCount: 0`), then `apply --rehash` with the reviewed digest.

### 6. Render

1. Create `production` at the reviewed tip of this branch and protect it (PRs + the
   `Verify and build` check). Render follows `production` only.
2. Apply the Blueprint `render.yaml` (Hobby workspace). The external groups must already hold:
   - `5central-ops-production`: `RENT_OPS_RUNTIME_DATABASE_URL`, `QBO_ENVIRONMENT=production`,
     production `QBO_CLIENT_ID`/`QBO_CLIENT_SECRET`,
     `QBO_REDIRECT_URI=https://5central.capital/api/accounting/qbo/callback`,
     `QBO_TOKEN_ENCRYPTION_KEY` (if the Replit app already has one, reuse it; otherwise generate
     once with `echo "base64:$(openssl rand -base64 32)"` and store it in the password manager).
   - `5central-ops-production-web`: per `docs/RENDER_DEPLOYMENT.md`, with `SESSION_SECRET` and
     `RENT_OPS_SESSION_SECRET` copied from Replit.
3. In a Render web shell: `npm run company:qbo-preflight -- --network --database` (no failures),
   then the document readback (`document-relocation.md` step 7).
4. On the `onrender.com` URL: `/readyz` 200; the worker log shows jobs being claimed and completed.
5. DNS: add `5central.capital` and `www.5central.capital` as custom domains, point the records as
   Render instructs (leave MX and other mail records alone), wait for the certificate. Stop — do
   not delete — the Replit deployment; keep it, its bucket and secrets 30 days.

### 7. Verify on `https://5central.capital`

Public site; manager sign-in at `/ops`; dashboard and top navigation; report setup and a run;
Forecasting; Projects; Investors; legal pages (`/legal/eula`, `/legal/privacy`,
`/quickbooks/disconnected`); a historical lease download and a tenant lease file; MCP sign-in from
Codex and Claude Code; Accounting ▸ Overview showing the **Production** badge. Mac app: launch and
confirm it opens the same manager.

### 8. Connect each LLC to QuickBooks production (read-only)

1. **First**, tell the Intuit case contact (case 00228254) that change-data-capture and webhooks
   are being enabled — the questionnaire answered "No" to both, and the worker starts hourly CDC
   as soon as a company is connected.
2. Capital, then Lucia, then Arcadia — one per session, signed in as that company's QuickBooks
   admin: Accounting ▸ Connect QuickBooks; compare CompanyInfo with the legal entity before
   confirming the binding (a realm cannot be rebound); run the read probe and a sync; reconcile one
   closed month against QuickBooks' P&L and trial balance. Unsupported objects appear as sync
   exceptions, never as zero.

### 9. Webhooks

1. Intuit portal ▸ Production ▸ Webhooks: CloudEvents format, endpoint
   `https://5central.capital/api/integrations/quickbooks/webhook/production`, entities Account,
   Bill, BillPayment, Customer, Deposit, Employee, Purchase, Vendor.
2. Put the verifier token in `QBO_WEBHOOK_VERIFIER_TOKEN_PRODUCTION` (web group) and redeploy.
3. Edit a vendor memo in QuickBooks; confirm a row in `accounting_qbo_webhook_events` and a
   completed fetch job. Hourly CDC is the backstop.

## Rollback

- Before step 4: nothing changed; unfreeze.
- After step 4, before DNS: nothing user-facing changed. The Replit build runs on the additive
  schema and still reads documents through the original binding columns.
- After DNS: point DNS back to Replit (its deployment was stopped, not deleted). Relocation rows
  stay; they do not affect the Replit build.
- Data restore only for proven corruption, from `rops-pre-v49-20260923`, accepting loss of later
  writes. Never drop the new tables or delete relocation rows as a shortcut.
