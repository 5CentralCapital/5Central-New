# Render hosting and switch runbook

## Current deployment design

This checkout contains two Render Blueprints:

- `render.staging.yaml`: staging web and background worker, sourced from branch
  `hosting/render`, attached to the `5central-ops-staging` environment group.
- `render.yaml`: production web and worker, intentionally pinned to the future
  `production` branch and attached to `5central-ops-production`. Do not create
  that branch or sync this Blueprint until the production cutover review approves
  it. Production must not deploy from `main`.

Each environment uses one paid Starter web service and one paid Starter worker,
with one instance apiece. Both run in Render's Virginia region because the
verified active Rent Ops runtime and host databases are in Neon us-east-1
(Virginia). S3 remains in us-west-2 (Oregon), so object requests cross regions.
The service health check is `/readyz`; the web and worker each build with
`npm ci && npm run build`. Render's `checksPass` auto-deploy trigger waits for
the configured GitHub checks.

Render lists Starter at $7 per service per month (0.5 CPU and 512 MB RAM), so
the two services cost $14/month for one environment and $28/month for both
staging and production. To stay within the approved $40/month Render budget,
the workspace must remain on Hobby ($0/month): fixed Render total is then
$28/month. If Billing shows Pro ($25/month), fixed total becomes $53/month
before usage and exceeds the approved cap; stop before applying the services
and obtain a new budget decision rather than changing the workspace plan.
Existing Neon plan/compute/storage, S3 storage/requests/transfer, Render
bandwidth/build overages, and cross-region transfer are usage-dependent and not
included in the $28 compute subtotal. Keep an eye on billing because those
variable charges can also exceed the remaining $12. No Render database is
provisioned by either Blueprint. See [Render pricing](https://render.com/pricing)
and [workspace plan details](https://render.com/docs/new-workspace-plans).

The staging Blueprint can be applied once its external environment group and
isolated staging database branch are ready. Production still needs the reviewed
production branch, production group, database/storage/email credentials, domain
cutover, and the data/document migration gates below. The code change does not
create or deploy either service.

## Render setup

Create the external environment groups in the Render Dashboard before applying
a Blueprint. The group names must match exactly:

- `5central-ops-staging`
- `5central-ops-production`
- `5central-ops-staging-web`
- `5central-ops-production-web`

Both web and worker reference the shared environment group for their
environment. The web service also references its web-only group; the worker
never receives those values. Keep the groups external and pre-created:
Render's Blueprint environment-variable-group declarations do not support
`sync: false` secrets. Do not add an `envVarGroups` block to these files. Enter
secrets only in Render's Dashboard; never commit their values, print them in
logs, or copy them into a ticket. Render supports attaching multiple external
groups to a service; avoid duplicate variable names across groups
([environment-variable docs](https://render.com/docs/configure-environment-variables)).

Create the staging Blueprint using the GitHub repository, branch
`hosting/render`, and custom Blueprint path `render.staging.yaml`. It creates
`5central-ops-staging-web` and `5central-ops-staging-worker`. Production uses
`render.yaml` only after the explicit cutover approval and creation of the
`production` branch. Keep the service names distinct as declared.

Both manifests pin `NODE_VERSION=22`, `NODE_ENV=production`, and
`RENT_OPS_INSTANCE_MODE=single`. The web service uses `npm start`, listens on
Render's assigned `PORT`, and is checked at `/readyz`. The worker uses
`npm run worker`, has no web health check, and receives the same QBO/runtime
environment group. Both explicitly set `QBO_WRITES_ENABLED=off` and
`QBO_PRODUCTION_WRITES=off`. Do not enable writes as part of hosting setup.

## Environment values

### Shared environment groups

Enter these values in each environment's shared Dashboard group. This group is
available to that environment's web and worker services:

- `RENT_OPS_RUNTIME_DATABASE_URL`: dedicated Rent Ops runtime-role connection
  URL for that environment only.
- `QBO_ENVIRONMENT`: `sandbox` for staging and `production` for production.
- `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REDIRECT_URI`, and
  `QBO_TOKEN_ENCRYPTION_KEY`: the matching Intuit app and environment values.

The staging runtime URL must point only to the isolated staging Neon branch and
its runtime role. The production runtime URL is verified as the Virginia Neon
branch `long-wave-42463880` / `br-flat-scene-ahvx8421`, database
`rent_ops_production`, role `rent_ops_production_web`. Do not use the
Replit-provided Oregon `DATABASE_URL`; production explicitly supplies the
dedicated `RENT_OPS_RUNTIME_DATABASE_URL`.

The shared group also holds the QuickBooks OAuth values for that environment.
QBO configuration is needed for the connection flow; posting remains disabled
because the Blueprint sets both QBO write flags directly on web and worker.

### Web-service values

Set the following values in the corresponding web-only group. Do not duplicate
them in the shared group or as service-level variables.

Production web:

- `RENT_OPS_HOST_DATABASE_URL`: the verified Virginia Neon host connection,
  database `neondb`, role `rent_ops_host_web`. This is a separate host-app
  connection from `RENT_OPS_RUNTIME_DATABASE_URL`, even though both resolve
  to the same Neon host/branch. Keep the two roles and database names distinct.
- `SESSION_SECRET` and `RENT_OPS_SESSION_SECRET`: enter the current Replit
  values to preserve existing sessions; do not rotate these during the switch.
- `RENT_OPS_ADMIN_EMAIL`, `RENT_OPS_ADMIN_OAUTH_CLIENT_ID`, and
  `RENT_OPS_OAUTH_ADMIN_SUBJECTS`: configure the already-approved admin
  identity and OAuth client.
- `RENT_OPS_PUBLIC_APP_URL`: the final HTTPS app origin used by the UI.
- `QBO_WEBHOOK_VERIFIER_TOKEN_PRODUCTION`: production webhook verification
  secret.
- `RENT_OPS_OBJECT_STORE_RUNTIME_IDENTITY`,
  `RENT_OPS_OBJECT_STORE_RUNTIME_TOKEN`,
  `RENT_OPS_OBJECT_STORE_UPLOAD_IDENTITY`, and
  `RENT_OPS_OBJECT_STORE_UPLOAD_TOKEN`: separate, narrowly scoped S3
  credentials for runtime reads and applicant uploads.
- `RENT_OPS_EMAIL_ALLOWED_RECIPIENTS`, `RENT_OPS_GMAIL_FROM`,
  `RENT_OPS_GMAIL_CLIENT_ID`, `RENT_OPS_GMAIL_CLIENT_SECRET`, and
  `RENT_OPS_GMAIL_REFRESH_TOKEN`: Gmail delivery allowlist, sender, and OAuth
  credentials.
- `RENT_OPS_MCP_MRA_CLIENT_IDS`: only the reviewed Codex OAuth client IDs
  allowed to use MRA ingestion tools.

`RENT_OPS_MCP_MRA_CLIENT_IDS` is optional and stays empty unless the specific
Codex client IDs have been reviewed for MRA mutation access.

The Blueprint sets `RENT_OPS_ADMIN_OAUTH_ORIGIN=https://5central.capital`,
which is one of the two canonical origins accepted by the current app. The
other accepted origin is the existing Replit origin. Register the branded
callback `https://5central.capital/api/rent-ops/auth/oauth/callback` with the
OAuth provider when that domain is attached. The app currently rejects other
origins, including Render's `onrender.com` hostnames. A staging login therefore
requires a separately reviewed narrow app change to permit its final canonical
staging origin; do not claim staging OAuth works on the Render hostname.

The staging web-only group has the staging host database URL, admin email,
public URL, `QBO_WEBHOOK_VERIFIER_TOKEN_SANDBOX`, plus separate staging-bucket
runtime/upload identities and tokens. Render generates separate staging
session secrets. Staging email is disabled; `mail-disabled.invalid` is a guard
value only and must never deliver mail.

The manifests pin the store profile to
`private-versioned`, endpoint `https://s3.us-west-2.amazonaws.com`, region
`us-west-2`, prefix `rent-ops/private`, required encryption/versioning, and
distinct production/staging buckets:

- `fivecentral-ops-production-651532007693`
- `fivecentral-ops-staging-651532007693`

The buckets are private, versioned, SSE-S3, and TLS-only. Scoped runtime and
upload IAM accounts are still being created. Do not start a service until its
credentials pass the probes below. The startup canary is the non-empty object
at `<prefix>/sha256/0000000000000000000000000000000000000000000000000000000000000000`;
create and retain its immutable object version before startup.

For each bucket, the runtime identity may Head/Get only (including exact-version
reads); applicant-upload may Put/Head/Get. Both must be denied List and Delete;
runtime Put must be denied. Scope object permissions to the configured prefix
and explicitly deny List/Delete. Startup also verifies bucket privacy,
versioning, and the pre-provisioned canary. A denied probe is proven only by an
HTTP 403; other errors do not demonstrate the boundary. The restricted importer
identity is separate and never enters either web or worker environment.

The production web enables Gmail delivery using `gmail`. The Google project
`fivecentral-ops` has internal Gmail enabled and only the `gmail.send` scope
approved; Google sender OAuth client creation is still in progress. User entry
of the sender OAuth client ID, secret, and refresh token remains necessary.
Keep staging delivery disabled. No Google secret values are present in this
repository.

## Database, migration, and document cutover

The verified active production database is the Virginia Neon project
`long-wave-42463880`, branch `br-flat-scene-ahvx8421`. Replit's built-in
Oregon `DATABASE_URL` is overridden in the live application. The production
host override is the `neondb` host-role URL; the runtime group URL is the
separate `rent_ops_production` runtime-role URL. Never set the host and runtime
variables to the same connection string.

The live read-only inventory is schema registry v42 (42 registered rows) and
1,509 Rent Ops document objects still on Replit-managed GCS. Company migration
44 is not applied; among `company%document%` tables, only
`company_investor_contract_documents` currently exists. Full document
rebinding and verification to the private S3 buckets is mandatory before
production cutover. This Render configuration does not move those objects or
apply database migrations. The document-move plan and migration review are
separate release gates; retain source object identity, checksums, bindings, and
independent reconciliation evidence.

The isolated staging Neon branch must be created and verified before setting
staging `RENT_OPS_RUNTIME_DATABASE_URL` and the staging web
`RENT_OPS_HOST_DATABASE_URL`. Staging host/runtime roles and their schema
must remain isolated from production. Application startup never runs migrations.
An operator uses the reviewed migration artifact and restricted
`RENT_OPS_DATABASE_URL` outside both hosted services. Verify the frozen
migration registry/checksum, required reviewed migrations, role ownership and
grants, backup attestation, and independent audit before the production switch.
Never put migration commands in `buildCommand`, `startCommand`, or health
checks. Neither `RENT_OPS_DATABASE_URL` nor
`RENT_OPS_OBJECT_STORE_IMPORTER_TOKEN` belongs in a web/worker environment.

## Checks and release sequence

1. Run the GitHub Actions CI workflow on `hosting/render`. It installs with
   `npm ci`, checks TypeScript, verifies the company migration registry, runs
   `npm run test:all` and performance tests, then builds web and worker
   artifacts. The Render `checksPass` trigger prevents deploy until checks pass.
2. Before staging apply, confirm the external staging group, isolated Neon
   branch/roles/schema, staging S3 bucket and canary, and scoped staging IAM
   identities are ready. Set the web-only host URL and S3 values in Render.
   Keep QBO pointed to sandbox and both write flags off. Staging manager login
   remains blocked until a narrow origin allowlist change and OAuth callback
   review are complete.
3. After staging is running, verify Render logs contain no credentials, the
   startup database and object-store privilege probes pass, `/readyz` returns
   200, login/email/webhook safety is as intended, and worker polling/shutdown
   behavior is healthy. Exercise staging applicant upload and document reads
   against synthetic data; verify the exact bucket, prefix, version, and access
   boundary.
4. Before creating the `production` branch or syncing `render.yaml`, review
   and approve the production cutover. Complete the migration and 1,509-object
   GCS-to-S3 rebinding gates, production database migration/role probes,
   production S3 canary and least-privilege probes, Gmail OAuth setup and
   allowed-recipient policy, QBO production OAuth/webhook configuration with
   writes still off, admin sign-in, DNS/TLS, a tested rollback target, and an
   accountable owner for applicant-upload incidents.
5. Enter production secrets directly into Render and verify the production
   deployment against `/readyz` before switching the custom domain. Preserve
   the current Replit app, database, sessions, GCS objects, and DNS rollback
   path until independent post-cutover checks and document reconciliation pass.
   Enabling QBO writes, deleting old data, or disabling the Replit rollback
   path requires a separate explicit review after the read-only cutover.

The public-health endpoints return status only and do not expose database URLs,
credentials, tenant/applicant data, or payloads. Monitor readiness at
`/readyz`; do not use a health check as a migration mechanism.

The Blueprint intentionally omits `ADMIN_API_KEY`, `DASHBOARD_API_KEY`, and
`FIVECENTRAL_API_KEY`; production startup rejects these legacy keys. It also
omits `RM_API_BASE`, `RM_API_TOKEN`, `RM_USERNAME`, `RM_PASSWORD`,
`RM_LOCATION_ID`, and `RENT_MANAGER_CLIENT_PATH`. Rent Manager remains an
offline, restricted migration/import source; none of its credentials belong in
a public web or worker environment.
