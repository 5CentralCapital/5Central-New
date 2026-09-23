/**
 * Plan or apply an owner-instructed charge reversal plan through RentOpsService.reverseLedgerTransaction.
 *
 *   plan:  tsx scripts/rent-ops-corrections/apply-owner-charge-reversals.ts plan \
 *            --ledger-plan <plan.json> --ledger-plan-sha <sha256> --database-url <url> --actor <operator> --occurred-at <ISO time> --out <private dir>
 *   apply: ... apply <same options> --approved-token <token from plan> --apply-reviewed
 *
 * Apply refuses without --apply-reviewed and the exact token of a dry run against the same
 * state. It only posts linked reversals of the listed charges: no payment, receipt, credit or
 * deletion. The saved readback shows every original unchanged and every new reversal.
 */
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runOwnerChargeReversals, type OwnerChargeReversalPlan } from "../../server/rent-ops/reconciliation/owner-corrections";
import { durable, guard, parseArgs, privateOutputDirectory, readJson, reportFailure, withLiveRepository } from "./cli-common";

async function main() {
  const { args, required, flag } = parseArgs(process.argv.slice(2));
  const mode = args[0];
  guard(mode === "plan" || mode === "apply", "explicit_mode_required");
  if (mode === "apply") guard(flag("apply-reviewed"), "explicit_reviewed_apply_required");
  const out = await privateOutputDirectory(required("out"));
  const read = await readJson<OwnerChargeReversalPlan>(required("ledger-plan"));
  guard(createHash("sha256").update(read.bytes).digest("hex") === required("ledger-plan-sha"), "ledger_plan_hash_mismatch");
  const actorSubject = required("actor"), occurredAt = required("occurred-at");
  guard(Number.isFinite(Date.parse(occurredAt)) && Date.parse(occurredAt) <= Date.now(), "actual_occurred_at_required");
  const approvedPlanToken = mode === "apply" ? required("approved-token") : undefined;
  await withLiveRepository(required("database-url"), async repository => {
    const before = await repository.getSnapshot();
    const result = await runOwnerChargeReversals(repository, read.value, { mode, approvedPlanToken, actorSubject, occurredAt });
    const stamp = Date.now();
    await durable(join(out, `owner-charge-reversal-${mode}-${stamp}.json`), { mode, ledgerPlanSha256: required("ledger-plan-sha"), result });
    if (mode === "apply") {
      const after = await repository.getSnapshot();
      const ids = new Set(read.value.accounts.flatMap(account => account.entries.flatMap(entry => [entry.chargeId, entry.reversalId])));
      const readback = { originals: before.ledgerTransactions.filter(row => ids.has(row.id)), afterRows: after.ledgerTransactions.filter(row => ids.has(row.id)),
        newRows: after.ledgerTransactions.filter(row => !before.ledgerTransactions.some(old => old.id === row.id)), allocationsUnchanged: JSON.stringify(before.paymentAllocations) === JSON.stringify(after.paymentAllocations) };
      guard(readback.newRows.every(row => row.kind === "reversal" && ids.has(row.id)) && readback.allocationsUnchanged, "reversal_readback_differs");
      await durable(join(out, `owner-charge-reversal-readback-${stamp}.json`), readback);
    }
    console.log(JSON.stringify({ mode, applied: mode === "apply", token: result.token, reversals: result.changes.map(change => ({ chargeId: change.chargeId, reversalId: change.reversalId })), paymentsCreated: 0 }));
  });
}

main().catch(reportFailure);
