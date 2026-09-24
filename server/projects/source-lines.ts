import {
  centsFromBigInt,
  centsToBigInt,
  isoDateSchema,
  type IsoDate,
} from "../../shared/company";
import {
  financialSourceCoverageSchema,
  financialSourceLineResolutionSchema,
  financialSourceReferenceSchema,
  type FinancialSourceAllocationBalance,
  type FinancialSourceAllocationRequest,
  type FinancialSourceLineResolution,
  type FinancialSourceReference,
  type FinancialSourceScope,
} from "../../shared/accounting/source";
import {
  costSourceLinePageSchema,
  costSourceLineQuerySchema,
  sameFinancialSourceReference,
  type CostSourceLinePage,
  type CostSourceLinePurpose,
  type CostSourceLineQuery,
} from "../../shared/projects/source-lines";
import { authorizeCompanyRead, type AuthenticatedPrincipal } from "../company/authorization";
import { ValidationCommandError } from "../company/commands/errors";
import { AccountingError } from "../accounting/errors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import type { ProjectExecutionFinancePorts } from "./execution-commands";

export const COST_SOURCE_LINE_READ_ROLES = ["owner", "admin", "finance", "operations_pm", "project_manager", "read_only_reviewer"] as const;

interface LineCursor { readonly postedOn: string; readonly objectType: string; readonly objectId: string; readonly lineId: string }

function encodeCursor(value: LineCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): LineCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.postedOn !== "string" || typeof parsed.objectType !== "string" || typeof parsed.objectId !== "string" || typeof parsed.lineId !== "string") throw new Error("cursor");
    return { postedOn: isoDateSchema.parse(parsed.postedOn), objectType: parsed.objectType, objectId: parsed.objectId, lineId: parsed.lineId };
  } catch {
    throw new ValidationCommandError("Source line cursor is invalid", { reason: "invalid_source_line_cursor" });
  }
}

function text(value: unknown): string { return value instanceof Date ? value.toISOString().slice(0, 10) : String(value); }

const PURPOSE_FILTER: Readonly<Record<CostSourceLinePurpose, string>> = {
  cost: "b.flow = 'outgoing' AND b.line_role IN ('expense','payable')",
  // Deposit cash-back is an outgoing debit to an explicitly named provider
  // account, but it is not payroll evidence. Keep it visible in the source
  // mirror while excluding it from the payroll picker.
  payroll: "b.direction = 'debit' AND b.flow <> 'incoming' AND b.line_role IN ('expense','payable','unknown') AND b.transaction_type <> 'Deposit'",
};

/**
 * Current posted QBO lines with their unallocated balance. Allocations from
 * projects, work orders and payroll links share one ledger, so the available
 * amount shown here is exactly what a new link may still reserve.
 */
export async function searchCostSourceLines(executor: RentOpsQueryExecutor, principal: AuthenticatedPrincipal, input: CostSourceLineQuery): Promise<CostSourceLinePage> {
  const query = costSourceLineQuerySchema.parse(input);
  authorizeCompanyRead(principal, { organizationId: query.organizationId, legalEntityId: query.legalEntityId }, COST_SOURCE_LINE_READ_ROLES);
  const values: unknown[] = [query.organizationId, query.legalEntityId];
  const add = (value: unknown): string => { values.push(value); return `$${values.length}`; };
  const where = [
    "b.organization_id = $1", "b.legal_entity_id = $2", "b.is_current = true", "b.allocation_blocked = false", "b.posting_state = 'posted'",
    PURPOSE_FILTER[query.purpose],
  ];
  if (query.from) where.push(`b.posted_on >= ${add(query.from)}::date`);
  if (query.through) where.push(`b.posted_on <= ${add(query.through)}::date`);
  if (query.search) {
    const term = add(query.search);
    where.push(`(l.description ILIKE '%' || ${term} || '%' OR b.object_id ILIKE '%' || ${term} || '%' OR b.transaction_type ILIKE '%' || ${term} || '%')`);
  }
  if (query.availableOnly) where.push("b.amount_cents > COALESCE(a.allocated_cents, 0)");
  const cursor = decodeCursor(query.cursor);
  if (cursor) where.push(`(b.posted_on, b.object_type, b.object_id, b.line_id) < (${add(cursor.postedOn)}::date, ${add(cursor.objectType)}, ${add(cursor.objectId)}, ${add(cursor.lineId)})`);
  const limit = add(query.limit + 1);
  const result = await executor.query<Record<string, unknown>>(
    `SELECT b.environment, b.realm_id, b.object_type, b.object_id, b.line_id, b.latest_version, b.transaction_type, b.amount_cents::text AS amount_cents,
            b.currency, b.posted_on, b.settlement_state, b.counterparty_object_id, l.description,
            COALESCE(a.allocated_cents, 0)::text AS allocated_cents
       FROM accounting_qbo_source_line_balances b
       JOIN accounting_qbo_transaction_lines l
         ON l.organization_id = b.organization_id AND l.legal_entity_id = b.legal_entity_id AND l.environment = b.environment AND l.realm_id = b.realm_id
        AND l.object_type = b.object_type AND l.object_id = b.object_id AND l.source_line_id = b.line_id AND l.source_version = b.latest_version
       LEFT JOIN LATERAL (
         SELECT SUM(x.amount_cents) AS allocated_cents FROM accounting_qbo_source_line_allocations x
          WHERE x.organization_id = b.organization_id AND x.legal_entity_id = b.legal_entity_id AND x.environment = b.environment AND x.realm_id = b.realm_id
            AND x.object_type = b.object_type AND x.object_id = b.object_id AND x.line_id = b.line_id
       ) a ON true
      WHERE ${where.join(" AND ")}
      ORDER BY b.posted_on DESC, b.object_type DESC, b.object_id DESC, b.line_id DESC
      LIMIT ${limit}`,
    values,
  );
  const rows = result.rows.slice(0, query.limit);
  const items = rows.map((row) => {
    const lineAmount = centsToBigInt(String(row.amount_cents));
    const allocated = centsToBigInt(String(row.allocated_cents));
    const available = lineAmount - allocated;
    return {
      source: financialSourceReferenceSchema.parse({
        provider: "qbo", organizationId: query.organizationId, legalEntityId: query.legalEntityId, environment: row.environment, realmId: String(row.realm_id),
        objectType: row.object_type, objectId: row.object_id, lineId: row.line_id, version: row.latest_version,
      }),
      transactionType: String(row.transaction_type),
      description: row.description === null || row.description === undefined ? null : String(row.description).slice(0, 500),
      postedOn: text(row.posted_on),
      currency: String(row.currency),
      lineAmountCents: centsFromBigInt(lineAmount),
      allocatedCents: centsFromBigInt(allocated),
      availableCents: centsFromBigInt(available < BigInt(0) ? BigInt(0) : available),
      settlementState: row.settlement_state,
      counterpartyObjectId: row.counterparty_object_id === null || row.counterparty_object_id === undefined ? null : String(row.counterparty_object_id),
    };
  });
  const last = rows.at(-1);
  const nextCursor = result.rows.length > query.limit && last
    ? encodeCursor({ postedOn: text(last.posted_on), objectType: String(last.object_type), objectId: String(last.object_id), lineId: String(last.line_id) })
    : null;
  return costSourceLinePageSchema.parse({ items, nextCursor });
}

function scopeOf(source: FinancialSourceReference): FinancialSourceScope {
  return { provider: source.provider, organizationId: source.organizationId, legalEntityId: source.legalEntityId, environment: source.environment, realmId: source.realmId };
}

const COST_CLASSIFICATIONS = new Set(["expense", "cogs", "capitalized_cost"]);
const PAYROLL_CLASSIFICATIONS = new Set(["expense", "cogs"]);

/**
 * Verify a caller-selected QBO line against the current mirror before a link
 * reserves any of it: the exact provider revision, posted state, currency,
 * provider account classification and a live readback are all required.
 */
export async function verifyCostSourceLine(finance: ProjectExecutionFinancePorts, input: {
  readonly source: FinancialSourceReference;
  readonly amountCents: string;
  readonly currency: string;
  readonly effectiveDate: IsoDate | string;
  readonly purpose: CostSourceLinePurpose;
  readonly reasonPrefix: string;
}): Promise<FinancialSourceLineResolution> {
  const source = financialSourceReferenceSchema.parse(input.source);
  const reason = (suffix: string) => `${input.reasonPrefix}_${suffix}`;
  if (source.lineId === null) throw new ValidationCommandError("A QBO source line is required", { reason: reason("line_required") });
  const coverage = financialSourceCoverageSchema.parse(await finance.source.readCoverage(scopeOf(source)));
  if (coverage.status === "unavailable" || coverage.evidence !== "live_provider_readback") throw new ValidationCommandError("A live QuickBooks readback is required", { reason: reason("source_unverified") });
  const line = await finance.source.resolveLine({ scope: scopeOf(source), objectType: source.objectType, objectId: source.objectId, lineId: source.lineId });
  if (!line) throw new ValidationCommandError("The QBO source line is not available", { reason: reason("line_not_found") });
  const resolved = financialSourceLineResolutionSchema.parse(line);
  if (!sameFinancialSourceReference(resolved.source, source)) throw new ValidationCommandError("The QBO source line changed; reload it before linking", { reason: reason("revision_mismatch") });
  if (resolved.postingState !== "posted" || resolved.postedOn === null || resolved.postedOn > input.effectiveDate) throw new ValidationCommandError("The QBO source line is not posted for this date", { reason: reason("line_not_posted") });
  if (resolved.currency !== input.currency) throw new ValidationCommandError("The QBO source line currency does not match", { reason: reason("currency_mismatch") });
  const roleOk = input.purpose === "cost"
    ? resolved.flow === "outgoing" && (resolved.lineRole === "expense" || resolved.lineRole === "payable")
    : resolved.direction === "debit" && resolved.flow !== "incoming" && resolved.transactionType !== "Deposit";
  if (!roleOk) throw new ValidationCommandError("The QBO source line is not an eligible cost", { reason: reason("line_ineligible") });
  const context = await finance.costContext.readCostContext({ scope: scopeOf(source), objectType: resolved.source.objectType, objectId: resolved.source.objectId, lineId: resolved.source.lineId ?? undefined });
  const classifications = input.purpose === "cost" ? COST_CLASSIFICATIONS : PAYROLL_CLASSIFICATIONS;
  if (!context || !sameFinancialSourceReference(context.source, resolved.source) || context.accountObjectId !== resolved.accountObjectId
    || context.amountCents !== resolved.amountCents || context.postingState !== "posted" || !context.eligible || !classifications.has(context.classification)) {
    throw new ValidationCommandError("The QBO account is not an eligible cost account", { reason: reason("account_ineligible") });
  }
  if (centsToBigInt(input.amountCents) > centsToBigInt(resolved.amountCents)) throw new ValidationCommandError("The allocation exceeds the source line", { reason: reason("allocation_exceeded") });
  return resolved;
}

/**
 * Reserve an allocation in the shared QBO ledger and turn a ledger refusal
 * (over-allocation, stale or missing line) into a command validation error.
 */
export async function reserveCostAllocation(finance: ProjectExecutionFinancePorts, request: FinancialSourceAllocationRequest, reasonPrefix: string): Promise<FinancialSourceAllocationBalance> {
  try {
    return await finance.allocations.reserve(request);
  } catch (error) {
    if (error instanceof AccountingError) {
      if (error.code === "accounting_allocation_exceeded") throw new ValidationCommandError("The allocation exceeds the unallocated balance of this QBO line", { reason: `${reasonPrefix}_allocation_exceeded` });
      if (error.code === "accounting_not_found" || error.code === "accounting_validation" || error.code === "accounting_conflict") throw new ValidationCommandError("The QBO line changed; reload it before linking", { reason: `${reasonPrefix}_line_unavailable` });
    }
    throw error;
  }
}
