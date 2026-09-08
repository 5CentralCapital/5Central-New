# Rent Operations

Rent Operations is the bounded replacement for the small part of Rent Manager used by 5Central: property/unit records, people and tenant profiles, lease terms, recurring charges, append-only tenant ledger, deposits, housing assistance, applications, documents/activity, fixed reports, and a read-only RM import boundary. It includes tenant password accounts, Stripe-hosted payment checkout, verified payment-event reconciliation, and recurring-charge preview/post controls. It does not implement general ledger, AP, work orders, screening, e-signature, or multi-admin permissions.

## Domain conventions

- Money is an integer number of cents in domain objects and API payloads. PostgreSQL is only the persistence boundary.
- Base rent, recurring fees, deposits, unapplied cash, and subsidy/HAP are distinct categories. HAP agency obligation and tenant obligation never collapse into one amount.
- Physical occupancy uses tenancy status and actual move-in/move-out dates. Lease expiration uses contractual term dates. A future/preleased unit, a genuine vacancy, not-ready inventory, and off-market inventory remain distinct.
- Recurring charges are effective-dated. Overlapping active base-rent schedules fail validation.
- Ledger entries are append-only. Corrections use a linked reversal; payments are connected to charges through explicit allocations.
- Tenant profiles retain the current summary tenancy and the complete person-linked tenancy, lease, schedule, ledger, deposit/HAP, document, and activity history.
- Operational calendar dates use the `America/New_York` business day; immutable timestamps remain UTC.
- Application decisions are manual. There is no score, ranking, screening, automatic approval/decline, SSN, bank-account collection, application-fee checkout, or electronic signature in the application workflow. Tenant payments use Stripe-hosted fields.

## Routes

The module is mounted at `/api/rent-ops` by `server/routes.ts`.

- Admin session required: `/snapshot`, `/dashboard`, `/reports/:report`, `/tenants/:personId`, `/properties`, `/units`, `/people`, `/tenancies`, `/lease-terms`, `/recurring-schedules`, `/ledger/*`, `/deposits`, `/subsidies`, `/applications/*`, `/documents`, and `/activity`.
- Public and rate-limited: `/public/application-options`, `/public/applications/start`, and bearer-token-scoped `/public/applications/resume` save/household/document/certify/submit routes.
- Tenant account grants: `/api/rent-ops/tenant-accounts` and `/:id/reissue` / `/:id/revoke` require the admin session and CSRF. Creating a link does not send it. `/:id/send-link` explicitly requests invitation/reset delivery and reports provider acceptance.
- Recurring billing: `/api/rent-ops/billing/preview` and `/post` require admin access; posting binds to a reviewed preview token.
- Tenant sessions: `/api/tenant/auth/login`, `/activate`, `/session`, `/password`, `/logout`, `/recovery`, and `/api/tenant/home`; `/api/tenant/lease-files/:id/download` serves only an exactly owned verified lease PDF. Tenant identity is separate from administrator/investor identity.
- Payments: `/api/tenant/payments` and `/checkout` require tenant access; `/api/tenant/payments/webhook` verifies the raw Stripe signature before JSON parsing. Missing Stripe connection disables checkout.
- UI: `/tenant` is the tenant account portal. `/ops` is admin-only. `/apply` and `/apply/:propertySlug` are public. Applicant HTML and public APIs send `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.

API response bodies are never logged. Magic links carry the token in a URL fragment, the applicant page erases it before making a request, and resume APIs receive it only in the `Authorization` header.

## Magic-link delivery

Production start is disabled unless all three variables are present:

- `RENT_OPS_MAGIC_LINK_WEBHOOK_URL` — HTTPS provider webhook.
- `RENT_OPS_MAGIC_LINK_WEBHOOK_SECRET` — 16–500 character bearer secret.
- `RENT_OPS_PUBLIC_APP_URL` — HTTPS public origin used to build `/apply#resume=...`.

The provider-neutral adapter posts only `applicationId`, `email`, `resumeUrl`, and `expiresAt`, with a stable `Idempotency-Key` header and a bounded timeout. Provider/network failures return a generic temporary-unavailable response; no provider detail is exposed. Partial or non-HTTPS configuration fails startup. No real delivery is performed by tests or the demo server, and tokens must never be logged.

## Schema and cutover

`migrations/001_rent_ops.sql` through the version 23 migration form the immutable migration chain. Versions 10–23 add tenant accounts/auth throttles, payment reconciliation, recurring billing, database-backed public limits, preserved source application/deposit/allocation states, recurring-root audit support, opaque answer types, account-parent household links, proven credit allocations, observed tenancy status bindings, and preserved parity collection identities, and exact source-credit scope/history evidence. Run `npm run rent-ops:migration:render:all` to render every checksum-bound SQL artifact into `dist/migrations/`; review and apply these in numeric order through the approved operator workflow. Application startup does not migrate. It checks schema checksums, required tables, and runtime privileges and fails closed if they differ.

Cutover sequence:

1. Take and verify a restorable PostgreSQL backup. Record the backup reference and database version.
2. Run `npm run rent-ops:migration:dry-run` and review the required tables and statement count.
3. In an approved maintenance window, apply only the rendered SQL artifact with the normal database operator tooling. Do not enable an application auto-migration.
4. Run the read-only RM export/import in dry-run mode, review exceptions, and reconcile record counts and charge/payment control totals.
5. Test reports and tenant/application workflows against the staged database before changing DNS or links.
6. Keep the RM export, reconciliation report, document manifest/checksums, and database backup until the retention decision is approved.

Restore is operational, not automatic: stop writes, restore the verified pre-cutover backup to a separate database first, validate it, then switch the application connection only through the normal deployment process.

## RM import and cancellation gates

The RM mapper accepts supplied fixtures/exports only. It has no embedded credentials and performs no RM writes. Mapping is idempotent by source system, entity type, and source ID; source timestamps, checksums, import runs, control totals, and exceptions are retained. Unmapped former-tenant/unit recurring rows and missing document binaries remain explicit exceptions.

Before cancelling RM, export and reconcile at minimum: properties/units, all current/future/former tenants, household/contact data, actual occupancy dates, every lease term and renewal, effective recurring charges, complete transaction/allocation history, deposit liability, HAP obligations and receipts, applications/status/missing items, notes/activity, and a document metadata/binary manifest. Confirm count and amount controls, resolve or accept every exception, verify report parity on sampled properties and tenants, and preserve the final archive plus restore instructions.

## Local verification

- `npm run test:rent-ops` — focused domain, security, route, repository, import, and client tests.
- `npm run check` — TypeScript.
- `npm run build` — production client/server bundle and checksum-rendered migration asset.
- `npm run rent-ops:migration:dry-run` — no database write.
- `npm run rent-ops:demo:build` then `npm run rent-ops:demo` — explicit synthetic browser-smoke path. Demo flags are development-only and production guards fail closed.

The demo server serves the built `/ops` and `/apply` SPA routes but imports no `.env`, global database, session store, RM client, or credentials. Its data and identity use obvious `example.test` synthetic values.

Production uses the atomic database public limiter through the dedicated runtime executor. Edge attestation remains an optional alternate mode. Process-memory limiting is development-only. Hosting remains configured for one instance; revisit the full deployment contract before scaling.

See `docs/TENANT_PORTAL_LAUNCH.md` for tenant account activation, optional Stripe connection, current launch prerequisites, and the isolated PGlite browser-QA command. No production host, real tenant invitation, payment-provider connection, or live database migration is implied by a successful local build.

The private operator entrypoint `scripts/rent-ops-production-import.ts` runs in the Replit development shell with `NODE_ENV=production`. It accepts only a nonsecret configuration path and prompts without echo for the dedicated importer URL, narrow raw-auditor URL, and retained base64 target-identity key. These credentials never belong in the archive package, command arguments, or published web environment. The reviewed package is extracted outside the workspace at `/tmp/5central-rent-ops-import`; run `NODE_ENV=production npx tsx --no-cache scripts/rent-ops-production-import.ts /tmp/5central-rent-ops-import/rent-ops-operator/operator-config.json` after its package digest is verified.

Production classification requires `APPLY_RENT_OPS_PRODUCTION_ONCE`; the staging phrase cannot authorize production. Both profiles retain target fingerprint, forbidden-target policy, schema checksum chain, restored-backup attestation, keyed identity, source-receipt verification, and database audit checks. The explicit managed-GCS import profile uses the real factory readiness callback and reports its single provider identity, private access, and generation guards truthfully. It does not claim separate S3 principals or native version retention. The stricter S3 privilege probe remains unchanged, and configuring both profiles is rejected.

The operator verifies an empty target, dry-runs the sealed archive, imports twice, runs raw parity through the dedicated auditor and financial checks through the importer read-only transaction, and compares every imported table. Verified document bytes are transferred through the managed importer store and bound within the import transaction. A successful operator result still labels actual populated PostgreSQL backup/restore verification as pending; the separate database operator must complete that final check.
