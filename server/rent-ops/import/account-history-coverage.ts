import type { RentOpsSnapshot } from "../../../shared/rent-ops-contracts";

export const ACCOUNT_HISTORY_KINDS = ["charges", "payments", "credits", "allocations"] as const;
export type AccountHistoryKind = typeof ACCOUNT_HISTORY_KINDS[number];
export type AccountHistoryCoverageStatus = "verified" | "partial" | "unverified";
/** Source identities are namespaced (charge:1 and payment:1 are distinct). */
export interface AccountHistoryRow {
  kind: AccountHistoryKind;
  sourceId: string | null;
  postedOn: string | null;
  /** Source-row digest, not a digest of the mapped target row. */
  checksum?: string | null;
}
export interface AccountHistoryEvidence {
  /** Exact source artifact, independently checked against its archive manifest. */
  artifactSha256: string;
  archiveHashVerified: boolean;
  observedOn: string;
  /** Requested audit cutoff; an older archive cannot establish current coverage. */
  requiredThrough: string;
  /** All three tenant partitions and unfiltered, exhausted financial pagination. */
  tenantPartitionsComplete: Record<"current" | "future" | "past", boolean>;
  collectionsComplete: Record<AccountHistoryKind, boolean>;
  /** Includes payments with an explicitly empty allocation array. */
  allocationEmbeddingVerified: boolean;
  /** Confirms exact account ownership and no unassigned source rows. */
  accountJoinVerified: boolean;
  /** Actual target inspection, never a local rehearsal or import-run claim. */
  targetReadbackVerified: boolean;
  sourceRows: AccountHistoryRow[];
}
export interface AccountHistoryKindCoverage {
  sourceCount: number | null;
  appliedCount: number;
  sourceDateRange: { first: string | null; last: string | null };
  appliedDateRange: { first: string | null; last: string | null };
  missingCount: number;
  duplicateSourceCount: number;
  duplicateAppliedCount: number;
  checksumMismatchCount: number;
  dateMismatchCount: number;
}
export interface AccountHistoryCoverage {
  status: AccountHistoryCoverageStatus;
  complete: boolean;
  observedOn: string | null;
  reasons: string[];
  kinds: Record<AccountHistoryKind, AccountHistoryKindCoverage>;
  /** Internal-only source IDs for an insert-missing plan; never generate rent. */
  missingSourceRows: AccountHistoryRow[];
}
const date = (value: string | null | undefined): string | null =>
  value && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) && Number.isFinite(Date.parse(value)) ? value.slice(0, 10) : null;
const range = (rows: AccountHistoryRow[]) => {
  const dates = rows.map(row => date(row.postedOn)).filter((value): value is string => value !== null).sort();
  return { first: dates[0] ?? null, last: dates.at(-1) ?? null };
};
const key = (row: AccountHistoryRow) => JSON.stringify([row.kind, row.sourceId]);
const duplicates = (rows: AccountHistoryRow[]) => rows.length - new Set(rows.map(key)).size;

/** Pure read-only comparison. A ledger balance and historical coverage are independent. */
export function assessAccountHistoryCoverage(appliedRows: AccountHistoryRow[], evidence?: AccountHistoryEvidence): AccountHistoryCoverage {
  const reasons: string[] = [];
  if (!evidence) reasons.push("source_coverage_not_verified");
  else {
    if (!evidence.archiveHashVerified || !/^[a-f0-9]{64}$/i.test(evidence.artifactSha256)) reasons.push("archive_identity_not_verified");
    if (!date(evidence.observedOn) || !date(evidence.requiredThrough) || evidence.observedOn < evidence.requiredThrough) reasons.push("source_observation_outdated_or_unknown");
    if (!["current", "future", "past"].every(partition => evidence.tenantPartitionsComplete[partition as "current"] === true)) reasons.push("tenant_partitions_incomplete");
    if (!evidence.allocationEmbeddingVerified) reasons.push("allocation_embedding_not_verified");
    if (!evidence.accountJoinVerified) reasons.push("account_join_not_verified");
    if (!evidence.targetReadbackVerified) reasons.push("target_readback_not_verified");
  }
  const missingSourceRows: AccountHistoryRow[] = [];
  const kinds = Object.fromEntries(ACCOUNT_HISTORY_KINDS.map(kind => {
    const source = evidence?.sourceRows.filter(row => row.kind === kind) ?? [];
    const applied = appliedRows.filter(row => row.kind === kind);
    const byKey = new Map(applied.filter(row => row.sourceId).map(row => [key(row), row]));
    const missing = source.filter(row => row.sourceId && !byKey.has(key(row)));
    // Only unambiguous, dated source identities may enter a later reviewed import plan.
    missingSourceRows.push(...missing.filter(row => row.checksum && date(row.postedOn) && source.filter(other => key(other) === key(row)).length === 1));
    const mismatches = source.filter(row => row.sourceId && byKey.has(key(row)) && (!row.checksum || byKey.get(key(row))!.checksum !== row.checksum)).length;
    const dateMismatches = source.filter(row => row.sourceId && byKey.has(key(row)) && date(row.postedOn) !== date(byKey.get(key(row))!.postedOn)).length;
    const duplicateSourceCount = duplicates(source);
    const duplicateAppliedCount = duplicates(applied);
    if (evidence && !evidence.collectionsComplete[kind]) reasons.push(`${kind}_collection_incomplete`);
    if ([...source, ...applied].some(row => !row.sourceId)) reasons.push(`${kind}_source_identity_missing`);
    if (source.some(row => !date(row.postedOn))) reasons.push(`${kind}_source_date_missing`);
    if (missing.length) reasons.push(`${kind}_missing_from_target`);
    if (duplicateSourceCount || duplicateAppliedCount) reasons.push(`${kind}_duplicate_identity`);
    if (mismatches) reasons.push(`${kind}_source_checksum_mismatch`);
    if (dateMismatches) reasons.push(`${kind}_posted_date_mismatch`);
    return [kind, { sourceCount: evidence ? source.length : null, appliedCount: applied.length,
      sourceDateRange: range(source), appliedDateRange: range(applied), missingCount: missing.length,
      duplicateSourceCount, duplicateAppliedCount, checksumMismatchCount: mismatches, dateMismatchCount: dateMismatches }];
  })) as Record<AccountHistoryKind, AccountHistoryKindCoverage>;
  return { status: !evidence ? "unverified" : reasons.length ? "partial" : "verified", complete: Boolean(evidence) && reasons.length === 0,
    observedOn: evidence ? date(evidence.observedOn) : null, reasons, kinds, missingSourceRows };
}

/** Unknown coverage remains unknown even when a person's ledger has posted money. */
export function getAccountHistoryCoverage(snapshot: RentOpsSnapshot, personId: string, evidence?: AccountHistoryEvidence): AccountHistoryCoverage {
  const tenancies = new Set(snapshot.tenancies.filter(row => row.primaryPersonId === personId).map(row => row.id));
  const transactions = snapshot.ledgerTransactions.filter(row => row.personId === personId || (row.tenancyId && tenancies.has(row.tenancyId)));
  const transactionIds = new Set(transactions.map(row => row.id));
  const sourceChecksum = (targetId: string, sourceId: string) => snapshot.sourceRecords.find(row => row.system === "rent_manager" && row.sourceId === sourceId && row.targetId === targetId)?.checksum;
  const applied: AccountHistoryRow[] = [];
  for (const row of transactions) {
    if (row.source?.system !== "rent_manager") continue; // Native money is preserved, not RM parity evidence.
    const prefix = row.source.sourceId.split(":")[0];
    const kind = ({ charge: "charges", payment: "payments", credit: "credits" } as const)[prefix as "charge"];
    if (kind) applied.push({ kind, sourceId: row.source.sourceId, postedOn: row.postedOn, checksum: sourceChecksum(row.id, row.source.sourceId) });
  }
  for (const row of snapshot.paymentAllocations) {
    if (row.source?.system !== "rent_manager" || ![row.paymentTransactionId, row.chargeTransactionId, row.creditTransactionId].some(id => id && transactionIds.has(id))) continue;
    applied.push({ kind: "allocations", sourceId: row.source.sourceId, postedOn: row.allocatedOn, checksum: sourceChecksum(row.id, row.source.sourceId) });
  }
  return assessAccountHistoryCoverage(applied, evidence);
}
