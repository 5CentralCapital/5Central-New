# Work orders

Packet O01 adds maintenance work orders to the `/ops` manager interface. The route is `/ops?section=work-orders`; `woView` selects a status view and `record` the selected work order. The top navigation's Work Orders menu opens Open work orders, All work orders, Completed work and New work order. Schedule calendar, Vendors and Preventive maintenance stay Planned.

## Model

Migration 040 (`040_company_work_orders.sql`) adds two tables, registered in the frozen migration registry, company table registry and deployment-security manifest.

- `company_work_orders` stores a UUID ID (shown as `WO-` plus its first eight hex digits), company, legal entity, property (required) and optional unit, tenancy/person and project links. Rental links use the existing rental IDs. It also stores title, description, category (plumbing, electrical, hvac, appliance, general, turnover/make-ready, pest, exterior, other), priority (emergency, high, normal, low), status, reported, scheduled and completed dates, assignee (free text), entry permission, estimated cost cents, record revision, created/updated by and timestamps. Identity columns (company, entity, property, currency and creator) are immutable, and rows cannot be deleted.
- `company_work_order_events` is the append-only status and activity history: creation, edits (changed field names), status changes with from/to and note, notes, project link changes and chargeback changes. Each row carries the actor, operation ID and resulting record revision. The runtime role can only insert and select these rows, and a trigger rejects updates and deletes.

Statuses: `new → scheduled → in_progress → on_hold → completed | canceled`. The allowed transitions are in `shared/work-orders/transitions.ts`. Putting work on hold, canceling it or reopening completed or canceled work requires a note. Scheduling requires a scheduled date. Completing work sets a completed date, which cannot precede the reported date, and reopening clears it.

A chargeback is only an intent: a positive amount in cents and a description, and it requires a linked tenant. It can also point to a tenant charge that was already posted, by that charge's ledger transaction ID. The link must be a posted `charge` at the same property and for the same tenant, and one charge can back only one work order. Work orders never create, change or post ledger entries. Completing a work order does not mean it was paid or that its costs were posted.

## Commands and reads

Contracts are in `shared/work-orders/contracts.ts`. The browser, Codex and the demo seed all run commands through `executeWorkOrderCommand` (`server/work-orders/commands.ts`) inside the shared company command runner. That runner provides idempotent operation IDs, reloads grants inside the transaction and records receipts.

| Command | Codex tool | Notes |
| --- | --- | --- |
| `work_order.create` | `create_work_order` | Needs a legal-entity scope. The property must be mapped to that entity. A tenancy defaults to its primary person. |
| `work_order.update` | `update_work_order` | Revision-checked. Rechecks the unit and tenant links. |
| `work_order.status.change` | `change_work_order_status` | Revision-checked. Enforces the transition rules. |
| `work_order.note.add` | `add_work_order_note` | Appends history. A revision is optional. |
| `work_order.project.link` | `link_work_order_project` | Revision-checked. Links an active project at the same property, or `null` to unlink. |
| `work_order.chargeback.set` / `.clear` | `set_work_order_chargeback` / `clear_work_order_chargeback` | Revision-checked. Records intent only. |

Reads, available in `list_work_orders`, `get_work_order` and `list_work_order_tenant_options`, use the same paired company grants and roles as projects:

- The list shows open work by default. It filters by property, unit, status set, priority, category, assignee and text (title, description, property, unit, tenant, vendor or `WO-` number). It sorts by priority and then by reported date, and pages with a keyset cursor.
- The detail read includes the history and the next allowed statuses.

A stale revision returns HTTP 409 (`company_conflict`). HTTP routes are `GET /api/company/:org/work-orders`, `GET …/work-orders/tenant-options`, `GET …/work-orders/:id` and `POST /api/company/:org/work-order-commands/:kind`.

## Interface

`client/src/features/work-orders` holds the list pane and the detail pane.

- The list pane has status chips, a priority filter, a property filter and search.
- The detail pane shows the reference, title and status, the priority and entry capsules, and links to the property, unit and tenant. Below those are facts, the chargeback and an activity timeline.
- Dialogs handle create/edit, status changes, notes and chargebacks.
- Under 900px the list and detail switch like a push navigation.

A save whose response is lost keeps its envelope, so retrying it reuses the same operation ID. The demo (`npm run company:demo`) seeds six synthetic work orders through the command service.

## Deliberately not done

- Vendor directory and vendor assignment by contact record. The assignee is free text.
- Bills, cost posting, purchase orders and linking actual costs to QBO. The estimate is informational only.
- Posting tenant charges from a chargeback.
- Tenant-portal maintenance requests, photos and attachments.
- Scheduling calendar, recurring or preventive maintenance, and notifications.
- Import of historical Rent Manager service issues.
