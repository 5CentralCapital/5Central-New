/**
 * Build a guarded correction plan from an owner-attested correction package.
 *
 *   tsx scripts/rent-ops-corrections/build-owner-correction-plan.ts \
 *     --package <package dir> --out <private dir> --occurred-at <ISO time> \
 *     (--database-url <url> | --snapshot <snapshot.json> | --synthetic | --checklist-only) [--resolutions <file>]
 *
 * Reads only. Writes the maintenance pack, the ledger reversal plan, the held list and the
 * package checklist into a private directory outside the repository. Prints counts only.
 */
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { buildOwnerCorrectionPlan, buildResolutionChecklist, loadCorrectionPackage, loadResolutions } from "../../server/rent-ops/reconciliation/owner-corrections";
import { syntheticOwnerCorrectionSnapshot, writeSyntheticCorrectionPackage } from "../../server/rent-ops/reconciliation/owner-corrections-synthetic";
import { durable, guard, parseArgs, privateOutputDirectory, readJson, reportFailure, withLiveRepository, type RentOpsSnapshot } from "./cli-common";

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

async function main() {
  const { option, required, flag } = parseArgs(process.argv.slice(2));
  const out = await privateOutputDirectory(required("out"));
  const sources = [option("database-url") ? "database" : "", option("snapshot") ? "snapshot" : "", flag("synthetic") ? "synthetic" : "", flag("checklist-only") ? "checklist" : ""].filter(Boolean);
  guard(sources.length === 1, "exactly_one_source_required");
  const occurredAt = required("occurred-at");
  guard(Number.isFinite(Date.parse(occurredAt)) && Date.parse(occurredAt) <= Date.now(), "actual_occurred_at_required");

  let packageDirectory = option("package"), resolutionsPath = option("resolutions");
  if (flag("synthetic")) {
    guard(!packageDirectory && !resolutionsPath, "synthetic_mode_uses_generated_package");
    const written = await writeSyntheticCorrectionPackage(join(out, "synthetic-package"));
    packageDirectory = written.directory; resolutionsPath = written.resolutionsPath;
  }
  guard(packageDirectory, "missing_package");
  const pkg = await loadCorrectionPackage(packageDirectory);
  const checklist = buildResolutionChecklist(pkg, new Date(occurredAt).toISOString());
  const checklistPath = join(out, `owner-correction-checklist-${pkg.asOf}.json`);
  await durable(checklistPath, checklist);
  if (flag("checklist-only")) {
    console.log(JSON.stringify({ mode: "checklist-only", checklist: checklistPath, counts: checklist.counts }));
    return;
  }

  // Fresh read: the baseline is the exact snapshot the plan is built against.
  let baselinePath: string, baselineBytes: Buffer, snapshot: RentOpsSnapshot;
  if (option("snapshot")) {
    baselinePath = resolve(option("snapshot")!);
    const read = await readJson<RentOpsSnapshot>(baselinePath); baselineBytes = read.bytes; snapshot = read.value;
  } else {
    snapshot = flag("synthetic") ? syntheticOwnerCorrectionSnapshot() : await withLiveRepository(option("database-url")!, repository => repository.getSnapshot());
    baselineBytes = Buffer.from(JSON.stringify(snapshot, null, 2) + "\n");
    baselinePath = join(out, "baseline-snapshot.json");
    await durable(baselinePath, baselineBytes.toString("utf8"));
  }
  const baselineSha256 = sha256(baselineBytes);
  const resolutions = resolutionsPath ? await loadResolutions(resolutionsPath) : undefined;
  const build = buildOwnerCorrectionPlan(pkg, snapshot, { occurredAt: new Date(occurredAt).toISOString(), baselineSha256, resolutions });

  const written: Record<string, { path: string; sha256: string } | null> = { baseline: { path: baselinePath, sha256: baselineSha256 }, pack: null, ledgerPlan: null };
  if (build.pack) {
    const text = JSON.stringify(build.pack, null, 2) + "\n", path = join(out, "owner-correction-pack.json");
    await durable(path, text); written.pack = { path, sha256: sha256(text) };
  }
  if (build.ledgerPlan) {
    const text = JSON.stringify(build.ledgerPlan, null, 2) + "\n", path = join(out, "owner-charge-reversal-plan.json");
    await durable(path, text); written.ledgerPlan = { path, sha256: sha256(text) };
  }
  const heldPath = join(out, "owner-correction-held.json");
  await durable(heldPath, { applicationStatus: "NOT_APPLIED", held: build.held });
  const summary = { mode: flag("synthetic") ? "synthetic" : option("snapshot") ? "snapshot" : "database", builtAt: new Date(occurredAt).toISOString(), ...written, held: heldPath, checklist: checklistPath,
    phases: build.pack?.phases.map(phase => ({ id: phase.id, operations: phase.operations.length })) ?? [], summary: build.summary };
  await durable(join(out, "build-summary.json"), summary);
  console.log(JSON.stringify({ mode: summary.mode, packSha256: written.pack?.sha256 ?? null, ledgerPlanSha256: written.ledgerPlan?.sha256 ?? null, baselineSha256, phases: summary.phases, summary: build.summary, checklistCounts: checklist.counts }));
}

main().catch(reportFailure);
