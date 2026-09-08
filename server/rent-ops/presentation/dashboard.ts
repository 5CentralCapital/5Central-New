import type {
  DashboardSummary,
  RentOpsActivityEvent,
  RentOpsApplication,
  RentOpsApplicationRecord,
  RentOpsDocument,
  RentOpsSnapshot,
} from "../../../shared/rent-ops-contracts";
import {
  isRecord,
  JsonObject,
  presentationObject,
  recordArrayValue,
  stringValue,
} from "./allowlist";
import {
  AdminSnapshotView,
  serializeAdminActivity,
  serializeAdminApplication,
  serializeAdminDashboardSummary,
  serializeAdminDocument,
  serializeAdminSnapshot,
  serializeAdminTenantProfile,
} from "./entities";
import { serializeReportMap } from "./reports";

/** Inputs accepted by the browser bundle adapter. No persistence shape is exported. */
export interface AdminDashboardInput {
  generatedAt?: string;
  summary: DashboardSummary;
  snapshot?: RentOpsSnapshot;
  reports?: unknown;
  tenants?: unknown[];
  applicants?: Array<RentOpsApplication | RentOpsApplicationRecord>;
  documents?: RentOpsDocument[];
  activities?: RentOpsActivityEvent[];
}

export interface AdminDashboardView {
  generatedAt?: string;
  summary: JsonObject;
  snapshot?: AdminSnapshotView;
  rentRoll: JsonObject[];
  occupancy: JsonObject[];
  scheduledIncome: JsonObject[];
  collectedIncome: JsonObject[];
  scheduledVsCollected: JsonObject[];
  delinquency: JsonObject[];
  ledger: JsonObject[];
  leaseExpiration: JsonObject[];
  depositLiability: JsonObject[];
  hap: JsonObject[];
  tenants: JsonObject[];
  applicants: JsonObject[];
  documents: JsonObject[];
  activities: JsonObject[];
  reports: Record<string, JsonObject[]>;
}

function rowsFromReport(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.rows)) return value.rows;
  return [];
}

function reportRows(reports: Record<string, JsonObject[]>, ...names: string[]): JsonObject[] {
  for (const name of names) {
    if (reports[name]) return reports[name];
  }
  return [];
}

/**
 * Build the complete admin browser bundle. `snapshot` is exposed under that
 * name only; the legacy `raw` envelope is deliberately not reproduced.
 */
export function serializeAdminDashboard(input: AdminDashboardInput): AdminDashboardView {
  const reportsInput = isRecord(input.reports) ? Object.fromEntries(Object.entries(input.reports).map(([key, value]) => [key, rowsFromReport(value)])) : {};
  const reports = serializeReportMap(reportsInput);
  const serializedSnapshot = input.snapshot ? serializeAdminSnapshot(input.snapshot) : undefined;
  const applicants = (input.applicants ?? []).map((application) => serializeAdminApplication(application));
  const documents = (input.documents ?? []).map((document) => serializeAdminDocument(document));
  const activities = (input.activities ?? []).map((activity) => serializeAdminActivity(activity));
  const tenants = (input.tenants ?? []).map((tenant) => serializeAdminTenantProfile(tenant));
  return presentationObject({
    generatedAt: stringValue(input.generatedAt),
    summary: serializeAdminDashboardSummary(input.summary),
    snapshot: serializedSnapshot,
    rentRoll: reportRows(reports, "rent-roll"),
    occupancy: reportRows(reports, "occupancy"),
    scheduledIncome: reportRows(reports, "scheduled-income"),
    collectedIncome: reportRows(reports, "collected-income"),
    scheduledVsCollected: reportRows(reports, "scheduled-vs-collected"),
    delinquency: reportRows(reports, "delinquency"),
    ledger: reportRows(reports, "tenant-ledger"),
    leaseExpiration: reportRows(reports, "lease-expiration", "lease-expirations"),
    depositLiability: reportRows(reports, "security-deposit", "deposits"),
    hap: reportRows(reports, "hap"),
    tenants,
    applicants,
    documents,
    activities,
    reports,
  }) as unknown as AdminDashboardView;
}

export const serializeDashboard = serializeAdminDashboard;
export const serializeAdminSnapshotBundle = serializeAdminDashboard;
export const serializeDashboardResponse = serializeAdminDashboard;
