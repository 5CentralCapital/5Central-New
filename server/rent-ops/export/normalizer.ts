import { createHash } from "node:crypto";
import type {
  FactKnowledge,
  HapContractStatus,
  HapPaymentStatus,
  RentManagerHapStatusCrosswalk,
  RentManagerImportInput,
  RentManagerRawRecord,
  RentManagerChargeTypeDefinition,
  RentManagerFinancialSemanticCrosswalk,
} from "../../../shared/rent-ops-contracts";
import { financialSemanticCrosswalkValue, selectFinancialSemanticCrosswalk } from "../../../shared/rent-ops-contracts";
import type { ExportException, ExportPayload } from "./types";
import { redactIdentifier } from "./redaction";
import { canonicalJson } from "./hash";

export interface NormalizationException extends ExportException {
  confidence: "confirmed" | "unresolved" | "ambiguous";
}

export interface NormalizedRentManagerImport {
  input: RentManagerImportInput;
  exceptions: NormalizationException[];
  /** All records retain their original RM casing and receive deterministic aliases. */
  recordCounts: Record<string, number>;
  confidence: NormalizationConfidence;
}

export interface NormalizationConfidence {
  overall: "confirmed" | "partial" | "blocked";
  relationships: "confirmed" | "partial" | "ambiguous";
  unresolvedRelationshipCount: number;
  ambiguousRelationshipCount: number;
  hap: "confirmed" | "not_observed" | "blocked";
}

type Raw = RentManagerRawRecord & Record<string, unknown>;

const DEPOSIT_MISSING_UNIT_SENTINEL = "__NO_UNIT__";

function depositCompositeIdentity(record: Raw): string | undefined {
  const parent = text(record, "parentSourceId", "ParentSourceID", "ParentID", "EntityKeyID", "EntityKeyId");
  const type = text(record, "SecurityDepositTypeID", "DepositTypeID", "DepositTypeId");
  const charge = text(record, "ChargeTypeID", "ChargeTypeId");
  const property = text(record, "PropertyID", "PropertyId");
  const account = text(record, "AccountID", "AccountId", "TenantID", "TenantId");
  if (!parent || !type || !charge || !property || !account) return undefined;
  const unit = text(record, "UnitID", "UnitId") ?? DEPOSIT_MISSING_UNIT_SENTINEL;
  // Keep the complete source tuple visible in the deterministic identity. The
  // sentinel is identity-only and is never copied into a target unit field.
  return `deposit:composite:${parent}|${type}|${charge}|${property}|${account}|${unit}`;
}

function assignDepositCompositeIdentities(records: readonly RentManagerRawRecord[], exceptions: NormalizationException[]): Raw[] {
  const rows = records.map((record) => structuredClone(record) as Raw);
  const existingIds = new Set(rows.map((record) => text(record, "sourceId", "id", "ID", "Id")).filter((value): value is string => Boolean(value)));
  const candidates = new Map<number, string>();
  const candidateCounts = new Map<string, number>();
  rows.forEach((record, index) => {
    const candidate = depositCompositeIdentity(record);
    if (!candidate && !text(record, "sourceId", "id", "ID", "Id")) {
      addException(exceptions, "incomplete_coverage", "deposits", record, "deposit_source_id_missing_composite_fields", "unresolved");
      return;
    }
    if (!candidate) return;
    candidates.set(index, candidate);
    candidateCounts.set(candidate, (candidateCounts.get(candidate) ?? 0) + 1);
    // Keep the canonical tuple visible for independent uniqueness controls
    // even when RM supplied a native summary ID.  It is evidence, not a unit
    // inference, and is stable under response ordering.
    record.depositCompositeIdentity = candidate;
  });
  for (const [index, candidate] of Array.from(candidates.entries())) {
    if ((candidateCounts.get(candidate) ?? 0) !== 1) {
      addException(exceptions, "duplicate_source_id", "deposits", rows[index], "deposit_composite_source_identity_not_unique", "ambiguous");
      continue;
    }
    if (!text(rows[index], "sourceId", "id", "ID", "Id")) {
      if (existingIds.has(candidate)) {
        addException(exceptions, "duplicate_source_id", "deposits", rows[index], "deposit_composite_source_identity_collides_with_native_id", "ambiguous");
        continue;
      }
      rows[index].sourceId = candidate;
      rows[index].identityDerivedFromComposite = true;
    }
  }
  return rows;
}

function value(record: Raw, ...keys: string[]): unknown {
  for (const key of keys) if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
  return undefined;
}

function text(record: Raw, ...keys: string[]): string | undefined {
  const found = value(record, ...keys);
  if (found === undefined) return undefined;
  const result = String(found).trim();
  return result || undefined;
}

/**
 * SecurityDepositSummaries often carry only SecurityDepositTypeID.  The
 * lookup is joined by that exact source key; conflicting lookup rows remain
 * unresolved instead of choosing response order or a target-local default.
 */
function securityDepositTypeLookup(records: readonly RentManagerRawRecord[]): Map<string, string | undefined> {
  const names = new Map<string, Set<string>>();
  for (const candidate of records) {
    const row = candidate as Raw;
    const sourceId = text(row, "SecurityDepositTypeID", "SecurityDepositTypeId", "DepositTypeID", "DepositTypeId", "sourceId", "ID", "Id");
    if (!sourceId) continue;
    const name = text(row, "Name", "SecurityDepositTypeName", "DepositType", "Type", "Description", "Label");
    if (!name) continue;
    const values = names.get(sourceId) ?? new Set<string>();
    values.add(name);
    names.set(sourceId, values);
  }
  return new Map(Array.from(names.entries()).map(([sourceId, values]) => [sourceId, values.size === 1 ? Array.from(values)[0] : undefined]));
}

function booleanValue(record: Raw, ...keys: string[]): boolean {
  const found = value(record, ...keys);
  if (typeof found === "boolean") return found;
  if (typeof found === "number") return found === 1;
  if (typeof found === "string") return /^(true|yes|y|1)$/i.test(found.trim());
  return false;
}

function id(record: Raw, fields: string[], namespace?: string): string | undefined {
  const raw = text(record, ...fields, "sourceId", "id", "ID", "Id");
  if (!raw) return undefined;
  return namespace && !raw.startsWith(`${namespace}:`) ? `${namespace}:${raw}` : raw;
}

function augment(record: RentManagerRawRecord, fields: string[], aliases: Record<string, string[]> = {}, namespace?: string, entityType?: string): Raw {
  const copy = structuredClone(record) as Raw;
  const sourceId = id(copy, fields, namespace);
  if (sourceId && copy.sourceId === undefined) copy.sourceId = sourceId;
  if (entityType && copy.entityType === undefined) copy.entityType = entityType;
  for (const [target, sources] of Object.entries(aliases)) {
    if (copy[target] !== undefined) continue;
    const found = value(copy, ...sources);
    if (found !== undefined) copy[target] = found;
  }
  return copy;
}

function indexBy(records: readonly Raw[], fields: string[]): Map<string, Raw[]> {
  const result = new Map<string, Raw[]>();
  for (const record of records) {
    const key = id(record, fields);
    if (!key) continue;
    const rows = result.get(key) ?? [];
    rows.push(record);
    result.set(key, rows);
  }
  return result;
}

function addException(exceptions: NormalizationException[], code: ExportException["code"], collection: string, record: Raw | undefined, detail: string, confidence: NormalizationException["confidence"] = "unresolved"): void {
  const rawId = record ? text(record, "sourceId", "id", "ID", "Id") : undefined;
  exceptions.push({ code, collection, ...(rawId ? { sourceIdHash: redactIdentifier(rawId) } : {}), detail, confidence });
}

function explicitTenantContact(tenant: Raw, contacts: readonly Raw[]): Raw | undefined {
  const tenantId = id(tenant, ["TenantID"]);
  if (!tenantId) return undefined;
  const candidates = contacts.filter((contact) => {
    const contactTenant = id(contact, ["TenantID", "ParentID", "EntityKeyID"]);
    const parentType = text(contact, "ParentType", "EntityType", "ContactType");
    return contactTenant === tenantId && (!parentType || /tenant|customer/i.test(parentType));
  });
  const primary = candidates.filter((candidate) => booleanValue(candidate, "IsPrimary", "Primary", "IsPrimaryContact"));
  return primary.length === 1 ? primary[0] : candidates.length === 1 ? candidates[0] : undefined;
}

function explicitPhone(contact: Raw | undefined, phones: readonly Raw[]): Raw | undefined {
  if (!contact) return undefined;
  const contactId = id(contact, ["ContactID"]);
  if (!contactId) return undefined;
  const candidates = phones.filter((phone) => id(phone, ["ContactID", "ParentID"]) === contactId);
  return selectPhone(candidates);
}

function selectPhone(candidates: readonly Raw[]): Raw | undefined {
  const primary = candidates.filter((candidate) => booleanValue(candidate, "IsPrimary", "Primary"));
  const textReady = candidates.filter((candidate) => booleanValue(candidate, "IsTextReady", "TextReady"));
  return primary.length === 1 ? primary[0] : textReady.length === 1 ? textReady[0] : candidates.length === 1 ? candidates[0] : undefined;
}

function joinById(index: Map<string, Raw[]>, rawId: string | undefined): { row?: Raw; ambiguous: boolean } {
  if (!rawId) return { ambiguous: false };
  const rows = index.get(rawId) ?? [];
  return { row: rows.length === 1 ? rows[0] : undefined, ambiguous: rows.length > 1 };
}

function embeddedRecord(record: Raw, ...keys: string[]): Raw | undefined {
  for (const key of keys) {
    const candidate = value(record, key);
    if (Array.isArray(candidate)) {
      const rows = candidate.filter((row): row is Raw => Boolean(row) && typeof row === "object" && !Array.isArray(row)) as Raw[];
      if (rows.length === 1) return rows[0];
      continue;
    }
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate as Raw;
  }
  return undefined;
}

function embeddedId(record: Raw, relationKeys: string[], idKeys: string[]): string | undefined {
  const nested = embeddedRecord(record, ...relationKeys);
  return nested ? text(nested, ...idKeys) : undefined;
}

function addressHasData(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const row = candidate as Record<string, unknown>;
  const nested = row.Address && typeof row.Address === "object" && !Array.isArray(row.Address) ? row.Address as Record<string, unknown> : undefined;
  const source = nested ?? row;
  return ["Line1", "AddressLine1", "Address", "Street", "Line2", "AddressLine2", "City", "State", "PostalCode", "Zip", "ZipCode"]
    .some((key) => source[key] !== undefined && source[key] !== null && String(source[key]).trim() !== "");
}

function addressValue(candidate: unknown): Raw | undefined {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const row = candidate as Raw;
  const nested = row.Address && typeof row.Address === "object" && !Array.isArray(row.Address) ? row.Address as Raw : undefined;
  return nested ?? row;
}

function addressRoleIsExplicit(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const row = candidate as Raw;
  if (booleanValue(row, "IsPrimary", "Primary", "IsPrimaryAddress", "IsDefault")) return true;
  const role = text(row, "AddressType", "Type", "Role", "AddressRole", "Use", "AddressUse");
  return Boolean(role && /primary|property|physical|main/i.test(role));
}

function selectPropertyAddress(candidates: readonly unknown[]): { row?: Raw; ambiguous: boolean; sourceEmpty: boolean } {
  const rows = candidates.map(addressValue).filter((row): row is Raw => Boolean(row));
  if (rows.length > 0 && rows.every((row) => !addressHasData(row))) return { ambiguous: false, sourceEmpty: true };
  const eligible = rows.filter((row) => addressHasData(row) && addressRoleIsExplicit(row));
  if (eligible.length === 1) return { row: eligible[0], ambiguous: false, sourceEmpty: false };
  // A single embedded row is not an order-dependent first-row choice. It is
  // retained as the sole source address; two or more unlabelled rows remain
  // unresolved rather than changing with RM response order.
  if (eligible.length === 0 && rows.length === 1 && addressHasData(rows[0])) return { row: rows[0], ambiguous: false, sourceEmpty: false };
  return { ambiguous: rows.length > 0, sourceEmpty: false };
}

function marketRentAmount(row: Raw): string | number | undefined {
  const amount = value(row, "AmountCents", "amountCents", "Amount", "Rent", "Value", "MarketRent");
  return typeof amount === "string" || typeof amount === "number" ? amount : undefined;
}

function marketRentExplicitCurrent(row: Raw): boolean {
  if (booleanValue(row, "IsCurrent", "Current", "IsCurrentRent", "IsActive", "Active")) return true;
  const status = text(row, "Status", "RentStatus", "MarketRentStatus");
  return Boolean(status && /current|active/i.test(status));
}

function selectMarketRent(candidates: readonly Raw[], asOf?: string): { row?: Raw; ambiguous: boolean; excludedFutureOrExpired: boolean } {
  if (candidates.length === 0) return { ambiguous: false, excludedFutureOrExpired: false };
  // Preserve the pre-v3 normalizer contract when no explicit as-of date was
  // requested.  The v3 artifact always supplies an as-of date; this fallback
  // keeps older callers deterministic while the strict interval path below
  // rejects overlapping conflicting values instead of selecting response
  // order.
  if (!asOf) {
    const current = candidates.filter((row) => marketRentExplicitCurrent(row));
    const pool = current.length > 0 ? current : candidates;
    const sorted = [...pool].sort((left, right) => `${dateKey(text(right, "FromDate", "EffectiveFrom", "StartDate")) ?? ""}|${text(right, "MarketRentID", "RentID", "sourceId") ?? ""}`.localeCompare(`${dateKey(text(left, "FromDate", "EffectiveFrom", "StartDate")) ?? ""}|${text(left, "MarketRentID", "RentID", "sourceId") ?? ""}`));
    return { row: sorted[0], ambiguous: false, excludedFutureOrExpired: false };
  }
  const asOfKey = dateKey(asOf ?? new Date().toISOString().slice(0, 10));
  const dated = candidates.map((row) => ({ row, start: dateKey(text(row, "FromDate", "EffectiveFrom", "StartDate")), end: dateKey(text(row, "ToDate", "EffectiveTo", "EndDate")) }));
  const eligible = dated.filter(({ start, end }) => (!asOfKey || !start || start <= asOfKey) && (!asOfKey || !end || end >= asOfKey));
  const excludedFutureOrExpired = eligible.length !== dated.length;
  const current = eligible.filter(({ row }) => marketRentExplicitCurrent(row));
  const pool = current.length > 0 ? current : eligible.filter(({ start, end }) => Boolean(start || end));
  const candidatesForSelection = pool.length > 0 ? pool : eligible.length === 1 ? eligible : eligible.filter(({ row }) => marketRentExplicitCurrent(row));
  if (candidatesForSelection.length === 0) return { ambiguous: candidates.length > 1, excludedFutureOrExpired };
  if (candidatesForSelection.length === 1) return { row: candidatesForSelection[0].row, ambiguous: false, excludedFutureOrExpired };
  const amounts = new Set(candidatesForSelection.map(({ row }) => String(marketRentAmount(row) ?? "")));
  if (amounts.size > 1) return { ambiguous: true, excludedFutureOrExpired };
  const sorted = [...candidatesForSelection].sort((left, right) => `${right.start ?? ""}|${text(right.row, "MarketRentID", "RentID", "sourceId") ?? ""}`.localeCompare(`${left.start ?? ""}|${text(left.row, "MarketRentID", "RentID", "sourceId") ?? ""}`));
  return { row: sorted[0].row, ambiguous: false, excludedFutureOrExpired };
}

function leaseDate(record: Raw): string {
  return text(record, "MoveInDate", "StartDate", "ContractStartOn", "ArrivalDate") ?? "";
}

function dateKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const isoDate = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed)?.[1];
  if (isoDate) return isoDate;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? trimmed : new Date(parsed).toISOString().slice(0, 10);
}

function leaseEndDate(record: Raw): string | undefined {
  return text(record, "MoveOutDate", "MoveOut", "ContractEndDate", "LeaseEndDate", "EndDate", "DepartureDate", "ExpectedMoveOutDate", "ExpectedMoveOut");
}

function chooseLeaseFor(leases: readonly Raw[], tenantId?: string, unitId?: string, asOf?: string): { row?: Raw; ambiguous: boolean } {
  const asOfKey = dateKey(asOf);
  const candidates = leases.filter((lease) => {
    const leaseTenant = text(lease, "TenantID", "tenantId");
    const leaseUnit = text(lease, "UnitID", "unitId");
    if (tenantId && leaseTenant && leaseTenant !== tenantId) return false;
    if (unitId && leaseUnit && leaseUnit !== unitId) return false;
    if (!asOfKey) return true;
    const start = dateKey(leaseDate(lease));
    const end = dateKey(leaseEndDate(lease));
    if (start && start > asOfKey) return false;
    if (end && end < asOfKey) return false;
    return true;
  }).sort((left, right) => `${dateKey(leaseDate(right)) ?? ""}|${text(right, "LeaseID", "leaseId") ?? ""}`.localeCompare(`${dateKey(leaseDate(left)) ?? ""}|${text(left, "LeaseID", "leaseId") ?? ""}`));
  if (candidates.length === 1) return { row: candidates[0], ambiguous: false };
  if (candidates.length > 1) return { ambiguous: true };
  return { ambiguous: false };
}

function normalizeProperty(record: Raw, exceptions: NormalizationException[]): Raw {
  const normalized = augment(record, ["PropertyID"], {
    name: ["PropertyName", "Name"],
    address: ["AddressLine1", "Street"],
    addressLine1: ["AddressLine1", "Street"],
    addressLine2: ["AddressLine2"],
    city: ["City"],
    state: ["State"],
    postalCode: ["PostalCode", "Zip", "ZipCode"],
    archived: ["IsArchived", "Archived"],
  }, undefined, "property");
  const address = value(record, "Address", "PropertyAddress");
  const addressObject = address && typeof address === "object" && !Array.isArray(address) ? address as Record<string, unknown> : undefined;
  const embeddedAddresses = value(record, "Addresses");
  const addressSelection = !addressObject && Array.isArray(embeddedAddresses) ? selectPropertyAddress(embeddedAddresses) : undefined;
  if (addressSelection?.ambiguous) addException(exceptions, "incomplete_coverage", "properties", normalized, "property_multiple_eligible_addresses_ambiguous", "ambiguous");
  const selected = addressObject ?? addressSelection?.row;
  if (selected) {
    // The collector intentionally does not alias Addresses[0].  Assign the
    // selected row directly so a stale compatibility alias from an older
    // archive cannot override an explicit primary/type/role selection.
    normalized.addressLine1 = selected.Line1 ?? selected.AddressLine1 ?? selected.Address ?? selected.Street ?? normalized.addressLine1;
    normalized.addressLine2 = selected.Line2 ?? selected.AddressLine2 ?? normalized.addressLine2;
    normalized.city = selected.City ?? normalized.city;
    normalized.state = selected.State ?? normalized.state;
    normalized.postalCode = selected.PostalCode ?? selected.Zip ?? selected.ZipCode ?? normalized.postalCode;
    normalized.address = normalized.addressLine1;
  } else if (addressSelection?.ambiguous && !addressObject) {
    // Multiple eligible rows are not a usable address fact.  Clear only the
    // derived aliases; the original Addresses array remains restricted raw
    // evidence for audit/reconciliation.
    delete normalized.address;
    delete normalized.addressLine1;
    delete normalized.addressLine2;
    delete normalized.city;
    delete normalized.state;
    delete normalized.postalCode;
  }
  if (!text(normalized, "addressLine1") || !text(normalized, "city") || !text(normalized, "state") || !text(normalized, "postalCode")) {
    const sourceRows = Array.isArray(embeddedAddresses) ? embeddedAddresses : [];
    // RM can return the address relationship with explicit Primary/Billing
    // rows whose address fields are all empty. This is verified source-empty,
    // not a failed join; retain the raw rows and surface a non-blocking fact.
    if (addressSelection?.sourceEmpty || (sourceRows.length > 0 && sourceRows.every((row) => !addressHasData(row)))) {
      normalized.addressSourceStatus = "source_empty";
      normalized.addressSourceEmpty = true;
      addException(exceptions, "source_empty", "properties", normalized, "property_embedded_addresses_source_empty", "confirmed");
    } else {
      addException(exceptions, "incomplete_coverage", "properties", normalized, "property_address_fields_not_returned_by_rm", "unresolved");
    }
  }
  return normalized;
}

function normalizeUnit(record: Raw, properties: Map<string, Raw>, unitTypes: Map<string, Raw>, exceptions: NormalizationException[], asOfDate?: string): Raw {
  const normalized = augment(record, ["UnitID"], {
    propertyId: ["PropertyID"],
    unitNumber: ["UnitNumber", "Name", "Unit"],
    unitTypeId: ["UnitTypeID"],
    marketRent: ["MarketRent", "Rent"],
    marketRentCents: ["MarketRentCents"],
    bathrooms: ["Bathrooms"],
    squareFeet: ["SquareFootage"],
  }, undefined, "unit");
  const unitTypeValue = value(record, "UnitType");
  const unitType = Array.isArray(unitTypeValue) && unitTypeValue.length === 1 ? unitTypeValue[0] : unitTypeValue;
  let hasEmbeddedUnitType = false;
  if (unitType && typeof unitType === "object" && !Array.isArray(unitType)) {
    hasEmbeddedUnitType = true;
    const embedded = unitType as Record<string, unknown>;
    normalized.unitType ??= embedded.Name ?? embedded.Description ?? embedded.UnitTypeName;
    normalized.unitTypeId ??= embedded.UnitTypeID;
    normalized.bathrooms ??= embedded.Bathrooms;
  }
  const marketRentValue = value(record, "MarketRent");
  const marketRentRows = Array.isArray(marketRentValue)
    ? marketRentValue.filter((candidate): candidate is Raw => Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate))
    : marketRentValue && typeof marketRentValue === "object" ? [marketRentValue as Raw] : [];
  if (marketRentValue !== null && typeof marketRentValue === "object") {
    // Empty embeds also mean unknown, never a numeric zero.
    // `normalizeRmRecord` used to copy an embedded row into marketRent before
    // this interval selector ran.  Keep an independently supplied scalar
    // field, but clear object/array-derived aliases so excluded rows cannot
    // become current rent by accident.
    const directRent = [record.marketRent, record.rent].find((candidate) => typeof candidate === "number" || typeof candidate === "string");
    const directRentCents = typeof record.marketRentCents === "number" || typeof record.marketRentCents === "string" ? record.marketRentCents : undefined;
    if (directRent === undefined) delete normalized.marketRent;
    else normalized.marketRent = directRent;
    if (directRentCents === undefined) delete normalized.marketRentCents;
    else normalized.marketRentCents = directRentCents;
  }
  const marketRentSelection = selectMarketRent(marketRentRows, asOfDate);
  const marketRentRecord = marketRentSelection.row;
  if (marketRentSelection.ambiguous) addException(exceptions, "incomplete_coverage", "units", normalized, "market_rent_effective_interval_ambiguous", "ambiguous");
  if (marketRentSelection.excludedFutureOrExpired) normalized.marketRentSelectionExcludedRows = true;
  if (marketRentRecord) {
    const embedded = marketRentRecord;
    normalized.marketRent = embedded.Amount ?? embedded.Rent ?? embedded.Value ?? normalized.marketRent;
    normalized.marketRentCents ??= embedded.AmountCents;
  }
  const amenities = value(record, "Amenities");
  if (Array.isArray(amenities)) {
    normalized.amenities ??= amenities.map((amenity) => {
      if (amenity && typeof amenity === "object" && !Array.isArray(amenity)) {
        const row = amenity as Record<string, unknown>;
        return row.Name ?? row.Description ?? row.AmenityName ?? row.AmenityID;
      }
      return amenity;
    }).filter((amenity): amenity is string | number => typeof amenity === "string" || typeof amenity === "number").map(String);
  }
  const propertyId = text(normalized, "propertyId");
  if (!propertyId || !properties.has(propertyId)) addException(exceptions, "missing_relationship", "units", normalized, "unit_property_not_resolved");
  const unitTypeId = text(normalized, "unitTypeId");
  if (unitTypeId && !unitTypes.has(unitTypeId) && !hasEmbeddedUnitType) addException(exceptions, "missing_relationship", "units", normalized, "unit_type_not_resolved");
  const lookupUnitType = unitTypeId ? unitTypes.get(unitTypeId) : undefined;
  if (lookupUnitType && normalized.unitType === undefined) normalized.unitType = text(lookupUnitType, "Name", "Description", "UnitTypeName");
  if (!text(normalized, "unitType")) addException(exceptions, "incomplete_coverage", "units", normalized, "unit_type_not_returned_or_joined", "unresolved");
  if (value(normalized, "marketRent", "marketRentCents") === undefined) addException(exceptions, "incomplete_coverage", "units", normalized, marketRentSelection.ambiguous ? "market_rent_effective_interval_ambiguous" : "market_rent_not_returned", marketRentSelection.ambiguous ? "ambiguous" : "unresolved");
  return normalized;
}

function normalizeTenant(record: Raw, contacts: readonly Raw[], phones: readonly Raw[], exceptions: NormalizationException[]): Raw {
  const normalized = augment(record, ["TenantID"], {
    name: ["FullName", "Name"],
    firstName: ["FirstName"],
    lastName: ["LastName"],
    status: ["Status", "TenantStatus"],
  }, undefined, "person");
  const embeddedContactRows = Array.isArray(record.Contacts)
    ? record.Contacts
    : record.Contacts && typeof record.Contacts === "object" ? [record.Contacts]
      : [];
  const primaryContactValue = record.PrimaryContact;
  const embeddedPrimary = primaryContactValue && typeof primaryContactValue === "object" && !Array.isArray(primaryContactValue)
    ? primaryContactValue as Raw
    : undefined;
  const embeddedContacts = [
    ...embeddedContactRows,
    ...(embeddedPrimary ? [embeddedPrimary] : []),
  ].filter((candidate): candidate is Raw => Boolean(candidate) && typeof candidate === "object") as Raw[];
  const embeddedPrimaryCandidates = embeddedPrimary
    ? [embeddedPrimary]
    : embeddedContacts.filter((candidate) => booleanValue(candidate, "IsPrimary", "Primary", "IsPrimaryContact"));
  const directEmbeddedContact = embeddedPrimaryCandidates.length === 1 ? embeddedPrimaryCandidates[0] : undefined;
  const contactSource = [...contacts, ...embeddedContacts];
  const embeddedPhones = embeddedContacts.flatMap((candidate) => Array.isArray(candidate.PhoneNumbers) ? candidate.PhoneNumbers : []).filter((candidate): candidate is Raw => Boolean(candidate) && typeof candidate === "object") as Raw[];
  const phoneSource = [...phones, ...embeddedPhones];
  const selectedContact = directEmbeddedContact ?? explicitTenantContact(normalized, contactSource);
  const selectedContactId = selectedContact ? id(selectedContact, ["ContactID"]) : undefined;
  const contactRows = selectedContactId
    ? contactSource.filter((candidate) => id(candidate, ["ContactID"]) === selectedContactId)
    : [];
  const contact = selectedContact
    ? contactRows.reduce((merged, candidate) => ({ ...merged, ...candidate }), {} as Raw)
    : undefined;
  const tenantSourceId = id(normalized, ["TenantID", "sourceId"]);
  const relatedContacts = contactSource.filter((candidate) => {
    const parent = id(candidate, ["TenantID", "ParentID", "EntityKeyID"]);
    return Boolean(parent && tenantSourceId && parent === tenantSourceId);
  });
  const methods = relatedContacts.flatMap((candidate) => {
    const contactId = id(candidate, ["ContactID"]);
    const embedded = Array.isArray(candidate.PhoneNumbers) ? candidate.PhoneNumbers : [];
    const linked = contactId ? phoneSource.filter((phone) => id(phone, ["ContactID", "ParentID"]) === contactId) : [];
    return [...embedded, ...linked];
  }).filter((candidate): candidate is Raw => Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate)).map((candidate) => ({
    id: id(candidate, ["PhoneNumberID", "PhoneID", "sourceId"]),
    value: value(candidate, "Number", "PhoneNumber", "Phone"),
    type: value(candidate, "PhoneType", "PhoneTypeName", "Type", "PhoneNumberTypeID"),
    isPrimary: booleanValue(candidate, "IsPrimary", "Primary", "IsPrimaryPhone"),
    isTextReady: booleanValue(candidate, "IsTextReady", "TextReady", "CanText"),
  })).filter((candidate) => typeof candidate.value === "string" || typeof candidate.value === "number");
  if (methods.length > 0) normalized.phoneMethods = methods;
  if (!contact) addException(exceptions, "missing_relationship", "tenants", normalized, "primary_contact_not_resolved");
  else {
    const contactId = id(contact, ["ContactID"]);
    if (contactId) normalized.contactId = contactId;
    normalized.email ??= value(contact, "Email", "EmailAddress");
    const directContactPhones = Array.isArray(contact.PhoneNumbers)
      ? contact.PhoneNumbers.filter((candidate): candidate is Raw => Boolean(candidate) && typeof candidate === "object") as Raw[]
      : [];
    const phone = explicitPhone(contact, phoneSource) ?? selectPhone(directContactPhones);
    if (phone) normalized.phone ??= value(phone, "Number", "PhoneNumber", "Phone");
    else addException(exceptions, "missing_relationship", "tenants", normalized, "primary_contact_phone_not_resolved");
  }
  return normalized;
}

function exactTenantPartitionStatus(
  record: Raw,
  tenant: Raw | undefined,
  crosswalk: RentManagerFinancialSemanticCrosswalk | undefined,
  artifactSha256: string | undefined,
): "future" | "current" | "past" | "notice" | "cancelled" | undefined {
  if (!crosswalk || !artifactSha256) return undefined;
  const candidates: Array<{ sourceCollection: string; partition: unknown }> = [];
  const addCandidate = (source: Raw | undefined): void => {
    if (!source) return;
    const sourceCollection = text(source, "sourceCollection", "SourceCollection");
    if (!sourceCollection || !/^tenants\.(?:current|future|former)$/i.test(sourceCollection)) return;
    const partition = value(source, "$partition", "partition", "sourcePartition") ?? sourceCollection.split(".").at(-1);
    if (partition !== undefined) candidates.push({ sourceCollection, partition });
  };
  // The tenant partition is the authoritative source for a lease's generic
  // MoveInDate. A lease row may also carry the same request provenance (some
  // exports attach sourceCollection directly to the child row); use it only
  // when it is itself an exact tenant-partition collection.
  addCandidate(tenant);
  addCandidate(record);
  const statuses = candidates
    .map(({ sourceCollection, partition }) => financialSemanticCrosswalkValue(crosswalk, {
      artifactSha256,
      sourceCollection,
      sourceField: "$partition",
      semanticKind: "tenancy_status",
      rawValue: partition,
    }))
    .filter((status): status is "future" | "current" | "past" | "notice" | "cancelled" => status === "future" || status === "current" || status === "past" || status === "notice" || status === "cancelled");
  const directTenantStatus = tenant && financialSemanticCrosswalkValue(crosswalk, {
    artifactSha256, sourceCollection: "tenants", sourceField: "Status", semanticKind: "tenancy_status", rawValue: value(tenant, "Status"),
  });
  if (directTenantStatus === "current" || directTenantStatus === "future" || directTenantStatus === "past" || directTenantStatus === "notice" || directTenantStatus === "cancelled") statuses.push(directTenantStatus);
  const unique = new Set(statuses);
  return unique.size === 1 ? statuses[0] : undefined;
}

function normalizeLease(
  record: Raw,
  properties: Map<string, Raw>,
  units: Map<string, Raw>,
  tenants: Map<string, Raw>,
  exceptions: NormalizationException[],
  financialCrosswalk?: RentManagerFinancialSemanticCrosswalk,
  artifactSha256?: string,
  artifactObservationOn?: string,
): Raw {
  const normalized = augment(record, ["LeaseID"], {
    tenantId: ["TenantID"],
    personId: ["TenantID"],
    propertyId: ["PropertyID"],
    unitId: ["UnitID"],
    tenancyId: ["LeaseID"],
    status: ["Status", "TenantStatus"],
    actualMoveInOn: ["ActualMoveInOn", "ActualMoveIn"],
    plannedMoveInOn: ["PlannedMoveInOn", "PlannedMoveIn", "DesiredMoveInOn", "RequestedMoveInOn"],
    actualMoveOutOn: ["MoveOutDate", "MoveOut"],
    expectedMoveOutOn: ["DepartureDate", "ExpectedMoveOutDate", "ExpectedMoveOut"],
    createdAt: ["CreatedAt", "CreatedDate", "CreateDate"],
    updatedAt: ["UpdatedAt", "UpdateDate", "ModifiedDate"],
  }, undefined, "tenancy");
  // A generic source MoveOutDate after the sealed observation is scheduled,
  // not a completed departure. Bind this decision to that observation forever;
  // replaying the archive after the date passes must not manufacture an event.
  const observedOn = dateKey(artifactObservationOn);
  const genericMoveOut = dateKey(text(record, "MoveOutDate", "MoveOut"));
  if (observedOn && genericMoveOut && genericMoveOut > observedOn && record.actualMoveOutOn === undefined) {
    delete normalized.actualMoveOutOn;
    normalized.expectedMoveOutOn ??= value(record, "MoveOutDate", "MoveOut");
  }
  // RM embeds can carry explicit relationship objects instead of scalar IDs.
  // Reading their documented IDs is deterministic; selecting by name or array
  // position is intentionally not supported.
  normalized.tenantId ??= embeddedId(record, ["Tenant", "TenantAccount"], ["TenantID", "TenantId", "ID", "Id"]);
  normalized.personId ??= normalized.tenantId;
  normalized.propertyId ??= embeddedId(record, ["Property"], ["PropertyID", "PropertyId", "ID", "Id"]);
  normalized.unitId ??= embeddedId(record, ["Unit"], ["UnitID", "UnitId", "ID", "Id"]);
  const tenantId = text(normalized, "tenantId", "TenantID");
  const tenant = tenantId ? tenants.get(tenantId) : undefined;
  // A move-out date is not proof of a Rent Manager status, and tenant status
  // is not a tenancy status unless RM returned it on the lease row itself.
  // Preserve absence so the v3 mapper can carry an explicit unknown.
  if (normalized.status === undefined && tenant && value(record, "Status", "TenantStatus") !== undefined) normalized.status = value(tenant, "Status", "TenantStatus");
  const statusText = text(normalized, "status", "Status", "TenantStatus")?.toLowerCase();
  const moveInSource = value(record, "MoveInDate", "MoveIn");
  if (moveInSource !== undefined && normalized.plannedMoveInOn === undefined && normalized.actualMoveInOn === undefined) {
    if (artifactSha256) {
      const exactStatus = exactTenantPartitionStatus(normalized, tenant, financialCrosswalk, artifactSha256);
      if (exactStatus === "future") normalized.plannedMoveInOn = moveInSource;
      else if (exactStatus === "current" || exactStatus === "past" || exactStatus === "notice" || exactStatus === "cancelled") normalized.actualMoveInOn = moveInSource;
      else addException(exceptions, "incomplete_coverage", "leases", normalized, "move_in_date_status_not_explicit", "unresolved");
    } else if (/future|prelease|pending/.test(statusText ?? "")) normalized.plannedMoveInOn ??= moveInSource;
    else if (/current|active|occupied|past|former|ended|notice/.test(statusText ?? "")) normalized.actualMoveInOn ??= moveInSource;
    else addException(exceptions, "incomplete_coverage", "leases", normalized, "move_in_date_status_not_explicit", "unresolved");
  }
  for (const [field, index, message] of [["propertyId", properties, "lease_property_not_resolved"], ["unitId", units, "lease_unit_not_resolved"], ["tenantId", tenants, "lease_tenant_not_resolved"]] as const) {
    const linked = text(normalized, field);
    if (!linked || !index.has(linked)) addException(exceptions, "missing_relationship", "leases", normalized, field === "unitId" && !linked ? "lease_unit_not_returned" : message);
  }
  return normalized;
}

function normalizeRenewal(record: Raw, leases: Map<string, Raw>, exceptions: NormalizationException[]): Raw {
  const normalized = augment(record, ["LeaseRenewalID"], {
    leaseId: ["ParentLeaseID"],
    tenancyId: ["ParentLeaseID"],
    contractStartOn: ["StartDate"],
    contractEndOn: ["EndDate"],
    signedOn: ["SignedDate"],
    renewalOfId: ["RenewalOfID", "ParentRenewalID", "PreviousLeaseRenewalID"],
  }, undefined, "lease_term");
  const parent = text(normalized, "leaseId");
  if (!parent || !leases.has(parent)) addException(exceptions, "missing_relationship", "leaseRenewals", normalized, "renewal_parent_lease_not_resolved");
  return normalized;
}

function normalizeLedger(record: Raw, collection: string, tenants: Map<string, Raw>, leases: Map<string, Raw>, exceptions: NormalizationException[]): Raw {
  const normalized = augment(record, [collection === "charges" ? "ChargeID" : collection === "payments" ? "PaymentID" : "CreditID"], {
    tenantId: ["TenantID", "AccountID", "EntityKeyID", "EntityKeyId", "TenantKeyID", "TenantKeyId", "CustomerID", "CustomerId", "CustomerAccountID", "CustomerAccountId", "CustomerKeyID", "CustomerKeyId", "CustomerEntityKeyID", "CustomerEntityKeyId"],
    propertyId: ["PropertyID", "PropertyId"],
    unitId: ["UnitID", "UnitId"],
    leaseId: ["LeaseID", "LeaseId", "TenancyID", "TenancyId"],
    amount: ["Amount", "TransactionAmount", "ChargeAmount", "PaymentAmount", "CreditAmount", "AmountDue"],
    transactionDate: ["TransactionDate", "Date", "PostedDate", "ChargeDate", "PaymentDate", "CreditDate", "ReceivedDate"],
    chargeTypeId: ["ChargeTypeID", "ChargeTypeId", "ChargeCodeID", "ChargeCodeId", "TypeID", "TypeId"],
    paymentMethod: ["PaymentMethod", "PaymentMethodName", "PaymentType", "PaymentTypeName"],
  }, collection === "charges" ? "charge" : collection === "payments" ? "payment" : "credit", "ledger_transaction");
  normalized.tenantId ??= embeddedId(record, ["Tenant", "TenantAccount", "Account", "Customer", "CustomerAccount"], ["TenantID", "TenantId", "AccountID", "AccountId", "CustomerID", "CustomerId", "CustomerAccountID", "CustomerAccountId", "ID", "Id"]);
  normalized.propertyId ??= embeddedId(record, ["Property"], ["PropertyID", "PropertyId", "ID", "Id"]);
  normalized.unitId ??= embeddedId(record, ["Unit"], ["UnitID", "UnitId", "ID", "Id"]);
  normalized.leaseId ??= embeddedId(record, ["Lease", "Tenancy"], ["LeaseID", "LeaseId", "TenancyID", "TenancyId", "ID", "Id"]);
  normalized.postedOn ??= value(record, "PostedOn", "PostedDate", "ChargeDate", "PaymentDate", "CreditDate", "TransactionDate", "Date");
  normalized.dueOn ??= value(record, "DueOn", "DueDate");
  const tenantId = text(normalized, "tenantId");
  // A ledger row is still a valid money fact when RM omits its tenant/account
  // join. Keep the transaction with an unknown person/tenancy rather than
  // blocking it or manufacturing a relationship from a date/description.
  if (!tenantId || !tenants.has(tenantId)) addException(exceptions, "source_empty", collection, normalized, "account_tenant_not_returned_or_not_resolved", "unresolved");
  const leaseId = text(normalized, "leaseId");
  if (leaseId && !leases.has(leaseId)) addException(exceptions, "missing_relationship", collection, normalized, "lease_not_resolved");
  if (leaseId) {
    const explicitLease = leases.get(leaseId);
    if (explicitLease) {
      // LeaseID is direct source evidence. Filling its parent property/unit is
      // a deterministic lookup, not a lease-selection inference.
      normalized.propertyId ??= value(explicitLease, "PropertyID", "propertyId");
      normalized.unitId ??= value(explicitLease, "UnitID", "unitId");
    }
  }
  if (!leaseId && tenantId) {
    const joined = chooseLeaseFor(Array.from(leases.values()), tenantId, text(normalized, "unitId"), text(normalized, "TransactionDate", "Date"));
    // Even a unique tenant/date/unit candidate is not a source-confirmed
    // lease link. Do not copy its property/unit into the normalized fact;
    // only direct RM fields may establish those relationships.
    addException(
      exceptions,
      "source_empty",
      collection,
      normalized,
      joined.ambiguous ? "ledger_lease_join_ambiguous" : joined.row ? "ledger_lease_join_requires_verified_source" : "ledger_lease_not_returned_by_rm",
      "unresolved",
    );
  }
  return normalized;
}

function normalizeHistory(record: Raw, tenants: Map<string, Raw>, properties: Map<string, Raw>, units: Map<string, Raw>, exceptions: NormalizationException[]): Raw {
  const normalized = augment(record, ["HistoryID", "HistoryNoteID", "HistoryEmailID", "EmailSentItemID", "EmailChainID", "OutgoingTextID", "IncomingTextID", "TextID", "ConversationID"], {
    occurredAt: ["OccurredAt", "Date", "HistoryDate"],
    summary: ["Subject", "Summary", "Description"],
    detail: ["Body", "Notes", "Description"],
  }, undefined, "activity");
  const sourceCollection = text(normalized, "sourceCollection") ?? "";
  const requestTenantParent = /^tenantHistory\.(?:current|future|former)$/i.test(sourceCollection)
    ? text(normalized, "_parentSourceId", "parentSourceId")
    : undefined;
  // Collector normalization adds camelCase aliases to the untouched RM row.
  // Read both forms; otherwise global activity rows appear parentless even
  // though RM returned an explicit ParentID/ParentType.
  const parentId = text(normalized, "ParentID", "ParentId", "parentId", "EntityKeyID", "EntityKeyId", "entityKeyId", "tenantId", "propertyId", "unitId", "parentSourceId", "_parentSourceId");
  const parentType = text(normalized, "ParentType", "parentType", "EntityType") ?? (text(normalized, "tenantId") ? "Tenant" : undefined);
  if (requestTenantParent) {
    // The per-parent GET path is verified source evidence even when RM omits
    // ParentType/ParentID or labels a small set of rows EntityType=Prospect.
    // Keep that RM subject label separately; it must not override the request
    // parent that identifies the tenant history collection.
    normalized.tenantId = requestTenantParent;
    normalized.verifiedParentType = "Tenant";
    normalized.verifiedParentSource = "tenant_history_request_parent";
    if (parentType) normalized.rmSubjectType = parentType;
    if (!tenants.has(requestTenantParent)) addException(exceptions, "missing_relationship", "histories", normalized, "history_request_parent_tenant_not_resolved");
    return normalized;
  }
  if (!parentId || !parentType) addException(exceptions, "source_empty", "histories", normalized, "history_parent_not_returned_by_rm", "unresolved");
  else if (/tenant|customer/i.test(parentType)) normalized.tenantId = parentId;
  else if (/property/i.test(parentType)) normalized.propertyId = parentId;
  else if (/unit/i.test(parentType)) normalized.unitId = parentId;
  else addException(exceptions, "source_empty", "histories", normalized, "history_parent_type_not_recognized", "unresolved");
  return normalized;
}

function normalizeContractTerm(record: Raw, leases: Map<string, Raw>, exceptions: NormalizationException[]): Raw {
  const normalized = augment(record, ["LeaseID"], {
    tenancyId: ["LeaseID"],
    leaseId: ["LeaseID"],
    contractStartOn: ["ContractStartDate", "LeaseStartDate", "StartDate"],
    contractEndOn: ["ContractEndDate", "LeaseEndDate", "EndDate"],
    signedOn: ["SignedDate", "ExecutedDate"],
    monthToMonth: ["MonthToMonth", "IsMonthToMonth"],
  }, undefined, "lease_term");
  const leaseId = text(normalized, "leaseId", "LeaseID");
  if (!leaseId || !leases.has(leaseId)) addException(exceptions, "missing_relationship", "leases", normalized, "contract_term_parent_lease_not_resolved");
  return normalized;
}

function relateToLease(
  normalized: Raw,
  collection: string,
  tenants: Map<string, Raw>,
  leases: readonly Raw[],
  exceptions: NormalizationException[],
): Raw {
  const tenantId = text(normalized, "tenantId", "TenantID", "AccountID", "EntityKeyID");
  if (!tenantId || !tenants.has(tenantId)) {
    addException(exceptions, "missing_relationship", collection, normalized, "tenant_not_resolved");
    return normalized;
  }
  normalized.tenantId ??= tenantId;
  const explicitLeaseId = text(normalized, "leaseId", "LeaseID", "tenancyId");
  if (explicitLeaseId) {
    const explicitLease = leases.find((lease) => text(lease, "LeaseID", "leaseId", "sourceId") === explicitLeaseId);
    if (explicitLease) {
      normalized.propertyId ??= value(explicitLease, "PropertyID", "propertyId");
      normalized.unitId ??= value(explicitLease, "UnitID", "unitId");
    }
    return normalized;
  }
  const joined = chooseLeaseFor(leases, tenantId, text(normalized, "unitId", "UnitID"), text(normalized, "transactionDate", "TransactionDate", "Date", "receivedOn", "StartDate"));
  // Tenant/date matching is review evidence only. It must not become a
  // tenancy, property, or unit link in the normalized import.
  addException(
    exceptions,
    "source_empty",
    collection,
    normalized,
    joined.ambiguous ? "tenant_lease_join_ambiguous" : joined.row ? "tenant_lease_join_requires_verified_source" : "tenant_lease_not_returned_by_rm",
    "unresolved",
  );
  return normalized;
}

function normalizeDeposit(record: Raw, tenants: Map<string, Raw>, leases: readonly Raw[], _charges: readonly Raw[], typeLookup: ReadonlyMap<string, string | undefined>, exceptions: NormalizationException[]): Raw {
  const normalized = augment(record, ["SecurityDepositSummaryID", "DepositID"], {
    tenantId: ["TenantID", "AccountID", "EntityKeyID", "parentSourceId", "ParentSourceID", "ParentID"],
    propertyId: ["PropertyID"],
    unitId: ["UnitID"],
    leaseId: ["LeaseID"],
    amount: ["Amount", "Balance", "HeldAmount", "SecurityDepositAmount"],
    receivedOn: ["ReceivedDate", "ReceivedOn"],
    type: ["DepositType", "Type", "Name"],
  }, undefined, "deposit");
  const inlineType = text(normalized, "type", "DepositType", "Type", "Name");
  const typeSourceId = text(normalized, "SecurityDepositTypeID", "SecurityDepositTypeId", "DepositTypeID", "DepositTypeId");
  if (!inlineType && typeSourceId) {
    if (!typeLookup.has(typeSourceId)) {
      addException(exceptions, "missing_relationship", "deposits", normalized, "deposit_type_lookup_not_returned", "unresolved");
    } else {
      const lookupType = typeLookup.get(typeSourceId);
      if (lookupType) normalized.type = lookupType;
      else addException(exceptions, "missing_relationship", "deposits", normalized, "deposit_type_lookup_ambiguous", "ambiguous");
    }
  }
  normalized.tenantId ??= embeddedId(record, ["Tenant", "TenantAccount"], ["TenantID", "TenantId", "AccountID", "AccountId", "ID", "Id"]);
  normalized.propertyId ??= embeddedId(record, ["Property"], ["PropertyID", "PropertyId", "ID", "Id"]);
  normalized.unitId ??= embeddedId(record, ["Unit"], ["UnitID", "UnitId", "ID", "Id"]);
  normalized.leaseId ??= embeddedId(record, ["Lease", "Tenancy"], ["LeaseID", "LeaseId", "ID", "Id"]);
  const tenantId = text(normalized, "tenantId", "TenantID", "AccountID");
  const leaseId = text(normalized, "leaseId", "LeaseID", "TenancyID", "TenancyId");
  const lease = leaseId ? leases.find((candidate) => text(candidate, "LeaseID", "leaseId", "sourceId") === leaseId) : undefined;
  if (tenantId && !tenants.has(tenantId)) addException(exceptions, "missing_relationship", "deposits", normalized, "deposit_tenant_not_resolved");
  if (leaseId && !lease) addException(exceptions, "missing_relationship", "deposits", normalized, "deposit_lease_not_resolved");
  if (lease) {
    const leaseTenantId = text(lease, "TenantID", "tenantId");
    const leasePropertyId = text(lease, "PropertyID", "propertyId");
    const leaseUnitId = text(lease, "UnitID", "unitId");
    if (tenantId && leaseTenantId && tenantId !== leaseTenantId) addException(exceptions, "missing_relationship", "deposits", normalized, "deposit_tenant_lease_mismatch", "ambiguous");
    if (text(normalized, "propertyId") && leasePropertyId && text(normalized, "propertyId") !== leasePropertyId) addException(exceptions, "missing_relationship", "deposits", normalized, "deposit_property_lease_mismatch", "ambiguous");
    if (text(normalized, "unitId") && leaseUnitId && text(normalized, "unitId") !== leaseUnitId) addException(exceptions, "missing_relationship", "deposits", normalized, "deposit_unit_lease_mismatch", "ambiguous");
    // Do not manufacture PropertyID or UnitID from a lease or move-in date.
    // A tenancy relationship may still be carried as exact evidence; the
    // target mapper decides whether that exact tenancy supplies a reportable
    // link.
  }
  if (!text(normalized, "receivedOn")) {
    normalized.receivedOnKnowledge = "unknown";
    addException(exceptions, "source_empty", "deposits", normalized, "deposit_received_on_not_returned_by_rm", "confirmed");
  } else {
    normalized.receivedOnKnowledge = "source";
  }
  normalized.unitLinkKnowledge = text(normalized, "unitId", "UnitID", "UnitId") ? "exact" : "unknown";
  if (!text(normalized, "propertyId")) addException(exceptions, "missing_relationship", "deposits", normalized, "deposit_property_not_resolved");
  if (!text(normalized, "unitId")) addException(exceptions, "source_empty", "deposits", normalized, "deposit_unit_id_not_returned_by_rm", "confirmed");
  return normalized;
}

type NormalizedHapStatus = HapContractStatus | HapPaymentStatus;

function hapStatusMatchesKind(valueToCheck: unknown, kind: "contract" | "payment"): valueToCheck is NormalizedHapStatus {
  if (typeof valueToCheck !== "string") return false;
  return kind === "contract"
    ? (HAP_CONTRACT_STATUS_VALUES as readonly string[]).includes(valueToCheck)
    : (HAP_PAYMENT_STATUS_VALUES as readonly string[]).includes(valueToCheck);
}

const HAP_CONTRACT_STATUS_VALUES = ["active", "ended", "pending", "exception"] as const;
const HAP_PAYMENT_STATUS_VALUES = ["received", "pending", "voided", "reversed"] as const;

/**
 * Normalize HAP statuses only through an artifact-bound exact crosswalk.
 * Case/whitespace normalization is the sole normalization step. In
 * particular, `inactive` does not match `active`, and a description is never
 * consulted. An absent/mismatched crosswalk leaves the status unknown.
 */
export function normalizeHapStatusValue(
  rawValue: unknown,
  kind: "contract" | "payment",
  crosswalks: readonly RentManagerHapStatusCrosswalk[] = [],
  artifactSha256?: string,
  sourceCollection?: RentManagerHapStatusCrosswalk["sourceCollection"],
  sourceField?: string,
): { value?: NormalizedHapStatus; knowledge: FactKnowledge } {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "" || !artifactSha256 || !sourceCollection || !sourceField) return { knowledge: "unknown" };
  const normalizedKey = String(rawValue).trim().toLowerCase();
  const candidates = crosswalks.filter((candidate) =>
    candidate.artifactSha256 === artifactSha256 &&
    candidate.sourceCollection === sourceCollection &&
    candidate.sourceField === sourceField,
  );
  // Crosswalk rows are selector objects, not an ordered list. A duplicate
  // selector is ambiguous even when the first two objects happen to match;
  // otherwise response order could silently change the operational status.
  if (candidates.length !== 1) return { knowledge: "unknown" };
  const crosswalk = candidates[0];
  const allowed = kind === "contract" ? HAP_CONTRACT_STATUS_VALUES : HAP_PAYMENT_STATUS_VALUES;
  if (Object.values(crosswalk.values).some((mapped) => !allowed.includes(mapped as never))) return { knowledge: "unknown" };
  const mapped = crosswalk?.values[normalizedKey] ?? crosswalk?.values[String(rawValue).trim()];
  return hapStatusMatchesKind(mapped, kind) ? { value: mapped, knowledge: "source" } : { knowledge: "unknown" };
}

function hapStatusField(record: Raw): { value?: unknown; field?: string } {
  // Prefer the original RM-cased field when a normalized row also carries a
  // canonical `status` alias. The exact crosswalk is bound to this source
  // field; the alias alone is not source evidence.
  for (const field of ["Status", "SubsidyStatus", "ContractStatus", "PaymentStatus", "status", "subsidyStatus", "contractStatus", "paymentStatus"]) {
    const candidate = value(record, field);
    if (candidate !== undefined) return { value: candidate, field };
  }
  return {};
}

function normalizeHapStatusOnRecord(
  normalized: Raw,
  record: Raw,
  kind: "contract" | "payment",
  collection: RentManagerHapStatusCrosswalk["sourceCollection"],
  crosswalks: readonly RentManagerHapStatusCrosswalk[],
  artifactSha256: string | undefined,
  exceptions: NormalizationException[],
): void {
  const statusField = hapStatusField(record);
  const result = normalizeHapStatusValue(statusField.value, kind, crosswalks, artifactSha256, collection, statusField.field);
  if (result.value) normalized.status = result.value;
  normalized.statusKnowledge = result.knowledge;
  if (statusField.value !== undefined && !result.value) {
    addException(exceptions, "incomplete_coverage", collection === "Subsidies" ? "subsidies" : collection === "SubsidyTenants" ? "subsidyTenants" : "subsidyPayments", record, "hap_status_unknown_exact_crosswalk_required", "unresolved");
  }
}

function normalizeSubsidy(
  record: Raw,
  tenants: Map<string, Raw>,
  leases: readonly Raw[],
  exceptions: NormalizationException[],
  crosswalks: readonly RentManagerHapStatusCrosswalk[] = [],
  artifactSha256?: string,
): Raw {
  const normalized = augment(record, ["SubsidyID", "SubsidyTenantID", "SubsidyPaymentID"], {
    tenantId: ["TenantID", "AccountID", "EntityKeyID"],
    propertyId: ["PropertyID"],
    unitId: ["UnitID"],
    agencyName: ["AgencyName", "Agency", "HousingAuthority"],
    agencyObligationCents: ["AgencyObligationCents", "AgencyAmountCents", "AgencyAmount"],
    tenantObligationCents: ["TenantObligationCents", "TenantAmountCents", "TenantAmount"],
    effectiveFrom: ["EffectiveFrom", "StartDate", "BeginDate"],
    effectiveTo: ["EffectiveTo", "EndDate", "ExpireDate"],
  }, undefined, "subsidy");
  normalized.tenantId ??= embeddedId(record, ["Tenant", "TenantAccount"], ["TenantID", "TenantId", "AccountID", "AccountId", "ID", "Id"]);
  normalized.propertyId ??= embeddedId(record, ["Property"], ["PropertyID", "PropertyId", "ID", "Id"]);
  normalized.unitId ??= embeddedId(record, ["Unit"], ["UnitID", "UnitId", "ID", "Id"]);
  normalized.leaseId ??= embeddedId(record, ["Lease", "Tenancy"], ["LeaseID", "LeaseId", "ID", "Id"]);
  normalizeHapStatusOnRecord(normalized, record, "contract", "Subsidies", crosswalks, artifactSha256, exceptions);
  return relateToLease(normalized, "subsidies", tenants, leases, exceptions);
}

function normalizeSubsidyTenant(
  record: Raw,
  crosswalks: readonly RentManagerHapStatusCrosswalk[],
  artifactSha256: string | undefined,
  exceptions: NormalizationException[],
): Raw {
  const normalized = augment(record, ["SubsidyTenantID", "SubsidyTenantId", "ID", "Id"], {
    subsidyContractSourceId: ["SubsidyID", "SubsidyId", "SubsidyContractID", "SubsidyContractId"],
    tenantId: ["TenantID", "TenantId", "AccountID", "AccountId"],
    tenancyId: ["TenancyID", "TenancyId", "LeaseID", "LeaseId"],
    personId: ["PersonID", "PersonId"],
    propertyId: ["PropertyID", "PropertyId"],
    unitId: ["UnitID", "UnitId"],
    effectiveFrom: ["EffectiveFrom", "StartDate", "BeginDate"],
    effectiveTo: ["EffectiveTo", "EndDate", "ExpireDate"],
    amountCents: ["AmountCents", "Amount", "TenantAmount", "TenantAmountCents"],
    payer: ["Payer", "PayerType", "PayerCategory"],
  }, "subsidy_tenant", "subsidy_tenant");
  normalized.sourceCollection = "SubsidyTenants";
  normalizeHapStatusOnRecord(normalized, record, "contract", "SubsidyTenants", crosswalks, artifactSha256, exceptions);
  return normalized;
}

function normalizeSubsidyPayment(
  record: Raw,
  crosswalks: readonly RentManagerHapStatusCrosswalk[],
  artifactSha256: string | undefined,
  exceptions: NormalizationException[],
): Raw {
  const normalized = augment(record, ["SubsidyPaymentID", "SubsidyPaymentId", "ID", "Id"], {
    subsidyContractSourceId: ["SubsidyID", "SubsidyId", "SubsidyContractID", "SubsidyContractId"],
    subsidyTenantSourceId: ["SubsidyTenantID", "SubsidyTenantId"],
    tenancyId: ["TenancyID", "TenancyId", "LeaseID", "LeaseId"],
    personId: ["PersonID", "PersonId", "TenantID", "TenantId", "AccountID", "AccountId"],
    propertyId: ["PropertyID", "PropertyId"],
    unitId: ["UnitID", "UnitId"],
    paymentSourceId: ["PaymentID", "PaymentId", "PaymentTransactionID", "PaymentTransactionId"],
    paymentOn: ["PaymentOn", "PaymentDate", "PaidOn", "TransactionDate", "Date"],
    amountCents: ["AmountCents", "Amount", "PaymentAmount", "PaymentAmountCents"],
    payer: ["Payer", "PayerType", "PayerCategory"],
  }, "subsidy_payment", "subsidy_payment");
  normalized.sourceCollection = "SubsidyPayments";
  normalizeHapStatusOnRecord(normalized, record, "payment", "SubsidyPayments", crosswalks, artifactSha256, exceptions);
  return normalized;
}

function normalizeActivity(record: Raw, tenants: Map<string, Raw>, properties: Map<string, Raw>, units: Map<string, Raw>, leases: Map<string, Raw>, exceptions: NormalizationException[]): Raw {
  const normalized = normalizeHistory(record, tenants, properties, units, exceptions);
  const parentType = text(normalized, "ParentType", "parentType", "EntityType");
  const parentId = text(normalized, "ParentID", "parentId", "EntityKeyID", "EntityKeyId");
  if (parentId && parentType && /lease|tenancy/i.test(parentType)) {
    if (leases.has(parentId)) normalized.leaseId = parentId;
    else addException(exceptions, "missing_relationship", "communications", normalized, "activity_lease_parent_not_resolved");
  }
  return normalized;
}

function numericAnswer(valueToCheck: unknown): number | undefined {
  if (typeof valueToCheck === "number") return Number.isFinite(valueToCheck) ? valueToCheck : undefined;
  if (typeof valueToCheck === "string" && /^-?\d+(?:\.\d+)?$/.test(valueToCheck.trim())) {
    const parsed = Number(valueToCheck.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function booleanAnswer(valueToCheck: unknown): boolean | undefined {
  if (typeof valueToCheck === "boolean") return valueToCheck;
  if (typeof valueToCheck === "number" && (valueToCheck === 0 || valueToCheck === 1)) return valueToCheck === 1;
  if (typeof valueToCheck === "string") {
    if (/^(true|yes|y|1)$/i.test(valueToCheck.trim())) return true;
    if (/^(false|no|n|0)$/i.test(valueToCheck.trim())) return false;
  }
  return undefined;
}

function objectAnswer(valueToCheck: unknown): Record<string, unknown> | unknown[] | undefined {
  if (Array.isArray(valueToCheck)) return structuredClone(valueToCheck);
  if (valueToCheck && typeof valueToCheck === "object") return structuredClone(valueToCheck) as Record<string, unknown>;
  if (typeof valueToCheck === "string") {
    try {
      const parsed = JSON.parse(valueToCheck) as unknown;
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> | unknown[] : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function answerApplicationId(record: Raw): string | undefined {
  return text(record, "applicationId", "ApplicationID", "ApplicationId", "ProspectApplicationID", "ProspectApplicationId", "ApplicationSourceID", "ApplicationSourceId", "ParentID");
}

function sourceIdVariants(record: Raw, fields: string[]): string[] {
  const candidates = [text(record, ...fields), text(record, "sourceId", "id", "ID", "Id")].filter((candidate): candidate is string => Boolean(candidate));
  const variants = new Set<string>();
  for (const candidate of candidates) {
    variants.add(candidate);
    variants.add(candidate.replace(/^[a-z_]+:/i, ""));
  }
  return Array.from(variants);
}

function answerFieldPath(record: Raw): string | undefined {
  const raw = text(record, "targetField", "TargetField", "fieldPath", "FieldPath", "applicationField", "ApplicationField", "fieldKey", "FieldKey", "fieldName", "FieldName", "QuestionKey", "QuestionName", "Key", "Name", "Label");
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const aliases: Record<string, string> = {
    email: "email",
    email_address: "email",
    applicant_email: "email",
    first_name: "firstName",
    applicant_first_name: "firstName",
    last_name: "lastName",
    applicant_last_name: "lastName",
    phone: "phone",
    phone_number: "phone",
    applicant_phone: "phone",
    current_address: "rentalHistory.currentAddress",
    prior_address: "rentalHistory.priorAddress",
    previous_address: "rentalHistory.priorAddress",
    landlord_name: "rentalHistory.landlordName",
    landlord_contact: "rentalHistory.landlordContact",
    reason_for_moving: "rentalHistory.reasonForMoving",
    employer_name: "employment.employerName",
    employer: "employment.employerName",
    job_title: "employment.jobTitle",
    monthly_income_cents: "employment.monthlyIncomeCents",
    employment_start_date: "employment.employmentStartOn",
    employment_start_on: "employment.employmentStartOn",
    adults: "householdSummary.adults",
    household_adults: "householdSummary.adults",
    children: "householdSummary.children",
    household_children: "householdSummary.children",
    total_occupants: "householdSummary.totalOccupants",
    occupants: "householdSummary.totalOccupants",
    desired_move_in: "preferences.desiredMoveInOn",
    desired_move_in_on: "preferences.desiredMoveInOn",
    desired_lease_months: "preferences.desiredLeaseMonths",
    max_rent_cents: "preferences.maxRentCents",
    bedrooms: "preferences.bedrooms",
    has_voucher: "voucher.hasVoucher",
    voucher_agency: "voucher.agencyName",
    voucher_agency_name: "voucher.agencyName",
    voucher_case_number: "voucher.caseNumber",
    voucher_tenant_portion_cents: "voucher.tenantPortionCents",
    pets: "pets",
    vehicles: "vehicles",
    emergency_contact: "emergencyContact",
  };
  return aliases[key] ?? (Object.values(aliases).includes(raw) ? raw : undefined);
}

function answerValue(record: Raw): unknown {
  return value(record, "answer", "Answer", "ApplicationValue", "response", "Response", "responseValue", "ResponseValue", "value", "Value", "text", "Text");
}

function canonicalAnswerEvidence(valueToCanonicalize: unknown): unknown {
  if (Array.isArray(valueToCanonicalize)) return valueToCanonicalize.map(canonicalAnswerEvidence);
  if (valueToCanonicalize && typeof valueToCanonicalize === "object") {
    const source = valueToCanonicalize as Record<string, unknown>;
    return Object.fromEntries(Object.entries(source)
      .filter(([key]) => !["attestation", "answerAttestation", "evidenceAttestation"].includes(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalAnswerEvidence(child)]));
  }
  return valueToCanonicalize;
}

/** Hashes the immutable answer-row evidence, excluding its attestation block. */
export function applicationAnswerEvidenceHash(record: RentManagerRawRecord): string {
  return createHash("sha256").update(JSON.stringify(canonicalAnswerEvidence(record))).digest("hex");
}

export type ApplicationAnswerAttestationType = "restricted_supplement" | "artifact";

export function createApplicationAnswerAttestation(
  record: RentManagerRawRecord,
  sourceRunId: string,
  type: ApplicationAnswerAttestationType = "restricted_supplement",
): { type: ApplicationAnswerAttestationType; rowHash: string; sourceRunId: string; immutableEvidence: true } {
  if (!sourceRunId.trim()) throw new Error("application_answer_source_run_required");
  return { type, rowHash: applicationAnswerEvidenceHash(record), sourceRunId, immutableEvidence: true };
}

/**
 * Verifies the non-secret envelope/row shape emitted by the restricted
 * supplement builder.  This intentionally checks only stable provenance
 * markers; the supplement builder remains the authority for the underlying
 * evidence package and source hash.
 */
export function approvedSupplementEvidenceValid(
  payload: ExportPayload,
  evidence: unknown,
  sourceRunId: string,
): boolean {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
  const envelopeEvidence = evidence as Record<string, unknown>;
  if (envelopeEvidence.version !== "rm-restricted-supplement/v1" || envelopeEvidence.sourceRunId !== sourceRunId) return false;
  if (typeof envelopeEvidence.supplementSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(envelopeEvidence.supplementSha256)) return false;
  if (typeof envelopeEvidence.attestationSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(envelopeEvidence.attestationSha256)) return false;
  const kinds = Array.isArray(envelopeEvidence.kinds) ? envelopeEvidence.kinds.filter((kind): kind is string => typeof kind === "string") : [];
  if (!Array.isArray(envelopeEvidence.kinds) || kinds.length !== envelopeEvidence.kinds.length) return false;
  const rows = payload.applicationAnswerRecords ?? [];
  const rowHashes = Array.isArray(envelopeEvidence.rowHashes) ? envelopeEvidence.rowHashes.filter((hash): hash is string => typeof hash === "string" && /^[a-f0-9]{64}$/i.test(hash)).sort() : [];
  if (!Array.isArray(envelopeEvidence.rowHashes) || rowHashes.length !== envelopeEvidence.rowHashes.length) return false;
  if (typeof envelopeEvidence.rowSetSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(envelopeEvidence.rowSetSha256) || envelopeEvidence.rowSetSha256.toLowerCase() !== createHash("sha256").update(rowHashes.join("\n")).digest("hex")) return false;
  if (kinds.some((kind) => !["application_answers", "document_binaries", "hap_subsidies"].includes(kind)) || new Set(kinds).size !== kinds.length) return false;
  const supplementCount = (values: unknown): number => Array.isArray(values) ? values.filter((row) => row && typeof row === "object" && typeof row.supplementRowId === "string").length : 0;
  const binaryCount = supplementCount(payload.documentBinaryDescriptors);
  const hapCount = supplementCount(payload.subsidies);
  if ((binaryCount > 0 && !kinds.includes("document_binaries")) || (hapCount > 0 && !kinds.includes("hap_subsidies"))) return false;
  if (rows.length === 0) return !kinds.includes("application_answers") && rowHashes.length === binaryCount + hapCount;
  if (!kinds.includes("application_answers")) return false;
  const supplementedRows = rows.filter((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate) && typeof (candidate as Record<string, unknown>).supplementRowId === "string");
  if (supplementedRows.length + binaryCount + hapCount !== rowHashes.length) return false;
  // The externally verified tuple binds the full mixed-kind row set. Answer
  // rows use their canonical row hash; binary/HAP rows use builder wrapper
  // hashes, so require exact answer membership without treating those hashes
  // as additional answers. Cardinality still rejects anonymous extra claims.
  const remaining = new Map<string, number>();
  for (const hash of rowHashes) remaining.set(hash, (remaining.get(hash) ?? 0) + 1);
  for (const candidate of supplementedRows) {
    const hash = createHash("sha256").update(canonicalJson(candidate)).digest("hex");
    const count = remaining.get(hash) ?? 0;
    if (!count) return false;
    remaining.set(hash, count - 1);
  }
  return rows.every((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const row = candidate as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(row, "attestation") || Object.prototype.hasOwnProperty.call(row, "answerAttestation") || Object.prototype.hasOwnProperty.call(row, "evidenceAttestation")) return false;
    const rowEvidence = row.supplementEvidence;
    if (!rowEvidence || typeof rowEvidence !== "object" || Array.isArray(rowEvidence)) return false;
    const value = rowEvidence as Record<string, unknown>;
    return typeof value.attestationId === "string" && value.attestationId.trim().length > 0
      && typeof value.sourceReference === "string" && value.sourceReference.trim().length > 0
      && typeof value.sourceSha256 === "string" && /^[a-f0-9]{64}$/i.test(value.sourceSha256)
      && typeof value.sourceUpdatedAt === "string" && value.sourceUpdatedAt.trim().length > 0;
  });
}

function answerAttestation(record: Raw): { type?: string; rowHash?: string; sourceRunId?: string; immutableEvidence?: boolean } | undefined {
  const candidate = value(record, "attestation", "answerAttestation", "evidenceAttestation");
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const attestation = candidate as Raw;
  return {
    type: text(attestation, "type", "kind", "attestationType"),
    rowHash: text(attestation, "rowHash", "hash", "sha256"),
    sourceRunId: text(attestation, "sourceRunId", "runId", "importRunId"),
    immutableEvidence: attestation.immutableEvidence === true || attestation.immutableRowEvidence === true || attestation.immutable === true,
  };
}

/**
 * A restricted supplement deliberately does not let its row carry the
 * normalizer's attestation.  The artifact boundary verifies the envelope
 * supplement provenance first, then asks the normalizer to derive this
 * short-lived attestation from the verified row evidence.  This prevents a
 * caller from making a structurally valid row-attestation pass directly.
 */
function deriveApprovedSupplementAttestation(record: Raw, sourceRunId: string): Raw | undefined {
  const evidence = record.supplementEvidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return undefined;
  const evidenceRecord = evidence as Record<string, unknown>;
  const attestationId = typeof evidenceRecord.attestationId === "string" ? evidenceRecord.attestationId.trim() : "";
  const sourceSha256 = typeof evidenceRecord.sourceSha256 === "string" ? evidenceRecord.sourceSha256.trim() : "";
  const sourceReference = typeof evidenceRecord.sourceReference === "string" ? evidenceRecord.sourceReference.trim() : "";
  if (!attestationId || !/^[a-f0-9]{64}$/i.test(sourceSha256) || !sourceReference || !sourceRunId.trim()) return undefined;
  const derived = { ...record } as Raw;
  // Row-supplied normalizer attestations are never trusted.  The derived
  // value is computed after removing every accepted alias.
  delete derived.attestation;
  delete derived.answerAttestation;
  delete derived.evidenceAttestation;
  derived.attestation = createApplicationAnswerAttestation(derived, sourceRunId, "restricted_supplement");
  return derived;
}

function applyApplicationAnswer(application: Raw, path: string, answer: unknown): boolean {
  const setString = (target: Raw, key: string): boolean => {
    if (typeof answer !== "string" && typeof answer !== "number") return false;
    const string = String(answer).trim();
    if (!string) return false;
    target[key] = string;
    return true;
  };
  const [parent, child] = path.split(".");
  if (!child) {
    if (["email", "firstName", "lastName", "phone"].includes(path)) return setString(application, path);
    const parsedObject = objectAnswer(answer);
    if (parsedObject !== undefined && ["pets", "vehicles", "emergencyContact"].includes(path)) {
      application[path] = parsedObject;
      return true;
    }
    return false;
  }
  const nested = (application[parent] && typeof application[parent] === "object" && !Array.isArray(application[parent]))
    ? application[parent] as Raw
    : {} as Raw;
  let applied = false;
  if (["adults", "children", "totalOccupants", "desiredLeaseMonths", "bedrooms"].includes(child)) {
    const parsed = numericAnswer(answer);
    if (parsed !== undefined && Number.isInteger(parsed) && parsed >= 0) { nested[child] = parsed; applied = true; }
  } else if (["monthlyIncomeCents", "maxRentCents", "tenantPortionCents"].includes(child)) {
    const parsed = numericAnswer(answer);
    if (parsed !== undefined && Number.isInteger(parsed) && parsed >= 0) { nested[child] = parsed; applied = true; }
  } else if (child === "hasVoucher") {
    const parsed = booleanAnswer(answer);
    if (parsed !== undefined) { nested[child] = parsed; applied = true; }
  } else if (["desiredMoveInOn", "employmentStartOn"].includes(child)) {
    applied = setString(nested, child);
  } else {
    applied = setString(nested, child);
  }
  if (applied) application[parent] = nested;
  return applied;
}

function normalizeApplicationAnswerRecords(
  records: readonly RentManagerRawRecord[] | undefined,
  applications: Raw[],
  exceptions: NormalizationException[],
  expectedSourceRunId?: string,
  approvedSupplementEvidence = false,
): Raw[] {
  if (!records) return [];
  const applicationIndex = new Map<string, Raw>();
  for (const application of applications) {
    for (const variant of sourceIdVariants(application, ["ProspectApplicationID", "ApplicationID", "ApplicationId"])) applicationIndex.set(variant, application);
  }
  const normalizedRows: Raw[] = [];
  const seen = new Set<string>();
  let attestedSourceRunId: string | undefined;
  for (const rawRecord of records) {
    const raw = rawRecord as Raw;
    const record = approvedSupplementEvidence
      ? deriveApprovedSupplementAttestation(raw, expectedSourceRunId ?? "")
      : raw;
    if (!record) {
      addException(exceptions, "incomplete_coverage", "applicationAnswers", raw, "application_answer_supplement_provenance_invalid", "ambiguous");
      continue;
    }
    const attestation = answerAttestation(record);
    const type = attestation?.type?.toLowerCase().replaceAll("-", "_");
    const attestedHash = attestation?.rowHash;
    const attestedRun = attestation?.sourceRunId;
    const validType = type === "restricted_supplement" || type === "artifact" || type === "approved_artifact";
    const validHash = Boolean(attestedHash && /^[a-f0-9]{64}$/i.test(attestedHash) && attestedHash.toLowerCase() === applicationAnswerEvidenceHash(record));
    const validRun = Boolean(attestedRun && (!expectedSourceRunId || attestedRun === expectedSourceRunId) && (!attestedSourceRunId || attestedRun === attestedSourceRunId));
    if (!attestation || !validType || !validHash || !validRun || !attestation.immutableEvidence) {
      addException(exceptions, "incomplete_coverage", "applicationAnswers", record, !attestation ? "application_answer_attestation_required" : "application_answer_attestation_invalid", "ambiguous");
      continue;
    }
    attestedSourceRunId ??= attestedRun;
    const nested = value(record, "answers", "Answers", "answerRecords", "AnswerRecords");
    const rows = Array.isArray(nested)
      ? nested.filter((candidate): candidate is Record<string, unknown> => Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate)).map((candidate) => ({ ...record, ...candidate } as Raw))
      : [record];
    for (const row of rows) {
      const appId = answerApplicationId(row);
      const application = appId ? applicationIndex.get(appId) ?? applicationIndex.get(appId.replace(/^[a-z_]+:/i, "")) : undefined;
      if (!application) {
        addException(exceptions, "missing_relationship", "applicationAnswers", row, "application_answer_application_not_resolved", "unresolved");
        continue;
      }
      const fieldPath = answerFieldPath(row);
      const rawAnswer = answerValue(row);
      const answerKey = text(row, "ApplicationAnswerID", "AnswerID", "ProspectApplicationAnswerID", "ApplicationFieldAnswerID", "sourceId", "id", "ID", "Id")
        ?? `${appId ?? ""}:${fieldPath ?? ""}:${JSON.stringify(rawAnswer)}`;
      if (seen.has(answerKey)) {
        addException(exceptions, "duplicate_source_id", "applicationAnswers", row, "application_answer_duplicate_source_id", "ambiguous");
        continue;
      }
      seen.add(answerKey);
      const normalized = structuredClone(row) as Raw;
      normalized.applicationId = appId;
      normalized.fieldPath = fieldPath;
      normalized.answer = rawAnswer;
      normalized.sourceCollection = "verified_application_answers";
      normalizedRows.push(normalized);
      const existing = Array.isArray(application.applicationAnswerRecords) ? application.applicationAnswerRecords as Raw[] : [];
      existing.push(normalized);
      application.applicationAnswerRecords = existing;
      if (fieldPath && rawAnswer !== undefined && !applyApplicationAnswer(application, fieldPath, rawAnswer)) {
        addException(exceptions, "incomplete_coverage", "applicationAnswers", row, "application_answer_field_not_supported_by_target_profile", "confirmed");
      }
    }
  }
  return normalizedRows;
}

function exactChargeTypeValue(
  crosswalk: RentManagerFinancialSemanticCrosswalk | undefined,
  artifactSha256: string | undefined,
  sourceField: "ChargeTypeID" | "IsActive",
  rawValue: unknown,
  semanticKind: "charge_category" | "charge_definition_active",
): string | undefined {
  if (!crosswalk || !artifactSha256) return undefined;
  return financialSemanticCrosswalkValue(crosswalk, {
    artifactSha256,
    sourceCollection: "chargeTypes",
    sourceField,
    semanticKind,
    rawValue,
  });
}

function chargeTypeDefinitions(
  records: readonly Raw[],
  crosswalk: RentManagerFinancialSemanticCrosswalk | undefined,
  artifactSha256: string | undefined,
): RentManagerChargeTypeDefinition[] {
  return records.map((record) => {
    const sourceId = text(record, "ChargeTypeID", "ChargeTypeId", "sourceId", "id", "ID", "Id") ?? "";
    const categoryValue = exactChargeTypeValue(crosswalk, artifactSha256, "ChargeTypeID", sourceId, "charge_category");
    const activeRaw = value(record, "IsActive", "isActive");
    const activeValue = exactChargeTypeValue(crosswalk, artifactSha256, "IsActive", activeRaw, "charge_definition_active");
    // Once an artifact boundary exists, all charge semantics are opaque until
    // the exact artifact-bound crosswalk supplies them.  A description, name,
    // or free-form category is never a v8 semantic source.
    const strict = Boolean(artifactSha256);
    const legacyCategory = text(record, "Category", "ChargeCategory");
    const legacyCategoryValue = legacyCategory && ["base_rent", "recurring_fee", "one_time_fee", "subsidy", "security_deposit", "refundable_pet_deposit", "move_in_funds", "unapplied_cash", "other"].includes(legacyCategory)
      ? legacyCategory as RentManagerChargeTypeDefinition["category"]
      : null;
    const active = activeValue === "true" ? true : activeValue === "false" ? false : strict ? null : activeRaw === undefined ? null : booleanValue(record, "IsActive", "isActive");
    const name = text(record, "Name", "ChargeTypeName", "Description");
    return {
      sourceId,
      ...(name ? { name, displayName: name } : {}),
      category: strict ? categoryValue as RentManagerChargeTypeDefinition["category"] ?? null : legacyCategoryValue,
      categoryKnowledge: strict ? categoryValue ? "source" : "unknown" : legacyCategoryValue ? "source" : "unknown",
      active,
      activeKnowledge: strict ? activeValue ? "source" : "unknown" : activeRaw === undefined ? "unknown" : "source",
      ...(artifactSha256 ? { artifactSha256 } : {}),
    };
  });
}

export function normalizeRentManagerExport(payload: ExportPayload, options: { asOfDate?: string; sourceRunId?: string; approvedSupplementEvidence?: boolean; artifactSha256?: string; artifactObservationOn?: string } = {}): NormalizedRentManagerImport {
  const exceptions: NormalizationException[] = [];
  const hapArtifactSha256 = options.artifactSha256 ?? payload.artifactSha256 ?? payload.archiveEnvelopeSha256;
  const hapStatusCrosswalks = payload.hapStatusCrosswalk ?? [];
  const financialCrosswalkValue = payload.financialSemanticCrosswalk;
  const financialCrosswalkSelection = selectFinancialSemanticCrosswalk(financialCrosswalkValue, hapArtifactSha256);
  const financialCrosswalk = financialCrosswalkSelection.crosswalk;
  const financialCrosswalkValid = financialCrosswalkSelection.valid;
  // An explicitly supplied array is an approved-artifact claim, not a hint.
  // Never silently choose its first object or fall back to source prose when
  // the claim is empty, duplicated, or bound to another artifact.
  if (financialCrosswalkValue !== undefined && !financialCrosswalkSelection.valid) {
    addException(exceptions, "incomplete_coverage", "financialSemanticCrosswalk", undefined, `financial_semantic_crosswalk_invalid:${financialCrosswalkSelection.issueCodes.join(",")}`, "unresolved");
  }
  const properties = (payload.properties ?? []).map((record) => normalizeProperty(record as Raw, exceptions));
  const propertiesById = indexBy(properties, ["PropertyID", "sourceId"]);
  const propertiesIndex = new Map(Array.from(propertiesById.entries()).map(([key, rows]) => [key, rows[0]]));
  const unitTypes = (payload.unitTypeRecords ?? []).map((record) => augment(record, ["UnitTypeID"], {}, undefined, "unit_type"));
  const unitTypesIndex = new Map(Array.from(indexBy(unitTypes, ["UnitTypeID", "sourceId"]).entries()).map(([key, rows]) => [key, rows[0]]));
  const units = (payload.units ?? []).map((record) => normalizeUnit(record as Raw, propertiesIndex, unitTypesIndex, exceptions, options.asOfDate));
  const unitsIndex = new Map(Array.from(indexBy(units, ["UnitID", "sourceId"]).entries()).map(([key, rows]) => [key, rows[0]]));
  const contacts = (payload.contacts ?? []).map((record) => augment(record, ["ContactID"], { email: ["Email", "EmailAddress"] }, undefined, "contact"));
  const phones = (payload.phoneNumbers ?? []).map((record) => augment(record, ["PhoneNumberID"], { phone: ["Number", "PhoneNumber", "Phone"] }, undefined, "phone"));
  const rawTenants = (payload.tenants ?? []).map((record) => normalizeTenant(record as Raw, contacts, phones, exceptions));
  const tenantsIndex = new Map(Array.from(indexBy(rawTenants, ["TenantID", "sourceId"]).entries()).map(([key, rows]) => [key, rows[0]]));
  const tenantParentContacts = contacts.filter((contact) => {
    const directTenantId = text(contact, "TenantID", "tenantId");
    if (directTenantId && tenantsIndex.has(directTenantId)) {
      contact.parentType ??= "Tenant";
      contact.tenantId ??= directTenantId;
      return true;
    }
    const parentType = text(contact, "ParentType", "parentType", "EntityTypeName");
    const parentId = text(contact, "ParentID", "parentId", "EntityKeyID");
    if (!parentId || !tenantsIndex.has(parentId) || !parentType || !/tenant|customer/i.test(parentType)) return false;
    contact.parentType ??= parentType;
    contact.tenantId ??= parentId;
    return true;
  }).map((contact) => {
    const phone = explicitPhone(contact, phones);
    if (phone) contact.phone ??= value(phone, "Number", "PhoneNumber", "Phone");
    const contactId = id(contact, ["ContactID", "sourceId"]);
    const embedded = Array.isArray(contact.PhoneNumbers) ? contact.PhoneNumbers : [];
    const linked = contactId ? phones.filter((candidate) => id(candidate, ["ContactID", "ParentID"]) === contactId) : [];
    const seen = new Set<string>();
    const methods = [...embedded, ...linked]
      .filter((candidate): candidate is Raw => Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate))
      .map((candidate) => {
        const methodId = id(candidate, ["PhoneNumberID", "PhoneID", "sourceId"]);
        const methodValue = value(candidate, "Number", "PhoneNumber", "Phone");
        const type = value(candidate, "PhoneType", "PhoneTypeName", "Type", "PhoneNumberTypeID");
        const key = methodId ?? `${String(methodValue ?? "")}\u0000${String(type ?? "")}`;
        if (seen.has(key)) return undefined;
        seen.add(key);
        return {
          ...(methodId ? { id: methodId } : {}),
          value: methodValue,
          type,
          isPrimary: booleanValue(candidate, "IsPrimary", "Primary", "IsPrimaryPhone"),
          isTextReady: booleanValue(candidate, "IsTextReady", "TextReady", "CanText"),
        };
      })
      .filter((candidate): candidate is { id?: string; value: unknown; type: unknown; isPrimary: boolean; isTextReady: boolean } => candidate !== undefined && (typeof candidate.value === "string" || typeof candidate.value === "number"));
    if (methods.length > 0) contact.phoneMethods = methods;
    return contact;
  });
  const leases = (payload.leases ?? []).map((record) => normalizeLease(record as Raw, propertiesIndex, unitsIndex, tenantsIndex, exceptions, financialCrosswalkValid ? financialCrosswalk : undefined, hapArtifactSha256, options.artifactObservationOn ?? payload.artifactObservationOn));
  const leasesIndex = new Map(Array.from(indexBy(leases, ["LeaseID", "sourceId"]).entries()).map(([key, rows]) => [key, rows[0]]));
  const renewals = (payload.leaseRenewals ?? []).map((record) => normalizeRenewal(record as Raw, leasesIndex, exceptions));
  // Actual occupancy dates live on Lease. Contract dates live on renewal/term
  // rows. Only create a Lease-derived term when RM returned explicit contract
  // fields; MoveIn/MoveOut and DepartureDate must not masquerade as terms.
  const contractTerms = leases
    .map((lease) => normalizeContractTerm(lease, leasesIndex, exceptions))
    .filter((term) => Boolean(text(term, "contractStartOn")));
  const termsByLease = new Map<string, Raw[]>();
  for (const term of [...contractTerms, ...renewals]) {
    const leaseId = text(term, "leaseId", "tenancyId");
    if (!leaseId) continue;
    const rows = termsByLease.get(leaseId) ?? [];
    rows.push(term);
    termsByLease.set(leaseId, rows);
  }
  // A chronological sequence is not evidence of parentage.  Preserve only
  // an explicit RM renewal-parent ID; otherwise the term remains unlinked.
  const recurringSchedules = (payload.recurringSchedules ?? []).map((record) => {
    const normalized = augment(record, ["RecurringChargeID"], {
      tenantId: ["TenantID", "TenantId"],
      personId: ["PersonID", "PersonId"],
      propertyId: ["PropertyID", "PropertyId"],
      unitId: ["UnitID", "UnitId"],
      leaseId: ["LeaseID", "LeaseId", "TenancyID", "TenancyId"],
      amount: ["Amount", "MonthlyAmount", "RecurringAmount", "AmountCents"],
      description: ["Description", "Name", "ChargeTypeName"],
      scopeType: ["EntityType", "EntityTypeName", "ScopeType"],
      scopeId: ["EntityKeyID", "EntityKeyId"],
      chargeDefinitionId: ["ChargeTypeID", "ChargeTypeId", "ChargeCodeID", "ChargeCodeId", "RecurringChargeTypeID"],
      chargeDefinitionKey: ["ChargeTypeKey", "ChargeCode", "ChargeKey"],
      effectiveFrom: ["FromDate", "fromDate"],
      effectiveTo: ["ToDate", "toDate"],
    }, undefined, "recurring_schedule");
    normalized.tenantId ??= embeddedId(record, ["Tenant", "TenantAccount"], ["TenantID", "TenantId", "ID", "Id"]);
    normalized.propertyId ??= embeddedId(record, ["Property"], ["PropertyID", "PropertyId", "ID", "Id"]);
    normalized.unitId ??= embeddedId(record, ["Unit"], ["UnitID", "UnitId", "ID", "Id"]);
    normalized.leaseId ??= embeddedId(record, ["Lease", "Tenancy"], ["LeaseID", "LeaseId", "TenancyID", "TenancyId", "ID", "Id"]);
    const entityType = text(normalized, "scopeType", "EntityType", "entityTypeName");
    const scopeId = text(normalized, "scopeId", "EntityKeyID", "EntityKeyId");
    const canonicalScope = financialCrosswalkValue !== undefined
      ? financialCrosswalkValid && financialCrosswalk && hapArtifactSha256
        ? financialSemanticCrosswalkValue(financialCrosswalk, {
            artifactSha256: hapArtifactSha256,
            sourceCollection: "recurringSchedules",
            sourceField: "EntityType",
            semanticKind: "recurring_scope",
            rawValue: entityType,
          })
        : undefined
      : entityType && /tenant|customer|resident|person/i.test(entityType)
        ? "tenant"
        : entityType && /unit/i.test(entityType)
          ? "unit"
          : entityType && /property|building/i.test(entityType)
            ? "property"
            : undefined;
    if (canonicalScope) normalized.scopeType = canonicalScope;
    if (scopeId) normalized.scopeId = scopeId;
    if (canonicalScope === "tenant" && scopeId) {
      // EntityKeyID is polymorphic in RM. Resolve it only after EntityType;
      // never let a colliding Unit/Property key become a tenant.
      normalized.tenantId = scopeId;
      normalized.personId = scopeId;
    } else if (canonicalScope === "unit" && scopeId) {
      normalized.unitId = scopeId;
      delete normalized.tenantId;
      delete normalized.personId;
      delete normalized.leaseId;
    } else if (canonicalScope === "property" && scopeId) {
      normalized.propertyId = scopeId;
      delete normalized.tenantId;
      delete normalized.personId;
      delete normalized.leaseId;
      delete normalized.unitId;
    } else {
      addException(exceptions, "missing_relationship", "recurringSchedules", normalized, "recurring_entity_scope_not_resolved");
    }
    if (!text(normalized, "effectiveFrom")) normalized.effectiveFromKnowledge = "unknown_open_start";
    else normalized.effectiveFromKnowledge = "source";
    const tenantId = canonicalScope === "tenant" ? scopeId : undefined;
    if (tenantId && !tenantsIndex.has(tenantId)) addException(exceptions, "missing_relationship", "recurringSchedules", normalized, "recurring_tenant_not_resolved");
    const explicitLeaseId = canonicalScope === "tenant" ? text(normalized, "leaseId") : undefined;
    if (explicitLeaseId) {
      const explicitLease = leases.find((lease) => text(lease, "LeaseID", "leaseId", "sourceId") === explicitLeaseId);
      if (!explicitLease) addException(exceptions, "missing_relationship", "recurringSchedules", normalized, "recurring_lease_not_resolved");
      else {
        const leaseTenantId = text(explicitLease, "TenantID", "tenantId");
        if (tenantId && leaseTenantId && leaseTenantId !== tenantId) addException(exceptions, "missing_relationship", "recurringSchedules", normalized, "recurring_tenant_lease_mismatch", "ambiguous");
        normalized.propertyId ??= value(explicitLease, "PropertyID", "propertyId");
        normalized.unitId ??= value(explicitLease, "UnitID", "unitId");
      }
    }
    return normalized;
  });
  const charges = (payload.charges ?? []).map((record) => normalizeLedger(record as Raw, "charges", tenantsIndex, leasesIndex, exceptions));
  const chargesByReference = new Map<string, Raw>();
  for (const charge of charges) {
    for (const variant of sourceIdVariants(charge as Raw, ["ChargeID", "ChargeId"])) chargesByReference.set(variant, charge as Raw);
  }
  const allocationChargeReference = (record: Raw): string | undefined => text(
    record,
    "ChargeID",
    "ChargeId",
    "chargeId",
    "ChargeSourceID",
    "ChargeSourceId",
    "ChargeTransactionID",
    "ChargeTransactionId",
    "ChargeSourceTransactionID",
    "ChargeSourceTransactionId",
  ) ?? embeddedId(record, ["Charge", "ChargeTransaction"], ["ChargeID", "ChargeId", "ID", "Id"]);
  const chargeForReference = (reference: string): Raw | undefined => {
    const direct = chargesByReference.get(reference);
    if (direct) return direct;
    const unnamespaced = reference.replace(/^[a-z_]+:/i, "");
    return chargesByReference.get(unnamespaced);
  };
  const payments = (payload.payments ?? []).map((record) => {
    const allocationValue = value(record as Raw, "Allocations", "allocations");
    // An unallocated RM prepayment carries its own explicit property/unit.
    // Preserve its transaction date; neither the account location nor export
    // date proves this money was received for the current reporting period.
    const paymentRecord = structuredClone(record) as Raw;
    if (!Array.isArray(allocationValue) || allocationValue.length === 0) {
      const prepayProperty = text(paymentRecord, "PrepayPropertyID", "PrepayPropertyId");
      const prepayUnit = text(paymentRecord, "PrepayUnitID", "PrepayUnitId");
      if (!text(paymentRecord, "propertyId", "PropertyID", "PropertyId") && prepayProperty) paymentRecord.propertyId = prepayProperty;
      if (!text(paymentRecord, "unitId", "UnitID", "UnitId") && prepayUnit) paymentRecord.unitId = prepayUnit;
    }
    const normalized = normalizeLedger(paymentRecord, "payments", tenantsIndex, leasesIndex, exceptions);
    const paymentReversal = embeddedRecord(paymentRecord, "PaymentReversal");
    if (paymentReversal) {
      const parent = text(paymentRecord, "PaymentID", "PaymentId");
      const reversalParent = text(paymentReversal, "PaymentID", "PaymentId");
      if (parent && reversalParent === parent) {
        for (const field of ["ReversalType", "ReversalDate", "ReversalReason"]) {
          const returned = value(paymentReversal, field);
          if (normalized[field] === undefined || normalized[field] === null) normalized[field] = returned;
          else if (returned !== undefined && returned !== null && normalized[field] !== returned) addException(exceptions, "missing_relationship", "payments", normalized, "payment_reversal_fields_conflict", "ambiguous");
        }
      } else addException(exceptions, "missing_relationship", "payments", normalized, "payment_reversal_parent_not_exact", "unresolved");
    }

    const allocations = Array.isArray(allocationValue)
      ? (allocationValue as RentManagerRawRecord[]).map((allocation) => structuredClone(allocation) as Raw)
      : [];
    if (allocations.length) normalized.allocations = allocations;

    // RM does not consistently place PropertyID on Payment rows. An explicit
    // ChargeID on each allocation is a safe bridge only when every referenced
    // charge resolves and all of those charges carry the same explicit
    // PropertyID. Cross-property, unresolved, and unallocated payments stay
    // unresolved; no lease or row-order inference is used.
    const directPropertyId = text(normalized, "propertyId", "PropertyID", "PropertyId");
    const allocationRows = allocations as Raw[];
    const references = allocationRows.map((allocation) => allocationChargeReference(allocation));
    const referencedCharges = references.map((reference) => reference ? chargeForReference(reference) : undefined);
    const referencedPropertyIds = new Set(referencedCharges.map((charge) => charge ? text(charge, "propertyId", "PropertyID", "PropertyId") : undefined).filter((propertyId): propertyId is string => Boolean(propertyId)));
    const hasUnresolvedChargeReference = references.some((reference, index) => !reference || !referencedCharges[index]);
    const hasChargeWithoutProperty = referencedCharges.some((charge) => !charge || !text(charge, "propertyId", "PropertyID", "PropertyId"));
    if (referencedPropertyIds.size > 1) {
      const exactCents = (raw: unknown): number | undefined => {
        const text = String(raw ?? "").trim();
        if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) return undefined;
        const negative = text.startsWith("-"); const [whole,fraction=""] = text.replace(/^-/,"").split(".");
        const cents = Number(whole)*100+Number((fraction+"00").slice(0,2));
        return Number.isSafeInteger(cents) ? (negative?-cents:cents) : undefined;
      };
      const account = text(normalized,"tenantId");
      const applied = allocationRows.filter(row => text(row,"AllocationType") !== "EntityTransfer");
      const receiptCents = exactCents(value(normalized,"amount","Amount"));
      const appliedCents = applied.map(row => exactCents(value(row,"Amount","amount")));
      const exactScope = !hasUnresolvedChargeReference && !hasChargeWithoutProperty && !!account && allocationRows.every((allocation,index) => {
        const charge = referencedCharges[index]!;
        return text(charge,"tenantId") === account
          && (!text(allocation,"PropertyID") || text(allocation,"PropertyID") === text(charge,"propertyId"))
          && (!text(allocation,"UnitID") || text(allocation,"UnitID") === text(charge,"unitId"));
      });
      if (exactScope && receiptCents !== undefined && receiptCents > 0 && appliedCents.every(amount=>amount!==undefined) && appliedCents.reduce<number>((sum,amount)=>sum+(amount??0),0) === receiptCents) {
        // One account receipt, exact applications across properties. Neither
        // the prepay property nor the current lease owns the whole receipt.
        normalized.allocationMode = "multi_property";
      } else addException(exceptions, "missing_relationship", "payments", normalized, "payment_allocated_charges_span_multiple_properties", "ambiguous");
    } else if (!directPropertyId) {
      if (allocationRows.length === 0) {
        addException(exceptions, "missing_relationship", "payments", normalized, "payment_property_not_resolved_unallocated", "unresolved");
      } else if (hasUnresolvedChargeReference || hasChargeWithoutProperty) {
        addException(exceptions, "missing_relationship", "payments", normalized, "payment_property_charge_reference_not_resolved", "unresolved");
      } else {
        const [propertyId] = Array.from(referencedPropertyIds);
        if (propertyId) normalized.propertyId = propertyId;
      }
    } else if (referencedPropertyIds.size === 1 && !referencedPropertyIds.has(directPropertyId)) {
      addException(exceptions, "missing_relationship", "payments", normalized, "payment_property_conflicts_with_allocated_charge", "ambiguous");
    }
    return normalized;
  });
  const credits = (payload.credits ?? []).map((record) => normalizeLedger(record as Raw, "credits", tenantsIndex, leasesIndex, exceptions));
  const prospects = (payload.prospects ?? []).map((record) => augment(record, ["ProspectID"], { contactId: ["ContactID"], propertyId: ["PropertyID"], unitId: ["UnitID"] }, undefined, "prospect"));
  const applications = (payload.applications ?? []).map((record) => {
    const normalized = augment(record, ["ProspectApplicationID", "ApplicationID"], { contactId: ["ContactID", "ContactId"], webUserId: ["WebUserID", "WebUserId", "UserID", "UserId"], webUserAccountId: ["WebUserAccountID", "WebUserAccountId", "AccountID", "AccountId", "WebAccountID", "WebAccountId"], prospectId: ["ProspectID", "ProspectId"], firstName: ["FirstName", "first_name"], lastName: ["LastName", "last_name"], email: ["Email", "EmailAddress"], status: ["Status", "ApplicationStatus"], submittedOn: ["SubmittedDate", "ApplicationDate", "ApplicationSubmissionDate"], createdAt: ["CreatedAt", "CreatedDate", "CreateDate"], updatedAt: ["UpdatedAt", "UpdateDate", "ModifiedDate"] }, undefined, "application");
    // RM -1 explicitly means no linked web account; AccountID is not a substitute.
    const unknownWebAccount = text(record, "WebUserAccountID", "WebUserAccountId") === "-1";
    if (unknownWebAccount) normalized.webUserAccountId = undefined;
    const embeddedWebUser = embeddedRecord(record, "WebUser", "User");
    const embeddedWebAccount = embeddedRecord(record, "WebUserAccount", "WebAccount", "Account");
    normalized.webUserId ??= embeddedWebUser ? text(embeddedWebUser, "WebUserID", "WebUserId", "UserID", "UserId", "ID", "Id") : undefined;
    if (!unknownWebAccount) normalized.webUserAccountId ??= embeddedWebAccount ? text(embeddedWebAccount, "WebUserAccountID", "WebUserAccountId", "AccountID", "AccountId", "WebAccountID", "WebAccountId", "ID", "Id") : undefined;
    const prospectId = text(normalized, "prospectId");
    const prospect = prospectId ? prospects.find((candidate) => id(candidate, ["ProspectID"]) === prospectId) : undefined;
    if (prospect) {
      normalized.propertyId ??= value(prospect, "PropertyID", "propertyId");
      normalized.unitId ??= value(prospect, "UnitID", "unitId");
      normalized.contactId ??= value(prospect, "ContactID", "contactId");
    } else if (prospectId) addException(exceptions, "missing_relationship", "prospectApplications", normalized, "application_prospect_not_resolved");
    const contactId = text(normalized, "contactId");
    const contact = contactId ? contacts.find((candidate) => id(candidate, ["ContactID"]) === contactId) : undefined;
    if (contact) {
      normalized.email ??= value(contact, "Email", "EmailAddress");
      normalized.phone ??= value(contact, "Phone", "PhoneNumber", "Mobile");
      normalized.firstName ??= value(contact, "FirstName");
      normalized.lastName ??= value(contact, "LastName");
    } else if (contactId) addException(exceptions, "missing_relationship", "prospectApplications", normalized, "application_contact_not_resolved");
    const webUserId = text(normalized, "WebUserID", "webUserId");
    const webUserAccountId = unknownWebAccount ? undefined : text(normalized, "WebUserAccountID", "webUserAccountId");
    const webUser = webUserId ? (payload.webUsers ?? []).find((user) => id(user as Raw, ["WebUserID", "WebUserId", "UserID", "UserId"]) === webUserId) : undefined;
    const webUserAccount = unknownWebAccount ? undefined : (payload.webUserAccounts ?? []).find((account) => {
      const row = account as Raw;
      if (webUserAccountId && id(row, ["WebUserAccountID", "WebUserAccountId", "AccountID", "AccountId", "WebAccountID", "WebAccountId"]) === webUserAccountId) return true;
      return Boolean(webUserId && id(row, ["WebUserID", "WebUserId", "UserID", "UserId"]) === webUserId);
    });
    const webIdentity = webUser ?? webUserAccount;
    if (webIdentity) {
      normalized.webUserId = webUser ? id(webUser as Raw, ["WebUserID"]) ?? webUserId : webUserId;
      normalized.webUserAccountId = webUserAccount ? id(webUserAccount as Raw, ["WebUserAccountID", "AccountID"]) ?? webUserAccountId : webUserAccountId;
      normalized.email ??= value(webIdentity, "Email", "EmailAddress");
      normalized.firstName ??= value(webIdentity, "FirstName");
      normalized.lastName ??= value(webIdentity, "LastName");
      normalized.phone ??= value(webIdentity, "Phone", "PhoneNumber");
    } else if (webUserId || webUserAccountId) addException(exceptions, "missing_relationship", "prospectApplications", normalized, "application_web_user_or_account_not_resolved");
    return normalized;
  });
  const applicationAnswerRecords = normalizeApplicationAnswerRecords(payload.applicationAnswerRecords, applications, exceptions, options.sourceRunId, options.approvedSupplementEvidence === true);
  const applicationTemplateFieldCount = (payload.applicationTemplates ?? []).filter((row) => /field/i.test(String((row as Raw).sourceCollection ?? ""))).length;
  if (payload.applicationAnswerRecords !== undefined && applicationAnswerRecords.length === 0 && applications.length > 0 && applicationTemplateFieldCount > 0) {
    addException(exceptions, "incomplete_coverage", "applicationAnswers", undefined, "application_answer_collection_empty_for_template_fields", "unresolved");
  }
  const historyRows = [
    ...(payload.histories ?? []),
    ...(payload.notes ?? []),
    ...(payload.activities ?? []),
    ...(payload.communications ?? []),
  ];
  const normalizedHistoryRows = historyRows.map((record) => normalizeActivity(record as Raw, tenantsIndex, propertiesIndex, unitsIndex, leasesIndex, exceptions));
  const activitiesBySource = new Map<string, Raw>();
  for (let index = 0; index < normalizedHistoryRows.length; index += 1) {
    const activity = normalizedHistoryRows[index];
    const parentSourceId = text(activity, "parentSourceId", "_parentSourceId", "TenantID", "tenantId");
    const source = text(activity, "sourceId");
    const sourceCollection = text(activity, "sourceCollection", "SourceCollection") ?? "activity";
    // HistoryID is parent-scoped in RM. Keep parent in the activity identity
    // even for supplements that arrive without the collector's composite
    // sourceId. True same-parent duplicates still collapse deterministically.
    const key = source
      ? `${sourceCollection}:${parentSourceId ?? ""}:${source}`
      : `row:${index}`;
    if (!activitiesBySource.has(key)) activitiesBySource.set(key, activity);
  }
  const histories = Array.from(activitiesBySource.values());
  const documentRows = [
    ...(payload.documents ?? []),
    ...(payload.documentBinaryDescriptors ?? []),
    ...(payload.documentBinaries ?? []).map((descriptor) => ({
      ...descriptor,
      entityType: "document",
      sourceId: descriptor.sourceId,
      binaryAvailable: descriptor.binaryAvailable,
      checksumSha256: descriptor.sha256,
    } as unknown as RentManagerRawRecord)),
  ].map((record) => augment(record, ["SignableDocumentID", "SignableDocumentPacketID", "DocumentPacketID", "DocumentID", "sourceId"], { fileName: ["FileName", "Name"], mimeType: ["MimeType", "ContentType", "contentType"], sizeBytes: ["SizeBytes", "FileSize", "sizeBytes"] }, undefined, "document"));
  const documentsBySourceId = new Map<string, Raw>();
  for (const document of documentRows) {
    const documentId = text(document, "sourceId", "DocumentID", "DocumentPacketID", "SignableDocumentID", "SignableDocumentPacketID");
    if (!documentId) {
      documentsBySourceId.set(`missing:${documentsBySourceId.size}`, document);
      continue;
    }
    const existing = documentsBySourceId.get(documentId);
    documentsBySourceId.set(documentId, existing ? { ...existing, ...document } : document);
  }
  const documents = Array.from(documentsBySourceId.values());
  // LeaseTerms is a lookup resource in RM. Contract terms come from Leases
  // plus the separately joined renewal rows, never from lookup definitions.
  const leaseTerms = [...contractTerms, ...renewals];
  const normalizeAllocation = (record: RentManagerRawRecord): Raw => {
    // TransactionDate belongs to this exact Allocation row, not its parent
    // payment. RM uses it for both direct and reverse allocation facts.
    const normalized = augment(record, ["PaymentAllocationID", "AllocationID", "PaymentAllocationId"], { paymentId: ["PaymentID", "PaymentSourceID", "PaymentTransactionID", "PaymentSourceTransactionID"], chargeId: ["ChargeID", "ChargeSourceID", "ChargeTransactionID", "ChargeSourceTransactionID"], amount: ["Amount", "AllocationAmount"], allocatedOn: ["AllocatedOn", "AllocationDate", "AllocatedOnDate", "TransactionDate"] }, "allocation", "payment_allocation");
    normalized.paymentId ??= embeddedId(record, ["Payment", "PaymentTransaction"], ["PaymentID", "PaymentId", "ID", "Id"]);
    if (text(record, "AllocationType") === "CreditAllocation") normalized.creditId = text(record, "AppliedCreditID");
    const allocationProperty = text(record,"PropertyID");
    if (allocationProperty) normalized.propertyId = `property:${allocationProperty.replace(/^property:/, "")}`;
    normalized.chargeId ??= embeddedId(record, ["Charge", "ChargeTransaction"], ["ChargeID", "ChargeId", "ID", "Id"]);
    const allocationId = text(normalized, "PaymentAllocationID", "AllocationID", "sourceId")?.replace(/^(?:payment_)?allocation:/, "");
    if (allocationId) normalized.sourceId = `payment_allocation:${allocationId}`;
    const payment = text(normalized, "paymentId");
    const charge = text(normalized, "chargeId");
    const credit = text(normalized, "creditId");
    if (credit) normalized.creditId = `credit:${credit.replace(/^credit:/, "")}`;
    if (payment) normalized.paymentId = `payment:${payment.replace(/^payment:/, "")}`;
    if (charge) normalized.chargeId = `charge:${charge.replace(/^charge:/, "")}`;
    return normalized;
  };
  const normalizedAllocationRows = [
    ...(payload.allocations ?? []),
    ...charges.flatMap(charge => Array.isArray(charge.Allocations) ? charge.Allocations as RentManagerRawRecord[] : []),
    ...payments.flatMap((payment) => {
      const row = payment as Raw;
      const nested = row.allocations ?? row.Allocations;
      return Array.isArray(nested) ? nested as RentManagerRawRecord[] : [];
    }),
  ].map(normalizeAllocation);
  const allocationBySource = new Map<string, Raw>();
  for (const allocation of normalizedAllocationRows) {
    const source = text(allocation, "sourceId", "AllocationID", "PaymentAllocationID") ?? `row:${text(allocation, "paymentId") ?? ""}:${text(allocation, "chargeId") ?? ""}:${text(allocation, "amount") ?? ""}`;
    allocationBySource.set(source, allocation);
  }
  const retainedPaymentReferences = new Set<string>();
  for (const payment of payments) {
    for (const variant of sourceIdVariants(payment as Raw, ["PaymentID", "PaymentId"])) retainedPaymentReferences.add(variant);
  }
  const retainedCreditReferences = new Set<string>();
  for (const credit of credits) {
    for (const variant of sourceIdVariants(credit as Raw, ["CreditID", "CreditId"])) retainedCreditReferences.add(variant);
  }
  const normalizedAllocations = Array.from(allocationBySource.values()).filter((allocation) => {
    if (text(allocation, "AllocationType") === "CreditAllocation") {
      const reference = text(allocation, "creditId");
      const plain = reference?.replace(/^credit:/, "");
      const retained = Boolean(reference && (retainedCreditReferences.has(reference) || (plain && retainedCreditReferences.has(plain))));
      if (!retained) addException(exceptions, "missing_relationship", "allocations", allocation, "allocation_parent_credit_not_resolved", "unresolved");
      return retained;
    }
    const paymentReference = text(allocation, "paymentId", "PaymentID", "PaymentId", "PaymentSourceID", "PaymentSourceId", "PaymentTransactionID", "PaymentTransactionId", "PaymentSourceTransactionID", "PaymentSourceTransactionId");
    const unnamespaced = paymentReference?.replace(/^[a-z_]+:/i, "");
    const retained = Boolean(paymentReference && (retainedPaymentReferences.has(paymentReference) || (unnamespaced && retainedPaymentReferences.has(unnamespaced))));
    if (!retained) {
      // Preserve the raw row in the restricted archive, but do not expose an
      // import allocation whose parent payment was not retained.
      addException(exceptions, "missing_relationship", "allocations", allocation, "allocation_parent_payment_not_resolved", "unresolved");
    }
    return retained;
  });
  const securityDepositTypes = securityDepositTypeLookup(payload.securityDepositTypeRecords ?? []);
  const interestedRentals = (payload.interestedRentals ?? []).map((record) => augment(record, ["InterestedRentalID", "InterestedRentID", "ID"], {}, "interested_rental", "interested_rental"));
  const applicationSettings = (payload.applicationSettings ?? []).map((record) => augment(record, ["ApplicationSettingID", "SettingID", "ID"], {}, "application_setting", "application_setting"));
  const input: RentManagerImportInput = {
    properties,
    units,
    tenants: rawTenants,
    contacts: tenantParentContacts,
    leases,
    leaseTerms,
    recurringSchedules,
    charges,
    payments,
    allocations: normalizedAllocations,
    deposits: assignDepositCompositeIdentities(payload.deposits ?? [], exceptions).map((record) => normalizeDeposit(record, tenantsIndex, leases, charges, securityDepositTypes, exceptions)),
    subsidies: (payload.subsidies ?? []).map((record) => normalizeSubsidy(record as Raw, tenantsIndex, leases, exceptions, hapStatusCrosswalks, hapArtifactSha256)),
    subsidyTenants: (payload.subsidyTenants ?? []).map((record) => normalizeSubsidyTenant(record as Raw, hapStatusCrosswalks, hapArtifactSha256, exceptions)),
    subsidyPayments: (payload.subsidyPayments ?? []).map((record) => normalizeSubsidyPayment(record as Raw, hapStatusCrosswalks, hapArtifactSha256, exceptions)),
    hapStatusCrosswalk: hapStatusCrosswalks,
    // Child HAP rows are preserved in the normalized restricted input so the
    // artifact cannot silently drop them while the operational child-table
    // projection remains an explicit follow-up packet.
    hap: (payload.hap ?? []).map((record) => ({ ...(record as Raw), sourceCollection: text(record as Raw, "sourceCollection") ?? "hap" })),
    applications,
    ...(options.approvedSupplementEvidence === true && payload.applicationHistoryStatusCrosswalk
      ? { applicationHistoryStatusCrosswalk: payload.applicationHistoryStatusCrosswalk.map((entry) => ({ ...entry })) }
      : {}),
    documents,
    activities: histories,
    chargeTypes: chargeTypeDefinitions((payload.chargeTypeRecords ?? []) as Raw[], financialCrosswalk, hapArtifactSha256),
    // Preserve an invalid explicit claim for the mapper's exact-one/artifact
    // gate; never replace it with the first array member or erase the reason.
    financialSemanticCrosswalk: financialCrosswalkSelection.valid ? financialCrosswalk : financialCrosswalkValue,
    ...(payload.financialReviewHolds ? { financialReviewHolds: payload.financialReviewHolds.map(row => ({...row})) } : {}),
    credits: credits,
    ...(options.artifactObservationOn ?? payload.artifactObservationOn ? { artifactObservationOn: options.artifactObservationOn ?? payload.artifactObservationOn } : {}),
  };
  // Keep the normalized answer rows available to the artifact builder and
  // restricted supplement path without expanding the public persistence
  // contract. The mapper persists supported typed fields on applications;
  // the restricted source archive retains every answer row losslessly.
  if (payload.applicationAnswerRecords !== undefined) (input as RentManagerImportInput & { applicationAnswerRecords?: Raw[] }).applicationAnswerRecords = applicationAnswerRecords;
  if (payload.interestedRentals !== undefined) (input as RentManagerImportInput & { interestedRentals?: Raw[] }).interestedRentals = interestedRentals;
  if (payload.applicationSettings !== undefined) (input as RentManagerImportInput & { applicationSettings?: Raw[] }).applicationSettings = applicationSettings;
  const chargeTypeById = new Map((input.chargeTypes ?? []).map((definition) => [definition.sourceId, definition]));
  const hapCandidates = [...charges, ...recurringSchedules].filter((record) => {
    const typeId = text(record as Raw, "chargeTypeId", "ChargeTypeID");
    const definition = typeId ? chargeTypeById.get(typeId) : undefined;
    // HAP candidacy may come only from an exact ChargeTypeID crosswalk.  A
    // rent-like or agency-like memo is not a financial classification.
    return definition?.category === "subsidy" && definition.categoryKnowledge === "source";
  });
  const rawHapRows = payload.hap ?? [];
  const explicitSubsidyTenants = payload.subsidyTenants !== undefined;
  const explicitSubsidyPayments = payload.subsidyPayments !== undefined;
  const hapChildCollectionsObserved = explicitSubsidyTenants && explicitSubsidyPayments;
  const normalizedHapChildRows = [...(input.subsidyTenants ?? []), ...(input.subsidyPayments ?? [])] as Raw[];
  const normalizedHapRows = input.subsidies ?? [];
  let hap: NormalizationConfidence["hap"] = "not_observed";
  if (normalizedHapRows.length === 0) {
    if (hapChildCollectionsObserved && hapCandidates.length === 0 && rawHapRows.length === 0) {
      // Explicit empty /Subsidies + /SubsidyTenants + /SubsidyPayments is a
      // verified zero case. It is not equivalent to omitted collections.
      hap = "confirmed";
    } else {
      hap = "blocked";
      if (rawHapRows.length > 0) {
      for (const row of rawHapRows) addException(exceptions, "incomplete_coverage", "hap", row as Raw, "hap_rows_without_supported_contract_join", "unresolved");
      } else if (hapCandidates.length === 0 && !hapChildCollectionsObserved) {
      addException(exceptions, "incomplete_coverage", "hap", undefined, "hap_collections_empty_manual_verification_required", "unresolved");
      } else if (hapCandidates.length > 0) {
      for (const candidate of hapCandidates) addException(exceptions, "incomplete_coverage", "hap", candidate as Raw, "hap_candidate_missing_agency_tenant_obligations_and_dates", "unresolved");
      }
    }
  } else if (normalizedHapRows.length > 0) {
    const complete = normalizedHapRows.every((record) => {
      const row = record as Raw;
      return Boolean(text(row, "agencyName")) && text(row, "effectiveFrom") !== undefined && value(row, "agencyObligationCents") !== undefined && value(row, "tenantObligationCents") !== undefined;
    });
    const subsidyIds = new Set(normalizedHapRows.map((record) => text(record as Raw, "SubsidyID", "subsidyId", "sourceId")));
    const unjoinedRawHap = rawHapRows.filter((row) => {
      const candidate = row as Raw;
      const subsidyId = text(candidate, "SubsidyID", "subsidyId");
      return !subsidyId || !subsidyIds.has(subsidyId);
    });
    if (unjoinedRawHap.length > 0) for (const row of unjoinedRawHap) addException(exceptions, "incomplete_coverage", "hap", row as Raw, "hap_row_not_joined_to_subsidy_contract", "unresolved");
    if (!hapChildCollectionsObserved) addException(exceptions, "incomplete_coverage", "hap", undefined, "hap_child_collections_not_returned", "unresolved");
    const unknownChildStatuses = normalizedHapChildRows.filter((row) => row.statusKnowledge !== "source").length;
    if (unknownChildStatuses > 0) addException(exceptions, "incomplete_coverage", "hap", undefined, "hap_child_status_unknown_exact_crosswalk_required", "unresolved");
    hap = complete && unjoinedRawHap.length === 0 && hapChildCollectionsObserved && unknownChildStatuses === 0 ? "confirmed" : "blocked";
    if (!complete) addException(exceptions, "incomplete_coverage", "hap", undefined, "hap_rows_missing_agency_tenant_obligations_or_dates", "unresolved");
  } else if (rawHapRows.length > 0) {
    hap = "blocked";
    addException(exceptions, "incomplete_coverage", "hap", undefined, "hap_rows_not_mapped_to_supported_subsidy_contracts", "unresolved");
  }
  const derivedIdentityRows: Array<[string, readonly Raw[]]> = [
    ["deposits", (input.deposits ?? []) as Raw[]],
    ["histories", (input.activities ?? []) as Raw[]],
    ["communications", (payload.communications ?? []) as Raw[]],
  ];
  const derivedIdentitySeen = new Set<string>();
  for (const [collection, records] of derivedIdentityRows) {
    for (const record of records) {
      if (!booleanValue(record, "identityDerivedFromComposite")) continue;
      const key = `${collection}:${text(record, "sourceId") ?? "row"}`;
      if (derivedIdentitySeen.has(key)) continue;
      derivedIdentitySeen.add(key);
      addException(exceptions, "derived_identity", collection, record, "source_identity_derived_from_explicit_composite", "confirmed");
    }
  }
  const relationshipExceptions = exceptions.filter((exception) => exception.code === "missing_relationship");
  const unresolvedRelationshipCount = relationshipExceptions.filter((exception) => exception.confidence === "unresolved").length;
  const ambiguousRelationshipCount = relationshipExceptions.filter((exception) => exception.confidence === "ambiguous").length;
  const confidence: NormalizationConfidence = {
    overall: hap === "blocked" ? "blocked" : exceptions.length > 0 ? "partial" : "confirmed",
    relationships: ambiguousRelationshipCount > 0 ? "ambiguous" : unresolvedRelationshipCount > 0 ? "partial" : "confirmed",
    unresolvedRelationshipCount,
    ambiguousRelationshipCount,
    hap,
  };
  const recordCounts = Object.fromEntries(Object.entries(input).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, (value as unknown[]).length]));
  return { input, exceptions, recordCounts, confidence };
}

export const normalizeRmExport = normalizeRentManagerExport;
