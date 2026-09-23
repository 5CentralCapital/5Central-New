/**
 * Plan-only runner for a built owner-correction pack (and optional charge reversal plan).
 *
 *   tsx scripts/rent-ops-corrections/plan-owner-corrections.ts \
 *     --pack <owner-correction-pack.json> --pack-sha <sha256> --baseline <baseline.json> --baseline-sha <sha256> \
 *     --actor <operator> --occurred-at <ISO time> --out <private dir> \
 *     (--database-url <url> | --offline-baseline) [--ledger-plan <plan.json> --ledger-plan-sha <sha256>]
 *
 * Every phase runs in mode "plan": the guarded operator executes inside a transaction and
 * rolls back. Nothing is applied. Prints change targets, changed field names and plan tokens;
 * full before/after detail is saved privately. Applying stays with scripts/rent-ops-maintenance.ts
 * (--apply-reviewed) and scripts/rent-ops-corrections/apply-owner-charge-reversals.ts.
 */
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { SyntheticRentOpsRepository } from "../../server/rent-ops/repositories/synthetic";
import { buildMaintenanceManifest, readPack, snapshotHash } from "../../server/rent-ops/reconciliation/maintenance";
import { reconcileImportedRecords } from "../../server/rent-ops/reconciliation/operator";
import { runOwnerChargeReversals, verifyPackageEvidence, type OwnerChargeReversalPlan } from "../../server/rent-ops/reconciliation/owner-corrections";
import type { RentOpsRepository } from "../../shared/rent-ops-contracts";
import { durable, guard, parseArgs, privateOutputDirectory, readJson, reportFailure, withLiveRepository, type RentOpsSnapshot } from "./cli-common";

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const changedFields = (before: unknown, after: unknown) => {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return Array.from(keys).filter(key => JSON.stringify((before as any)[key] ?? null) !== JSON.stringify((after as any)[key] ?? null)).sort();
};

async function planAll(repository: RentOpsRepository, input: { pack: ReturnType<typeof readPack>; packPath: string; packSha256: string; baseline: RentOpsSnapshot; actor: string; occurredAt: string; ledgerPlan?: OwnerChargeReversalPlan }) {
  const live = await repository.getSnapshot();
  guard(snapshotHash(live) === snapshotHash(input.baseline), "live_baseline_changed");
  const phases = [];
  for (const phase of input.pack.phases) {
    const evidence = phase.operations.flatMap(op => (op as { packageEvidence?: [] }).packageEvidence ?? []);
    guard(evidence.length >= phase.operations.length, "package_evidence_missing");
    await verifyPackageEvidence(evidence);
    // Same inputs as scripts/rent-ops-maintenance.ts plan mode, so the token matches for the same state.
    const { manifest, archivedSnapshot } = buildMaintenanceManifest(live, input.pack, phase, { actor: input.actor, occurredAt: input.occurredAt, packPath: input.packPath, packSha256: input.packSha256 });
    const plan = await reconcileImportedRecords(repository, manifest, { mode: "plan", archivedSnapshot });
    guard(snapshotHash(await repository.getSnapshot()) === snapshotHash(live), "dry_run_changed_snapshot");
    phases.push({ phase: phase.id, token: plan.token, manifestHash: plan.manifestHash, ledgerUnchanged: plan.ledgerUnchanged,
      changes: plan.changes.map((change, index) => ({ targetId: change.targetId, kind: manifest.operations[index].kind, beforeSha256: change.beforeSha256, afterSha256: change.afterSha256, changedFields: manifest.operations[index].kind === "balance-review" ? ["(new balance-review activity event)"] : changedFields(change.before, change.after), before: change.before, after: change.after })) });
  }
  let reversals = null;
  if (input.ledgerPlan) {
    const dry = await runOwnerChargeReversals(repository, input.ledgerPlan, { mode: "plan", actorSubject: input.actor, occurredAt: input.occurredAt });
    guard(snapshotHash(await repository.getSnapshot()) === snapshotHash(live), "dry_run_changed_snapshot");
    reversals = { token: dry.token, planSha256: dry.planSha256, paymentsCreated: dry.paymentsCreated, changes: dry.changes };
  }
  return { phases, reversals, baselineHash: snapshotHash(live) };
}

async function main() {
  const { option, required, flag } = parseArgs(process.argv.slice(2));
  const out = await privateOutputDirectory(required("out"));
  const packPath = resolve(required("pack")), packSha256 = required("pack-sha");
  const packBytes = (await readJson(packPath)).bytes;
  const pack = readPack(packBytes, packSha256);
  const baseline = await readJson<RentOpsSnapshot>(required("baseline"));
  guard(sha256(baseline.bytes) === required("baseline-sha"), "baseline_hash_mismatch");
  guard(pack.initialBaselineSha256 === required("baseline-sha"), "original_baseline_required");
  const actor = required("actor"), occurredAt = required("occurred-at");
  guard(Number.isFinite(Date.parse(occurredAt)) && Date.parse(occurredAt) <= Date.now(), "actual_occurred_at_required");
  let ledgerPlan: OwnerChargeReversalPlan | undefined;
  if (option("ledger-plan")) {
    const read = await readJson<OwnerChargeReversalPlan>(option("ledger-plan")!);
    guard(sha256(read.bytes) === required("ledger-plan-sha"), "ledger_plan_hash_mismatch");
    ledgerPlan = read.value;
  }
  guard(!!option("database-url") !== flag("offline-baseline"), "exactly_one_source_required");
  const input = { pack, packPath, packSha256, baseline: baseline.value, actor, occurredAt, ledgerPlan };
  const result = option("database-url")
    ? await withLiveRepository(option("database-url")!, repository => planAll(repository, input))
    : await planAll(new SyntheticRentOpsRepository(baseline.value), input);
  const reviewPath = join(out, `owner-corrections-plan-review-${Date.now()}.json`);
  await durable(reviewPath, { applicationStatus: "PLANNED_NOT_APPLIED", packPath, packSha256, baselineSha256: pack.initialBaselineSha256, actor, occurredAt, ...result });
  // Stdout: identities, changed field names and tokens only.
  console.log(JSON.stringify({ mode: "plan", applied: false, review: reviewPath,
    phases: result.phases.map(phase => ({ phase: phase.phase, token: phase.token, changes: phase.changes.map(change => ({ targetId: change.targetId, kind: change.kind, changedFields: change.changedFields })) })),
    reversals: result.reversals ? { token: result.reversals.token, entries: result.reversals.changes.map(change => ({ chargeId: change.chargeId, reversalId: change.reversalId })) } : null }, null, 2));
}

main().catch(reportFailure);
