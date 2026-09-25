# Document relocation: Replit-managed GCS → private S3

Status: code complete and tested on synthetic data (September 23, 2026). Not yet run against
production. This is a **release gate for the Render cutover**: the live database holds 1,509
verified document bindings on `replit-managed-gcs`, and the Render web service cannot read the
Replit bucket. Without this step every historical lease and application file becomes
unavailable after the switch (the app fails closed; it never serves an unverified file).

## Why a relocation table and not an update

A verified binding (`rent_ops_document_objects`) pins one exact object version in one backend and
is immutable by trigger (migration 004). Migration **049** adds
`rent_ops_document_object_relocations`, an append-only table:

- one row per document says the same content (same `sha256:` key, checksum and size) now lives at
  an exact version in another backend;
- a trigger requires each row to continue the chain exactly — same content as the original
  binding, starting from the currently effective backend object, next sequence number;
- rows cannot be updated, deleted or truncated;
- the runtime (web/worker) role can only **read** it; the operator writes it.

The repository resolves the effective binding (original row overlaid with its latest relocation)
for downloads, tenant lease files and availability checks. The document rows themselves
(`storage_key = documents/<sha256>`) do not change.

## What the operator tool does

`npm run company:document-relocation -- <command>` (`scripts/company/document-relocation.ts`,
logic in `server/rent-ops/storage/document-relocation.ts`):

| Command | Writes | What it does |
|---|---|---|
| `inventory` | nothing | Effective bindings by backend: documents, distinct objects, bytes, and an inventory digest. |
| `copy` | S3 objects + a local manifest | For each distinct source object: read it from Replit GCS at its pinned generation and verify SHA-256 and size; `PUT If-None-Match: *` to S3 under the same content-addressed key (S3 checks the payload hash); read it back through the **runtime** identity at the exact new version and re-hash. Resumable; one bad object is recorded and skipped, never written. |
| `plan` | nothing | Joins the manifest with the live bindings: one relocation row per document, the documents still missing, and a `planSha256` of exactly what `apply` would write. |
| `apply` | relocation rows | Re-checks every target object version (HEAD, or full re-hash with `--rehash`), then in one transaction under an advisory lock recomputes the plan, refuses if it differs from `--confirm`, inserts the rows, reads the effective bindings back, and commits. Requires `--apply-reviewed`; refuses an incomplete copy unless `--allow-partial`. |
| `readback` | nothing | Verifies target-backend bindings through the runtime reader at their exact versions (`--sample N` or all). Runs on Render with the app's own runtime credentials. |

The tool never prints connection strings or keys and never deletes or overwrites objects.

## Environment (names only)

- Database: `--url-env` (default `RENT_OPS_MIGRATION_DATABASE_URL`), the Neon **owner** URL for
  branch `rent-ops-replacement-20260907` (`br-flat-scene-ahvx8421`), database
  `rent_ops_production`. `inventory`, `copy` and `plan` only read.
- Source (for `copy`, inside the Replit workspace): `RENT_OPS_RELOCATION_SOURCE_BUCKET`
  (`replit-objstore-…`) and `RENT_OPS_RELOCATION_SOURCE_PREFIX`; if unset, the app's own
  `RENT_OPS_OBJECT_STORE_BUCKET`/`_PREFIX` are used when `RENT_OPS_OBJECT_STORE_BACKEND=replit-managed-gcs`.
- Target, default prefix `RENT_OPS_RELOCATION_TARGET` (so the Replit app's own
  `RENT_OPS_OBJECT_STORE_*` values are never reused by mistake):
  - `RENT_OPS_RELOCATION_TARGET_ENDPOINT=https://s3.us-west-2.amazonaws.com`
  - `RENT_OPS_RELOCATION_TARGET_REGION=us-west-2`
  - `RENT_OPS_RELOCATION_TARGET_BUCKET=fivecentral-ops-production-651532007693`
  - `RENT_OPS_RELOCATION_TARGET_PREFIX=rent-ops/private`
  - writer: `RENT_OPS_RELOCATION_TARGET_IMPORTER_IDENTITY` / `_IMPORTER_TOKEN`
  - reader: `RENT_OPS_RELOCATION_TARGET_RUNTIME_IDENTITY` / `_RUNTIME_TOKEN` (the production
    runtime IAM user, so the copy proves the app can read what was written)

### IAM for the writer

Use the existing IAM user `fivecentral-ops-production-importer` (and
`fivecentral-ops-staging-importer` for the rehearsal). Its reviewed policy is exactly what `copy`
needs: `s3:PutObject`, `s3:GetObject` and `s3:GetObjectVersion` on `rent-ops/private/*`, with
explicit denies for listing and deletion. No importer access key exists yet: create one only for
the copy session, export it in the Replit shell as the `_IMPORTER_*` pair, never put it in a
Render group (web startup refuses importer credentials), and deactivate it after `readback`
passes.

The reader pair is the runtime user (`fivecentral-ops-production-runtime`); its key already
exists in the `5central-ops-production-web` group. Copy it into the Replit shell for the session
from the Render dashboard, or create a second runtime key and deactivate it afterwards.

Without `s3:ListBucket`, S3 answers 403 (not 404) for a key that does not exist. The tool never
depends on that answer: it writes with `If-None-Match: *` and reads only keys it just wrote.

## Run order

The copy is idempotent and content-addressed, so it can run **before** the freeze (it only reads
the database and works on schema v42). The database write happens inside the cutover window,
after migrations 043–049.

1. **Inventory** (any shell with the owner URL):
   `npm run company:document-relocation -- inventory` — expect `replit-managed-gcs` ≈ 1,509
   documents. Record `inventorySha256`.
2. **Rehearsal on staging** (optional but recommended): the staging Neon branch
   `rops-render-staging-20260923` is a clone with the same 1,509 bindings. Run steps 3–8 against
   it with the staging bucket and staging importer/runtime users, after migrations through 49 on
   that branch.
3. **Trial copy inside the Replit workspace** (it has the managed bucket identity), on this branch
   (pushed to GitHub and pulled there) with `npm ci` done and the variables above exported in the
   shell only:
   `npm run company:document-relocation -- copy --manifest ~/relocation-20260923.json --run-id relocate-20260923 --limit 3`
   Check the three objects in the S3 console (versions shown, sizes match).
4. **Full copy**: the same command without `--limit`. Re-run until `remaining: 0` and
   `failureCount: 0`. A failure code of `storage_checksum_mismatch` means the Replit object does
   not match its binding — stop and investigate; do not relocate that document.
5. **Cutover window, after the freeze**: re-run the same copy once more (picks up any upload made
   since), then apply migrations through **49** with `npm run company:production-schema`
   (see `production-release-2026-09-23.md`).
6. **Plan**: `npm run company:document-relocation -- plan --manifest ~/relocation-20260923.json --run-id relocate-20260923 --authorization <michael-approval-ref>`
   Expect `documentsToRelocate` = the inventory count, `missingCount: 0`. Copy `planSha256`.
7. **Apply**: `npm run company:document-relocation -- apply --manifest … --run-id relocate-20260923 --authorization <ref> --confirm <planSha256> --apply-reviewed --rehash`
8. **Readback on Render** (web shell, app credentials):
   `npm run company:document-relocation -- readback --url-env RENT_OPS_RUNTIME_DATABASE_URL --target-env-prefix RENT_OPS_OBJECT_STORE`
   Expect `replit-managed-gcs` absent from `byBackend`, `verifiedObjects` = distinct objects,
   `failureCount: 0`. Then download one lease in the manager UI.
9. Keep the Replit bucket untouched for at least 30 days. Keep the manifest file with the
   cutover evidence (it contains checksums and version ids only, no document content or names).

## Rollback

- Before `apply`: nothing in the database changed. S3 objects written by `copy` are inert.
- After `apply`, if S3 reads fail: point DNS back to Replit only if the Replit build is being
  restored too — the Replit build still reads GCS through the original binding columns, which
  were never changed. The relocation rows stay; a later forward relocation can move bindings
  again. Never delete relocation rows.

## Tests

`server/rent-ops/storage/document-relocation.test.ts` (PGlite, real migrations and runtime
grants): the trigger chain and append-only guards; the web role can read but not insert; the
repository resolves the latest relocation while the original row stays unchanged; copy verifies
both ends, resumes, and skips a corrupted source without writing it; plan/apply digest binding,
target pre-check blocking the batch, partial-copy refusal, idempotent re-plan; readback drift
detection; the CLI's manifest permissions, target mismatch refusal and secret hygiene; operation
on a v48 database before 049 exists.
