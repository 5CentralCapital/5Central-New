import { financialSourceScopeSchema } from "../../shared/accounting";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { AccountingError } from "./errors";
import { linkTenancyToQboCustomer } from "./receivables-links";
import { currentBusinessDate } from "./tenancy-source-resolution";

/*
 * Links tenancies to their QuickBooks customers automatically when the
 * customer's name AND address both identify exactly one tenancy. A link is
 * made only when the match is unique in both directions (one customer for
 * the tenancy, one tenancy for the customer) and the tenancy's historical
 * owner is the customer's company — linkTenancyToQboCustomer re-checks the
 * ownership history and the one-customer-per-tenancy rules. Nothing is
 * written to QuickBooks; only the local identity map changes.
 */

export interface AutoLinkTenancy {
  readonly tenancyId: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly propertyName: string | null;
  readonly propertyAddress: string | null;
  readonly unitNumber: string | null;
}

export interface AutoLinkCustomer {
  readonly legalEntityId: string;
  readonly realmId: string;
  readonly objectId: string;
  /** Name fields: DisplayName, FullyQualifiedName, GivenName, FamilyName, CompanyName, PrintOnCheckName. */
  readonly names: readonly string[];
  /** Address fields: Bill/Ship address lines and city, plus the parent path of a sub-customer. */
  readonly addresses: readonly string[];
}

export interface AutoLinkMatch { readonly tenancyId: string; readonly customer: AutoLinkCustomer }

const UNIT_DESIGNATORS = new Set(["lot", "unit", "apt", "suite", "ste", "bldg", "building", "room", "space", "trailer", "lote"]);
const GENERIC_PROPERTY_WORDS = new Set(["apartments", "apartment", "apts", "apt", "the", "llc", "inc", "homes", "home", "and", "of", "at", "unit", "units"]);

export function matchTokens(value: string | null | undefined): string[] {
  return (value ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}

function hasAll(haystack: ReadonlySet<string>, needles: readonly string[]): boolean {
  return needles.length > 0 && needles.every(token => haystack.has(token));
}

/** Both the first and last name appear in the customer's name fields. */
export function nameMatches(tenancy: AutoLinkTenancy, customer: AutoLinkCustomer): boolean {
  const first = matchTokens(tenancy.firstName).filter(token => token.length > 1);
  const last = matchTokens(tenancy.lastName).filter(token => token.length > 1);
  if (!first.length || !last.length) return false;
  const tokens = new Set(customer.names.flatMap(matchTokens));
  // The first given name and every part of the family name must be present.
  return tokens.has(first[0]!) && hasAll(tokens, last);
}

/** The unit and the property (name or street address) appear in the customer's address fields. */
export function addressMatches(tenancy: AutoLinkTenancy, customer: AutoLinkCustomer): boolean {
  const tokens = new Set([...customer.addresses, ...customer.names].flatMap(matchTokens));
  const unit = matchTokens(tenancy.unitNumber);
  if (!hasAll(tokens, unit)) return false;
  // A unit that is itself a street address ("617 Plateau Ave") identifies the home on its own.
  const unitIsAddress = unit.some(token => /^\d{2,}$/.test(token)) && unit.some(token => /^[a-z]{3,}$/.test(token) && !UNIT_DESIGNATORS.has(token));
  if (unitIsAddress) return true;
  const property = matchTokens(tenancy.propertyName).filter(token => !GENERIC_PROPERTY_WORDS.has(token));
  if (hasAll(tokens, property)) return true;
  const street = matchTokens(tenancy.propertyAddress);
  const number = street.find(token => /^\d+$/.test(token));
  const word = street.find(token => /^[a-z]{3,}$/.test(token) && !["the", "ave", "st", "rd", "blvd", "dr", "ln", "ct", "way", "east", "west", "north", "south"].includes(token));
  return Boolean(number && word && tokens.has(number) && tokens.has(word));
}

/** Unique name-and-address matches, one customer per tenancy and one tenancy per customer. */
export function matchTenanciesToCustomers(tenancies: readonly AutoLinkTenancy[], customers: readonly AutoLinkCustomer[]): AutoLinkMatch[] {
  const byTenancy = new Map<string, AutoLinkCustomer[]>();
  const byCustomer = new Map<string, string[]>();
  const key = (customer: AutoLinkCustomer) => `${customer.realmId}:${customer.objectId}`;
  for (const tenancy of tenancies) {
    for (const customer of customers) {
      if (!nameMatches(tenancy, customer) || !addressMatches(tenancy, customer)) continue;
      byTenancy.set(tenancy.tenancyId, [...(byTenancy.get(tenancy.tenancyId) ?? []), customer]);
      byCustomer.set(key(customer), [...(byCustomer.get(key(customer)) ?? []), tenancy.tenancyId]);
    }
  }
  const matches: AutoLinkMatch[] = [];
  for (const [tenancyId, candidates] of Array.from(byTenancy.entries())) {
    if (candidates.length !== 1) continue;
    const customer = candidates[0]!;
    if (byCustomer.get(key(customer))?.length !== 1) continue;
    matches.push({ tenancyId, customer });
  }
  return matches.sort((left, right) => left.tenancyId.localeCompare(right.tenancyId));
}

const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;

function customerFromBody(legalEntityId: string, realmId: string, objectId: string, body: unknown): AutoLinkCustomer {
  const row = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const address = (value: unknown): string[] => {
    const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return ["Line1", "Line2", "Line3", "Line4", "Line5", "City"].flatMap(field => text(item[field]) ?? []);
  };
  const qualified = text(row.FullyQualifiedName);
  return {
    legalEntityId, realmId, objectId,
    names: ["DisplayName", "FullyQualifiedName", "GivenName", "MiddleName", "FamilyName", "CompanyName", "PrintOnCheckName"].flatMap(field => text(row[field]) ?? []),
    addresses: [...address(row.BillAddr), ...address(row.ShipAddr), ...(qualified && qualified.includes(":") ? [qualified.split(":").slice(0, -1).join(" ")] : [])],
  };
}

export interface AutoLinkResult {
  readonly linked: readonly { readonly tenancyId: string; readonly customerObjectId: string; readonly legalEntityId: string }[];
  readonly unmatched: number;
}

/**
 * Links every unlinked tenancy that has a unique name-and-address match.
 * Run inside the caller's authorized write transaction. `tenancyId` narrows
 * the links made (matching still considers every tenancy so uniqueness holds).
 */
export async function autoLinkQboCustomers(executor: RentOpsQueryExecutor, input: { readonly organizationId: string; readonly environment: "sandbox" | "production"; readonly legalEntityId?: string; readonly tenancyId?: string; readonly asOf?: string }): Promise<AutoLinkResult> {
  const { organizationId, environment } = input;
  const bindings = await executor.query<{ legal_entity_id: unknown; realm_id: unknown }>(
    "SELECT legal_entity_id, realm_id FROM accounting_qbo_realm_bindings WHERE organization_id=$1 AND environment=$2",
    [organizationId, environment],
  );
  const scopes = bindings.rows.map(row => ({ legalEntityId: String(row.legal_entity_id), realmId: String(row.realm_id) }))
    .filter(scope => !input.legalEntityId || scope.legalEntityId === input.legalEntityId);
  if (!scopes.length) return { linked: [], unmatched: 0 };

  const links = await executor.query<{ local_id: unknown; external_id: unknown; source_scope: unknown }>(
    `SELECT local_id, external_id, source_scope FROM company_external_identities
      WHERE organization_id=$1 AND provider='qbo' AND record_kind='Customer' AND local_kind='tenancy' AND source_scope LIKE $2`,
    [organizationId, `qbo:${environment}:%`],
  );
  const linkedTenancies = new Set(links.rows.map(row => String(row.local_id)));
  const linkedCustomers = new Set(links.rows.map(row => `${String(row.source_scope).split(":")[2] ?? ""}:${String(row.external_id)}`));

  const customers: AutoLinkCustomer[] = [];
  for (const scope of scopes) {
    const rows = await executor.query<{ object_id: unknown; provider_body: unknown }>(
      `SELECT DISTINCT ON (object_id) object_id, provider_body FROM accounting_qbo_source_objects
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type='Customer' AND deleted_at IS NULL
        ORDER BY object_id, provider_updated_at DESC NULLS LAST, received_at DESC`,
      [organizationId, scope.legalEntityId, environment, scope.realmId],
    );
    for (const row of rows.rows) {
      const objectId = String(row.object_id);
      const body = typeof row.provider_body === "string" ? JSON.parse(row.provider_body) as unknown : row.provider_body;
      customers.push(customerFromBody(scope.legalEntityId, scope.realmId, objectId, body));
    }
  }

  const tenancyRows = await executor.query<Record<string, unknown>>(
    `SELECT t.id, pe.first_name, pe.last_name, p.name AS property_name, p.address_line1, u.unit_number
       FROM rent_ops_tenancies t
       JOIN rent_ops_people pe ON pe.id = t.primary_person_id
       LEFT JOIN rent_ops_properties p ON p.id = t.property_id
       LEFT JOIN rent_ops_units u ON u.id = t.unit_id
      WHERE COALESCE(t.status, '') <> 'cancelled'
        AND EXISTS (SELECT 1 FROM company_property_entity_periods m WHERE m.property_id = t.property_id AND m.organization_id = $1)
      ORDER BY t.id`,
    [organizationId],
  );
  const tenancies: AutoLinkTenancy[] = tenancyRows.rows.map(row => ({
    tenancyId: String(row.id), firstName: text(row.first_name), lastName: text(row.last_name),
    propertyName: text(row.property_name), propertyAddress: text(row.address_line1), unitNumber: text(row.unit_number),
  }));

  // Already-linked customers and tenancies still count toward uniqueness.
  const matches = matchTenanciesToCustomers(tenancies, customers)
    .filter(match => !linkedTenancies.has(match.tenancyId) && !linkedCustomers.has(`${match.customer.realmId}:${match.customer.objectId}`))
    .filter(match => !input.tenancyId || match.tenancyId === input.tenancyId);
  const linked: { tenancyId: string; customerObjectId: string; legalEntityId: string }[] = [];
  for (const match of matches) {
    try {
      const result = await linkTenancyToQboCustomer(executor, {
        scope: financialSourceScopeSchema.parse({ provider: "qbo", organizationId, legalEntityId: match.customer.legalEntityId, environment, realmId: match.customer.realmId }),
        tenancyId: match.tenancyId, customerObjectId: match.customer.objectId, asOf: input.asOf ?? currentBusinessDate(),
      });
      if (result.status === "linked") linked.push({ tenancyId: match.tenancyId, customerObjectId: match.customer.objectId, legalEntityId: match.customer.legalEntityId });
    } catch (error) {
      // Ownership history or a concurrent link rules this match out; leave it for manual review.
      if (!(error instanceof AccountingError)) throw error;
    }
  }
  const unlinkedCount = tenancies.filter(tenancy => !linkedTenancies.has(tenancy.tenancyId) && (!input.tenancyId || tenancy.tenancyId === input.tenancyId)).length;
  return { linked, unmatched: Math.max(0, unlinkedCount - linked.length) };
}
