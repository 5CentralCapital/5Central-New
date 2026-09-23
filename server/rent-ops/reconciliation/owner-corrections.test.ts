import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyntheticRentOpsRepository } from "../repositories/synthetic";
import { deriveDelinquency } from "../domain/reports";
import { bytesHash, buildMaintenanceManifest, verifyMaintenanceReadback, readPack } from "./maintenance";
import { reconcileImportedRecords, reconciliationHash } from "./operator";
import {
  buildOwnerCorrectionPlan, buildResolutionChecklist, loadCorrectionPackage, loadResolutions, parseDisplayedCents, runOwnerChargeReversals,
  verifyPackageEvidence, type OwnerCorrectionBuild,
} from "./owner-corrections";
import { SYNTHETIC_IDS as I, SYNTHETIC_OCCURRED_AT, syntheticOwnerCorrectionSnapshot, writeSyntheticCorrectionPackage } from "./owner-corrections-synthetic";

const BASELINE = "c".repeat(64);
const PAYMENT_KINDS = new Set(["payment", "credit", "adjustment"]);

async function scenario(mutate?: Parameters<typeof writeSyntheticCorrectionPackage>[1]) {
  const root = await mkdtemp(join(tmpdir(), "owner-corrections-"));
  const { directory, resolutionsPath } = await writeSyntheticCorrectionPackage(join(root, "package"), mutate);
  return { root, pkg: await loadCorrectionPackage(directory), resolutions: await loadResolutions(resolutionsPath), snapshot: syntheticOwnerCorrectionSnapshot() };
}
const opsOf = (build: OwnerCorrectionBuild) => (build.pack?.phases ?? []).flatMap(phase => phase.operations) as any[];
const heldFor = (build: OwnerCorrectionBuild, caseIndex: number) => build.held.filter(row => row.caseIndex === caseIndex);

test("builds cancelled-tenancy, owner zero-balance review, future unit link and exact charge reversal plan", async () => {
  const { root, pkg, resolutions, snapshot } = await scenario();
  try {
    const build = buildOwnerCorrectionPlan(pkg, snapshot, { occurredAt: SYNTHETIC_OCCURRED_AT, baselineSha256: BASELINE, resolutions });
    const ops = opsOf(build);
    const cancel = ops.filter(op => op.values.kind === "tenancy-status");
    assert.deepEqual(cancel.map(op => op.target.id).sort(), [I.cancelTenancy, I.reverseTenancy].sort());
    assert.ok(cancel.every(op => op.values.status === "cancelled" && op.expected.status === "past"), "cancel guards the researched former status");
    const review = ops.find(op => op.values.kind === "balance-review");
    assert.equal(review.target.id, I.zeroTenancy);
    assert.equal(review.values.review.reviewedBalanceCents, 0);
    assert.equal(review.values.review.tenantBalanceCents, 0);
    assert.equal(review.values.review.agencyBalanceCents, null, "unstated agency balance stays unknown");
    assert.equal(review.values.review.asOfDate, "2026-09-23");
    const link = ops.find(op => op.values.kind === "future-tenancy-unit-link");
    assert.equal(link.target.id, I.futureTenancy);
    assert.deepEqual(link.values.unitGuard, { $guard: { collection: "units", id: "syn-unit-5" } });
    assert.equal(link.values.plannedMoveInOn, "2026-10-01");
    // Every operation carries package evidence whose bytes still hash to the recorded digest.
    for (const op of ops) {
      assert.ok(op.packageEvidence.length > 0 && op.reference.includes(pkg.files["proposed-corrections.json"].sha256));
      await verifyPackageEvidence(op.packageEvidence);
    }
    // Ledger plan: exact current charges, amounts as decimal strings, revisions and before-hashes.
    const account = build.ledgerPlan!.accounts[0];
    assert.equal(build.ledgerPlan!.accounts.length, 1);
    assert.equal(account.personId, I.reversePerson);
    assert.equal(account.expectedPostedTotalCents, "133300");
    assert.deepEqual(account.entries.map(row => [row.chargeId, row.amountCents]), [[I.feeCharge, "22200"], [I.rentCharge, "111100"]]);
    for (const entry of account.entries) {
      const charge = snapshot.ledgerTransactions.find(row => row.id === entry.chargeId)!;
      assert.equal(entry.beforeSha256, reconciliationHash(charge));
      assert.match(entry.expectedRevision, /^[a-f0-9]{64}$/);
      assert.equal(entry.reversalPostedOn, "2026-09-23");
    }
    assert.deepEqual(build.ledgerPlan!.guarantees, { createsPayments: false, createsReceipts: false, deletesOriginals: false, route: "RentOpsService.reverseLedgerTransaction" });
    // Side actions that need cash matching are held, not converted.
    assert.deepEqual(heldFor(build, 1).map(row => row.reason), ["charge-reversal-not-instructed"]);
    assert.deepEqual(heldFor(build, 3).map(row => row.reason), ["deposit-allocation-open"]);
    // The pack is consumable by the existing maintenance reader.
    const bytes = Buffer.from(JSON.stringify(build.pack));
    assert.deepEqual(readPack(bytes, bytesHash(bytes)).phases.length, build.pack!.phases.length);
  } finally { await rm(root, { recursive: true }); }
});

test("case with payment-matching gaps is held with exact reasons and produces no operation", async () => {
  const { root, pkg, resolutions, snapshot } = await scenario();
  try {
    const build = buildOwnerCorrectionPlan(pkg, snapshot, { occurredAt: SYNTHETIC_OCCURRED_AT, baselineSha256: BASELINE, resolutions });
    assert.ok(!opsOf(build).some(op => op.target.id === I.paymentGapTenancy));
    assert.ok(!build.ledgerPlan!.accounts.some(account => account.personId === I.paymentGapPerson));
    const reasons = new Set(heldFor(build, 4).map(row => row.reason));
    assert.ok(reasons.has("payment-matching-required") && reasons.has("remaining-evidence-listed"));
    // An owner-instructed zero-charge case whose account already holds a receipt needs payment matching.
    const withReceipt = structuredClone(snapshot);
    withReceipt.ledgerTransactions.push({ ...structuredClone(snapshot.ledgerTransactions.find(row => row.id === I.gapPayment)!), id: "syn-extra-receipt", personId: I.reversePerson, tenancyId: I.reverseTenancy, unitId: "syn-unit-3", amountCents: 1 });
    const edited = structuredClone(pkg);
    edited.cases[2].before["Operational balance"] = "$1,332.99"; edited.cases[2].before["Posted ledger total"] = "$1,332.99";
    edited.ownerInstructions[2].observedBefore = { posted_ledger_total_cents: 133299 };
    const blocked = buildOwnerCorrectionPlan(edited, withReceipt, { occurredAt: SYNTHETIC_OCCURRED_AT, baselineSha256: BASELINE, resolutions });
    assert.equal(blocked.ledgerPlan, null);
    assert.ok(heldFor(blocked, 2).some(row => row.kind === "owner-charge-reversal" && row.reason === "payment-matching-required"));
  } finally { await rm(root, { recursive: true }); }
});

test("stale readback holds every supported action with 'changed since research'", async () => {
  const { root, pkg, resolutions, snapshot } = await scenario();
  try {
    const changed = structuredClone(snapshot);
    changed.ledgerTransactions.push({ ...structuredClone(snapshot.ledgerTransactions.find(row => row.id === I.rentCharge)!), id: "syn-new-charge", amountCents: 5000 });
    changed.tenancies.find(row => row.id === I.cancelTenancy)!.status = "current";
    changed.tenancies.find(row => row.id === I.cancelTenancy)!.actualMoveOutOn = undefined;
    const build = buildOwnerCorrectionPlan(pkg, changed, { occurredAt: SYNTHETIC_OCCURRED_AT, baselineSha256: BASELINE, resolutions });
    assert.equal(build.ledgerPlan, null);
    for (const caseIndex of [0, 2]) {
      const held = heldFor(build, caseIndex).filter(row => row.kind);
      assert.ok(held.length > 0 && held.every(row => row.reason === "changed-since-research"), `case ${caseIndex} held as stale`);
    }
    assert.ok(!opsOf(build).some(op => [I.cancelTenancy, I.reverseTenancy].includes(op.target.id)));
    // A missing structured resolution holds the future link instead of guessing from prose.
    const noResolution = buildOwnerCorrectionPlan(pkg, snapshot, { occurredAt: SYNTHETIC_OCCURRED_AT, baselineSha256: BASELINE });
    assert.ok(heldFor(noResolution, 3).some(row => row.kind === "future-tenancy-unit-link" && row.reason === "structured-resolution-missing"));
  } finally { await rm(root, { recursive: true }); }
});

test("unknown amounts never become zero", async () => {
  assert.deepEqual(parseDisplayedCents("Needs review"), { known: true, cents: null });
  assert.deepEqual(parseDisplayedCents("'-$335.00"), { known: true, cents: "-33500" });
  assert.deepEqual(parseDisplayedCents("$1,234.56"), { known: true, cents: "123456" });
  assert.deepEqual(parseDisplayedCents("about $5"), { known: false });
  const { root, pkg, resolutions, snapshot } = await scenario(value => {
    value.proposed.cases[2].before["Operational balance"] = "Needs review";
    value.proposed.cases[2].before["Posted ledger total"] = "Needs review";
  });
  try {
    const unknownCharge = structuredClone(snapshot);
    const fee = unknownCharge.ledgerTransactions.find(row => row.id === I.feeCharge)!;
    fee.amountCents = null; fee.amountKnowledge = "unknown";
    const build = buildOwnerCorrectionPlan(pkg, unknownCharge, { occurredAt: SYNTHETIC_OCCURRED_AT, baselineSha256: BASELINE, resolutions });
    assert.equal(build.ledgerPlan, null);
    assert.ok(heldFor(build, 2).some(row => row.kind === "owner-charge-reversal" && row.reason === "unknown-amount"));
    // Cancelling a never-occupied tenancy never writes a balance for it.
    assert.ok(!opsOf(build).some(op => op.values.kind === "balance-review" && op.target.id !== I.zeroTenancy));
    const review = opsOf(build).find(op => op.values.kind === "balance-review");
    assert.equal(review.values.review.agencyBalanceCents, null);
  } finally { await rm(root, { recursive: true }); }
});

test("operational pack plans in a rolled-back transaction, applies only with the exact token and reads back", async () => {
  const { root, pkg, resolutions, snapshot } = await scenario();
  try {
    const build = buildOwnerCorrectionPlan(pkg, snapshot, { occurredAt: SYNTHETIC_OCCURRED_AT, baselineSha256: BASELINE, resolutions });
    const packPath = join(root, "pack.json"), bytes = Buffer.from(JSON.stringify(build.pack)); await writeFile(packPath, bytes);
    const repository = new SyntheticRentOpsRepository(snapshot), before = await repository.getSnapshot();
    const { manifest, archivedSnapshot } = buildMaintenanceManifest(before, build.pack!, build.pack!.phases[0], { actor: "owner-test", occurredAt: SYNTHETIC_OCCURRED_AT, packPath, packSha256: bytesHash(bytes) });
    const plan = await reconcileImportedRecords(repository, manifest, { mode: "plan", archivedSnapshot });
    assert.deepEqual(await repository.getSnapshot(), before, "plan rolls back");
    await assert.rejects(() => reconcileImportedRecords(repository, manifest, { mode: "apply", approvedPlanToken: "0".repeat(64), archivedSnapshot }), /token/);
    const applied = await reconcileImportedRecords(repository, manifest, { mode: "apply", approvedPlanToken: plan.token, archivedSnapshot });
    const after = await repository.getSnapshot();
    verifyMaintenanceReadback(before, after, manifest, applied);
    const cancelled = after.tenancies.find(row => row.id === I.cancelTenancy)!;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.actualMoveInOn, "2026-06-01", "imported history is preserved");
    assert.equal(cancelled.source?.sourceId, before.tenancies.find(row => row.id === I.cancelTenancy)!.source?.sourceId);
    const future = after.tenancies.find(row => row.id === I.futureTenancy)!;
    assert.equal(future.unitId, "syn-unit-5"); assert.equal(future.unitLinkKnowledge, "manual"); assert.equal(future.plannedMoveInOn, "2026-10-01");
    assert.equal(future.actualMoveInOn, undefined, "no occupancy is invented");
    const zero = deriveDelinquency(after, { tenantStatus: "all", asOfDate: "2026-09-23" }).find(row => row.personId === I.zeroPerson)!;
    assert.equal(zero.operationalBalanceCents, 0);
    assert.deepEqual(after.ledgerTransactions, before.ledgerTransactions);
    assert.deepEqual(after.paymentAllocations, before.paymentAllocations);
    // After application the researched before-state no longer matches: rebuilding refuses to re-apply.
    const rebuilt = buildOwnerCorrectionPlan(pkg, after, { occurredAt: SYNTHETIC_OCCURRED_AT, baselineSha256: BASELINE, resolutions });
    assert.ok(!opsOf(rebuilt).some(op => op.target.id === I.cancelTenancy));
  } finally { await rm(root, { recursive: true }); }
});

test("charge reversal dry run rolls back; apply posts linked reversals only through the audited service", async () => {
  const { root, pkg, resolutions, snapshot } = await scenario();
  try {
    const build = buildOwnerCorrectionPlan(pkg, snapshot, { occurredAt: SYNTHETIC_OCCURRED_AT, baselineSha256: BASELINE, resolutions });
    const plan = build.ledgerPlan!;
    const repository = new SyntheticRentOpsRepository(snapshot), before = await repository.getSnapshot();
    const options = { actorSubject: "owner-test", occurredAt: SYNTHETIC_OCCURRED_AT };
    const dry = await runOwnerChargeReversals(repository, plan, { ...options, mode: "plan" });
    assert.deepEqual(await repository.getSnapshot(), before, "dry run rolls back");
    assert.equal(dry.changes.length, 2);
    await assert.rejects(() => runOwnerChargeReversals(repository, plan, { ...options, mode: "apply", approvedPlanToken: "wrong" }), /token/);
    const tampered = structuredClone(plan); tampered.accounts[0].entries[0].amountCents = "1";
    await assert.rejects(() => runOwnerChargeReversals(repository, tampered, { ...options, mode: "plan" }), /conserve/);
    const applied = await runOwnerChargeReversals(repository, plan, { ...options, mode: "apply", approvedPlanToken: dry.token });
    assert.equal(applied.paymentsCreated, 0);
    const after = await repository.getSnapshot();
    const added = after.ledgerTransactions.filter(row => !before.ledgerTransactions.some(old => old.id === row.id));
    assert.deepEqual(added.map(row => [row.kind, row.reversalOfId, row.amountCents]).sort(), [["reversal", I.feeCharge, 22200], ["reversal", I.rentCharge, 111100]].sort());
    assert.ok(!added.some(row => PAYMENT_KINDS.has(row.kind ?? "")), "no payment, receipt or credit is created");
    for (const original of before.ledgerTransactions) assert.deepEqual(after.ledgerTransactions.find(row => row.id === original.id), original, "originals are never deleted or rewritten");
    assert.deepEqual(after.paymentAllocations, before.paymentAllocations);
    const account = deriveDelinquency(after, { tenantStatus: "all", asOfDate: "2026-09-23" }).find(row => row.personId === I.reversePerson)!;
    assert.equal(account.totalBalanceCents, 0);
    // Replay after application is refused by the before-state guard.
    await assert.rejects(() => runOwnerChargeReversals(repository, plan, { ...options, mode: "apply", approvedPlanToken: dry.token }), /changed/);
  } finally { await rm(root, { recursive: true }); }
});

test("charge reversal refuses when a receipt appears after planning or package evidence changes", async () => {
  const { root, pkg, resolutions, snapshot } = await scenario();
  try {
    const build = buildOwnerCorrectionPlan(pkg, snapshot, { occurredAt: SYNTHETIC_OCCURRED_AT, baselineSha256: BASELINE, resolutions });
    const repository = new SyntheticRentOpsRepository(snapshot);
    const options = { actorSubject: "owner-test", occurredAt: SYNTHETIC_OCCURRED_AT };
    const dry = await runOwnerChargeReversals(repository, build.ledgerPlan!, { ...options, mode: "plan" });
    await repository.saveLedgerTransaction({ ...structuredClone(snapshot.ledgerTransactions.find(row => row.id === I.gapPayment)!), source: undefined, sourceArtifactSha256: null, artifactObservationOn: null,
      id: "syn-late-receipt", personId: I.reversePerson, tenancyId: I.reverseTenancy, unitId: "syn-unit-3", amountCents: 100 });
    await assert.rejects(() => runOwnerChargeReversals(repository, build.ledgerPlan!, { ...options, mode: "apply", approvedPlanToken: dry.token }), /Account ledger changed/);
    const proposedPath = pkg.files["proposed-corrections.json"].path;
    await writeFile(proposedPath, (await readFile(proposedPath, "utf8")) + " ");
    await assert.rejects(() => runOwnerChargeReversals(new SyntheticRentOpsRepository(snapshot), build.ledgerPlan!, { ...options, mode: "plan" }), /package_evidence_hash_mismatch/);
  } finally { await rm(root, { recursive: true }); }
});

test("no payment or receipt operation kinds are ever produced", async () => {
  const { root, pkg, resolutions, snapshot } = await scenario();
  try {
    const build = buildOwnerCorrectionPlan(pkg, snapshot, { occurredAt: SYNTHETIC_OCCURRED_AT, baselineSha256: BASELINE, resolutions });
    const kinds = new Set(opsOf(build).map(op => op.values.kind));
    assert.deepEqual(Array.from(kinds).sort(), ["balance-review", "future-tenancy-unit-link", "tenancy-status"]);
    assert.ok(!JSON.stringify(build.pack).match(/"kind":"(payment|receipt|credit|manual-payment|adjustment)"/));
    assert.ok(build.ledgerPlan!.accounts.every(account => account.entries.every(entry => entry.reversalId.startsWith("owner-correction-reversal:"))));
  } finally { await rm(root, { recursive: true }); }
});

test("package integrity, controls and package-only checklist", async () => {
  const { root, pkg } = await scenario();
  try {
    const checklist = buildResolutionChecklist(pkg, SYNTHETIC_OCCURRED_AT);
    assert.equal(checklist.counts.cases, 5);
    assert.equal(checklist.counts.supported, 2);
    assert.equal(checklist.counts.partiallySupported, 2);
    assert.equal(checklist.counts.held, 1);
    assert.deepEqual(checklist.counts.supportedActionsByKind, { "future-tenancy-unit-link": 1, "owner-charge-reversal": 1, "owner-zero-balance-review": 1, "tenancy-cancelled": 2 });
    assert.equal(checklist.counts.packageLevelHeld, 1);
    assert.ok(checklist.package.every(file => file.matchesPackageManifest !== false));
    assert.ok(checklist.cases.find(row => row.index === 3)!.supportedActions[0].requiresStructuredResolution);
    assert.deepEqual(checklist.resolutionsTemplate.cases.map(row => row.personId), [I.futurePerson]);
    const blankPath = join(root, "blank-resolutions.json"); await writeFile(blankPath, JSON.stringify(checklist.resolutionsTemplate));
    await assert.rejects(() => loadResolutions(blankPath), /invalid_future_unit_link_resolution/, "an unfilled template never resolves anything");
    // Tampered bytes relative to the package manifest refuse to load.
    const proposedPath = pkg.files["proposed-corrections.json"].path;
    await writeFile(proposedPath, (await readFile(proposedPath, "utf8")).replace("NOT_APPLIED", "NOT_APPLIED "));
    await assert.rejects(() => loadCorrectionPackage(pkg.directory), /package_file_hash_mismatch/);
    const unsafe = await writeSyntheticCorrectionPackage(join(root, "unsafe"), value => { (value.proposed as any).automatic_execution_allowed = true; });
    await assert.rejects(() => loadCorrectionPackage(unsafe.directory), /package_controls_missing/);
  } finally { await rm(root, { recursive: true }); }
});

test("future unit link operator guard rejects past starts, non-future tenancies and occupied destinations", async () => {
  const { root, pkg, resolutions, snapshot } = await scenario();
  try {
    const build = buildOwnerCorrectionPlan(pkg, snapshot, { occurredAt: SYNTHETIC_OCCURRED_AT, baselineSha256: BASELINE, resolutions });
    const onlyLink = { ...build.pack!, counts: {}, phases: [{ id: "link", operations: opsOf(build).filter(op => op.values.kind === "future-tenancy-unit-link") }] };
    const packPath = join(root, "link.json"), bytes = Buffer.from(JSON.stringify(onlyLink)); await writeFile(packPath, bytes);
    const context = { actor: "owner-test", occurredAt: SYNTHETIC_OCCURRED_AT, packPath, packSha256: createHash("sha256").update(bytes).digest("hex") };
    const plan = (snap: typeof snapshot, edit?: (op: any) => void) => {
      const { manifest } = buildMaintenanceManifest(snap, onlyLink, onlyLink.phases[0], context);
      edit?.(manifest.operations[0]);
      return reconcileImportedRecords(new SyntheticRentOpsRepository(snap), manifest, { mode: "plan" });
    };
    await plan(snapshot);
    await assert.rejects(() => plan(snapshot, op => { op.plannedMoveInOn = "2026-09-20"; }), /prospective start/);
    const occupied = structuredClone(snapshot);
    occupied.tenancies.push({ ...structuredClone(snapshot.tenancies.find(row => row.id === I.paymentGapTenancy)!), id: "syn-occupant", unitId: "syn-unit-5", source: { system: "rent_manager", entityType: "tenancy", sourceId: "lease:occupant" } });
    await assert.rejects(() => plan(occupied), /conflicting occupancy/);
    const notFuture = structuredClone(snapshot);
    const tenancy = notFuture.tenancies.find(row => row.id === I.futureTenancy)!; tenancy.status = "past"; tenancy.plannedMoveInOn = undefined;
    assert.throws(() => buildMaintenanceManifest(notFuture, onlyLink, onlyLink.phases[0], context), /expected_value_changed/);
  } finally { await rm(root, { recursive: true }); }
});

test("future unit link confirms an unresolved link to the same unit under the next revision", async () => {
  const { root, pkg, resolutions, snapshot } = await scenario(value => { value.resolutions.cases[0].futureUnitLink.unitNumber = "#4"; });
  try {
    const build = buildOwnerCorrectionPlan(pkg, snapshot, { occurredAt: SYNTHETIC_OCCURRED_AT, baselineSha256: BASELINE, resolutions });
    const onlyLink = { ...build.pack!, phases: [{ id: "link", operations: opsOf(build).filter(op => op.values.kind === "future-tenancy-unit-link") }] };
    const packPath = join(root, "link.json"), bytes = Buffer.from(JSON.stringify(onlyLink)); await writeFile(packPath, bytes);
    const repository = new SyntheticRentOpsRepository(snapshot), before = await repository.getSnapshot();
    const { manifest } = buildMaintenanceManifest(before, onlyLink, onlyLink.phases[0], { actor: "owner-test", occurredAt: SYNTHETIC_OCCURRED_AT, packPath, packSha256: bytesHash(bytes) });
    const plan = await reconcileImportedRecords(repository, manifest, { mode: "plan" });
    const applied = await reconcileImportedRecords(repository, manifest, { mode: "apply", approvedPlanToken: plan.token });
    const after = await repository.getSnapshot();
    verifyMaintenanceReadback(before, after, manifest, applied);
    const tenancy = after.tenancies.find(row => row.id === I.futureTenancy)!;
    assert.equal(tenancy.unitId, "syn-unit-4"); assert.equal(tenancy.unitLinkKnowledge, "manual"); assert.equal(tenancy.recordRevision, 3);
    assert.equal(deriveDelinquency(after, { tenantStatus: "all", asOfDate: "2026-09-23" }).find(row => row.personId === I.futurePerson)!.unitNumber, "#4");
  } finally { await rm(root, { recursive: true }); }
});
