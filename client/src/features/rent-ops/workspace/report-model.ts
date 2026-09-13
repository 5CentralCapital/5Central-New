import { balanceReviewReportText } from "./balance-review-display";
import type {
  AdminSnapshot,
  ApiFilters,
  ReportKey,
  ReportRow,
  ReportColumn,
  ViewFilters,
} from "../types";
import { REPORT_KEYS, REPORT_LABELS } from "../types";
import { formatDate, formatLabel, formatMoney } from "./display";

export { formatDate, formatLabel, formatMoney } from "./display";

/**
 * Report rows are server-derived. This module owns the browser's display
 * mapping only: it does not calculate rent, balances, occupancy, or cash.
 */

export type ReportPeriodMode = "as-of" | "month" | "range";

export interface ReportColumnDefinition {
  key: string;
  label: string;
  format?: ReportColumn["format"];
  align?: ReportColumn["align"];
  /** The curated columns shown when a report is first opened. */
  curated?: boolean;
  /** Safe additive fields may receive a property subtotal. */
  subtotal?: boolean;
  read: (row: ReportRow, snapshot?: AdminSnapshot) => unknown;
}

export interface ReportConfig {
  key: ReportKey;
  label: string;
  description: string;
  sourceNote: string;
  period: ReportPeriodMode;
  columns: ReportColumnDefinition[];
}

export interface DisplayReportRow extends Record<string, unknown> {
  /** Kept out of grid columns; used only for row drill-downs and identity. */
  __source: ReportRow;
  __index: number;
}

export interface ReportViewModel {
  key: ReportKey;
  label: string;
  description: string;
  sourceNote: string;
  period: ReportPeriodMode;
  columns: ReportColumnDefinition[];
  curatedColumns: ReportColumnDefinition[];
  optionalColumns: ReportColumnDefinition[];
  rows: ReportRow[];
  displayRows: DisplayReportRow[];
}

export interface PropertySubtotal {
  propertyId?: string;
  label: string;
  count: number;
  /** A null total means one or more source values prevent a safe sum. */
  amounts: Record<string, number | null>;
}

export const REPORT_PERIODS: Record<ReportKey, ReportPeriodMode> = {
  "rent-roll": "as-of",
  occupancy: "as-of",
  "scheduled-income": "month",
  "collected-income": "range",
  "scheduled-vs-collected": "month",
  delinquency: "as-of",
  "tenant-ledger": "range",
  "lease-expiration": "as-of",
  "security-deposit": "as-of",
  "applicant-pipeline": "as-of",
  hap: "month",
};

const REPORT_DESCRIPTIONS: Record<ReportKey, string> = {
  "rent-roll": "Current units, occupancy, scheduled charges, and resident balances.",
  occupancy: "Physical occupancy and vacancy readiness by unit.",
  "scheduled-income": "Server-derived recurring income for the selected month.",
  "collected-income": "Posted collected income within the selected activity range.",
  "scheduled-vs-collected": "Monthly scheduled income compared with posted collections.",
  delinquency: "Tenant rent balances with non-rent balances kept visible.",
  "tenant-ledger": "Account statement rows with allocations and running balance.",
  "lease-expiration": "Lease expirations, month-to-month residents, and next actions.",
  "security-deposit": "Security-deposit liability by resident and unit.",
  "applicant-pipeline": "Manual application pipeline status and missing items.",
  hap: "Housing-assistance obligations compared with agency receipts.",
};

const REPORT_SOURCE_NOTES: Record<ReportKey, string> = {
  "rent-roll": "Rows are derived by the Rent Operations domain service as of the selected date.",
  occupancy: "Rows are derived by the Rent Operations domain service as of the selected date.",
  "scheduled-income": "Rows are derived from server-recognized recurring schedules; unresolved facts stay visible as Needs review.",
  "collected-income": "Rows are derived from posted ledger receipts; this view does not establish bank settlement.",
  "scheduled-vs-collected": "Rows compare server-derived schedules and posted receipts; incomplete inputs remain unresolved.",
  delinquency: "Rows are derived from the server account ledger; incomplete balances are never treated as zero.",
  "tenant-ledger": "Rows are derived from the server account ledger and retain opening-balance uncertainty.",
  "lease-expiration": "Rows are derived from current lease terms and tenancy dates.",
  "security-deposit": "Rows are derived from deposit liability records; unknown held amounts remain unresolved.",
  "applicant-pipeline": "Rows are derived from current application records; all decisions remain manual.",
  hap: "Rows are derived from housing-assistance obligations and posted agency receipts.",
};

type RowReader = (row: ReportRow, snapshot?: AdminSnapshot) => unknown;

function propertyName(row: ReportRow, snapshot?: AdminSnapshot): unknown {
  const direct = readRaw(row, "propertyName");
  if (direct !== undefined) return direct;
  const id = propertyId(row);
  if (!id || !snapshot) return undefined;
  return snapshot.snapshot.properties.find((property) => property.id === id)?.name;
}

function unitNumber(row: ReportRow, snapshot?: AdminSnapshot): unknown {
  const direct = readRaw(row, "unitNumber");
  if (direct !== undefined) return direct;
  const id = unitId(row);
  if (!id || !snapshot) return undefined;
  return snapshot.snapshot.units.find((unit) => unit.id === id)?.unitNumber;
}

function tenantName(row: ReportRow, snapshot?: AdminSnapshot): unknown {
  const directTenant = readRaw(row, "tenantName");
  const direct = directTenant !== undefined ? directTenant : readRaw(row, "currentTenantName");
  if (direct !== undefined) return direct;
  const id = personId(row);
  if (!id || !snapshot) return undefined;
  const person = snapshot.snapshot.people.find((candidate) => candidate.id === id);
  if (!person) return undefined;
  return [person.firstName, person.lastName].filter((part) => part != null && String(part).trim()).join(" ") || undefined;
}

function field(key: string, format?: ReportColumn["format"], label?: string, subtotal = false, read?: RowReader): ReportColumnDefinition {
  return {
    key,
    label: label ?? labelForKey(key),
    format,
    align: format === "currency" || format === "integer" || format === "percent" ? "right" : undefined,
    curated: true,
    subtotal,
    read: read ?? ((row) => readRaw(row, key)),
  };
}

function currency(key: string, label?: string): ReportColumnDefinition {
  return field(key, "currency", label, true, (row) => guardedMoney(row, key));
}

function date(key: string, label?: string, read?: RowReader): ReportColumnDefinition {
  return field(key, "date", label, false, read);
}

function status(key: string, label?: string, read?: RowReader): ReportColumnDefinition {
  return field(key, "status", label, false, read);
}

function text(key: string, label?: string, read?: RowReader): ReportColumnDefinition {
  return field(key, undefined, label, false, read);
}

function integer(key: string, label?: string): ReportColumnDefinition {
  return field(key, "integer", label);
}

function reportColumns(key: ReportKey): ReportColumnDefinition[] {
  switch (key) {
    case "rent-roll":
      return [
        text("unitNumber", "Unit", unitNumber),
        text("currentTenantName", "Tenant", (row) => readRaw(row, "currentTenantName") ?? (readRaw(row, "currentPersonId") || readRaw(row, "occupancy") === "current" ? undefined : readRaw(row, "futureTenantName") ?? (readRaw(row, "occupancy") === "vacant" ? "Vacant" : undefined))),
        currency("baseRentCents", "Recurring rent"),
        currency("recurringFeesCents", "Other recurring"),
        currency("totalScheduledCents", "Monthly total"),
        currency("operationalBalanceCents", "Balance due"),
        ...[
          text("propertyName", "Property", propertyName),
          status("occupancy", "Occupancy"),
          status("readiness", "Readiness"),
          status("listing", "Listing"),
          text("futureTenantName", "Future tenant"),
          currency("marketRentCents", "Market rent"),
          currency("subsidyCents", "Subsidy"),
          currency("balanceDueCents", "Posted ledger balance"),
          text("reviewedOperationalBalance", "Reviewed operational balance", (row) => balanceReviewReportText("balanceReview" in row ? row.balanceReview : undefined)),
        ].map(column => ({ ...column, curated: false })),
      ];
    case "occupancy":
      return [
        text("propertyName", "Property", propertyName),
        text("unitNumber", "Unit", unitNumber),
        status("occupancy", "Occupancy"),
        status("readiness", "Readiness"),
        status("listing", "Listing"),
        integer("daysVacant", "Days vacant"),
      ];
    case "scheduled-income":
      return [
        text("propertyName", "Property", propertyName),
        text("unitNumber", "Unit", unitNumber),
        text("tenantName", "Resident", tenantName),
        text("month", "Month"),
        status("category", "Category"),
        text("description", "Description"),
        currency("amountCents", "Amount"),
        status("effectiveFromKnowledge", "Effective date knowledge"),
        status("temporalUncertainty", "Timing review"),
      ];
    case "collected-income":
      return [
        text("propertyName", "Property", propertyName),
        text("unitNumber", "Unit", unitNumber),
        text("tenantName", "Resident", tenantName),
        date("paymentOn", "Payment date"),
        status("category", "Category"),
        currency("amountCents", "Amount"),
        text("description", "Description"),
      ];
    case "scheduled-vs-collected":
      return [
        text("propertyName", "Property", propertyName),
        text("month", "Month"),
        currency("scheduledCents", "Scheduled"),
        currency("collectedCents", "Collected"),
        currency("varianceCents", "Variance"),
        status("complete", "Complete"),
        text("uncertaintyCodes", "Review flags"),
      ];
    case "delinquency":
      return [
        text("propertyName", "Property", propertyName),
        text("unitNumber", "Unit", unitNumber),
        text("tenantName", "Tenant", tenantName),
        status("tenancyStatus", "Tenant status"),
        currency("operationalBalanceCents", "Operational balance"),
        currency("totalBalanceCents", "Posted ledger total"),
        ...[
          currency("rentOnlyBalanceCents", "Posted rent balance"),
          currency("nonRentBalanceCents", "Posted non-rent balance"),
          text("reviewedOperationalBalance", "Reviewed operational balance", (row) => balanceReviewReportText("balanceReview" in row ? row.balanceReview : undefined)),
          currency("unappliedCashCents", "Unapplied cash"),
          date("oldestUnpaidRentOn", "Oldest unpaid rent"),
          date("lastPaymentOn", "Last payment"),
          status("noticeStatus", "Notice status"),
        ].map(column => ({ ...column, curated: false })),
      ];
    case "tenant-ledger":
      return [
        text("propertyName", "Property", propertyName),
        text("unitNumber", "Unit", unitNumber),
        text("tenantName", "Resident", tenantName),
        date("postedOn", "Posted", (row) => readNestedTransaction(row, "postedOn")),
        date("dueOn", "Due", (row) => readNestedTransaction(row, "dueOn")),
        status("kind", "Entry", (row) => readNestedTransaction(row, "kind")),
        status("category", "Category", (row) => readNestedTransaction(row, "category")),
        text("description", "Description", (row) => readNestedTransaction(row, "description")),
        currency("amountCents", "Amount"),
        currency("allocatedCents", "Allocated"),
        currency("openCents", "Open"),
        field("runningBalanceCents", "currency", "Running balance"),
        status("status", "Status", (row) => readNestedTransaction(row, "status")),
      ];
    case "lease-expiration":
      return [
        text("propertyName", "Property", propertyName),
        text("unitNumber", "Unit", unitNumber),
        text("tenantName", "Resident", tenantName),
        date("contractEndOn", "Lease ends"),
        status("monthToMonth", "Month to month"),
        currency("currentBaseRentCents", "Base rent"),
        date("noticeDeadlineOn", "Notice deadline"),
        status("actionStatus", "Action"),
      ];
    case "security-deposit":
      return [
        text("propertyName", "Property", propertyName),
        text("unitNumber", "Unit", unitNumber),
        text("tenantName", "Resident", tenantName),
        currency("securityHeldCents", "Security held"),
        currency("refundablePetHeldCents", "Pet held"),
        currency("otherRefundableHeldCents", "Other refundable held"),
        currency("totalHeldCents", "Total held"),
        status("dispositionStatus", "Disposition"),
        integer("unknownHeldCount", "Unknown amounts"),
        status("temporalUncertainty", "Date review"),
      ];
    case "applicant-pipeline":
      return [
        text("displayName", "Applicant"),
        text("propertyName", "Property", propertyName),
        text("unitInterest", "Unit interest"),
        date("submittedOn", "Submitted"),
        status("status", "Status"),
        text("missingItems", "Missing items"),
        integer("daysInStage", "Days in stage"),
      ];
    case "hap":
      return [
        text("propertyName", "Property", propertyName),
        text("unitNumber", "Unit", unitNumber),
        text("tenantName", "Resident", tenantName),
        text("agencyName", "Agency"),
        text("month", "Month"),
        currency("agencyObligationCents", "Agency obligation"),
        currency("tenantObligationCents", "Tenant obligation"),
        currency("expectedTotalCents", "Expected total"),
        currency("receivedAgencyCents", "Agency received"),
        currency("varianceCents", "Variance"),
        status("exception", "Exception"),
      ];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNestedTransaction(row: ReportRow, key: string): unknown {
  if (!isRecord(row)) return undefined;
  const transaction = row.transaction;
  return isRecord(transaction) ? transaction[key] : undefined;
}

function readRaw(row: ReportRow, key: string): unknown {
  if (!isRecord(row)) return undefined;
  if (key in row) return row[key];
  const transaction = row.transaction;
  if (isRecord(transaction) && key in transaction) return transaction[key];
  return undefined;
}

function propertyId(row: ReportRow): string | undefined {
  const value = readRaw(row, "propertyId");
  return typeof value === "string" && value.length ? value : undefined;
}

function unitId(row: ReportRow): string | undefined {
  const value = readRaw(row, "unitId");
  return typeof value === "string" && value.length ? value : undefined;
}

function personId(row: ReportRow): string | undefined {
  const value = readRaw(row, "personId") ?? readRaw(row, "currentPersonId") ?? readRaw(row, "futurePersonId");
  return typeof value === "string" && value.length ? value : undefined;
}

/** Read a positive browser row field, including a nested ledger transaction. */
export function readReportValue(row: ReportRow, key: string, snapshot?: AdminSnapshot): unknown {
  if (key === "propertyName") return propertyName(row, snapshot);
  if (key === "unitNumber") return unitNumber(row, snapshot);
  if (key === "tenantName") return tenantName(row, snapshot);
  return readRaw(row, key);
}

const INTERNAL_ID_KEYS = new Set([
  "id",
  "propertyId",
  "unitId",
  "tenancyId",
  "personId",
  "currentPersonId",
  "futurePersonId",
  "applicationId",
  "scheduleId",
  "paymentTransactionId",
  "chargeTransactionId",
  "reversalOfId",
  "executedDocumentId",
  "renewalOfId",
]);

function isInternalIdKey(key: string): boolean {
  return INTERNAL_ID_KEYS.has(key) || /Id$/.test(key) || key === "transaction" || key.startsWith("__");
}

export function labelForKey(key: string): string {
  const labels: Record<string, string> = {
    balanceComplete: "Balance status",
    balanceUncertaintyCodes: "Balance review",
    temporalUncertainty: "Timing review",
    effectiveFromKnowledge: "Effective date knowledge",
    uncertaintyCodes: "Review flags",
    missingItems: "Missing items",
    sourceBalanceCents: "Source balance",
  };
  return labels[key] ?? key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function inferFormat(key: string, value: unknown): ReportColumn["format"] {
  if (/Cents$/.test(key)) return "currency";
  if (/On$|Date$/.test(key)) return "date";
  if (/Count$/.test(key) || typeof value === "number") return "integer";
  if (typeof value === "boolean" || /status|state|occupancy|readiness|listing|complete|uncertainty|exception/i.test(key)) return "status";
  return undefined;
}

function discoverSourceKeys(rows: readonly ReportRow[]): string[] {
  const keys = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    for (const key of Object.keys(row)) {
      if (!isInternalIdKey(key) && key !== "balanceReview") keys.add(key);
    }
    const transaction = row.transaction;
    if (isRecord(transaction)) {
      for (const key of Object.keys(transaction)) {
        if (!isInternalIdKey(key) && key !== "balanceReview") keys.add(key);
      }
    }
  }
  return Array.from(keys).sort((left, right) => left.localeCompare(right));
}

export function discoverOptionalReportColumns(key: ReportKey, rows: readonly ReportRow[], snapshot?: AdminSnapshot): ReportColumnDefinition[] {
  const curated = reportColumns(key);
  const curatedKeys = new Set(curated.map((column) => column.key));
  return discoverSourceKeys(rows)
    .filter((candidate) => !curatedKeys.has(candidate))
    .map((candidate) => {
      const sample = rows.map((row) => readReportValue(row, candidate, snapshot)).find((value) => value !== undefined && value !== null && value !== "");
      const format = inferFormat(candidate, sample);
      return {
        key: candidate,
        label: labelForKey(candidate),
        format,
        align: format === "currency" || format === "integer" || format === "percent" ? "right" : undefined,
        curated: false,
        read: (row: ReportRow, currentSnapshot?: AdminSnapshot) => readReportValue(row, candidate, currentSnapshot),
      } satisfies ReportColumnDefinition;
    });
}

export function getReportConfig(key: ReportKey): ReportConfig {
  const columns = reportColumns(key);
  return {
    key,
    label: key === "rent-roll" ? "Rent roll" : key === "occupancy" ? "Vacancies" : key === "delinquency" ? "Balances due" : REPORT_LABELS[key],
    description: REPORT_DESCRIPTIONS[key],
    sourceNote: REPORT_SOURCE_NOTES[key],
    period: REPORT_PERIODS[key],
    columns,
  };
}

export function getReportColumns(key: ReportKey, rows: readonly ReportRow[] = [], snapshot?: AdminSnapshot): ReportColumnDefinition[] {
  return [...reportColumns(key), ...discoverOptionalReportColumns(key, rows, snapshot)];
}

export function toDisplayReportRows(key: ReportKey, rows: readonly ReportRow[], snapshot?: AdminSnapshot): DisplayReportRow[] {
  const columns = getReportColumns(key, rows, snapshot);
  return rows.map((source, index) => {
    const display: DisplayReportRow = { __source: source, __index: index };
    for (const column of columns) display[column.key] = column.read(source, snapshot);
    return display;
  });
}

export function createReportViewModel(key: ReportKey, rows: readonly ReportRow[], snapshot?: AdminSnapshot): ReportViewModel {
  const config = getReportConfig(key);
  const columns = getReportColumns(key, rows, snapshot);
  return {
    ...config,
    columns,
    curatedColumns: columns.filter((column) => column.curated !== false),
    optionalColumns: columns.filter((column) => column.curated === false),
    rows: [...rows],
    displayRows: toDisplayReportRows(key, rows, snapshot),
  };
}

function normalized(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replaceAll("_", " ");
}

export function filterReportRowsForDisplay(
  rows: readonly ReportRow[],
  key: ReportKey,
  filters: Pick<ViewFilters, "propertyId" | "propertyScope" | "status" | "search">,
  snapshot?: AdminSnapshot,
): ReportRow[] {
  const property = filters.propertyId !== "all" && snapshot
    ? snapshot.snapshot.properties.find((candidate) => candidate.id === filters.propertyId)
    : undefined;
  const search = filters.search.trim().toLowerCase();
  const statusValue = normalized(filters.status);
  const columns = getReportColumns(key, rows, snapshot).filter((column) => column.curated !== false);
  return rows.filter((row) => {
    const rowProperty = propertyId(row);
    const rowPropertyName = readReportValue(row, "propertyName", snapshot);
    const propertyMatches = filters.propertyId === "all"
      || (rowProperty ? rowProperty === filters.propertyId : property ? normalized(rowPropertyName) === normalized(property.name) : true);
    const activeMatches = filters.propertyScope !== "active" || !rowProperty || !snapshot
      || snapshot.snapshot.properties.some((candidate) => candidate.id === rowProperty && candidate.state === "active");
    const values = columns.map((column) => column.read(row, snapshot));
    const statusMatches = statusValue === "all" || values.some((value) => normalized(value) === statusValue);
    const searchMatches = !search || values.some((value) => normalized(value).includes(search));
    return propertyMatches && activeMatches && statusMatches && searchMatches;
  });
}

const BALANCE_TOTAL_KEYS = new Set([
  "balanceDueCents",
  "rentOnlyBalanceCents",
  "nonRentBalanceCents",
  "grossBalanceCents",
  "totalBalanceCents",
  "netAccountBalanceCents",
  "unappliedCashCents",
  "prepaidCents",
  "runningBalanceCents",
  "openCents",
]);

/** Only a server-confirmed vacancy with zero scheduled obligation has no contractual rent. */
export function isVacantWithoutObligation(row: ReportRow): boolean {
  return readRaw(row, "occupancy") === "vacant"
    && !readRaw(row, "tenancyId") && !readRaw(row, "currentPersonId") && !readRaw(row, "futurePersonId")
    && readRaw(row, "totalScheduledCents") === 0 && readRaw(row, "recurringFeesCents") === 0
    && (readRaw(row, "baseRentCents") == null || readRaw(row, "baseRentCents") === 0);
}

function guardedMoney(row: ReportRow, key: string): unknown {
  const value = readRaw(row, key);
  if (key === "operationalBalanceCents") {
    const review = readRaw(row, "balanceReview");
    if (isRecord(review) && review.stale === true) return null;
    // Compatibility with older report responses; explicit null never falls back.
    if (value !== undefined) return value;
    if (readRaw(row, "balanceComplete") !== true) return null;
    return readRaw(row, "balanceDueCents") ?? readRaw(row, "totalBalanceCents");
  }
  if (key === "baseRentCents" && isVacantWithoutObligation(row)) return 0;
  if (BALANCE_TOTAL_KEYS.has(key) && readRaw(row, "balanceComplete") === false) return null;
  if (key === "totalScheduledCents" && readRaw(row, "baseRentCents") == null && !isVacantWithoutObligation(row)) return null;
  if (/HeldCents$/.test(key) && (Number(readRaw(row, "unknownHeldCount")) > 0 || readRaw(row, "temporalUncertainty") === true)) return null;
  if (["agencyObligationCents", "tenantObligationCents", "expectedTotalCents", "varianceCents"].includes(key) && readRaw(row, "exception") === true) return null;
  return value;
}

function safeSubtotalValue(row: ReportRow, key: string, value: unknown): value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return false;
  if (BALANCE_TOTAL_KEYS.has(key) && readRaw(row, "balanceComplete") !== true) return false;
  if (readRaw(row, "complete") === false || readRaw(row, "exception") === true) return false;
  if (key === "amountCents" && ((readRaw(row, "known") !== undefined && readRaw(row, "known") !== true) || readRaw(row, "uncertain") === true || readRaw(row, "temporalUncertainty") === true || readRaw(row, "unclassified") === true)) return false;
  return true;
}

export function buildPropertySubtotals(key: ReportKey, rows: readonly ReportRow[], snapshot?: AdminSnapshot): PropertySubtotal[] {
  const columns = reportColumns(key).filter((column) => column.subtotal);
  const groups = new Map<string, { propertyId?: string; label: string; rows: ReportRow[] }>();
  for (const row of rows) {
    const id = propertyId(row);
    const nameValue = readReportValue(row, "propertyName", snapshot);
    const label = typeof nameValue === "string" && nameValue.trim() ? nameValue : id && snapshot
      ? snapshot.snapshot.properties.find((property) => property.id === id)?.name ?? "Needs review"
      : "Needs review";
    const groupKey = id ?? `name:${label}`;
    const existing = groups.get(groupKey);
    if (existing) existing.rows.push(row);
    else groups.set(groupKey, { propertyId: id, label, rows: [row] });
  }
  return Array.from(groups.values())
    .sort((left, right) => left.label.localeCompare(right.label))
    .map((group) => {
      const amounts: Record<string, number | null> = {};
      for (const column of columns) {
        const values = group.rows.map((row) => column.read(row, snapshot));
        amounts[column.key] = values.length > 0 && values.every((value, index) => safeSubtotalValue(group.rows[index], column.key, value))
          ? values.reduce((sum, value) => sum + (value as number), 0)
          : null;
      }
      return { propertyId: group.propertyId, label: group.label, count: group.rows.length, amounts };
    });
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  const safe = /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function formatReportValue(value: unknown, format?: ReportColumn["format"]): string {
  if (value === null || value === undefined || value === "") return "Needs review";
  if (format === "currency") return formatMoney(value);
  if (format === "date") return formatDate(value);
  if (format === "percent") {
    if (typeof value !== "number" || !Number.isFinite(value)) return "Needs review";
    return `${(Math.abs(value) <= 1 ? value * 100 : value).toFixed(1)}%`;
  }
  if (format === "integer") return typeof value === "number" && Number.isSafeInteger(value) ? value.toLocaleString("en-US") : "Needs review";
  if (format === "status") {
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (Array.isArray(value)) return value.length ? value.map(formatLabel).join(", ") : "Needs review";
    return formatLabel(value);
  }
  if (Array.isArray(value)) return value.length ? value.map(formatLabel).join(", ") : "Needs review";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "Needs review";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (isRecord(value)) return "Needs review";
  return String(value);
}

export function formatReportCellValue(row: DisplayReportRow, column: ReportColumnDefinition): string {
  if (column.key === "baseRentCents" && isVacantWithoutObligation(row.__source)) return "—";
  return formatReportValue(row[column.key], column.format);
}

export function buildReportCsv(rows: readonly DisplayReportRow[], columns: readonly ReportColumnDefinition[]): string {
  return [
    columns.map((column) => csvCell(column.label)).join(","),
    ...rows.map((row) => columns.map((column) => csvCell(formatReportCellValue(row, column))).join(",")),
  ].join("\n");
}

export function reportRowKey(row: DisplayReportRow): string {
  const source = row.__source;
  const sourceId = readRaw(source, "id") ?? (readRaw(source, "transaction") ? readNestedTransaction(source, "id") : undefined);
  const identity = [propertyId(source), unitId(source), personId(source), sourceId, readRaw(source, "postedOn"), readRaw(source, "month")].filter((value) => value != null).map(String).join(":");
  return `${identity || "row"}:${row.__index}`;
}

function stableObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
}

export function reportRequestKey(report: ReportKey, filters: ApiFilters): string {
  return `${report}:${JSON.stringify(stableObject(filters))}`;
}

/** Rent roll is already fully scoped and dated by the server; only its terminal text search is local. */
export function filterRentRollRows(rows: ReportRow[], search: string): ReportRow[] {
  const query = search.trim().toLowerCase();
  if (!query) return rows;
  return rows.filter(row => `${readRaw(row, "propertyName") ?? ""} ${readRaw(row, "unitNumber") ?? ""} ${readRaw(row, "currentTenantName") ?? "Unknown applicant/tenant"} ${readRaw(row, "futureTenantName") ?? "Unknown applicant/tenant"}`.toLowerCase().includes(query));
}

export function reportQueryKey(report: ReportKey, filters: ApiFilters, authenticatedUserId: string) {
  return ["rent-ops-workspace", "report", authenticatedUserId, report, filters] as const;
}

export const occupancyReportStatusOptions = [["all", "All"], ["current", "Current"], ["future_preleased", "Future preleased"], ["vacant", "Vacant"], ["unknown", "Needs review"]] as const;
export function isOccupancyReport(key: ReportKey): boolean {
  return key === "rent-roll" || key === "occupancy";
}

/** Report statuses are distinct from tenant populations and unit occupancy. */
export function reportSupportsStatus(key: ReportKey, status: string): boolean {
  switch (key) {
    case "lease-expiration": return ["month_to_month", "expiring", "not_due"].includes(status);
    case "hap": return ["active", "ended", "pending"].includes(status);
    case "applicant-pipeline": return ["complete", "in_progress", "awaiting_payment", "draft", "submitted", "missing_information", "under_review", "approved", "declined", "withdrawn", "converted"].includes(status);
    default: return false;
  }
}

export function reportQueryFilters(
  filters: ViewFilters,
  key: ReportKey,
  period: { asOfDate: string; month?: string; fromDate?: string; toDate?: string },
): ApiFilters {
  const mode = REPORT_PERIODS[key];
  return {
    propertyScope: filters.propertyScope,
    ...(filters.propertyIds?.length ? { propertyIds: [...filters.propertyIds].sort() } : filters.propertyId !== "all" ? { propertyId: filters.propertyId } : {}),
    ...(filters.balanceStatus ? { balanceStatus: filters.balanceStatus } : {}),
    ...(isTenantStatusReport(key) ? { tenantStatus: defaultReportTenantStatus(key, filters.tenantStatus) } : {}),
    ...(filters.readiness?.length ? { readiness: filters.readiness } : {}),
    asOfDate: period.asOfDate,
    ...(mode === "month" && period.month ? { month: period.month } : {}),
    ...(mode === "range" && period.fromDate && period.toDate ? { fromDate: period.fromDate, toDate: period.toDate } : {}),
    ...(isOccupancyReport(key)
      ? occupancyReportStatusOptions.some(([value]) => value !== "all" && value === filters.status) ? { occupancy: [filters.status] } : {}
      : reportSupportsStatus(key, filters.status) ? { status: [filters.status] } : {}),
    ...(key !== "rent-roll" && filters.search.trim() ? { search: filters.search.trim() } : {}),
  };
}

export function validateReportPeriod(key: ReportKey, asOfDate: string, month: string, fromDate: string, toDate: string): string | undefined {
  if (!isIsoDate(asOfDate)) return "Choose a valid report date.";
  const mode = REPORT_PERIODS[key];
  if (mode === "month") {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return "Choose a valid report month.";
    if (month > asOfDate.slice(0, 7)) return "The report month cannot be after the report date.";
  }
  if (mode === "range") {
    if (!isIsoDate(fromDate) || !isIsoDate(toDate)) return "Choose a start and end date.";
    if (fromDate > toDate) return "The start date must be on or before the end date.";
    if (toDate > asOfDate) return "The activity range cannot extend beyond the report date.";
  }
  return undefined;
}

function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dateValue = new Date(Date.UTC(year, month - 1, day));
  return dateValue.getUTCFullYear() === year && dateValue.getUTCMonth() === month - 1 && dateValue.getUTCDate() === day;
}

export function reportPeriodLabel(key: ReportKey, asOfDate: string, month: string, fromDate: string, toDate: string): string {
  switch (REPORT_PERIODS[key]) {
    case "month": return month || asOfDate.slice(0, 7) || "Needs review";
    case "range": return fromDate && toDate ? `${fromDate} through ${toDate}` : "Choose activity range";
    default: return asOfDate ? `As of ${asOfDate}` : "Needs review";
  }
}

export function emptyReportMessage(loaded: boolean): string {
  return loaded ? "No records returned for the selected filters." : "Loading the selected report…";
}

export function reportKeys(): readonly ReportKey[] {
  return REPORT_KEYS;
}

/** Preserve the grid's full filtered order and column order, without page slicing. */
export function projectReportGridView(rows: DisplayReportRow[], columnKeys: string[]) {
  const signature = JSON.stringify([columnKeys, rows.map(row => [reportRowKey(row), ...columnKeys.map(key => row[key])])]);
  return { rows, columnKeys, signature };
}


export type ReportBalanceFilter = "all" | "due" | "zero" | "credit" | "unverified";
export interface ReportLocalFilters {
  propertyIds?: readonly string[];
  occupancy?: string;
  readiness?: string;
  listing?: string;
  balance?: ReportBalanceFilter;
  tenancyStatus?: string;
}

/** Narrow server rows without converting unknown balances to zero or a debt. */
export function filterReportLocalRows(rows: readonly ReportRow[], key: ReportKey, filters: ReportLocalFilters): ReportRow[] {
  return rows.filter(row => {
    if (filters.propertyIds?.length && !filters.propertyIds.includes(propertyId(row) ?? "")) return false;
    for (const field of ["occupancy", "readiness", "listing", "tenancyStatus"] as const) {
      const selected = filters[field];
      if (selected && selected !== "all" && readRaw(row, field) !== selected) return false;
    }
    const balance = filters.balance ?? "all";
    if (balance === "all") return true;
    const amount = guardedMoney(row, "operationalBalanceCents");
    const known = typeof amount === "number" && Number.isSafeInteger(amount);
    if (balance === "unverified") return !known;
    if (!known) return false;
    return balance === "due" ? amount > 0 : balance === "credit" ? amount < 0 : amount === 0;
  });
}

export interface ReportPropertyGroup extends PropertySubtotal { rows: DisplayReportRow[] }

/** Property sections, unit-natural order, and their complete filtered subtotals. */
export function groupReportRows(key: ReportKey, rows: readonly DisplayReportRow[], snapshot?: AdminSnapshot, sort?: { key: string; direction: "asc" | "desc" }): ReportPropertyGroup[] {
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  return buildPropertySubtotals(key, rows.map(row => row.__source), snapshot).map(subtotal => ({
    ...subtotal,
    rows: rows.filter(row => {
      if (subtotal.propertyId) return propertyId(row.__source) === subtotal.propertyId;
      const name = propertyName(row.__source, snapshot);
      const label = typeof name === "string" && name.trim() ? name : "Needs review";
      return !propertyId(row.__source) && label === subtotal.label;
    }).sort((left, right) => {
      const column = sort?.key ?? "unitNumber";
      const a = left[column]; const b = right[column];
      const comparison = a == null ? b == null ? 0 : 1 : b == null ? -1 : typeof a === "number" && typeof b === "number" ? a - b : collator.compare(String(a), String(b));
      return (sort?.direction === "desc" ? -comparison : comparison) || collator.compare(String(left.unitNumber ?? ""), String(right.unitNumber ?? "")) || left.__index - right.__index;
    }),
  }));
}

/** Match the displayed identity, including a future-only row, never a neighboring name. */
export function reportCellPersonId(row: ReportRow, columnKey: string): string | undefined {
  const id = columnKey === "futureTenantName" ? readRaw(row, "futurePersonId")
    : columnKey === "currentTenantName" ? readRaw(row, "currentPersonId") ?? (!readRaw(row, "currentTenantName") && readRaw(row, "occupancy") !== "current" ? readRaw(row, "futurePersonId") : undefined)
    : readRaw(row, "personId") ?? readRaw(row, "currentPersonId") ?? (readRaw(row, "currentTenantName") || readRaw(row, "occupancy") === "current" ? undefined : readRaw(row, "futurePersonId"));
  return typeof id === "string" && id.length > 0 ? id : undefined;
}


/** Explicit URL preferences override this fallback in the report workspace. */
export function defaultReportOccupancy(key: ReportKey, status = "all"): string {
  if (["current", "vacant", "future_preleased", "unknown"].includes(status)) return status;
  return key === "rent-roll" ? "current" : key === "occupancy" ? "vacant" : "all";
}

/** Vacancy and applicant reports describe different populations; rent roll uses occupancy. */
export function isTenantStatusReport(key: ReportKey): boolean {
  return key !== "rent-roll" && key !== "occupancy" && key !== "applicant-pipeline";
}

/** Explicit alternate selections remain valid; unfiltered tenant reports start current. */
export function defaultReportTenantStatus(key: ReportKey, status?: string): NonNullable<ViewFilters["tenantStatus"]> {
  if (!isTenantStatusReport(key)) return "all";
  return status && ["all", "current", "former", "future", "unknown"].includes(status)
    ? status as NonNullable<ViewFilters["tenantStatus"]> : "current";
}
