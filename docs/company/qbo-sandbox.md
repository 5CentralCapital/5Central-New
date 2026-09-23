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
| Connect/Reconnect URL (required since 2026-02-24) | `https://5-central-new.replit.app/ops?section=accounting` |
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

Rechecked on 2026-09-22 at about 21:40 EDT from a browser: `/legal/eula`,
`/legal/privacy` and `/quickbooks/disconnected` still render the public site's
"404 Page Not Found" content, `/api/accounting/qbo/callback` returns HTTP 404
`{"error":"API route not found"}`, and `/healthz` returns 404. The published
deployment is not this build. Nothing was deployed during the audit.

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
to `localhost` never reaches this server. Keep the same cookie jar for every
call. The callback URL contains a short-lived authorization code and OAuth
state: do not paste it into a shell command, save it in a file, or print it in
terminal output. The hidden prompt below keeps it out of shell history and
terminal echo. The authorization URL is opened directly without printing it.

```sh
umask 077
J="$(mktemp)"; H=http://localhost:4178
curl -fsS -c "$J" -b "$J" "$H/__sandbox/status" >/dev/null
auth_url="$(curl -fsS -c "$J" -b "$J" -X POST "$H/__sandbox/connect-url" | python3 -c 'import json,sys; print(json.load(sys.stdin)["authorizationUrl"])')"
open "$auth_url"
unset auth_url
# Sign in to the sandbox company. If the remote browser cannot load localhost,
# copy its final callback URL, then paste it at this hidden prompt.
printf 'Paste redirected callback URL (input hidden): '
IFS= read -r -s callback_url
printf '\n'
curl -fsS -c "$J" -b "$J" -G "$H/__sandbox/replay" --data-urlencode "url=$callback_url" \
  | python3 -c 'import json,sys; result=json.load(sys.stdin); print(result.get("status", "unknown"))'
unset callback_url
curl -fsS -c "$J" -b "$J" -X POST -H 'content-type: application/json' -d '{}' "$H/__sandbox/confirm"
curl -fsS -c "$J" -b "$J" -X POST -H 'content-type: application/json' -d '{}' "$H/__sandbox/acceptance"
rm -f "$J"
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
| `POST /__sandbox/acceptance` `{ realmId?, disconnect?, maxPages?, fullReplay? }` | Runs the automatable checklist items and writes evidence |
| `POST /__sandbox/sync` `{ realmId?, maxPages?, fullReplay?, reconcile? }` | Read-only: bootstrap, catch-up (or full replay), open sync exceptions with safe reasons, coverage, and a provider-vs-mirror count and cent reconciliation per transaction type |
| `GET /__sandbox/inspect?entity=…&id=…` | Structural, redacted shape of one sandbox object (keys, types, IDs, reference types, amounts; names, memos and contact fields redacted) for diagnosing a rejection |

## Acceptance run

For the confirmed connection, `/__sandbox/acceptance` runs these steps:

1. Reads CompanyInfo through the provider-sync bootstrap, which enables `accounting.read` from live read-back.
2. Runs the provider sync catch-up for Purchase, Bill, BillPayment, Deposit, and Account (`maxPages`, default 3; `fullReplay: true` re-reads everything). It passes only when every stream is complete, nothing was rejected in this run, and no durable sync exception from any earlier run remains open. The notes list each open exception by provider ID with its normalizer reason.
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

### Sandbox verification recorded on 2026-09-22

**First run (Codex, 00:01Z).** Ten acceptance steps were recorded, but the
provider sync reported 10 BillPayment and 9 Deposit entries as unsupported.
The acceptance criterion at the time still counted that sync as a pass, so the
run did not establish full mirror coverage.

**Audit re-run (01:44Z to 01:50Z) against the same sandbox company.** Sandbox
Company US 10b3 (realm `9341457970146424`) was used with the harness in this
branch.

- **Root cause of the 19 rejections.** Intuit omits `Line.Id` on every
  BillPayment line (10 lines across 10 payments) and on every Deposit line that
  moves a Payment out of Undeposited Funds (9 lines across Deposits 62, 102
  and 121). Those linked lines can also carry a `DepositLineDetail` holding
  only `PaymentMethodRef`/`CheckNum`. The normalizer now identifies each such
  line by its single linked transaction (`linked:<TxnType>:<TxnId>`).
- **Resolved.** All 10 BillPayments and Deposits 62 and 102 now mirror exactly.
- **Intentional exceptions.** Two objects stay open as durable exceptions:
  - Deposit 121 has $200.00 cash back. It has $1,068.15 of linked lines and a
    net `TotalAmt` of $868.15.
  - Purchase 139 is a $900.00 credit-card credit (refund), and
    `Credit: true` was previously ignored. The code before this audit mirrored
    Purchase 139 as a $900.00 outgoing expense and reported Purchase coverage
    as complete.

  Mirror coverage therefore stays `partial` for the Purchase and Deposit
  streams, and the gate correctly fails `provider_sync_catch_up`.
- **Reconciliation.** Each type was reconciled in cents from provider
  `TotalAmt` to current mirrored lines plus open exceptions. Every object is
  accounted for, with no unexplained or mismatched IDs.

  | Type | Provider count | Provider total | Mirrored | Exceptions |
  | --- | --- | --- | --- | --- |
  | Purchase | 35 | $3,424.17 | 34 / $2,524.17 | 1 / $900.00 |
  | Bill | 15 | $6,142.17 | 15 / $6,142.17 | 0 |
  | BillPayment | 10 | $4,539.50 | 10 / $4,539.50 | 0 |
  | Deposit | 5 | $7,094.90 | 4 / $6,226.75 | 1 / $868.15 |

- **Initial, incremental and full-replay runs.** All three produced the same
  open exceptions. An incremental run that rejected nothing new still reported
  the earlier exceptions and partial coverage. A full replay found no objects
  missing from QBO.
- **Other steps passed.** These were:
  - CompanyInfo bootstrap, with the home currency read from
    `Preferences.CurrencyPrefs` (USD, multicurrency off).
  - Vendor create and read-back.
  - Sparse update with a SyncToken increase.
  - Stale SyncToken rejected with fault 5010 as `quickbooks_conflict` after
    exactly one POST, with the record unchanged. Writes now carry `requestid`.
  - Forced refresh: one refresh call, and the latest returned refresh token was
    persisted.
  - Disconnect with provider revoke.
  - Reads refused after disconnect with no provider request.
- **Reconnect after disconnect.** Proven live. A fresh authorization revived
  the revoked connection (version 4, new rolling expiry about 100 days out),
  and reads and sync then worked. Replaying the used callback, or replaying it
  with a different `realmId`, was rejected with `409 accounting_conflict`. The
  final run disconnected and revoked the sandbox grant.
- **Refresh token value.** It was unchanged across the forced refresh. Intuit
  issues a new value about once every 24 hours, so this is expected. It does
  not prove that rotating values are handled; mocked tests cover that.

Still not proven live:

- Delivery of a real signed webhook. No webhook route exists.
- Wrong-environment keys.
- 429 and 5xx responses.
- An uncertain-write timeout.

Mocked tests cover these.

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
