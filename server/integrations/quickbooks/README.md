# QuickBooks Online boundary

This folder contains the offline-testable QuickBooks Online OAuth and Accounting REST adapter. It is deliberately limited to the `com.intuit.quickbooks.accounting` scope (plus optional OpenID identity scopes) and the QBO Accounting REST API. It does not request or implement Payments, money movement, or GraphQL Projects. A QuickBooks Plus subscription is not treated as proof that a premium Projects GraphQL capability is available.

The adapter uses these provider endpoints:

| Purpose | Endpoint |
| --- | --- |
| Authorization | `https://appcenter.intuit.com/connect/oauth2` |
| Token exchange and refresh | `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer` |
| Token revoke | `https://developer.api.intuit.com/v2/oauth2/tokens/revoke` |
| OAuth discovery (sandbox) | `https://developer.api.intuit.com/.well-known/openid_sandbox_configuration` |
| OAuth discovery (production) | `https://developer.api.intuit.com/.well-known/openid_configuration` |
| Accounting sandbox | `https://sandbox-quickbooks.api.intuit.com/v3/company/{realmId}` |
| Accounting production | `https://quickbooks.api.intuit.com/v3/company/{realmId}` |

The OAuth client always uses Basic authentication for the app credentials, form-encoded token requests, and the latest `refresh_token` returned by Intuit. Access tokens are normalized to absolute expiry times. The token manager serializes refreshes per organization/legal-entity/environment/realm scope within one process and saves the rotated token with an optional optimistic version. This in-process lock is not a cross-worker lease: the root database layer must add an atomic lease or advisory lock before running multiple workers. A repository conflict is re-read once and used only when the winner is already valid; it is never overwritten blindly.

The Accounting client supports read-by-ID, QBO query reads, create, and update. Updates require the caller to provide the current `Id` and `SyncToken`; the adapter sends both in the update payload. GET failures expose a safe retry classification. POST failures from timeouts, transport failures, 408, 429, 5xx, or an unparseable success response are `quickbooks_ambiguous_write` and must be reconciled before another write is attempted. The adapter performs no automatic retries.

The capability constants describe adapter implementation coverage only. They do not attest that a connected realm or subscription has access. The per-connection capability check defaults to disabled, and the root integration layer must provide current evidence before enabling a capability. Payments, money movement, and Projects GraphQL remain disabled.

Webhook verification must receive the exact raw request bytes before JSON parsing. `verifyQuickBooksWebhookSignature` checks the base64 HMAC-SHA256 digest against the `intuit-signature` header in constant time.

## Persistence contract for the integration owner

The root integration layer owns storage and routes. It can implement `QuickBooksTokenRepository` with the following boundaries:

* `load(scope)` is keyed by `organizationId`, `legalEntityId`, `environment`, and `realmId`; a realm ID alone is not an account key.
* `save(scope, token, expectedVersion?)` stores encrypted access and refresh tokens, expiry timestamps, and an incremented version. It must reject an `expectedVersion` mismatch rather than replacing a newer rotated token. Cross-worker refresh needs a database lease or advisory lock around the refresh plus this compare-and-save.
* `revoke(scope)` clears or tombstones the local token after the provider revoke succeeds. A failed or uncertain revoke must remain retryable.
* Do not log or return token values. Store only safe provider metadata such as the last `intuit_tid`, connected environment, realm, and timestamps in an audit record owned by the root integration layer.

When a write needs asynchronous reconciliation, the root command may enqueue an outbox record in its existing company outbox. The compact payload should contain `organizationId`, `legalEntityId`, `environment`, `realmId`, `entity`, `operation`, the local operation/idempotency key, and the provider trace ID if known. It must not contain OAuth tokens or unredacted provider bodies. An outbox event is local intent or reconciliation work; it is not evidence that QBO posted the write.

## Sources checked

These links were checked on 2026-09-21 before the endpoint and behavior assumptions were implemented:

* [Intuit OAuth 2.0 documentation](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization) — authorization-code flow, realm ID, bearer access tokens, 3,600-second access-token lifetime, rolling refresh-token expiry, latest-token rotation, and revoke behavior.
* [Intuit OAuth Node client](https://github.com/intuit/oauth-jsclient) — current token endpoint and authorization header behavior used by the official client.
* [Intuit QuickBooks Online Accounting API Postman collection](https://www.postman.com/intuit-developer/intuit-developer-quickbooks-online-accounting-api/documentation/4884662-e6c576f1-f6d3-440f-b090-da9ff1ac519d) — Accounting REST request shapes and `SyncToken` update examples.
* [Intuit SyncToken reference](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/5d539a7b-9e16-5085-3ecc-e0ab5dff7504.htm) — stale `SyncToken` updates fail and the latest token is required.
* [Intuit webhook SDK reference](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/f6a1e36a-ebb4-e097-4815-2e344f822f76.htm) — webhook signature verification requirement.
* [Intuit webhook sample](https://github.com/IntuitDeveloper/SampleApp-Webhooks-Java-Cloudevents) — current CloudEvents fields and verifier-token configuration example.

The current implementation has no live credentials and has not made live or sandbox requests. The checklist below remains an acceptance gate; passing the mocked tests in this folder is not a sandbox validation attestation.

## Sandbox acceptance checklist

Run these with a dedicated Intuit developer sandbox and synthetic records only. Capture request method/host/path, status, `intuit_tid`, and verified QBO read-backs without recording credentials or raw token values.

- [ ] Connect: authorization state is generated and checked; callback realm ID is bound to the selected environment and legal entity; code exchange returns access and refresh tokens; only the encrypted repository stores them.
- [ ] Connect rejection: `access_denied`, invalid state, wrong redirect URI, and an environment/realm mismatch leave no usable token record.
- [ ] Read: `CompanyInfo` and one synthetic Accounting entity are read from the sandbox host, with the expected realm in the path and a successful read-back.
- [ ] Create: create one disposable synthetic Accounting record; capture the provider response and then read it back by returned ID. Do not infer success from a local queued event.
- [ ] Update: read the record, update a safe field using the returned `Id` and `SyncToken`, then read it back and confirm the changed value and incremented `SyncToken`.
- [ ] Stale update: submit the old `SyncToken`; record the provider conflict and confirm the adapter does not retry or overwrite the current record.
- [ ] Disconnect: revoke the latest refresh token, clear the local record only after provider acceptance, and confirm subsequent use requires reconnect.
- [ ] Reconnect: authorize the same legal entity and realm again, confirm the new refresh token replaces the old one, and repeat a read.
- [ ] Refresh rotation: force an expired access-token path, confirm refresh occurs once per connection scope, and verify the latest returned refresh token is the one persisted.
- [ ] OAuth failures: record sanitized behavior for invalid grant, expired refresh token, malformed token response, timeout, 429, and 5xx; confirm no token values or raw bodies appear in logs/errors.
- [ ] API failures: record 401, validation 400, stale-token 409, 429, 5xx, timeout, and malformed-success behavior. GET retries may be operator-controlled; writes must be marked uncertain where delivery is unknown and must be reconciled before retry.
- [ ] Webhook: capture one real signed sandbox webhook, verify the exact raw body with `intuit-signature`, reject a changed body and wrong verifier token, and parse only after verification.
- [ ] Capability gate: confirm Payments, money movement, and Projects GraphQL requests are unavailable/disabled until separately supported and approved; no Plus subscription inference is accepted.
