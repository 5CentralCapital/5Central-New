# R-ops implementation

Use the approved company-system plan and its current execution manifest. Implement dependency-ready packets and keep partial work distinct from accepted features. Preserve existing rental and payment behavior, source IDs and historical migrations.

- Shared contracts belong under `shared/`; business logic does not import HTTP, MCP or UI adapters. All mutation surfaces call the same scoped commands.
- QBO is the accounting authority per legal entity. Never present queued work as posted, or posted work as bank-settled.
- New monetary boundaries use exact signed bigint cents encoded as decimal strings. Do not convert large amounts through JavaScript floating-point numbers.
- The existing ordered SQL chain is the migration authority. Verify the frozen registry, add new reviewed migrations, and never rewrite historical SQL. Production startup cannot migrate.
- Development tests use synthetic data and isolated PostgreSQL/PGlite. Do not copy private company documents, tenant records or credentials into fixtures, source or screenshots.
- MRA upload, mapping, preview and apply are Codex-only. The app displays results read-only. Ordinary records and project costs retain full manual editing.
- Preserve the approved charcoal/gold/cream design, nine workspaces, opaque financial content and accessible controls. Tenant/applicant routes remain independent of the manager shell.
- Michael rejected the first new dashboard reference on September 21. Extend the existing R-ops interface; do not integrate the paused replacement shell. See `docs/company/existing-interface.md`.
- Run `npm run verify:quick` for a focused foundation change and relevant existing tests. Run the complete suite for cross-cutting changes. Passing unit tests does not establish performance, desktop or production acceptance.
- Work in isolated checkouts outside iCloud. Give workers disjoint files; the orchestrator owns migrations, dependencies, integration and release gates.

This repository's default development workflow does not post accounting entries, migrate production, send messages, buy subscriptions or publish releases. Those actions retain the user's task-specific authorization and the saved cutover gates.
