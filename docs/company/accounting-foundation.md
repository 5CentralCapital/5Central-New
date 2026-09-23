# Accounting foundation

5Central Ops treats QuickBooks Online as the authority for accounting facts. Local
records may carry workflow intent and attribution, but a raw QBO ID, a posted
accrual transaction, a prepared write, or a sync watermark does not establish
payment or bank settlement.

The stable consumer contract is exported from `shared/accounting`:

- `FinancialSourceReference` carries `provider`, organization, legal entity,
  environment, realm, object type, object ID, source line ID, and provider
  revision together.
- `FinancialSourceReadPort.resolveLine()` returns exact non-negative cent text,
  currency, debit/credit direction, transaction type, account and counterparty
  context, posting state, a provider watermark, and a separate settlement
  object. Bills therefore remain distinct from BillPayments and other cash
  evidence.
- `FinancialSourceReadPort.readCoverage()` reports unavailable, partial, or
  complete mirror coverage with evidence and basis. Live provider readback is
  the only evidence that can enable an operational QBO capability.
- `FinancialProviderPaymentContext` carries the provider cash account type and
  an accounting purpose proof. An unmapped account is `unknown`; matching a
  payment total never upgrades a manually classified contribution, distribution,
  principal, interest, or expense.
- `FinancialSourceAllocationPort` locks one central object+line balance. The
  line key is stable across QBO revisions, so projects and investors cannot
  each consume the same economic line independently. `linkSourceLine()` is an
  attribution relationship and does not consume the balance. Consumers that
  need to reserve or release inside a domain command use
  `mirror.forExecutor(transaction)`.

The server seam is assembled with:

```ts
const accounting = createAccountingServices(executor, options);
registerAccountingHttpRoutes(app, { executor, requireAdmin, services: accounting });
registerAccountingMcpTools(register, { executor, services: accounting, actorId });
```

`createAccountingServices()` permits startup without QBO configuration and
reports `qbo.status === "unconfigured"`. When configured it exposes a
capability-gated Accounting client and Reports client, an encrypted token
repository, OAuth state service, and `createProviderSync(scope)`. The provider
sync performs a read-only `CompanyInfo` probe before enabling
`accounting.read`, then mirrors the supported `Purchase`, `Bill`, and
`BillPayment` Accounting REST objects. Unsupported lines make coverage
partial and are not silently promoted to verified facts.

The HTTP callback consumes only the provider's `state`, `code`, `realmId`, and
error values. It recovers organization and legal entity from the server-side
hashed state, binds the flow to the authenticated browser session ID, reloads
the current entity grant, and reads CompanyInfo with the exchanged short-lived
token. A first connection is held in an encrypted, expiring pending handoff;
the browser returns to the Accounting workspace, which shows the provider
company name and legal name beside the selected 5Central Ops legal entity. Only the
administrator's explicit confirmation saves the durable environment-scoped
realm fence, the encrypted connection, and the audit record. A failed save
leaves the handoff available for a safe retry. Existing bindings still require
an exact CompanyInfo identity match. MCP cannot complete a browser OAuth state;
its connect tool returns a scoped in-app setup link for the browser flow.
The static organization-free redirect URI `GET /api/accounting/qbo/callback`
is the one registered with Intuit. It shares the same handler as the
organization-scoped callback.

`POST /api/company/:organizationId/accounting/qbo/disconnect` (and the
`disconnect_quickbooks` MCP tool) revokes the latest refresh token at Intuit.
It clears the connection, disables its capabilities, and writes an audit
receipt only after the provider accepts, or after the provider reports that the
grant is already invalid. An uncertain revoke keeps the connection for retry.
See [qbo-sandbox.md](qbo-sandbox.md) for the sandbox harness.

QBO access and refresh credentials are encrypted separately with AES-256-GCM.
The exact company/entity/environment/realm scope is authenticated data, the
encryption key is required configuration, and missing or malformed key
configuration fails closed. Refresh uses a database lease and update-only
optimistic version checks. A stale worker cannot insert a missing row or revive
a revoked connection. Reconnect uses the explicit `saveNewConnection()` path.

The registered schema is [034_accounting_foundation.sql](/Users/michaelmcelwee/Projects/r-ops/server/rent-ops/migrations/034_accounting_foundation.sql). The additive first-connection tables in [039_accounting_company_binding.sql](/Users/michaelmcelwee/Projects/r-ops/server/rent-ops/migrations/039_accounting_company_binding.sql) hold encrypted pending credentials, CompanyInfo evidence, environment-scoped realm fences, and confirmation audit rows. It keeps provider JSON only in source-object
`provider_body`; identities, revisions, amounts, lines, coverage,
checkpoints, leases, capabilities, links, and central allocations remain
relational. Disposable database tests apply the canonical chain through migration 34.
Historical migrations 1 through 33 remain unchanged. Production migration and database attestation are separate release gates.

Raw JSON numbers arriving from QBO retain their exact decimal text before parsing. Amounts are
converted with bigint arithmetic, and rejected when they contain sub-cent
precision or exceed the supported range. No local accrual movement is used to
fabricate a cash-basis report. The Reports adapter calls the native endpoint
with its supported parameters and fails closed when the returned report header
does not match the requested basis, period, currency assertion, or filter.

The endpoint and report behavior were checked against Intuit's primary
references: [OAuth 2.0](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization), [Accounting API collection](https://www.postman.com/intuit-developer/intuit-developer-quickbooks-online-accounting-api/documentation/4884662-e6c576f1-f6d3-440f-b090-da9ff1ac519d), and [ReportHeader reference](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/50c0056c-b710-cb65-a15e-654a32f48a6b.htm). No live QBO credentials or network mutation are used by the implementation or focused tests.

## Integration operations (U05/U06, 2026-09-23)

This section describes code in this branch. None of it has been exercised
against a live QuickBooks company; the sandbox harness step
`change_data_capture` and the webhook checklist item are the live proofs that
remain.

### Durable jobs and the worker

`server/jobs/` implements the queue in migration 046. `PostgresJobQueue`
enqueues idempotently by `job_key`, claims with `FOR UPDATE SKIP LOCKED` under
a lease, and fences every later transition (heartbeat, checkpoint, complete,
fail, release) by state, lease owner and attempt number. Failures retry with
exponential backoff and bounded jitter (50–100% of `min(1 h, 5 s·2^(n−1))`),
an explicit `RetryLaterJobError` delay (QBO 429) wins over a shorter backoff,
and a job is dead-lettered after `max_attempts` or a `PermanentJobError`.
`reapExpiredLeases()` returns expired leases to retry and records the attempt
as `lease_expired`. Operators (organization owner/admin only) list, inspect,
requeue (`dead → queued` with more attempts; attempt numbering continues) and
cancel (never a running job) through `job.requeue` / `job.cancel` commands on
the shared command runner; HTTP `/api/company/:org/jobs…` and MCP
`list_jobs`, `get_job`, `requeue_job`, `cancel_job` call the same port.
Stored error messages are redacted (tokens, secrets, URLs with credentials,
JWTs, long opaque strings) and bounded to 500 characters.

`dispatchOutboxEvents()` moves ready `company_outbox` rows into jobs in one
statement (`job_key = 'outbox:<id>'`, `outbox_event_id`, `dispatched_at`), so
concurrent dispatchers take disjoint batches and a replay cannot create a
second job.

`server/worker.ts` is a separate process (`npm run worker`, `worker:dev`;
Render `type: worker` service). It registers `outbox.dispatch`, `jobs.reap`,
`accounting.qbo.sync`, `accounting.qbo.webhook_event` and
`accounting.qbo.write`, writes `company_worker_heartbeats`, backs off when
idle, and on SIGTERM stops claiming, waits for running handlers, then releases
unfinished leases. Periodic work uses time-bucket keys:
`outbox.dispatch:system:<minute>`, `jobs.reap:system:<5-minute bucket>`, and
`qbo.sync:<org>:<entity>:<env>:<realm>:<yyyy-mm-ddThh>` per active connection.
Job rows are never deleted by the runtime role (no DELETE grant); retention
needs a reviewed archival path later.

### QuickBooks transport

- **Webhook.** `POST /api/integrations/quickbooks/webhook/:environment` is
  registered before `express.json()` with a raw body. It verifies
  `intuit-signature` with `QBO_WEBHOOK_VERIFIER_TOKEN_SANDBOX` or
  `_PRODUCTION`; a bad signature is 401 and nothing is stored. Each
  CloudEvent is stored once in `accounting_qbo_webhook_events` keyed by
  (environment, source, id). A new event is routed to every active binding of
  that environment + realm (a realm is unique only per organization and
  environment) as one fetch job per (binding, object); pending jobs for the
  same object coalesce. An event with no binding is `unrouted`; an entity that
  is not mirrored is recorded and `processed`. The request makes no provider
  call. The job fetches the object through that binding's connection and
  mirrors it, or tombstones it for a delete notice; an object that vanished
  queues a catch-up.
- **CDC and replay.** `QuickBooksAccountingClient.cdc()` calls `/cdc`
  (≤ 30-day lookback; a 1,000-object response is treated as truncated).
  `createProviderSync(scope).syncChanges()` uses the `changes` checkpoint: no
  watermark, a watermark older than 29.5 days, or a truncated CDC response
  triggers a scoped full replay with delete reconciliation; otherwise CDC runs
  from the watermark minus a five-minute overlap. A full replay whose streams
  all fetched anchors the chain (`cursor = verified:<time>`). Coverage stays
  partial until that anchor exists and no exceptions are open.
- **Tombstones.** `mirror.recordDeletion()` appends
  `accounting_qbo_deletion_tombstones`, marks every mirrored revision
  `deleted_at`, retires the object's lines (not current, voided, unsettled)
  and blocks allocations that consumed them (`allocation_blocked`; allocation
  rows are kept for review). A deletion notice older than a mirrored live
  revision is ignored as stale. Readers exclude deleted objects. A later,
  strictly newer revision re-creates the object; an inferred full-replay
  deletion is undone when the same revision reappears. Full-replay deletions
  also keep the `missing_from_full_replay` exception open; explicit webhook or
  CDC deletions resolve the object's exceptions.
- **Writes.** `createQboWriteService()` is the only path that posts. It holds
  any write that is unsupported (void/delete are not implemented), disabled
  (`QBO_WRITES_ENABLED` off by default), not allow-listed (`QBO_WRITE_TYPES`)
  or aimed at production without `QBO_PRODUCTION_WRITES=on`, with the exact
  reason. Supported writes are journaled in `accounting_qbo_write_attempts`
  (`prepared → validated → started → confirmed | ambiguous | failed`) through
  `PostgresQuickBooksWriteJournal`. An unknown outcome is `ambiguous` and the
  next attempt reads back (by record Id, a natural key, or a resend under the
  same `requestid`, which Intuit de-duplicates); it is never blindly reposted.
  A stale SyncToken (fault 5010) is a definitive rejection (`failed`) that
  requires a reread and a new operation key.

### Rental accounting bridge

- **Posting ownership.** `accounting.rental_posting_policy.set` / `.close`
  commands keep one method per entity and period (the command checks overlap;
  the migration 047 trigger is the backstop). Native receivables require
  `invoiceDeliveryVerified`; switching method needs an opening balance bridge
  reference. `rentalPostingMethodFor()` resolves the policy for a date and
  `assertRentalPostingMethod()` refuses posting with no policy, a different
  method, or activity before the cutoff.
- **Summary bridge preview.** `previewRentalBridge()` builds control totals
  for an entity and period from the rental ledger (charges, credits, receipts
  split tenant/subsidy/other, deposit receipts, deposits received and held,
  reversals, adjustments, net receivable change). Voided, pending and unknown
  rows are excluded and counted; an unknown amount is never treated as zero.
  JSON and CSV export only; nothing is posted.
- **PM settlements.** Commands create, update (new append-only line set per
  header revision), reconcile (bank reference and date required when a
  remittance is present), and mark/clear exceptions. Lines must total each
  header field by kind and held funds must roll forward. The read model
  reports collections (deposits separated), PM costs, remittance, held funds
  and differences; a $1,000 receipt with $100 of costs and a $900 remittance
  reports $1,000 collected, $100 costs and $900 remitted.
- **Health and close.** Connector health (per binding) reports connection
  state, last sync and change capture, lag, coverage, open exceptions, active
  tombstones, job backlog/failures, last webhook, 429 cooldown and worker
  liveness. The period close checklist is read-only and never locks QBO.

## External acceptance gates

Before enabling live operations, root should complete a dedicated synthetic
QBO sandbox proof for CompanyInfo readback, one Purchase/Bill/BillPayment
mirror, report basis/period readback, create/readback, update/readback with
SyncToken, stale update rejection, refresh rotation, revoke/reconnect,
change data capture after a full replay, and one real signed webhook delivery
routed to a fetch job. Capture only safe scope, status, timestamps,
and Intuit trace IDs. A local checkpoint or accepted write request is not a
provider readback.
