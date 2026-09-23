# QuickBooks Online requirements matrix

Accessed 2026-09-22 from official Intuit sources. Implementation evidence updated 2026-09-23 (durable worker, webhook intake, CDC, tombstones, write journal); "mocked tests" means synthetic fakes, not live acceptance. 5Central Ops (formerly 5Central Ops) is a **private, single-company internal app**. It is not listed on the QuickBooks App Store.

Applicability codes:

- **ALL**: applies to any app that holds production keys, including 5Central Ops.
- **MKT**: applies only to apps listed on the App Store.
- **REC**: recommended.

Source abbreviations:

- `D:` = `https://developer.intuit.com/app/developer/qbo/docs/`
- `PT:` = `https://developer.intuit.com/app/developer/payroll-time/docs/`

The developer.intuit.com pages are rendered by JavaScript, so their text was read from `static.developer.intuit.com/output_html/…`. Transaction schemas come from the minor version 75 XSD files (`https://static.developer.intuit.com/resources/v3-minor-version-75.zip`). Items marked UNVERIFIED could not be confirmed from a fetchable official page.

## OAuth and connection lifecycle

| Requirement | Source | App. | Implementation evidence | Gap |
| --- | --- | --- | --- | --- |
| **Endpoints.** Authorize: `appcenter.intuit.com/connect/oauth2`. Tokens: `oauth.platform.intuit.com/oauth2/v1/tokens/bearer`. Revoke: `developer.api.intuit.com/v2/oauth2/tokens/revoke`. | `https://developer.api.intuit.com/.well-known/openid_configuration` (also `…openid_sandbox_configuration`) | ALL | `server/integrations/quickbooks/oauth.ts` constants; README endpoint table | None |
| **Redirect URI.** Must match the registered value exactly, with no query string. Production must use HTTPS and cannot use an IP address. `http://localhost` is allowed only for development keys. | D:develop/authentication-and-authorization/oauth-2.0; …/faq | ALL | `oauth.ts` rejects non-HTTPS, IP and localhost production redirects (`oauth.test.ts`). The callback route is static (`/api/accounting/qbo/callback`). | The deployed production callback returns 404 (see Deployment) |
| **State.** Random, validated, single use. | D:…/faq | ALL | `server/accounting/oauth-state.ts`: hashed, single use, expires in 10 minutes, bound to the session and the actor (`oauth-state.test.ts`) | None |
| **Auth code.** Do not render the auth code; redirect to a clean URL. | D:…/oauth-2.0; D:go-live/publish-app/security-requirements | REC (MKT) | The callback always returns 303 to `/ops?…` and sets `Referrer-Policy: no-referrer` (`http.ts`) | Error responses still return JSON at the callback URL. The body contains no code. |
| **Scopes.** Accounting is `com.intuit.quickbooks.accounting`. Payments, Projects, Payroll and Time need separate scopes or apps. | D:learn/scopes | ALL | Only the accounting scope is requested. Payments, money movement and Projects GraphQL are capability-gated off. | None |
| **Access token** lasts 3,600 s. | D:…/faq | ALL | `token-manager.ts` refreshes with an expiry skew | None |
| **Refresh token.** Rolling 100-day window. Intuit issues a new value about every 24 h, and each new value invalidates the previous one. Always persist the latest value. There is a 5-year hard maximum, returned in `x_refresh_token_hard_expires_in`. | D:…/faq; D:…/oauth-2.0; `https://medium.com/intuitdev/important-changes-to-refresh-token-policy-8443779d40db` | ALL | Atomic compare-and-save by version. Hard expiry is stored (migration 041). The sandbox harness compares hashes of the latest token. | A refresh within 24 h legitimately returns the same value. The 2026-09-22 run therefore does not prove that value-rotation handling works. Mocked tests cover rotation. |
| **Concurrent refresh.** Concurrent refreshes cause `invalid_grant`. | D:…/faq | ALL | DB lease (`refresh-lease.ts`). A worker that loses the lease waits for the winner. `invalid_grant` is checked against the latest stored version before a connection is marked for reconnect. Disconnect holds the same lease (`refresh-lease.test.ts`, `token-manager.test.ts`, `disconnect.test.ts`). | None known |
| **Disconnect.** Revoke at Intuit, then wipe the tokens. | D:…/oauth-2.0 | ALL | `disconnect.ts`: revoke, then a version-fenced wipe in one transaction. `invalid_grant` is treated as already revoked. Other failures keep the connection and return a retryable error. | None |
| **Reconnect URL.** Required portal field since 2026-02-24. | refresh-token policy post above | ALL | The launch page `/ops?section=accounting` serves connect and reconnect | The URL must be entered in the portal and deployed |
| **Environments.** Separate Development and Production keys. Sandbox API is `sandbox-quickbooks.api.intuit.com`; production is `quickbooks.api.intuit.com`. | D:get-started/get-client-id-and-client-secret | ALL | Every token, capability, checkpoint and mirror row is scoped by environment and realm. The harness refuses any environment other than sandbox. | None |

## Accounting API behavior

| Requirement | Source | App. | Implementation evidence | Gap |
| --- | --- | --- | --- | --- |
| **Minor version.** 1–74 retired on 2025-08-01. Send `minorversion=75`. | D:learn/explore-the-quickbooks-online-api/minor-versions | ALL | `DEFAULT_QUICKBOOKS_MINOR_VERSION = 75` | None |
| **Paging.** Queries return at most 1,000 rows, paged with STARTPOSITION/MAXRESULTS. Sorting by `Id` is not allowed since 2026-01-27. | D:learn/…/data-queries; upcoming-changes blog post | ALL | Orders by `MetaData.LastUpdatedTime` only. Keyset cursor (`provider-sync.ts`). Queries use 500 rows per page. | Order among records with the same timestamp is not documented as stable (residual risk) |
| **Throttling.** 500 requests/min per realm, 10 requests/s. On 429, wait 60 s. Requests time out after 120 s. | D:learn/limits-and-throttles | ALL | A 429 sets a per-realm cooldown of at least 60 s (`accounting.ts`). Reads report whether they are safe to retry. | The client write timeout is 15 s, so more writes become uncertain; `requestid` makes retrying them safe |
| **Stale object** returns 5010 (HTTP 400). | D:develop/troubleshooting/error-codes | ALL | Mapped to `quickbooks_conflict` and never retried automatically (live sandbox step) | None |
| **Duplicate protection.** Send `requestid` (≤50 characters, unique per realm) on writes. | D:learn/learn-basic-field-definitions | REC | Every create and update sends `requestid`. The reconciler derives it from the operation key and journals each write durably in `accounting_qbo_write_attempts` (prepared → validated → started → confirmed/ambiguous/failed). An ambiguous outcome is resolved by readback before any resend (`write-reconciliation.test.ts`, `qbo-write.test.ts`). Writes are held unless `QBO_WRITES_ENABLED=on`, allow-listed in `QBO_WRITE_TYPES`, and (for production) `QBO_PRODUCTION_WRITES=on`. | Void/delete writes are not implemented and are held with a reason |
| **Sparse updates** | same | REC | Updates send `sparse: true` with `Id` and `SyncToken` | None |
| **intuit_tid logging** | D:learn/rest-api-features | REC | Recorded on errors, events and harness evidence | None |
| **BillPayment.** Lines link to Bills through `LinkedTxn` and have no `Line.Id`. Payment is `CheckPayment.BankAccountRef` or `CreditCardPayment.CCAccountRef`. | MV75 XSD (Finance.xsd) | ALL | Line identity is `linked:Bill:<TxnId>`. Only Bill applications are mirrored. Line totals must equal `TotalAmt`. | A vendor credit or journal entry applied inside a payment is an explicit exception |
| **Deposit.** A line has either a `DepositLineDetail` (with its own `AccountRef`) or a `LinkedTxn` to a Payment or SalesReceipt from Undeposited Funds. `CashBack` reduces `TotalAmt`. | MV75 XSD | ALL | The detail line's account is the offset account, not the bank. Linked lines get no inferred account. `TotalAmt` is reconciled. | A Deposit with cash back is an explicit exception |
| **Home currency** comes from `Preferences.CurrencyPrefs.HomeCurrency`. `CompanyInfo` does not carry it. | MV75 XSD | ALL | `CurrencyPrefs` is read first. A missing `CurrencyRef` is accepted only when multicurrency is confirmed off. | Whether `CurrencyRef` is always present when multicurrency is off is UNVERIFIED |
| **Deletions** appear only through CDC (`status: Deleted`, 30-day lookback, 1,000 objects) or webhooks. | D:learn/…/change-data-capture | REC | `cdc()` on the Accounting client; `syncChanges()` uses CDC within the horizon and a full replay with delete reconciliation when the watermark is missing, older than 29.5 days, or a response reaches 1,000 objects. Deletions from CDC, webhooks, or absence in a full replay write tombstones, retire lines and block affected allocations (`qbo-cdc.test.ts`). | Mocked tests only. Not yet run against the sandbox (`change_data_capture` acceptance step added). Whether the 1,000-object cap is per response or per entity is treated conservatively as per response (UNVERIFIED). |
| **Account references** show FullyQualifiedName since 2026-04-30. Write by ID. | upcoming-changes-to-accounting-apis blog post | ALL | Accounts are matched by ID only | None |

## Webhooks

| Requirement | Source | App. | Implementation evidence | Gap |
| --- | --- | --- | --- | --- |
| **Signature.** HMAC-SHA256 of the raw body using the verifier token, base64 encoded, sent in `intuit-signature`. Each environment has its own token. | D:develop/webhooks/configure-webhooks | ALL if used | `webhook.ts` uses a constant-time comparison. `POST /api/integrations/quickbooks/webhook/:environment` is registered before `express.json()` with the raw body and the per-environment token (`QBO_WEBHOOK_VERIFIER_TOKEN_SANDBOX` / `_PRODUCTION`); a bad signature returns 401 and stores nothing (`qbo-webhook.test.ts`). | Not subscribed in the Intuit portal yet; no real signed delivery has been captured |
| **Delivery.** Reply 200 within 3 s. Delivery is at-least-once and out of order. Recover missed events with CDC. | D:develop/webhooks/best-practices | ALL if used | Events are stored once per (environment, source, id) in `accounting_qbo_webhook_events`, routed to every active binding of the realm as coalescing fetch jobs, and acknowledged without provider calls. The worker fetches the current object (ordering comes from SyncToken/LastUpdatedTime); stale deletes and stale fetches after a delete are ignored. Hourly CDC catch-up recovers missed events. | Response latency under load is not measured. Requires the separate worker process to be deployed. |
| **Realm routing.** `intuitaccountid` is the realm; one delivery can carry several realms. | CloudEvents payload post above | ALL if used | Each event is routed by its own realm; a realm bound by more than one organization fans out to every active binding; an event with no active binding is recorded as `unrouted`. | None known |
| **Format.** Only the CloudEvents array format is supported since 2026-07-31. | `https://medium.com/intuitdev/upcoming-change-to-webhooks-payload-structure-2a87dab642d0` | ALL if used | Parser accepts only CloudEvents and rejects the legacy `eventNotifications` format | None |

## Production access, program and product boundaries

| Requirement | Source | App. | Implementation evidence | Gap |
| --- | --- | --- | --- | --- |
| **Production keys** appear only after the App Assessment Questionnaire is approved. This applies to private apps too. App details needed: EULA, privacy policy, host domain, launch URL, disconnect URL and reconnect URL. | D:go-live/publish-app; D:get-started/get-client-id-and-client-secret | ALL | Pages are implemented: `/legal/eula`, `/legal/privacy`, `/quickbooks/disconnected`, `/ops?section=accounting` | **Deployed site (checked 2026-09-22):** the EULA, privacy and disconnect pages show the public site's 404 page, the callback returns `{"error":"API route not found"}` (404), and `/healthz` returns 404. The questionnaire content requires sign-in (UNVERIFIED). |
| **Security.** Encrypt tokens at rest (AES) and keep the key separate. Never log credentials. Use Secure/HttpOnly cookies, HTTPS and TLS 1.2+. | D:go-live/publish-app/security-requirements | MKT (REC for 5Central Ops) | AES-GCM token cipher bound to scope (`token-crypto.ts`), security headers (`security-headers.ts`), redacted errors | None known |
| **App Partner Program.** Builder tier is free: 500,000 CorePlus (read) calls per month per workspace, blocked with 429 after that. Writes (Core) are not capped. Sandbox calls are not metered. | D:get-started/partner-faq (updated 2026-09-17) | ALL | Full replays read every object. Incremental runs use a watermark. | Monitor read volume. Which calls are CorePlus is UNVERIFIED (the help article would not load). |
| **Product boundaries.** Projects API (GraphQL) needs Silver tier or higher and a restricted scope. Payroll/Workforce is limited to partners. QuickBooks Time is a separate OAuth app. Payments needs its own scope. | D:workflows/manage-projects/get-started; D:learn/premium-apis; PT:get-started; `https://tsheetsteam.github.io/api_docs/` | ALL | Accounting scope only. Projects, Payments and money movement are disabled capabilities. QuickBooks Time is a separate integration (`server/time`). | None |
