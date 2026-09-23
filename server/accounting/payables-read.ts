import {
  accountingPayablesQuerySchema,
  accountingPayablesResponseSchema,
  type AccountingPayable,
  type AccountingPayablesQuery,
  type AccountingPayablesResponse,
} from "../../shared/accounting/operations";
import { isoDateSchema } from "../../shared/company";
import { authorizeCompanyRead, type AuthenticatedPrincipal } from "../company/authorization";
import { ValidationCommandError } from "../company/commands/errors";
import { qboAmountToCents } from "../integrations/quickbooks/normalize";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { createQboAccountingMirrorStore } from "./mirror-store";
import { ACCOUNTING_READ_ROLES } from "./posting-policy";

interface Cursor { readonly date: string; readonly id: string }
const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
function decode(value: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.id !== "string" || parsed.id.length > 200) throw new Error("id");
    return { date: isoDateSchema.parse(parsed.date), id: parsed.id };
  } catch {
    throw new ValidationCommandError("Bills cursor is invalid", { reason: "invalid_cursor" });
  }
}

function text(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : null;
}

function refName(body: Record<string, unknown>, key: string): string | null {
  const ref = body[key];
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return null;
  const name = (ref as Record<string, unknown>).name;
  return typeof name === "string" && name.trim() ? name.trim().slice(0, 200) : null;
}

function refId(body: Record<string, unknown>, key: string): string | null {
  const ref = body[key];
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return null;
  const value = (ref as Record<string, unknown>).value;
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

/** Read-only AP view: current, non-deleted Bill or BillPayment revisions from the mirror. */
export async function listAccountingPayables(executor: RentOpsQueryExecutor, principal: AuthenticatedPrincipal, input: AccountingPayablesQuery): Promise<AccountingPayablesResponse> {
  const query = accountingPayablesQuerySchema.parse(input);
  authorizeCompanyRead(principal, { organizationId: query.organizationId, legalEntityId: query.legalEntityId }, ACCOUNTING_READ_ROLES);
  const objectType = query.kind === "payments" ? "BillPayment" : "Bill";
  const values: unknown[] = [query.organizationId, query.legalEntityId, query.environment, query.realmId, objectType];
  const where: string[] = [];
  const add = (value: unknown) => { values.push(value); return `$${values.length}`; };
  if (query.from) where.push(`latest.transaction_date >= ${add(query.from)}::date`);
  if (query.through) where.push(`latest.transaction_date <= ${add(query.through)}::date`);
  if (query.cursor) {
    const cursor = decode(query.cursor);
    where.push(`(latest.transaction_date, latest.object_id) < (${add(cursor.date)}::date, ${add(cursor.id)})`);
  }
  const limit = add(query.limit + 1);
  const rows = await executor.query<Record<string, unknown>>(
    `SELECT latest.*, (
         SELECT SUM(b.amount_cents)::text FROM accounting_qbo_source_line_balances b
          WHERE b.organization_id=$1 AND b.legal_entity_id=$2 AND b.environment=$3 AND b.realm_id=$4
            AND b.object_type=$5 AND b.object_id=latest.object_id AND b.is_current AND b.latest_version=latest.object_version
       ) AS amount_cents,
       (SELECT v.provider_body->>'DisplayName' FROM accounting_qbo_source_objects v
          WHERE v.organization_id=$1 AND v.legal_entity_id=$2 AND v.environment=$3 AND v.realm_id=$4 AND v.object_type='Vendor'
            AND v.object_id = latest.provider_body->'VendorRef'->>'value' AND v.deleted_at IS NULL
          ORDER BY v.provider_updated_at DESC NULLS LAST LIMIT 1) AS vendor_display_name
       FROM (
         SELECT DISTINCT ON (t.object_id) t.object_id, t.object_version, t.transaction_date, t.posting_state, t.currency, o.provider_body
           FROM accounting_qbo_transactions t
           JOIN accounting_qbo_source_objects o ON o.organization_id=t.organization_id AND o.id=t.source_object_id
          WHERE t.organization_id=$1 AND t.legal_entity_id=$2 AND t.environment=$3 AND t.realm_id=$4 AND t.object_type=$5
            AND EXISTS (SELECT 1 FROM accounting_qbo_source_objects l
                         WHERE l.organization_id=t.organization_id AND l.legal_entity_id=t.legal_entity_id AND l.environment=t.environment
                           AND l.realm_id=t.realm_id AND l.object_type=t.object_type AND l.object_id=t.object_id AND l.deleted_at IS NULL)
          ORDER BY t.object_id, t.updated_at DESC, t.object_version DESC
       ) latest
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY latest.transaction_date DESC, latest.object_id DESC
      LIMIT ${limit}`,
    values,
  );
  const items: AccountingPayable[] = rows.rows.slice(0, query.limit).map(row => {
    const body = row.provider_body && typeof row.provider_body === "object" ? row.provider_body as Record<string, unknown> : {};
    let openBalance: string | null = null;
    if (objectType === "Bill" && body.Balance !== undefined && body.Balance !== null) {
      try { openBalance = qboAmountToCents(body.Balance, "Bill balance"); } catch { openBalance = null; }
    }
    const due = text(body, "DueDate");
    const amount = row.amount_cents === null || row.amount_cents === undefined ? null : String(row.amount_cents);
    return {
      objectType, objectId: String(row.object_id), version: String(row.object_version), docNumber: text(body, "DocNumber"),
      vendorName: (typeof row.vendor_display_name === "string" ? row.vendor_display_name : null) ?? refName(body, "VendorRef") ?? (refId(body, "VendorRef") ? `Vendor ${refId(body, "VendorRef")}` : null),
      transactionDate: row.transaction_date instanceof Date ? row.transaction_date.toISOString().slice(0, 10) : String(row.transaction_date).slice(0, 10),
      dueDate: due && isoDateSchema.safeParse(due).success ? due : null,
      currency: String(row.currency), amountCents: amount, openBalanceCents: openBalance,
      postingState: row.posting_state === "voided" ? "voided" : row.posting_state === "posted" ? "posted" : "unknown",
      mirrored: amount !== null,
    } as AccountingPayable;
  });
  const coverage = await createQboAccountingMirrorStore(executor).readCoverage({ provider: "qbo", organizationId: query.organizationId, legalEntityId: query.legalEntityId, environment: query.environment, realmId: query.realmId } as never, objectType === "Bill" ? "transactions.bill" : "transactions.billpayment");
  const last = items.at(-1);
  return accountingPayablesResponseSchema.parse({ items, nextCursor: rows.rows.length > query.limit && last ? encode({ date: last.transactionDate, id: last.objectId }) : null, coverage: { status: coverage.status, reason: coverage.reason } });
}
