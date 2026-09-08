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

Tools: `search`, `fetch`, `get_tenant`, `get_lease`, `get_tenancy`, `get_application`, `get_property`, `get_unit`, `get_tenant_ledger`, `get_report`, `update_tenant_contact`, `update_lease`, `update_application_status`.

Read tools expose positive admin serializers. Broad application reads exclude profile answers, household answers, documents and tokens. All writes require an exact record ID and revision; the existing transaction, invariant and audit service owns mutation. Refetch after a conflict. Writes are deliberately not advertised as idempotent: a repeated stale revision is rejected. Application status editing does not send messages or convert applicants. No maintenance tool is exposed because no supported maintenance domain exists. No payment execution, generic SQL or unaudited ledger mutation is exposed.

After setting up the issuer and stable HTTPS hosting, enable Developer Mode in ChatGPT, create an app with the `/mcp` URL, select OAuth and use the exact callback URL shown in the app editor in the issuer allowlist. Enable CIMD or DCR in the issuer, or configure a predefined OAuth client. Authenticate the administrator and consent to the appropriate scopes. Refresh the app after tool changes. Test a read, a denied write with read-only scope, an authorized reversible contact correction, stale revision rejection and grant revocation before operational use.

Local validation: `npx tsx --test server/rent-ops/mcp/mcp.test.ts` and `npm run check`. Local tests use synthetic records and no external OAuth account. Actual provider/ChatGPT linking remains a deployment check.

Official references: https://developers.openai.com/plugins/build/auth , https://developers.openai.com/apps-sdk/build/mcp-server , https://developers.openai.com/apps-sdk/plan/tools , https://developers.openai.com/apps-sdk/reference .

Record links open the existing `/ops` workspace; the workspace does not support record deep links. Configure the Auth0 custom API access-token lifetime to 900 seconds before enabling JWT mode.
