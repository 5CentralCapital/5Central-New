# QuickBooks Online sandbox harness

`scripts/company/qbo-sandbox.ts` runs the synthetic company demo against an
Intuit **sandbox** company so the connect, disconnect, and reconnect flow and
the README acceptance checklist
([server/integrations/quickbooks/README.md](../../server/integrations/quickbooks/README.md))
can be exercised end to end. It uses the in-memory synthetic database only. No
private company data, tenant records, or production realm is involved.

## Required environment

| Variable | Value |
| --- | --- |
| `QBO_ENVIRONMENT` | `sandbox` (anything else is refused) |
| `QBO_CLIENT_ID` | Development (sandbox) client ID from the Intuit app |
| `QBO_CLIENT_SECRET` | Development (sandbox) client secret |
| `QBO_REDIRECT_URI` | `http://localhost:4178/api/accounting/qbo/callback` |
| `QBO_TOKEN_ENCRYPTION_KEY` | Optional here. When absent the harness generates an ephemeral in-memory key. Production requires a 32-byte `base64:` key. |
| `ROPS_SANDBOX_PORT` | Optional, default `4178` |
| `ROPS_EVIDENCE_DIR` | Optional. Defaults to `~/.local/state/r-ops/qbo-sandbox/` on the current machine. |

Export the credentials in your shell. Never write them into a file in the repository.

## Redirect URIs to register with Intuit

Intuit matches redirect URIs exactly, so R-ops has one static,
organization-free callback, `GET /api/accounting/qbo/callback`. The callback
recovers the organization and legal entity from the server-side OAuth state.

| App keys | Redirect URI |
| --- | --- |
| Development (sandbox harness) | `http://localhost:4178/api/accounting/qbo/callback` |
| Production | `https://5-central-new.replit.app/api/accounting/qbo/callback` |

The older `/api/company/:organizationId/accounting/qbo/callback` route remains
and runs the same shared handler. Don't register it with Intuit.

## Intuit app details (production key review)

| Field | URL |
| --- | --- |
| Launch URL | `https://5-central-new.replit.app/ops?section=accounting` |
| Disconnect URL | `https://5-central-new.replit.app/quickbooks/disconnected` |
| End-user license agreement | `https://5-central-new.replit.app/legal/eula` |
| Privacy policy | `https://5-central-new.replit.app/legal/privacy` |

The active build contains the disconnect, EULA, privacy, and OAuth callback
routes. As of 2026-09-22, the published disconnect and legal URLs above render
the public site's 404 page (the SPA returns HTTP 200, so status alone is
misleading), and the published callback returns an `API route not found`
response. The current deployment therefore cannot complete this app's OAuth
flow or satisfy its listed app-detail URLs. Deploy the build that contains
these routes, then verify the actual page content and callback behavior before
the production key review.

## Run it

```sh
npm run build   # or the synthetic frontend build below
VITE_RENT_OPS_DEMO=true VITE_RENT_OPS_APPLY_DEMO=true VITE_RENT_OPS_LOCAL_SYNTHETIC_BUILD=true npx vite build
QBO_ENVIRONMENT=sandbox QBO_CLIENT_ID=… QBO_CLIENT_SECRET=… \
  QBO_REDIRECT_URI=http://localhost:4178/api/accounting/qbo/callback \
  npm run company:qbo-sandbox
```

The harness serves the normal built frontend from `dist/public` at
`http://localhost:4178/ops?section=accounting`. It adds a cookie session only
inside the harness, so `request.sessionID` exists and the OAuth state can bind
to it.

### Browser on the same machine

Open the Accounting workspace, choose **Connect QuickBooks**, sign in to the
sandbox company, and confirm the company when the workspace shows it. Then run
the acceptance step below with the same browser cookie, or use the
**Disconnect QuickBooks** action in the UI.

### Headless or remote browser (callback replay)

If you complete the Intuit sign-in in a browser on another machine, its redirect
to `localhost` never reaches this server. Use one cookie jar for every call:

```sh
J=/tmp/qbo-sandbox.jar; H=http://localhost:4178
curl -s -c $J -b $J $H/__sandbox/status
curl -s -c $J -b $J -X POST $H/__sandbox/connect-url      # open authorizationUrl, sign in
# copy the full URL the browser was redirected to (it fails to load; that is expected)
curl -s -c $J -b $J -G $H/__sandbox/replay --data-urlencode "url=<redirected URL>"
curl -s -c $J -b $J -X POST -H 'content-type: application/json' -d '{}' $H/__sandbox/confirm
curl -s -c $J -b $J -X POST -H 'content-type: application/json' -d '{}' $H/__sandbox/acceptance
```

The OAuth state expires after 10 minutes and works only once.

## Harness-only endpoints

These exist only in the script. They are never registered by production routes.

| Endpoint | Purpose |
| --- | --- |
| `GET /__sandbox/status` | Environment, redirect URI, this session's pending confirmation, safe connection metadata, last evidence file |
| `POST /__sandbox/connect-url` | Starts the normal OAuth begin flow for the synthetic organization and legal entity, bound to this cookie session. It returns the Intuit authorize URL. |
| `GET /__sandbox/replay?url=…` | Forwards the redirected callback's query to `/api/accounting/qbo/callback` in the same session |
| `POST /__sandbox/confirm` `{ pendingId? }` | Confirms the pending CompanyInfo binding through the normal confirm route. It uses the last replayed pending ID by default. |
| `POST /__sandbox/acceptance` `{ realmId?, disconnect?, maxPages? }` | Runs the automatable checklist items and writes evidence |

## Acceptance run

For the confirmed connection, `/__sandbox/acceptance` runs these steps:

1. Reads CompanyInfo through the provider-sync bootstrap, which enables `accounting.read` from live read-back.
2. Runs the provider sync catch-up for Purchase, Bill, BillPayment, Deposit, and Account (`maxPages`, default 3).
3. Runs one Accounting query (`SELECT * FROM Vendor MAXRESULTS 5`).
4. Enables `accounting.create` and `accounting.update` for this sandbox realm only, using the existing capability store with the CompanyInfo read-back evidence. Only the harness does this.
5. Creates a disposable Vendor named `R-ops sandbox test <timestamp>` and reads it back.
6. Makes a sparse update of `CompanyName` with `Id` and `SyncToken`, then reads it back and confirms that `SyncToken` went up.
7. Sends an update with the old `SyncToken`. Intuit must reject it after exactly one POST with no retry, and the record must be unchanged.
8. Marks the access token expired in the repository, then reads. Expected: exactly one refresh, and the refresh token Intuit returned is the one persisted. The check compares hashes internally; the token is never printed.
9. Disconnects through `POST /api/company/:org/accounting/qbo/disconnect`.
10. Reads after the disconnect. The read must be refused with a reconnect requirement and no provider request.

Pass `{"disconnect": false}` to keep the connection. The evidence JSON is
written to `$ROPS_EVIDENCE_DIR/acceptance-<timestamp>.json` and `latest.json`.
It contains the method, host, path, status, `intuit_tid`, OAuth grant type,
pass/fail, and notes for each step. It never contains tokens, client
credentials, authorization codes, or raw provider bodies.

The run can't automate these items, so the evidence lists them for manual
follow-up:

- Wrong redirect URI and environment/realm mismatch rejections.
- Reconnect after the disconnect. Run connect-url, authorize, replay, and confirm again, then repeat the acceptance run.
- The OAuth and API failure matrices, which mocked tests cover.
- A real signed webhook, which needs a public HTTPS endpoint.

## Disconnect behavior (all environments)

`POST /api/company/:organizationId/accounting/qbo/disconnect` takes
`{ legalEntityId, realmId }`. It needs the owner, admin, or finance role and CSRF.
Codex MCP has the matching `disconnect_quickbooks` tool, which calls the same
command.

1. It revokes the latest stored refresh token with Intuit.
2. Only after Intuit accepts, it tombstones the connection in one transaction: credentials are cleared and `revoked_at` is set. The same transaction disables every recorded capability for the scope and writes an `accounting.qbo.disconnect` command receipt.
3. If Intuit answers `invalid_grant` or `invalid_token`, the user already disconnected inside QuickBooks, so the local connection is cleared the same way (`providerOutcome: "already_revoked"`).
4. Any other failure keeps the connection and returns `503 accounting_disconnect_unconfirmed` with `retryable: true`. This covers timeouts, transport errors, 5xx, and 429. A `failed` receipt is audited.
5. After a disconnect, reads and syncs need a reconnect. Reconnect uses the normal connect, callback, and confirm path, which revives the tombstoned row with new tokens.
