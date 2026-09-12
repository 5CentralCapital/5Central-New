import type { FixedReportName } from "../../../shared/rent-ops-contracts";
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
  RentOpsPresentationError,
  stringArrayValue,
  stringValue,
} from "./allowlist";
import { serializeAdminLedgerTransaction, serializeFilters } from "./entities";

export type PresentationReportName = FixedReportName;

const REPORT_NAMES: readonly PresentationReportName[] = [
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
];

export function isPresentationReportName(value: unknown): value is PresentationReportName {
  return typeof value === "string" && REPORT_NAMES.includes(value as PresentationReportName);
}

function inputOf(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function text(input: JsonObject, field: string): string | undefined {
  return stringValue(input[field]);
}

function number(input: JsonObject, field: string): number | undefined {
  return finiteNumberValue(input[field]);
}

function bool(input: JsonObject, field: string): boolean | undefined {
  return booleanValue(input[field]);
}

function dateText(input: JsonObject, field: string): string | undefined {
  return text(input, field);
}

function strings(input: JsonObject, field: string): string[] | undefined {
  return stringArrayValue(input[field]);
}

function row(input: JsonObject, fields: Record<string, unknown>): JsonObject {
  return presentationObject({ ...fields });
}

export function serializeRentRollRow(value: unknown): JsonObject {
  const input = inputOf(value);
  return row(input, {
    balanceComplete: bool(input, "balanceComplete"),
    balanceUncertaintyCodes: strings(input, "balanceUncertaintyCodes"),
    propertyId: text(input, "propertyId"),
    propertyName: text(input, "propertyName"),
    unitId: text(input, "unitId"),
    unitNumber: text(input, "unitNumber"),
    bedrooms: number(input, "bedrooms"),
    bathrooms: number(input, "bathrooms"),
    marketRentCents: number(input, "marketRentCents"),
    readiness: text(input, "readiness"),
    listing: text(input, "listing"),
    occupancy: text(input, "occupancy"),
    currentPersonId: text(input, "currentPersonId"),
    currentTenantName: text(input, "currentTenantName"),
    futurePersonId: text(input, "futurePersonId"),
    futureTenantName: text(input, "futureTenantName"),
    tenancyId: text(input, "tenancyId"),
    actualMoveInOn: dateText(input, "actualMoveInOn"),
    noticeOn: dateText(input, "noticeOn"),
    expectedMoveOutOn: dateText(input, "expectedMoveOutOn"),
    actualMoveOutOn: dateText(input, "actualMoveOutOn"),
    contractStartOn: dateText(input, "contractStartOn"),
    contractEndOn: dateText(input, "contractEndOn"),
    monthToMonth: bool(input, "monthToMonth"),
    baseRentCents: number(input, "baseRentCents"),
    recurringFeesCents: nullableNumberValue(input.recurringFeesCents),
    subsidyCents: nullableNumberValue(input.subsidyCents),
    tenantPortionCents: number(input, "tenantPortionCents"),
    totalScheduledCents: nullableNumberValue(input.totalScheduledCents),
    balanceDueCents: nullableNumberValue(input.balanceDueCents),
    oldestUnpaidRentOn: dateText(input, "oldestUnpaidRentOn"),
    exceptionCodes: strings(input, "exceptionCodes"),
  });
}

export function serializeOperationalScheduleRegister(value: unknown): JsonObject {
  const input = inputOf(value);
  return presentationObject({
    asOfDate: dateText(input, "asOfDate"),
    currentScheduleIds: strings(input, "currentScheduleIds"),
    historicalScheduleIds: strings(input, "historicalScheduleIds"),
    futureScheduleIds: strings(input, "futureScheduleIds"),
    unitDefaultScheduleIds: strings(input, "unitDefaultScheduleIds"),
    propertyDefaultScheduleIds: strings(input, "propertyDefaultScheduleIds"),
    reviewScheduleIds: strings(input, "reviewScheduleIds"),
    complete: bool(input, "complete"),
  });
}

export function serializeOccupancyRow(value: unknown): JsonObject {
  const input = inputOf(value);
  return row(input, {
    propertyId: text(input, "propertyId"),
    propertyName: text(input, "propertyName"),
    unitId: text(input, "unitId"),
    unitNumber: text(input, "unitNumber"),
    occupancy: text(input, "occupancy"),
    readiness: text(input, "readiness"),
    listing: text(input, "listing"),
    daysVacant: number(input, "daysVacant"),
    tenancyId: text(input, "tenancyId"),
  });
}

export function serializeScheduledIncomeRow(value: unknown): JsonObject {
  const input = inputOf(value);
  // Charge-definition identifiers and keys are deliberately not part of a
  // report row. The report keeps nullable v8 facts visible so the client can
  // render Needs review instead of filling in a category or amount.
  return row(input, {
    propertyId: nullableStringValue(input.propertyId),
    propertyName: nullableStringValue(input.propertyName),
    unitId: nullableStringValue(input.unitId),
    unitNumber: nullableStringValue(input.unitNumber),
    tenancyId: nullableStringValue(input.tenancyId),
    personId: nullableStringValue(input.personId),
    tenantName: nullableStringValue(input.tenantName),
    month: nullableStringValue(input.month),
    category: nullableStringValue(input.category),
    description: nullableStringValue(input.description),
    amountCents: nullableNumberValue(input.amountCents),
    scheduleId: text(input, "scheduleId"),
    scopeType: nullableStringValue(input.scopeType),
    effectiveFromKnowledge: nullableStringValue(input.effectiveFromKnowledge),
    temporalUncertainty: nullableBooleanValue(input.temporalUncertainty),
    amountKnowledge: nullableStringValue(input.amountKnowledge),
    categoryKnowledge: nullableStringValue(input.categoryKnowledge),
    chargeDefinitionLinkKnowledge: nullableStringValue(input.chargeDefinitionLinkKnowledge),
    known: nullableBooleanValue(input.known),
    uncertain: nullableBooleanValue(input.uncertain),
    unclassified: nullableBooleanValue(input.unclassified),
    exceptionCodes: strings(input, "exceptionCodes"),
  });
}

export function serializeCollectedIncomeRow(value: unknown): JsonObject {
  const input = inputOf(value);
  return row(input, {
    propertyId: text(input, "propertyId"),
    propertyName: text(input, "propertyName"),
    unitId: text(input, "unitId"),
    unitNumber: text(input, "unitNumber"),
    tenancyId: text(input, "tenancyId"),
    personId: text(input, "personId"),
    tenantName: text(input, "tenantName"),
    paymentTransactionId: text(input, "paymentTransactionId"),
    chargeTransactionId: text(input, "chargeTransactionId"),
    paymentOn: dateText(input, "paymentOn"),
    category: text(input, "category"),
    amountCents: number(input, "amountCents"),
    description: text(input, "description"),
  });
}

export function serializeScheduledVsCollectedRow(value: unknown): JsonObject {
  const input = inputOf(value);
  return row(input, {
    propertyId: nullableStringValue(input.propertyId),
    propertyName: nullableStringValue(input.propertyName),
    month: nullableStringValue(input.month),
    scheduledCents: nullableNumberValue(input.scheduledCents),
    collectedCents: nullableNumberValue(input.collectedCents),
    varianceCents: nullableNumberValue(input.varianceCents),
    scheduledKnownCents: nullableNumberValue(input.scheduledKnownCents),
    scheduledUncertainCents: nullableNumberValue(input.scheduledUncertainCents),
    scheduledUnknownAmountCount: nullableNumberValue(input.scheduledUnknownAmountCount),
    collectedKnownCents: nullableNumberValue(input.collectedKnownCents),
    collectedUncertainCents: nullableNumberValue(input.collectedUncertainCents),
    collectedUnknownAmountCount: nullableNumberValue(input.collectedUnknownAmountCount),
    complete: nullableBooleanValue(input.complete),
    uncertaintyCodes: strings(input, "uncertaintyCodes"),
  });
}

export function serializeDelinquencyRow(value: unknown): JsonObject {
  const input = inputOf(value);
  return row(input, {
    tenancyStatus: text(input, "tenancyStatus"),
    creditBalanceCents: nullableNumberValue(input.creditBalanceCents),
    balanceComplete: bool(input, "balanceComplete"),
    balanceUncertaintyCodes: strings(input, "balanceUncertaintyCodes"),
    propertyId: text(input, "propertyId"),
    propertyName: text(input, "propertyName"),
    unitId: text(input, "unitId"),
    unitNumber: text(input, "unitNumber"),
    tenancyId: text(input, "tenancyId"),
    personId: text(input, "personId"),
    tenantName: text(input, "tenantName"),
    rentOnlyBalanceCents: nullableNumberValue(input.rentOnlyBalanceCents),
    nonRentBalanceCents: nullableNumberValue(input.nonRentBalanceCents),
    grossBalanceCents: nullableNumberValue(input.grossBalanceCents),
    totalBalanceCents: nullableNumberValue(input.totalBalanceCents),
    netAccountBalanceCents: nullableNumberValue(input.netAccountBalanceCents),
    unappliedCashCents: nullableNumberValue(input.unappliedCashCents),
    prepaidCents: nullableNumberValue(input.prepaidCents),
    oldestUnpaidRentOn: dateText(input, "oldestUnpaidRentOn"),
    lastPaymentOn: dateText(input, "lastPaymentOn"),
    hasPromiseOrHold: bool(input, "hasPromiseOrHold"),
    noticeStatus: text(input, "noticeStatus"),
  });
}

export function serializeLedgerRow(value: unknown): JsonObject {
  const input = inputOf(value);
  return row(input, {
    balanceComplete: bool(input, "balanceComplete"),
    balanceUncertaintyCodes: strings(input, "balanceUncertaintyCodes"),
    transaction: serializeAdminLedgerTransaction(input.transaction as never),
    allocatedCents: nullableNumberValue(input.allocatedCents),
    openCents: nullableNumberValue(input.openCents),
    runningBalanceCents: nullableNumberValue(input.runningBalanceCents),
    rowType: input.rowType === "opening_balance" ? "opening_balance" : undefined,
    openingBalanceCents: nullableNumberValue(input.openingBalanceCents),
  });
}

export function serializeLeaseExpirationRow(value: unknown): JsonObject {
  const input = inputOf(value);
  return row(input, {
    propertyId: text(input, "propertyId"),
    propertyName: text(input, "propertyName"),
    unitId: text(input, "unitId"),
    unitNumber: text(input, "unitNumber"),
    tenancyId: text(input, "tenancyId"),
    personId: text(input, "personId"),
    tenantName: text(input, "tenantName"),
    contractEndOn: dateText(input, "contractEndOn"),
    monthToMonth: bool(input, "monthToMonth"),
    currentBaseRentCents: number(input, "currentBaseRentCents"),
    noticeDeadlineOn: dateText(input, "noticeDeadlineOn"),
    actionStatus: text(input, "actionStatus"),
  });
}

export function serializeDepositLiabilityRow(value: unknown): JsonObject {
  const input = inputOf(value);
  return row(input, {
    propertyId: text(input, "propertyId"),
    propertyName: text(input, "propertyName"),
    unitId: text(input, "unitId"),
    unitNumber: text(input, "unitNumber"),
    tenancyId: text(input, "tenancyId"),
    personId: text(input, "personId"),
    tenantName: text(input, "tenantName"),
    securityHeldCents: input.securityHeldCents === null ? null : number(input, "securityHeldCents"),
    refundablePetHeldCents: input.refundablePetHeldCents === null ? null : number(input, "refundablePetHeldCents"),
    otherRefundableHeldCents: input.otherRefundableHeldCents === null ? null : number(input, "otherRefundableHeldCents"),
    totalHeldCents: input.totalHeldCents === null ? null : number(input, "totalHeldCents"),
    dispositionStatus: text(input, "dispositionStatus"),
    sourceBalanceCents: number(input, "sourceBalanceCents"),
    unknownHeldCount: number(input, "unknownHeldCount"),
    unknownReceiptCount: number(input, "unknownReceiptCount"),
    hasUnknownReceiptDate: bool(input, "hasUnknownReceiptDate"),
    temporalUncertainty: bool(input, "temporalUncertainty"),
  });
}

export function serializeHapRow(value: unknown): JsonObject {
  const input = inputOf(value);
  return row(input, {
    propertyId: text(input, "propertyId"),
    propertyName: text(input, "propertyName"),
    unitId: text(input, "unitId"),
    unitNumber: text(input, "unitNumber"),
    tenancyId: text(input, "tenancyId"),
    tenantName: text(input, "tenantName"),
    agencyName: text(input, "agencyName"),
    month: text(input, "month"),
    agencyObligationCents: number(input, "agencyObligationCents"),
    tenantObligationCents: number(input, "tenantObligationCents"),
    expectedTotalCents: number(input, "expectedTotalCents"),
    receivedAgencyCents: number(input, "receivedAgencyCents"),
    varianceCents: number(input, "varianceCents"),
    exception: bool(input, "exception"),
  });
}

export function serializeApplicantPipelineRow(value: unknown): JsonObject {
  const input = inputOf(value);
  // The domain row contains `source`; it is intentionally not a browser key.
  return row(input, {
    id: text(input, "id"),
    displayName: text(input, "displayName"),
    propertyId: text(input, "propertyId"),
    propertyName: text(input, "propertyName"),
    unitId: text(input, "unitId"),
    unitInterest: text(input, "unitInterest"),
    submittedOn: dateText(input, "submittedOn"),
    status: text(input, "status"),
    missingItems: strings(input, "missingItems"),
    daysInStage: number(input, "daysInStage"),
  });
}

type RowSerializer = (value: unknown) => JsonObject;

const rowSerializers: Record<PresentationReportName, RowSerializer> = {
  "rent-roll": serializeRentRollRow,
  occupancy: serializeOccupancyRow,
  "scheduled-income": serializeScheduledIncomeRow,
  "collected-income": serializeCollectedIncomeRow,
  "scheduled-vs-collected": serializeScheduledVsCollectedRow,
  delinquency: serializeDelinquencyRow,
  "tenant-ledger": serializeLedgerRow,
  "lease-expirations": serializeLeaseExpirationRow,
  "lease-expiration": serializeLeaseExpirationRow,
  deposits: serializeDepositLiabilityRow,
  "security-deposit": serializeDepositLiabilityRow,
  "applicant-pipeline": serializeApplicantPipelineRow,
  hap: serializeHapRow,
};

export function serializeReportRows(report: string, rows: unknown): JsonObject[] {
  if (!isPresentationReportName(report)) throw new RentOpsPresentationError("unknown_report");
  const serializer = rowSerializers[report];
  return (recordArrayValue(rows) ?? []).map(serializer);
}

export const serializeCsvRows = serializeReportRows;
export const serializeReportCsvRows = serializeReportRows;

export interface PresentationReportEnvelope {
  report: string;
  filters: JsonObject;
  rows: JsonObject[];
}

export function serializeReportEnvelope(input: { report: string; filters?: unknown; rows?: unknown }): PresentationReportEnvelope {
  if (!isPresentationReportName(input.report)) throw new RentOpsPresentationError("unknown_report");
  return presentationObject({ report: input.report, filters: serializeFilters(input.filters ?? {}), rows: serializeReportRows(input.report, input.rows ?? []) }) as PresentationReportEnvelope;
}

export const serializeReport = serializeReportEnvelope;

export function serializeReportMap(value: unknown): Record<string, JsonObject[]> {
  const input = inputOf(value);
  const output: Record<string, JsonObject[]> = {};
  const aliases: Record<string, PresentationReportName> = {
    "rent-roll": "rent-roll",
    rentRoll: "rent-roll",
    occupancy: "occupancy",
    "scheduled-income": "scheduled-income",
    scheduledIncome: "scheduled-income",
    "collected-income": "collected-income",
    collectedIncome: "collected-income",
    "scheduled-vs-collected": "scheduled-vs-collected",
    scheduledVsCollected: "scheduled-vs-collected",
    delinquency: "delinquency",
    "tenant-ledger": "tenant-ledger",
    tenantLedger: "tenant-ledger",
    ledger: "tenant-ledger",
    "lease-expirations": "lease-expirations",
    "lease-expiration": "lease-expiration",
    leaseExpiration: "lease-expiration",
    deposits: "deposits",
    "security-deposit": "security-deposit",
    depositLiability: "security-deposit",
    "applicant-pipeline": "applicant-pipeline",
    applicantPipeline: "applicant-pipeline",
    hap: "hap",
  };
  for (const [key, report] of Object.entries(aliases)) {
    const candidate = input[key];
    if (candidate === undefined) continue;
    const rows = isRecord(candidate) && Array.isArray(candidate.rows) ? candidate.rows : candidate;
    output[report] = serializeReportRows(report, rows);
  }
  return presentationObject(output);
}

export const serializeReportRowsForCsv = serializeCsvRows;
