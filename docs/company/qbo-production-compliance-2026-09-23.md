# QuickBooks Online production compliance review — September 23, 2026

Scope: the QuickBooks Online Accounting API integration on `claude/qbo-production-release`
(and the receivables work on `claude/qbo-financial-source`), reviewed against Intuit's current
public requirements and API changes before switching the live app from sandbox to production.
Sources: Intuit Developer blog posts on minor versions, refresh-token policy, CloudEvents webhooks,
Reports v2, query/Id changes and account-name changes; Intuit SDK reference implementations; the
App Partner Program guide (v1.2, March 2026); the live OAuth discovery documents. Several
developer.intuit.com pages render client-side and could not be fetched; items marked
"confirm in sandbox" are where the public sources disagree or are silent.

## Summary

The integration meets the current requirements for a read-only production connection. One
correctness defect was found and fixed in this review (inactive list records read as deletions).
Two process items remain before enabling webhooks and change-data-capture in production: tell the
Intuit case contact (the questionnaire answered "No" to both) and register the webhook endpoint.
Writes stay off.

## Requirement-by-requirement

| # | Requirement (source) | Status | Evidence / action |
|---|---|---|---|
| 1 | **OAuth 2.0 with discovery document**; endpoints from `https://developer.api.intuit.com/.well-known/openid_configuration` (production) | Pass | `server/integrations/quickbooks/oauth.ts` resolves endpoints from discovery (24 h cache, documented fallback). |
| 2 | **Least scope**: request only what is used | Pass | Authorization requests `com.intuit.quickbooks.accounting` only (`getAuthorizationUrl`). No Payments scope. |
| 3 | **CSRF state** bound to the session, single use, short-lived | Pass | Hashed state, 10-minute expiry, bound to session and actor; replay rejected (`oauth-state.ts`). |
| 4 | **Exact HTTPS redirect URI** registered for production | Pass | `https://5central.capital/api/accounting/qbo/callback` registered Sept 23; `npm run company:qbo-preflight` checks the env value matches exactly. |
| 5 | **Access token 1 h; refresh tokens rotate** — persist the newest refresh token every time; old one dies 24 h later | Pass | Compare-and-save rotation with a database refresh lease so only one worker refreshes per company (`token-manager.ts`, `refresh-lease.ts`). |
| 6 | **Refresh-token 5-year hard expiry** (policy Nov 2025); request `x_refresh_token_hard_expires_in` | Pass | Sends `x-include-refresh-token-hard-expires-in: true` and stores the hard expiry (`oauth.ts`). |
| 7 | **Reconnect URL mandatory** (since Feb 24 2026); `invalid_grant` → reconnect | Pass / confirm | `invalid_grant` marks the connection `needs_reconnect`; the reconnect entry is `/ops?section=accounting`. Confirm the Reconnect URL field in the portal. |
| 8 | **Disconnect**: revoke tokens at Intuit, stop access, Disconnect URL page | Pass | Revoke then clear credentials and capabilities; uncertain revoke keeps the connection for retry; `/quickbooks/disconnected` page. |
| 9 | **Token security**: never log or expose tokens; encrypt at rest | Pass | AES-256-GCM with scope-bound AAD (`token-crypto.ts`); errors carry fault codes only. One key for web and worker: it lives in the shared `5central-ops-production` group; the preflight checks it decodes to 32 bytes. |
| 10 | **minorversion 75** on every request (versions 1–74 retired Aug 2025) | Pass | `DEFAULT_QUICKBOOKS_MINOR_VERSION = "75"` applied to reads, queries, CDC, writes and reports; tested. |
| 11 | **Throttling**: 500 req/min/realm, 10 concurrent; back off on HTTP 429 | Pass | 429 sets a per-realm cooldown of `Retry-After` or 60 s; worker batch size 4 keeps concurrency low. |
| 12 | **`intuit_tid`** captured for support | Pass | Captured on every response and persisted with write attempts and capability evidence. |
| 13 | **No `ORDERBY Id`, no `Id >/</!=` filters** (removed Jan 2026 / Oct 2025) | Pass | Queries page by `MetaData.LastUpdatedTime` with a keyset cursor; tested (`qbo-list-queries.test.ts`). |
| 14 | **Inactive name-list records** are hidden unless the query names `Active` | **Fixed** | List queries now include `Active IN (true, false)` for Account/Customer/Vendor/Employee/etc. Before the fix a full replay tombstoned deactivated accounts. |
| 15 | **`AccountRef.name` returns the full path** (Apr 2026) — match on `value` | Pass | Mapping uses `AccountRef.value` only. |
| 16 | **CDC**: ≤30-day look-back, ≤1,000 objects, deleted stubs | Pass | Falls back to a full replay 12 h before the horizon or on a capped response; `status: "Deleted"` tombstones. |
| 17 | **Webhooks: CloudEvents only** (legacy format retired July 31 2026); HMAC-SHA256 `intuit-signature` over raw bytes; respond fast | Pass | Raw-body verification before parsing, constant-time compare, legacy envelope rejected, durable dedupe by (source, id), 200 after persisting (no provider call), 401 on bad signature, 503 without a verifier token. |
| 18 | **Webhooks are hints; reconcile** (deliveries can be missed) | Pass | Hourly CDC catch-up per connection; webhook fetches coalesce per object. |
| 19 | **Reports v2** (Aug 31 2026): nulls are `""`, row order dynamic, parse by key | Pass | Report engine maps `""` to null and walks nested rows; rows are labeled by column titles. `providerPath` uses row position only as an identifier within one run. |
| 20 | **Idempotent writes** with `requestid`; resolve uncertain outcomes before retrying | Pass | Stable request id per operation key; ambiguous creates without a natural key are held for manual review, never resent (`qbo-write.ts`, `write-reconciliation.ts`). |
| 21 | **Stale object (5010)** handling with SyncToken | Pass | Sparse updates with the read SyncToken; 5010 → conflict, re-read required. |
| 22 | **Invoices created by API are not delivered unless sent** | Pass | No send endpoint exists in the client. New guard: any Invoice write must set online card/ACH/IPN payment false and `EmailStatus` `NotSet`, and the saved record is verified. Confirm in sandbox that company defaults do not queue API invoices. |
| 23 | **Payment void** uses `operation=update&include=void` | N/A | Void/delete writes are not supported (held). |
| 24 | **Read metering** (App Partner Program: Builder tier 500,000 CorePlus reads/month, blocked above) | Pass | CDC-based hourly sync ≈ 4,300 reads/month for three companies plus webhook fetches and initial full replays; far below the cap. Avoid scheduled full replays. |
| 25 | **Sandbox/production separation** | Pass | Connections, bindings, capabilities and mirror rows are keyed by environment; the server runs one environment; `company:qbo-sandbox` refuses production. |
| 26 | **Production writes** gated | Pass | `QBO_WRITES_ENABLED`, `QBO_WRITE_TYPES` and `QBO_PRODUCTION_WRITES` all required, plus per-company live read-back capability evidence. Blueprint pins both switches `off`. |
| 27 | **App assessment answers stay accurate** | **Action** | The questionnaire answered "No" to webhooks and CDC. The worker runs hourly CDC as soon as a company is connected. Notify the Intuit case contact (case 00228254) before connecting production companies, and before registering webhooks. |
| 28 | **EULA, privacy, launch, disconnect URLs** on the production host | Pass | Served by the same app on `5central.capital`; unchanged by the Render move. |

## Changes made in this review

- `server/accounting/provider-sync.ts`: list queries include inactive records (item 14).
- `server/accounting/qbo-write.ts`: record-only Invoice guard and post-save verification (item 22).
- `scripts/company/qbo-production-preflight.ts`: explicit `off` write switches read as intended.
- Hosting (Codex's `render.yaml`, verified): all `QBO_*` values in the shared group attached to
  both the web service (OAuth callback, webhooks) and the worker (sync, CDC, fetches); both write
  switches pinned `off` on both services.

## Before the first production connection

1. Notify Intuit (item 27).
2. Set the production values in `5central-ops-production`; run
   `npm run company:qbo-preflight -- --network --database` in a Render web shell.
3. Connect one company at a time and reconcile a closed month before the next.
4. Keep writes off until the read-only comparison and the books cleanup are signed off.
