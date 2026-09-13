import { usdCurrencyFormatter } from '../../lib/rent-ops-formatters';
import { APPLICATION_STATUS_TRANSITIONS } from "../../../../shared/application-status-transitions";
import { ManagerLeaseUpload } from "./manager-lease-upload";
import { useCallback, useEffect, useMemo, useState, useRef, type FormEvent } from "react";
import {
  AlertCircle,
  Building2,
  ClipboardList,
  Download,
  FileClock,
  FileText,
  Home,
  Loader2,
  LogOut,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Users,
  WalletCards,
  X,
} from "lucide-react";

import {
  filterReportRows,
  currentLocalIsoDate,
  downloadRentOpsDocument,
  loadRentOpsAdminSnapshot,
  loadRentOpsChargeDefinitions,
  loadRentOpsReport,
  loadRentOpsPreviewContext,
  postRentOpsMutation,
  reportCell,
  reportToCsv,
} from "./api";
import { rentOpsAuthClient } from "./auth";
import { RentOpsAdminLogin, RentOpsAuthLoading, useRentOpsAuth } from "./auth-ui";
import { handleRentOpsMutationError, refreshRentOpsAfterConflict, sectionCreateAction, scheduledRentNeedsReview, balanceMetric } from "./ui";
import { ApplicationCaseDetail } from "./application-case-detail";
import { PhoneMethodsEditor } from "./phone-methods-editor";
import { ManagerIncomeActions } from "./manager-income-actions";
import { RecurringBillingPanel } from "./recurring-billing-panel";
import { depositAmounts, depositMoney } from "../tenant-portal/deposit-view";
import { TenantPortalAccountsPanel } from "../tenant-portal/admin-accounts";
import { mutationPayload, RENT_OPS_QUICK_ADD_ACTIONS, type FormValues, type QuickAction } from "./form-payload";
import {
  REPORT_KEYS,
  REPORT_LABELS,
  type AdminSnapshot,
  type ReportDefinition,
  type ReportKey,
  type SectionKey,
  type TenantTab,
  type TenantView,
  type ViewFilters,
} from "./types";
import "./rent-ops.css";

const SECTIONS: Array<{ key: SectionKey; label: string; icon: typeof FileText }> = [
  { key: "dashboard", label: "Dashboard", icon: Home },
  { key: "reports", label: "Reports", icon: FileText },
  { key: "rent-roll", label: "Rent roll", icon: ClipboardList },
  { key: "tenants", label: "Tenants", icon: Users },
  { key: "properties", label: "Properties & units", icon: Building2 },
  { key: "leases", label: "Leases", icon: FileClock },
  { key: "income", label: "Income & ledger", icon: WalletCards },
  { key: "applicants", label: "Applicants", icon: Users },
  { key: "documents", label: "Documents & activity", icon: FileText },
];

const TENANT_TABS: TenantTab[] = ["summary", "household", "tenancy", "charges", "ledger", "deposits", "housing-assistance", "documents", "activity"];

function today(): string {
  return currentLocalIsoDate();
}

function title(value: unknown): string {
  if (value === "amountHeldCents") return "Amount held";
  if (value === "sourceBalanceCents") return "Source balance";
  return String(value ?? "—").replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function money(cents: unknown): string {
  if (cents == null || cents === "") return "Needs review";
  const amount = typeof cents === "number" ? cents : Number(cents);
  if (!Number.isFinite(amount)) return "Needs review";
  return usdCurrencyFormatter.format(amount / 100);
}

function formatCell(value: unknown, key: string, format?: string): string {
  if (key === "balanceComplete") return value === false ? "Needs review" : value === true ? "Complete" : "Needs review";
  if (key === "balanceUncertaintyCodes" && Array.isArray(value) && !value.length) return "—";
  if (/HeldCents$/.test(key) || key === "sourceBalanceCents") return depositMoney(value);
  if (value == null || value === "") return "Needs review";
  if (/knowledge/i.test(key)) {
    if (["unknown", "ambiguous", "inferred"].includes(String(value))) return "Needs review";
    if (String(value) === "manual") return "Entered manually";
    if (["source", "exact", "confirmed", "known"].includes(String(value))) return "Known";
  }
  if (format === "currency" || /Cents$/.test(key)) return money(value);
  if (format === "percent") {
    const number = Number(value);
    return Number.isFinite(number) ? `${(Math.abs(number) <= 1 ? number * 100 : number).toFixed(1)}%` : String(value);
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.map(title).join(", ") : "Needs review";
  if (typeof value === "object") return Object.values(value).filter(value => value != null && value !== "").join(", ") || "Needs review";
  return format === "status" || /status|state|occupancy|readiness/i.test(key) ? title(value) : String(value);
}

function saveTextFile(name: string, contents: string): void {
  const blob = new Blob([contents], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

async function saveDocumentFile(record: { id: string; fileName?: string; downloadAvailable: boolean }): Promise<void> {
  if (!record.downloadAvailable) return;
  const blob = await downloadRentOpsDocument(record.id);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = record.fileName || "document";
  link.click();
  URL.revokeObjectURL(url);
}

function reportRowKey(report: ReportDefinition, row: ReportDefinition["rows"][number], index: number): string {
  const values = report.columns.map((column) => {
    const value = reportCell(row, column.key);
    return typeof value === "string" ? value : JSON.stringify(value) ?? String(value ?? "");
  });
  return `${report.key}:${values.join("\u001f")}:${index}`;
}

function DataTable({ report, onRow }: { report: ReportDefinition; onRow?: (row: ReportDefinition["rows"][number]) => void }) {
  if (!report.rows.length) return <EmptyState message="No records match these filters." />;
  return (
    <div className="ro-table-wrap">
      <table className="ro-table">
        <thead><tr>{report.columns.map((column) => <th key={column.key} className={column.align === "right" ? "number" : ""}>{column.label}</th>)}</tr></thead>
        <tbody>
          {report.rows.map((row, index) => (
            <tr key={reportRowKey(report, row, index)} tabIndex={onRow ? 0 : undefined} className={"rowType" in row && row.rowType === "opening_balance" ? "ro-opening-balance" : onRow ? "clickable" : ""} onClick={() => onRow?.(row)} onKeyDown={(event) => { if (onRow && (event.key === "Enter" || event.key === " ")) onRow(row); }}>
              {report.columns.map((column) => <td key={column.key} className={column.align === "right" || column.format === "currency" ? "number" : ""}>{formatCell(reportCell(row, column.key), column.key, column.format)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return <div className="ro-empty"><Home aria-hidden="true" /><p>{message}</p></div>;
}

function StatCard({ label, value, tone, onClick }: { label: string; value: string; tone?: "warn" | "good"; onClick?: () => void }) {
  const content = <><span>{label}</span><strong>{value}</strong></>;
  return onClick ? <button className={`ro-stat ${tone ?? ""}`} onClick={onClick}>{content}</button> : <div className={`ro-stat ${tone ?? ""}`}>{content}</div>;
}

type Field = { name: string; label: string; type?: "text" | "date" | "datetime-local" | "number" | "select" | "textarea" | "checkbox"; required?: boolean; options?: Array<[string, string]> };

function baseOptions(snapshot: AdminSnapshot) {
  return {
    properties: snapshot.snapshot.properties.map((item) => [item.id, item.name ?? "Needs review"] as [string, string]),
    units: snapshot.snapshot.units.map((item) => [item.id, `${snapshot.snapshot.properties.find((p) => p.id === item.propertyId)?.name ?? "Needs review"} · ${item.unitNumber ?? "Needs review"}`] as [string, string]),
    people: snapshot.snapshot.people.map((item) => [item.id, `${item.firstName ?? "Needs review"} ${item.lastName ?? "Needs review"}`] as [string, string]),
    tenancies: snapshot.snapshot.tenancies.map((item) => [item.id, `${snapshot.snapshot.units.find((unit) => unit.id === item.unitId)?.unitNumber ?? "Needs review"} · ${title(item.status)}`] as [string, string]),
    payments: snapshot.snapshot.ledgerTransactions.filter((item) => item.kind === "payment").map((item) => [item.id, `${item.postedOn ?? "Needs review"} · ${money(item.amountCents)} · ${item.description ?? "Needs review"}`] as [string, string]),
    charges: snapshot.snapshot.ledgerTransactions.filter((item) => item.kind === "charge").map((item) => [item.id, `${item.postedOn ?? "Needs review"} · ${money(item.amountCents)} · ${item.description ?? "Needs review"}`] as [string, string]),
    ledger: snapshot.snapshot.ledgerTransactions.filter((item) => item.status === "posted").map((item) => [item.id, `${title(item.kind)} · ${item.postedOn ?? "Needs review"} · ${money(item.amountCents)}`] as [string, string]),
  };
}

function rawActionFields(action: QuickAction, snapshot: AdminSnapshot, initialValues: FormValues = {}): Field[] {
  const options = baseOptions(snapshot);
  const property: Field = { name: "propertyId", label: "Property", type: "select", required: true, options: options.properties };
  const unit: Field = { name: "unitId", label: "Unit", type: "select", options: options.units };
  const tenancy: Field = { name: "tenancyId", label: "Tenancy", type: "select", options: options.tenancies };
  const person: Field = { name: "personId", label: "Resident", type: "select", options: options.people };
  const dollars: Field = { name: "amountDollars", label: "Amount", type: "number", required: true };
  const confirmedDefinitions = snapshot.chargeDefinitions.filter((definition) => definition.id && definition.category && definition.active === true && (definition.activeKnowledge === "source" || definition.activeKnowledge === "manual") && (definition.categoryKnowledge === "source" || definition.categoryKnowledge === "manual"));
  const definitionOptions: Array<[string, string]> = confirmedDefinitions.map((definition) => [definition.id!, `${definition.displayName ?? "Needs review"} · ${title(definition.category)}`]);
  const categoryOptions: Array<[string, string]> = Array.from(new Set(confirmedDefinitions.map((definition) => definition.category).filter((category): category is string => Boolean(category)))).map((category) => [category, title(category)]);
  const conversionDefinitionOptions: Array<[string, string]> = confirmedDefinitions.filter((definition) => definition.category === "base_rent").map((definition) => [definition.id!, `${definition.displayName ?? "Needs review"} · Base rent`]);
  const scopeOptions: Array<[string, string]> = [
    ...options.properties.map(([id, label]) => [id, `Property · ${label}`] as [string, string]),
    ...options.units.map(([id, label]) => [id, `Unit · ${label}`] as [string, string]),
    ...options.people.map(([id, label]) => [id, `Resident · ${label}`] as [string, string]),
  ];
  switch (action) {
    case "save-property": return [{ name: "name", label: "Property name", required: true }, { name: "slug", label: "Short URL name", required: true }, { name: "address1", label: "Street address", required: true }, { name: "city", label: "City", required: true }, { name: "stateCode", label: "State", required: true }, { name: "postalCode", label: "ZIP", required: true }, { name: "propertyType", label: "Property type", type: "select", required: true, options: [["multifamily", "Multifamily"], ["single_family", "Single family"], ["other", "Other"]] }, { name: "propertyState", label: "Property state", type: "select", required: true, options: [["active", "Active"], ["archived", "Archived"]] }, { name: "operatingContact", label: "Operating contact" }];
    case "save-unit": return [property, { name: "unitNumber", label: "Unit", required: true }, { name: "unitType", label: "Unit type" }, { name: "squareFeet", label: "Square feet", type: "number" }, { name: "defaultDepositDollars", label: "Default deposit", type: "number" }, { name: "amenitiesText", label: "Amenities (one per line)", type: "textarea" }, { name: "accessNotes", label: "Access notes", type: "textarea" }, { name: "bedrooms", label: "Bedrooms", type: "number" }, { name: "bathrooms", label: "Bathrooms", type: "number" }, { name: "marketRentDollars", label: "Market rent", type: "number" }, { name: "readiness", label: "Readiness", type: "select", required: true, options: [["ready", "Ready"], ["not_ready", "Not ready"], ["off_market", "Off market"]] }, { name: "listing", label: "Listing", type: "select", required: true, options: [["listed", "Listed"], ["unlisted", "Unlisted"], ["off_market", "Off market"]] }];
    case "save-person": return [{ name: "firstName", label: "First name", required: true }, { name: "lastName", label: "Last name", required: true }, { name: "email", label: "Email" }, { name: "phone", label: "Phone" }, { name: "renterInsuranceExpiresOn", label: "Insurance expires", type: "date" }, { name: "archived", label: "Archived", type: "checkbox" }];
    case "save-household-membership": return [{ ...tenancy, required: true }, { ...person, required: true }, { name: "role", label: "Household role", type: "select", required: true, options: [["primary", "Primary"], ["co_applicant", "Co-applicant"], ["occupant", "Occupant"], ["minor", "Minor"], ["emergency_contact", "Emergency contact"], ["other_contact", "Other contact"]] }, { name: "relationship", label: "Relationship" }, { name: "isFinanciallyResponsible", label: "Financially responsible", type: "checkbox", required: true }];
    case "save-tenancy": return [property, { ...unit, required: true }, { name: "primaryPersonId", label: "Primary resident", type: "select", required: true, options: options.people }, { name: "status", label: "Status", type: "select", required: true, options: ["future", "current", "notice", "past", "cancelled"].map((value) => [value, title(value)] as [string, string]) }, { name: "plannedMoveInOn", label: "Planned move-in", type: "date" }, { name: "actualMoveInOn", label: "Actual move-in", type: "date" }, { name: "noticeOn", label: "Notice date", type: "date" }, { name: "expectedMoveOutOn", label: "Expected move-out", type: "date" }, { name: "actualMoveOutOn", label: "Actual move-out", type: "date" }];
    case "save-lease-term": return [{ ...tenancy, required: true }, { name: "status", label: "Lease status", type: "select", required: true, options: ["draft", "executed", "expired", "month_to_month", "cancelled"].map((value) => [value, title(value)] as [string, string]) }, { name: "contractStartOn", label: "Contract start", type: "date", required: true }, { name: "contractEndOn", label: "Contract end", type: "date" }, { name: "signedOn", label: "Signed date", type: "date" }, { name: "monthToMonth", label: "Month to month", type: "checkbox", required: true }];
    case "save-recurring-schedule": return [property, { name: "unitId", label: "Unit (when applicable)", type: "select", options: options.units }, { name: "tenancyId", label: "Tenancy (when applicable)", type: "select", options: options.tenancies }, { name: "personId", label: "Resident (when applicable)", type: "select", options: options.people }, { name: "scopeType", label: "Recurring scope", type: "select", required: true, options: [["tenant", "Tenant"], ["unit", "Unit"], ["property", "Property"]] }, { name: "scopeId", label: "Selected scope", type: "select", required: true, options: scopeOptions }, { name: "chargeDefinitionId", label: "Confirmed charge definition", type: "select", required: true, options: definitionOptions }, { name: "category", label: "Charge category", type: "select", required: true, options: categoryOptions }, { name: "description", label: "Description", required: true }, dollars, { name: "billingFrequency", label: "Confirmed billing frequency", type: "select", required: true, options: [["monthly", "Monthly"]] }, { name: "effectiveFrom", label: "Effective start", type: "date", required: true }, { name: "effectiveTo", label: "Effective through", type: "date" }, { name: "active", label: "Schedule status", type: "select", required: true, options: [["true", "Active"], ["false", "Inactive"]] }];
    case "replace-recurring-schedule": return [{ name: "billingFrequency", label: "Confirm billing frequency (optional)", type: "select", options: [["monthly", "Monthly — confirmed"]] }, { name: "effectiveFrom", label: "Replacement effective date", type: "date", required: true }, { name: "amountDollars", label: "Replacement amount", type: "number", required: true }];
    case "end-recurring-schedule": return [{ name: "effectiveFrom", label: "End effective date", type: "date", required: true }];
    case "post-ledger-transaction": return [property, unit, tenancy, person, { name: "kind", label: "Entry type", type: "select", required: true, options: [["charge", "Charge"], ["credit", "Credit"]] }, { name: "category", label: "Category", type: "select", required: true, options: [["base_rent", "Base rent"], ["recurring_fee", "Recurring fee"], ["subsidy", "Housing assistance"], ["security_deposit", "Security deposit"], ["other", "Other"]] }, dollars, { name: "status", label: "Entry status", type: "select", required: true, options: [["posted", "Posted"], ["pending", "Pending"], ["voided", "Voided"]] }, { name: "postedOn", label: "Posted date", type: "date", required: true }, { name: "dueOn", label: "Due date", type: "date" }, { name: "payer", label: "Payer", type: "select", options: [["tenant", "Tenant"], ["agency", "Agency"], ["owner", "Owner"], ["unknown", "Unknown"]] }, { name: "paymentMethod", label: "Payment method", type: "select", options: ["ach", "zelle", "check", "cash", "money_order", "card", "other"].map((value) => [value, title(value)] as [string, string]) }, { name: "description", label: "Description", required: true }];
    case "save-payment-allocation": return [{ name: "paymentTransactionId", label: "Payment", type: "select", required: true, options: options.payments }, { name: "chargeTransactionId", label: "Charge", type: "select", required: true, options: options.charges }, dollars, { name: "allocatedOn", label: "Allocation date", type: "date", required: true }];
    case "reverse-ledger-transaction": return [{ name: "originalId", label: "Entry to reverse", type: "select", required: true, options: options.ledger }, { name: "postedOn", label: "Reversal date", type: "date", required: true }, { name: "status", label: "Reversal status", type: "select", required: true, options: [["posted", "Posted"], ["voided", "Voided"], ["pending", "Pending"]] }, { name: "description", label: "Reason", type: "textarea", required: true }];
    case "save-security-deposit": return [property, unit, tenancy, { ...person, required: true }, { name: "type", label: "Deposit type", type: "select", required: true, options: [["security", "Security"], ["refundable_pet", "Refundable pet"], ["other_refundable", "Other refundable"]] }, { ...dollars, label: "Amount held" }, { name: "receivedOn", label: "Received date", type: "date" }, { name: "receivedOnKnowledge", label: "Receipt-date knowledge", type: "select", options: [["source", "Known source date"], ["unknown", "Unknown"]] }, { name: "dispositionStatus", label: "Disposition", type: "select", required: true, options: [["held", "Held"], ["partially_disposed", "Partially disposed"], ["disposed", "Disposed"], ["returned", "Returned"]] }, { name: "disposedOn", label: "Disposition date", type: "date" }, { name: "dispositionNotes", label: "Disposition notes", type: "textarea" }];
    case "save-subsidy-contract": return [property, { ...unit, required: true }, { ...tenancy, required: true }, { name: "agencyName", label: "Housing agency", required: true }, { name: "contractNumber", label: "Contract number" }, { name: "effectiveFrom", label: "Effective from", type: "date", required: true }, { name: "effectiveTo", label: "Effective through", type: "date" }, { name: "agencyDollars", label: "Agency portion", type: "number", required: true }, { name: "tenantDollars", label: "Tenant portion", type: "number", required: true }, { name: "status", label: "Contract status", type: "select", required: true, options: [["active", "Active"], ["ended", "Ended"], ["pending", "Pending"], ["exception", "Exception"]] }];
    case "convert-application": {
      const applicationId = typeof initialValues.applicationId === "string" ? initialValues.applicationId : "";
      const memberIds = snapshot.snapshot.applicationHouseholdMembers.filter((member) => member.applicationId === applicationId).map((member) => member.id);
      const roleOptions = ["primary", "co_applicant", "occupant", "minor", "emergency_contact", "other_contact"].map((value) => [value, title(value)] as [string, string]);
      const fields: Field[] = [property, { ...unit, required: true }, { name: "chargeDefinitionId", label: "Confirmed base-rent definition", type: "select", required: true, options: conversionDefinitionOptions }, { name: "category", label: "Charge category", type: "select", required: true, options: [["base_rent", "Base rent"]] }, { name: "scheduleDescription", label: "Recurring schedule description", required: true }, { name: "billingFrequency", label: "Confirmed billing frequency", type: "select", required: true, options: [["monthly", "Monthly"]] }, { name: "plannedMoveInOn", label: "Planned move-in", type: "date", required: true }, { name: "leaseStatus", label: "Lease status", type: "select", required: true, options: [["draft", "Draft"], ["executed", "Executed"], ["expired", "Expired"], ["month_to_month", "Month to month"], ["cancelled", "Cancelled"]] }, { name: "contractStartOn", label: "Contract start", type: "date", required: true }, { name: "contractEndOn", label: "Contract end", type: "date" }, { name: "monthToMonth", label: "Month to month", type: "select", required: true, options: [["true", "Yes"], ["false", "No"]] }, { name: "baseRentDollars", label: "Contractual base rent", type: "number", required: true }, { name: "primaryFinanciallyResponsible", label: "Primary financially responsible", type: "select", required: true, options: [["true", "Yes"], ["false", "No"]] }, { name: "memberRole:primary", label: "Primary role", type: "select", required: true, options: roleOptions }, { name: "memberFinanciallyResponsible:primary", label: "Primary member responsibility", type: "select", required: true, options: [["true", "Yes"], ["false", "No"]] }, { name: "memberRelationship:primary", label: "Primary relationship" }];
      for (const memberId of memberIds) fields.push({ name: `memberRole:${memberId}`, label: `Member ${memberId} role`, type: "select", required: true, options: roleOptions }, { name: `memberFinanciallyResponsible:${memberId}`, label: `Member ${memberId} responsibility`, type: "select", required: true, options: [["true", "Yes"], ["false", "No"]] }, { name: `memberRelationship:${memberId}`, label: `Member ${memberId} relationship` });
      return fields;
    }
    case "save-activity": return [property, unit, tenancy, person, { name: "type", label: "Activity type", type: "select", required: true, options: ["note", "call", "email", "text", "promise_to_pay", "hold", "notice"].map((value) => [value, title(value)] as [string, string]) }, { name: "occurredAt", label: "When it occurred", type: "datetime-local", required: true }, { name: "actor", label: "Actor", required: true }, { name: "summary", label: "Summary", required: true }, { name: "detail", label: "Details", type: "textarea" }];
    default: return [];
  }
}

function actionFields(action: QuickAction, snapshot: AdminSnapshot, initialValues: FormValues = {}): Field[] {
  const fields = rawActionFields(action, snapshot, initialValues);
  const editing = typeof initialValues.revision === "number" && Number.isSafeInteger(initialValues.revision) && initialValues.revision > 0;
  // Existing imported rows can legitimately have unknown/null facts.  Sparse
  // PATCH forms never require the operator to fabricate omitted facts.
  if (!editing) return fields;
  const editableFields = action === "save-subsidy-contract" ? fields.filter((field) => field.name === "status") : fields;
  return editableFields.map((field) => ({ ...field, required: false }));
}

const ACTION_LABELS: Partial<Record<QuickAction, string>> = {
  "save-property": "Save property",
  "save-unit": "Save unit",
  "save-person": "Save resident",
  "save-household-membership": "Save household member",
  "save-tenancy": "Save tenancy",
  "save-lease-term": "Save lease term",
  "save-recurring-schedule": "Add recurring charge",
  "replace-recurring-schedule": "Replace recurring charge",
  "end-recurring-schedule": "End recurring charge",
  "post-ledger-transaction": "Post charge or credit",
  "save-payment-allocation": "Allocate payment",
  "reverse-ledger-transaction": "Reverse ledger entry",
  "save-security-deposit": "Update deposit liability",
  "save-subsidy-contract": "Update HAP contract",
  "save-activity": "Add note or activity",
  "convert-application": "Convert application",
};

function confirmedChargeDefinition(snapshot: AdminSnapshot, id: unknown, category: unknown) {
  const definitionId = typeof id === "string" ? id.trim() : "";
  const selectedCategory = typeof category === "string" ? category.trim() : "";
  const definition = snapshot.chargeDefinitions.find((candidate) => candidate.id === definitionId);
  if (!definition || !definition.category || definition.category !== selectedCategory || definition.active !== true || (definition.activeKnowledge !== "source" && definition.activeKnowledge !== "manual") || (definition.categoryKnowledge !== "source" && definition.categoryKnowledge !== "manual")) {
    throw new Error("Select an active, confirmed charge definition whose category matches the selected category.");
  }
  return definition;
}

function ActionDialog({ action, snapshot, initialValues = {}, onClose, onSaved, onConflict }: { action: QuickAction; snapshot: AdminSnapshot; initialValues?: FormValues; onClose: () => void; onSaved: (message: string) => void; onConflict?: () => void }) {
  const fields = actionFields(action, snapshot, initialValues);
  const deposit = action === "save-security-deposit" ? snapshot.snapshot.securityDeposits.find((item) => item.id === initialValues.id) : undefined;
  const depositView = deposit ? depositAmounts(deposit) : undefined;
  const [values, setValues] = useState<FormValues>(() => ({ ...Object.fromEntries(fields.map((field) => [field.name, field.type === "checkbox" ? undefined : ""])), ...initialValues }));
  const [saving, setSaving] = useState(false);
  const [changedFields, setChangedFields] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string>();
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(undefined);
    try {
      if (action === "save-recurring-schedule" || action === "convert-application") confirmedChargeDefinition(snapshot, values.chargeDefinitionId, values.category);
      if (action === "save-recurring-schedule") {
        const scopeType = String(values.scopeType ?? "");
        const scopeId = String(values.scopeId ?? "");
        const propertyId = String(values.propertyId ?? "");
        const unitId = String(values.unitId ?? "");
        const tenancyId = String(values.tenancyId ?? "");
        const personId = String(values.personId ?? "");
        if (scopeType === "property" && (scopeId !== propertyId || unitId || tenancyId || personId)) throw new Error("Property scope requires only the selected property.");
        if (scopeType === "unit" && (!unitId || tenancyId || personId)) throw new Error("Unit scope requires one exact unit and no tenant fields.");
        if (scopeType === "tenant" && (!unitId || !tenancyId || !personId)) throw new Error("Tenant scope requires an exact resident, tenancy, unit, and property.");
      }
      const result = await postRentOpsMutation({ action, payload: mutationPayload(action, values, initialValues, changedFields) });
      if (!result.ok) throw new Error(result.message ?? "The record was not saved.");
      onSaved(result.message ?? `${ACTION_LABELS[action]} completed.`); onClose();
    }
    catch (cause) { handleRentOpsMutationError(cause, onConflict, setError); }
    finally { setSaving(false); }
  }
  return (
    <div className="ro-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="ro-dialog" role="dialog" aria-modal="true" aria-labelledby="ro-action-title">
        <header><div><h2 id="ro-action-title">{ACTION_LABELS[action]}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X /></button></header>
        <form onSubmit={submit}>
          {depositView && <p>Current amount held: {depositView.held}.{depositView.sourceBalance !== undefined && <> Source balance: {depositView.sourceBalance}.</>} Leave unknown held amounts blank until confirmed.</p>}
          <div className="ro-form-grid">
            {fields.map((field) => <label key={field.name} className={field.type === "textarea" ? "wide" : ""}>{field.label}{field.required && <sup> *</sup>}{field.type === "select" ? <select required={field.required} value={String(values[field.name] ?? "")} onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}><option value="">Select…</option>{field.options?.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : field.type === "textarea" ? <textarea required={field.required} value={String(values[field.name] ?? "")} onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))} /> : field.type === "checkbox" ? <select required={field.required} value={typeof values[field.name] === "boolean" ? String(values[field.name]) : ""} onChange={(event) => { const selected = event.target.value; setChangedFields(current => new Set([...Array.from(current), field.name])); setValues(current => ({ ...current, [field.name]: selected === "" ? undefined : selected === "true" })); }}><option value="" disabled={typeof initialValues[field.name] === "boolean"}>Unknown / not specified</option><option value="true">Yes</option><option value="false">No</option></select> : <input required={field.required} type={field.type ?? "text"} step={field.type === "number" ? "0.01" : undefined} value={String(values[field.name] ?? "")} onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))} />}</label>)}
          </div>
          {error && <p className="ro-error"><AlertCircle />{error}</p>}
          <footer><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={saving}>{saving && <Loader2 className="spin" />}{saving ? "Saving…" : "Save record"}</button></footer>
        </form>
      </section>
    </div>
  );
}

function visibleProperties(snapshot: AdminSnapshot, filters: Pick<ViewFilters, "propertyId" | "propertyScope">) {
  const selected = snapshot.snapshot.properties.filter((property) => filters.propertyId === "all" || property.id === filters.propertyId);
  return filters.propertyId !== "all" || filters.propertyScope !== "active"
    ? selected
    : selected.filter((property) => property.state === "active");
}

function FilterBar({ filters, snapshot, onChange, onRefresh, refreshing }: { filters: ViewFilters; snapshot: AdminSnapshot; onChange: (next: ViewFilters) => void; onRefresh: () => void; refreshing: boolean }) {
  const properties = visibleProperties(snapshot, { propertyId: "all", propertyScope: filters.propertyScope });
  return <div className="ro-filters"><label>Scope<select aria-label="Portfolio scope" value={filters.propertyScope} onChange={(event) => onChange({ ...filters, propertyScope: event.target.value as ViewFilters["propertyScope"], propertyId: "all" })}><option value="active">Active portfolio</option><option value="all">All imported properties</option></select></label><label>Property<select value={filters.propertyId} onChange={(event) => onChange({ ...filters, propertyId: event.target.value })}><option value="all">All properties</option>{properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}</select></label><label>As of<input type="date" value={filters.asOfDate} onChange={(event) => onChange({ ...filters, asOfDate: event.target.value })} /></label><label>Status<select value={filters.status} onChange={(event) => onChange({ ...filters, status: event.target.value })}><option value="all">All statuses</option>{["current", "future_preleased", "vacant", "not_ready", "off_market", "submitted", "missing_information", "under_review"].map((status) => <option key={status} value={status}>{title(status)}</option>)}</select></label><label className="search"><Search aria-hidden="true" /><span className="sr-only">Search</span><input placeholder="Search this workspace" value={filters.search} onChange={(event) => onChange({ ...filters, search: event.target.value })} /></label><button className="icon-button" onClick={onRefresh} aria-label="Refresh" disabled={refreshing}><RefreshCw className={refreshing ? "spin" : ""} /></button></div>;
}

function Reports({ snapshot, filters, selected, onSelect }: { snapshot: AdminSnapshot; filters: ViewFilters; selected: ReportKey; onSelect: (report: ReportKey) => void }) {
  const rangeReport = selected === "collected-income" || selected === "tenant-ledger";
  const monthlyReport = ["scheduled-income", "scheduled-vs-collected", "hap"].includes(selected);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [month, setMonth] = useState("");
  const [loaded, setLoaded] = useState<ReportDefinition>();
  const requestVersion = useRef(0);
  const [appliedPeriod, setAppliedPeriod] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { requestVersion.current += 1; setAppliedPeriod(""); setLoaded(undefined); setError(""); setBusy(false); }, [selected, snapshot, filters.propertyId, filters.asOfDate]);
  const report = filterReportRows(loaded?.key === selected ? loaded : snapshot.reports[selected], filters, snapshot);
  async function applyPeriod() {
    if (rangeReport && (!fromDate || !toDate || fromDate > toDate || toDate > filters.asOfDate)) { setError("Choose a valid start and end date on or before the as-of date."); return; }
    setBusy(true); setError("");
    const version = ++requestVersion.current;
    try {
      const rows = await loadRentOpsReport(selected, { propertyScope: filters.propertyScope, ...(filters.propertyId !== "all" ? { propertyId: filters.propertyId } : {}), asOfDate: filters.asOfDate, ...(rangeReport ? { fromDate, toDate } : { month: month || filters.asOfDate.slice(0, 7) }) });
      if (version === requestVersion.current) { setLoaded({ ...snapshot.reports[selected], rows }); setAppliedPeriod(rangeReport ? `${fromDate} through ${toDate}` : month || filters.asOfDate.slice(0, 7)); }
    } catch (cause) { if (version === requestVersion.current) { setLoaded(undefined); setError(cause instanceof Error ? cause.message : "Report unavailable."); } }
    finally { if (version === requestVersion.current) setBusy(false); }
  }
  return <><div className="ro-report-picker" aria-label="Report list">{REPORT_KEYS.map((key) => <button key={key} className={selected === key ? "active" : ""} onClick={() => onSelect(key)}>{REPORT_LABELS[key]}</button>)}</div><section className="ro-panel"><div className="ro-panel-heading"><h2>{report.label} · {appliedPeriod || (monthlyReport || selected === "collected-income" ? filters.asOfDate.slice(0, 7) : `As of ${filters.asOfDate}`)}</h2><div className="ro-actions"><button className="secondary" disabled={busy} onClick={() => saveTextFile(`rent-ops-${selected}-${filters.asOfDate}.csv`, reportToCsv(report))}><Download /> CSV</button><button className="secondary" onClick={() => window.print()}><Printer /> Print</button></div></div>
    {(rangeReport || monthlyReport) && <div className="ro-filters">{rangeReport ? <><label>From<input type="date" max={filters.asOfDate} value={fromDate} onChange={event => setFromDate(event.target.value)} /></label><label>Through<input type="date" max={filters.asOfDate} value={toDate} onChange={event => setToDate(event.target.value)} /></label></> : <label>Month<input type="month" value={month || filters.asOfDate.slice(0, 7)} onChange={event => setMonth(event.target.value)} /></label>}<button className="secondary" disabled={busy} onClick={() => void applyPeriod()}>{busy ? "Loading…" : "Apply period"}</button></div>}
    {error && <p className="ro-panel-message" role="alert">{error}</p>}<DataTable report={report} /></section></>;
}

function TenantDetail({ tenant, tab, onTab, onEdit, onChanged, chargeDefinitions }: { chargeDefinitions: AdminSnapshot["chargeDefinitions"]; onChanged: () => void; tenant: TenantView; tab: TenantTab; onTab: (tab: TenantTab) => void; onEdit: (action: QuickAction, values: FormValues) => void }) {
  const items: Record<TenantTab, unknown[]> = {
    summary: [{ ...tenant.person, phoneMethods: undefined }, ...(tenant.person.phoneMethods ?? []).map(method => ({ phoneNumber: method.value, phoneType: method.type, primaryNumber: method.isPrimary, textEnabled: method.isTextReady })), tenant.property, tenant.unit],
    household: tenant.household ?? [],
    tenancy: [...(tenant.tenancies ?? (tenant.tenancy ? [tenant.tenancy] : [])), ...(tenant.leaseTerms ?? [])],
    charges: (tenant.schedules ?? []).map(schedule => ({ ...schedule, chargeType: chargeDefinitions.find(definition => definition.id === schedule.chargeDefinitionId)?.displayName ?? "Needs review", billingFrequency: schedule.billingFrequency ?? "Unverified" })),
    ledger: (tenant.ledger ?? []).map(row => ({ ...row.transaction, allocatedCents: row.allocatedCents, openCents: row.openCents, runningBalanceCents: row.runningBalanceCents, balanceComplete: row.balanceComplete, balanceUncertaintyCodes: row.balanceUncertaintyCodes })),
    deposits: (tenant.deposits ?? []).map((deposit) => ({ type: deposit.type, amountHeldCents: deposit.amountHeldCents, sourceBalanceCents: deposit.sourceBalanceCents, dispositionStatus: deposit.dispositionStatus, receivedOn: deposit.receivedOn, disposedOn: deposit.disposedOn, dispositionNotes: deposit.dispositionNotes })),
    "housing-assistance": tenant.subsidyContracts ?? [],
    documents: tenant.documents ?? [],
    activity: tenant.activity ?? [],
  };
  const editButtons: Array<{ label: string; action: QuickAction; values: FormValues }> = [];
  if (tab === "summary") editButtons.push({ label: "Edit resident", action: "save-person", values: { id: tenant.person.id, revision: tenant.person.recordRevision ?? 1, firstName: tenant.person.firstName, lastName: tenant.person.lastName, email: tenant.person.email ?? "", phone: tenant.person.phone ?? "", renterInsuranceExpiresOn: tenant.person.renterInsuranceExpiresOn ?? "", ...(tenant.person.archived == null ? {} : { archived: tenant.person.archived }) } });
  if (tab === "tenancy") (tenant.tenancies ?? (tenant.tenancy ? [tenant.tenancy] : [])).forEach((record, index) => editButtons.push({ label: `Edit tenancy ${index + 1}`, action: "save-tenancy", values: { id: record.id, revision: record.recordRevision ?? 1, propertyId: record.propertyId, unitId: record.unitId, primaryPersonId: record.primaryPersonId, status: record.status, plannedMoveInOn: record.plannedMoveInOn ?? "", actualMoveInOn: record.actualMoveInOn ?? "", noticeOn: record.noticeOn ?? "", expectedMoveOutOn: record.expectedMoveOutOn ?? "", actualMoveOutOn: record.actualMoveOutOn ?? "" } }));
  if (tab === "household") tenant.household.forEach((record, index) => editButtons.push({ label: `Edit household member ${index + 1}`, action: "save-household-membership", values: { id: record.id, revision: record.recordRevision ?? 1, tenancyId: record.tenancyId ?? "", personId: record.personId, role: record.role ?? "", relationship: record.relationship ?? "", isFinanciallyResponsible: record.isFinanciallyResponsible ?? "" } }));
  if (tab === "tenancy") tenant.leaseTerms.forEach((term, index) => editButtons.push({ label: `Edit lease ${index + 1}`, action: "save-lease-term", values: { id: term.id, revision: term.recordRevision ?? 1, tenancyId: term.tenancyId, status: term.status, contractStartOn: term.contractStartOn, contractEndOn: term.contractEndOn ?? "", signedOn: term.signedOn ?? "", monthToMonth: term.monthToMonth } }));
  if (tab === "deposits") tenant.deposits.forEach((deposit, index) => editButtons.push({ label: `Edit deposit ${index + 1}`, action: "save-security-deposit", values: { id: deposit.id, revision: deposit.recordRevision ?? 1, propertyId: deposit.propertyId, unitId: deposit.unitId ?? "", tenancyId: deposit.tenancyId ?? "", personId: deposit.personId, type: deposit.type ?? "", amountDollars: typeof deposit.amountHeldCents === "number" ? String(deposit.amountHeldCents / 100) : "", receivedOn: deposit.receivedOn ?? "", dispositionStatus: deposit.dispositionStatus ?? "", disposedOn: deposit.disposedOn ?? "", dispositionNotes: deposit.dispositionNotes ?? "" } }));
  if (tab === "housing-assistance") tenant.subsidyContracts.forEach((contract, index) => editButtons.push({ label: `Edit HAP contract ${index + 1}`, action: "save-subsidy-contract", values: { id: contract.id, revision: contract.recordRevision ?? 1, propertyId: contract.propertyId, unitId: contract.unitId, tenancyId: contract.tenancyId, agencyName: contract.agencyName, contractNumber: contract.contractNumber ?? "", effectiveFrom: contract.effectiveFrom ?? "", effectiveTo: contract.effectiveTo ?? "", agencyDollars: typeof contract.agencyObligationCents === "number" ? String(contract.agencyObligationCents / 100) : "", tenantDollars: typeof contract.tenantObligationCents === "number" ? String(contract.tenantObligationCents / 100) : "", status: contract.status ?? "" } }));
  if (tab === "charges" && tenant.tenancy?.id && tenant.unit?.id && tenant.property?.id && tenant.person.id) editButtons.push({ label: "Add recurring charge", action: "save-recurring-schedule", values: { propertyId: tenant.property.id, unitId: tenant.unit.id, tenancyId: tenant.tenancy.id, personId: tenant.person.id, scopeType: "tenant", scopeId: tenant.person.id } });
  if (tab === "charges") tenant.schedules.forEach((schedule, index) => {
    if (!schedule.id) return;
    const values = { predecessorId: schedule.id, expectedRevision: schedule.recordRevision ?? 1 };
    editButtons.push({ label: `Replace charge ${index + 1}`, action: "replace-recurring-schedule", values: { ...values, amountDollars: "", effectiveFrom: "" } });
    editButtons.push({ label: `End charge ${index + 1}`, action: "end-recurring-schedule", values: { ...values, effectiveFrom: "" } });
  });
  return <section className="ro-panel tenant-detail"><div className="ro-panel-heading"><div><span className="eyebrow">Resident profile</span><h2>{tenant.person.firstName ?? "Needs review"} {tenant.person.lastName ?? "Needs review"}</h2><p>{tenant.property?.name ?? "Needs review"} · {tenant.unit?.unitNumber ?? "Needs review"}</p></div></div><div className="ro-tabs" role="tablist">{TENANT_TABS.map((item) => <button role="tab" aria-selected={tab === item} className={tab === item ? "active" : ""} key={item} onClick={() => onTab(item)}>{title(item)}</button>)}</div>{editButtons.length ? <div className="ro-inline-actions ro-tab-actions">{editButtons.map((button) => <button className="secondary" key={`${button.action}-${button.values.id ?? button.values.predecessorId}`} onClick={() => onEdit(button.action, button.values)}>{button.label}</button>)}</div> : null}{tab === "documents" && tenant.tenancy?.id && <ManagerLeaseUpload key={tenant.tenancy.id} tenancyId={tenant.tenancy.id} files={tenant.documents} onSaved={onChanged} />}{tab === "charges" && tenant.schedules.some(schedule => schedule.active == null) && <p className="ro-panel-message">For an imported charge with unverified active status, end that schedule, then add a new monthly charge with the confirmed amount, effective date and active status. If only monthly frequency is unverified and the charge is already active, use Replace charge to confirm monthly frequency.</p>}<div className="ro-record-grid">{items[tab].filter((item) => item != null).map((item, index) => <dl key={index}>{Object.entries(item as Record<string, unknown>).filter(([key]) => !["id", "phoneMethods", "recordRevision", "createdAt", "updatedAt", "source", "storageKey", "checksumSha256", "metadataChecksumSha256", "sourceArtifactSha256", "lineageRootId", "supersedesId"].includes(key) && !key.endsWith("Id")).map(([key, value]) => <div key={key}><dt>{title(key)}</dt><dd>{formatCell(value, key)}</dd></div>)}</dl>)}</div>{tab === "summary" && tenant.person.id && <PhoneMethodsEditor key={`phones:${tenant.person.id}:${tenant.person.recordRevision}`} person={tenant.person} onSaved={onChanged} />}{tab === "summary" && tenant.person.id && <TenantPortalAccountsPanel key={tenant.person.id} personId={tenant.person.id} personName={`${tenant.person.firstName ?? ""} ${tenant.person.lastName ?? ""}`.trim()} email={tenant.person.email} />}{!items[tab].filter((item) => item != null).length && <EmptyState message={`No ${title(tab).toLowerCase()} records yet.`} />}</section>;
}

function PropertyPanels({ snapshot, filters, onEdit }: { snapshot: AdminSnapshot; filters: ViewFilters; onEdit: (action: QuickAction, initialValues: FormValues) => void }) {
  const properties = visibleProperties(snapshot, filters);
  return <div className="ro-property-grid">{properties.map((property) => {
    const units = snapshot.snapshot.units.filter((unit) => unit.propertyId === property.id);
    return <section className="ro-panel" key={property.id}>
      <div className="ro-panel-heading">
        <div><span className="eyebrow">{formatCell(property.state, "state")}</span><h2>{property.name ?? "Needs review"}</h2><p>{property.address?.line1 ?? "Needs review"}, {property.address?.city ?? "Needs review"}, {property.address?.state ?? "Needs review"} {property.address?.postalCode ?? "Needs review"}</p></div>
        <div className="ro-actions"><strong>{units.length} units</strong><button className="secondary" onClick={() => onEdit("save-unit", { propertyId: property.id })}>Add unit</button><button className="secondary" onClick={() => onEdit("save-property", { id: property.id, revision: property.recordRevision ?? 1, name: property.name, slug: property.slug, address1: property.address?.line1 ?? "", city: property.address?.city ?? "", stateCode: property.address?.state ?? "", postalCode: property.address?.postalCode ?? "", propertyType: property.propertyType, propertyState: property.state, operatingContact: property.operatingContact ?? "" })}>Edit property</button></div>
      </div>
      <div className="ro-unit-list">{units.map((unit) => <div key={unit.id}>
        <strong>{unit.unitNumber ?? "Needs review"}<small>{unit.unitType ?? "Type needs review"}</small></strong><span>{unit.bedrooms ?? "Needs review"} bd · {unit.bathrooms ?? "Needs review"} ba<small>{unit.squareFeet == null ? "Area needs review" : `${unit.squareFeet} sq ft`}</small></span><span className={`status ${unit.readiness ?? "unknown"}`}>{formatCell(unit.readiness, "readiness")}</span><span>{money(unit.marketRentCents)} rent<small>{money(unit.defaultDepositCents)} deposit</small></span>
        <button className="secondary" onClick={() => onEdit("save-unit", { id: unit.id, revision: unit.recordRevision ?? 1, propertyId: unit.propertyId, unitNumber: unit.unitNumber, unitType: unit.unitType ?? "", squareFeet: unit.squareFeet == null ? "" : String(unit.squareFeet), defaultDepositDollars: unit.defaultDepositCents == null ? "" : String(unit.defaultDepositCents / 100), amenitiesText: unit.amenities?.join("\n") ?? "", accessNotes: unit.accessNotes ?? "", bedrooms: unit.bedrooms == null ? "" : String(unit.bedrooms), bathrooms: unit.bathrooms == null ? "" : String(unit.bathrooms), marketRentDollars: unit.marketRentCents == null ? "" : String(unit.marketRentCents / 100), readiness: unit.readiness, listing: unit.listing })}>Edit</button>
      </div>)}</div>
    </section>;
  })}</div>;
}

function ApplicantCard({ application, snapshot, onChanged, onError, onConflict, onConvert, onOpen }: { application: AdminSnapshot["applicants"][number]; snapshot: AdminSnapshot; onChanged: (message: string) => void; onError: (message: string) => void; onConflict: () => void; onConvert: () => void; onOpen: (applicationId: string) => void }) {
  const [status, setStatus] = useState(application.status);
  const [assigning, setAssigning] = useState(false);
  const [assignmentProperty, setAssignmentProperty] = useState(application.propertyId ?? "");
  const [assignmentUnit, setAssignmentUnit] = useState(application.unitId ?? "");
  const [savingAssignment, setSavingAssignment] = useState(false);
  useEffect(() => { setStatus(application.status); }, [application.status]);
  const nextStatuses = status && status in APPLICATION_STATUS_TRANSITIONS ? APPLICATION_STATUS_TRANSITIONS[status as keyof typeof APPLICATION_STATUS_TRANSITIONS] : [];
  async function assignUnit() {
    setSavingAssignment(true);
    try {
      await postRentOpsMutation({ action: "assign-application-unit", payload: { applicationId: application.id, revision: application.recordRevision ?? 1, propertyId: assignmentProperty, unitId: assignmentUnit } });
      setAssigning(false); onChanged("Application unit assigned. Review and approval remain separate steps.");
    } catch (cause) { handleRentOpsMutationError(cause, onConflict, onError); }
    finally { setSavingAssignment(false); }
  }

  async function changeStatus(next: string) {
    if (next === status) return;
    const note = next === "approved" || next === "declined" ? window.prompt(`Add the manual ${title(next).toLowerCase()} decision note:`) : "";
    if ((next === "approved" || next === "declined") && note == null) return;
    if (!window.confirm(`Change this application from ${title(status)} to ${title(next)}?`)) return;
    try {
      await postRentOpsMutation({ action: "update-application-status", payload: { applicationId: application.id, revision: application.recordRevision ?? 1, status: next, note: note || undefined } });
      setStatus(next as typeof status); onChanged("Application status updated.");
    } catch (cause) { handleRentOpsMutationError(cause, onConflict, onError); }
  }
  async function requestInfo() {
    const label = window.prompt("What information is missing?");
    if (!label?.trim()) return;
    try { await postRentOpsMutation({ action: "save-application-requirement", payload: { applicationId: application.id, key: `missing-${Date.now()}`, label: label.trim(), status: "requested", requestedOn: today() } }); onChanged("Missing information request added."); }
    catch (cause) { onError(cause instanceof Error ? cause.message : "Request could not be added."); }
  }
  async function convert() {
    if (!window.confirm("Convert this approved application to one future tenancy? This action is idempotent but should only be used after the unit is confirmed.")) return;
    onConvert();
  }
  return <section className="ro-panel applicant-card">
    <button type="button" className="applicant-card-trigger" disabled={!application.id} onClick={() => { if (application.id) onOpen(application.id); }} aria-label={`Open application details for ${application.firstName ?? "unknown"} ${application.lastName ?? "applicant"}`}>
      <span className={`status ${status}`}>{title(status)}</span><span className="applicant-card-name">{application.firstName ?? "Unknown"} {application.lastName ?? "applicant"}</span><span className="applicant-card-contact">{application.email ?? "Unknown email"}<br />{application.phone ?? "Unknown phone"}</span>
      <span className="applicant-card-facts"><span><span className="applicant-card-fact-label">Submitted</span><span>{application.submittedOn ?? "Unknown"}</span></span><span><span className="applicant-card-fact-label">Desired move-in</span><span>{application.preferences?.desiredMoveInOn ?? "Unknown"}</span></span><span><span className="applicant-card-fact-label">Voucher</span><span>{application.voucher?.hasVoucher === undefined ? "Unknown" : application.voucher.hasVoucher ? "Yes" : "No"}</span></span></span>
      <span className="applicant-card-hint">Open case detail</span>
    </button>
    {!application.convertedTenancyId && status !== "converted" && <div className="ro-app-actions"><button type="button" className="secondary" onClick={() => { setAssignmentProperty(application.propertyId ?? ""); setAssignmentUnit(application.unitId ?? ""); setAssigning(!assigning); }}>{application.unitId ? "Change assigned unit" : "Assign unit"}</button></div>}
    {assigning && <div className="ro-form-grid">
      <label>Property<select aria-label="Application property" value={assignmentProperty} onChange={(event) => { setAssignmentProperty(event.target.value); setAssignmentUnit(""); }}><option value="">Choose property</option>{snapshot.snapshot.properties.map((property) => <option key={property.id} value={property.id}>{property.name ?? property.id}</option>)}</select></label>
      <label>Unit<select aria-label="Application unit" value={assignmentUnit} onChange={(event) => setAssignmentUnit(event.target.value)}><option value="">Choose unit</option>{snapshot.snapshot.units.filter((unit) => unit.propertyId === assignmentProperty).map((unit) => <option key={unit.id} value={unit.id}>{unit.unitNumber ?? unit.id}</option>)}</select></label>
      <button type="button" className="primary" disabled={!assignmentProperty || !assignmentUnit || savingAssignment} onClick={() => void assignUnit()}>{savingAssignment ? "Saving…" : "Save assignment"}</button>
      <button type="button" className="secondary" disabled={savingAssignment} onClick={() => setAssigning(false)}>Cancel</button>
    </div>}
    <div className="ro-app-actions"><select aria-label="Application status" value={status} onChange={(event) => void changeStatus(event.target.value)}>{[status ?? "", ...nextStatuses].map((item) => <option key={item} value={item}>{title(item || "unknown")}</option>)}</select>{status === "approved" && !application.convertedTenancyId && <button className="primary" onClick={() => void convert()}>Convert</button>}<button className="secondary" onClick={() => void requestInfo()}>Request info</button></div>
  </section>;
}

export default function RentOpsWorkspace() {
  const auth = useRentOpsAuth();
  const [section, setSection] = useState<SectionKey>("dashboard");
  const [reportKey, setReportKey] = useState<ReportKey>("rent-roll");
  const [businessDate, setBusinessDate] = useState<string>();
  const [filters, setFilters] = useState<ViewFilters>({ propertyScope: "active", propertyId: "all", asOfDate: "", status: "all", search: "" });
  const [snapshot, setSnapshot] = useState<AdminSnapshot>();
  const [source, setSource] = useState<"live" | "synthetic">("live");
  const [warning, setWarning] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<QuickAction>();
  const [actionInitial, setActionInitial] = useState<FormValues>({});
  const [notice, setNotice] = useState<string>();
  const [selectedTenantId, setSelectedTenantId] = useState<string>();
  const [tenantTab, setTenantTab] = useState<TenantTab>("summary");
  const [selectedApplicationId, setSelectedApplicationId] = useState<string>();

  useEffect(() => {
    if (auth.status !== "unknown") return;
    void rentOpsAuthClient.initialize().catch(() => undefined);
  }, [auth.status]);

  useEffect(() => {
    if (auth.status !== "authenticated") return;
    let cancelled = false;
    setError(undefined);
    void loadRentOpsPreviewContext().then(({ asOfDate, source }) => {
      if (cancelled) return;
      setSource(source);
      setBusinessDate(asOfDate);
      setFilters((current) => current.asOfDate ? current : { ...current, asOfDate });
    }).catch((cause) => {
      if (cancelled) return;
      setLoading(false);
      setError(cause instanceof Error ? cause.message : "Rent Operations preview context could not be loaded.");
    });
    return () => { cancelled = true; };
  }, [auth.status]);

  const load = useCallback(async () => {
    setLoading(true); setError(undefined);
    try {
      const result = await loadRentOpsAdminSnapshot(filters);
      // Definitions are intentionally fetched through their narrow positive
      // catalog route. A schedule/report bundle never supplies this identity.
      const chargeDefinitions = result.snapshot.chargeDefinitions.length ? result.snapshot.chargeDefinitions : await loadRentOpsChargeDefinitions();
      setSnapshot({ ...result.snapshot, chargeDefinitions });
      setWarning(result.warning);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Rent Operations could not be loaded."); }
    finally { setLoading(false); }
  }, [filters.propertyScope, filters.propertyId, filters.asOfDate]);
  useEffect(() => {
    if (auth.status === "authenticated" && filters.asOfDate) void load();
  }, [auth.status, filters.asOfDate, load]);

  const visibleTenants = useMemo(() => snapshot?.tenants.filter((tenant) => !filters.search || `${tenant.person.firstName} ${tenant.person.lastName} ${tenant.person.email ?? ""}`.toLowerCase().includes(filters.search.toLowerCase())) ?? [], [snapshot, filters.search]);
  const selectedTenant = visibleTenants.find((tenant) => tenant.person.id === selectedTenantId) ?? visibleTenants[0];
  function openAction(nextAction: QuickAction, initialValues: FormValues = {}) {
    setActionInitial(initialValues);
    setAction(nextAction);
  }

  function openDrilldown(metric: keyof AdminSnapshot["summary"]["drilldowns"], fallback: ReportKey) {
    const drilldown = snapshot?.summary.drilldowns[metric];
    setReportKey((drilldown?.report as ReportKey | undefined) ?? fallback);
    const occupancy = drilldown?.filters.occupancy?.[0];
    setFilters((current) => ({ ...current, status: occupancy ?? "all", search: "" }));
    setSection("reports");
  }

  if (auth.status === "unknown") return <RentOpsAuthLoading />;
  if (auth.status === "unauthenticated") return <RentOpsAdminLogin message={auth.message} />;
  if (loading && !snapshot) return <main className="ro-loading"><Loader2 className="spin" /><h1>Loading Rent Operations</h1><p>Building the current rent roll and tenant records…</p></main>;
  if (error && !snapshot) return <main className="ro-loading error"><AlertCircle /><h1>Rent Operations is unavailable</h1><p>{error}</p><button className="primary" onClick={() => void load()}>Try again</button></main>;
  if (!snapshot) return null;

  const summary = snapshot.summary;
  const debtMetric = balanceMetric(summary.rentOnlyDelinquencyCents, summary.balanceComplete);
  const rentNeedsReview = summary.scheduledRentComplete === undefined ? scheduledRentNeedsReview(snapshot.scheduledIncome) : !summary.scheduledRentComplete;
  const createAction = sectionCreateAction(section);
  const sectionReport: Partial<Record<SectionKey, ReportKey>> = { "rent-roll": "rent-roll", leases: "lease-expiration", income: "scheduled-vs-collected" };
  const scopeLabel = filters.propertyId !== "all" ? "Selected property" : filters.propertyScope === "all" ? "All imported properties" : "Active portfolio";
  return <main className="rent-ops-shell">
    <aside className="ro-sidebar"><div className="ro-brand"><span>5C</span><div><strong>Rent Operations</strong><small>Single-admin workspace</small></div></div><a className="ro-back-link" href="https://5central.capital">← 5Central website</a><nav>{SECTIONS.map(({ key, label, icon: Icon }) => <button key={key} className={section === key ? "active" : ""} onClick={() => setSection(key)}><Icon />{label}</button>)}</nav><div className="ro-source"><span className={source === "live" ? "live" : "demo"} />{source === "live" ? "Live operational data" : "Synthetic development data"}<small>Updated {new Date(snapshot.generatedAt).toLocaleString()}</small><button className="ro-logout" type="button" onClick={() => { void rentOpsAuthClient.logout(); }}><LogOut /> Sign out</button></div></aside>
    <div className="ro-main"><header className="ro-topbar"><div><span className="eyebrow">{scopeLabel} · {summary.propertyCount} propert{summary.propertyCount === 1 ? "y" : "ies"} · {summary.unitCount} units</span><h1>{SECTIONS.find((item) => item.key === section)?.label}</h1></div>{createAction && <button className="primary" onClick={() => openAction(createAction.action)}><Plus /> {createAction.label}</button>}{section === "applicants" && <a className="primary" href="/apply">Open application form</a>}</header>
      {(warning || notice || error) && <div className={`ro-banner ${error ? "error" : ""}`}><AlertCircle />{error ?? notice ?? warning}<button onClick={() => { setNotice(undefined); setError(undefined); }} aria-label="Dismiss"><X /></button></div>}
      <FilterBar filters={filters} snapshot={snapshot} onChange={setFilters} onRefresh={() => void load()} refreshing={loading} />
      {section === "dashboard" && <><div className="ro-stats"><StatCard label="Occupied" value={`${summary.occupiedUnits}/${summary.unitCount}`} onClick={() => openDrilldown("occupiedUnits", "occupancy")} /><StatCard label="Ready vacancies" value={String(summary.readyVacantUnits)} tone={summary.readyVacantUnits ? "warn" : "good"} onClick={() => openDrilldown("genuineVacantUnits", "occupancy")} /><StatCard label="Confirmed recurring configuration" value={summary.scheduledRentConfirmedCents !== undefined ? money(summary.scheduledRentConfirmedCents) : rentNeedsReview ? "Needs review" : money(summary.scheduledRentCents)} onClick={() => openDrilldown("scheduledRentCents", "scheduled-income")} /><StatCard label="Rent delinquency" value={money(debtMetric.amountCents)} tone={debtMetric.tone} onClick={() => openDrilldown("rentOnlyDelinquencyCents", "delinquency")} /><StatCard label="Expiring ≤ 60 days" value={String(summary.expiringIn60Days)} onClick={() => openDrilldown("expiringIn60Days", "lease-expiration")} /><StatCard label="Deposit liability" value={depositMoney(summary.securityDepositLiabilityCents)} onClick={() => openDrilldown("securityDepositLiabilityCents", "security-deposit")} /></div><div className="ro-inline-actions"><button className="primary" onClick={() => setSection("income")}>Monthly billing & payments</button><button className="secondary" onClick={() => setSection("tenants")}>Tenant accounts</button><button className="secondary" onClick={() => { setReportKey("delinquency"); setSection("reports"); }}>Review balances</button></div>{summary.balanceComplete === false && <p className="ro-panel-message" role="status">{summary.balanceUnresolvedCount ?? "Some"} balances need review because the available history is incomplete.</p>}{(rentNeedsReview || summary.scheduledRentCadenceComplete === false) && <section className="ro-panel"><div className="ro-panel-heading"><h2>Recurring configuration</h2><button className="secondary" onClick={() => { setReportKey("scheduled-income"); setSection("reports"); }}>Review schedules</button></div><p className="ro-panel-message">{rentNeedsReview && <>{summary.scheduledRentUnresolvedCount ?? "Some"} schedules need amount, category, or date review. </>}{summary.scheduledRentCadenceComplete === false && <>Cadence unverified. This configuration total is not confirmed monthly expected income.</>}</p></section>}<section className="ro-panel"><div className="ro-panel-heading"><h2>Current rent roll</h2><button className="secondary" onClick={() => setSection("rent-roll")}>Open rent roll</button></div><DataTable report={filterReportRows(snapshot.reports["rent-roll"], filters, snapshot)} /></section></>}
      {section === "reports" && <Reports snapshot={snapshot} filters={filters} selected={reportKey} onSelect={setReportKey} />}
      {section === "income" && <><ManagerIncomeActions snapshot={snapshot} businessDate={businessDate} propertyId={filters.propertyId} onSaved={load} /><RecurringBillingPanel key={filters.propertyId} onPosted={load} businessDate={businessDate} propertyId={filters.propertyId === "all" ? undefined : filters.propertyId} /></>}
      {sectionReport[section] && <Reports snapshot={snapshot} filters={filters} selected={sectionReport[section]!} onSelect={(key) => { setReportKey(key); setSection("reports"); }} />}
      {section === "tenants" && <div className="ro-split"><section className="ro-panel tenant-list"><div className="ro-panel-heading"><div><span className="eyebrow">People, not ledger accounts</span><h2>{visibleTenants.length} residents</h2></div><button className="secondary" onClick={() => openAction("save-person")}><Plus /> Resident</button></div>{visibleTenants.map((tenant) => <button key={tenant.person.id} className={selectedTenant?.person.id === tenant.person.id ? "active" : ""} onClick={() => { setSelectedTenantId(tenant.person.id); setTenantTab("summary"); }}><strong>{tenant.person.firstName} {tenant.person.lastName}</strong><span>{tenant.property?.name ?? "No property"} · {tenant.unit?.unitNumber ?? "No unit"}</span></button>)}</section>{selectedTenant ? <TenantDetail chargeDefinitions={snapshot.chargeDefinitions} tenant={selectedTenant} tab={tenantTab} onTab={setTenantTab} onEdit={openAction} onChanged={() => { void load(); }} /> : <section className="ro-panel"><EmptyState message="No tenant profiles match the current filters." /></section>}</div>}
      {section === "properties" && <><div className="ro-inline-actions"><button className="primary" onClick={() => openAction("save-property")}><Plus /> Property</button><button className="secondary" onClick={() => openAction("save-unit")}><Plus /> Unit</button></div><PropertyPanels snapshot={snapshot} filters={filters} onEdit={openAction} /></>}
      {section === "applicants" && <><div className="ro-inline-actions"><span>All decisions are manual. This tool does not score or screen applicants.</span></div><div className="ro-card-grid">{snapshot.applicants.map((application) => <ApplicantCard key={application.id} application={application} snapshot={snapshot} onChanged={(message) => { setNotice(message); void load(); }} onError={setError} onConflict={() => refreshRentOpsAfterConflict({ closeEditor: () => undefined, clearEditor: () => undefined, showNotice: setNotice, reload: load })} onConvert={() => openAction("convert-application", { applicationId: application.id })} onOpen={setSelectedApplicationId} />)}</div></>}
      {section === "documents" && <><div className="ro-inline-actions"><p>Secure document upload is available only through the verified storage path. Metadata alone cannot satisfy an application requirement.</p><button className="secondary" onClick={() => openAction("save-activity")}><Plus /> Note or activity</button></div><div className="ro-split"><section className="ro-panel"><div className="ro-panel-heading"><div><span className="eyebrow">Private documents</span><h2>{snapshot.documents.length} records</h2></div></div><div className="ro-timeline">{snapshot.documents.map((document) => <article key={document.id}><FileText /><div><strong>{document.fileName ?? "Unknown document"}</strong><span>{title(document.type)} · {title(document.state)} · {document.uploadedAt ? new Date(document.uploadedAt).toLocaleDateString() : "Unknown date"}</span><small>{document.downloadAvailable ? "Verified secure document" : "Secure file unavailable"}</small>{document.downloadAvailable && document.id && <button className="secondary" type="button" onClick={() => { void saveDocumentFile({ ...document, id: document.id! }).catch((cause) => setError(cause instanceof Error ? cause.message : "Secure document download is unavailable.")); }}><Download /> Download</button>}</div></article>)}</div></section><section className="ro-panel"><div className="ro-panel-heading"><div><span className="eyebrow">One dated timeline</span><h2>Recent activity</h2></div></div><div className="ro-timeline">{[...snapshot.activities].sort((a, b) => String(b.occurredAt ?? "").localeCompare(String(a.occurredAt ?? ""))).map((event) => { const occurredAt = typeof event.occurredAt === "string" ? event.occurredAt : undefined; return <article key={event.id}><FileClock /><div><strong>{event.summary ?? "Unknown activity"}</strong><span>{occurredAt ? new Date(occurredAt).toLocaleString() : "Unknown time"} · {event.actor ?? "Unknown actor"}</span>{event.detail && <small>{event.detail}</small>}</div></article>; })}</div></section></div></>}
      {section !== "reports" && <div className="ro-quick-actions"><span>Quick add</span>{RENT_OPS_QUICK_ADD_ACTIONS.map((item) => <button key={item} onClick={() => openAction(item)}>{ACTION_LABELS[item]}</button>)}</div>}
    </div>
    {selectedApplicationId && <ApplicationCaseDetail key={selectedApplicationId} applicationId={selectedApplicationId} summary={snapshot.applicants.find((application) => application.id === selectedApplicationId)} onClose={() => setSelectedApplicationId(undefined)} />}
    {action && <ActionDialog action={action} snapshot={snapshot} initialValues={actionInitial} onClose={() => { setAction(undefined); setActionInitial({}); }} onSaved={(message) => { setNotice(message); void load(); }} onConflict={() => refreshRentOpsAfterConflict({ closeEditor: () => setAction(undefined), clearEditor: () => setActionInitial({}), showNotice: setNotice, reload: load })} />}
  </main>;
}
