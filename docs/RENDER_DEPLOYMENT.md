# Rent Ops Render deployment

`render.yaml` is a fail-closed Blueprint for the single-user Rent Ops web
service. It deliberately defaults to Render's `free` plan with one instance:
that is suitable for review, synthetic data, and pre-public staging only. A
human operator must record an explicit paid-plan decision before public
applicant go-live. The shared database limiter and
`RENT_OPS_INSTANCE_MODE=single` contract must be revisited before enabling
multiple instances.

## Dashboard setup

1. In Render Dashboard, create a Blueprint from
   `https://github.com/5CentralCapital/5Central-New.git` and select the
   `render.yaml` file on the reviewed branch. Review the generated service
   name, free-plan setting, single-instance setting, build command, start
   command, and `/healthz` health check before applying it.
2. Fill every `sync: false` value in the Blueprint. Render generates
   `SESSION_SECRET` and `RENT_OPS_SESSION_SECRET`; do not paste those values
   into the repository or a ticket. Set `RENT_OPS_ADMIN_EMAIL` to the one
   operator account used for Rent Ops administration. Set the magic-link
   webhook URL, webhook secret, and public app URL for the reviewed applicant
   delivery path. Plaid and Ramp values are optional host-dashboard
   integrations; if enabled, fill their `sync: false` values from the
   provider Dashboard without recording the values in source control.
3. Provision the host database URL as `DATABASE_URL`. Provision separate
   Rent Ops runtime and importer database roles and place their URLs in
   `RENT_OPS_RUNTIME_DATABASE_URL` and `RENT_OPS_DATABASE_URL`. The runtime
   role is application-only; the importer role is restricted and is not used
   by the web process. Provision the host `user_sessions` table as part of the
   reviewed host schema. Never point either URL at the other role or at the
   host application's shared role.
4. Configure a private, encrypted, versioned S3-compatible bucket and the
   three identities named in the Blueprint. Set the endpoint, region, bucket,
   prefix, and each identity/token pair from the provider Dashboard. The
   runtime identity may Head/Get only (Put/List/Delete denied); the
   applicant-upload identity may Put/Head/Get; the importer identity may
   Put/Head/Get. None may List or Delete. Keep the bucket private and prevent
   provider public ACLs and redirect/follow behavior. The server uses a
   built-in HTTPS SigV4 adapter; it starts only after the provider probe sees
   the pre-provisioned `sha256:` startup canary, enabled versioning, private
   access, and every permitted/forbidden operation. No provider SDK calls are
   made by tests or deployment review.

   The probe canary's exact key is
   `<RENT_OPS_OBJECT_STORE_PREFIX>/sha256/` followed by 64 zeroes (for the
   Blueprint default: `rent-ops/private/sha256/0000000000000000000000000000000000000000000000000000000000000000`).
   Provision that non-empty object before startup and retain its immutable
   version. The provider must support path-style HTTPS requests, return a
   non-null `x-amz-version-id` for every HEAD/GET/PUT response, deny List and
   Delete for all three identities, and deny Put for the runtime identity;
   a provider that cannot attest those exact boundaries is rejected. On AWS
   S3, Head/Get use `s3:GetObject`, exact-version reads additionally require
   `s3:GetObjectVersion`, and the runtime startup probe requires the read-only
   bucket permission `s3:GetBucketVersioning`. Grant object permissions only
   within the configured prefix and keep List/Delete explicitly denied.
   A denied operation must return 403; other failures do not prove denial.
5. The Blueprint selects `RENT_OPS_PUBLIC_LIMITER_MODE=database`. Apply
   migration 013 and its runtime-role grants before startup. Shared PostgreSQL
   counters use the database clock and atomic updates; no Cloudflare account
   or external edge service is required. Keep Express's trusted-proxy setting
   restricted to the reviewed Render proxy topology. The limiter uses `req.ip`
   and stores only HMAC address keys derived from `RENT_OPS_SESSION_SECRET`.
   Rotating that secret resets client buckets. Global and route limits gate
   client-row creation, and each request removes at most 64 expired rows.
   Unknown public routes/methods return 404, limits return 429 with
   `Retry-After`, and database failures return 503 with `Retry-After: 30`.
   Verify these behaviors before enabling public traffic.

   Existing edge deployments can instead select
   `RENT_OPS_PUBLIC_LIMITER_MODE=edge-attestation` and configure
   `RENT_OPS_EDGE_ATTESTATION_SECRET`. The reviewed edge limiter must discard
   incoming `x-rent-ops-edge-attestation`, enforce a shared rate limit, then
   sign the upstream request with HMAC-SHA256. The header format is
   `<unix-seconds>.<lowercase-hex-signature>` over
   `<unix-seconds>:<UPPERCASE-METHOD>:<router-relative-path>`, with a 90-second
   freshness window. For `/api/rent-ops/public/applications/start`, sign
   `/applications/start`; exclude the query string. Keep the secret in the
   edge and Render secret stores. Verify direct-origin requests without a
   valid attestation receive 403. Never use a per-process in-memory fallback.
6. Attach HTTPS and the reviewed custom domain. Configure the external
   monitor against `/healthz` and use `/readyz` for rollout/readiness checks.
   Both endpoints return status only and never expose secrets, database URLs,
   object-store credentials, or applicant/tenant data.

The provider adapter spools each request to a private `O_NOFOLLOW`, mode-0600
transient file before hashing and streaming it to the provider. Upload
admission is bounded and rejects saturation with a retryable response; it does
not queue 50 MiB bodies or create a document/database binding on saturation.
The transient spool is not an object-store backend and must never be used for
durable document storage.

## Migration and release gates

Application startup never runs migrations. An operator runs the reviewed Rent
Ops migration artifact out-of-band with the restricted importer/migration
credential, verifies the schema checksum, backup attestation, independent
audit, role ownership/`NOINHERIT`, and object-store privilege probes, then
starts the Blueprint service. Do not put a migration command in
`startCommand` or add a migration step to a health check.

Before switching a public applicant domain to this service, the operator must
record:

- the explicit paid-plan decision (plan, expected traffic, and rollback owner);
- the exact Dashboard secret names set, without recording their values;
- successful permitted and forbidden database/object-store startup probes;
- verified selected shared limiter behavior and saturation behavior;
- successful `/healthz` and `/readyz` checks after the reviewed migration;
- a rollback target and an owner for applicant-upload incidents.

This repository does not apply a Blueprint, call Render, or handle Dashboard
secrets. Those are operator actions after review.

The Blueprint intentionally does not declare `ADMIN_API_KEY`,
`DASHBOARD_API_KEY`, or `FIVECENTRAL_API_KEY`: production startup rejects any
of those legacy keys, and Rent Ops never accepts them. It also does not
declare `RM_API_BASE`, `RM_API_TOKEN`, `RM_USERNAME`, `RM_PASSWORD`,
`RM_LOCATION_ID`, or `RENT_MANAGER_CLIENT_PATH`. Rent Manager is an offline,
restricted migration/import source; its credentials and client path must not
enter the public web service environment.
