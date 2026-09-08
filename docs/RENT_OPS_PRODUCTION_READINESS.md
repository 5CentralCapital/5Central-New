
## Replit managed GCS profile

`replit-managed-gcs` is an explicit managed-hosting profile, separate from the stricter S3 IAM profile. Replit supplies one app identity. Its observed provider permissions include object get/create/list/delete/update; bucket IAM/configuration access is denied. The application exposes keyed reads and create-if-absent uploads only. It does not claim separate cloud principals, provider list/delete denial, or verified native version retention.

Objects use SHA-256 content addresses, GCS `ifGenerationMatch: 0` creation, exact generation reads, and byte size/checksum verification. Startup writes a harmless deterministic probe and requires anonymous access to that existing object to return 401/403. Server authentication and explicit document-to-person/tenancy bindings remain the tenant authorization boundary. Keep sealed source archives and independent hash receipts outside the web deployment as recovery copies: the managed app credential itself has broader destructive power than its exposed storage interface.
