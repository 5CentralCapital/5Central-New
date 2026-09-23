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

A stale revision returns HTTP 409 (`company_conflict`). HTTP routes are `GET /api/company/:org/work-orders` (filters include `vendorId`, `scheduledFrom`, `scheduledThrough`), `GET …/work-orders/tenant-options`, `GET …/work-orders/vendor-options`, `GET …/work-orders/document-options`, `GET …/work-orders/cost-lines`, `GET …/work-order-report`, `GET …/work-orders/:id` and `POST /api/company/:org/work-order-commands/:kind`.

## Interface

`client/src/features/work-orders` holds the list pane and the detail pane.

- The list pane has status chips, a priority filter, a property filter and search.
- The detail pane shows the reference, title and status, the priority and entry capsules, and links to the property, unit and tenant. Below those are facts, the chargeback and an activity timeline.
- Dialogs handle create/edit, status changes, notes, chargebacks, vendor assignment, QBO cost links, manual actuals and documents.
- Under 900px the list and detail switch like a push navigation.

A save whose response is lost keeps its envelope, so retrying it reuses the same operation ID. The demo (`npm run company:demo`) seeds six synthetic work orders through the command service.

## Vendors, actual cost and documents

- `work_order.vendor.assign` assigns a company contact with the vendor role or a project vendor (from `GET …/work-orders/vendor-options`, MCP `list_work_order_vendor_options`). The free-text assignee stays alongside it.
- `work_order.cost.link` links all or part of a posted QBO bill/expense line (`GET …/work-orders/cost-lines`, MCP `search_work_order_cost_lines`). The line is verified against the live mirror and reserved in the central allocation ledger under consumer `work_order`; `work_order.cost.unlink` releases it. The same line cannot be counted beyond its amount across work orders, projects and payroll.
- `work_order.actual.set` records or clears a draft manual actual; it stays labelled draft beside the linked QBO actual.
- `work_order.attachment.link` / `.unlink` attach verified company documents at the property (`GET …/work-orders/document-options`).
- Target date = reported date + 1, 3, 7 or 14 days for emergency, high, normal or low priority; aging counts days open.

All new commands are revisioned and run through the company command runner; HTTP and MCP use the same port.

## Reporting read

`WorkOrderReportingReadPort.listForReporting` (`server/work-orders/reporting.ts`; HTTP `GET /api/company/:org/work-order-report`, MCP `list_work_orders_for_reporting`) returns bounded, cursor-paged rows with aging, target date, overdue, vendor, estimate, linked and manual actual, and completion. Filters: property, status, priority, category (type), assignee (free text or vendor name), vendor, target-date and reported-date windows.

The list view `schedule` (`woView=schedule`) shows scheduled and in-progress work by scheduled date (or target date).

## Storage and follow-ups

Vendor assignment, manual actual and attachments are stored as `updated` events in `company_work_order_events.details` (keys `vendorAssignment`, `manualActual`, `attachment`) and folded on read; linked costs live in the central allocation ledger. Follow-ups: columns for vendor and manual actual, a `work_order` link kind in `company_document_links`, and adding work-order actual cost to a linked project's incurred cost (not counted today).

## Deliberately not done

- Posting tenant charges from a chargeback.
- Tenant-portal maintenance requests and photo upload.
- Recurring or preventive maintenance, and notifications.
- Import of historical Rent Manager service issues.
