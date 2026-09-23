/**
 * Release-gate review inventory. Prints JSON with case counts by reason,
 * materiality and state, record overlap, and every remaining case with its
 * missing evidence and next action. Impact totals are never summed.
 *
 * Usage: npx tsx scripts/company/review-inventory.ts --organization <uuid> [--detect] [--as-of YYYY-MM-DD] [--limit N]
 * Uses RENT_OPS_RUNTIME_DATABASE_URL. --detect reconciles cases first.
 */
import { createRentOpsRuntimeDatabase } from "../../server/rent-ops/runtime-database";
import { runReviewInventoryCli } from "../../server/review-cases/inventory";

async function main(): Promise<void> {
  const db = await createRentOpsRuntimeDatabase();
  try {
    const result = await runReviewInventoryCli(process.argv.slice(2), db);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await db.close();
  }
}

main().catch(error => {
  const code = error instanceof Error && /^review_inventory_[a-z_]+$/.test(error.message) ? error.message : "review_inventory_failed";
  console.error(JSON.stringify({ ok: false, code }));
  process.exitCode = 1;
});
