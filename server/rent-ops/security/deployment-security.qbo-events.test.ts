import assert from "node:assert/strict";
import test from "node:test";
import { createRentOpsSecurityManifest, renderRentOpsSecuritySql, RENT_OPS_RUNTIME_EPHEMERAL_TABLES } from "./deployment-security";

function verifiedManifest() {
  return createRentOpsSecurityManifest("staging", {
    gates: { backupVerified: true, backupAttestation: "backup-synthetic", independentAuditVerified: true, independentAuditAttestation: "audit-synthetic", schemaChecksumSha256: "a".repeat(64) },
    roleAttestation: { runtimeRoleIsNotRestrictedTableOwner: true, runtimeRoleNoInherit: true, importerRoleIsDistinct: true, auditorRoleIsDistinct: true, auditorRoleNoInherit: true },
    authorization: { productionExplicitlyAuthorized: false },
  });
}

test("QBO lifecycle events are append-only: the runtime role gets only SELECT and INSERT", () => {
  const manifest = verifiedManifest();
  const plan = renderRentOpsSecuritySql(manifest);
  assert.equal(plan.canApply, true, plan.blockingReasons.join(","));
  const table = '"accounting_qbo_connection_events"';
  const grants = plan.statements.filter(statement => statement.startsWith("GRANT") && statement.includes(table));
  assert.equal(grants.length, 1, grants.join("\n"));
  assert.match(grants[0]!, /^GRANT SELECT, INSERT ON TABLE /);
  assert.ok(grants[0]!.endsWith(`TO "${manifest.target.runtimeRole}";`), "only the runtime role is granted");
  assert.doesNotMatch(grants.join("\n"), /UPDATE|DELETE|TRUNCATE/);
  assert.equal((RENT_OPS_RUNTIME_EPHEMERAL_TABLES as readonly string[]).includes("accounting_qbo_connection_events"), false);
  // Every earlier privilege is revoked before the narrow grant is applied.
  const revokeIndex = plan.statements.findIndex(statement => statement.startsWith("REVOKE ALL PRIVILEGES ON TABLE") && statement.includes(table));
  assert.ok(revokeIndex >= 0 && revokeIndex < plan.statements.indexOf(grants[0]!));
});
