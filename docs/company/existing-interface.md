# Existing R-ops interface

Michael rejected the first new dashboard reference on September 21, 2026. Preserve the current manager dashboard and record screens while extending the existing app. The unused reference and incomplete shell are stored outside this checkout at `/Users/michaelmcelwee/Projects/r-ops-design-work/`; they are not implementation targets.

The current manager entry is `client/src/pages/rent-ops.tsx`, which selects `RmWorkspace` from `client/src/features/rent-ops/workspace/rm-workspace.tsx`. `?ui=classic` preserves the older workspace. `client/src/App.tsx` keeps `/tenant` and `/apply` independent.

`workspace-state.ts` owns section and record query parameters. Preserve `section`, `record`, `kind`, `tab`, `report`, `scope`, `property`, `asOf`, `status` and `search`, plus the centralized tenant, unit and property links. New company sections need canonical routes and aliases for existing rental bookmarks; do not replace the whole shell to add a workspace.

Reuse the existing workspace grid, record, report, banking and document patterns and the Radix controls under `client/src/components/ui`. The current palette and layout are in `workspace.css`. The separate investor portal and older investor CRM do not define the manager interface.

The company database and command foundation do not yet expose new client routes. Add new scoped queries and commands alongside the existing rental API after their contracts are verified. Local browser verification uses `server/rent-ops/demo-server.ts` with its synthetic repository and explicitly guarded synthetic frontend build.
