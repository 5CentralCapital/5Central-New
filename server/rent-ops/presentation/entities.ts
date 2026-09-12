import { effectiveScheduleIntervals } from "../domain/invariants";
import { resolveEffectiveScheduleVersions } from "../domain/financial-projection";
import type {
  DashboardSummary,
  RentOpsChargeDefinition,
  RentOpsActivityEvent,
  RentOpsApplication,
  RentOpsApplicationHouseholdMember,
  RentOpsApplicationRecord,
  RentOpsApplicationRequirement,
  RentOpsDocument,
  RentOpsFilters,
  RentOpsHouseholdMembership,
  RentOpsLeaseTerm,
  RentOpsLedgerTransaction,
  RentOpsPaymentAllocation,
  RentOpsPerson,
  RentOpsProperty,
  RentOpsRecurringChargeSchedule,
  RentOpsSecurityDeposit,
  RentOpsSnapshot,
  RentOpsSubsidyContract,
  RentOpsTenancy,
  RentOpsUnit,
  TenantProfile,
} from "../../../shared/rent-ops-contracts";
import {
  booleanValue,
  finiteNumberValue,
  isRecord,
  JsonObject,
  nullableBooleanValue,
  nullableNumberValue,
  nullableStringValue,
  presentationObject,
  recordArrayValue,
  stringArrayValue,
  stringValue,
} from "./allowlist";

function inputOf(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function text(input: JsonObject, field: string): string | undefined {
  return stringValue(input[field]);
}

function number(input: JsonObject, field: string): number | undefined {
  return finiteNumberValue(input[field]);
}

function revision(input: JsonObject): number | undefined {
  const value = number(input, "recordRevision");
  return value !== undefined && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function bool(input: JsonObject, field: string): boolean | undefined {
  return booleanValue(input[field]);
}

function dateText(input: JsonObject, field: string): string | undefined {
  return text(input, field);
}

function nested<T>(input: JsonObject, field: string, serializer: (value: unknown) => T): T | undefined {
  const value = input[field];
  return isRecord(value) ? serializer(value) : undefined;
}

function nestedList<T>(input: JsonObject, field: string, serializer: (value: unknown) => T): T[] {
  return (recordArrayValue(input[field]) ?? []).map(serializer);
}

function textList(input: JsonObject, field: string): string[] | undefined {
  return stringArrayValue(input[field]);
}

export interface AdminAddressView {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
}

export function serializeAddress(value: unknown): AdminAddressView | undefined {
  if (!isRecord(value)) return undefined;
  return presentationObject({
    line1: text(value, "line1"),
    line2: text(value, "line2"),
    city: text(value, "city"),
    state: text(value, "state"),
    postalCode: text(value, "postalCode"),
  });
}

export interface AdminPropertyView {
  recordRevision?: number;
  id?: string;
  name?: string;
  slug?: string;
  address?: AdminAddressView;
  propertyType?: string;
  state?: string;
  operatingContact?: string;
  nameKnowledge?: string;
  addressKnowledge?: string;
  propertyTypeKnowledge?: string;
  stateKnowledge?: string;
  operatingContactKnowledge?: string;
}

export function serializeAdminProperty(value: RentOpsProperty): AdminPropertyView {
  const input = inputOf(value);
  return presentationObject({
    id: text(input, "id"),
    name: text(input, "name"),
    slug: text(input, "slug"),
    address: nested(input, "address", serializeAddress),
    propertyType: text(input, "propertyType"),
    state: text(input, "state"),
    operatingContact: text(input, "operatingContact"),
    nameKnowledge: text(input, "nameKnowledge"),
    addressKnowledge: text(input, "addressKnowledge"),
    propertyTypeKnowledge: text(input, "propertyTypeKnowledge"),
    stateKnowledge: text(input, "stateKnowledge"),
    operatingContactKnowledge: text(input, "operatingContactKnowledge"),
    recordRevision: revision(input),
  });
}

export interface AdminUnitView {
  recordRevision?: number;
  id?: string;
  propertyId?: string;
  unitNumber?: string;
  unitType?: string;
  bedrooms?: number;
  bathrooms?: number;
  squareFeet?: number;
  marketRentCents?: number;
  defaultDepositCents?: number;
  readiness?: string;
  listing?: string;
  amenities?: string[];
  accessNotes?: string;
  propertyLinkKnowledge?: string;
  unitNumberKnowledge?: string;
  unitTypeKnowledge?: string;
  readinessKnowledge?: string;
  listingKnowledge?: string;
}

export function serializeAdminUnit(value: RentOpsUnit): AdminUnitView {
  const input = inputOf(value);
  return presentationObject({
    id: text(input, "id"),
    propertyId: text(input, "propertyId"),
    unitNumber: text(input, "unitNumber"),
    unitType: text(input, "unitType"),
    bedrooms: number(input, "bedrooms"),
    bathrooms: number(input, "bathrooms"),
    squareFeet: number(input, "squareFeet"),
    marketRentCents: number(input, "marketRentCents"),
    defaultDepositCents: number(input, "defaultDepositCents"),
    readiness: text(input, "readiness"),
    listing: text(input, "listing"),
    amenities: textList(input, "amenities"),
    accessNotes: text(input, "accessNotes"),
    propertyLinkKnowledge: text(input, "propertyLinkKnowledge"),
    unitNumberKnowledge: text(input, "unitNumberKnowledge"),
    unitTypeKnowledge: text(input, "unitTypeKnowledge"),
    readinessKnowledge: text(input, "readinessKnowledge"),
    listingKnowledge: text(input, "listingKnowledge"),
    recordRevision: revision(input),
  });
}

export interface AdminPersonView {
  recordRevision?: number;
  id?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  phoneMethods?: Array<{ id?: string; value?: string; type?: string; isPrimary?: boolean; isTextReady?: boolean }>;
  renterInsuranceExpiresOn?: string;
  archived?: boolean | null;
  archivedKnowledge?: string;
  firstNameKnowledge?: string;
  lastNameKnowledge?: string;
  emailKnowledge?: string;
  phoneKnowledge?: string;
}

export function serializeAdminPerson(value: RentOpsPerson): AdminPersonView {
  const input = inputOf(value);
  const phoneMethods = nestedList(input, "phoneMethods", (method) => {
    const item = inputOf(method);
    return presentationObject({
      id: text(item, "id"),
      value: text(item, "value"),
      type: text(item, "type"),
      isPrimary: bool(item, "isPrimary"),
      isTextReady: bool(item, "isTextReady"),
    });
  });
  return presentationObject({
    id: text(input, "id"),
    firstName: text(input, "firstName"),
    lastName: text(input, "lastName"),
    email: text(input, "email"),
    phone: text(input, "phone"),
    phoneMethods: phoneMethods.length ? phoneMethods : undefined,
    renterInsuranceExpiresOn: dateText(input, "renterInsuranceExpiresOn"),
    archived: bool(input, "archived"),
    archivedKnowledge: text(input, "archivedKnowledge"),
    firstNameKnowledge: text(input, "firstNameKnowledge"),
    lastNameKnowledge: text(input, "lastNameKnowledge"),
    emailKnowledge: text(input, "emailKnowledge"),
    phoneKnowledge: text(input, "phoneKnowledge"),
    recordRevision: revision(input),
  });
}

export interface AdminHouseholdMembershipView {
  recordRevision?: number;
  id?: string;
  tenancyId?: string;
  applicationId?: string;
  personId?: string;
  accountPersonId?: string;
  role?: string | null;
  relationship?: string | null;
  isFinanciallyResponsible?: boolean | null;
  roleKnowledge?: string;
  relationshipKnowledge?: string;
  responsibilityKnowledge?: string;
}

export function serializeAdminHouseholdMembership(value: RentOpsHouseholdMembership): AdminHouseholdMembershipView {
  const input = inputOf(value);
  return presentationObject({
    id: text(input, "id"),
    tenancyId: text(input, "tenancyId"),
    applicationId: text(input, "applicationId"),
    accountPersonId: text(input, "accountPersonId"),
    personId: text(input, "personId"),
    role: text(input, "role"),
    relationship: text(input, "relationship"),
    isFinanciallyResponsible: bool(input, "isFinanciallyResponsible"),
    roleKnowledge: text(input, "roleKnowledge"),
    relationshipKnowledge: text(input, "relationshipKnowledge"),
    responsibilityKnowledge: text(input, "responsibilityKnowledge"),
    recordRevision: revision(input),
  });
}

export interface AdminTenancyView {
  recordRevision?: number;
  id?: string;
  propertyId?: string;
  unitId?: string;
  primaryPersonId?: string;
  status?: string;
  actualMoveInOn?: string;
  noticeOn?: string;
  expectedMoveOutOn?: string;
  actualMoveOutOn?: string;
  createdAt?: string;
  endedAt?: string;
  applicationId?: string;
  plannedMoveInOn?: string;
  propertyLinkKnowledge?: string;
  unitLinkKnowledge?: string;
  primaryPersonLinkKnowledge?: string;
  statusKnowledge?: string;
  plannedMoveInKnowledge?: string;
  actualMoveInKnowledge?: string;
  noticeKnowledge?: string;
  expectedMoveOutKnowledge?: string;
  actualMoveOutKnowledge?: string;
  createdAtKnowledge?: string;
  endedAtKnowledge?: string;
}

export function serializeAdminTenancy(value: RentOpsTenancy): AdminTenancyView {
  const input = inputOf(value);
  return presentationObject({
    id: text(input, "id"),
    propertyId: text(input, "propertyId"),
    unitId: text(input, "unitId"),
    primaryPersonId: text(input, "primaryPersonId"),
    status: text(input, "status"),
    plannedMoveInOn: dateText(input, "plannedMoveInOn"),
    actualMoveInOn: dateText(input, "actualMoveInOn"),
    noticeOn: dateText(input, "noticeOn"),
    expectedMoveOutOn: dateText(input, "expectedMoveOutOn"),
    actualMoveOutOn: dateText(input, "actualMoveOutOn"),
    createdAt: dateText(input, "createdAt"),
    endedAt: dateText(input, "endedAt"),
    applicationId: text(input, "applicationId"),
    propertyLinkKnowledge: text(input, "propertyLinkKnowledge"),
    unitLinkKnowledge: text(input, "unitLinkKnowledge"),
    primaryPersonLinkKnowledge: text(input, "primaryPersonLinkKnowledge"),
    statusKnowledge: text(input, "statusKnowledge"),
    plannedMoveInKnowledge: text(input, "plannedMoveInKnowledge"),
    actualMoveInKnowledge: text(input, "actualMoveInKnowledge"),
    noticeKnowledge: text(input, "noticeKnowledge"),
    expectedMoveOutKnowledge: text(input, "expectedMoveOutKnowledge"),
    actualMoveOutKnowledge: text(input, "actualMoveOutKnowledge"),
    createdAtKnowledge: text(input, "createdAtKnowledge"),
    endedAtKnowledge: text(input, "endedAtKnowledge"),
    recordRevision: revision(input),
  });
}

export interface AdminLeaseTermView {
  recordRevision?: number;
  id?: string;
  tenancyId?: string;
  status?: string;
  contractStartOn?: string;
  contractEndOn?: string;
  monthToMonth?: boolean;
  signedOn?: string;
  executedDocumentId?: string;
  renewalOfId?: string;
  createdAt?: string;
  tenancyLinkKnowledge?: string;
  statusKnowledge?: string;
  contractStartKnowledge?: string;
  contractEndKnowledge?: string;
  signedOnKnowledge?: string;
  monthToMonthKnowledge?: string;
  createdAtKnowledge?: string;
}

export function serializeAdminLeaseTerm(value: RentOpsLeaseTerm): AdminLeaseTermView {
  const input = inputOf(value);
  return presentationObject({
    id: text(input, "id"),
    tenancyId: text(input, "tenancyId"),
    status: text(input, "status"),
    contractStartOn: dateText(input, "contractStartOn"),
    contractEndOn: dateText(input, "contractEndOn"),
    monthToMonth: bool(input, "monthToMonth"),
    signedOn: dateText(input, "signedOn"),
    executedDocumentId: text(input, "executedDocumentId"),
    renewalOfId: text(input, "renewalOfId"),
    createdAt: dateText(input, "createdAt"),
    tenancyLinkKnowledge: text(input, "tenancyLinkKnowledge"),
    statusKnowledge: text(input, "statusKnowledge"),
    contractStartKnowledge: text(input, "contractStartKnowledge"),
    contractEndKnowledge: text(input, "contractEndKnowledge"),
    signedOnKnowledge: text(input, "signedOnKnowledge"),
    monthToMonthKnowledge: text(input, "monthToMonthKnowledge"),
    createdAtKnowledge: text(input, "createdAtKnowledge"),
    recordRevision: revision(input),
  });
}

export interface AdminRecurringScheduleView {
  resolvedEffectiveTo?: string | null;
  lineageState?: "valid" | "unknown";
  canScheduleSuccessor?: boolean;
  /** Opaque target definition ID; never the provider source ID or key. */
  chargeDefinitionId?: string | null;
  billingFrequency?: string | null;
  recordRevision?: number;
  id?: string;
  scopeType?: string | null;
  scopeId?: string | null;
  tenancyId?: string | null;
  personId?: string | null;
  propertyId?: string | null;
  unitId?: string | null;
  category?: string | null;
  description?: string | null;
  descriptionKnowledge?: string | null;
  amountCents?: number | null;
  effectiveFrom?: string | null;
  effectiveFromKnowledge?: string | null;
  effectiveTo?: string | null;
  active?: boolean | null;
  activeKnowledge?: string | null;
  sourceConfidence?: string | null;
  chargeDefinitionKnowledge?: string | null;
}

export function serializeAdminRecurringSchedule(value: RentOpsRecurringChargeSchedule): AdminRecurringScheduleView {
  const input = inputOf(value);
  return presentationObject({
    chargeDefinitionId: nullableStringValue(input.chargeDefinitionId),
    billingFrequency: nullableStringValue(input.billingFrequency),
    id: text(input, "id"),
    scopeType: nullableStringValue(input.scopeType),
    scopeId: nullableStringValue(input.scopeId),
    tenancyId: nullableStringValue(input.tenancyId),
    personId: nullableStringValue(input.personId),
    propertyId: nullableStringValue(input.propertyId),
    unitId: nullableStringValue(input.unitId),
    category: nullableStringValue(input.category),
    description: nullableStringValue(input.description),
    descriptionKnowledge: nullableStringValue(input.descriptionKnowledge),
    amountCents: nullableNumberValue(input.amountCents),
    effectiveFrom: nullableStringValue(input.effectiveFrom),
    effectiveFromKnowledge: nullableStringValue(input.effectiveFromKnowledge),
    effectiveTo: nullableStringValue(input.effectiveTo),
    active: nullableBooleanValue(input.active),
    activeKnowledge: nullableStringValue(input.activeKnowledge),
    sourceConfidence: nullableStringValue(input.sourceConfidence),
    chargeDefinitionKnowledge: nullableStringValue(input.chargeDefinitionKnowledge),
    recordRevision: revision(input),
  });
}

/** Derive display boundaries from the complete lineage before filtering rows. */
export function serializeAdminRecurringSchedules(rows: RentOpsRecurringChargeSchedule[], completeSchedules = rows): AdminRecurringScheduleView[] {
  const intervals = effectiveScheduleIntervals(completeSchedules);
  const invalidIds = new Set(resolveEffectiveScheduleVersions(completeSchedules, "9999-12", { strictLineage: true }).invalidSchedules.map(row => row.id));
  const byId = new Map(completeSchedules.map(row => [row.id, row]));
  const successors = new Set(completeSchedules.flatMap(row => row.supersedesId ? [row.supersedesId] : []));
  return rows.map(row => {
    const source = byId.get(row.id);
    const interval = source ? intervals.get(source) : undefined;
    const valid = Boolean(source && interval && !invalidIds.has(row.id));
    const trustedLinks = source && (source.scopeTypeKnowledge === "source" || source.scopeTypeKnowledge === "manual")
      && (source.scopeLinkKnowledge === "exact" || source.scopeLinkKnowledge === "manual")
      && (source.chargeDefinitionLinkKnowledge === "exact" || source.chargeDefinitionLinkKnowledge === "manual");
    return presentationObject({
      ...serializeAdminRecurringSchedule(row),
      resolvedEffectiveTo: valid ? interval!.effectiveTo ?? null : null,
      lineageState: valid ? "valid" as const : "unknown" as const,
      canScheduleSuccessor: Boolean(valid && source && !successors.has(source.id) && source.versionAction !== "end"
        && source.scopeType && source.scopeId && source.propertyId && source.chargeDefinitionId && source.category != null && trustedLinks),
    });
  });
}

/**
 * Positive admin DTO for the operational charge-definition catalog. The
 * importer source row, source key, artifact binding, and crosswalk are never
 * copied into this view. The opaque target id is the only identity exposed so
 * an administrator can explicitly select a definition for a new schedule or
 * application conversion.
 */
export interface AdminChargeDefinitionView {
  id?: string;
  displayName?: string | null;
  displayNameKnowledge?: string | null;
  category?: string | null;
  categoryKnowledge?: string | null;
  active?: boolean | null;
  activeKnowledge?: string | null;
  recordRevision?: number;
}

export function serializeAdminChargeDefinition(value: RentOpsChargeDefinition): AdminChargeDefinitionView {
  const input = inputOf(value);
  return presentationObject({
    id: text(input, "id"),
    displayName: nullableStringValue(input.displayName),
    displayNameKnowledge: nullableStringValue(input.displayNameKnowledge),
    category: nullableStringValue(input.category),
    categoryKnowledge: nullableStringValue(input.categoryKnowledge),
    active: nullableBooleanValue(input.active),
    activeKnowledge: nullableStringValue(input.activeKnowledge),
    recordRevision: revision(input),
  });
}

export interface AdminLedgerTransactionView {
  id?: string;
  propertyId?: string;
  unitId?: string;
  tenancyId?: string;
  personId?: string;
  kind?: string;
  category?: string;
  status?: string;
  amountCents?: number;
  postedOn?: string;
  dueOn?: string;
  paymentMethod?: string;
  description?: string;
  reversalOfId?: string;
  payer?: string;
  adjustmentDirection?: string;
  propertyLinkKnowledge?: string;
  unitLinkKnowledge?: string;
  tenancyLinkKnowledge?: string;
  personLinkKnowledge?: string;
  amountKnowledge?: string;
  postedOnKnowledge?: string;
  dueOnKnowledge?: string;
  descriptionKnowledge?: string;
  statusKnowledge?: string;
  allocationMode?: string;
}

export function serializeAdminLedgerTransaction(value: RentOpsLedgerTransaction): AdminLedgerTransactionView {
  const input = inputOf(value);
  return presentationObject({
    id: text(input, "id"),
    propertyId: text(input, "propertyId"),
    unitId: text(input, "unitId"),
    tenancyId: text(input, "tenancyId"),
    personId: text(input, "personId"),
    kind: text(input, "kind"),
    category: text(input, "category"),
    status: text(input, "status"),
    amountCents: number(input, "amountCents"),
    postedOn: dateText(input, "postedOn"),
    dueOn: dateText(input, "dueOn"),
    paymentMethod: text(input, "paymentMethod"),
    description: text(input, "description"),
    reversalOfId: text(input, "reversalOfId"),
    payer: text(input, "payer"),
    adjustmentDirection: text(input, "adjustmentDirection"),
    propertyLinkKnowledge: text(input, "propertyLinkKnowledge"),
    unitLinkKnowledge: text(input, "unitLinkKnowledge"),
    tenancyLinkKnowledge: text(input, "tenancyLinkKnowledge"),
    personLinkKnowledge: text(input, "personLinkKnowledge"),
    amountKnowledge: text(input, "amountKnowledge"),
    postedOnKnowledge: text(input, "postedOnKnowledge"),
    dueOnKnowledge: text(input, "dueOnKnowledge"),
    descriptionKnowledge: text(input, "descriptionKnowledge"),
    statusKnowledge: text(input, "statusKnowledge"),
    allocationMode: text(input, "allocationMode"),
  });
}

export interface AdminPaymentAllocationView {
  id?: string;
  kind?: string;
  paymentTransactionId?: string;
  chargeTransactionId?: string;
  amountCents?: number;
  allocatedOn?: string;
  paymentLinkKnowledge?: string;
  chargeLinkKnowledge?: string;
  amountKnowledge?: string;
  allocatedOnKnowledge?: string;
}

export function serializeAdminPaymentAllocation(value: RentOpsPaymentAllocation): AdminPaymentAllocationView {
  const input = inputOf(value);
  return presentationObject({
    id: text(input, "id"),
    kind: text(input, "kind"),
    paymentTransactionId: text(input, "paymentTransactionId"),
    chargeTransactionId: text(input, "chargeTransactionId"),
    amountCents: number(input, "amountCents"),
    allocatedOn: dateText(input, "allocatedOn"),
    paymentLinkKnowledge: text(input, "paymentLinkKnowledge"),
    chargeLinkKnowledge: text(input, "chargeLinkKnowledge"),
    amountKnowledge: text(input, "amountKnowledge"),
    allocatedOnKnowledge: text(input, "allocatedOnKnowledge"),
  });
}

export interface AdminSecurityDepositView {
  recordRevision?: number;
  id?: string;
  propertyId?: string;
  propertyLinkKnowledge?: string;
  unitId?: string;
  unitLinkKnowledge?: string;
  tenancyId?: string;
  personId?: string;
  personLinkKnowledge?: string;
  type?: string;
  typeKnowledge?: string;
  amountHeldCents?: number | null;
  sourceBalanceCents?: number | null;
  receivedOn?: string;
  receivedOnKnowledge?: string;
  dispositionStatus?: string;
  dispositionStatusKnowledge?: string;
  disposedOn?: string;
  dispositionNotes?: string;
}

export function serializeAdminSecurityDeposit(value: RentOpsSecurityDeposit): AdminSecurityDepositView {
  const input = inputOf(value);
  return presentationObject({
    id: text(input, "id"),
    propertyId: text(input, "propertyId"),
    propertyLinkKnowledge: text(input, "propertyLinkKnowledge"),
    unitId: text(input, "unitId"),
    unitLinkKnowledge: text(input, "unitLinkKnowledge"),
    tenancyId: text(input, "tenancyId"),
    personId: text(input, "personId"),
    personLinkKnowledge: text(input, "personLinkKnowledge"),
    type: text(input, "type"),
    typeKnowledge: text(input, "typeKnowledge"),
    amountHeldCents: input.amountHeldCents === null ? null : number(input, "amountHeldCents"),
    sourceBalanceCents: number(input, "sourceBalanceCents"),
    receivedOn: dateText(input, "receivedOn"),
    receivedOnKnowledge: text(input, "receivedOnKnowledge"),
    dispositionStatus: text(input, "dispositionStatus"),
    dispositionStatusKnowledge: text(input, "dispositionStatusKnowledge"),
    disposedOn: dateText(input, "disposedOn"),
    dispositionNotes: text(input, "dispositionNotes"),
    recordRevision: revision(input),
  });
}

export interface AdminSubsidyContractView {
  recordRevision?: number;
  id?: string;
  propertyId?: string;
  unitId?: string;
  tenancyId?: string;
  agencyName?: string;
  contractNumber?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  agencyObligationCents?: number;
  tenantObligationCents?: number;
  status?: string;
  statusKnowledge?: string;
}

export function serializeAdminSubsidyContract(value: RentOpsSubsidyContract): AdminSubsidyContractView {
  const input = inputOf(value);
  return presentationObject({
    id: text(input, "id"),
    propertyId: text(input, "propertyId"),
    unitId: text(input, "unitId"),
    tenancyId: text(input, "tenancyId"),
    agencyName: text(input, "agencyName"),
    contractNumber: text(input, "contractNumber"),
    effectiveFrom: dateText(input, "effectiveFrom"),
    effectiveTo: dateText(input, "effectiveTo"),
    agencyObligationCents: number(input, "agencyObligationCents"),
    tenantObligationCents: number(input, "tenantObligationCents"),
    status: text(input, "status"),
    statusKnowledge: text(input, "statusKnowledge"),
    recordRevision: revision(input),
  });
}

export interface RentalHistoryView {
  currentAddress?: string;
  priorAddress?: string;
  landlordName?: string;
  landlordContact?: string;
  reasonForMoving?: string;
}

export function serializeRentalHistory(value: unknown): RentalHistoryView | undefined {
  if (!isRecord(value)) return undefined;
  return presentationObject({
    currentAddress: text(value, "currentAddress"),
    priorAddress: text(value, "priorAddress"),
    landlordName: text(value, "landlordName"),
    landlordContact: text(value, "landlordContact"),
    reasonForMoving: text(value, "reasonForMoving"),
  });
}

export interface EmploymentView {
  employerName?: string;
  jobTitle?: string;
  monthlyIncomeCents?: number;
  employmentStartOn?: string;
}

export function serializeEmployment(value: unknown): EmploymentView | undefined {
  if (!isRecord(value)) return undefined;
  return presentationObject({
    employerName: text(value, "employerName"),
    jobTitle: text(value, "jobTitle"),
    monthlyIncomeCents: number(value, "monthlyIncomeCents"),
    employmentStartOn: dateText(value, "employmentStartOn"),
  });
}

export interface HouseholdSummaryView {
  adults?: number;
  children?: number;
  totalOccupants?: number;
}

export function serializeHouseholdSummary(value: unknown): HouseholdSummaryView | undefined {
  if (!isRecord(value)) return undefined;
  return presentationObject({ adults: number(value, "adults"), children: number(value, "children"), totalOccupants: number(value, "totalOccupants") });
}

export interface ApplicationPreferencesView {
  desiredMoveInOn?: string;
  desiredLeaseMonths?: number;
  maxRentCents?: number;
  bedrooms?: number;
}

export function serializeApplicationPreferences(value: unknown): ApplicationPreferencesView | undefined {
  if (!isRecord(value)) return undefined;
  return presentationObject({
    desiredMoveInOn: dateText(value, "desiredMoveInOn"),
    desiredLeaseMonths: number(value, "desiredLeaseMonths"),
    maxRentCents: number(value, "maxRentCents"),
    bedrooms: number(value, "bedrooms"),
  });
}

export interface VoucherView {
  hasVoucher?: boolean;
  agencyName?: string;
  caseNumber?: string;
  tenantPortionCents?: number;
}

export function serializeVoucher(value: unknown): VoucherView | undefined {
  if (!isRecord(value)) return undefined;
  return presentationObject({
    hasVoucher: bool(value, "hasVoucher"),
    agencyName: text(value, "agencyName"),
    caseNumber: text(value, "caseNumber"),
    tenantPortionCents: number(value, "tenantPortionCents"),
  });
}

export interface PetView {
  type?: string;
  name?: string;
  weightLb?: number;
}

export function serializePet(value: unknown): PetView {
  const input = inputOf(value);
  return presentationObject({ type: text(input, "type"), name: text(input, "name"), weightLb: number(input, "weightLb") });
}

export interface VehicleView {
  makeModel?: string;
  plateState?: string;
  plateLastFour?: string;
}

export function serializeVehicle(value: unknown): VehicleView {
  const input = inputOf(value);
  return presentationObject({ makeModel: text(input, "makeModel"), plateState: text(input, "plateState"), plateLastFour: text(input, "plateLastFour") });
}

export interface EmergencyContactView {
  name?: string;
  phone?: string;
  relationship?: string;
}

export function serializeEmergencyContact(value: unknown): EmergencyContactView | undefined {
  if (!isRecord(value)) return undefined;
  return presentationObject({ name: text(value, "name"), phone: text(value, "phone"), relationship: text(value, "relationship") });
}

export interface AdminApplicationHouseholdMemberView {
  id?: string;
  applicationId?: string;
  firstName?: string;
  lastName?: string;
  relationship?: string;
  email?: string;
  phone?: string;
  isMinor?: boolean;
}

export function serializeAdminApplicationHouseholdMember(value: RentOpsApplicationHouseholdMember): AdminApplicationHouseholdMemberView {
  const input = inputOf(value);
  return presentationObject({
    id: text(input, "id"),
    applicationId: text(input, "applicationId"),
    firstName: text(input, "firstName"),
    lastName: text(input, "lastName"),
    relationship: text(input, "relationship"),
    email: text(input, "email"),
    phone: text(input, "phone"),
    isMinor: bool(input, "isMinor"),
  });
}

export interface AdminApplicationRequirementView {
  id?: string;
  applicationId?: string;
  label?: string;
  status?: string;
  documentId?: string;
  requestedOn?: string;
  resolvedOn?: string;
}

export function serializeAdminApplicationRequirement(value: RentOpsApplicationRequirement): AdminApplicationRequirementView {
  const input = inputOf(value);
  // `key` is intentionally omitted. It is an internal requirement identity
  // and is also one of the classes of fields forbidden at this boundary.
  return presentationObject({
    id: text(input, "id"),
    applicationId: text(input, "applicationId"),
    label: text(input, "label"),
    status: text(input, "status"),
    documentId: text(input, "documentId"),
    requestedOn: dateText(input, "requestedOn"),
    resolvedOn: dateText(input, "resolvedOn"),
  });
}

export interface AdminDocumentView {
  recordRevision?: number;
  id?: string;
  propertyId?: string;
  unitId?: string;
  personId?: string;
  tenancyId?: string;
  applicationId?: string;
  type?: string;
  state?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  uploadedAt?: string;
  verifiedAt?: string;
  availability?: string;
  downloadAvailable: boolean;
}

/**
 * A storage reference alone is not evidence that a browser can download a
 * document. Metadata-only and applicant-pending rows deliberately carry an
 * internal placeholder key. Only a verified document with a persisted
 * checksum/binding, verification timestamp, and storage reference is marked
 * available; those internal values never leave this serializer.
 */
export function documentDownloadAvailable(value: unknown): boolean {
  const input = inputOf(value);
  const state = text(input, "state");
  const availability = text(input, "availability");
  const storageReference = text(input, "storageKey");
  const checksum = text(input, "checksumSha256");
  const verifiedAt = dateText(input, "verifiedAt");
  const storageKnowledge = text(input, "storageKeyKnowledge");
  const verifiedState = state === "verified" && availability === "verified";
  const verifiedBinding = storageKnowledge === "source";
  return verifiedState
    && Boolean(storageReference && checksum && verifiedAt)
    && verifiedBinding;
}

/** Document metadata is safe only after storage/provenance fields are gone. */
export function serializeAdminDocument(value: RentOpsDocument): AdminDocumentView {
  const input = inputOf(value);
  return presentationObject({
    id: text(input, "id"),
    propertyId: text(input, "propertyId"),
    unitId: text(input, "unitId"),
    personId: text(input, "personId"),
    tenancyId: text(input, "tenancyId"),
    applicationId: text(input, "applicationId"),
    type: text(input, "type"),
    state: text(input, "state"),
    fileName: text(input, "fileName"),
    mimeType: text(input, "mimeType"),
    sizeBytes: number(input, "sizeBytes"),
    uploadedAt: dateText(input, "uploadedAt"),
    verifiedAt: dateText(input, "verifiedAt"),
    availability: text(input, "availability"),
    downloadAvailable: documentDownloadAvailable(value),
    recordRevision: revision(input),
  });
}

export interface AdminActivityView {
  recordRevision?: number;
  id?: string;
  propertyId?: string;
  unitId?: string;
  personId?: string;
  tenancyId?: string;
  applicationId?: string;
  type?: string;
  occurredAt?: string;
  actor?: string;
  summary?: string;
  detail?: string;
  occurredAtKnowledge?: string;
  actorKnowledge?: string;
  summaryKnowledge?: string;
  typeKnowledge?: string;
  propertyLinkKnowledge?: string;
  unitLinkKnowledge?: string;
  personLinkKnowledge?: string;
  tenancyLinkKnowledge?: string;
  applicationLinkKnowledge?: string;
}

export function serializeAdminActivity(value: RentOpsActivityEvent): AdminActivityView {
  const input = inputOf(value);
  return presentationObject({
    id: text(input, "id"),
    propertyId: text(input, "propertyId"),
    unitId: text(input, "unitId"),
    personId: text(input, "personId"),
    tenancyId: text(input, "tenancyId"),
    applicationId: text(input, "applicationId"),
    type: text(input, "type"),
    occurredAt: dateText(input, "occurredAt"),
    actor: text(input, "actor"),
    summary: text(input, "summary"),
    detail: text(input, "detail"),
    occurredAtKnowledge: text(input, "occurredAtKnowledge"),
    actorKnowledge: text(input, "actorKnowledge"),
    summaryKnowledge: text(input, "summaryKnowledge"),
    typeKnowledge: text(input, "typeKnowledge"),
    propertyLinkKnowledge: text(input, "propertyLinkKnowledge"),
    unitLinkKnowledge: text(input, "unitLinkKnowledge"),
    personLinkKnowledge: text(input, "personLinkKnowledge"),
    tenancyLinkKnowledge: text(input, "tenancyLinkKnowledge"),
    applicationLinkKnowledge: text(input, "applicationLinkKnowledge"),
    recordRevision: revision(input),
  });
}

export interface AdminApplicationView {
  recordRevision?: number;
  id?: string;
  sourceType?: string;
  status?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  propertyId?: string;
  unitId?: string;
  submittedOn?: string;
  certificationAcceptedOn?: string;
  convertedTenancyId?: string;
  createdAt?: string;
  updatedAt?: string;
  rentalHistory?: RentalHistoryView;
  employment?: EmploymentView;
  householdSummary?: HouseholdSummaryView;
  preferences?: ApplicationPreferencesView;
  voucher?: VoucherView;
  pets?: PetView[];
  vehicles?: VehicleView[];
  emergencyContact?: EmergencyContactView;
  sourceTypeKnowledge?: string;
  statusKnowledge?: string;
  emailKnowledge?: string;
  firstNameKnowledge?: string;
  lastNameKnowledge?: string;
  phoneKnowledge?: string;
  propertyLinkKnowledge?: string;
  unitLinkKnowledge?: string;
  submittedOnKnowledge?: string;
  certificationAcceptedOnKnowledge?: string;
  createdAtKnowledge?: string;
  updatedAtKnowledge?: string;
}

export function serializeAdminApplication(value: RentOpsApplication | RentOpsApplicationRecord): AdminApplicationView {
  const input = inputOf(value);
  const pets = recordArrayValue(input.pets)?.map(serializePet);
  const vehicles = recordArrayValue(input.vehicles)?.map(serializeVehicle);
  return presentationObject({
    id: text(input, "id"),
    sourceType: text(input, "sourceType"),
    status: text(input, "status"),
    email: text(input, "email"),
    firstName: text(input, "firstName"),
    lastName: text(input, "lastName"),
    phone: text(input, "phone"),
    propertyId: text(input, "propertyId"),
    unitId: text(input, "unitId"),
    submittedOn: dateText(input, "submittedOn"),
    certificationAcceptedOn: dateText(input, "certificationAcceptedOn"),
    convertedTenancyId: text(input, "convertedTenancyId"),
    createdAt: dateText(input, "createdAt"),
    updatedAt: dateText(input, "updatedAt"),
    rentalHistory: nested(input, "rentalHistory", serializeRentalHistory),
    employment: nested(input, "employment", serializeEmployment),
    householdSummary: nested(input, "householdSummary", serializeHouseholdSummary),
    preferences: nested(input, "preferences", serializeApplicationPreferences),
    voucher: nested(input, "voucher", serializeVoucher),
    pets,
    vehicles,
    emergencyContact: nested(input, "emergencyContact", serializeEmergencyContact),
    sourceTypeKnowledge: text(input, "sourceTypeKnowledge"),
    statusKnowledge: text(input, "statusKnowledge"),
    emailKnowledge: text(input, "emailKnowledge"),
    firstNameKnowledge: text(input, "firstNameKnowledge"),
    lastNameKnowledge: text(input, "lastNameKnowledge"),
    phoneKnowledge: text(input, "phoneKnowledge"),
    propertyLinkKnowledge: text(input, "propertyLinkKnowledge"),
    unitLinkKnowledge: text(input, "unitLinkKnowledge"),
    submittedOnKnowledge: text(input, "submittedOnKnowledge"),
    certificationAcceptedOnKnowledge: text(input, "certificationAcceptedOnKnowledge"),
    createdAtKnowledge: text(input, "createdAtKnowledge"),
    updatedAtKnowledge: text(input, "updatedAtKnowledge"),
    recordRevision: revision(input),
  });
}

export const serializeAdminApplicationRecord = serializeAdminApplication;

export interface AdminApplicationViewWithRecords extends AdminApplicationView {
  householdMembers: AdminApplicationHouseholdMemberView[];
  requirements: AdminApplicationRequirementView[];
  documents: AdminDocumentView[];
}

export interface AdminApplicationContext {
  application: RentOpsApplication | RentOpsApplicationRecord;
  householdMembers?: RentOpsApplicationHouseholdMember[];
  requirements?: RentOpsApplicationRequirement[];
  documents?: RentOpsDocument[];
}

export function serializeAdminApplicationView(input: AdminApplicationContext): AdminApplicationViewWithRecords {
  return presentationObject({
    ...serializeAdminApplication(input.application),
    householdMembers: (input.householdMembers ?? []).map(serializeAdminApplicationHouseholdMember),
    requirements: (input.requirements ?? []).map(serializeAdminApplicationRequirement),
    documents: (input.documents ?? []).map(serializeAdminDocument),
  });
}

export interface AdminDashboardSummaryView {
  balanceComplete?: boolean;
  balanceUncertaintyCodes?: string[];
  balanceUnresolvedCount?: number;
  asOfDate?: string;
  propertyCount?: number;
  unitCount?: number;
  occupiedUnits?: number;
  futurePreleasedUnits?: number;
  genuineVacantUnits?: number;
  readyVacantUnits?: number;
  notReadyUnits?: number;
  offMarketUnits?: number;
  physicalOccupancyPercent?: number;
  scheduledRentCents?: number;
  scheduledRentConfirmedCents?: number;
  scheduledRentUnresolvedCount?: number;
  scheduledRentComplete?: boolean;
  scheduledRentCadenceComplete?: boolean;
  collectedRentCents?: number;
  rentOnlyDelinquencyCents?: number | null;
  totalDelinquencyCents?: number | null;
  unappliedCashCents?: number | null;
  expiringIn30Days?: number;
  expiringIn60Days?: number;
  expiringIn90Days?: number;
  monthToMonthCount?: number;
  applicationsSubmitted?: number;
  applicationsMissingInformation?: number;
  securityDepositLiabilityCents?: number | null;
  drilldowns?: Record<string, { report?: string; filters?: JsonObject }>;
}

const DASHBOARD_DRILLDOWN_KEYS = [
  "occupiedUnits",
  "futurePreleasedUnits",
  "genuineVacantUnits",
  "rentOnlyDelinquencyCents",
  "securityDepositLiabilityCents",
] as const;

const REPORT_NAMES = [
  "rent-roll",
  "occupancy",
  "scheduled-income",
  "collected-income",
  "scheduled-vs-collected",
  "delinquency",
  "tenant-ledger",
  "lease-expirations",
  "lease-expiration",
  "deposits",
  "security-deposit",
  "applicant-pipeline",
  "hap",
] as const;

function reportName(value: unknown): string | undefined {
  const candidate = stringValue(value);
  return candidate && (REPORT_NAMES as readonly string[]).includes(candidate) ? candidate : undefined;
}

function serializeFilterValue(value: unknown): JsonObject {
  const input = inputOf(value);
  const allowedArray = (field: string, values: readonly string[]): string[] | undefined => {
    const items = stringArrayValue(input[field]);
    return items?.filter((item) => values.includes(item));
  };
  return presentationObject({
    propertyScope: ["active", "all"].includes(text(input, "propertyScope") ?? "") ? text(input, "propertyScope") : undefined,
    propertyId: text(input, "propertyId"),
    unitId: text(input, "unitId"),
    tenancyId: text(input, "tenancyId"),
    personId: text(input, "personId"),
    asOfDate: dateText(input, "asOfDate"),
    fromDate: dateText(input, "fromDate"),
    toDate: dateText(input, "toDate"),
    month: dateText(input, "month"),
    occupancy: allowedArray("occupancy", ["current", "future_preleased", "vacant", "unknown"]),
    readiness: allowedArray("readiness", ["ready", "not_ready", "off_market"]),
    listing: allowedArray("listing", ["listed", "unlisted", "off_market"]),
    balanceStatus: ["all", "due", "credit", "zero"].includes(text(input, "balanceStatus") ?? "") ? text(input, "balanceStatus") : undefined,
    status: stringArrayValue(input.status),
    search: text(input, "search"),
  });
}

export function serializeFilters(value: RentOpsFilters | unknown): JsonObject {
  return serializeFilterValue(value);
}

export function serializeDashboardSummary(value: DashboardSummary): AdminDashboardSummaryView {
  const input = inputOf(value);
  const sourceDrilldowns = input.drilldowns;
  const drilldowns: Record<string, JsonObject> = {};
  if (isRecord(sourceDrilldowns)) {
    for (const key of DASHBOARD_DRILLDOWN_KEYS) {
      const candidate = sourceDrilldowns[key];
      if (!isRecord(candidate)) continue;
      const report = reportName(candidate.report);
      drilldowns[key] = presentationObject({ report, filters: serializeFilterValue(candidate.filters) });
    }
  }
  return presentationObject({
    asOfDate: dateText(input, "asOfDate"),
    propertyCount: number(input, "propertyCount"),
    unitCount: number(input, "unitCount"),
    occupiedUnits: number(input, "occupiedUnits"),
    futurePreleasedUnits: number(input, "futurePreleasedUnits"),
    genuineVacantUnits: number(input, "genuineVacantUnits"),
    readyVacantUnits: number(input, "readyVacantUnits"),
    notReadyUnits: number(input, "notReadyUnits"),
    offMarketUnits: number(input, "offMarketUnits"),
    physicalOccupancyPercent: number(input, "physicalOccupancyPercent"),
    scheduledRentCents: number(input, "scheduledRentCents"),
    scheduledRentConfirmedCents: number(input, "scheduledRentConfirmedCents"),
    scheduledRentUnresolvedCount: number(input, "scheduledRentUnresolvedCount"),
    scheduledRentComplete: bool(input, "scheduledRentComplete"),
    scheduledRentCadenceComplete: bool(input, "scheduledRentCadenceComplete"),
    collectedRentCents: number(input, "collectedRentCents"),
    balanceComplete: bool(input, "balanceComplete"),
    balanceUncertaintyCodes: stringArrayValue(input.balanceUncertaintyCodes),
    balanceUnresolvedCount: number(input, "balanceUnresolvedCount"),
    rentOnlyDelinquencyCents: nullableNumberValue(input.rentOnlyDelinquencyCents),
    totalDelinquencyCents: nullableNumberValue(input.totalDelinquencyCents),
    unappliedCashCents: nullableNumberValue(input.unappliedCashCents),
    expiringIn30Days: number(input, "expiringIn30Days"),
    expiringIn60Days: number(input, "expiringIn60Days"),
    expiringIn90Days: number(input, "expiringIn90Days"),
    monthToMonthCount: number(input, "monthToMonthCount"),
    applicationsSubmitted: number(input, "applicationsSubmitted"),
    applicationsMissingInformation: number(input, "applicationsMissingInformation"),
    securityDepositLiabilityCents: input.securityDepositLiabilityCents === null ? null : number(input, "securityDepositLiabilityCents"),
    drilldowns,
  });
}

export const serializeAdminDashboardSummary = serializeDashboardSummary;

export interface AdminSnapshotView {
  properties: AdminPropertyView[];
  units: AdminUnitView[];
  people: AdminPersonView[];
  householdMemberships: AdminHouseholdMembershipView[];
  tenancies: AdminTenancyView[];
  leaseTerms: AdminLeaseTermView[];
  recurringSchedules: AdminRecurringScheduleView[];
  ledgerTransactions: AdminLedgerTransactionView[];
  paymentAllocations: AdminPaymentAllocationView[];
  securityDeposits: AdminSecurityDepositView[];
  subsidyContracts: AdminSubsidyContractView[];
  applications: AdminApplicationView[];
  applicationHouseholdMembers: AdminApplicationHouseholdMemberView[];
  applicationRequirements: AdminApplicationRequirementView[];
  documents: AdminDocumentView[];
  activityEvents: AdminActivityView[];
}

/** Snapshot arrays deliberately exclude source records and import runs. */
export function serializeAdminSnapshot(value: RentOpsSnapshot): AdminSnapshotView {
  const input = inputOf(value);
  return presentationObject({
    properties: (recordArrayValue(input.properties) ?? []).map((item) => serializeAdminProperty(item as unknown as RentOpsProperty)),
    units: (recordArrayValue(input.units) ?? []).map((item) => serializeAdminUnit(item as unknown as RentOpsUnit)),
    people: (recordArrayValue(input.people) ?? []).map((item) => serializeAdminPerson(item as unknown as RentOpsPerson)),
    householdMemberships: (recordArrayValue(input.householdMemberships) ?? []).map((item) => serializeAdminHouseholdMembership(item as unknown as RentOpsHouseholdMembership)),
    tenancies: (recordArrayValue(input.tenancies) ?? []).map((item) => serializeAdminTenancy(item as unknown as RentOpsTenancy)),
    leaseTerms: (recordArrayValue(input.leaseTerms) ?? []).map((item) => serializeAdminLeaseTerm(item as unknown as RentOpsLeaseTerm)),
    recurringSchedules: serializeAdminRecurringSchedules((recordArrayValue(input.recurringSchedules) ?? []) as unknown as RentOpsRecurringChargeSchedule[]),
    ledgerTransactions: (recordArrayValue(input.ledgerTransactions) ?? []).map((item) => serializeAdminLedgerTransaction(item as unknown as RentOpsLedgerTransaction)),
    paymentAllocations: (recordArrayValue(input.paymentAllocations) ?? []).map((item) => serializeAdminPaymentAllocation(item as unknown as RentOpsPaymentAllocation)),
    securityDeposits: (recordArrayValue(input.securityDeposits) ?? []).map((item) => serializeAdminSecurityDeposit(item as unknown as RentOpsSecurityDeposit)),
    subsidyContracts: (recordArrayValue(input.subsidyContracts) ?? []).map((item) => serializeAdminSubsidyContract(item as unknown as RentOpsSubsidyContract)),
    applications: (recordArrayValue(input.applications) ?? []).map((item) => serializeAdminApplication(item as unknown as RentOpsApplicationRecord)),
    applicationHouseholdMembers: (recordArrayValue(input.applicationHouseholdMembers) ?? []).map((item) => serializeAdminApplicationHouseholdMember(item as unknown as RentOpsApplicationHouseholdMember)),
    applicationRequirements: (recordArrayValue(input.applicationRequirements) ?? []).map((item) => serializeAdminApplicationRequirement(item as unknown as RentOpsApplicationRequirement)),
    documents: (recordArrayValue(input.documents) ?? []).map((item) => serializeAdminDocument(item as unknown as RentOpsDocument)),
    activityEvents: (recordArrayValue(input.activityEvents) ?? []).map((item) => serializeAdminActivity(item as unknown as RentOpsActivityEvent)),
  });
}

export const serializeSnapshot = serializeAdminSnapshot;
export const serializeSnapshotArrays = serializeAdminSnapshot;

export const serializeProperty = serializeAdminProperty;
export const serializeUnit = serializeAdminUnit;
export const serializePerson = serializeAdminPerson;
export const serializeHouseholdMembership = serializeAdminHouseholdMembership;
export const serializeTenancy = serializeAdminTenancy;
export const serializeLeaseTerm = serializeAdminLeaseTerm;
export const serializeRecurringSchedule = serializeAdminRecurringSchedule;
export const serializeLedgerTransaction = serializeAdminLedgerTransaction;
export const serializePaymentAllocation = serializeAdminPaymentAllocation;
export const serializeSecurityDeposit = serializeAdminSecurityDeposit;
export const serializeSubsidyContract = serializeAdminSubsidyContract;
export const serializeApplication = serializeAdminApplication;
export const serializeApplicationHouseholdMember = serializeAdminApplicationHouseholdMember;
export const serializeApplicationRequirement = serializeAdminApplicationRequirement;
export const serializeDocument = serializeAdminDocument;
export const serializeActivity = serializeAdminActivity;

export interface AdminTenantProfileView {
  person?: AdminPersonView;
  household: AdminHouseholdMembershipView[];
  tenancy?: AdminTenancyView;
  tenancies?: AdminTenancyView[];
  leaseTerms: AdminLeaseTermView[];
  schedules: AdminRecurringScheduleView[];
  ledger: Array<{ transaction: AdminLedgerTransactionView; allocatedCents?: number | null; openCents?: number | null; runningBalanceCents?: number | null; rowType?: string; openingBalanceCents?: number | null; balanceComplete?: boolean; balanceUncertaintyCodes?: string[] }>;
  deposits: AdminSecurityDepositView[];
  subsidyContracts: AdminSubsidyContractView[];
  documents: AdminDocumentView[];
  activity: AdminActivityView[];
  property?: AdminPropertyView;
  unit?: AdminUnitView;
  primaryLease?: AdminLeaseTermView;
}

function serializeLedgerRows(value: unknown): AdminTenantProfileView["ledger"] {
  return (recordArrayValue(value) ?? []).map((item) => presentationObject({
    transaction: serializeAdminLedgerTransaction(inputOf(item).transaction as RentOpsLedgerTransaction),
    allocatedCents: nullableNumberValue(inputOf(item).allocatedCents),
    openCents: nullableNumberValue(inputOf(item).openCents),
    runningBalanceCents: nullableNumberValue(inputOf(item).runningBalanceCents),
    balanceComplete: bool(inputOf(item), "balanceComplete"),
    balanceUncertaintyCodes: stringArrayValue(inputOf(item).balanceUncertaintyCodes),
    rowType: inputOf(item).rowType === "opening_balance" ? "opening_balance" : undefined,
    openingBalanceCents: nullableNumberValue(inputOf(item).openingBalanceCents),
  }));
}

export function serializeAdminTenantProfile(value: TenantProfile | unknown, completeSchedules?: RentOpsRecurringChargeSchedule[], preparedSchedules?: ReadonlyMap<string, AdminRecurringScheduleView>): AdminTenantProfileView {
  const input = inputOf(value);
  return presentationObject({
    person: nested(input, "person", (item) => serializeAdminPerson(item as RentOpsPerson)),
    household: nestedList(input, "household", (item) => serializeAdminHouseholdMembership(item as RentOpsHouseholdMembership)),
    tenancy: nested(input, "tenancy", (item) => serializeAdminTenancy(item as RentOpsTenancy)),
    tenancies: nestedList(input, "tenancies", (item) => serializeAdminTenancy(item as RentOpsTenancy)),
    leaseTerms: nestedList(input, "leaseTerms", (item) => serializeAdminLeaseTerm(item as RentOpsLeaseTerm)),
    schedules: preparedSchedules
      ? (recordArrayValue(input.schedules) ?? []).map(item => preparedSchedules.get(String(item.id)) ?? serializeAdminRecurringSchedules([item as unknown as RentOpsRecurringChargeSchedule], [])[0])
      : serializeAdminRecurringSchedules((recordArrayValue(input.schedules) ?? []) as unknown as RentOpsRecurringChargeSchedule[], completeSchedules),
    ledger: serializeLedgerRows(input.ledger),
    deposits: nestedList(input, "deposits", (item) => serializeAdminSecurityDeposit(item as RentOpsSecurityDeposit)),
    subsidyContracts: nestedList(input, "subsidyContracts", (item) => serializeAdminSubsidyContract(item as RentOpsSubsidyContract)),
    documents: nestedList(input, "documents", (item) => serializeAdminDocument(item as RentOpsDocument)),
    activity: nestedList(input, "activity", (item) => serializeAdminActivity(item as RentOpsActivityEvent)),
    property: nested(input, "property", (item) => serializeAdminProperty(item as RentOpsProperty)),
    unit: nested(input, "unit", (item) => serializeAdminUnit(item as RentOpsUnit)),
    primaryLease: nested(input, "primaryLease", (item) => serializeAdminLeaseTerm(item as RentOpsLeaseTerm)),
  });
}

export const serializeTenantProfile = serializeAdminTenantProfile;
