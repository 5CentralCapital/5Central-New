# Accounting foundation

R-Ops treats QuickBooks Online as the authority for accounting facts. Local
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
company name and legal name beside the selected R-Ops legal entity. Only the
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

## External acceptance gates

Before enabling live operations, root should complete a dedicated synthetic
QBO sandbox proof for CompanyInfo readback, one Purchase/Bill/BillPayment
mirror, report basis/period readback, create/readback, update/readback with
SyncToken, stale update rejection, refresh rotation, revoke/reconnect, and
webhook signature verification. Capture only safe scope, status, timestamps,
and Intuit trace IDs. A local checkpoint or accepted write request is not a
provider readback.
