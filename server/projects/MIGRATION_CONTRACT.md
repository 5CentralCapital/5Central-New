# Project storage contract

The executable schema is `server/rent-ops/migrations/033_company_projects.sql`, verified by the frozen company migration registry. Do not maintain a second copy of its SQL here. Prior migrations remain unchanged.

The eight project tables store projects, scope items, budget versions and lines, tasks and dependency edges, manual draft costs, and verified QBO actuals. UUIDs identify company records; existing property and unit IDs retain their original values. New money uses signed bigint cents encoded as decimal strings. Quantities use exact numeric(24,12).

Project organization, legal entity, property, and currency identities are immutable. A selected unit must belong to the property. Composite keys prevent cross-company and cross-project links; all financial children use their project's currency. Commands recheck current grants, active company/entity/property state, and effective ownership inside the same transaction.

Every child mutation advances the parent project revision. The parent write serializes simultaneous edits, budget approval, dependency changes, and archive operations. Task cycles are rejected, and a task cannot be archived while an active task depends on it. Real PostgreSQL concurrency coverage is in `concurrency.test.ts`, enabled only by an explicit `ROPS_PROJECT_TEST_DATABASE_URL` against an isolated development database.

Budget approval creates a draft version, copies current scope, then seals it in one transaction. Approved lines reject additions, edits, and deletes; a later approval only supersedes the prior version. Manual drafts are editable and nonnegative. QBO actuals are immutable, may contain negative credits, and are read-only for the web runtime. The synchronization worker and its restricted database role are not implemented in this slice.

Deployment grants are defined in `server/rent-ops/security/deployment-security.ts`. Budget lines receive SELECT/INSERT only, dependency edges allow atomic replacement, and posted actuals receive SELECT only. Project records are excluded from the legacy rental importer.
