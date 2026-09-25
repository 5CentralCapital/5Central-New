import assert from "node:assert/strict";
import test from "node:test";
import type { ReportRow } from "../types";
import { createReportViewModel, formatReportCellValue, formatReportValue, overdueDateAbsentLabel, type ReportKey } from "./report-model";
import { gridCellText } from "./grid-model";
import { dashboardKpis, splitDueRows } from "./dashboard-kpis";
import { activityDisplay } from "./activity-display";
import { unconfirmedScheduleMessage, unverifiedBalanceMessage } from "../ui";

// Synthetic rows only.
function cells(report: ReportKey, row: Record<string, unknown>): Record<string, string> {
  const view = createReportViewModel(report, [row as ReportRow]);
  return Object.fromEntries(view.columns.map((column) => [column.label, formatReportCellValue(view.displayRows[0], column)]));
}

test("K1: empty or omitted review-code lists read None; real codes stay visible; null values keep specific labels", () => {
  assert.equal(formatReportValue([], "status"), "None");
  assert.equal(formatReportValue([]), "None");
  assert.equal(formatReportValue(null, "currency"), "Unknown");
  const clean = cells("scheduled-vs-collected", { propertyId: "p1", propertyName: "Synthetic", month: "2026-09", scheduledCents: 1000, collectedCents: 1000, varianceCents: 0, complete: true, uncertaintyCodes: [] });
  assert.equal(clean["Review flags"], "None");
  const omitted = cells("scheduled-vs-collected", { propertyId: "p1", propertyName: "Synthetic", month: "2026-09", scheduledCents: 1000, collectedCents: 1000, varianceCents: 0, complete: true });
  assert.equal(omitted["Review flags"], "None");
  const flagged = cells("scheduled-vs-collected", { propertyId: "p1", propertyName: "Synthetic", month: "2026-09", scheduledCents: 1000, collectedCents: 0, varianceCents: null, complete: false, uncertaintyCodes: ["schedule_person_assignment_ambiguous"] });
  assert.equal(flagged["Review flags"], "Schedule Person Assignment Ambiguous");
  assert.equal(flagged.Variance, "Unknown");
  // A discovered code column (for example on HAP rows) also treats absence as none.
  const hap = createReportViewModel("hap", [{ propertyId: "p1", agencyObligationCents: 100, uncertaintyCodes: undefined } as ReportRow, { propertyId: "p1", uncertaintyCodes: ["subsidy_payment_amount_unknown"] } as ReportRow]);
  const codes = hap.columns.find((column) => column.key === "uncertaintyCodes");
  assert.equal(codes && formatReportCellValue(hap.displayRows[0], codes), "None");
});

test("K5: uncertain scheduled dollars and disposition counts are visible columns", () => {
  const row = cells("scheduled-vs-collected", { propertyId: "p1", propertyName: "Synthetic", month: "2026-09", scheduledCents: 100000, scheduledUncertainCents: 45000, collectedCents: 0, varianceCents: null, complete: false, scheduleNotApplicableVacantCount: 1, schedulePrecedenceSuppressedCount: 2, scheduleNotApplicableOtherTenancyCount: 0 });
  assert.equal(row["Uncertain scheduled"], "$450.00");
  assert.equal(row["Schedules not counted"], "1 vacant unit · 2 lower precedence");
  const none = cells("scheduled-vs-collected", { propertyId: "p1", propertyName: "Synthetic", month: "2026-09", scheduledCents: 1, collectedCents: 1, varianceCents: 0, complete: true });
  assert.equal(none["Schedules not counted"], "None");
  assert.match(createReportViewModel("scheduled-vs-collected", []).sourceNote, /report date/);
});

test("K3: inapplicable delinquency fields say what is true instead of an uncertainty label", () => {
  const settled = cells("delinquency", { propertyId: "p1", propertyName: "Synthetic", tenantName: "Synthetic Resident", rentOnlyBalanceCents: 0, operationalBalanceCents: 0, balanceComplete: true });
  assert.equal(settled["Oldest unpaid rent"], "Not overdue");
  assert.equal(settled["Notice status"], "No notice");
  assert.equal(settled["Last payment"], "None recorded");
  assert.equal(settled.Unit, "Link missing");
  const unknown = cells("delinquency", { propertyId: "p1", unitNumber: "1", rentOnlyBalanceCents: null, operationalBalanceCents: null, balanceComplete: false });
  assert.equal(unknown["Oldest unpaid rent"], "Unknown");
  assert.equal(unknown["Last payment"], "Unknown");
  assert.equal(overdueDateAbsentLabel({ rentOnlyBalanceCents: 5000 } as ReportRow), "Date missing");
  const dated = cells("delinquency", { propertyId: "p1", unitNumber: "1", rentOnlyBalanceCents: 5000, oldestUnpaidRentOn: "2026-08-01", noticeStatus: "notice_given" });
  assert.notEqual(dated["Oldest unpaid rent"], "Not overdue");
  assert.equal(dated["Notice status"], "Notice Given");
});

test("K6: a known deposit amount stays visible when only its date is unverified; the three facts are separate", () => {
  const dateOnly = cells("security-deposit", { propertyId: "p1", propertyName: "Synthetic", unitNumber: "1A", unitLinkStatus: "tenancy", tenantName: "Synthetic Resident", securityHeldCents: 110000, refundablePetHeldCents: 0, otherRefundableHeldCents: 0, totalHeldCents: 110000, unknownHeldCount: 0, temporalUncertainty: true, hasUnknownReceiptDate: true, dispositionStatus: "held" });
  assert.equal(dateOnly["Security held"], "$1,100.00");
  assert.equal(dateOnly["Total held"], "$1,100.00");
  assert.equal(dateOnly["Date review"], "Date unverified");
  assert.equal(dateOnly["Unknown amounts"], "0");
  assert.equal(dateOnly["Unit link"], "Via tenancy");
  const unknownAmount = cells("security-deposit", { propertyId: "p1", unitLinkStatus: "missing", securityHeldCents: null, totalHeldCents: null, unknownHeldCount: 1, temporalUncertainty: false });
  assert.equal(unknownAmount["Total held"], "Unknown");
  assert.equal(unknownAmount["Date review"], "None");
  assert.equal(unknownAmount.Unit, "Link missing");
  assert.equal(unknownAmount["Unit link"], "Link missing");
});

test("K4: HAP obligations stay visible on exception rows; receipt status separates none from unknown", () => {
  const none = cells("hap", { propertyId: "p1", agencyObligationCents: 40000, tenantObligationCents: 80000, expectedTotalCents: 120000, receivedAgencyCents: 0, agencyReceiptStatus: "none_received", varianceCents: -40000, exception: true, uncertainty: false });
  assert.equal(none["Agency obligation"], "$400.00");
  assert.equal(none["Tenant obligation"], "$800.00");
  assert.equal(none["Expected total"], "$1,200.00");
  assert.equal(none["Agency receipt"], "None received");
  assert.equal(none.Variance, "-$400.00");
  const unknown = cells("hap", { propertyId: "p1", agencyObligationCents: 40000, tenantObligationCents: 80000, expectedTotalCents: 120000, receivedAgencyCents: null, agencyReceiptStatus: "unknown", varianceCents: null, exception: true, uncertainty: true });
  assert.equal(unknown["Agency obligation"], "$400.00");
  assert.equal(unknown["Agency received"], "Unknown");
  assert.equal(unknown["Agency receipt"], "Receipt status unknown");
  assert.equal(unknown.Variance, "Unknown");
});

test("L2: a blank grid cell shows a dash, not the row's review reason", () => {
  assert.equal(gridCellText("tenantName", undefined), "—");
  assert.equal(gridCellText("phone", ""), "—");
  assert.equal(gridCellText("moveInOn", null), "—");
  assert.equal(gridCellText("status", null), "—");
  assert.equal(gridCellText("amountCents", null), "Unknown");
  assert.equal(gridCellText("propertyId", "p1"), "—");
  assert.equal(gridCellText("tenantName", "Synthetic Resident"), "Synthetic Resident");
});

test("K2: balances due count known amounts separately from unverified balances", () => {
  const rows = [
    { operationalBalanceCents: 50000, balanceUncertaintyCodes: [] },
    { operationalBalanceCents: 25000 },
    { operationalBalanceCents: null, balanceUncertaintyCodes: ["history_incomplete"] },
  ];
  assert.deepEqual(splitDueRows(rows), { knownCents: 75000, knownCount: 2, unverifiedCount: 1 });
  const due = dashboardKpis({ dueRows: rows, period: "2026-09" }).find((kpi) => kpi.key === "due")!;
  assert.equal(due.value, "$750.00");
  assert.match(due.detail, /^2 accounts · 1 not verified/);
  const clean = dashboardKpis({ dueRows: rows.slice(0, 2), period: "2026-09" }).find((kpi) => kpi.key === "due")!;
  assert.equal(clean.detail, "2 accounts");
  assert.doesNotMatch(clean.detail, /not verified/);
  const onlyUnverified = dashboardKpis({ dueRows: rows.slice(2), period: "2026-09" }).find((kpi) => kpi.key === "due")!;
  assert.equal(onlyUnverified.value, "Unknown", "no known amount and an unverified balance is not $0");
  const empty = dashboardKpis({ dueRows: [], period: "2026-09" }).find((kpi) => kpi.key === "due")!;
  assert.equal(empty.detail, "No open balances");
});

test("K7: imported activity without a title, body, type or author says so without inventing them", () => {
  assert.deepEqual(activityDisplay({}), { title: "Details unavailable", actor: "Author not recorded", type: "Type not recorded", typeKnown: false });
  const bodyOnly = activityDisplay({ detail: "Synthetic body", actor: "Unknown actor", actorKnowledge: "unknown", type: "call" });
  assert.equal(bodyOnly.title, "No title recorded");
  assert.equal(bodyOnly.body, "Synthetic body");
  assert.equal(bodyOnly.actor, "Author not recorded");
  assert.equal(bodyOnly.type, "Call");
  assert.equal(activityDisplay({ summary: "Synthetic subject", actor: "Synthetic Staff" }).actor, "By Synthetic Staff");
});

test("L1: dashboard statements are specific and do not say 'need review'", () => {
  assert.equal(unverifiedBalanceMessage(1), "1 balance is unverified because the account history is incomplete.");
  assert.equal(unverifiedBalanceMessage(3), "3 balances are unverified because the account history is incomplete.");
  assert.equal(unconfirmedScheduleMessage(2), "2 schedules are missing a confirmed amount, category or date.");
  for (const message of [unverifiedBalanceMessage(undefined), unconfirmedScheduleMessage(undefined)]) assert.doesNotMatch(message, /need.{0,4}review/i);
});
