# QuickBooks Online production switch

Intuit issued production keys for the 5Central Ops app on September 23, 2026.
The switch from sandbox to production needs configuration only, no code
changes. `QBO_ENVIRONMENT` selects Intuit's production discovery document,
OAuth endpoints and Accounting API base URL. Connections, realm bindings,
capabilities and mirror rows are all stored per environment, so sandbox rows
never appear in production reads.

A server runs one environment at a time. Once it is on production keys it
cannot see or revoke sandbox connections, so disconnect those first.

## Secrets (deployment, not the repository)

| Variable | Production value |
|---|---|
| `QBO_ENVIRONMENT` | `production` (exact; any other value makes the app show QuickBooks as not configured) |
| `QBO_CLIENT_ID` | Production Client ID from the Intuit portal |
| `QBO_CLIENT_SECRET` | Production Client Secret |
| `QBO_REDIRECT_URI` | `https://5central.capital/api/accounting/qbo/callback`, unchanged; must match the portal's Production redirect URI exactly |
| `QBO_TOKEN_ENCRYPTION_KEY` | Unchanged. Do not rotate it during the switch. |
| `QBO_OAUTH_DISCOVERY` | Leave unset |
| `QBO_WRITES_ENABLED`, `QBO_PRODUCTION_WRITES` | `off` (pinned in `render.yaml` on both services). Keep off until the read-only comparison and books cleanup are signed off |
| `QBO_WRITE_TYPES` | Leave unset |

On Render these values live in the external group `5central-ops-production`,
which both the web service (connect flow, callback, webhooks) and the worker
(sync, change-data-capture, webhook fetches) read. Group changes apply on the
next deploy or restart of each service. The webhook verifier token
(`QBO_WEBHOOK_VERIFIER_TOKEN_PRODUCTION`) goes only in the web group.

## Preflight

`npm run company:qbo-preflight` checks the configuration and exits non-zero on
any failure. It makes no QuickBooks API calls, never prints a secret, and
writes nothing.

```sh
npm run company:qbo-preflight                  # configuration
npm run company:qbo-preflight -- --network     # + Intuit production discovery document
npm run company:qbo-preflight -- --database    # + open connections by environment
```

Before the switch, use `-- --skip-config --database` to confirm no sandbox
connection is still open. The configuration section will fail at that point
because the secrets still hold sandbox values.

## Order

1. Disconnect the sandbox company from Accounting while the server is still
   on sandbox keys. `--skip-config --database` should then show none open.
2. Intuit portal, Production settings: check the redirect URI and the EULA,
   privacy, launch and disconnect URLs are all on `5central.capital`, and
   rename the app profile to "5Central Ops". Do not register webhooks yet.
3. Back up the runtime database.
4. Set `QBO_ENVIRONMENT`, `QBO_CLIENT_ID` and `QBO_CLIENT_SECRET` in the
   deployment secrets, then run `npm run company:qbo-preflight -- --network`.
   It should show no failures.
5. Redeploy. The Accounting page's environment badge should read Production.
6. Connect one company at a time, signed in as that company's QuickBooks
   admin. Before confirming the binding, check that the CompanyInfo name
   matches the legal entity; a realm cannot be rebound to a different entity.
7. Run the CompanyInfo probe and a sync. Reconcile one closed month against
   QuickBooks' P&L and trial balance before connecting the next company.

## Rollback

Disconnect the production company in the app, then put back the sandbox
values of `QBO_ENVIRONMENT`, `QBO_CLIENT_ID` and `QBO_CLIENT_SECRET` and
redeploy. Production rows stay isolated by environment and need no cleanup.

## Sandbox testing afterwards

Use sandbox keys only in local or dev environments.
`npm run company:qbo-sandbox` refuses to start unless `QBO_ENVIRONMENT=sandbox`.
