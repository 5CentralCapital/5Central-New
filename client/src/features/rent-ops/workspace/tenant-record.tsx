import { useQueryClient } from "@tanstack/react-query";
import { rentOpsAuthClient } from "../auth";
import { ChargeEditDialog } from "./charge-edit-dialog";
import { PaymentEditDialog } from "./payment-edit-dialog";
import { TenantLedgerExportDialog } from "./tenant-ledger-export";
import { ManagerTenancyActions } from './manager-tenancy-actions';
import { useRecurringChargeTerms } from './use-recurring-charge-terms';
import { currentPhoneMethods, phoneTypeLabel } from "../phone-methods-display";
import { usdAccountingFormatter, utcCalendarDateFormatter } from '../../../lib/rent-ops-formatters';
import { balanceReviewDisplay } from "./balance-review-display";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { ManagerLeaseUpload } from "../manager-lease-upload";
import { PhoneMethodsEditor } from "../phone-methods-editor";
import { TenantPortalAccountsPanel } from "../../tenant-portal/admin-accounts";
import type { FormValues, QuickAction } from "../form-payload";
import type {
  AdminDocumentView,
  AdminLeaseTermView,
  AdminSnapshot,
  AdminTenancyView,
  TenantTab,
  TenantView,
} from "../types";
import {
  currentMonthlyTotal,
  filterTenantLedger,
  ledgerActionEligibility,
  buildHouseholdRows,
  buildLedgerRows,
  buildRecurringChargeRows,
  buildTenantEditActions,
  buildTenantSummary,
  filterRecurringCharges,
  recurringChargeIssueLabels,
  isCurrentTenancy,
  resolveTenantContext,
  type RecurringChargeFilter,
  type RecurringChargeRow,
  type TenantEditAction,
  type TenantLedgerRow,
} from "./tenant-model";
import "./tenant-record.css";
import "./tenant-clean.css";
import { EntityLink } from "./entity-link";
import { reviewLabelForCodes, reviewLabelsForCodes, reviewReason, UNKNOWN_AMOUNT_LABEL, UNVERIFIED_LABEL } from "@shared/review-cases/reasons";

export type EditAction = (action: QuickAction, values?: FormValues) => void;

export interface TenantRecordProps {
  tenant: TenantView;
  snapshot: AdminSnapshot;
  tab: TenantTab;
  onTab: (tab: TenantTab) => void;
  onEdit: EditAction;
  onChanged: () => void;
  onMoveRefresh?: () => Promise<void>;
  businessDate?: string;
  onManageMoves?: () => void;
  readOnly?: boolean;
}

export const TENANT_RECORD_TABS: TenantTab[] = [
  "summary",
  "household",
  "tenancy",
  "charges",
  "ledger",
  "deposits",
  "housing-assistance",
  "documents",
  "activity",
];

const TAB_LABELS: Record<TenantTab, string> = {
  summary: "Summary",
  household: "Contacts & household",
  tenancy: "Tenancy & leases",
  charges: "Recurring charges",
  ledger: "Transactions",
  deposits: "Deposits",
  "housing-assistance": "HAP",
  documents: "Documents",
  activity: "Activity",
};

/** Status text from the tenant model; its generic UNVERIFIED_LABEL is shown as "Unverified". */
const MODEL_REVIEW_STATUS = ["Needs", "review"].join(" ");
function displayStatus(value: string | undefined): string | undefined {
  return value === MODEL_REVIEW_STATUS ? UNVERIFIED_LABEL : value;
}

function text(value: unknown, fallback = UNVERIFIED_LABEL): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function label(value: unknown): string {
  return text(value, UNVERIFIED_LABEL)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string | null | undefined): string {
  if (!value) return UNVERIFIED_LABEL;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return UNVERIFIED_LABEL;
  return utcCalendarDateFormatter.format(parsed);
}

function formatMoney(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return UNKNOWN_AMOUNT_LABEL;
  return usdAccountingFormatter.format(cents / 100);
}

function valueOrDash(value: string | null | undefined): string {
  return value ? value : "—";
}

function statusClass(value: string | null | undefined, warning = false): string {
  if (warning || !value) return "rm-status rm-status-warning";
  const normalized = value.toLowerCase();
  if (["current", "active", "executed", "held", "posted", "received", "verified"].includes(normalized)) return "rm-status rm-status-good";
  if (["ended", "past", "cancelled", "voided", "returned", "disposed"].includes(normalized)) return "rm-status rm-status-muted";
  return "rm-status";
}

function Field({ label: fieldLabel, children, warning = false }: { label: string; children: ReactNode; warning?: boolean }) {
  return <div className={`rm-field${warning ? " rm-field-warning" : ""}`}><dt>{fieldLabel}</dt><dd>{children}</dd></div>;
}

function Panel({ title: panelTitle, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <section className="rm-panel rm-tenant-panel"><div className="rm-panel-title"><h3>{panelTitle}</h3>{action}</div>{children}</section>;
}

function Empty({ message }: { message: string }) {
  return <div className="rm-empty"><p>{message}</p></div>;
}

function ActionButton({ action, onEdit, primary = false, danger = false }: { action: TenantEditAction; onEdit: EditAction; primary?: boolean; danger?: boolean }) {
  return <button type="button" className={`rm-button${primary ? " rm-button-primary" : ""}${danger ? " rm-button-danger" : ""}`} onClick={() => onEdit(action.action, action.values)}>{action.label}</button>;
}

function findAction(actions: TenantEditAction[], action: QuickAction, predicate?: (candidate: TenantEditAction) => boolean): TenantEditAction | undefined {
  return actions.find((candidate) => candidate.action === action && (!predicate || predicate(candidate)));
}

function amountCell(value: number | null, applicable = true): string {
  return applicable ? formatMoney(value) : "—";
}

function statusValue(value: string | undefined, warning = false): ReactNode {
  const shown = displayStatus(value);
  return <span className={statusClass(shown, warning || !shown || shown === UNVERIFIED_LABEL)}>{shown ? label(shown) : UNVERIFIED_LABEL}</span>;
}

function SummaryTab({ tenant, snapshot, onChanged }: { tenant: TenantView; snapshot: AdminSnapshot; onChanged: () => void }) {
  const summary = buildTenantSummary(tenant, snapshot);
  const context = resolveTenantContext(tenant, snapshot);
  const tenancy = summary.currentTenancy;
  const phoneDisplay = currentPhoneMethods(tenant.person);
  const balanceWarning = !summary.balance.complete;
  const review = balanceReviewDisplay(tenant.balanceReview);
  return <div className="rm-tenant-tab-content">
    <div className="rm-summary-grid">
      <Panel title="General">
        <dl className="rm-form-grid rm-detail-grid">
          <Field label="Resident">{summary.displayName}</Field>
          <Field label="Property">{summary.propertyName}</Field>
          <Field label="Unit">{summary.unitLabel}</Field>
          <Field label="Status">{statusValue(summary.status, displayStatus(summary.status) === UNVERIFIED_LABEL)}</Field>
          {review && <Field label={review.label} warning={Boolean(review.warning)}><strong className="rm-amount">{review.amount}</strong><small>{review.date}</small>{review.warning && <small className="rm-warning-copy" role="status">{review.warning}</small>}{review.qualification && <small>{review.qualification}</small>}<small>{review.payerSplit}</small></Field>}
          <Field label="Posted ledger balance" warning={balanceWarning}><span className={balanceWarning ? "rm-muted" : summary.balance.amountCents ? "rm-amount rm-amount-warning" : "rm-amount"}>{summary.balance.complete ? formatMoney(summary.balance.amountCents) : reviewLabelForCodes(summary.balance.uncertaintyCodes)}</span>{balanceWarning && summary.balance.uncertaintyCodes.length > 1 && <small className="rm-warning-copy">{reviewLabelsForCodes(summary.balance.uncertaintyCodes).join(" · ")}</small>}</Field>
          <Field label="As of date">{formatDate(summary.asOfDate)}</Field>
          {(tenant.meteredUtilities ?? []).map(utility => <Field key={`${utility.utility}:${utility.effectiveFrom}`} label="Water — metered"><span>Starts {formatDate(utility.effectiveFrom)}</span><small>Amount unknown · billed from meter readings</small></Field>)}
          {tenancy?.plannedMoveInOn && <Field label="Planned move-in">{formatDate(tenancy.plannedMoveInOn)}</Field>}
          <Field label="Actual move-in">{formatDate(tenancy?.actualMoveInOn)}</Field>
          <Field label="Lease end">{formatDate(summary.primaryLease?.contractEndOn)}{!tenant.primaryLease && summary.primaryLease && <small className="rm-muted">Execution not recorded</small>}</Field>
        </dl>
      </Panel>
      <Panel title="Contact">
        <dl className="rm-form-grid rm-detail-grid">
          <Field label="Email">{valueOrDash(tenant.person.email)}</Field>
          {phoneDisplay.rows.length ? phoneDisplay.rows.map((phone, index) => <Field key={phone.id ?? index} label={phone.isPrimary ? "Primary phone" : phoneDisplay.hasPreviousPrimary ? "Other / previous phone" : "Phone"}><span>{phone.value}</span>{phoneTypeLabel(phone.type) && <small>{phoneTypeLabel(phone.type)}</small>}</Field>) : <Field label="Phone">{valueOrDash(undefined)}</Field>}
          <Field label="Insurance expires">{tenant.person.renterInsuranceExpiresOn ? formatDate(tenant.person.renterInsuranceExpiresOn) : "Not on file"}</Field>
          {typeof tenant.person.archived === "boolean" && <Field label="Archived">{tenant.person.archived ? "Yes" : "No"}</Field>}
        </dl>
        {tenant.person.id && <PhoneMethodsEditor key={`phones:${tenant.person.id}:${tenant.person.recordRevision ?? 1}`} person={tenant.person} onSaved={onChanged} />}
      </Panel>
    </div>
    {tenant.person.id && <TenantPortalAccountsPanel key={`portal:${tenant.person.id}`} personId={tenant.person.id} personName={summary.displayName} email={tenant.person.email} />}
    <Panel title="Property and unit context">
      <dl className="rm-form-grid rm-detail-grid">
        <Field label="Unit type">{valueOrDash(context.unit?.unitType)}</Field>
        <Field label="Bedrooms">{context.unit?.bedrooms == null ? UNVERIFIED_LABEL : String(context.unit.bedrooms)}</Field>
        <Field label="Bathrooms">{context.unit?.bathrooms == null ? UNVERIFIED_LABEL : String(context.unit.bathrooms)}</Field>
        <Field label="Square feet">{context.unit?.squareFeet == null ? UNVERIFIED_LABEL : context.unit.squareFeet.toLocaleString()}</Field>
        <Field label="Market rent">{formatMoney(context.unit?.marketRentCents)}</Field>
        <Field label="Default deposit">{context.unit?.defaultDepositCents == null ? "—" : formatMoney(context.unit.defaultDepositCents)}</Field>
      </dl>
    </Panel>
  </div>;
}

function HouseholdTab({ tenant, snapshot, onEdit, editActions }: { tenant: TenantView; snapshot: AdminSnapshot; onEdit: EditAction; editActions: TenantEditAction[] }) {
  const rows = buildHouseholdRows(tenant, snapshot);
  const context = resolveTenantContext(tenant, snapshot);
  return <div className="rm-tenant-tab-content">
    <Panel title="Contacts and household" action={<button type="button" className="rm-button" onClick={() => onEdit("save-household-membership", { tenancyId: context.currentTenancy?.id ?? "" })}><Plus aria-hidden="true" /> Add contact</button>}>
      {rows.length === 0 ? <Empty message="No household or contact records are linked to this tenant." /> : <div className="rm-table-wrap"><table className="rm-table"><caption className="sr-only">Contacts and household members</caption><thead><tr><th>Name</th><th>Role</th><th>Relationship</th><th>Financially responsible</th><th>Tenancy</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{rows.map((row, index) => {
        const action = findAction(editActions, "save-household-membership", (candidate) => candidate.values.id === row.membership.id) ?? editActions.filter((candidate) => candidate.action === "save-household-membership")[index];
        const tenancy = row.membership.tenancyId ? snapshot.snapshot.tenancies.find((candidate) => candidate.id === row.membership.tenancyId) : undefined;
        return <tr key={row.membership.id ?? `household-${index}`}><td><strong><EntityLink personId={row.person?.id ?? row.membership.personId}>{row.name}</EntityLink></strong>{row.person?.email && <small>{row.person.email}</small>}{row.person?.phone && <small>{row.person.phone}</small>}</td><td>{label(row.role)}</td><td>{row.relationship}</td><td>{row.responsibility}</td><td>{tenancy ? tenancyLocation(tenancy, snapshot) : UNVERIFIED_LABEL}</td><td>{action && <ActionButton action={action} onEdit={onEdit} />}</td></tr>;
      })}</tbody></table></div>}
    </Panel>
    <Panel title="Primary contact">
      <dl className="rm-form-grid rm-detail-grid">
        <Field label="Name">{text(tenant.person.firstName, UNVERIFIED_LABEL)} {text(tenant.person.lastName, "")}</Field>
        <Field label="Email">{valueOrDash(tenant.person.email)}</Field>
        <Field label="Phone">{valueOrDash(tenant.person.phone)}</Field>
        <Field label="Insurance expires">{formatDate(tenant.person.renterInsuranceExpiresOn)}</Field>
      </dl>
    </Panel>
  </div>;
}

function tenancyLocation(tenancy: AdminTenancyView, snapshot: AdminSnapshot): string {
  const property = snapshot.snapshot.properties.find((candidate) => candidate.id === tenancy.propertyId);
  const unit = snapshot.snapshot.units.find((candidate) => candidate.id === tenancy.unitId);
  return `${text(property?.name)} · ${text(unit?.unitNumber)}`;
}

function TenancyDates({ tenancy }: { tenancy: AdminTenancyView }) {
  const dates: Array<[string, string | undefined, boolean]> = [
    ["Planned move-in", tenancy.plannedMoveInOn, false],
    ["Actual move-in", tenancy.actualMoveInOn, tenancy.status !== "future" && tenancy.status !== "cancelled"],
    ["Notice", tenancy.noticeOn, false],
    ["Expected move-out", tenancy.expectedMoveOutOn, false],
    ["Actual move-out", tenancy.actualMoveOutOn, tenancy.status === "past"],
  ];
  return <dl className="rm-form-grid rm-detail-grid rm-tenancy-dates">{dates.filter(([, value, required]) => value || required).map(([fieldLabel, value, required]) => <Field key={fieldLabel} label={fieldLabel} warning={required && !value}>{formatDate(value)}</Field>)}</dl>;
}

function LeaseTermsTable({ terms, snapshot, editActions, onEdit }: { terms: AdminLeaseTermView[]; snapshot: AdminSnapshot; editActions: TenantEditAction[]; onEdit: EditAction }) {
  if (!terms.length) return <Empty message="No lease terms are linked to this tenant." />;
  return <div className="rm-table-wrap"><table className="rm-table"><caption className="sr-only">Lease terms</caption><thead><tr><th>Tenancy</th><th>Status</th><th>Contract start</th><th>Contract end</th><th>Signed</th><th>Month to month</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{terms.map((term, index) => {
    const action = findAction(editActions, "save-lease-term", (candidate) => candidate.values.id === term.id) ?? editActions.filter((candidate) => candidate.action === "save-lease-term")[index];
    const tenancy = snapshot.snapshot.tenancies.find((candidate) => candidate.id === term.tenancyId);
    return <tr key={term.id ?? `lease-${index}`}><td>{tenancy ? tenancyLocation(tenancy, snapshot) : UNVERIFIED_LABEL}</td><td>{!term.status || ["unknown", "ambiguous", "inferred"].includes(term.statusKnowledge ?? "") ? <span className="rm-muted">Execution not recorded</span> : statusValue(term.status)}</td><td>{formatDate(term.contractStartOn)}</td><td>{formatDate(term.contractEndOn)}</td><td>{term.signedOn ? formatDate(term.signedOn) : <span className="rm-muted">Not recorded</span>}</td><td>{term.monthToMonth == null ? "Not recorded" : term.monthToMonth ? "Yes" : "No"}</td><td>{action && <ActionButton action={action} onEdit={onEdit} />}</td></tr>;
  })}</tbody></table></div>;
}

function TenancyTab({ tenant, snapshot, onEdit, editActions }: { tenant: TenantView; snapshot: AdminSnapshot; onEdit: EditAction; editActions: TenantEditAction[] }) {
  const context = resolveTenantContext(tenant, snapshot);
  const current = context.tenancies.filter((tenancy) => isCurrentTenancy(tenancy, context.asOfDate));
  const history = context.tenancies.filter((tenancy) => !isCurrentTenancy(tenancy, context.asOfDate));
  const showPlannedMoveIn = history.some(tenancy => tenancy.plannedMoveInOn);
  const showNotice = history.some(tenancy => tenancy.noticeOn);
  const showExpectedMoveOut = history.some(tenancy => tenancy.expectedMoveOutOn);
  return <div className="rm-tenant-tab-content">
    <Panel title="Current tenancy">
      {current.length === 0 ? <Empty message="No current or future tenancy is linked." /> : current.map((tenancy, index) => <article className="rm-tenancy-card" key={tenancy.id ?? `current-${index}`}><div className="rm-card-heading"><div><strong>{tenancyLocation(tenancy, snapshot)}</strong></div>{statusValue(tenancy.status, !tenancy.status)}</div><TenancyDates tenancy={tenancy} /><div className="rm-panel-actions">{findAction(editActions, "save-tenancy", (candidate) => candidate.values.id === tenancy.id) && <ActionButton action={findAction(editActions, "save-tenancy", (candidate) => candidate.values.id === tenancy.id)!} onEdit={onEdit} />}</div></article>)}
    </Panel>
    <Panel title="Tenancy history">
      {history.length === 0 ? <Empty message="No prior tenancy records are linked." /> : <div className="rm-table-wrap"><table className="rm-table"><caption className="sr-only">Tenancy history</caption><thead><tr><th>Property / unit</th><th>Status</th>{showPlannedMoveIn && <th>Planned move-in</th>}<th>Actual move-in</th>{showNotice && <th>Notice</th>}{showExpectedMoveOut && <th>Expected move-out</th>}<th>Actual move-out</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{history.map((tenancy, index) => {
        const action = findAction(editActions, "save-tenancy", (candidate) => candidate.values.id === tenancy.id) ?? editActions.filter((candidate) => candidate.action === "save-tenancy")[index];
        return <tr key={tenancy.id ?? `history-${index}`}><td>{tenancyLocation(tenancy, snapshot)}</td><td>{statusValue(tenancy.status, !tenancy.status)}</td>{showPlannedMoveIn && <td>{tenancy.plannedMoveInOn ? formatDate(tenancy.plannedMoveInOn) : "—"}</td>}<td>{tenancy.actualMoveInOn || !["future", "cancelled"].includes(tenancy.status ?? "") ? formatDate(tenancy.actualMoveInOn) : "—"}</td>{showNotice && <td>{tenancy.noticeOn ? formatDate(tenancy.noticeOn) : "—"}</td>}{showExpectedMoveOut && <td>{tenancy.expectedMoveOutOn ? formatDate(tenancy.expectedMoveOutOn) : "—"}</td>}<td>{tenancy.actualMoveOutOn || tenancy.status === "past" ? formatDate(tenancy.actualMoveOutOn) : "—"}</td><td>{action && <ActionButton action={action} onEdit={onEdit} />}</td></tr>;
      })}</tbody></table></div>}
    </Panel>
    <Panel title="Lease terms"><LeaseTermsTable terms={context.leaseTerms} snapshot={snapshot} editActions={editActions} onEdit={onEdit} /></Panel>
  </div>;
}

function chargeAction(actions: TenantEditAction[], type: "replace-recurring-schedule" | "end-recurring-schedule", row: RecurringChargeRow): TenantEditAction | undefined {
  return findAction(actions, type, (candidate) => candidate.values.predecessorId === row.id);
}

function ChargeTable({ rows, editActions, onEdit, asOfDate }: { asOfDate: string; rows: RecurringChargeRow[]; editActions: TenantEditAction[]; onEdit: EditAction }) {
  const chargeTerms = useRecurringChargeTerms(rows.map(row => row.id), asOfDate);
  if (!rows.length) return <Empty message="No recurring charges match this view." />;
  return <div className="rm-table-wrap"><table className="rm-table rm-charge-table"><caption className="sr-only">Recurring charges</caption><thead><tr><th>Charge</th><th>Applies to</th><th>Frequency</th><th>Charge starts</th><th>Lease through</th><th>Scheduled end</th><th className="rm-align-right">Amount</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{rows.map((row, index) => {
    const replace = chargeAction(editActions, "replace-recurring-schedule", row);
    const end = chargeAction(editActions, "end-recurring-schedule", row);
    const warning = row.uncertaintyCodes.length > 0 || row.state === "unknown";
    return <tr key={row.id ?? `charge-${index}`}><td><strong>{row.description}</strong>{warning && <small className="rm-warning-copy">{recurringChargeIssueLabels(row.uncertaintyCodes).join(" · ") || reviewReason("schedule_unconfirmed").shortLabel}</small>}</td><td><span>{row.applicabilityLabel}</span>{(row.scope.type === "unit" || row.scope.type === "property") && <small className="rm-warning-copy">Shared schedule: replacing or ending changes charges for all applicable residents in this {row.scope.type}.</small>}</td><td>{row.billingFrequency ? label(row.billingFrequency) : UNVERIFIED_LABEL}</td><td>{chargeTerms.label(row.id, "start", row.scope.type)}</td><td>{chargeTerms.label(row.id, "through", row.scope.type)}</td><td>{row.effectiveTo ? formatDate(row.effectiveTo) : "—"}</td><td className="rm-align-right rm-amount">{formatMoney(row.amountCents)}</td><td>{statusValue(row.state === "unknown" ? reviewLabelForCodes(row.uncertaintyCodes) : row.state, warning || row.active == null)}{row.stateReason && <small>{row.stateReason}</small>}</td><td><div className="rm-row-actions">{replace && <ActionButton action={{...replace,label:"Schedule change"}} onEdit={onEdit} />}{end && <ActionButton action={{...end,label:"End"}} onEdit={onEdit} danger />}</div></td></tr>;
  })}</tbody></table></div>;
}

function ChargesTab({ tenant, snapshot, onEdit, editActions }: { tenant: TenantView; snapshot: AdminSnapshot; onEdit: EditAction; editActions: TenantEditAction[] }) {
  const [filter, setFilter] = useState<RecurringChargeFilter>("current");
  const rows = useMemo(() => buildRecurringChargeRows(tenant, snapshot), [tenant, snapshot]);
  const filtered = useMemo(() => filterRecurringCharges(rows, filter), [rows, filter]);
  const monthlyTotal = currentMonthlyTotal(rows, tenant.operationalSchedulesComplete === true && Array.isArray(tenant.operationalScheduleIds));
  return <div className="rm-tenant-tab-content"><Panel title="Recurring charges">
    <div className="rm-charge-toolbar"><div className="rm-segmented" role="group" aria-label="Recurring charge status">{(["current", "all", "history", "future", "review"] as RecurringChargeFilter[]).map((option) => <button type="button" key={option} className={filter === option ? "active" : ""} onClick={() => setFilter(option)}>{option === "review" ? "Unconfirmed" : label(option)} <span>{option === "all" ? rows.length : filterRecurringCharges(rows, option).length}</span></button>)}</div><div className="rm-charge-total"><span>Current monthly total</span><strong>{formatMoney(monthlyTotal)}</strong></div></div>
    <ChargeTable asOfDate={snapshot.summary.asOfDate} rows={filtered} editActions={editActions} onEdit={onEdit} />
    {(tenant.meteredUtilities ?? []).map(utility => <p key={`${utility.utility}:${utility.effectiveFrom}`} className="rm-warning" role="status">Water — metered · starts {formatDate(utility.effectiveFrom)} · amount unknown. Metered usage is excluded from the fixed monthly total.</p>)}
  </Panel></div>;
}

function LedgerDetail({ row }: { row: TenantLedgerRow; snapshot: AdminSnapshot }) {
  return <dl className="rm-ledger-detail rm-form-grid"><Field label="Status" warning={!row.statusKnown}>{statusValue(row.status, !row.statusKnown)}</Field><Field label="Category">{label(row.category)}</Field><Field label="Due date">{formatDate(row.dueOn)}</Field><Field label="Payer">{label(row.payer)}</Field><Field label="Payment method">{label(row.paymentMethod)}</Field><Field label="Allocated">{formatMoney(row.allocatedCents)}</Field><Field label="Open">{formatMoney(row.openCents)}</Field>{row.reversalOfId && <Field label="Reversal">Reverses an earlier transaction</Field>}{row.uncertaintyCodes.length > 0 && <div className="rm-ledger-warning"><strong>{reviewLabelForCodes(row.uncertaintyCodes)}</strong><span>{reviewLabelsForCodes(row.uncertaintyCodes).join(" · ")}</span></div>}</dl>;
}

function LedgerTable({ rows, allRows, snapshot, onEdit, expanded, onToggle, onPayment, onCharge, onAutoAllocate, allocatingId }: { onAutoAllocate?: (id:string)=>void; allocatingId?:string; onCharge?: (id:string)=>void; onPayment?: (id:string)=>void; rows: TenantLedgerRow[]; allRows: TenantLedgerRow[]; snapshot: AdminSnapshot; onEdit: EditAction; expanded?: string; onToggle: (key: string) => void }) {
  if (!rows.length) return <Empty message="No transactions match this view." />;
  const showReference = allRows.some(row => Boolean(row.reference));
  return <div className="rm-table-wrap"><table className="rm-table rm-ledger-table"><caption className="sr-only">Transactions</caption><thead><tr><th>Date</th><th>Property</th><th>Unit</th>{showReference && <th>Reference</th>}<th>Description</th><th className="rm-align-right">Charge</th><th className="rm-align-right">Payment or credit</th><th className="rm-align-right">Running balance</th><th>Status</th><th><span className="sr-only">Details</span></th></tr></thead><tbody>{rows.map((row, index) => {
    const isOpen = expanded === row.key;
    const eligible = ledgerActionEligibility(row, allRows);
    const editTransaction = row.transaction.kind === "charge" ? onCharge : onPayment;
    const canEditPayment = ["payment","charge"].includes(row.transaction.kind??"") && row.transaction.status === "posted" && !!row.transaction.id && !!editTransaction && !allRows.some(other=>other.transaction.reversalOfId===row.transaction.id && other.transaction.status==="posted");
    const reverse = eligible.reverse ? { label: "Reverse", action: "reverse-ledger-transaction" as QuickAction, values: { originalId: row.transaction.id, postedOn: "", status: "posted", description: "" } satisfies FormValues } : undefined;

    return <Fragment key={`${row.key}-${index}`}>
      <tr className={isOpen ? "rm-row-open" : canEditPayment ? "rm-editable-payment" : ""} onClick={event=>{if(canEditPayment && !(event.target as HTMLElement).closest("button,a,input"))editTransaction?.(row.transaction.id!);}}><td>{formatDate(row.date)}</td><td>{row.propertyName}</td><td>{row.unitLabel}</td>{showReference && <td className="rm-reference">{row.reference || "—"}</td>}<td>{canEditPayment && editTransaction ? <button type="button" className="rm-payment-link" onClick={()=>editTransaction(row.transaction.id!)}>{row.description}</button> : <strong>{row.description}</strong>}</td><td className="rm-align-right rm-amount">{amountCell(row.chargeCents, row.chargeCents !== null || ["charge", "debit"].includes(row.kind?.toLowerCase() ?? ""))}</td><td className={`rm-align-right rm-amount${row.paymentLabel === "Credit" ? " rm-credit" : ""}`}>{row.paymentLabel ? <>{amountCell(row.paymentCents)}<small>{row.paymentLabel}</small></> : "—"}</td><td className="rm-align-right rm-amount">{formatMoney(row.runningBalanceCents)}</td><td>{statusValue(row.status, !row.statusKnown)}</td><td><div className="rm-row-actions"><button type="button" className="rm-button rm-button-icon" aria-expanded={isOpen} aria-label={canEditPayment ? `Edit ${row.transaction.kind}: ${row.description}` : `${isOpen ? "Hide" : "Show"} details for ${row.description}`} onClick={() => canEditPayment && editTransaction ? editTransaction(row.transaction.id!) : onToggle(row.key)}>{isOpen ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}</button>{eligible.allocate && onAutoAllocate && <button type="button" className="rm-button" disabled={!!allocatingId} onClick={()=>onAutoAllocate(row.transaction.id!)}>{allocatingId===row.transaction.id ? "Allocating…" : "Auto-allocate"}</button>}{reverse && <ActionButton action={reverse} onEdit={onEdit} danger />}</div></td></tr>
      {isOpen && <tr key={`${row.key}-${index}-detail`} className="rm-detail-row"><td colSpan={showReference ? 10 : 9}><LedgerDetail row={row} snapshot={snapshot} /></td></tr>}
    </Fragment>;
  })}</tbody></table></div>;
}

function LedgerTab({ tenant, snapshot, onEdit, editActions, onChanged, onMoveRefresh, readOnly }: Omit<TenantRecordProps,"tab"|"onTab"> & {editActions:TenantEditAction[]}) {
  const queryClient=useQueryClient();
  const [allocatingId,setAllocatingId]=useState<string>();
  const [allocationMessage,setAllocationMessage]=useState("");
  const [allocationError,setAllocationError]=useState("");
  async function autoAllocate(id:string){
    if(allocatingId)return;
    setAllocatingId(id);setAllocationError("");setAllocationMessage("");
    let saved=false;
    try{
      const response=await rentOpsAuthClient.request(`/api/rent-ops/payments/${encodeURIComponent(id)}/auto-allocate`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
      const result=await response.json();
      if(!response.ok)throw new Error(typeof result.error==="string"?result.error:"Payment could not be allocated.");
      saved=true;
      await queryClient.invalidateQueries({predicate:q=>String(q.queryKey[0]).startsWith("rent-ops")},{throwOnError:true});
      await (onMoveRefresh ? onMoveRefresh() : onChanged());
      setAllocationMessage(`${formatMoney(result.allocatedCents)} applied to charges.${result.unappliedCents > 0 ? ` ${formatMoney(result.unappliedCents)} remains as credit.` : ""}`);
    }catch(error){setAllocationError(`${saved?"Allocation saved, but refresh failed. ":""}${error instanceof Error?error.message:"Payment could not be allocated."}`);}
    finally{setAllocatingId(undefined);}
  }
  const [paymentId,setPaymentId]=useState<string>();
  const [chargeId,setChargeId]=useState<string>();
  const [expanded, setExpanded] = useState<string>();
  const [exportOpen, setExportOpen] = useState(false);
  const rows = useMemo(() => buildLedgerRows(tenant, snapshot), [tenant, snapshot]);
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);
  const filtered = useMemo(() => filterTenantLedger(rows, search, from, to), [rows, search, from, to]);
  const pages = Math.max(1, Math.ceil(filtered.length / 25));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * 25, (currentPage + 1) * 25);
  return <div className="rm-tenant-tab-content">{chargeId && <ChargeEditDialog key={chargeId} id={chargeId} tenantName={buildTenantSummary(tenant,snapshot).displayName} onClose={()=>setChargeId(undefined)} onSaved={onMoveRefresh ?? (async()=>{await onChanged();})}/>} {paymentId && <PaymentEditDialog key={paymentId} id={paymentId} tenantName={buildTenantSummary(tenant,snapshot).displayName} onClose={()=>setPaymentId(undefined)} onSaved={onMoveRefresh ?? (async()=>{await onChanged();})}/>} {exportOpen && <TenantLedgerExportDialog rows={rows} tenant={tenant} snapshot={snapshot} initialFrom={from} initialThrough={to} search={search} onClose={() => setExportOpen(false)} />}<Panel title="Transactions" action={<button type="button" className="rm-button" onClick={() => setExportOpen(true)}>Export CSV</button>}>
    <div className="rm-ledger-filters">
      <label>Search transactions<input type="search" value={search} placeholder="Description, payment method, status" onChange={event => { setSearch(event.target.value); setPage(0); }} /></label>
      <label>From<input type="date" value={from} onChange={event => { setFrom(event.target.value); setPage(0); }} /></label>
      <label>Through<input type="date" value={to} onChange={event => { setTo(event.target.value); setPage(0); }} /></label>
    </div>
    <div className="rm-ledger-toolbar"><span>{filtered.length} entr{filtered.length === 1 ? "y" : "ies"}</span></div>
    {allocationError && <p role="alert" className="rm-warning">{allocationError}</p>}{allocationMessage && <p role="status">{allocationMessage}</p>}
    <LedgerTable onAutoAllocate={readOnly ? undefined : autoAllocate} allocatingId={allocatingId} onCharge={readOnly ? undefined : setChargeId} onPayment={readOnly ? undefined : setPaymentId} rows={visible} allRows={rows} snapshot={snapshot} onEdit={onEdit} expanded={expanded} onToggle={(key) => setExpanded((prior) => prior === key ? undefined : key)} />
    {pages > 1 && <div className="rm-ledger-toolbar"><span>Page {currentPage + 1} of {pages}</span><div className="rm-row-actions"><button type="button" className="rm-button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><button type="button" className="rm-button" disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)}>Next</button></div></div>}
  </Panel></div>;
}

function DepositsTab({ tenant, snapshot, onEdit, editActions }: { tenant: TenantView; snapshot: AdminSnapshot; onEdit: EditAction; editActions: TenantEditAction[] }) {
  const rows = tenant.deposits ?? [];
  return <div className="rm-tenant-tab-content"><Panel title="Security deposits">
    {rows.length === 0 ? <Empty message="No security-deposit records are linked to this tenant." /> : <div className="rm-table-wrap"><table className="rm-table"><caption className="sr-only">Security deposits</caption><thead><tr><th>Type</th><th className="rm-align-right">Amount held</th><th className="rm-align-right">Source balance</th><th>Received</th><th>Disposition</th><th>Disposed</th><th>Notes</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{rows.map((deposit, index) => {
      const action = findAction(editActions, "save-security-deposit", (candidate) => candidate.values.id === deposit.id);
      const warning = deposit.amountHeldCents == null || !deposit.receivedOn;
      return <tr key={deposit.id ?? `deposit-${index}`}><td>{deposit.type ? label(deposit.type) : UNVERIFIED_LABEL}</td><td className="rm-align-right rm-amount">{formatMoney(deposit.amountHeldCents)}</td><td className="rm-align-right rm-amount">{formatMoney(deposit.sourceBalanceCents)}</td><td>{formatDate(deposit.receivedOn)}</td><td>{statusValue(deposit.dispositionStatus, warning || !deposit.dispositionStatus)}</td><td>{formatDate(deposit.disposedOn)}</td><td className="rm-note-cell">{valueOrDash(deposit.dispositionNotes)}</td><td>{action && <ActionButton action={action} onEdit={onEdit} />}</td></tr>;
    })}</tbody></table></div>}
    {rows.some((deposit) => deposit.amountHeldCents == null || deposit.sourceBalanceCents == null) && <p className="rm-warning" role="status">Held amount and source balance are separate liabilities. Unknown amounts stay marked for review.</p>}
  </Panel></div>;
}

function HapTab({ tenant, onEdit, editActions }: { tenant: TenantView; onEdit: EditAction; editActions: TenantEditAction[] }) {
  const rows = tenant.subsidyContracts ?? [];
  return <div className="rm-tenant-tab-content"><Panel title="Housing assistance (HAP)">
    {tenant.payerResponsibilityUnverified && <p role="status" className="rm-section-note">{reviewReason("subsidy_split_unknown").shortLabel}: agency and tenant responsibility are not yet verified. Gross rent remains separate from the payer split.</p>}
    {rows.length === 0 ? <Empty message="No housing-assistance contract is linked to this tenant." /> : <div className="rm-table-wrap"><table className="rm-table"><caption className="sr-only">Housing assistance contracts</caption><thead><tr><th>Agency</th><th>Contract</th><th>Effective from</th><th>Effective to</th><th className="rm-align-right">Agency portion</th><th className="rm-align-right">Tenant portion</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{rows.map((contract, index) => {
      const action = findAction(editActions, "save-subsidy-contract", (candidate) => candidate.values.id === contract.id);
      const warning = !contract.agencyName || contract.agencyObligationCents == null || contract.tenantObligationCents == null;
      return <tr key={contract.id ?? `hap-${index}`}><td>{text(contract.agencyName)}</td><td>{valueOrDash(contract.contractNumber)}</td><td>{formatDate(contract.effectiveFrom)}</td><td>{formatDate(contract.effectiveTo)}</td><td className="rm-align-right rm-amount">{formatMoney(contract.agencyObligationCents)}</td><td className="rm-align-right rm-amount">{formatMoney(contract.tenantObligationCents)}</td><td>{statusValue(contract.status, warning || !contract.status)}</td><td>{action && <ActionButton action={action} onEdit={onEdit} />}</td></tr>;
    })}</tbody></table></div>}
  </Panel></div>;
}

function documentLink(document: AdminDocumentView): ReactNode {
  if (!document.id || !document.downloadAvailable) return <span className="rm-muted">Unavailable</span>;
  return <a href={`/api/rent-ops/documents/${encodeURIComponent(document.id)}/download`} className="rm-link">Open</a>;
}

function DocumentsTab({ tenant, snapshot, onChanged }: { tenant: TenantView; snapshot: AdminSnapshot; onChanged: () => void }) {
  const context = resolveTenantContext(tenant, snapshot);
  const currentTenancyId = context.currentTenancy?.id;
  const documents = tenant.documents ?? [];
  return <div className="rm-tenant-tab-content"><Panel title="Documents"><div className="rm-document-upload">{currentTenancyId && <ManagerLeaseUpload key={`lease-upload:${currentTenancyId}`} tenancyId={currentTenancyId} files={documents} onSaved={onChanged} />}</div>{documents.length === 0 ? <Empty message="No tenant documents are linked." /> : <div className="rm-table-wrap"><table className="rm-table"><caption className="sr-only">Tenant documents</caption><thead><tr><th>Type</th><th>File</th><th>State</th><th>Uploaded</th><th>Verified</th><th>Availability</th><th>Open</th></tr></thead><tbody>{documents.map((document, index) => <tr key={document.id ?? `document-${index}`}><td>{document.type ? label(document.type) : UNVERIFIED_LABEL}</td><td><strong>{text(document.fileName)}</strong><small>{document.mimeType ?? UNVERIFIED_LABEL}</small></td><td>{statusValue(document.state, !document.state)}</td><td>{formatDate(document.uploadedAt)}</td><td>{formatDate(document.verifiedAt)}</td><td>{document.availability ? label(document.availability) : UNVERIFIED_LABEL}</td><td>{documentLink(document)}</td></tr>)}</tbody></table></div>}</Panel></div>;
}

function ActivityTab({ tenant, onEdit, editActions }: { tenant: TenantView; onEdit: EditAction; editActions: TenantEditAction[] }) {
  const rows = [...(tenant.activity ?? [])].sort((left, right) => String(right.occurredAt ?? "").localeCompare(String(left.occurredAt ?? "")));
  return <div className="rm-tenant-tab-content"><Panel title="Activity">
    {rows.length === 0 ? <Empty message="No activity is linked to this tenant." /> : <div className="rm-activity-list">{rows.map((event, index) => <article className="rm-activity-item" key={event.id ?? `activity-${index}`}><div className="rm-activity-meta"><span>{formatDate(event.occurredAt)}</span>{statusValue(event.type, !event.type)}</div><div><strong>{text(event.summary)}</strong><p>{valueOrDash(event.detail)}</p><small>{event.actor ? `By ${event.actor}` : "Actor unverified"}</small></div></article>)}</div>}
  </Panel></div>;
}

function tabContent(tab: TenantTab, props: Omit<TenantRecordProps, "tab" | "onTab"> & { editActions: TenantEditAction[] }): ReactNode {
  switch (tab) {
    case "summary": return <SummaryTab {...props} />;
    case "household": return <HouseholdTab {...props} />;
    case "tenancy": return <TenancyTab {...props} />;
    case "charges": return <ChargesTab {...props} />;
    case "ledger": return <LedgerTab {...props} />;
    case "deposits": return <DepositsTab {...props} />;
    case "housing-assistance": return <HapTab {...props} />;
    case "documents": return <DocumentsTab tenant={props.tenant} snapshot={props.snapshot} onChanged={props.onChanged} />;
    case "activity": return <ActivityTab tenant={props.tenant} onEdit={props.onEdit} editActions={props.editActions} />;
  }
}

export function TenantRecord({ tenant, snapshot, tab, onTab, onEdit, onChanged, onMoveRefresh, businessDate, readOnly = false, onManageMoves }: TenantRecordProps) {
  const [movesOpen, setMovesOpen] = useState(false);
  const [addPaymentOpen,setAddPaymentOpen]=useState(false);
  const paymentTenancy=resolveTenantContext(tenant,snapshot).currentTenancy;
  const review = balanceReviewDisplay(tenant.balanceReview);
  const summary = buildTenantSummary(tenant, snapshot);
  const editActions = useMemo(() => buildTenantEditActions(tenant, snapshot, tab), [tenant, snapshot, tab]);
  const headerActions = useMemo(() => {
    const oneTime = buildTenantEditActions(tenant, snapshot, "ledger").filter(action => action.action === "post-ledger-transaction");
    const contextual = editActions.filter(action => (tab === "summary" && action.action === "save-person") || (tab === "activity" && action.action === "save-activity") || (tab === "deposits" && action.label.startsWith("Add ")));
    return [...oneTime, ...contextual];
  }, [tenant, snapshot, editActions, tab]);
  return <section className="rm-tenant-record" aria-label={`Tenant record for ${summary.displayName}`}>
    {addPaymentOpen && paymentTenancy?.id && <PaymentEditDialog id="new" tenancyId={paymentTenancy.id} businessDate={businessDate??summary.asOfDate} tenantName={summary.displayName} onClose={()=>setAddPaymentOpen(false)} onSaved={onMoveRefresh??(async()=>{await onChanged();})}/>}
    <header className="rm-record-summary">
      <div className="rm-record-summary-main"><h2>{summary.displayName}</h2><p>{summary.propertyName} · Unit {summary.unitLabel}</p></div>
      <div className="rm-record-summary-meta"><span className={statusClass(displayStatus(summary.status), displayStatus(summary.status) === UNVERIFIED_LABEL)}>{label(displayStatus(summary.status))}</span><span className={`rm-record-balance${review ? tenant.balanceReview?.stale || tenant.balanceReview?.reviewedBalanceCents ? " rm-record-balance-warning" : "" : summary.balance.complete && summary.balance.amountCents ? " rm-record-balance-warning" : ""}`}><small>{review ? review.label : "Posted ledger balance"}</small><strong>{review ? review.amount : summary.balance.complete ? formatMoney(summary.balance.amountCents) : reviewLabelForCodes(summary.balance.uncertaintyCodes)}</strong></span><span className="rm-record-as-of"><small>As of</small><strong>{formatDate(review ? tenant.balanceReview?.asOfDate : summary.asOfDate)}</strong></span></div>
    </header>
    {!readOnly && businessDate && <div className="rm-toolbar"><button className="rm-button" onClick={() => onManageMoves ? onManageMoves() : setMovesOpen(true)}>Move-in / move-out</button></div>}
    {movesOpen && !readOnly && businessDate && <ManagerTenancyActions key={tenant.person.id} snapshot={snapshot} personId={tenant.person.id} businessDate={businessDate} onSaved={onMoveRefresh ?? (async () => { await onChanged(); })} onClose={() => setMovesOpen(false)} />}
    <nav className="rm-tabs rm-tenant-tabs" role="tablist" aria-label="Tenant record sections">{TENANT_RECORD_TABS.map((item) => <button type="button" role="tab" aria-selected={tab === item} aria-controls={`tenant-panel-${item}`} className={tab === item ? "active" : ""} key={item} onClick={() => onTab(item)}>{TAB_LABELS[item]}</button>)}</nav>
    {headerActions.length > 0 && <div className="rm-toolbar rm-tenant-toolbar">{tab==="ledger"&&!readOnly&&<button className="rm-button rm-button-primary" disabled={!paymentTenancy?.id} onClick={()=>setAddPaymentOpen(true)}>Add payment</button>}{headerActions.map((action) => <ActionButton key={`${action.action}-${action.label}`} action={action} onEdit={onEdit} primary />)}</div>}
    <div id={`tenant-panel-${tab}`} role="tabpanel" className="rm-tenant-panel-body">{tabContent(tab, { tenant, snapshot, onEdit, onChanged, onMoveRefresh, businessDate, readOnly, editActions })}</div>
  </section>;
}
