# Employee time

Employee time is an R-ops review and costing workspace backed by QuickBooks Time (TSheets). QuickBooks Time remains the place where employees clock in and out. R-ops mirrors those records so an administrator can review, correct, map, approve, and estimate labor before accounting work uses the result.

## Boundary

The connection is a QuickBooks Time connection. It is separate from QuickBooks Online accounting OAuth and uses its own client credentials, redirect URI, environment, provider company ID, access token, and refresh token. The first browser setup starts with the selected legal entity; QuickBooks Time supplies the provider company identity during OAuth, so an administrator never has to type that ID. A missing or malformed runtime configuration leaves the service unavailable; it does not create a sandbox connection or fall back to synthetic data.

R-ops never writes time records back to QuickBooks Time, posts payroll, creates subscriptions, or runs a live-write provider job. Corrections, review actions, employee mappings, and jobcode mappings are company commands saved in R-ops. Every command has a stable operation ID, idempotency key, receipt, retry path, and audit event.

## Provider record meaning

The source normalization keeps the provider's distinction between:

- a regular entry with an explicit start timestamp and optional end timestamp;
- a manual entry with a calendar date and duration in seconds; and
- a clocked-in entry with no end timestamp.

R-ops stores timestamps with their explicit offset and timezone name. It calculates elapsed duration from the timestamps for regular entries, which preserves cross-midnight and daylight-saving transitions. A manual entry never receives synthetic start or end timestamps. An entry with an impossible or mismatched duration stays visible with an `invalid_duration` conflict for review.

QuickBooks Time's `locked` flag is stored as provider state. It is not treated as approval. The employee source record's `submitted_to` and `approved_to` dates are stored separately so an administrator can tell whether a locked entry is merely submitted, approved through a date, or still awaiting R-ops review. The provider's one-active-timesheet rule is enforced again while mirroring; a second active clock-in becomes a conflict and is not silently merged.

## Sync and source evidence

The sync reads `users`, `jobcodes`, `timesheets`, and `timesheets_deleted` through the official modified-since and paginated endpoints. Each stream has its own checkpoint and watermark. A page limit or object failure produces partial coverage and leaves the prior checkpoint in place so the next run can overlap the last known timestamp safely. Deleted timesheets become inactive R-ops rows and a source tombstone; a later live page cannot erase that deletion history.

The provider response body, source version, body hash, last-modified timestamp, and receipt time are retained as source evidence. Read responses identify the environment and provider company in the source reference and expose coverage status (`unavailable`, `partial`, or `complete`) with the observed watermark.

## Review, mapping, and labor costing

The review state is independent of provider state: `needs_review`, `corrected`, `approved`, or `rejected`. Approval requires an active employee mapping, an active jobcode mapping, no unresolved provider conflict, and an active source record. A provider deletion or changed source record brings an approved entry back to review.

Employee mappings connect a provider user to an R-ops company contact for an effective date range. Hourly rates are optional exact cents with an explicit currency and cannot overlap for the same provider employee. Jobcode mappings connect a provider jobcode to a property, project, and optional cost code.

Estimated labor is calculated in integer cents with half-up rounding from `duration_seconds × hourly_rate_cents ÷ 3,600`. It is a separate R-ops estimate. Posted payroll amounts, when a source is later attached, remain separate fields and are never inferred from the estimate.

## Server contracts

`createTimeServices` builds the store, sync service, command runner, token repository, OAuth state service, refresh lease, and authenticated read port. Expiring provider access tokens use a scoped database lease, a reread after lease acquisition, and compare-and-save fencing so concurrent sync workers cannot overwrite a newer refresh-token rotation. The read port starts a read-only SQL transaction for each call, reloads active company grants inside that transaction, reauthorizes the requested scope, and only then reads through the transaction-bound store.

`registerTimeHttpRoutes` exposes the same business service to the browser:

- `GET /api/company/:organizationId/time/entries`
- `GET /api/company/:organizationId/time/users`
- `GET /api/company/:organizationId/time/jobcodes`
- `GET /api/company/:organizationId/time/employee-mappings`
- `GET /api/company/:organizationId/time/jobcode-mappings`
- `GET /api/company/:organizationId/time/coverage`
- `POST /api/company/:organizationId/time/sync`
- `POST /api/company/:organizationId/time-commands/:commandKind`
- `POST /api/company/:organizationId/time/connect`
- `GET /api/company/:organizationId/time/callback`

Every read and sync request carries an explicit `production` or `sandbox` environment. The server does not silently choose sandbox. OAuth starts only in the authenticated browser session; state is stored hashed, bound to that session and actor, consumed once, expires, and must return the provider company identity. Reconnect may supply an existing provider identity to the setup endpoint, while first connection setup leaves it blank until the provider returns it.

`registerTimeMcpTools` exposes the same reads, sync action, browser-setup handoff, and command kinds through MCP. MCP cannot complete browser OAuth. Both adapters use the same company command receipt and retry semantics.

## Source references

Provider endpoint and object behavior were verified against the [QuickBooks Time API documentation](https://tsheetsteam.github.io/api_docs/) and [QuickBooks Time API guide](https://developers.tsheets.com/docs/api/). The implementation follows the documented token expiry and refresh-token grant flow, regular versus manual timesheet shapes, modified-since pagination, and deletion retention behavior.

The schema is registered as migration 36, `036_company_employee_time.sql`. It is applied only by the reviewed migration process; production startup does not migrate.
