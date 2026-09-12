/** Private evidence stays outside the repository. This CLI has no scenario-specific defaults. */
import { readFile, open, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRentOpsRuntimeDatabase } from "../server/rent-ops/runtime-database";
import { createPostgresRentOpsRepository } from "../server/rent-ops/repositories/postgres";
import { reconcileImportedRecords, reconciliationHash } from "../server/rent-ops/reconciliation/operator";
import { readPack, bytesHash, requireGuard, snapshotHash, buildMaintenanceManifest, verifyMaintenanceReadback, MaintenanceGuardError } from "../server/rent-ops/reconciliation/maintenance";
import type { RentOpsSnapshot } from "../shared/rent-ops-contracts";
const args = process.argv.slice(2), mode = args.shift();
function option(name: string) { const i = args.indexOf(`--${name}`); requireGuard(i >= 0 && !!args[i + 1], `missing_${name}`); return args[i + 1]; }
async function durable(path: string, value: unknown) { const file = await open(path, "wx", 0o600); try { await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.sync(); } finally { await file.close(); } }
async function main() {
  requireGuard(["inspect", "plan", "apply", "execute-reviewed"].includes(mode ?? ""), "explicit_mode_required");
  const packPath = resolve(option("pack")), packSha256 = option("pack-sha"), pack = readPack(await readFile(packPath), packSha256);
  const baselineBytes = await readFile(resolve(option("baseline"))), baselineSha = option("baseline-sha");
  requireGuard(bytesHash(baselineBytes) === baselineSha, "baseline_hash_mismatch");
  let baseline = JSON.parse(baselineBytes.toString()) as RentOpsSnapshot;
  const requested = option("phases"), names = requested === "all" ? pack.phases.map(p => p.id) : requested.split(","), phases = names.map(id => { const p = pack.phases.find(p => p.id === id); requireGuard(p, "phase_missing"); return p; });
  requireGuard(new Set(names).size === names.length && (mode === "execute-reviewed" || phases.length === 1), "invalid_phase_selection");
  if (pack.phases[0].id === phases[0].id) requireGuard(baselineSha === pack.initialBaselineSha256, "original_baseline_required");
  if (mode === "apply" || mode === "execute-reviewed") requireGuard(args.includes("--apply-reviewed"), "explicit_reviewed_apply_required");
  const context = { actor: option("actor"), occurredAt: option("occurred-at"), packPath, packSha256 }, out = resolve(option("out"));
  await mkdir(out, { recursive: true, mode: 0o700 });
  if (mode === "inspect") { const built = buildMaintenanceManifest(baseline, pack, phases[0], context); await durable(join(out, "inspection.json"), { manifest: built.manifest, baselineHash: snapshotHash(baseline), packSha256 }); console.log(JSON.stringify({ mode, operations: built.manifest.operations.length, saved: true })); return; }
  const db = await createRentOpsRuntimeDatabase();
  try {
    const repository = createPostgresRentOpsRepository(db);
    for (const phase of phases) {
      const live = await repository.getSnapshot(); requireGuard(snapshotHash(live) === snapshotHash(baseline), "live_baseline_changed");
      const { manifest, archivedSnapshot } = buildMaintenanceManifest(live, pack, phase, context);
      const envelope = { manifest, baselineHash: snapshotHash(live), packSha256 };
      await durable(join(out, `${phase.id}-before.json`), live);
      await durable(join(out, `${phase.id}-inspection.json`), envelope);
      let plan;
      if (mode === "apply") {
        const bytes = await readFile(resolve(option("plan"))); requireGuard(bytesHash(bytes) === option("plan-sha"), "saved_plan_hash_mismatch");
        const approved = JSON.parse(bytes.toString()); requireGuard(approved.packSha256 === packSha256 && approved.baselineHash === envelope.baselineHash && reconciliationHash(approved.manifest) === reconciliationHash(manifest), "saved_plan_changed");
        requireGuard(approved.plan.token === option("approved-token"), "approved_token_mismatch"); plan = approved.plan;
      } else {
        plan = await reconcileImportedRecords(repository, manifest, { mode: "plan", archivedSnapshot });
        requireGuard(snapshotHash(await repository.getSnapshot()) === envelope.baselineHash, "dry_run_changed_snapshot");
        await durable(join(out, `${phase.id}-plan.json`), { ...envelope, plan });
      }
      if (mode === "plan") continue;
      const applied = await reconcileImportedRecords(repository, manifest, { mode: "apply", archivedSnapshot, approvedPlanToken: plan.token });
      await durable(join(out, `${phase.id}-execution.json`), { ...envelope, applied, verificationPending: true });
      const after = await repository.getSnapshot(); await durable(join(out, `${phase.id}-after.json`), after);
      verifyMaintenanceReadback(live, after, manifest, applied);
      await durable(join(out, `${phase.id}-verified.json`), { ...envelope, plan: applied, afterHash: snapshotHash(after), verified: true, ledgerUnchanged: true }); baseline = after;
    }
    console.log(JSON.stringify({ mode, phases: phases.length, saved: true, ledgerUnchanged: true }));
  } finally { await db.close(); }
}
main().catch(error => { console.error(JSON.stringify({ ok: false, code: error instanceof MaintenanceGuardError ? error.code : "maintenance_failed_details_suppressed" })); process.exitCode = 1; });
