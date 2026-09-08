
## Replit managed GCS profile

`replit-managed-gcs` is an explicit managed-hosting profile, separate from the stricter S3 IAM profile. Replit supplies one app identity. Its observed provider permissions include object get/create/list/delete/update; bucket IAM/configuration access is denied. The application exposes keyed reads and create-if-absent uploads only. It does not claim separate cloud principals, provider list/delete denial, or verified native version retention.

Objects use SHA-256 content addresses, GCS `ifGenerationMatch: 0` creation, exact generation reads, and byte size/checksum verification. Startup writes a harmless deterministic probe and requires anonymous access to that existing object to return 401/403. Server authentication and explicit document-to-person/tenancy bindings remain the tenant authorization boundary. Keep sealed source archives and independent hash receipts outside the web deployment as recovery copies: the managed app credential itself has broader destructive power than its exposed storage interface.

## Manager Google login

Set `RENT_OPS_ADMIN_OAUTH_CLIENT_ID` to the dedicated public Auth0 PKCE application's client ID. Keep `RENT_OPS_ADMIN_EMAIL=michael@5central.capital` and the exact verified Google subject in `RENT_OPS_OAUTH_ADMIN_SUBJECTS`. The manager flow pins issuer `https://dev-0mw45hx037gk3vbi.us.auth0.com/`, API audience `https://5-central-new.replit.app/mcp`, and callback `https://5-central-new.replit.app/api/rent-ops/auth/oauth/callback`. Configure authorization-code only, token authentication none, Google connection, and `rent-ops:read` API scope. No client secret or refresh token is stored.

The server stores five-minute one-use state and PKCE verifier in the existing PostgreSQL session, validates the API token with the shared RS256 issuer/audience/scope validator, then rotates the session and creates a CSRF token. Redirect destinations are fixed to the public `/ops`. Each authenticated request still reloads the host administrator and checks the current subject/email allowlist. Password login remains available. Tokens and callback query values are not logged.
