# Project workspace

Projects extends the existing `/ops` manager interface. The dashboard, tenant portal and applicant flow retain their existing screens. The new route is `/ops?section=projects`; a selected record also carries its company and project IDs.

The workspace supports project creation, editing and archiving; scope estimates; approved budget versions; tasks and dependencies; and editable draft costs. The same domain commands serve authenticated web requests and Codex MCP tools. Scope, task and cost changes advance the parent project revision. Approved budgets preserve their saved lines and approval identity.

Money crosses the company boundary as exact decimal strings of integer cents. A quantity times a rate is rounded to cents using the shared exact-decimal implementation. Draft costs never count as QBO posted costs.

## Sections

- **Overview** — the canonical cost summary, schedule risk, closeout checklist, project facts and templates (apply a saved template or save this project as one).
- **Schedule** — tasks with named dependencies (edited in the task dialog), assignments, milestones, inspections and punch items.
- **Budgets & costs** — the cost summary, budget by line with the cost-to-complete override, scope lines and budget approval, QBO costs with the mirror line picker (link and release), labor, and draft costs.
- **Commitments** — the commitment ledger (received, invoiced, paid, remaining) and procurement: bids, commitments, change orders, purchase orders and vendors.
- **Draws** — the retainage payable rollforward and draw requests.

The cost figures come from one read (`/projects/:id/cost-report`); the workspace does not recompute them.

## Development

Use the stable checkout outside iCloud. Do not run a production migration during startup or use `db:push`. Migration 033 follows the frozen registry and is applied only through reviewed migration artifacts. The application needs explicit company organizations, entities, effective property mappings and active access grants; it does not infer or seed live company identities from administrator login.

```sh
npm run rent-ops:demo:build
npm run company:demo
```

The demo binds to `127.0.0.1:4176` and uses disposable, in-memory synthetic data. It never connects to live QBO or the hosted rental database. Restarting it clears its company edits.

```sh
npm run verify:quick
npm run test:all
npm run company:browser-smoke
npm run company:performance-smoke
```

The browser check exercises real forms and saved readbacks in Chromium and WebKit. The performance check measures three runs of 100 list and 100 detail requests against 200 synthetic projects and 12,000 associated records. Its local regression limit is diagnostic. It cannot satisfy the plan's deployed, concurrent-load, device, network or signed-Mac launch gates.

The browser journey also edits scope quantities, preserves two approved budget versions, loses a response after a cost commits, retries the identical command, edits the resulting cost, reloads its saved value, archives the project, changes the archive filter during the save, and returns to the existing dashboard. Screenshots and database readbacks use synthetic data only.

To run the three real PostgreSQL concurrency regressions, use an isolated development database explicitly supplied through `ROPS_PROJECT_TEST_DATABASE_URL`, then run `node --import tsx --test server/projects/concurrency.test.ts`. The ordinary test runner removes database credentials and reports these checks as skipped. It never falls back to the application's database.

## Integration boundaries

- HTTP routes: `server/company/routes.ts`; existing rental session and CSRF middleware supplies the actor.
- Codex tools: `server/company/mcp.ts`; verified OAuth subjects have separately provisioned company grants.
- Domain: `server/projects`; shared schemas: `shared/projects`.
- Storage and permission changes: migration 033, company table registry and rental deployment-security manifest.
- QuickBooks transport: `server/integrations/quickbooks`; real sandbox acceptance remains unverified.

Contractor agreements, MRA ingestion, a cost library and Mac packaging remain separate implementation packets. Pending browser save envelopes currently survive dialog changes within the active workspace; recovery across a reload, navigation away or app restart still needs the planned durable client recovery layer. This development slice is not a production release or accounting cutover.
