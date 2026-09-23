# Render cutover audit — September 23, 2026

Audit of the code on `claude/qbo-production-release` for the move from Replit to Render (web +
worker), S3 documents and direct Gmail, with QuickBooks switching from sandbox to production on the
same deploy. Account setup (Render, AWS, Google) is in the separate Codex handoff; this document is
the code-side state and the remaining steps. Operator steps are in
`production-release-2026-09-23.md`.

## Verdict

The code is ready for a Render cutover once the items under **Must happen before DNS moves** are
done. Nothing in the code requires Replit: Replit-only backends stay behind explicit configuration
(`replit-managed-gcs`, `replit-gmail`, `RENT_OPS_HOST_DATABASE_URL`) and are unused by the Render
Blueprint. The largest remaining risk is the first contact with real AWS S3 (the SigV4 client has
only been exercised against fakes) — verify it on staging before DNS moves.

Verification on this branch (Linux, Node 22, PGlite): typecheck clean; registry 48/48 valid;
`npm run test:all` 1,829 tests, 1,823 passed, 0 failed, 6 opt-in skipped (before the final four
commits; re-run results are in the handoff message); performance tests 16/16; production build
produces `dist/index.js`, `dist/worker.js` and the rendered migrations.

## What changed in code for Render

| Area | State | Evidence |
|---|---|---|
| Blueprint | Rewritten: web + worker, `plan: starter`, `region: virginia`, `branch: production`, `autoDeployTrigger: checksPass`, `buildCommand: npm ci && npm run build` (tests run in CI), web `healthCheckPath: /readyz`, `maxShutdownDelaySeconds: 30`, shared group with `NODE_VERSION=22` and both write switches `off`, QBO values declared on **both** services, secrets `sync: false`, no `generateValue` (copy existing session secrets). | `render.yaml`, `server/render-deployment.test.ts` |
| CI gate | `.github/workflows/ci.yml` on PRs/pushes to `production` and `main`: `npm ci`, typecheck, registry verify, full suite, performance, build (Node 22). | `.github/workflows/ci.yml` |
| Node version | Render's default is now Node 24; PDF intake was verified on 22. Pinned by `NODE_VERSION=22` and `engines.node ">=22 <23"`. | `render.yaml`, `package.json` |
| Graceful shutdown | Web: on SIGTERM mark not ready, stop accepting, drain up to `WEB_SHUTDOWN_GRACE_MS` (25 s), close pool. Worker already releases leased jobs on SIGTERM (`WORKER_SHUTDOWN_GRACE_MS`). | `server/graceful-shutdown.ts`, `server/worker.ts` |
| Port / proxy | Listens on `PORT` (10000) on `0.0.0.0`; `trust proxy` = 1 hop (Render's router); secure cookies behind TLS termination. | `server/index.ts` |
| Start commands | Web `npm start` (→ `scripts/deploy/start.mjs`, role `web`); worker `npm run worker`. | `package.json` |
| Schema | Never migrated by build, preDeploy or startup. `npm run company:production-schema` applies 043–048 with a reviewed digest, backup comparison and grant verification. | `server/company/operations/production-schema.ts` |
| Health | `/healthz` liveness; `/readyz` 503 until listening, and 503 again while draining. | `server/index.ts` |

## Environment matrix (names only)

**Shared group `5central-ops-shared` (non-secret):** `NODE_VERSION=22`, `QBO_WRITES_ENABLED=off`,
`QBO_PRODUCTION_WRITES=off`.

**Both services (secret, identical values):** `RENT_OPS_RUNTIME_DATABASE_URL`, `QBO_ENVIRONMENT`,
`QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REDIRECT_URI`, `QBO_TOKEN_ENCRYPTION_KEY`.

**Web only:** `NODE_ENV=production`, `PORT=10000`, `WEB_SHUTDOWN_GRACE_MS`, `DATABASE_URL`,
`SESSION_SECRET`, `RENT_OPS_SESSION_SECRET`, `RENT_OPS_ADMIN_EMAIL`,
`RENT_OPS_PUBLIC_APP_URL=https://5central.capital`, `RENT_OPS_ADMIN_OAUTH_ORIGIN=https://5central.capital`,
`RENT_OPS_ADMIN_OAUTH_CLIENT_ID`, `RENT_OPS_OAUTH_ADMIN_SUBJECTS`, `RENT_OPS_MAGIC_LINK_WEBHOOK_URL`,
`RENT_OPS_MAGIC_LINK_WEBHOOK_SECRET`, `RENT_OPS_MCP_ENABLED`, `RENT_OPS_MCP_RESOURCE`,
`RENT_OPS_MCP_MRA_CLIENT_IDS`, `RENT_OPS_OBJECT_STORE_BACKEND=private-versioned`,
`RENT_OPS_OBJECT_STORE_ENDPOINT`, `_REGION`, `_BUCKET`, `_PREFIX=rent-ops/private`,
`_ENCRYPTION=required`, `_VERSIONING=required`, `_RUNTIME_IDENTITY`, `_RUNTIME_TOKEN`,
`_UPLOAD_IDENTITY`, `_UPLOAD_TOKEN`, `RENT_OPS_PUBLIC_LIMITER_MODE=database`,
`RENT_OPS_INSTANCE_MODE=single`, `RENT_OPS_TENANT_EMAIL_PROVIDER=gmail`,
`RENT_OPS_TENANT_EMAIL_ENABLED`, `RENT_OPS_GMAIL_CLIENT_ID`, `_CLIENT_SECRET`, `_REFRESH_TOKEN`,
`_FROM`, `RENT_OPS_EMAIL_ALLOWED_RECIPIENTS`, `QBO_WEBHOOK_VERIFIER_TOKEN_PRODUCTION`,
`QBO_TIME_ENVIRONMENT`, `QBO_TIME_CLIENT_ID`, `QBO_TIME_CLIENT_SECRET`, `QBO_TIME_REDIRECT_URI`,
`QBO_TIME_TOKEN_ENCRYPTION_KEY`, optional `PLAID_*`, `RAMP_*`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`.

**Worker only:** `NODE_ENV=production`, `WORKER_SHUTDOWN_GRACE_MS` (optional `WORKER_POLL_MS`,
`WORKER_BATCH_SIZE`, `WORKER_MAX_IDLE_MS`, `WORKER_ID`).

**Never on web:** `RENT_OPS_DATABASE_URL` (importer), `RENT_OPS_OBJECT_STORE_IMPORTER_*`, legacy
`ADMIN_API_KEY`/`DASHBOARD_API_KEY`/`FIVECENTRAL_API_KEY`, `RM_*`. Startup refuses them.

`validateRentOpsProductionConfiguration` (`server/rent-ops/security/deployment-security.ts`) is
the executable checklist: startup fails closed with the exact blocking reason if a required value
is missing or unsafe. `DATABASE_URL` and `RENT_OPS_RUNTIME_DATABASE_URL` must differ.

## Must happen before DNS moves

1. **Migrations 043–048 and grants** on the live Neon branch, after a backup branch and a
   rehearsal (runbook steps 1–4). The currently deployed Replit build runs on the upgraded schema.
2. **Real S3 verification on staging.** Startup probes privacy, versioning and the runtime/upload
   permission boundaries; they must pass against the real bucket. Specific AWS behaviors to confirm:
   path-style URLs on `https://s3.<region>.amazonaws.com`; `If-None-Match: *` conditional PUT on a
   versioned bucket (AWS supports it since 2024); `x-amz-version-id` on HEAD/GET/PUT; 403 (not 404)
   for denied List/Delete; the pre-provisioned canary object
   `rent-ops/private/sha256/000…000` (64 zeros). IAM actions: runtime `s3:GetObject`,
   `s3:GetObjectVersion`, `s3:GetBucketVersioning`; upload additionally `s3:PutObject`; nobody
   `s3:ListBucket`/`s3:DeleteObject*` on the prefix. See `docs/RENDER_DEPLOYMENT.md` §4.
3. **Documents.** Count `rent_ops_document_objects` rows (and `company_documents` rows, which migration 044 creates) by
   `backend`. If any are `replit-managed-gcs`, they need the audited rebinding described in the
   hosting handoff §5.3 before the Replit bucket is retired; the Render web process cannot read the
   Replit bucket. If there are none, switching backends is trivial.
4. **Gmail send test** to an allowlisted address from staging.
5. **Session secrets copied** from Replit (`SESSION_SECRET`, `RENT_OPS_SESSION_SECRET`) so current
   sessions and limiter keys survive; otherwise note the forced sign-out.
6. **`production` branch + protection**: create it at the reviewed tip, require PRs and the
   `CI / verify` check. With `checksPass`, Render deploys only green commits.
7. **Auth0**: callback `https://5central.capital/api/rent-ops/auth/oauth/callback` listed (it
   already works on the Replit custom domain). Staging on `*.onrender.com` cannot use admin sign-in
   because `RENT_OPS_ADMIN_OAUTH_ORIGIN` only accepts the two approved origins; test sign-in after
   DNS.
8. **Intuit portal**: nothing changes host-wise (redirect, EULA, privacy, launch, disconnect and
   reconnect URLs all stay on `5central.capital`). Confirm the Reconnect URL is set (mandatory
   since Feb 2026).

## After DNS

- Connect Capital, Lucia and Arcadia to QuickBooks production, one at a time (runbook step 7).
- Webhooks (runbook step 8) — tell Intuit first.
- Stop, but do not delete, the Replit deployment; keep its bucket and secrets 30 days.
- Cleanup PR (separate): remove `.replit`, `replit.md` references, `@replit/object-storage`,
  `@replit/connectors-sdk`, the unused Replit vite plugins, `replit-managed-gcs`, `replit-gmail` and
  the Replit origin constants (`ADMIN_OAUTH_ORIGIN` still defaults to `5-central-new.replit.app`
  when `RENT_OPS_ADMIN_OAUTH_ORIGIN` is unset).

## Open decisions and known gaps

- **MCP resource identifier.** `RENT_OPS_MCP_RESOURCE` (the Auth0 audience) is still
  `https://5-central-new.replit.app/mcp`, and the protected-resource metadata advertises it even on
  `5central.capital`. It keeps working after Replit is gone because it is only an identifier, but
  MCP clients that enforce RFC 9728 resource matching may object. Recommended: keep it for the
  cutover; move to `https://5central.capital/mcp` as its own step (new Auth0 API, clients re-auth).
- **Worker concurrency** is one instance (`numInstances: 1`); the job queue uses `SKIP LOCKED`
  leases, so a second instance would be safe, but QuickBooks allows ~10 concurrent requests per
  company and the current batch size (4) keeps well under it.
- **Render plan naming.** Render renamed plans on 2026-08-26 (`starter` = `0.5c-512mb`); legacy
  names remain valid. The web build (Vite + esbuild) fits in 512 MB in local runs; raise to
  `standard` if the Render build runs out of memory.
- **Mac app.** It targets `https://5central.capital/ops`, so it follows the DNS move without a
  rebuild. A rebuild is needed once to pick up the new name and Go menu
  (`desktop/Build 5Central Ops for Mac.command`); the old `R-ops.app` can then be deleted.
