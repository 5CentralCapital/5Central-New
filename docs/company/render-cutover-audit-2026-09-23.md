# Render cutover audit — September 23, 2026

Code-side audit of `claude/qbo-production-release` for the move from Replit to Render (web +
worker, S3 documents, direct Gmail) with QuickBooks switching from sandbox to production. The
hosting configuration is Codex's `hosting/render` (`render.yaml`, `render.staging.yaml`,
`.github/workflows/ci.yml`, `docs/RENDER_DEPLOYMENT.md`); this branch is `hosting/render` plus the
audited rollout, the QuickBooks production work and the cutover tooling below. Operator steps:
`production-release-2026-09-23.md`. QuickBooks requirements: `qbo-production-compliance-2026-09-23.md`.

## Verdict

The code is ready for the cutover. Nothing in the code requires Replit once the documents are
relocated; Replit-only backends (`replit-managed-gcs`, `replit-gmail`, `RENT_OPS_HOST_DATABASE_URL`
override) are selected only by explicit configuration and the Render Blueprints do not select
them. What remains is operator and account work, listed under **Gates before DNS moves**. The
three items most likely to slip: the Gmail sender credentials (production web will not start
without them, see gate 5), the 1,509-document relocation (gate 3), and the first contact with real
S3 (gate 4).

## Hosting configuration (Codex, verified against the code)

| Area | State |
|---|---|
| Services | `5central-ops-web` (`npm start`, `/readyz`) and `5central-ops-worker` (`npm run worker`), Starter, one instance each, `region: virginia` next to Neon us-east-1. Staging twins `5central-ops-staging-web/-worker` from branch `hosting/render`. |
| Deploys | Production follows branch `production` only, `autoDeployTrigger: checksPass`. CI job `Verify and build` (Node 22): `npm ci`, `check`, `company:migrations:verify`, `test:all`, `test:performance`, `build`. No migration in build, start or health check. |
| Environment | External groups (pre-created, secrets entered in the dashboard): `5central-ops-production` (web + worker: runtime DB URL and all `QBO_*` including `QBO_TOKEN_ENCRYPTION_KEY`) and `5central-ops-production-web` (host DB URL, sessions, admin OAuth, public URL, webhook verifier, S3 runtime/upload identities, Gmail, MCP). Both services pin `NODE_VERSION=22`, `NODE_ENV=production`, `QBO_WRITES_ENABLED=off`, `QBO_PRODUCTION_WRITES=off`. |
| Database | Runtime `rent_ops_production` (role `rent_ops_production_web`) and host `neondb` (role `rent_ops_host_web`) on Neon `long-wave-42463880` / `br-flat-scene-ahvx8421`. Distinct URLs, as the startup gate requires. |
| Documents | `private-versioned` S3, `us-west-2`, buckets `fivecentral-ops-production-651532007693` / `-staging-…`, prefix `rent-ops/private`, SSE-S3, versioned, TLS-only. Startup probes privacy, versioning, the canary object and the runtime/upload permission boundary and refuses to start on any failure. |
| Email | Production `RENT_OPS_TENANT_EMAIL_PROVIDER=gmail`, enabled. Staging disabled (`mail-disabled.invalid` guard). |
| Budget | $28/month compute for both environments on the Hobby workspace; Pro would exceed the $40 cap. |

## What this branch adds on top of `hosting/render`

| Change | Why | Evidence |
|---|---|---|
| Audited rollout `73e5230` (migrations 043–048, jobs, intake, review cases, forecasting, QBO webhooks/CDC) | The release itself | `codex-release-audit-2026-09-23.md` |
| **Migration 049 + document relocation operator** | The 1,509 bindings pinned to Replit GCS generations are unreadable from Render. Append-only relocation rows, digest-bound apply, runtime-identity readback. | `document-relocation.md`, `server/rent-ops/storage/document-relocation.test.ts` |
| `npm run company:production-schema` | Reviewed migration apply (plan digest, one transaction, advisory lock, ledger readback), backup comparison, manifest-derived grants with live verification. **Runtime-only grant plans** because production has only the web runtime role. | `server/company/operations/production-schema.test.ts` |
| Staging manager sign-in | `RENT_OPS_ADMIN_OAUTH_ORIGIN=https://5central-ops-staging-web.onrender.com` accepted only inside that Render service with QBO not in production. | `server/admin-oauth.test.ts`, `render.staging.yaml` |
| Graceful web shutdown | Render sends SIGTERM on every deploy: readiness goes 503, the server drains up to 25 s (`WEB_SHUTDOWN_GRACE_MS`) and closes the pool. The worker already releases leased jobs. | `server/graceful-shutdown.test.ts` |
| `npm start` → `scripts/deploy/start.mjs` | One start command; `RENT_OPS_PROCESS_ROLE` (default `web`) can also start the worker. | `scripts/deploy/start.test.ts` |
| QBO production preflight | `npm run company:qbo-preflight -- --network --database` catches secret typos, a mismatched redirect URI, a bad encryption key and open sandbox connections. | `scripts/company/qbo-production-preflight.test.ts` |
| QBO fixes | List queries include inactive records; record-only Invoice guard (writes stay off). | `qbo-production-compliance-2026-09-23.md` items 14, 22 |
| Mac app | Loads `https://5central.capital/ops`; Go menu drift-tested against the web navigation. Follows the DNS move without a rebuild. | `docs/company/desktop-app.md` |

## Gates before DNS moves

1. **Backup, migrations 043–049 and runtime grants** on the live branch, rehearsed first on a
   copy (runbook steps 1–4). Do this inside the cutover window: the grants replace the runtime
   role's privileges with the new build's manifest.
2. **`production` branch** at the reviewed tip, protected (PRs + the `Verify and build` check).
3. **Document relocation** (`document-relocation.md`): copy from inside the Replit workspace
   (can start now; it only reads the database), then plan/apply after migration 049 and read back
   on Render. The Replit bucket stays untouched for 30 days.
4. **Real S3 on staging.** The SigV4 client has only met fakes. Startup must pass against the real
   staging bucket: path-style URLs on `https://s3.us-west-2.amazonaws.com`; `If-None-Match: *`
   PUT on a versioned bucket (412 when present); `x-amz-version-id` on HEAD/GET/PUT; HTTP 403 (not
   404) for denied List/Delete; the canary `rent-ops/private/sha256/000…000` (64 zeros) created
   with a retained version. Then an applicant upload and a document download.
5. **Gmail sender credentials.** With `gmail` enabled in the Blueprint, production startup refuses
   to run until `RENT_OPS_GMAIL_CLIENT_ID`, `_CLIENT_SECRET`, `_REFRESH_TOKEN`, `_FROM` and
   `RENT_OPS_EMAIL_ALLOWED_RECIPIENTS` are set (`validateRentOpsProductionConfiguration`). Google
   client creation was still in progress. If it cannot finish before the window, the only other
   option is a reviewed Blueprint change to the staging-style disabled email, which stops tenant
   magic-link sign-in and notices.
6. **Session secrets** copied from Replit into `5central-ops-production-web` so sessions and
   limiter keys survive (`RENT_OPS_SESSION_SECRET` must be ≥ 32 characters for the database
   limiter).
7. **Auth0**: `https://5central.capital/api/rent-ops/auth/oauth/callback` (already used on the
   Replit custom domain) and, for staging, the `onrender.com` staging callback.
8. **QuickBooks**: the same `QBO_TOKEN_ENCRYPTION_KEY` everywhere (a new key makes stored tokens
   unreadable); run the preflight in a Render shell. Intuit URLs (redirect, EULA, privacy, launch,
   disconnect, reconnect) stay on `5central.capital`, so nothing changes in the portal for the
   host move.

## After DNS

- Connect Capital, Lucia and Arcadia to QuickBooks production one at a time; reconcile a closed
  month before the next (runbook step 7). Tell the Intuit case contact before connecting, since
  hourly change-data-capture starts with the first connection.
- Webhooks after that notice (runbook step 8).
- Stop, but do not delete, the Replit deployment; keep its bucket and secrets 30 days.
- Separate cleanup PR later: `.replit`, `replit.md`, `@replit/object-storage`,
  `@replit/connectors-sdk`, the unused Replit Vite plugins, `replit-managed-gcs`, `replit-gmail`,
  and the Replit origin constants (the manager sign-in origin still defaults to
  `5-central-new.replit.app` when `RENT_OPS_ADMIN_OAUTH_ORIGIN` is unset).

## Open decisions and known gaps

- **MCP resource identifier.** `RENT_OPS_MCP_RESOURCE` (the Auth0 audience) is still
  `https://5-central-new.replit.app/mcp` and is advertised in protected-resource metadata on
  `5central.capital`. It is only an identifier, so it keeps working after Replit, but clients that
  enforce RFC 9728 resource matching may object. Keep it for the cutover; move to
  `https://5central.capital/mcp` as its own step (new Auth0 API, clients re-authorize).
- **S3 region.** Buckets are in us-west-2 and services in Virginia: each document read crosses
  regions (latency and transfer cost). Acceptable at current volume.
- **Worker scale.** One instance; the queue uses `SKIP LOCKED` leases, so a second would be safe,
  but QuickBooks allows ~10 concurrent requests per company and batch size 4 stays well under it.
- **Receivables mirror** (QuickBooks as the tenant-ledger source) is on
  `claude/qbo-financial-source` as migration 050 and is not part of this cutover.
