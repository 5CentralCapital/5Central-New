import type { CollectionDefinition } from "./types";
import type { RentManagerRawRecord } from "../../../shared/rent-ops-contracts";
import { canonicalJson, sha256 } from "./hash";

/**
 * Lossless per-row normalization used by the collector before hashing and
 * archiving. It only aliases explicitly documented RM fields; it never picks a
 * relationship by name, position, or first-match heuristics.
 */
export function normalizeRmRecord(
  definition: CollectionDefinition,
  record: RentManagerRawRecord,
  context: { parentSourceId?: string; index?: number } = {},
): RentManagerRawRecord {
  const normalized = structuredClone(record) as Record<string, unknown>;
  const fields = [...(definition.idFields ?? []), "sourceId", "id", "ID", "Id"];
  let rawId: unknown;
  for (const field of fields) {
    if (normalized[field] !== undefined && normalized[field] !== null && normalized[field] !== "") {
      rawId = normalized[field];
      break;
    }
  }
  if (rawId !== undefined) {
    const source = String(rawId);
    const namespace = definition.sourceIdNamespace;
    // History is a tenant subresource whose HistoryID is only unique within
    // the parent tenant. RM can also return multiple payload variants with
    // the same HistoryID for one tenant; the verified CreateDate/HistoryDate
    // component distinguishes those facts before the collector's global
    // exact-once pass. Same-parent rows with the same date remain eligible for
    // true duplicate detection.
    if (namespace === "history" && context.parentSourceId !== undefined) {
      const scopedPrefix = `history:${context.parentSourceId}:`;
      let historyPart = source.replace(/^history:/, "");
      if (historyPart.startsWith(`${context.parentSourceId}:`)) historyPart = historyPart.slice(context.parentSourceId.length + 1);
      const historyDateFields = ["CreateDate", "HistoryDate", "createDate", "historyDate"] as const;
      const historyDateField = historyDateFields.find((field) => nonEmpty(normalized[field]));
      const historyDate = historyDateField ? stringPart(normalized[historyDateField]) : undefined;
      if (historyDate && !historyPart.endsWith(`:${historyDate}`)) historyPart = `${historyPart}:${historyDate}`;
      normalized.sourceId = `${scopedPrefix}${historyPart}`;
      normalized.historyIdentityFields = historyDate
        ? ["parentSourceId", "HistoryID", historyDateField ?? "CreateDate"]
        : ["parentSourceId", "HistoryID"];
      normalized.historyIdentitySource = historyDate ? "tenant_history_request_parent_history_id_date" : "tenant_history_request_parent_history_id";
    } else {
      normalized.sourceId = namespace && !source.startsWith(`${namespace}:`) ? `${namespace}:${source}` : source;
    }
  }
  if (normalized.sourceId === undefined || normalized.sourceId === null || normalized.sourceId === "") {
    const composite = compositeSourceIdentity(definition, normalized, context);
    if (composite) {
      normalized.sourceId = composite.sourceId;
      // This is provenance, not a guessed relationship. The field list records
      // only source field names; the values never leave the restricted archive
      // and the source ID contains only a SHA-256 digest.
      normalized.identityDerivedFromComposite = true;
      normalized.identityDerivedFromCompositeFields = composite.fields;
      normalized.identityCompositeHash = composite.digest;
      if (composite.phoneComponentHashed) normalized.identityPhoneComponentHashed = true;
    }
  }
  // RM returns six phone-type slots for every contact. Empty slots have no
  // PhoneNumberID but do have the explicit parent + PhoneNumberTypeID
  // compound identity. Preserve those rows losslessly without inventing a
  // position- or hash-based ID.
  if ((normalized.sourceId === undefined || normalized.sourceId === null || normalized.sourceId === "") && definition.entityType === "phone" && context.parentSourceId !== undefined) {
    const phoneTypeId = normalized.PhoneNumberTypeID ?? normalized.phoneNumberTypeId;
    if (phoneTypeId !== undefined && phoneTypeId !== null && String(phoneTypeId).trim()) {
      normalized.sourceId = `phone_slot:${context.parentSourceId}:${String(phoneTypeId).trim()}`;
    }
  }
  // Other entities remain incomplete when RM did not supply an explicit or
  // documented compound identity.
  if (definition.entityType && normalized.entityType === undefined) normalized.entityType = definition.entityType;
  normalized.sourceCollection = definition.name;
  if (context.parentSourceId !== undefined) {
    normalized.parentSourceId = context.parentSourceId;
    normalized._parentSourceId = context.parentSourceId;
    if (definition.parentCollection?.startsWith("tenants")) normalized.tenantId ??= context.parentSourceId;
    if (definition.parentCollection === "contacts") normalized.contactId ??= context.parentSourceId;
    if (definition.embeddedEntityType === "payment_allocation") normalized.paymentId ??= context.parentSourceId;
  }
  if (definition.embeddedEntityType === "payment_allocation") {
    const payment = normalized.PaymentID ?? normalized.paymentId;
    const charge = normalized.ChargeID ?? normalized.chargeId;
    if (payment !== undefined) normalized.paymentId = `payment:${String(payment).replace(/^payment:/, "")}`;
    if (charge !== undefined) normalized.chargeId = `charge:${String(charge).replace(/^charge:/, "")}`;
    if (normalized.TransactionDate !== undefined && normalized.allocatedOn === undefined) normalized.allocatedOn = normalized.TransactionDate;
  }
  const aliases: Record<string, string> = {
    PropertyID: "propertyId", UnitID: "unitId", TenantID: "tenantId", LeaseID: "leaseId", LeaseRenewalID: "leaseRenewalId", ParentLeaseID: "parentLeaseId",
    LeaseTermID: "leaseTermId", RecurringChargeID: "recurringChargeId", ChargeID: "chargeId", PaymentID: "paymentId", CreditID: "creditId", AllocationID: "allocationId",
    ContactID: "contactId", WebUserID: "webUserId", ProspectID: "prospectId", ProspectApplicationID: "prospectApplicationId", AccountID: "accountId", EntityKeyID: "entityKeyId",
    ParentID: "parentId", ParentType: "parentType", UnitTypeID: "unitTypeId", ChargeTypeID: "chargeTypeId", SecurityDepositTypeID: "securityDepositTypeId",
    AddressLine1: "addressLine1", AddressLine2: "addressLine2", PropertyName: "propertyName", UnitNumber: "unitNumber", MarketRent: "marketRent",
    MoveInDate: "moveInDate", MoveOutDate: "moveOutDate", StartDate: "startDate", EndDate: "endDate", TransactionDate: "transactionDate",
    IsArchived: "isArchived", IsPrimary: "isPrimary", IsTextReady: "isTextReady", EmailAddress: "email", PhoneNumber: "phone",
  };
  for (const [source, target] of Object.entries(aliases)) if (normalized[target] === undefined && normalized[source] !== undefined) normalized[target] = normalized[source];
  const address = normalized.Address;
  if (address && typeof address === "object" && !Array.isArray(address)) {
    const object = address as Record<string, unknown>;
    if (normalized.addressLine1 === undefined) normalized.addressLine1 = object.Line1 ?? object.AddressLine1 ?? object.Address ?? object.Street;
    if (normalized.city === undefined) normalized.city = object.City;
    if (normalized.state === undefined) normalized.state = object.State;
    if (normalized.postalCode === undefined) normalized.postalCode = object.PostalCode ?? object.Zip ?? object.ZipCode;
  }
  // Do not alias Addresses[0].  Address selection is a source-fidelity
  // decision made by the relationship normalizer, where explicit primary /
  // role evidence and ambiguity can be retained.  Copying the first row here
  // would make a response-order artifact look like a verified property fact
  // and would prevent the later selector from replacing it.
  const unitTypeValue = normalized.UnitType;
  const unitType = Array.isArray(unitTypeValue) && unitTypeValue.length === 1 ? unitTypeValue[0] : unitTypeValue;
  if (unitType && typeof unitType === "object" && !Array.isArray(unitType)) {
    const object = unitType as Record<string, unknown>;
    if (normalized.unitType === undefined) normalized.unitType = object.Name ?? object.Description ?? object.UnitTypeName;
  }
  // Embedded MarketRent rows are selected later using an explicit as-of
  // interval.  Never collapse an object/array into a scalar here: a future or
  // expired row must not leak into the operational market-rent field.
  const marketRentValue = normalized.MarketRent;
  if (!marketRentValue || (typeof marketRentValue !== "object" && !Array.isArray(marketRentValue))) {
    // A scalar top-level MarketRent remains a direct source fact.
    if (normalized.marketRent === undefined && marketRentValue !== undefined) normalized.marketRent = marketRentValue;
  }
  const amenities = normalized.Amenities;
  if (Array.isArray(amenities) && normalized.amenities === undefined) normalized.amenities = amenities;
  return normalized as RentManagerRawRecord;
}

function nonEmpty(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function stringPart(value: unknown): string | undefined {
  return nonEmpty(value) ? String(value).trim() : undefined;
}

/**
 * Read one of a small, explicit set of RM casing aliases. The collector's
 * first pass sees PascalCase fields; the resume/finish pass may see the
 * canonical camelCase aliases that the first pass added. Neither pass may
 * select an arbitrary field or a row position for identity.
 */
function explicitField(record: Record<string, unknown>, ...fields: string[]): unknown {
  for (const field of fields) if (nonEmpty(record[field])) return record[field];
  return undefined;
}

function normalizedPhone(value: unknown): string | undefined {
  const text = stringPart(value);
  if (!text) return undefined;
  const digits = text.replace(/\D/g, "");
  return digits || text.toLowerCase();
}

interface CompositeIdentity {
  sourceId: string;
  digest: string;
  fields: string[];
  phoneComponentHashed?: boolean;
}

/**
 * RM has two source collections whose records can be stable without an RM
 * surrogate ID. These are the only documented composites currently accepted:
 * security-deposit summaries are scoped to the tenant request, while text
 * conversations are keyed by parent and external phone. Never fall back to a
 * row index: a reordered page must produce the same ID.
 */
function compositeSourceIdentity(
  definition: CollectionDefinition,
  record: Record<string, unknown>,
  context: { parentSourceId?: string; index?: number },
): CompositeIdentity | undefined {
  const collection = definition.name.toLowerCase();
  const isDeposit = definition.entityType === "deposit" || collection.includes("securitydeposit") || collection.includes("deposit");
  if (isDeposit) {
    const parentSourceId = stringPart(context.parentSourceId ?? explicitField(
      record,
      "parentSourceId",
      "_parentSourceId",
      "ParentID",
      "ParentId",
      "TenantID",
      "TenantId",
      "tenantId",
    ));
    const accountId = stringPart(explicitField(record, "AccountID", "AccountId", "accountId", "TenantID", "TenantId", "tenantId"));
    const parts = {
      parentSourceId,
      SecurityDepositTypeID: stringPart(explicitField(record, "SecurityDepositTypeID", "SecurityDepositTypeId", "securityDepositTypeId")),
      ChargeTypeID: stringPart(explicitField(record, "ChargeTypeID", "ChargeTypeId", "chargeTypeId")),
      PropertyID: stringPart(explicitField(record, "PropertyID", "PropertyId", "propertyId")),
      AccountID: accountId,
      // RM omits UnitID on some deposit summaries. Preserve that fact in the
      // identity only; never copy the sentinel into the target unit field.
      UnitID: stringPart(explicitField(record, "UnitID", "UnitId", "unitId")) ?? "__NO_UNIT__",
    };
    if (parts.parentSourceId === undefined || parts.SecurityDepositTypeID === undefined || parts.ChargeTypeID === undefined || parts.PropertyID === undefined || parts.AccountID === undefined) return undefined;
    const fields = Object.keys(parts);
    const digest = sha256(canonicalJson(parts));
    return { sourceId: `deposit:composite:${digest}`, digest, fields };
  }

  const isConversation = definition.entityType === "activity"
    && (collection.includes("conversation") || String(definition.path ?? "").toLowerCase().includes("textmessagingconversations"));
  if (isConversation) {
    const parentType = stringPart(explicitField(record, "ParentType", "parentType"));
    const parentId = stringPart(explicitField(record, "ParentID", "ParentId", "parentId", "parentSourceId", "_parentSourceId") ?? context.parentSourceId);
    if (!parentType || !parentId) return undefined;
    const phone = normalizedPhone(explicitField(record, "ExternalPhoneNumber", "externalPhoneNumber"));
    const phoneHash = phone ? sha256(phone) : "none";
    const parts = { ParentType: parentType, ParentID: parentId, ExternalPhoneNumberSha256: phoneHash };
    const fields = ["ParentType", "ParentID", "ExternalPhoneNumber"];
    const digest = sha256(canonicalJson(parts));
    const namespace = definition.sourceIdNamespace ?? "text_conversation";
    return { sourceId: `${namespace}:composite:${digest}`, digest, fields, phoneComponentHashed: Boolean(phone) };
  }
  return undefined;
}

/** Compatibility entrypoint for the RM raw-to-import normalization boundary. */
export {
  normalizeRentManagerExport,
  normalizeRmExport,
} from "./normalizer";
export type {
  NormalizationException,
  NormalizedRentManagerImport,
} from "./normalizer";
