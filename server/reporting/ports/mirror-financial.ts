import { createHash } from "node:crypto";
import { legalEntityIdSchema, propertyReferenceIdSchema, type LegalEntityId } from "../../../shared/company";
import type { FinancialSourceCoverage, FinancialSourceLineResolution, FinancialSourceReadPort, FinancialSourceScope } from "../../../shared/accounting/source";
import { authorizeCompanyRead, type AuthenticatedPrincipal } from "../../company/authorization";
import type { RentOpsQueryExecutor } from "../../rent-ops/repositories/postgres";
import type { CombinedFinancialReadPort, CombinedFinancialReadResult, CombinedFinancialReportId, FinancialReportingElimination, FinancialReportingLine } from "../combined-financial-engine";
import { ReportingError } from "../errors";
import type { ReportingEngineProbeResult } from "../registry";
import { periodBounds } from "../source-engine-utils";
import { REPORT_READ_ROLES } from "./scope";

/** Approved canonical account identities and intercompany eliminations. */
export interface ConsolidationMappingReadResult {
  readonly accountMappingVersion: string;
  readonly accounts: readonly { readonly legalEntityId: string; readonly providerAccountId: string; readonly canonicalAccountId: string; readonly canonicalName: string | null }[];
  readonly eliminationVersion: string | null;
  readonly eliminations: readonly FinancialReportingElimination[];
}

export interface ConsolidationMappingReadPort {
  read(input: { readonly organizationId: string; readonly entityIds: readonly string[]; readonly eliminationVersion: string | null; readonly asOf: string }): Promise<ConsolidationMappingReadResult | null>;
  hasApprovedMapping(organizationId: string): Promise<boolean>;
  /** Approved elimination versions offered in consolidation setup, newest first. */
  listEliminationVersions?(organizationId: string): Promise<readonly { readonly version: string; readonly label: string; readonly approvedOn: string | null }[]>;
}

export interface MirrorFinancialPortOptions {
  readonly executor: RentOpsQueryExecutor;
  readonly principal: AuthenticatedPrincipal;
  /** QBO environment; `null` when QuickBooks is not configured for this deployment. */
  readonly environment: "sandbox" | "production" | null;
  readonly mirror: Pick<FinancialSourceReadPort, "readCoverage" | "listTransactions">;
  readonly consolidation?: ConsolidationMappingReadPort;
  readonly maxLines?: number;
}

/** Why a report cannot be built from the source-transaction mirror. */
export const MIRROR_UNSUPPORTED: Readonly<Partial<Record<CombinedFinancialReportId, { reason: string; dependency: string }>>> = {
  "balance-sheet-by-fund-type": { reason: "Balance-sheet balances are not in the QuickBooks mirror (it holds purchases, bills, bill payments and deposits), and no approved fund mapping exists.", dependency: "approved_fund_mapping" },
  "balance-sheet-consolidated": { reason: "Balance-sheet balances are not in the QuickBooks mirror (it holds purchases, bills, bill payments and deposits); consolidation needs QuickBooks balance reports per entity.", dependency: "quickbooks_balance_source" },
  "trial-balance-consolidated": { reason: "Trial-balance balances are not in the QuickBooks mirror (it holds purchases, bills, bill payments and deposits); consolidation needs QuickBooks balance reports per entity.", dependency: "quickbooks_balance_source" },
  "accounts-receivable": { reason: "Invoices and customer payments are not in the QuickBooks mirror, so receivables cannot be aged from it.", dependency: "quickbooks_receivables_source" },
  "cash-position": { reason: "No bank balance observations are recorded.", dependency: "bank_observations" },
  "budget-vs-actual": { reason: "No approved budget version is recorded.", dependency: "approved_budget_version" },
  "income-statement-by-unit": { reason: "No approved unit allocation version is recorded.", dependency: "approved_unit_allocation_version" },
};

const MIRROR_SCOPE_REASON = "The QuickBooks mirror holds purchases, bills, bill payments and deposits; journal entries, invoices and sales receipts are not included.";

interface AccountInfo { readonly name: string | null; readonly classification: string | null; readonly accountType: string | null }

function statementFor(reportId: CombinedFinancialReportId): FinancialReportingLine["statement"] {
  if (reportId === "general-ledger-consolidated") return "general_ledger";
  if (reportId === "accounts-payable") return "accounts_payable";
  return "income_statement";
}

function incomeClass(account: AccountInfo | undefined): "income" | "expense" | null {
  const classification = account?.classification?.toLowerCase();
  if (classification === "revenue") return "income";
  if (classification === "expense") return "expense";
  const type = account?.accountType?.toLowerCase() ?? "";
  if (type === "income" || type === "other income") return "income";
  if (type === "expense" || type === "other expense" || type === "cost of goods sold") return "expense";
  return null;
}

function bodyText(body: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) { const value = body[key]; if (typeof value === "string" && value.trim()) return value.trim(); }
  return null;
}

/**
 * Combined-financial port over the QuickBooks source-transaction mirror plus
 * dated property/entity mappings. Coverage is explicit: no connection or no
 * mirror coverage makes the source unavailable, and because the mirror holds
 * only purchases, bills, bill payments and deposits every statement built
 * from it is partial. It never returns zero lines as a verified result.
 */
export function createMirrorCombinedFinancialReadPort(options: MirrorFinancialPortOptions): CombinedFinancialReadPort {
  const maxLines = options.maxLines ?? 50_000;
  const probes = new Map<string, Promise<number>>();
  const connectionCount = (organizationId: string): Promise<number> => {
    const cached = probes.get(organizationId);
    if (cached) return cached;
    const created = options.environment === null ? Promise.resolve(0) : options.executor.query<{ count: string | number }>(
      `SELECT count(*)::text AS count FROM accounting_qbo_connections WHERE organization_id=$1 AND environment=$2 AND revoked_at IS NULL`,
      [organizationId, options.environment],
    ).then(result => Number(result.rows[0]?.count ?? 0));
    probes.set(organizationId, created);
    return created;
  };

  async function realmFor(organizationId: string, legalEntityId: string): Promise<string | null> {
    const result = await options.executor.query<{ realm_id: string }>(
      `SELECT realm_id FROM accounting_qbo_connections WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND revoked_at IS NULL`,
      [organizationId, legalEntityId, options.environment],
    );
    if (result.rows.length > 1) throw new ReportingError("report_unavailable", "A legal entity has more than one active QuickBooks connection.", 409, { dependency: "verified_quickbooks_connection" });
    return result.rows[0]?.realm_id ?? null;
  }

  async function providerObjects(scope: FinancialSourceScope, objectType: "Account" | "Vendor"): Promise<Map<string, Record<string, unknown>>> {
    const result = await options.executor.query<{ object_id: string; provider_body: unknown }>(
      `SELECT DISTINCT ON (object_id) object_id, provider_body FROM accounting_qbo_source_objects
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND deleted_at IS NULL
        ORDER BY object_id, provider_updated_at DESC NULLS LAST, received_at DESC`,
      [scope.organizationId, scope.legalEntityId, scope.environment, scope.realmId, objectType],
    );
    return new Map(result.rows.map(row => {
      const body = typeof row.provider_body === "string" ? JSON.parse(row.provider_body) as Record<string, unknown> : (row.provider_body ?? {}) as Record<string, unknown>;
      return [String(row.object_id), body];
    }));
  }

  /** The one property mapped to an entity for the whole period, if exactly one. */
  async function soleProperty(organizationId: string, legalEntityId: string, from: string, through: string): Promise<{ propertyId: string | null; mappingCount: number; fingerprint: string }> {
    const result = await options.executor.query<{ property_id: string; effective_from: unknown; effective_until: unknown; covers: boolean }>(
      `SELECT property_id, effective_from, effective_until, effective_from <= $3::date AND (effective_until IS NULL OR effective_until > $4::date) AS covers
         FROM company_property_entity_periods
        WHERE organization_id=$1 AND legal_entity_id=$2 AND effective_from <= $4::date AND (effective_until IS NULL OR effective_until > $3::date)
        ORDER BY property_id, effective_from`,
      [organizationId, legalEntityId, from, through],
    );
    const fingerprint = createHash("sha256").update(JSON.stringify(result.rows.map(row => [row.property_id, String(row.effective_from), String(row.effective_until)]))).digest("hex").slice(0, 16);
    const properties = Array.from(new Set(result.rows.map(row => String(row.property_id))));
    const propertyId = properties.length === 1 && result.rows.every(row => row.covers === true) ? properties[0]! : null;
    return { propertyId, mappingCount: properties.length, fingerprint };
  }

  async function listLines(scope: FinancialSourceScope, from: string | undefined, through: string): Promise<{ items: FinancialSourceLineResolution[]; coverage: FinancialSourceCoverage | null }> {
    const items: FinancialSourceLineResolution[] = [];
    let cursor: string | undefined;
    let coverage: FinancialSourceCoverage | null = null;
    do {
      const page = await options.mirror.listTransactions({ scope, ...(from ? { from } : {}), through, limit: 500, ...(cursor ? { cursor } : {}) });
      items.push(...page.items);
      coverage = page.coverage;
      cursor = page.nextCursor ?? undefined;
      if (items.length > maxLines) throw new ReportingError("report_unavailable", "The report exceeds the bounded line count; choose a shorter period or fewer entities.", 409, { maxLines });
    } while (cursor);
    return { items, coverage };
  }

  function mapLine(reportId: CombinedFinancialReportId, basis: "cash" | "accrual", line: FinancialSourceLineResolution, accounts: Map<string, AccountInfo>, vendors: Map<string, string | null>, legalEntityId: string, realmId: string, propertyId: string | null): FinancialReportingLine | null {
    if (line.postingState !== "posted" || !line.postedOn) return null;
    const type = line.transactionType;
    const amount = BigInt(line.amountCents);
    const base = { legalEntityId, propertyId, unitId: null, date: line.postedOn, month: line.postedOn.slice(0, 7), currency: line.currency, sourceId: `${line.source.objectType}:${line.source.objectId}:${line.source.lineId ?? "*"}:${line.source.version}`, sourceRealmId: realmId, basis } as const;
    if (reportId === "accounts-payable") {
      if (type === "Bill" && line.lineRole === "payable") {
        const vendor = line.counterpartyObjectId;
        return { ...base, id: base.sourceId, accountId: vendor ?? "unknown-vendor", accountName: vendor ? vendors.get(vendor) ?? `Vendor ${vendor}` : "Vendor not recorded", amountCents: amount.toString(), category: "accounts_payable", statement: "accounts_payable" };
      }
      if (type === "BillPayment" && line.lineRole === "payment_source") {
        const vendor = line.counterpartyObjectId;
        return { ...base, id: base.sourceId, accountId: vendor ?? "unknown-vendor", accountName: vendor ? vendors.get(vendor) ?? `Vendor ${vendor}` : "Vendor not recorded", amountCents: (-amount).toString(), category: "accounts_payable", statement: "accounts_payable" };
      }
      return null;
    }
    if (!line.accountObjectId) return null;
    const account = accounts.get(line.accountObjectId);
    if (reportId === "general-ledger-consolidated") {
      if (basis === "cash" && type === "Bill") return null;
      if (basis === "accrual" && type === "BillPayment") return null;
      const debit = type === "Purchase" || type === "Bill";
      return { ...base, id: base.sourceId, accountId: line.accountObjectId, accountName: account?.name ?? null, amountCents: (debit ? amount : -amount).toString(), category: account?.classification?.toLowerCase() ?? null, statement: "general_ledger" };
    }
    // Income-statement semantics: a Deposit credits its offset account; a
    // Purchase or Bill debits its expense account. Bills are recognized on
    // the accrual basis only; bill payments move cash, not expense.
    if (type === "BillPayment") return null;
    if (basis === "cash" && type === "Bill") return null;
    const category = incomeClass(account);
    if (!category) return null;
    const incoming = line.flow === "incoming";
    const signed = category === "income" ? (incoming ? amount : -amount) : (incoming ? -amount : amount);
    return { ...base, id: base.sourceId, accountId: line.accountObjectId, accountName: account?.name ?? null, amountCents: signed.toString(), category, statement: statementFor(reportId) };
  }

  return {
    async probe({ organizationId, reportId }): Promise<ReportingEngineProbeResult> {
      if (options.environment === null) return { status: "missing_data", reason: "Connect QuickBooks to run financial statements.", dependency: "verified_quickbooks_connection" };
      const unsupported = MIRROR_UNSUPPORTED[reportId];
      if (unsupported) return { status: "missing_data", reason: unsupported.reason, dependency: unsupported.dependency };
      if (await connectionCount(organizationId) === 0) return { status: "missing_data", reason: "No legal entity has an active QuickBooks connection.", dependency: "verified_quickbooks_connection" };
      if (reportId.endsWith("-consolidated") && !(options.consolidation && await options.consolidation.hasApprovedMapping(organizationId))) return { status: "missing_data", reason: "No approved account mapping and elimination version is recorded for consolidation.", dependency: "approved_account_mapping" };
      return { status: "available" };
    },
    async read({ context, reportId, legalEntityIds, propertyIds, accountIds }): Promise<CombinedFinancialReadResult> {
      const unavailable = (reason: string): CombinedFinancialReadResult => ({ lines: [], coverage: { state: "unavailable", evidence: "unverified", watermark: null, reason } });
      if (options.environment === null) return unavailable("Connect QuickBooks to run financial statements.");
      const unsupported = MIRROR_UNSUPPORTED[reportId];
      if (unsupported) return unavailable(unsupported.reason);
      const basis = context.request.basis;
      if (basis !== "cash" && basis !== "accrual") return unavailable("Choose cash or accrual basis.");
      if (reportId === "accounts-payable" && basis !== "accrual") return unavailable("Accounts payable is reported on the accrual basis.");
      const organizationId = context.request.scope.organizationId;
      const bounds = periodBounds(context);
      const through = bounds.through ?? context.now.slice(0, 10);
      const cumulative = reportId === "accounts-payable";
      const from = cumulative ? undefined : bounds.from ?? undefined;
      const selectedAccounts = new Set(accountIds);
      const lines: FinancialReportingLine[] = [];
      const reasons: string[] = [MIRROR_SCOPE_REASON];
      const watermarks: string[] = [];
      const fingerprints: string[] = [];
      let covered = 0;
      let complete = true;
      for (const entity of legalEntityIds) {
        const legalEntityId = legalEntityIdSchema.parse(entity) as LegalEntityId;
        if (!propertyIds.length) authorizeCompanyRead(options.principal, { organizationId: context.request.scope.organizationId, legalEntityId }, REPORT_READ_ROLES);
        else for (const propertyId of propertyIds) {
          // Property-limited principals only see lines attributed to their property.
          try { authorizeCompanyRead(options.principal, { organizationId: context.request.scope.organizationId, legalEntityId, propertyId: propertyReferenceIdSchema.parse(propertyId) }, REPORT_READ_ROLES); } catch { /* checked per line below */ }
        }
        const realmId = await realmFor(organizationId, legalEntityId);
        if (!realmId) { reasons.push("A selected legal entity has no active QuickBooks connection."); complete = false; continue; }
        const scope: FinancialSourceScope = { provider: "qbo", organizationId: context.request.scope.organizationId, legalEntityId, environment: options.environment, realmId };
        const coverage = await options.mirror.readCoverage(scope);
        if (coverage.status === "unavailable") { reasons.push(coverage.reason ?? "The QuickBooks mirror has not synchronized for a selected entity."); complete = false; continue; }
        if (coverage.status !== "complete") { complete = false; if (coverage.reason) reasons.push(coverage.reason); }
        if (coverage.coveredThrough && coverage.coveredThrough < through) { complete = false; reasons.push(`QuickBooks activity is mirrored only through ${coverage.coveredThrough}.`); }
        if (coverage.watermark) watermarks.push(coverage.watermark.value);
        covered += 1;
        const [accountBodies, vendorBodies, property] = await Promise.all([
          providerObjects(scope, "Account"),
          reportId === "accounts-payable" ? providerObjects(scope, "Vendor") : Promise.resolve(new Map<string, Record<string, unknown>>()),
          soleProperty(organizationId, legalEntityId, bounds.from ?? through, through),
        ]);
        fingerprints.push(`${legalEntityId}:${property.fingerprint}`);
        const accounts = new Map(Array.from(accountBodies.entries()).map(([id, body]) => [id, { name: bodyText(body, "FullyQualifiedName", "Name"), classification: bodyText(body, "Classification"), accountType: bodyText(body, "AccountType") } satisfies AccountInfo]));
        const vendors = new Map(Array.from(vendorBodies.entries()).map(([id, body]) => [id, bodyText(body, "DisplayName", "CompanyName")]));
        const { items } = await listLines(scope, from, through);
        for (const item of items) {
          const mapped = mapLine(reportId, basis, item, accounts, vendors, legalEntityId, realmId, property.propertyId);
          if (!mapped) continue;
          if (selectedAccounts.size && !selectedAccounts.has(mapped.accountId)) continue;
          if (propertyIds.length) {
            if (!mapped.propertyId || !propertyIds.includes(mapped.propertyId)) continue;
            authorizeCompanyRead(options.principal, { organizationId: context.request.scope.organizationId, legalEntityId, propertyId: propertyReferenceIdSchema.parse(mapped.propertyId) }, REPORT_READ_ROLES);
          }
          lines.push(mapped);
        }
      }
      if (!covered) return unavailable(reasons.slice(1).join(" ") || "No selected legal entity has QuickBooks data.");
      let consolidated: Partial<CombinedFinancialReadResult> = {};
      if (reportId.endsWith("-consolidated")) {
        const policy = context.request.consolidation;
        const mapping = options.consolidation && policy ? await options.consolidation.read({ organizationId, entityIds: policy.entityIds.map(String), eliminationVersion: policy.eliminationPolicy === "approved_version" ? policy.eliminationVersion ?? null : null, asOf: through }) : null;
        if (!mapping) return unavailable("No approved account mapping and elimination version is recorded for consolidation.");
        const canonical = new Map(mapping.accounts.map(item => [`${item.legalEntityId}:${item.providerAccountId}`, item]));
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index]!;
          const mapped = canonical.get(`${line.legalEntityId}:${line.accountId}`);
          lines[index] = { ...line, canonicalAccountId: mapped?.canonicalAccountId ?? null, accountName: mapped?.canonicalName ?? line.accountName ?? null };
        }
        consolidated = { accountMappingVersion: mapping.accountMappingVersion, eliminationVersion: mapping.eliminationVersion, eliminations: mapping.eliminations };
      }
      return {
        lines,
        ...consolidated,
        propertyMappingVersion: fingerprints.length ? `company_property_entity_periods:${createHash("sha256").update(fingerprints.sort().join("|")).digest("hex").slice(0, 16)}` : null,
        coverage: {
          state: "partial",
          evidence: complete ? "live_provider_readback" : "unverified",
          watermark: watermarks.sort().at(-1) ?? null,
          reason: Array.from(new Set(reasons)).join(" ").slice(0, 500),
        },
      };
    },
  };
}
