/** Offline, bounded read-only audit. Usage: tsx .../account-history-coverage-cli.ts snapshot.json [evidence.json]
 * evidence.json is an internal Record<personId, AccountHistoryEvidence> assembled
 * from an independently verified archive and actual target readback. No importer,
 * schema bootstrap, RM connector, database credentials, or write path is loaded.
 */
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { getAccountHistoryCoverage, type AccountHistoryEvidence } from "./account-history-coverage";
import type { RentOpsSnapshot } from "../../../shared/rent-ops-contracts";
const MAX_BYTES = 128 * 1024 * 1024;
async function boundedJson(path: string): Promise<unknown> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_BYTES) throw Error("audit_input_size_rejected");
  const bytes = await readFile(path);
  if (bytes.length > MAX_BYTES) throw Error("audit_input_size_rejected");
  return JSON.parse(bytes.toString("utf8"));
}
async function main() {
  if (process.argv.length < 3 || process.argv.length > 4) throw Error("expected_snapshot_and_optional_evidence_paths");
  const snapshot = await boundedJson(process.argv[2]) as RentOpsSnapshot;
  for (const name of ["people", "tenancies", "ledgerTransactions", "paymentAllocations", "sourceRecords"] as const) {
    if (!Array.isArray(snapshot?.[name]) || snapshot[name].length > 250_000) throw Error("invalid_or_unbounded_snapshot");
  }
  if (snapshot.people.length > 10_000) throw Error("account_limit_exceeded");
  const evidence = process.argv[3] ? await boundedJson(process.argv[3]) as Record<string, AccountHistoryEvidence> : {};
  const accounts = snapshot.people.map(person => {
    const { missingSourceRows, ...result } = getAccountHistoryCoverage(snapshot, person.id, evidence[person.id]);
    return { accountHash: createHash("sha256").update(person.id).digest("hex"), ...result,
      missingSourceIdentityHashes: missingSourceRows.map(row => createHash("sha256").update(JSON.stringify([row.kind, row.sourceId])).digest("hex")) };
  });
  console.log(JSON.stringify({ mode: "read_only_offline", accounts, totals: {
    verified: accounts.filter(row => row.status === "verified").length,
    partial: accounts.filter(row => row.status === "partial").length,
    unverified: accounts.filter(row => row.status === "unverified").length,
  } }, null, 2));
}
main().catch(() => { console.error("account_history_audit_failed: input unavailable, invalid, or exceeds bounds"); process.exitCode = 1; });
