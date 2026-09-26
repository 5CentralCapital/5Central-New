import { canonicalJsonSha256 } from "../company/commands/fingerprint";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";

/**
 * Read-only preview of the tenant history already persisted in R-ops.
 *
 * This module intentionally has no writer or migration path. It builds an
 * auditable extract keyed by the persisted R-ops transaction/allocation ids,
 * then classifies each row by property ownership, QBO binding, customer link,
 * posting policy, and the current QBO write surface. Former tenancies remain
 * in the extract; properties without a connected QBO company remain local to
 * R-ops. No source archive is applied or copied by this code.
 */

export const TENANT_QBO_MIGRATION_PREVIEW_KIND = "qbo_tenant_migration_preview" as const;
export const TENANT_QBO_ENVIRONMENTS = ["sandbox", "production"] as const;
export type TenantQboEnvironment = typeof TENANT_QBO_ENVIRONMENTS[number];
export type TenantQboPreviewRoute = "native_qbo" | "local_rops" | "hold";
export type TenantQboPreviewEligibility = "eligible" | "local_only" | "hold";
export type TenantQboCustomerLinkState = "linked" | "unlinked" | "ambiguous" | "not_applicable";
export type TenantQboTargetObject = "Invoice" | "Payment" | "CreditMemo" | "JournalEntry";
export type TenantQboPostingMethod = "native_receivables" | "summary_bridge" | "not_posted";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const QBO_WRITE_SUPPORT: Readonly<Record<TenantQboTargetObject, boolean>> = Object.freeze({
  Invoice: true,
  Payment: false,
  CreditMemo: false,
  JournalEntry: true,
});

export interface TenantQboMigrationProperty {
  readonly id: string;
}

export interface TenantQboMigrationTenancy {
  readonly id: string;
  readonly sourceSystem: string | null;
  readonly sourceId: string | null;
  readonly propertyId: string | null;
  readonly unitId: string | null;
  readonly personId: string | null;
  readonly status: string | null;
  readonly endOn: string | null;
}

export interface TenantQboMigrationEntityPeriod {
  readonly organizationId: string;
  readonly legalEntityId: string;
  readonly propertyId: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
}

export interface TenantQboMigrationQboBinding {
  readonly legalEntityId: string;
  readonly realmId: string;
  /** Native routing requires an explicit active connection/capability proof; missing or false routes local to R-ops. */
  readonly connected?: boolean;
}

export interface TenantQboMigrationCustomerLink {
  readonly tenancyId: string;
  readonly legalEntityId: string | null;
  readonly realmId: string;
  readonly customerObjectId: string;
}

export interface TenantQboMigrationPostingPolicy {
  readonly legalEntityId: string;
  readonly method: TenantQboPostingMethod;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly cutoffDate: string;
  readonly openingBalanceBridgeReference: string | null;
  readonly invoiceDeliveryVerified: boolean;
}

export type TenantQboAmountInput = string | number | bigint | null | undefined;

export interface TenantQboMigrationLedgerSourceRow {
  readonly id: string;
  readonly sourceSystem: string | null;
  readonly sourceId: string | null;
  readonly sourceArtifactSha256: string | null;
  readonly artifactObservationOn: string | null;
  readonly propertyId: string | null;
  readonly unitId: string | null;
  readonly tenancyId: string | null;
  readonly personId: string | null;
  readonly kind: string | null;
  readonly category: string | null;
  readonly status: string | null;
  readonly amountCents: TenantQboAmountInput;
  readonly postedOn: string | null;
  readonly dueOn: string | null;
  readonly paymentMethod: string | null;
  readonly description: string | null;
  readonly reversalOfId: string | null;
  readonly payer: string | null;
  readonly adjustmentDirection: string | null;
  readonly propertyLinkKnowledge: string | null;
  readonly unitLinkKnowledge: string | null;
  readonly tenancyLinkKnowledge: string | null;
  readonly personLinkKnowledge: string | null;
  readonly amountKnowledge: string | null;
  readonly postedOnKnowledge: string | null;
  readonly sourceUpdatedAt: string | null;
}

export interface TenantQboMigrationAllocationSourceRow {
  readonly id: string;
  readonly sourceSystem: string | null;
  readonly sourceId: string | null;
  readonly sourceArtifactSha256: string | null;
  readonly artifactObservationOn: string | null;
  readonly sourcePropertyId: string | null;
  readonly kind: string | null;
  readonly paymentTransactionId: string | null;
  readonly chargeTransactionId: string | null;
  readonly creditTransactionId: string | null;
  readonly amountCents: TenantQboAmountInput;
  readonly allocatedOn: string | null;
  readonly paymentLinkKnowledge: string | null;
  readonly chargeLinkKnowledge: string | null;
  readonly creditLinkKnowledge: string | null;
  readonly amountKnowledge: string | null;
  readonly allocatedOnKnowledge: string | null;
  readonly sourceUpdatedAt: string | null;
}

export interface TenantQboMigrationPreviewInput {
  readonly organizationId: string;
  readonly environment: TenantQboEnvironment;
  readonly asOf: string;
  readonly properties: readonly TenantQboMigrationProperty[];
  readonly tenancies: readonly TenantQboMigrationTenancy[];
  readonly entityPeriods: readonly TenantQboMigrationEntityPeriod[];
  readonly bindings: readonly TenantQboMigrationQboBinding[];
  readonly customerLinks: readonly TenantQboMigrationCustomerLink[];
  readonly postingPolicies: readonly TenantQboMigrationPostingPolicy[];
  readonly transactions: readonly TenantQboMigrationLedgerSourceRow[];
  readonly allocations: readonly TenantQboMigrationAllocationSourceRow[];
}

export interface TenantQboMigrationPolicyView {
  readonly method: TenantQboPostingMethod;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly cutoffDate: string;
  readonly openingBalanceBridgeReference: string | null;
  readonly invoiceDeliveryVerified: boolean;
}

export interface TenantQboMigrationTransactionPreview {
  readonly transactionId: string;
  readonly sourceSystem: string | null;
  readonly sourceId: string | null;
  readonly sourceKey: string | null;
  readonly sourceArtifactSha256: string | null;
  readonly artifactObservationOn: string | null;
  readonly sourceUpdatedAt: string | null;
  readonly propertyId: string | null;
  readonly unitId: string | null;
  readonly tenancyId: string | null;
  readonly personId: string | null;
  readonly tenancyStatus: string | null;
  readonly formerTenancy: boolean;
  readonly kind: string | null;
  readonly category: string | null;
  readonly status: string | null;
  /** Decimal string; never a floating-point amount. */
  readonly amountCents: string | null;
  readonly postedOn: string | null;
  readonly dueOn: string | null;
  readonly paymentMethod: string | null;
  readonly description: string | null;
  readonly reversalOfId: string | null;
  readonly payer: string | null;
  readonly adjustmentDirection: string | null;
  readonly targetObjectType: TenantQboTargetObject | null;
  readonly targetObjectWriteSupported: boolean | null;
  readonly route: TenantQboPreviewRoute;
  readonly eligibility: TenantQboPreviewEligibility;
  readonly routeReason: string;
  readonly holdReasons: readonly string[];
  readonly legalEntityId: string | null;
  readonly realmId: string | null;
  readonly customerObjectId: string | null;
  readonly customerLinkState: TenantQboCustomerLinkState;
  readonly postingPolicy: TenantQboMigrationPolicyView | null;
}

export interface TenantQboMigrationAllocationPreview {
  readonly allocationId: string;
  readonly sourceSystem: string | null;
  readonly sourceId: string | null;
  readonly sourceKey: string | null;
  readonly sourceArtifactSha256: string | null;
  readonly artifactObservationOn: string | null;
  readonly sourceUpdatedAt: string | null;
  readonly sourcePropertyId: string | null;
  readonly kind: string | null;
  readonly paymentTransactionId: string | null;
  readonly chargeTransactionId: string | null;
  readonly creditTransactionId: string | null;
  /** Decimal string; never a floating-point amount. */
  readonly amountCents: string | null;
  readonly allocatedOn: string | null;
  readonly route: TenantQboPreviewRoute;
  readonly eligibility: TenantQboPreviewEligibility;
  readonly routeReason: string;
  readonly holdReasons: readonly string[];
}

export interface TenantQboMigrationPreviewCounts {
  readonly transactionCount: number;
  readonly nativeQboTransactionCount: number;
  readonly eligibleNativeQboTransactionCount: number;
  readonly heldTransactionCount: number;
  readonly localRopsTransactionCount: number;
  readonly formerTenancyTransactionCount: number;
  readonly allocationCount: number;
  readonly nativeQboAllocationCount: number;
  readonly eligibleNativeQboAllocationCount: number;
  readonly heldAllocationCount: number;
  readonly localRopsAllocationCount: number;
}

export interface TenantQboMigrationPreviewTotals {
  /** Raw source amounts by route; these are not posted-QBO totals. */
  readonly transactionAmountCents: {
    readonly all: string;
    readonly nativeQbo: string;
    readonly held: string;
    readonly localRops: string;
  };
  readonly transactionAmountByKindCents: Readonly<Record<string, string>>;
  readonly allocationAmountCents: {
    readonly all: string;
    readonly nativeQbo: string;
    readonly held: string;
    readonly localRops: string;
  };
}

export interface TenantQboMigrationPreview {
  readonly kind: typeof TENANT_QBO_MIGRATION_PREVIEW_KIND;
  readonly readOnly: true;
  readonly organizationId: string;
  readonly environment: TenantQboEnvironment;
  readonly asOf: string;
  readonly transactions: readonly TenantQboMigrationTransactionPreview[];
  readonly allocations: readonly TenantQboMigrationAllocationPreview[];
  readonly counts: TenantQboMigrationPreviewCounts;
  readonly totals: TenantQboMigrationPreviewTotals;
  /** Digest of the complete source-linked preview, excluding this field. */
  readonly previewSha256: string;
}

interface ScopeDecision {
  readonly route: TenantQboPreviewRoute;
  readonly reason: string;
  readonly legalEntityId: string | null;
  readonly realmId: string | null;
}

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result.length > 0 ? result : null;
};

function date(value: unknown): string | null {
  const valueText = text(value);
  if (!valueText) return null;
  const result = valueText.slice(0, 10);
  return DATE_RE.test(result) ? result : null;
}

function requireDate(value: string, field: string): string {
  if (!DATE_RE.test(value)) throw new Error(`${field} must be YYYY-MM-DD`);
  return value;
}

function cents(value: TenantQboAmountInput): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return null;
    return String(value);
  }
  if (!/^-?\d+$/.test(value.trim())) return null;
  try {
    return BigInt(value.trim()).toString();
  } catch {
    return null;
  }
}

function addCents(left: string, right: string | null): string {
  return (BigInt(left) + BigInt(right ?? "0")).toString();
}

function sourceKey(sourceSystem: string | null, sourceId: string | null): string | null {
  return sourceSystem && sourceId ? `${sourceSystem}:${sourceId}` : null;
}

function targetForKind(kind: string | null): TenantQboTargetObject | null {
  switch (kind) {
    case "charge": return "Invoice";
    case "payment": return "Payment";
    case "credit": return "CreditMemo";
    case "adjustment": return "JournalEntry";
    default: return null;
  }
}

function isFormer(tenancy: TenantQboMigrationTenancy | undefined, asOf: string): boolean {
  return Boolean(tenancy && (tenancy.status === "past" || tenancy.status === "cancelled" || (tenancy.endOn !== null && tenancy.endOn <= asOf)));
}

function policyForDate(policies: readonly TenantQboMigrationPostingPolicy[], legalEntityId: string, activityDate: string): TenantQboMigrationPostingPolicy | null {
  const matches = policies.filter(policy => policy.legalEntityId === legalEntityId
    && policy.effectiveFrom <= activityDate
    && (policy.effectiveUntil === null || policy.effectiveUntil > activityDate));
  return matches.length === 1 ? matches[0]! : null;
}

function policyView(policy: TenantQboMigrationPostingPolicy | null): TenantQboMigrationPolicyView | null {
  if (!policy) return null;
  return {
    method: policy.method,
    effectiveFrom: policy.effectiveFrom,
    effectiveUntil: policy.effectiveUntil,
    cutoffDate: policy.cutoffDate,
    openingBalanceBridgeReference: policy.openingBalanceBridgeReference,
    invoiceDeliveryVerified: policy.invoiceDeliveryVerified,
  };
}

function scopeFor(input: TenantQboMigrationPreviewInput, row: TenantQboMigrationLedgerSourceRow): ScopeDecision {
  if (!row.propertyId) return { route: "hold", reason: "missing_property_scope", legalEntityId: null, realmId: null };
  if (input.properties.length > 0 && !input.properties.some(property => property.id === row.propertyId)) {
    return { route: "hold", reason: "property_not_found", legalEntityId: null, realmId: null };
  }
  const periods = input.entityPeriods.filter(period => period.organizationId === input.organizationId && period.propertyId === row.propertyId);
  // An unmapped property is outside this organization's accounting scope. It
  // is an operator hold, not a local-only result; otherwise a cross-company
  // row could be silently relabeled as local R-ops history.
  if (periods.length === 0) return { route: "hold", reason: "property_not_assigned_to_company", legalEntityId: null, realmId: null };
  const activityDate = date(row.postedOn);
  if (!activityDate) return { route: "hold", reason: "posted_date_unknown_for_entity_route", legalEntityId: null, realmId: null };
  const matches = periods.filter(period => period.effectiveFrom <= activityDate && (period.effectiveUntil === null || period.effectiveUntil > activityDate));
  if (matches.length !== 1) return { route: "hold", reason: matches.length === 0 ? "outside_entity_period" : "overlapping_entity_periods", legalEntityId: null, realmId: null };
  const binding = input.bindings.find(item => item.legalEntityId === matches[0]!.legalEntityId);
  // Treat an omitted/unknown connection proof as local too.  Native routing
  // requires the loader's active connection plus live accounting.read
  // capability evidence; a realm binding alone is not enough.
  if (!binding || binding.connected !== true) return { route: "local_rops", reason: "qbo_company_unconnected", legalEntityId: matches[0]!.legalEntityId, realmId: binding?.realmId ?? null };
  return { route: "native_qbo", reason: "connected_entity_period", legalEntityId: matches[0]!.legalEntityId, realmId: binding.realmId };
}

function pushReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function sortDateId(leftDate: string | null, leftId: string, rightDate: string | null, rightId: string): number {
  const left = leftDate ?? "";
  const right = rightDate ?? "";
  return left < right ? -1 : left > right ? 1 : leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function customerLinksByTenancy(links: readonly TenantQboMigrationCustomerLink[]): Map<string, TenantQboMigrationCustomerLink[]> {
  const result = new Map<string, TenantQboMigrationCustomerLink[]>();
  for (const link of links) result.set(link.tenancyId, [...(result.get(link.tenancyId) ?? []), link]);
  return result;
}

function transactionAmountTotal(rows: readonly TenantQboMigrationTransactionPreview[], route: TenantQboPreviewRoute | "all"): string {
  return rows.reduce((total, row) => route === "all" || row.route === route ? addCents(total, row.amountCents) : total, "0");
}

function allocationAmountTotal(rows: readonly TenantQboMigrationAllocationPreview[], route: TenantQboPreviewRoute | "all"): string {
  return rows.reduce((total, row) => route === "all" || row.route === route ? addCents(total, row.amountCents) : total, "0");
}

export function buildTenantQboMigrationPreview(input: TenantQboMigrationPreviewInput): TenantQboMigrationPreview {
  requireDate(input.asOf, "asOf");
  if (!TENANT_QBO_ENVIRONMENTS.includes(input.environment)) throw new Error("environment must be sandbox or production");
  const tenancies = new Map(input.tenancies.map(tenancy => [tenancy.id, tenancy]));
  const transactionsById = new Map(input.transactions.map(row => [row.id, row]));
  const linksByTenancy = customerLinksByTenancy(input.customerLinks);
  const scopedInput = input;
  const transactions = [...input.transactions].sort((left, right) => sortDateId(date(left.postedOn), left.id, date(right.postedOn), right.id));

  const transactionRows: TenantQboMigrationTransactionPreview[] = transactions.map(row => {
    const tenancy = row.tenancyId ? tenancies.get(row.tenancyId) : undefined;
    const scope = scopeFor(scopedInput, row);
    const reasons: string[] = [];
    const amountCents = cents(row.amountCents);
    const postedOn = date(row.postedOn);
    const dueOn = date(row.dueOn);
    const targetObjectType = targetForKind(row.kind);
    let customerObjectId: string | null = null;
    let customerLinkState: TenantQboCustomerLinkState = row.tenancyId ? "unlinked" : "not_applicable";
    let postingPolicy: TenantQboMigrationPostingPolicy | null = null;

    if (!row.tenancyId) pushReason(reasons, "missing_tenancy");
    if (row.tenancyId && !tenancy) pushReason(reasons, "tenancy_not_found");
    if (tenancy && row.propertyId && tenancy.propertyId && tenancy.propertyId !== row.propertyId) pushReason(reasons, "transaction_tenancy_property_mismatch");
    if (tenancy && row.unitId && tenancy.unitId && tenancy.unitId !== row.unitId) pushReason(reasons, "transaction_tenancy_unit_mismatch");
    if (!row.sourceSystem || !row.sourceId) pushReason(reasons, "source_identity_missing");
    if (row.sourceSystem !== null && row.sourceId !== null && row.sourceSystem.trim() === "" && row.sourceId.trim() === "") pushReason(reasons, "source_identity_missing");
    if (amountCents === null) pushReason(reasons, "amount_unknown_or_invalid");
    if (!postedOn) pushReason(reasons, "posted_date_unknown_or_invalid");
    if (row.status !== "posted") pushReason(reasons, row.status === null ? "status_unknown" : "transaction_not_posted");
    if (!row.kind || !targetObjectType) pushReason(reasons, row.kind === "reversal" ? "reversal_requires_linked_source" : "transaction_kind_unknown");
    if (!row.category) pushReason(reasons, "category_unknown");
    if (row.kind === "adjustment" && !row.adjustmentDirection) pushReason(reasons, "adjustment_direction_unknown");
    if (row.kind === "reversal") {
      if (!row.reversalOfId || !transactionsById.has(row.reversalOfId)) pushReason(reasons, "reversal_source_missing");
      else if (scopeFor(scopedInput, transactionsById.get(row.reversalOfId)!).route !== scope.route) pushReason(reasons, "reversal_scope_mismatch");
    }

    const links = row.tenancyId ? linksByTenancy.get(row.tenancyId) ?? [] : [];
    if (links.length > 1) {
      customerLinkState = "ambiguous";
      pushReason(reasons, "multiple_customer_links");
    } else if (links.length === 1) {
      const link = links[0]!;
      customerObjectId = link.customerObjectId;
      customerLinkState = "linked";
      if (scope.legalEntityId && link.legalEntityId !== null && link.legalEntityId !== scope.legalEntityId) pushReason(reasons, "customer_link_entity_mismatch");
      if (scope.realmId && link.realmId !== scope.realmId) pushReason(reasons, "customer_link_realm_mismatch");
    }

    if (scope.route === "hold") pushReason(reasons, scope.reason);
    if (scope.route === "native_qbo") {
      if (customerLinkState !== "linked") pushReason(reasons, customerLinkState === "ambiguous" ? "multiple_customer_links" : "customer_not_linked");
      if (!postedOn || !scope.legalEntityId) pushReason(reasons, "native_route_missing_activity_scope");
      else {
        postingPolicy = policyForDate(input.postingPolicies, scope.legalEntityId, postedOn);
        if (!postingPolicy) pushReason(reasons, "posting_policy_missing_or_overlapping");
        else {
          if (postingPolicy.method !== "native_receivables") pushReason(reasons, "native_receivables_policy_required");
          if (postedOn < postingPolicy.cutoffDate) pushReason(reasons, "before_posting_policy_cutoff");
          if (targetObjectType === "Invoice" && !postingPolicy.invoiceDeliveryVerified) pushReason(reasons, "invoice_delivery_not_verified");
        }
      }
      if (targetObjectType && !QBO_WRITE_SUPPORT[targetObjectType]) pushReason(reasons, "qbo_object_write_unsupported");
      if (!targetObjectType) pushReason(reasons, "target_object_requires_review");
    }

    const eligibility: TenantQboPreviewEligibility = scope.route === "local_rops" ? "local_only" : reasons.length > 0 ? "hold" : "eligible";
    const route: TenantQboPreviewRoute = scope.route === "local_rops" ? "local_rops" : scope.route === "hold" || eligibility === "hold" ? "hold" : "native_qbo";
    return {
      transactionId: row.id,
      sourceSystem: row.sourceSystem,
      sourceId: row.sourceId,
      sourceKey: sourceKey(row.sourceSystem, row.sourceId),
      sourceArtifactSha256: row.sourceArtifactSha256,
      artifactObservationOn: row.artifactObservationOn,
      sourceUpdatedAt: row.sourceUpdatedAt,
      propertyId: row.propertyId,
      unitId: row.unitId,
      tenancyId: row.tenancyId,
      personId: row.personId,
      tenancyStatus: tenancy?.status ?? null,
      formerTenancy: isFormer(tenancy, input.asOf),
      kind: row.kind,
      category: row.category,
      status: row.status,
      amountCents,
      postedOn,
      dueOn,
      paymentMethod: row.paymentMethod,
      description: row.description,
      reversalOfId: row.reversalOfId,
      payer: row.payer,
      adjustmentDirection: row.adjustmentDirection,
      targetObjectType,
      targetObjectWriteSupported: targetObjectType ? QBO_WRITE_SUPPORT[targetObjectType] : null,
      route,
      eligibility,
      routeReason: scope.reason,
      holdReasons: reasons,
      legalEntityId: scope.legalEntityId,
      realmId: scope.realmId,
      customerObjectId,
      customerLinkState,
      postingPolicy: policyView(postingPolicy),
    };
  });

  const txById = new Map(transactionRows.map(row => [row.transactionId, row]));
  const allocationRows: TenantQboMigrationAllocationPreview[] = [...input.allocations]
    .sort((left, right) => sortDateId(date(left.allocatedOn), left.id, date(right.allocatedOn), right.id))
    .map(row => {
      const reasons: string[] = [];
      const amountCents = cents(row.amountCents);
      const allocatedOn = date(row.allocatedOn);
      const relatedIds = [row.paymentTransactionId, row.chargeTransactionId, row.creditTransactionId].filter((id): id is string => Boolean(id));
      const related = relatedIds.map(id => txById.get(id));
      if (relatedIds.length === 0) pushReason(reasons, "allocation_has_no_transaction_link");
      if (related.some(item => !item)) pushReason(reasons, "allocation_transaction_missing");
      if (!row.sourceSystem || !row.sourceId) pushReason(reasons, "source_identity_missing");
      if (amountCents === null) pushReason(reasons, "allocation_amount_unknown_or_invalid");
      if (!allocatedOn) pushReason(reasons, "allocation_date_unknown_or_invalid");
      if (!row.kind) pushReason(reasons, "allocation_kind_unknown");
      const knownRelated = related.filter((item): item is TenantQboMigrationTransactionPreview => item !== undefined);
      const relatedRoutes = new Set(knownRelated.map(item => item.route));
      let route: TenantQboPreviewRoute;
      let routeReason: string;
      if (relatedRoutes.size === 0) {
        route = "hold";
        routeReason = "allocation_scope_unresolved";
      } else if (relatedRoutes.has("hold")) {
        route = "hold";
        routeReason = "related_transaction_hold";
        pushReason(reasons, "related_transaction_hold");
      } else if (relatedRoutes.has("native_qbo") && relatedRoutes.has("local_rops")) {
        route = "hold";
        routeReason = "allocation_crosses_qbo_and_local_scope";
        pushReason(reasons, "allocation_crosses_qbo_and_local_scope");
      } else if (relatedRoutes.has("local_rops")) {
        route = "local_rops";
        routeReason = "all_related_transactions_local_rops";
      } else {
        route = "native_qbo";
        routeReason = "all_related_transactions_native_qbo";
      }
      if (route === "native_qbo" && knownRelated.some(item => item.eligibility !== "eligible")) pushReason(reasons, "related_transaction_not_eligible");
      const eligibility: TenantQboPreviewEligibility = route === "local_rops" ? "local_only" : reasons.length > 0 ? "hold" : "eligible";
      if (eligibility === "hold" && route === "native_qbo") route = "hold";
      return {
        allocationId: row.id,
        sourceSystem: row.sourceSystem,
        sourceId: row.sourceId,
        sourceKey: sourceKey(row.sourceSystem, row.sourceId),
        sourceArtifactSha256: row.sourceArtifactSha256,
        artifactObservationOn: row.artifactObservationOn,
        sourceUpdatedAt: row.sourceUpdatedAt,
        sourcePropertyId: row.sourcePropertyId,
        kind: row.kind,
        paymentTransactionId: row.paymentTransactionId,
        chargeTransactionId: row.chargeTransactionId,
        creditTransactionId: row.creditTransactionId,
        amountCents,
        allocatedOn,
        route,
        eligibility,
        routeReason,
        holdReasons: reasons,
      };
    });

  // Source pairs are immutable in R-ops. Duplicate pairs are a preview hold,
  // never a reason to choose one row nondeterministically.
  const duplicateSourceKeys = new Set<string>();
  const sourceKeyCounts = new Map<string, number>();
  for (const row of transactionRows) if (row.sourceKey) sourceKeyCounts.set(row.sourceKey, (sourceKeyCounts.get(row.sourceKey) ?? 0) + 1);
  sourceKeyCounts.forEach((count, key) => { if (count > 1) duplicateSourceKeys.add(key); });
  const finalTransactions = transactionRows.map(row => {
    if (!row.sourceKey || !duplicateSourceKeys.has(row.sourceKey) || row.route === "local_rops") return row;
    const reasons = [...row.holdReasons];
    pushReason(reasons, "duplicate_source_identity");
    return { ...row, route: "hold" as const, eligibility: "hold" as const, holdReasons: reasons };
  });

  const byKind = new Map<string, string>();
  for (const row of finalTransactions) if (row.kind) byKind.set(row.kind, addCents(byKind.get(row.kind) ?? "0", row.amountCents));
  const counts: TenantQboMigrationPreviewCounts = {
    transactionCount: finalTransactions.length,
    nativeQboTransactionCount: finalTransactions.filter(row => row.route === "native_qbo").length,
    eligibleNativeQboTransactionCount: finalTransactions.filter(row => row.route === "native_qbo" && row.eligibility === "eligible").length,
    heldTransactionCount: finalTransactions.filter(row => row.route === "hold").length,
    localRopsTransactionCount: finalTransactions.filter(row => row.route === "local_rops").length,
    formerTenancyTransactionCount: finalTransactions.filter(row => row.formerTenancy).length,
    allocationCount: allocationRows.length,
    nativeQboAllocationCount: allocationRows.filter(row => row.route === "native_qbo").length,
    eligibleNativeQboAllocationCount: allocationRows.filter(row => row.route === "native_qbo" && row.eligibility === "eligible").length,
    heldAllocationCount: allocationRows.filter(row => row.route === "hold").length,
    localRopsAllocationCount: allocationRows.filter(row => row.route === "local_rops").length,
  };
  const totals: TenantQboMigrationPreviewTotals = {
    transactionAmountCents: {
      all: transactionAmountTotal(finalTransactions, "all"),
      nativeQbo: transactionAmountTotal(finalTransactions, "native_qbo"),
      held: transactionAmountTotal(finalTransactions, "hold"),
      localRops: transactionAmountTotal(finalTransactions, "local_rops"),
    },
    transactionAmountByKindCents: Object.fromEntries(Array.from(byKind.entries()).sort(([left], [right]) => left.localeCompare(right))),
    allocationAmountCents: {
      all: allocationAmountTotal(allocationRows, "all"),
      nativeQbo: allocationAmountTotal(allocationRows, "native_qbo"),
      held: allocationAmountTotal(allocationRows, "hold"),
      localRops: allocationAmountTotal(allocationRows, "local_rops"),
    },
  };
  const withoutHash = {
    kind: TENANT_QBO_MIGRATION_PREVIEW_KIND,
    readOnly: true as const,
    organizationId: input.organizationId,
    environment: input.environment,
    asOf: input.asOf,
    transactions: finalTransactions,
    allocations: allocationRows,
    counts,
    totals,
  };
  return { ...withoutHash, previewSha256: canonicalJsonSha256(withoutHash) };
}

interface DbRow {
  readonly [key: string]: unknown;
}

function dbString(value: unknown): string | null {
  return text(value);
}

function dbDate(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return date(value);
}

/**
 * Read the persisted R-ops ledger/history in one read-only transaction and
 * build the preview. The SQL selects only existing persisted records; it does
 * not read or apply an archive and it never calls a QBO provider.
 */
export async function readTenantQboMigrationPreview(executor: RentOpsQueryExecutor, query: {
  readonly organizationId: string;
  readonly environment: TenantQboEnvironment;
  readonly asOf: string;
}): Promise<TenantQboMigrationPreview> {
  const read = async (tx: RentOpsQueryExecutor): Promise<TenantQboMigrationPreview> => {
    // R-ops rows have no organization column. The organization's property
    // ownership map is therefore the mandatory SQL boundary before reading
    // tenants, ledger rows, or allocations. The reader only loads properties
    // explicitly mapped to this organization; an operator can pass an
    // authorized unmapped extract to the pure classifier for an explicit hold.
    const periodRows = await tx.query<DbRow>(`SELECT organization_id, legal_entity_id, property_id,
                                                       to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
                                                       to_char(effective_until, 'YYYY-MM-DD') AS effective_until
                                                  FROM company_property_entity_periods
                                                 WHERE organization_id=$1
                                                 ORDER BY property_id, effective_from, legal_entity_id`, [query.organizationId]);
    const mappedPropertyIds = Array.from(new Set(periodRows.rows.map(row => String(row.property_id))));
    const propertyRows = await tx.query<DbRow>("SELECT id FROM rent_ops_properties WHERE id = ANY($1::varchar[]) ORDER BY id", [mappedPropertyIds]);
    const scopePropertyIds = propertyRows.rows.map(row => String(row.id));
    const [tenancyRows, bindingRows, policyRows] = await Promise.all([
      tx.query<DbRow>(`SELECT id, source_system, source_id, property_id, unit_id, primary_person_id, status,
                              to_char(COALESCE(actual_move_out_on, (ended_at AT TIME ZONE 'America/New_York')::date), 'YYYY-MM-DD') AS end_on
                         FROM rent_ops_tenancies
                        WHERE property_id = ANY($1::varchar[])
                        ORDER BY id`, [scopePropertyIds]),
      tx.query<DbRow>(`SELECT b.legal_entity_id, b.realm_id,
                              CASE WHEN c.realm_id=b.realm_id AND c.status='active' AND c.revoked_at IS NULL
                                     AND EXISTS (
                                       SELECT 1 FROM accounting_qbo_capabilities cap
                                        WHERE cap.organization_id=b.organization_id AND cap.legal_entity_id=b.legal_entity_id
                                          AND cap.environment=b.environment AND cap.realm_id=b.realm_id
                                          AND cap.capability='accounting.read' AND cap.enabled=true
                                          AND cap.evidence='live_provider_readback'
                                     )
                                   THEN true ELSE false END AS connected
                         FROM accounting_qbo_realm_bindings b
                         LEFT JOIN accounting_qbo_connections c
                           ON c.organization_id=b.organization_id AND c.legal_entity_id=b.legal_entity_id
                          AND c.environment=b.environment AND c.realm_id=b.realm_id
                        WHERE b.organization_id=$1 AND b.environment=$2
                        ORDER BY b.legal_entity_id`, [query.organizationId, query.environment]),
      tx.query<DbRow>(`SELECT legal_entity_id, method,
                              to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
                              to_char(effective_until, 'YYYY-MM-DD') AS effective_until,
                              to_char(cutoff_date, 'YYYY-MM-DD') AS cutoff_date,
                              opening_balance_bridge_reference, invoice_delivery_verified
                         FROM accounting_rental_posting_policies
                        WHERE organization_id=$1
                        ORDER BY legal_entity_id, effective_from`, [query.organizationId]),
    ]);
    const scopeTenancyIds = tenancyRows.rows.map(row => String(row.id));
    const boundedLinkRows = await tx.query<DbRow>(`SELECT local_id, legal_entity_id, source_scope, external_id
                         FROM company_external_identities
                        WHERE organization_id=$1 AND provider='qbo' AND record_kind='Customer'
                          AND local_kind='tenancy' AND source_scope LIKE $2
                          AND local_id = ANY($3::varchar[])
                        ORDER BY local_id, created_at, id`, [query.organizationId, `qbo:${query.environment}:%`, scopeTenancyIds]);
    const transactionRows = await tx.query<DbRow>(`SELECT id, source_system, source_id, source_artifact_sha256,
                              to_char(artifact_observation_on, 'YYYY-MM-DD') AS artifact_observation_on,
                              source_updated_at, property_id, unit_id, tenancy_id, person_id,
                              kind, category, status, amount_cents::text AS amount_cents,
                              to_char(posted_on, 'YYYY-MM-DD') AS posted_on,
                              to_char(due_on, 'YYYY-MM-DD') AS due_on,
                              payment_method, description, reversal_of_id, payer, adjustment_direction,
                              property_link_knowledge, unit_link_knowledge, tenancy_link_knowledge,
                              person_link_knowledge, amount_knowledge, posted_on_knowledge
                         FROM rent_ops_ledger_transactions
                        WHERE property_id = ANY($1::varchar[])
                        ORDER BY posted_on NULLS FIRST, id`, [scopePropertyIds]);
    const transactionIds = transactionRows.rows.map(row => String(row.id));
    const allocationRows = await tx.query<DbRow>(`SELECT id, source_system, source_id, source_artifact_sha256,
                              to_char(artifact_observation_on, 'YYYY-MM-DD') AS artifact_observation_on,
                              source_updated_at, source_property_id, kind,
                              payment_transaction_id, charge_transaction_id, credit_transaction_id,
                              amount_cents::text AS amount_cents,
                              to_char(allocated_on, 'YYYY-MM-DD') AS allocated_on,
                              payment_link_knowledge, charge_link_knowledge, credit_link_knowledge,
                              amount_knowledge, allocated_on_knowledge
                         FROM rent_ops_payment_allocations
                        WHERE source_property_id = ANY($1::varchar[])
                           OR payment_transaction_id = ANY($2::varchar[])
                           OR charge_transaction_id = ANY($2::varchar[])
                           OR credit_transaction_id = ANY($2::varchar[])
                        ORDER BY allocated_on NULLS FIRST, id`, [scopePropertyIds, transactionIds]);
    const bindings: TenantQboMigrationQboBinding[] = bindingRows.rows.map(row => ({ legalEntityId: String(row.legal_entity_id), realmId: String(row.realm_id), connected: row.connected === true || row.connected === "true" }));
    const customerLinks: TenantQboMigrationCustomerLink[] = boundedLinkRows.rows.map(row => ({
      tenancyId: String(row.local_id),
      legalEntityId: dbString(row.legal_entity_id),
      realmId: String(row.source_scope).split(":")[2] ?? "",
      customerObjectId: String(row.external_id),
    }));
    const postingPolicies: TenantQboMigrationPostingPolicy[] = policyRows.rows.map(row => ({
      legalEntityId: String(row.legal_entity_id),
      method: String(row.method) as TenantQboPostingMethod,
      effectiveFrom: String(row.effective_from),
      effectiveUntil: dbString(row.effective_until),
      cutoffDate: String(row.cutoff_date),
      openingBalanceBridgeReference: dbString(row.opening_balance_bridge_reference),
      invoiceDeliveryVerified: row.invoice_delivery_verified === true || row.invoice_delivery_verified === "true",
    }));
    const tenancies: TenantQboMigrationTenancy[] = tenancyRows.rows.map(row => ({
      id: String(row.id),
      sourceSystem: dbString(row.source_system),
      sourceId: dbString(row.source_id),
      propertyId: dbString(row.property_id),
      unitId: dbString(row.unit_id),
      personId: dbString(row.primary_person_id),
      status: dbString(row.status),
      endOn: dbDate(row.end_on),
    }));
    const transactions: TenantQboMigrationLedgerSourceRow[] = transactionRows.rows.map(row => ({
      id: String(row.id), sourceSystem: dbString(row.source_system), sourceId: dbString(row.source_id),
      sourceArtifactSha256: dbString(row.source_artifact_sha256), artifactObservationOn: dbDate(row.artifact_observation_on),
      sourceUpdatedAt: dbString(row.source_updated_at), propertyId: dbString(row.property_id), unitId: dbString(row.unit_id),
      tenancyId: dbString(row.tenancy_id), personId: dbString(row.person_id), kind: dbString(row.kind), category: dbString(row.category),
      status: dbString(row.status), amountCents: dbString(row.amount_cents), postedOn: dbDate(row.posted_on), dueOn: dbDate(row.due_on),
      paymentMethod: dbString(row.payment_method), description: dbString(row.description), reversalOfId: dbString(row.reversal_of_id),
      payer: dbString(row.payer), adjustmentDirection: dbString(row.adjustment_direction), propertyLinkKnowledge: dbString(row.property_link_knowledge),
      unitLinkKnowledge: dbString(row.unit_link_knowledge), tenancyLinkKnowledge: dbString(row.tenancy_link_knowledge), personLinkKnowledge: dbString(row.person_link_knowledge),
      amountKnowledge: dbString(row.amount_knowledge), postedOnKnowledge: dbString(row.posted_on_knowledge),
    }));
    const allocations: TenantQboMigrationAllocationSourceRow[] = allocationRows.rows.map(row => ({
      id: String(row.id), sourceSystem: dbString(row.source_system), sourceId: dbString(row.source_id),
      sourceArtifactSha256: dbString(row.source_artifact_sha256), artifactObservationOn: dbDate(row.artifact_observation_on),
      sourceUpdatedAt: dbString(row.source_updated_at), sourcePropertyId: dbString(row.source_property_id), kind: dbString(row.kind),
      paymentTransactionId: dbString(row.payment_transaction_id), chargeTransactionId: dbString(row.charge_transaction_id), creditTransactionId: dbString(row.credit_transaction_id),
      amountCents: dbString(row.amount_cents), allocatedOn: dbDate(row.allocated_on), paymentLinkKnowledge: dbString(row.payment_link_knowledge),
      chargeLinkKnowledge: dbString(row.charge_link_knowledge), creditLinkKnowledge: dbString(row.credit_link_knowledge), amountKnowledge: dbString(row.amount_knowledge),
      allocatedOnKnowledge: dbString(row.allocated_on_knowledge),
    }));
    return buildTenantQboMigrationPreview({
      organizationId: query.organizationId,
      environment: query.environment,
      asOf: query.asOf,
      properties: propertyRows.rows.map(row => ({ id: String(row.id) })),
      tenancies,
      entityPeriods: periodRows.rows.map(row => ({ organizationId: String(row.organization_id), legalEntityId: String(row.legal_entity_id), propertyId: String(row.property_id), effectiveFrom: String(row.effective_from), effectiveUntil: dbString(row.effective_until) })),
      bindings,
      customerLinks,
      postingPolicies,
      transactions,
      allocations,
    });
  };
  return executor.transaction ? executor.transaction(read, { readOnly: true }) : read(executor);
}
