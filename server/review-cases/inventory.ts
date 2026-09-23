import { organizationIdSchema } from "../../shared/company";
import type { ReviewDetectionSummary, ReviewInventory } from "../../shared/review-cases";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { runReviewDetection } from "./detection";
import { summarizeReviewCaseRows } from "./read";
import { REVIEW_CASE_COLUMNS, mapReviewCaseRow } from "./store";

/**
 * Operator release-gate inventory for one organization, read in one snapshot.
 * Server-internal (CLI, job); user-facing reads go through the authorized port.
 */
export async function summarizeReviewInventoryForExecutor(executor: RentOpsQueryExecutor, organizationId: string, options: { limit?: number } = {}): Promise<ReviewInventory> {
  const organization = organizationIdSchema.parse(organizationId);
  const work = async (connection: RentOpsQueryExecutor) => {
    const result = await connection.query<Record<string, unknown>>(
      `SELECT ${REVIEW_CASE_COLUMNS} FROM company_review_cases c WHERE c.organization_id = $1
        ORDER BY CASE c.materiality WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'unknown' THEN 2 ELSE 3 END, c.reason_code, c.id
        LIMIT 20000`,
      [organization],
    );
    return summarizeReviewCaseRows(organization, result.rows.map(mapReviewCaseRow), Math.min(Math.max(options.limit ?? 200, 1), 500));
  };
  return executor.transaction ? executor.transaction(work, { readOnly: true }) : work(executor);
}

export interface ReviewInventoryCliResult {
  readonly detection: ReviewDetectionSummary | null;
  readonly inventory: ReviewInventory;
}

/** Parse CLI arguments and produce the JSON document the script prints. */
export async function runReviewInventoryCli(argv: readonly string[], executor: RentOpsQueryExecutor): Promise<ReviewInventoryCliResult> {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const organizationId = value("organization");
  if (!organizationId) throw new Error("review_inventory_organization_required");
  const limitText = value("limit");
  const limit = limitText === undefined ? undefined : Number(limitText);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) throw new Error("review_inventory_limit_invalid");
  // Detection is explicit: it reconciles cases (opens, refreshes and verifies by readback).
  const detection = argv.includes("--detect") ? await runReviewDetection(executor, organizationId, { asOf: value("as-of") }) : null;
  return { detection, inventory: await summarizeReviewInventoryForExecutor(executor, organizationId, { limit }) };
}
