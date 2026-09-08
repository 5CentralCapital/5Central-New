# ChatGPT Rent Operations

This is an internal, tool-only MCP app on the existing Express server. No widget, OpenAI API key or public directory submission is required.

The server is disabled unless `RENT_OPS_MCP_ENABLED=true`. Configure an established OAuth authorization server, such as Auth0, with authorization-code flow, S256 PKCE, explicit administrator consent, resource-bound access tokens and revocation. The default JWT mode supports Auth0 custom API RS256 access tokens through the exact configured issuer’s OpenID discovery and same-origin HTTPS JWKS. Configure access-token lifetime to at most 900 seconds. No application password or long-lived bearer token is pasted into ChatGPT.

Runtime settings:

- `RENT_OPS_MCP_RESOURCE`: canonical public HTTPS URL ending `/mcp`.
- `RENT_OPS_OAUTH_ISSUER`: exact issuer from discovery.
- `RENT_OPS_OAUTH_TOKEN_MODE`: `jwt` (default) or `introspection`.
- Introspection mode only: `RENT_OPS_OAUTH_INTROSPECTION_ENDPOINT`, `RENT_OPS_OAUTH_INTROSPECTION_CLIENT_ID`, and `RENT_OPS_OAUTH_INTROSPECTION_CLIENT_SECRET`. This alternative requires RFC8414 discovery and RFC7662 responses with issuer, audience, expiry, subject and scope.
- `RENT_OPS_OAUTH_ADMIN_SUBJECTS`: explicit comma-separated allowed administrator subject IDs.

Only `rent-ops:read` can read. Writes require both `rent-ops:read` and `rent-ops:write`. The issuer must issue these scopes only to administrators; the independent subject allowlist is also enforced on every request. Remove the subject from this configuration and restart to deny access. `RENT_OPS_ADMIN_EMAIL` is required; the corresponding local user must still have the admin role on every request. JWT validation requires RS256, exact issuer/audience, valid expiry/not-before, subject, read scope, and a maximum 15-minute lifetime. Provider grant revocation does not immediately revoke an already-issued JWT; it remains usable until expiry unless locally denied. Introspection mode checks every request without a positive cache. Tenant sessions, application tokens and legacy dashboard API keys are never accepted as authorization.

Tools include typed `search`/`fetch`, exact record reads, tenant ledger and 11 fixed reports, tenant/contact/insurance edits, lease details, application status, property settings, unit settings and tenancy dates/status. `list_charge_definitions`, `list_recurring_schedules` and `get_recurring_schedule` expose curated charge configuration. `create_recurring_schedule` requires a stable unique ID and exact validated bindings; `replace_recurring_schedule` and `end_recurring_schedule` preserve history through revision-checked successors. All amounts are integer cents.

Read tools expose positive admin serializers. Broad application reads exclude profile answers, household answers, documents and tokens. Existing-record writes require an exact ID and revision; the transaction, invariant and audit service owns mutation. Refetch after a conflict. Writes are not advertised as idempotent: a repeated stale revision is rejected and a duplicate creation ID cannot overwrite a record. No source payload, actor identity or provenance field may be supplied in a patch. Application status editing does not send messages or convert applicants. Payment execution, generic SQL and unaudited ledger mutation are not exposed. Charge-definition create/update and idempotent manual-payment recording use strict shared schemas and audited services. Manual recording never executes a payment or establishes bank settlement. Account and billing tools are registered only when their runtime service is injected (33 total with both services; 26 core tools). Account reads and grant/reissue/revoke results use a positive summary that excludes credentials and activation URLs. Grant uses a stable request ID; reissue/revoke compare credentialRevision atomically. Access-link delivery requires particular-send authorization, a configured controlled QA recipient, and a stable request ID; replay never resends and an indeterminate outcome must be reviewed. Billing preview/post binds the exact month, optional property/tenancy scope and data to a preview token; replay cannot duplicate posted charges.


After setting up the issuer and stable HTTPS hosting, enable Developer Mode in ChatGPT, create an app with the `/mcp` URL, select OAuth and use the exact callback URL shown in the app editor in the issuer allowlist. Enable CIMD or DCR in the issuer, or configure a predefined OAuth client. Authenticate the administrator and consent to the appropriate scopes. Refresh the app after tool changes. Test a read, a denied write with read-only scope, an authorized reversible contact correction, stale revision rejection and grant revocation before operational use.

Local validation: `npx tsx --test server/rent-ops/mcp/mcp.test.ts` and `npm run check`. Local tests use synthetic records and no external OAuth account. Actual provider/ChatGPT linking remains a deployment check.

Official references: https://developers.openai.com/plugins/build/auth , https://developers.openai.com/apps-sdk/build/mcp-server , https://developers.openai.com/apps-sdk/plan/tools , https://developers.openai.com/apps-sdk/reference .

Record links open the existing `/ops` workspace; the workspace does not support record deep links. Configure the Auth0 custom API access-token lifetime to 900 seconds before enabling JWT mode.
