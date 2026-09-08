export type RentOpsSource = "live" | "synthetic";

export type SectionKey =
  | "reports"
  | "rent-roll"
  | "tenants"
  | "properties"
  | "leases"
  | "income"
  | "applicants"
  | "documents";

export type ReportKey =
  | "rent-roll"
  | "occupancy"
  | "scheduled-income"
  | "collected-income"
  | "scheduled-vs-collected"
  | "delinquency"
  | "tenant-ledger"
  | "lease-expiration"
  | "security-deposit"
  | "applicant-pipeline"
  | "hap";

/** Browser-owned query shape.  It deliberately contains no persistence
 * entity types or source/import fields. */
export interface ApiFilters {
  propertyId?: string;
  unitId?: string;
  tenancyId?: string;
  personId?: string;
  asOfDate?: string;
  month?: string;
  occupancy?: string[];
  readiness?: string[];
  listing?: string[];
  balanceStatus?: "all" | "due" | "credit" | "zero";
  status?: string[];
  search?: string;
}

export interface DashboardSummary {
  asOfDate: string;
  propertyCount: number;
  unitCount: number;
  occupiedUnits: number;
  futurePreleasedUnits: number;
  genuineVacantUnits: number;
  readyVacantUnits: number;
  notReadyUnits: number;
  offMarketUnits: number;
  physicalOccupancyPercent: number;
  scheduledRentCents: number;
  collectedRentCents: number;
  rentOnlyDelinquencyCents: number;
  totalDelinquencyCents: number;
  unappliedCashCents: number;
  expiringIn30Days: number;
  expiringIn60Days: number;
  expiringIn90Days: number;
  monthToMonthCount: number;
  applicationsSubmitted: number;
  applicationsMissingInformation: number;
  securityDepositLiabilityCents: number | null;
  drilldowns: Record<string, { report: string; filters: ApiFilters }>;
}

export type TenantTab =
  | "summary"
  | "household"
  | "tenancy"
  | "charges"
  | "ledger"
  | "deposits"
  | "housing-assistance"
  | "documents"
  | "activity";

/** Local display state; API filters use the browser-owned ApiFilters shape. */
export interface ViewFilters {
  propertyId: string;
  asOfDate: string;
  status: string;
  search: string;
}

export interface ReportColumn {
  key: string;
  label: string;
  format?: "currency" | "date" | "percent" | "integer" | "status";
  align?: "left" | "right";
}

export interface ReportDefinition {
  key: ReportKey;
  label: string;
  description: string;
  sourceNote: string;
  columns: ReportColumn[];
  rows: ReportRow[];
}

/**
 * Browser-owned view types.  These intentionally mirror only the positive
 * presentation response; persistence-only source/import records and private
 * document bindings have no client representation.
 */
export interface AdminAddressView {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
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
export interface AdminPersonView {
  recordRevision?: number;
  id?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  phoneMethods?: Array<{ id?: string; value?: string; type?: string; isPrimary?: boolean; isTextReady?: boolean }>;
  renterInsuranceExpiresOn?: string;
  archived?: boolean;
  archivedKnowledge?: string;
  firstNameKnowledge?: string;
  lastNameKnowledge?: string;
  emailKnowledge?: string;
  phoneKnowledge?: string;
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
export interface AdminTenancyView {
  recordRevision?: number;
  id?: string;
  propertyId?: string;
  unitId?: string;
  primaryPersonId?: string;
  status?: string;
  plannedMoveInOn?: string;
  actualMoveInOn?: string;
  noticeOn?: string;
  expectedMoveOutOn?: string;
  actualMoveOutOn?: string;
  createdAt?: string;
  endedAt?: string;
  applicationId?: string;
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
export interface AdminRecurringScheduleView {
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
export interface AdminPaymentAllocationView {
  id?: string;
  paymentTransactionId?: string;
  chargeTransactionId?: string;
  amountCents?: number;
  allocatedOn?: string;
  paymentLinkKnowledge?: string;
  chargeLinkKnowledge?: string;
  amountKnowledge?: string;
  allocatedOnKnowledge?: string;
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
  rentalHistory?: Record<string, unknown>;
  employment?: Record<string, unknown>;
  householdSummary?: Record<string, unknown>;
  preferences?: { desiredMoveInOn?: string; desiredLeaseMonths?: number; maxRentCents?: number; bedrooms?: number };
  voucher?: { hasVoucher?: boolean; agencyName?: string; caseNumber?: string; tenantPortionCents?: number };
  pets?: Array<Record<string, unknown>>;
  vehicles?: Array<Record<string, unknown>>;
  emergencyContact?: Record<string, unknown>;
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

/**
 * Positive detail response for one application. The admin detail endpoint
 * adds only the related household, requirement, and document records; it does
 * not expose persistence, source, or storage metadata.
 */
export interface AdminApplicationDetailView extends AdminApplicationView {
  householdMembers: AdminApplicationHouseholdMemberView[];
  requirements: AdminApplicationRequirementView[];
  documents: AdminDocumentView[];
  /** Optional immutable v9 history section for the same target application. */
  history?: AdminApplicationHistoryCaseView;
}

/** Positive, browser-owned DTO for the v9 historical application case. */
export interface AdminApplicationHistoryPartyView {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  status?: string;
  statusKnowledge?: string;
  submittedOn?: string;
  submittedOnKnowledge?: string;
  createdOn?: string;
  createdOnKnowledge?: string;
  updatedOn?: string;
  updatedOnKnowledge?: string;
}

export interface AdminApplicationHistoryApplicationView extends AdminApplicationHistoryPartyView {
  id: string;
}

export interface AdminApplicationHistoryInterestView {
  propertyId?: string;
  unitId?: string;
  sourceOrder?: number;
  sourceRank?: number;
  preference?: string;
  preferenceKnowledge?: string;
  interestedOn?: string;
  interestedOnKnowledge?: string;
  rentCents?: number;
  rentKnowledge?: string;
  bedrooms?: number;
  bedroomsKnowledge?: string;
  status?: string;
  statusKnowledge?: string;
}

export interface AdminApplicationHistoryParticipantView {
  sourceOrder?: number;
  role?: string;
  roleKnowledge?: string;
  relationship?: string;
  relationshipKnowledge?: string;
  isMinor?: boolean;
  minorKnowledge?: string;
  isFinanciallyResponsible?: boolean;
  financialResponsibilityKnowledge?: string;
}

export interface AdminApplicationHistoryRequirementView {
  label?: string;
  status?: string;
  statusKnowledge?: string;
  requestedOn?: string;
  requestedOnKnowledge?: string;
  resolvedOn?: string;
  resolvedOnKnowledge?: string;
  hasDocument?: boolean;
}

export interface AdminApplicationHistoryAnswerView {
  valueType: string;
  valueKnowledge: string;
  fieldLinkKnowledge?: string;
}

export interface AdminApplicationHistoryDocumentView {
  type?: string;
  typeKnowledge?: string;
  state?: string;
  stateKnowledge?: string;
  fileName?: string;
  mimeType?: string;
  metadataSizeBytes?: number;
  availability: "metadata" | "unavailable";
}

export interface AdminApplicationHistoryActivityView {
  type?: string;
  occurredAt?: string;
  occurredAtKnowledge?: string;
  summary?: string;
  summaryKnowledge?: string;
}

export interface AdminApplicationHistoryBlockerView {
  code: string;
  occurrenceCount: number;
  reason: string;
}

export interface AdminApplicationHistoryUnknownRestrictedView {
  restrictedAnswerCount: number;
  unmappedAnswerCount: number;
  missingAnswerApplications: number;
  metadataOnlyDocumentCount: number;
  unavailableDocumentCount: number;
  unlinkedActivityCount: number;
  unlinkedInterestCount: number;
}

export interface AdminApplicationHistoryCaseView {
  application?: AdminApplicationHistoryApplicationView;
  prospect?: AdminApplicationHistoryPartyView;
  interests: AdminApplicationHistoryInterestView[];
  participants: AdminApplicationHistoryParticipantView[];
  requirements: AdminApplicationHistoryRequirementView[];
  answers: AdminApplicationHistoryAnswerView[];
  documents: AdminApplicationHistoryDocumentView[];
  activities: AdminApplicationHistoryActivityView[];
  blockers: AdminApplicationHistoryBlockerView[];
  unknownRestricted: AdminApplicationHistoryUnknownRestrictedView;
}

export interface AdminApplicationHistoryDetailView {
  history: AdminApplicationHistoryCaseView;
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
export interface AdminApplicationRequirementView {
  id?: string;
  applicationId?: string;
  label?: string;
  status?: string;
  documentId?: string;
  requestedOn?: string;
  resolvedOn?: string;
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

export interface AdminLedgerRowView {
  transaction: AdminLedgerTransactionView;
  allocatedCents?: number;
  openCents?: number;
  runningBalanceCents?: number;
}

export interface TenantView {
  person: AdminPersonView;
  household: AdminHouseholdMembershipView[];
  tenancy?: AdminTenancyView;
  tenancies?: AdminTenancyView[];
  leaseTerms: AdminLeaseTermView[];
  schedules: AdminRecurringScheduleView[];
  ledger: AdminLedgerRowView[];
  deposits: AdminSecurityDepositView[];
  subsidyContracts: AdminSubsidyContractView[];
  documents: AdminDocumentView[];
  activity: AdminActivityView[];
  property?: AdminPropertyView;
  unit?: AdminUnitView;
  primaryLease?: AdminLeaseTermView;
}

/** Server-derived report DTOs. Every row has a closed runtime decoder in the
 * API adapter; these browser types intentionally contain no source or
 * persistence-definition fields. */
export interface RentRollRow {
  propertyId?: string;
  propertyName?: string;
  unitId?: string;
  unitNumber?: string;
  bedrooms?: number;
  bathrooms?: number;
  marketRentCents?: number;
  readiness?: string;
  listing?: string;
  occupancy?: string;
  currentPersonId?: string;
  currentTenantName?: string;
  futurePersonId?: string;
  futureTenantName?: string;
  tenancyId?: string;
  actualMoveInOn?: string;
  noticeOn?: string;
  expectedMoveOutOn?: string;
  actualMoveOutOn?: string;
  contractStartOn?: string;
  contractEndOn?: string;
  monthToMonth?: boolean;
  baseRentCents?: number;
  recurringFeesCents?: number;
  subsidyCents?: number;
  tenantPortionCents?: number;
  totalScheduledCents?: number;
  balanceDueCents?: number;
  oldestUnpaidRentOn?: string;
  exceptionCodes?: string[];
}

export interface OccupancyRow {
  propertyId?: string;
  propertyName?: string;
  unitId?: string;
  unitNumber?: string;
  occupancy?: string;
  readiness?: string;
  listing?: string;
  daysVacant?: number;
  tenancyId?: string;
}

export interface ScheduledIncomeRow {
  propertyId?: string | null;
  propertyName?: string | null;
  unitId?: string | null;
  unitNumber?: string | null;
  tenancyId?: string | null;
  personId?: string | null;
  tenantName?: string | null;
  month?: string | null;
  category?: string | null;
  description?: string | null;
  amountCents?: number | null;
  scheduleId?: string;
  scopeType?: string | null;
  effectiveFromKnowledge?: string | null;
  temporalUncertainty?: boolean | null;
  amountKnowledge?: string | null;
  categoryKnowledge?: string | null;
  chargeDefinitionLinkKnowledge?: string | null;
  known?: boolean | null;
  uncertain?: boolean | null;
  unclassified?: boolean | null;
  exceptionCodes?: string[];
}

export interface CollectedIncomeRow {
  propertyId?: string;
  propertyName?: string;
  unitId?: string;
  unitNumber?: string;
  tenancyId?: string;
  personId?: string;
  tenantName?: string;
  paymentTransactionId?: string;
  chargeTransactionId?: string;
  paymentOn?: string;
  category?: string;
  amountCents?: number;
  description?: string;
}

export interface ScheduledVsCollectedRow {
  propertyId?: string | null;
  propertyName?: string | null;
  month?: string | null;
  scheduledCents?: number | null;
  collectedCents?: number | null;
  varianceCents?: number | null;
  scheduledKnownCents?: number | null;
  scheduledUncertainCents?: number | null;
  scheduledUnknownAmountCount?: number | null;
  collectedKnownCents?: number | null;
  collectedUncertainCents?: number | null;
  collectedUnknownAmountCount?: number | null;
  complete?: boolean | null;
  uncertaintyCodes?: string[];
}

export interface DelinquencyRow {
  propertyId?: string;
  propertyName?: string;
  unitId?: string;
  unitNumber?: string;
  tenancyId?: string;
  personId?: string;
  tenantName?: string;
  rentOnlyBalanceCents?: number;
  nonRentBalanceCents?: number;
  grossBalanceCents?: number;
  totalBalanceCents?: number;
  netAccountBalanceCents?: number;
  unappliedCashCents?: number;
  prepaidCents?: number;
  oldestUnpaidRentOn?: string;
  lastPaymentOn?: string;
  hasPromiseOrHold?: boolean;
  noticeStatus?: string;
}
export type LedgerRow = AdminLedgerRowView;

export interface LeaseExpirationRow {
  propertyId?: string;
  propertyName?: string;
  unitId?: string;
  unitNumber?: string;
  tenancyId?: string;
  personId?: string;
  tenantName?: string;
  contractEndOn?: string;
  monthToMonth?: boolean;
  currentBaseRentCents?: number;
  noticeDeadlineOn?: string;
  actionStatus?: string;
}

export interface DepositLiabilityRow {
  propertyId?: string;
  propertyName?: string;
  unitId?: string;
  unitNumber?: string;
  tenancyId?: string;
  personId?: string;
  tenantName?: string;
  securityHeldCents?: number | null;
  refundablePetHeldCents?: number | null;
  otherRefundableHeldCents?: number | null;
  totalHeldCents?: number | null;
  sourceBalanceCents?: number | null;
  unknownHeldCount?: number;
  dispositionStatus?: string;
  unknownReceiptCount?: number;
  hasUnknownReceiptDate?: boolean;
  temporalUncertainty?: boolean;
}

export interface ApplicantPipelineRow {
  id?: string;
  displayName?: string;
  propertyId?: string;
  propertyName?: string;
  unitId?: string;
  unitInterest?: string;
  submittedOn?: string;
  status?: string;
  missingItems?: string[];
  daysInStage?: number;
}

export interface HapRow {
  propertyId?: string;
  propertyName?: string;
  unitId?: string;
  unitNumber?: string;
  tenancyId?: string;
  tenantName?: string;
  agencyName?: string;
  month?: string;
  agencyObligationCents?: number;
  tenantObligationCents?: number;
  expectedTotalCents?: number;
  receivedAgencyCents?: number;
  varianceCents?: number;
  exception?: boolean;
}

export type ReportRow =
  | RentRollRow
  | OccupancyRow
  | ScheduledIncomeRow
  | CollectedIncomeRow
  | ScheduledVsCollectedRow
  | DelinquencyRow
  | LedgerRow
  | LeaseExpirationRow
  | DepositLiabilityRow
  | ApplicantPipelineRow
  | HapRow;

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

export interface AdminSnapshot {
  generatedAt: string;
  snapshot: AdminSnapshotView;
  summary: DashboardSummary;
  rentRoll: RentRollRow[];
  occupancy: OccupancyRow[];
  scheduledIncome: ScheduledIncomeRow[];
  collectedIncome: CollectedIncomeRow[];
  scheduledVsCollected: ScheduledVsCollectedRow[];
  delinquency: DelinquencyRow[];
  ledger: LedgerRow[];
  leaseExpiration: LeaseExpirationRow[];
  depositLiability: DepositLiabilityRow[];
  hap: HapRow[];
  tenants: TenantView[];
  applicants: AdminApplicationView[];
  documents: AdminDocumentView[];
  activities: AdminActivityView[];
  reports: Record<ReportKey, ReportDefinition>;
  /** Loaded from the positive admin catalog endpoint; never persistence-shaped. */
  chargeDefinitions: AdminChargeDefinitionView[];
}

export interface RentOpsLoadResult {
  snapshot: AdminSnapshot;
  source: RentOpsSource;
  warning?: string;
}

export interface RentOpsMutation {
  action:
    | "save-property"
    | "save-unit"
    | "save-person"
    | "save-household-membership"
    | "save-tenancy"
    | "save-lease-term"
    | "save-recurring-schedule"
    | "replace-recurring-schedule"
    | "end-recurring-schedule"
    | "post-ledger-transaction"
    | "save-payment-allocation"
    | "reverse-ledger-transaction"
    | "save-security-deposit"
    | "save-subsidy-contract"
    | "save-activity"
    | "update-application-status"
    | "save-application-requirement"
    | "convert-application";
  payload: Record<string, unknown>;
}

export interface RentOpsMutationResult {
  ok: boolean;
  message?: string;
  id?: string;
}

export const REPORT_KEYS: ReportKey[] = [
  "rent-roll",
  "occupancy",
  "scheduled-income",
  "collected-income",
  "scheduled-vs-collected",
  "delinquency",
  "tenant-ledger",
  "lease-expiration",
  "security-deposit",
  "applicant-pipeline",
  "hap",
];

export const REPORT_LABELS: Record<ReportKey, string> = {
  "rent-roll": "Rent Roll by Property",
  occupancy: "Occupancy and Vacancy",
  "scheduled-income": "Scheduled Income",
  "collected-income": "Collected Income",
  "scheduled-vs-collected": "Scheduled vs. Collected",
  delinquency: "Delinquency",
  "tenant-ledger": "Tenant Ledger / Account Statement",
  "lease-expiration": "Lease Expiration / Month-to-Month",
  "security-deposit": "Security-Deposit Liability",
  "applicant-pipeline": "Applicant Pipeline",
  hap: "HAP Expected vs. Received",
};
