import { canonicalJsonSha256 } from "../company/commands/fingerprint";

/*
 * Read-only plan: one QuickBooks Customer per tenancy, in the QuickBooks
 * company of the legal entity that owned the property during the tenancy.
 *
 * Pure: the caller loads tenancies, property->entity periods, realm bindings,
 * the mirrored Customer/Vendor/Employee names and the tenancy<->customer
 * identity map. Nothing here writes anywhere; the plan is for review until
 * QuickBooks writes are signed off.
 *
 * QuickBooks rules applied to the proposed DisplayName:
 * - unique across Customers, Vendors and Employees in one company
 *   (compared trimmed and case-insensitive against the mirror);
 * - at most 100 characters: the tenant/property part is shortened, never the
 *   RM id that makes the name unique;
 * - no ':' (QuickBooks uses it for sub-customer paths), tabs or newlines.
 */

export const QBO_CUSTOMER_DISPLAY_NAME_MAX = 100;
const SEPARATOR = " · ";

export const QBO_CUSTOMER_PLAN_STATUSES = [
  "create",
  "linked",
  "review_possible_match",
  "review_name_collision",
  "review_ownership_change",
  "review_invalid_name",
  "blocked_not_connected",
  "blocked_mirror_not_read",
  "blocked_no_entity",
  "skipped_cancelled",
] as const;
export type QboCustomerPlanStatus = typeof QBO_CUSTOMER_PLAN_STATUSES[number];

export interface PlanTenancy {
  readonly tenancyId: string;
  readonly sourceId: string | null;
  /** rent_ops_tenancies.status: future, current, notice, past, cancelled (or unknown). */
  readonly status: string | null;
  readonly tenantName: string | null;
  readonly propertyId: string | null;
  readonly propertyName: string | null;
  readonly unitNumber: string | null;
  /** First occupancy date known (actual, else planned move-in, else created). */
  readonly startOn: string | null;
  /** Actual move-out or end date; null while the tenancy continues. */
  readonly endOn: string | null;
}

export interface PlanEntityPeriod {
  readonly propertyId: string;
  readonly legalEntityId: string;
  /** Inclusive. */
  readonly from: string;
  /** Exclusive; null when open-ended. */
  readonly until: string | null;
}

export interface PlanMirrorName {
  readonly objectType: "Customer" | "Vendor" | "Employee";
  readonly objectId: string;
  readonly displayName: string;
}

export interface PlanEntity {
  readonly legalEntityId: string;
  readonly name: string;
  /** Realm of the confirmed binding in the plan's environment; null when not connected. */
  readonly realmId: string | null;
  /** Whether the Customer mirror has been read for that realm (names can be checked). */
  readonly mirrorRead: boolean;
  readonly names: readonly PlanMirrorName[];
}

export interface PlanCustomerLink {
  readonly tenancyId: string;
  readonly customerObjectId: string;
  readonly legalEntityId: string | null;
  readonly realmId: string;
}

export interface QboCustomerPlanInput {
  readonly environment: "sandbox" | "production";
  readonly asOf: string;
  readonly tenancies: readonly PlanTenancy[];
  readonly periods: readonly PlanEntityPeriod[];
  readonly entities: readonly PlanEntity[];
  readonly links: readonly PlanCustomerLink[];
}

export interface QboCustomerProposal {
  readonly displayName: string;
  readonly active: boolean;
  readonly truncated: boolean;
}

export interface QboCustomerPlanRow {
  readonly tenancyId: string;
  readonly tenancySourceId: string | null;
  readonly tenancyStatus: string | null;
  readonly tenantName: string | null;
  readonly propertyId: string | null;
  readonly propertyName: string | null;
  readonly unitNumber: string | null;
  readonly startOn: string | null;
  readonly endOn: string | null;
  readonly legalEntityId: string | null;
  /** Distinct owning entities during the tenancy, in date order. */
  readonly ownerEntityIds: readonly string[];
  readonly ownershipChange: boolean;
  readonly status: QboCustomerPlanStatus;
  readonly reason: string;
  readonly proposed: QboCustomerProposal | null;
  readonly linkedCustomerId: string | null;
  readonly conflict: PlanMirrorName | null;
}

export type QboCustomerPlanCounts = Readonly<Record<QboCustomerPlanStatus, number>>;

export interface QboCustomerPlanEntityGroup {
  /** null groups tenancies whose property has no owning entity for their dates. */
  readonly legalEntityId: string | null;
  readonly legalEntityName: string | null;
  readonly realmId: string | null;
  readonly connected: boolean;
  readonly mirrorRead: boolean;
  readonly counts: QboCustomerPlanCounts;
  readonly planSha256: string;
  readonly rows: readonly QboCustomerPlanRow[];
}

export interface QboCustomerPlan {
  readonly kind: "qbo_customer_plan";
  readonly readOnly: true;
  readonly environment: "sandbox" | "production";
  readonly asOf: string;
  readonly planSha256: string;
  readonly counts: QboCustomerPlanCounts;
  readonly entities: readonly QboCustomerPlanEntityGroup[];
}

/** Remove what QuickBooks forbids in a name (':' and control characters) and collapse spaces. */
export function cleanQboNamePart(value: string | null | undefined): string {
  return (value ?? "").replace(/:/g, " ").replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
}

/** How QuickBooks compares DisplayNames for uniqueness. */
export function normalizeQboName(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * `<Tenant name> · <Property> <Unit> · RM<id>`, at most 100 characters.
 * Returns null when the id alone leaves no room for a readable name.
 */
export function qboCustomerDisplayName(input: { readonly tenantName: string | null; readonly propertyName: string | null; readonly unitNumber: string | null; readonly sourceKey: string }): { readonly displayName: string; readonly truncated: boolean } | null {
  const id = cleanQboNamePart(input.sourceKey).replace(/ /g, "");
  if (!id) return null;
  const suffix = `${SEPARATOR}RM${id}`;
  const property = cleanQboNamePart(input.propertyName);
  const unit = cleanQboNamePart(input.unitNumber);
  const place = [property, unit && unit !== property ? unit : ""].filter(Boolean).join(" ");
  const head = [cleanQboNamePart(input.tenantName) || "Unknown tenant", place].filter(Boolean).join(SEPARATOR);
  const room = QBO_CUSTOMER_DISPLAY_NAME_MAX - suffix.length;
  if (room < 12) return null;
  if (head.length <= room) return { displayName: `${head}${suffix}`, truncated: false };
  // Shorten the readable part; drop a split surrogate pair and a dangling separator.
  const cut = head.slice(0, room - 1).replace(/[\uD800-\uDBFF]$/, "").replace(/[\s·]+$/, "");
  return { displayName: `${cut}…${suffix}`, truncated: true };
}

function isFormer(tenancy: PlanTenancy, asOf: string): boolean {
  return tenancy.status === "past" || (tenancy.endOn !== null && tenancy.endOn <= asOf);
}

/** Owning entities during the tenancy (inclusive dates; periods are [from, until)). */
export function owningEntities(tenancy: PlanTenancy, periods: readonly PlanEntityPeriod[], asOf: string): { readonly owner: string | null; readonly entityIds: readonly string[] } {
  if (!tenancy.propertyId) return { owner: null, entityIds: [] };
  const start = tenancy.startOn ?? tenancy.endOn ?? asOf;
  let end = tenancy.endOn ?? asOf;
  if (end < start) end = start;
  const overlapping = periods
    .filter(period => period.propertyId === tenancy.propertyId && period.from <= end && (period.until === null || period.until > start))
    .sort((left, right) => (left.from < right.from ? -1 : left.from > right.from ? 1 : 0));
  const entityIds: string[] = [];
  for (const period of overlapping) if (!entityIds.includes(period.legalEntityId)) entityIds.push(period.legalEntityId);
  // The entity holding the property at the tenancy's end (or most recently before it).
  return { owner: overlapping.at(-1)?.legalEntityId ?? null, entityIds };
}

function emptyCounts(): Record<QboCustomerPlanStatus, number> {
  return Object.fromEntries(QBO_CUSTOMER_PLAN_STATUSES.map(status => [status, 0])) as Record<QboCustomerPlanStatus, number>;
}

function compareRows(left: QboCustomerPlanRow, right: QboCustomerPlanRow): number {
  const keys = (row: QboCustomerPlanRow) => [row.propertyName ?? "", row.unitNumber ?? "", row.startOn ?? "", row.tenancyId];
  const a = keys(left);
  const b = keys(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index]! < b[index]!) return -1;
    if (a[index]! > b[index]!) return 1;
  }
  return 0;
}

export function buildQboCustomerPlan(input: QboCustomerPlanInput): QboCustomerPlan {
  const entities = new Map(input.entities.map(entity => [entity.legalEntityId, entity]));
  const linkByTenancy = new Map(input.links.map(link => [link.tenancyId, link]));
  const linkedCustomers = new Map(input.links.map(link => [`${link.realmId}:${link.customerObjectId}`, link.tenancyId]));
  const namesByEntity = new Map<string, Map<string, PlanMirrorName>>();
  for (const entity of input.entities) {
    const names = new Map<string, PlanMirrorName>();
    // A Customer match is the most useful one to show; otherwise the first seen.
    for (const name of entity.names) {
      const key = normalizeQboName(name.displayName);
      if (!names.has(key) || (name.objectType === "Customer" && names.get(key)!.objectType !== "Customer")) names.set(key, name);
    }
    namesByEntity.set(entity.legalEntityId, names);
  }

  const rows: QboCustomerPlanRow[] = [];
  for (const tenancy of input.tenancies) {
    const ownership = owningEntities(tenancy, input.periods, input.asOf);
    const naming = qboCustomerDisplayName({ tenantName: tenancy.tenantName, propertyName: tenancy.propertyName, unitNumber: tenancy.unitNumber, sourceKey: tenancy.sourceId ?? tenancy.tenancyId });
    const proposed: QboCustomerProposal | null = naming ? { ...naming, active: !isFormer(tenancy, input.asOf) } : null;
    const base = {
      tenancyId: tenancy.tenancyId, tenancySourceId: tenancy.sourceId, tenancyStatus: tenancy.status, tenantName: tenancy.tenantName,
      propertyId: tenancy.propertyId, propertyName: tenancy.propertyName, unitNumber: tenancy.unitNumber, startOn: tenancy.startOn, endOn: tenancy.endOn,
      ownerEntityIds: ownership.entityIds, ownershipChange: ownership.entityIds.length > 1,
    };
    const row = (legalEntityId: string | null, status: QboCustomerPlanStatus, reason: string, extra: Partial<Pick<QboCustomerPlanRow, "proposed" | "linkedCustomerId" | "conflict">> = {}): QboCustomerPlanRow => ({
      ...base, legalEntityId, status, reason, proposed: extra.proposed === undefined ? proposed : extra.proposed, linkedCustomerId: extra.linkedCustomerId ?? null, conflict: extra.conflict ?? null,
    });

    const link = linkByTenancy.get(tenancy.tenancyId);
    if (link) {
      const linkedEntity = link.legalEntityId ?? ownership.owner;
      const note = ownership.owner && linkedEntity !== ownership.owner ? " The property's owner for these dates is a different entity; review the link." : "";
      rows.push(row(linkedEntity, "linked", `Already linked to QuickBooks customer ${link.customerObjectId}; no action.${note}`, { proposed: null, linkedCustomerId: link.customerObjectId }));
      continue;
    }
    if (tenancy.status === "cancelled") {
      rows.push(row(ownership.owner, "skipped_cancelled", "Cancelled before move-in; no customer is proposed. Review if it carried charges.", { proposed: null }));
      continue;
    }
    if (!ownership.owner) {
      rows.push(row(null, "blocked_no_entity", tenancy.propertyId ? "No legal entity owned the property during this tenancy; add the property's entity period." : "The tenancy has no property."));
      continue;
    }
    const entity = entities.get(ownership.owner);
    if (!entity?.realmId) {
      rows.push(row(ownership.owner, "blocked_not_connected", `The owning entity has no ${input.environment} QuickBooks company binding.`));
      continue;
    }
    if (!proposed) {
      rows.push(row(ownership.owner, "review_invalid_name", "The source id is too long to form a QuickBooks DisplayName of at most 100 characters."));
      continue;
    }
    if (base.ownershipChange) {
      rows.push(row(ownership.owner, "review_ownership_change", `The property changed owning entity during this tenancy (${ownership.entityIds.length} entities); proposed under the owner at its end. Decide how to split the history.`));
      continue;
    }
    if (!entity.mirrorRead) {
      rows.push(row(ownership.owner, "blocked_mirror_not_read", "QuickBooks customers have not been mirrored for this company yet; names cannot be checked for uniqueness."));
      continue;
    }
    const match = namesByEntity.get(entity.legalEntityId)?.get(normalizeQboName(proposed.displayName));
    if (match?.objectType === "Customer" && !linkedCustomers.has(`${entity.realmId}:${match.objectId}`)) {
      rows.push(row(ownership.owner, "review_possible_match", `QuickBooks customer ${match.objectId} already has this name and is not linked; confirm and link it instead of creating one.`, { conflict: match }));
      continue;
    }
    if (match) {
      const what = match.objectType === "Customer" ? `customer ${match.objectId} linked to another tenancy` : `${match.objectType.toLowerCase()} ${match.objectId}`;
      rows.push(row(ownership.owner, "review_name_collision", `The name is already used by QuickBooks ${what}; DisplayName must be unique across customers, vendors and employees.`, { conflict: match }));
      continue;
    }
    rows.push(row(ownership.owner, "create", proposed.active ? "Create an active QuickBooks customer." : "Create an inactive QuickBooks customer (former tenant)."));
  }

  // Two tenancies proposing the same name in one company cannot both be created.
  const proposedCount = new Map<string, number>();
  const keyOf = (item: QboCustomerPlanRow) => `${item.legalEntityId}:${normalizeQboName(item.proposed!.displayName)}`;
  for (const item of rows) if (item.proposed && item.legalEntityId) proposedCount.set(keyOf(item), (proposedCount.get(keyOf(item)) ?? 0) + 1);
  const finalRows = rows.map(item => item.status === "create" && (proposedCount.get(keyOf(item)) ?? 0) > 1
    ? { ...item, status: "review_name_collision" as const, reason: "Another tenancy in this plan proposes the same name in this QuickBooks company." }
    : item);

  const groups: QboCustomerPlanEntityGroup[] = [];
  const knownIds = input.entities.map(entity => entity.legalEntityId);
  const otherIds = [...new Set(finalRows.map(item => item.legalEntityId).filter((id): id is string => id !== null && !entities.has(id)))];
  const byName = (id: string) => entities.get(id)?.name ?? id;
  const groupIds: (string | null)[] = [...knownIds, ...otherIds].sort((left, right) => (byName(left) < byName(right) ? -1 : byName(left) > byName(right) ? 1 : 0));
  if (finalRows.some(item => item.legalEntityId === null)) groupIds.push(null);
  const totals = emptyCounts();
  for (const legalEntityId of groupIds) {
    const entity = legalEntityId ? entities.get(legalEntityId) : undefined;
    const groupRows = finalRows.filter(item => item.legalEntityId === legalEntityId).sort(compareRows);
    const counts = emptyCounts();
    for (const item of groupRows) { counts[item.status] += 1; totals[item.status] += 1; }
    const realmId = entity?.realmId ?? null;
    groups.push({
      legalEntityId, legalEntityName: entity?.name ?? null, realmId, connected: realmId !== null, mirrorRead: entity?.mirrorRead ?? false,
      counts, planSha256: canonicalJsonSha256({ environment: input.environment, legalEntityId, realmId, rows: groupRows }), rows: groupRows,
    });
  }
  return {
    kind: "qbo_customer_plan", readOnly: true, environment: input.environment, asOf: input.asOf,
    planSha256: canonicalJsonSha256({ environment: input.environment, entities: groups.map(group => ({ legalEntityId: group.legalEntityId, planSha256: group.planSha256 })) }),
    counts: totals, entities: groups,
  };
}
