import { z } from "zod";
import { centsFromBigInt, isoDateSchema, type IsoDate, type MoneyCents } from "../../shared/company";
import { financialSourceScopeSchema, type FinancialSourceScope } from "../../shared/accounting";
import {
  QBO_RECEIVABLE_STREAMS,
  type QboAgingBuckets,
  type QboCustomerLedger,
  type QboCustomerLedgerEntry,
  type QboReceivableDocumentType,
  type QboReceivableEffectKind,
} from "../../shared/accounting/receivables";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { AccountingError } from "./errors";
import { currentBusinessDate, resolveTenancyHistory } from "./tenancy-source-resolution";

/*
 * The one read path for QuickBooks-backed tenant/customer financial history
 * (plan QS04). Manager screens, statements, exports and agent tools use it,
 * so the same question returns the same numbers everywhere.
 *
 * - Only live (not deleted), fully mirrored revisions count.
 * - The running balance is computed over the customer's COMPLETE history
 *   before paging, so page 7 never restarts at zero.
 * - The computed balance is checked against QuickBooks' own Customer.Balance;
 *   a gap is reported as a mismatch, never hidden.
 * - Coverage is reported with every answer; unavailable or partial data is
 *   never presented as a zero balance.
 */

const MAX_PAGE = 500;
const TYPE_RANK: Readonly<Record<QboReceivableDocumentType, number>> = { Invoice: 1, JournalEntry: 2, SalesReceipt: 3, CreditMemo: 4, Payment: 5, RefundReceipt: 6 };

const customerIdSchema = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
const cursorSchema = z.string().regex(/^[0-9]{1,9}\.[a-f0-9]{16}$/);

export interface CustomerLedgerQuery {
  readonly scope: FinancialSourceScope;
  readonly customerObjectId: string;
  /** Include documents dated on or before this day; aging is measured from it. Defaults to all history, aged as of `today`. */
  readonly asOf?: string;
  readonly today: string;
  readonly limit?: number;
  readonly cursor?: string;
}

function scopeParts(scope: FinancialSourceScope): unknown[] {
  return [scope.organizationId, scope.legalEntityId, scope.environment, scope.realmId];
}

function cents(value: unknown): MoneyCents {
  if (typeof value === "bigint") return centsFromBigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return centsFromBigInt(BigInt(value));
  if (typeof value === "string" && /^-?\d+$/.test(value)) return centsFromBigInt(BigInt(value));
  throw new AccountingError("accounting_unavailable", "Receivable amount could not be read exactly");
}

function dateOf(value: unknown): IsoDate {
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : typeof value === "string" ? value.slice(0, 10) : "";
  return isoDateSchema.parse(text);
}

function optionalDate(value: unknown): IsoDate | null {
  return value === null || value === undefined ? null : dateOf(value);
}

/** QBO Customer.Balance as exact cents; numbers are admitted only within the safe range. */
export function providerBalanceCents(value: unknown): MoneyCents | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "number" ? (Number.isFinite(value) && Math.abs(value) < Number.MAX_SAFE_INTEGER / 100 ? value.toFixed(2) : null) : typeof value === "string" ? value.trim() : null;
  if (text === null) return null;
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const whole = BigInt(match[2]!) * BigInt(100) + BigInt((match[3] ?? "").padEnd(2, "0") || "0");
  return centsFromBigInt(match[1] === "-" ? -whole : whole);
}

function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function fingerprint(total: number, latestMirroredAt: string | null): string {
  // Detects a ledger that changed between pages; not a security boundary.
  let hash = BigInt("0xcbf29ce484222325");
  for (const character of `${total}|${latestMirroredAt ?? ""}`) {
    hash ^= BigInt(character.charCodeAt(0));
    hash = (hash * BigInt("0x100000001b3")) & BigInt("0xffffffffffffffff");
  }
  return hash.toString(16).padStart(16, "0");
}

interface DocRow {
  object_type: QboReceivableDocumentType;
  object_id: string;
  object_version: string;
  txn_date: unknown;
  due_date: unknown;
  doc_number: string | null;
  open_balance_cents: unknown;
  posting_state: "posted" | "voided";
  amount_cents: unknown;
  running_balance_cents: unknown;
  kinds: string | null;
  total_count: unknown;
  latest_mirrored_at: unknown;
}

export async function readCustomerLedger(executor: RentOpsQueryExecutor, query: CustomerLedgerQuery): Promise<QboCustomerLedger> {
  const scope = financialSourceScopeSchema.parse(query.scope);
  const customerObjectId = customerIdSchema.parse(query.customerObjectId);
  const today = isoDateSchema.parse(query.today);
  const asOf = query.asOf === undefined ? null : isoDateSchema.parse(query.asOf);
  const limit = Math.min(Math.max(query.limit ?? 100, 1), MAX_PAGE);
  const cursor = query.cursor === undefined ? null : cursorSchema.parse(query.cursor);
  const offset = cursor ? Number(cursor.split(".")[0]) : 0;
  const parts = scopeParts(scope);

  const customer = (await executor.query<{ provider_body: Record<string, unknown> | null; provider_updated_at: unknown }>(
    `SELECT COALESCE(ob.provider_body,o.provider_body) AS provider_body,
            COALESCE(ob.provider_updated_at,o.provider_updated_at) AS provider_updated_at
       FROM accounting_qbo_source_objects o
       LEFT JOIN LATERAL (
         SELECT n.provider_body,n.provider_updated_at
           FROM accounting_qbo_named_observations n
          WHERE n.organization_id=o.organization_id AND n.legal_entity_id=o.legal_entity_id
            AND n.environment=o.environment AND n.realm_id=o.realm_id
            AND n.object_type=o.object_type AND n.object_id=o.object_id AND n.object_version=o.object_version
            AND n.material_conflict=false
          ORDER BY n.observed_at DESC,n.observation_order DESC LIMIT 1
       ) ob ON true
      WHERE o.organization_id=$1 AND o.legal_entity_id=$2 AND o.environment=$3 AND o.realm_id=$4
        AND o.object_type='Customer' AND o.object_id=$5 AND o.deleted_at IS NULL
      ORDER BY CASE WHEN o.object_version ~ '^[0-9]+$' THEN 0 ELSE 1 END,
               CASE WHEN o.object_version ~ '^[0-9]+$' THEN length(o.object_version) ELSE 0 END DESC,
               CASE WHEN o.object_version ~ '^[0-9]+$' THEN o.object_version ELSE '' END DESC,
               COALESCE(ob.provider_updated_at,o.provider_updated_at) DESC NULLS LAST,o.received_at DESC LIMIT 1`,
    [...parts, customerObjectId],
  )).rows[0];
  const body = customer?.provider_body && typeof customer.provider_body === "object" ? customer.provider_body : null;

  const rankCase = `CASE d.object_type ${Object.entries(TYPE_RANK).map(([type, rank]) => `WHEN '${type}' THEN ${rank}`).join(" ")} END`;
  const rows = (await executor.query<DocRow>(
    `WITH live AS (
       SELECT d.object_type, d.object_id, d.object_version, d.txn_date, d.due_date, d.doc_number, d.open_balance_cents, d.posting_state, d.mirrored_at, ${rankCase} AS type_rank
         FROM accounting_qbo_receivable_documents d
         JOIN accounting_qbo_source_objects s ON s.id = d.source_object_id AND s.deleted_at IS NULL
         JOIN company_legal_entities le ON le.organization_id=d.organization_id AND le.id=d.legal_entity_id AND le.currency=d.currency
        WHERE d.organization_id=$1 AND d.legal_entity_id=$2 AND d.environment=$3 AND d.realm_id=$4 AND d.mirror_state='current' AND d.posting_state='posted'
          AND ($6::date IS NULL OR d.txn_date <= $6::date)
     ), per_doc AS (
       SELECT l.object_type, l.object_id, l.object_version, l.txn_date, l.due_date, l.doc_number, l.open_balance_cents, l.posting_state, l.type_rank, l.mirrored_at,
              SUM(e.amount_cents)::text AS amount_cents, string_agg(DISTINCT e.effect_kind, ',') AS kinds
         FROM live l
         JOIN accounting_qbo_receivable_effects e
           ON e.organization_id=$1 AND e.legal_entity_id=$2 AND e.environment=$3 AND e.realm_id=$4
          AND e.object_type=l.object_type AND e.object_id=l.object_id AND e.object_version=l.object_version
        WHERE e.customer_object_id=$5
        GROUP BY l.object_type, l.object_id, l.object_version, l.txn_date, l.due_date, l.doc_number, l.open_balance_cents, l.posting_state, l.type_rank, l.mirrored_at
     ), ordered AS (
       SELECT p.*,
              SUM(p.amount_cents::bigint) OVER (ORDER BY p.txn_date, p.type_rank, p.object_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::text AS running_balance_cents,
              COUNT(*) OVER () AS total_count,
              MAX(p.mirrored_at) OVER () AS latest_mirrored_at
         FROM per_doc p
     )
     SELECT object_type, object_id, object_version, txn_date, due_date, doc_number, open_balance_cents::text AS open_balance_cents, posting_state,
            amount_cents, running_balance_cents, kinds, total_count, latest_mirrored_at
       FROM ordered
      ORDER BY txn_date, type_rank, object_id`,
    [...parts, customerObjectId, asOf],
  )).rows;

  const total = rows.length;
  const latestMirroredAt = rows[0]?.latest_mirrored_at instanceof Date ? (rows[0].latest_mirrored_at as Date).toISOString() : rows[0]?.latest_mirrored_at ? String(rows[0].latest_mirrored_at) : null;
  const print = fingerprint(total, latestMirroredAt);
  if (cursor && cursor.split(".")[1] !== print) throw new AccountingError("accounting_conflict", "The customer ledger changed while paging; reload from the first page");
  if (offset > total) throw new AccountingError("accounting_validation", "Ledger cursor is past the end");

  const entries: QboCustomerLedgerEntry[] = rows.slice(offset, offset + limit).map(row => ({
    objectType: row.object_type,
    objectId: String(row.object_id),
    version: String(row.object_version),
    txnDate: dateOf(row.txn_date),
    dueDate: optionalDate(row.due_date),
    docNumber: row.doc_number,
    kinds: (row.kinds ?? "").split(",").filter(Boolean).sort() as QboReceivableEffectKind[],
    amountCents: cents(row.amount_cents),
    runningBalanceCents: cents(row.running_balance_cents),
    openBalanceCents: row.open_balance_cents === null ? null : cents(row.open_balance_cents),
    postingState: row.posting_state,
  }));

  // Totals over the complete (as-of) history, by effect kind.
  const totalsRows = (await executor.query<{ effect_kind: QboReceivableEffectKind; amount_cents: unknown }>(
    `SELECT e.effect_kind, SUM(e.amount_cents)::text AS amount_cents
       FROM accounting_qbo_receivable_effects e
       JOIN accounting_qbo_receivable_documents d ON d.organization_id=e.organization_id AND d.legal_entity_id=e.legal_entity_id AND d.environment=e.environment AND d.realm_id=e.realm_id
        AND d.object_type=e.object_type AND d.object_id=e.object_id AND d.object_version=e.object_version AND d.mirror_state='current' AND d.posting_state='posted'
       JOIN company_legal_entities le ON le.organization_id=d.organization_id AND le.id=d.legal_entity_id AND le.currency=d.currency
       JOIN accounting_qbo_source_objects s ON s.id = d.source_object_id AND s.deleted_at IS NULL
      WHERE e.organization_id=$1 AND e.legal_entity_id=$2 AND e.environment=$3 AND e.realm_id=$4 AND e.customer_object_id=$5
        AND ($6::date IS NULL OR d.txn_date <= $6::date)
      GROUP BY e.effect_kind`,
    [...parts, customerObjectId, asOf],
  )).rows;
  const byKind = new Map(totalsRows.map(row => [row.effect_kind, BigInt(cents(row.amount_cents))]));
  const pick = (...kinds: QboReceivableEffectKind[]) => kinds.reduce((sum, kind) => sum + (byKind.get(kind) ?? BigInt(0)), BigInt(0));
  const ending = pick("charge", "discount", "credit", "payment", "receipt", "refund", "adjustment");

  // Open items as QuickBooks reports them (Invoice.Balance, remaining credit, unapplied payment).
  const openRows = (await executor.query<{ object_type: "Invoice" | "CreditMemo" | "Payment"; object_id: string; doc_number: string | null; txn_date: unknown; due_date: unknown; open_balance_cents: unknown }>(
    `SELECT d.object_type, d.object_id, d.doc_number, d.txn_date, d.due_date, d.open_balance_cents::text AS open_balance_cents
       FROM accounting_qbo_receivable_documents d
       JOIN accounting_qbo_source_objects s ON s.id = d.source_object_id AND s.deleted_at IS NULL
       JOIN company_legal_entities le ON le.organization_id=d.organization_id AND le.id=d.legal_entity_id AND le.currency=d.currency
      WHERE d.organization_id=$1 AND d.legal_entity_id=$2 AND d.environment=$3 AND d.realm_id=$4 AND d.customer_object_id=$5
        AND d.mirror_state='current' AND d.posting_state='posted' AND d.object_type IN ('Invoice','CreditMemo','Payment') AND d.open_balance_cents IS NOT NULL AND d.open_balance_cents <> 0
      ORDER BY COALESCE(d.due_date, d.txn_date), d.txn_date, d.object_id`,
    [...parts, customerObjectId],
  )).rows;
  const agingDate = asOf ?? today;
  const openItems = openRows.map(row => {
    const due = optionalDate(row.due_date);
    const txnDate = dateOf(row.txn_date);
    return {
      objectType: row.object_type,
      objectId: String(row.object_id),
      docNumber: row.doc_number,
      txnDate,
      dueDate: due,
      openBalanceCents: cents(row.open_balance_cents),
      daysPastDue: row.object_type === "Invoice" ? Math.max(0, daysBetween(due ?? txnDate, agingDate)) : null,
    };
  });
  const bucket = { current: BigInt(0), d30: BigInt(0), d60: BigInt(0), d90: BigInt(0), over: BigInt(0) };
  for (const item of openItems) {
    // Unapplied payments and credits stay listed as open items; aging buckets hold invoices only.
    if (item.objectType !== "Invoice") continue;
    const amount = BigInt(item.openBalanceCents);
    const days = item.daysPastDue ?? 0;
    if (days <= 0) bucket.current += amount;
    else if (days <= 30) bucket.d30 += amount;
    else if (days <= 60) bucket.d60 += amount;
    else if (days <= 90) bucket.d90 += amount;
    else bucket.over += amount;
  }
  const aging: QboAgingBuckets | null = asOf === null || asOf >= today
    ? { currentCents: centsFromBigInt(bucket.current), days1To30Cents: centsFromBigInt(bucket.d30), days31To60Cents: centsFromBigInt(bucket.d60), days61To90Cents: centsFromBigInt(bucket.d90), over90Cents: centsFromBigInt(bucket.over) }
    // Open balances are today's QuickBooks values; aging an earlier date from them would misstate it.
    : null;

  // Coverage of the streams this answer depends on.
  const coverageRows = (await executor.query<{ stream: string; status: string; evidence: string; observed_at: unknown; reason: string | null }>(
    `SELECT stream, status, evidence, observed_at, reason FROM accounting_qbo_coverage
      WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND stream = ANY($5::text[])`,
    [...parts, [...QBO_RECEIVABLE_STREAMS]],
  )).rows;
  const exceptions = (await executor.query<{ stream: string; open_count: unknown }>(
    `SELECT stream, COUNT(*) AS open_count FROM accounting_qbo_sync_exceptions
      WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND resolved_at IS NULL AND stream = ANY($5::text[])
      GROUP BY stream`,
    [...parts, [...QBO_RECEIVABLE_STREAMS]],
  )).rows;
  const covered = new Map(coverageRows.map(row => [row.stream, row]));
  const reasons: string[] = [];
  const missing = QBO_RECEIVABLE_STREAMS.filter(stream => !covered.has(stream));
  if (missing.length) reasons.push(`QuickBooks receivables have not been read yet for: ${missing.join(", ")}`);
  for (const row of coverageRows) {
    if (row.status !== "complete" || row.evidence !== "live_provider_readback") reasons.push(`${row.stream}: ${row.reason ?? "partial coverage"}`);
  }
  const openExceptions = exceptions.reduce((sum, row) => sum + Number(row.open_count ?? 0), 0);
  if (openExceptions > 0) reasons.push(`${openExceptions} QuickBooks receivable record(s) could not be mirrored and are excluded until resolved`);
  const currencyGaps = (await executor.query<{ count: unknown; currencies: string | null }>(
    `SELECT COUNT(*) AS count, string_agg(DISTINCT d.currency, ',') AS currencies
       FROM accounting_qbo_receivable_documents d
       JOIN accounting_qbo_source_objects s ON s.id=d.source_object_id AND s.deleted_at IS NULL
       JOIN company_legal_entities le ON le.organization_id=d.organization_id AND le.id=d.legal_entity_id
      WHERE d.organization_id=$1 AND d.legal_entity_id=$2 AND d.environment=$3 AND d.realm_id=$4 AND d.mirror_state='current'
        AND d.currency IS DISTINCT FROM le.currency`,
    parts,
  )).rows[0];
  const foreignCurrencyCount = Number(currencyGaps?.count ?? 0);
  if (foreignCurrencyCount > 0) reasons.push(`${foreignCurrencyCount} QuickBooks receivable document(s) use a currency different from the legal entity and are excluded${currencyGaps?.currencies ? ` (${currencyGaps.currencies})` : ""}`);
  const unsupportedForCustomer = Number((await executor.query<{ n: unknown }>(
    `SELECT COUNT(*) AS n FROM accounting_qbo_receivable_documents
      WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND customer_object_id=$5 AND mirror_state='unsupported'`,
    [...parts, customerObjectId],
  )).rows[0]?.n ?? 0);
  if (unsupportedForCustomer > 0) reasons.push(`${unsupportedForCustomer} of this customer's documents changed in QuickBooks in a way the mirror cannot read; they are excluded`);
  const coverageStatus: QboCustomerLedger["coverage"]["status"] = coverageRows.length === 0 ? "unavailable" : reasons.length ? "partial" : "complete";
  const observed = coverageRows.map(row => row.observed_at instanceof Date ? row.observed_at.toISOString() : String(row.observed_at)).sort().at(-1) ?? null;

  // Verify the complete-history balance against QuickBooks' Customer.Balance.
  const providerBalance = providerBalanceCents(body?.Balance);
  let verification: QboCustomerLedger["verification"];
  if (!body) {
    verification = { state: "unavailable", providerBalanceCents: null, computedBalanceCents: null, reason: "The QuickBooks customer has not been mirrored" };
  } else if (asOf !== null && asOf < today) {
    verification = { state: "unverified", providerBalanceCents: providerBalance, computedBalanceCents: centsFromBigInt(ending), reason: "QuickBooks reports only the current customer balance; an earlier as-of date cannot be verified against it" };
  } else if (providerBalance === null) {
    verification = { state: "unverified", providerBalanceCents: null, computedBalanceCents: centsFromBigInt(ending), reason: "QuickBooks did not report a customer balance" };
  } else if (BigInt(providerBalance) === ending) {
    verification = { state: coverageStatus === "complete" ? "verified" : "unverified", providerBalanceCents: providerBalance, computedBalanceCents: centsFromBigInt(ending), reason: coverageStatus === "complete" ? null : "Balances agree, but receivable coverage is not complete" };
  } else {
    verification = { state: "mismatch", providerBalanceCents: providerBalance, computedBalanceCents: centsFromBigInt(ending), reason: "The mirrored history does not add up to QuickBooks' customer balance; some activity is not mirrored or is newer than the last sync" };
  }

  const nextOffset = offset + entries.length;
  return {
    scope: { organizationId: scope.organizationId, legalEntityId: scope.legalEntityId, environment: scope.environment, realmId: scope.realmId },
    customer: { objectId: customerObjectId, displayName: typeof body?.DisplayName === "string" ? body.DisplayName : null, active: typeof body?.Active === "boolean" ? body.Active : null },
    asOf,
    entries,
    totals: {
      chargesCents: centsFromBigInt(pick("charge", "discount")),
      creditsCents: centsFromBigInt(pick("credit")),
      paymentsCents: centsFromBigInt(pick("payment", "receipt", "refund")),
      adjustmentsCents: centsFromBigInt(pick("adjustment")),
      endingBalanceCents: centsFromBigInt(ending),
    },
    openItems,
    aging,
    verification,
    coverage: { status: coverageStatus, reasons, observedAt: observed },
    page: { total, nextCursor: nextOffset < total ? `${nextOffset}.${print}` : null },
  };
}

/**
 * The QuickBooks customer linked to a tenancy, through the immutable
 * external identity map. Returns null when the tenancy is not linked yet —
 * callers must show "not linked", never a zero balance.
 */
export async function resolveTenancyCustomer(executor: RentOpsQueryExecutor, input: { readonly organizationId: string; readonly tenancyId: string; readonly environment: "sandbox" | "production"; readonly asOf?: string }): Promise<{ readonly scope: FinancialSourceScope; readonly customerObjectId: string } | null> {
  const history = await resolveTenancyHistory(executor, {
    organizationId: input.organizationId,
    tenancyId: input.tenancyId,
    asOf: input.asOf ?? currentBusinessDate(),
  });
  // A customer link is usable only when the full historical tenancy interval
  // resolves to one owner. The identity map alone is not an ownership proof.
  if (!history?.effectiveLegalEntityId) return null;
  const rows = (await executor.query<{ legal_entity_id: string; source_scope: string; external_id: string }>(
    `SELECT i.legal_entity_id, i.source_scope, i.external_id
       FROM company_external_identities i
      WHERE i.organization_id=$1 AND i.provider='qbo' AND i.record_kind='Customer' AND i.local_kind='tenancy' AND i.local_id=$2 AND i.source_scope LIKE $3
      ORDER BY i.created_at`,
    [input.organizationId, input.tenancyId, `qbo:${input.environment}:%`],
  )).rows;
  if (rows.length === 0) return null;
  if (rows.length > 1) throw new AccountingError("accounting_conflict", "This tenancy is linked to more than one QuickBooks customer; resolve the mapping before showing its history");
  const row = rows[0]!;
  if (row.legal_entity_id !== history.effectiveLegalEntityId) return null;
  const match = /^qbo:(sandbox|production):(\d{1,32})$/.exec(row.source_scope);
  if (!match) throw new AccountingError("accounting_unavailable", "The tenancy's QuickBooks mapping has an invalid scope");
  return {
    scope: financialSourceScopeSchema.parse({ provider: "qbo", organizationId: input.organizationId, legalEntityId: row.legal_entity_id, environment: match[1], realmId: match[2] }),
    customerObjectId: customerIdSchema.parse(row.external_id),
  };
}
