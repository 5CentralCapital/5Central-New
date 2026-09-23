import type { ReportDrilldown, ReportMissingData, ReportSourceCoverage, ReportingEngineContext, ReportingEngineResult } from "../../shared/reporting";
import type { RentOpsFilters, RentOpsSnapshot } from "../../shared/rent-ops-contracts";
import { deriveCollectedIncome } from "../rent-ops/domain/reports";
import { isOccupiedTenancyOn } from "../rent-ops/domain/tenancy-occupancy";
import { ReportingError } from "./errors";
import { periodBounds, reportColumns, resultFromRecords, rowMatchesSearch, sourceCoverage } from "./source-engine-utils";
import type { ReportingEngine } from "./registry";

export const RENTAL_EXTENDED_REPORT_IDS = [
  "current-tenants",
  "rent-paid",
  "renters-insurance",
  "tenant-vehicles",
  "unit-listings",
] as const;
export type RentalExtendedReportId = (typeof RENTAL_EXTENDED_REPORT_IDS)[number];

export interface RentalSnapshotReadResult {
  readonly snapshot: RentOpsSnapshot;
  readonly coverage?: {
    readonly state?: ReportSourceCoverage["state"];
    readonly evidence?: ReportSourceCoverage["evidence"];
    readonly watermark?: string | null;
    readonly coveredFrom?: string | null;
    readonly coveredThrough?: string | null;
    readonly reason?: string | null;
  };
}

export interface RentalSnapshotReadPort {
  readSnapshot(input: { readonly context: ReportingEngineContext; readonly filters: RentOpsFilters }): Promise<RentalSnapshotReadResult>;
}

function rentalFilters(context: ReportingEngineContext): RentOpsFilters {
  const raw = context.request.filters;
  const filters: RentOpsFilters = {};
  const stringField = (name: keyof RentOpsFilters): string | undefined => typeof raw[name] === "string" ? raw[name] as string : undefined;
  const arrayField = (name: keyof RentOpsFilters): string[] | undefined => Array.isArray(raw[name]) ? (raw[name] as unknown[]).filter((value): value is string => typeof value === "string") : undefined;
  const propertyIds = context.request.scope.propertyIds.map(String);
  if (propertyIds.length) filters.propertyIds = propertyIds;
  const unitIds = context.request.scope.unitIds.map(String);
  const tenantIds = context.request.scope.tenantIds.map(String);
  const tenancyIds = context.request.scope.tenancyIds.map(String);
  if (unitIds.length === 1) filters.unitId = unitIds[0];
  if (tenantIds.length === 1) filters.personId = tenantIds[0];
  if (tenancyIds.length === 1) filters.tenancyId = tenancyIds[0];
  // The run period is the only date authority; date filter fields are not
  // accepted for these reports.
  const period = context.request.period;
  const asOfDate = period.mode === "as_of" ? period.asOfDate : period.mode === "custom" ? period.asOfDate : undefined;
  const fromDate = period.mode === "range" ? period.fromDate : period.mode === "custom" ? period.fromDate : undefined;
  const toDate = period.mode === "range" ? period.toDate : period.mode === "custom" ? period.toDate : undefined;
  const month = period.mode === "month" ? period.month : period.mode === "custom" ? period.month : undefined;
  const search = stringField("search");
  const tenantStatus = stringField("tenantStatus");
  const propertyScope = stringField("propertyScope");
  if (asOfDate) filters.asOfDate = asOfDate as RentOpsFilters["asOfDate"];
  if (fromDate) filters.fromDate = fromDate as RentOpsFilters["fromDate"];
  if (toDate) filters.toDate = toDate as RentOpsFilters["toDate"];
  if (month) filters.month = month as RentOpsFilters["month"];
  if (search) filters.search = search;
  if (tenantStatus && ["all", "current", "former", "future", "unknown"].includes(tenantStatus)) filters.tenantStatus = tenantStatus as RentOpsFilters["tenantStatus"];
  if (propertyScope === "active" || propertyScope === "all") filters.propertyScope = propertyScope;
  const status = arrayField("status");
  if (status?.length) filters.status = status;
  const unitFilter = Array.isArray(raw.unitIds) ? (raw.unitIds as unknown[]).filter((value): value is string => typeof value === "string") : undefined;
  if (unitFilter?.length && unitIds.length === 0) filters.unitId = unitFilter.length === 1 ? unitFilter[0] : undefined;
  const tenantFilter = Array.isArray(raw.tenantIds) ? (raw.tenantIds as unknown[]).filter((value): value is string => typeof value === "string") : undefined;
  if (tenantFilter?.length && tenantIds.length === 0) filters.personId = tenantFilter.length === 1 ? tenantFilter[0] : undefined;
  return filters;
}

function asOfDate(context: ReportingEngineContext): string {
  const period = context.request.period;
  if (period.mode === "as_of") return period.asOfDate;
  if (period.mode === "month") return `${period.month}-01`;
  return period.mode === "range" ? period.toDate : period.toDate ?? period.asOfDate ?? new Date(context.now).toISOString().slice(0, 10);
}

function nameOf(snapshot: RentOpsSnapshot, personId: string | undefined): string | null {
  if (!personId) return null;
  const person = snapshot.people.find(item => item.id === personId);
  return person ? `${person.firstName} ${person.lastName}`.trim() : null;
}

function propertyName(snapshot: RentOpsSnapshot, propertyId: string | undefined): string | null {
  return propertyId ? snapshot.properties.find(property => property.id === propertyId)?.name ?? null : null;
}

function emptySourceMissing(snapshot: RentOpsSnapshot): ReportMissingData[] {
  return snapshot.properties.length || snapshot.units.length || snapshot.tenancies.length || snapshot.people.length
    ? []
    : [{ code: "rental_source_empty", state: "unknown", message: "The rental source returned no records and does not prove a verified zero." }];
}

function scopeMatches(context: ReportingEngineContext, propertyId?: string | null, unitId?: string | null, personId?: string | null, tenancyId?: string | null): boolean {
  const scope = context.request.scope;
  if (propertyId && scope.propertyIds.length && !scope.propertyIds.includes(propertyId as typeof scope.propertyIds[number])) return false;
  if (unitId && scope.unitIds.length && !scope.unitIds.includes(unitId as typeof scope.unitIds[number])) return false;
  if (personId && scope.tenantIds.length && !scope.tenantIds.includes(personId as typeof scope.tenantIds[number])) return false;
  if (tenancyId && scope.tenancyIds.length && !scope.tenancyIds.includes(tenancyId as typeof scope.tenancyIds[number])) return false;
  const selectedProperties = Array.isArray(context.request.filters.propertyIds) ? context.request.filters.propertyIds.filter((value): value is string => typeof value === "string") : [];
  const selectedUnits = Array.isArray(context.request.filters.unitIds) ? context.request.filters.unitIds.filter((value): value is string => typeof value === "string") : [];
  const selectedTenants = Array.isArray(context.request.filters.tenantIds) ? context.request.filters.tenantIds.filter((value): value is string => typeof value === "string") : [];
  const selectedTenancies = Array.isArray(context.request.filters.tenancyIds) ? context.request.filters.tenancyIds.filter((value): value is string => typeof value === "string") : [];
  if (selectedProperties.length && (!propertyId || !selectedProperties.includes(propertyId))) return false;
  if (selectedUnits.length && (!unitId || !selectedUnits.includes(unitId))) return false;
  if (selectedTenants.length && (!personId || !selectedTenants.includes(personId))) return false;
  if (selectedTenancies.length && (!tenancyId || !selectedTenancies.includes(tenancyId))) return false;
  return true;
}

function baseCoverage(context: ReportingEngineContext, source: RentalSnapshotReadResult, rowCount: number): ReportSourceCoverage {
  const bounds = periodBounds(context);
  return sourceCoverage(context, {
    source: "rental_operational_records",
    state: source.coverage?.state ?? "partial",
    evidence: source.coverage?.evidence ?? "reproducible_snapshot",
    basis: "operational",
    watermark: source.coverage?.watermark ?? null,
    coveredFrom: source.coverage?.coveredFrom ?? bounds.from,
    coveredThrough: source.coverage?.coveredThrough ?? bounds.through,
    rowCount,
    reason: source.coverage?.reason ?? "The snapshot reader did not prove complete historical coverage for every requested rental source field.",
  });
}

function reportRows(context: ReportingEngineContext, source: RentalSnapshotReadResult, reportId: RentalExtendedReportId, allRecords: readonly unknown[], missingData: readonly ReportMissingData[] = []): ReportingEngineResult {
  const records = allRecords.filter(record => rowMatchesSearch(record as Record<string, unknown>, context.request.filters.search));
  const columns = reportId === "current-tenants"
    ? reportColumns([{ id: "propertyName", label: "Property", type: "text" }, { id: "unitNumber", label: "Unit", type: "text" }, { id: "tenantName", label: "Tenant", type: "text" }, { id: "status", label: "Status", type: "status" }, { id: "actualMoveInOn", label: "Move in", type: "date" }, { id: "occupancyConfirmedOn", label: "Occupancy confirmed", type: "date" }, { id: "occupancyEvidence", label: "Evidence", type: "status" }])
    : reportId === "rent-paid"
      ? reportColumns([{ id: "propertyName", label: "Property", type: "text" }, { id: "unitNumber", label: "Unit", type: "text" }, { id: "tenantName", label: "Tenant", type: "text" }, { id: "paymentOn", label: "Payment date", type: "date" }, { id: "category", label: "Category", type: "status" }, { id: "amountCents", label: "Amount", type: "money" }, { id: "description", label: "Description", type: "text" }])
      : reportId === "renters-insurance"
        ? reportColumns([{ id: "propertyName", label: "Property", type: "text" }, { id: "unitNumber", label: "Unit", type: "text" }, { id: "tenantName", label: "Tenant", type: "text" }, { id: "insuranceExpiresOn", label: "Insurance expiry", type: "date" }, { id: "insuranceStatus", label: "Status", type: "status" }, { id: "insuranceEvidence", label: "Evidence", type: "status" }])
        : reportId === "tenant-vehicles"
          ? reportColumns([{ id: "tenantName", label: "Tenant", type: "text" }, { id: "makeModel", label: "Vehicle", type: "text" }, { id: "plateState", label: "Plate state", type: "text" }, { id: "plateLastFour", label: "Plate last four", type: "text" }, { id: "recordStatus", label: "Record status", type: "status" }])
          : reportColumns([{ id: "propertyName", label: "Property", type: "text" }, { id: "unitNumber", label: "Unit", type: "text" }, { id: "unitType", label: "Unit type", type: "text" }, { id: "readiness", label: "Readiness", type: "status" }, { id: "listing", label: "Listing", type: "text" }, { id: "listingEvidence", label: "Evidence", type: "status" }, { id: "marketRentCents", label: "Market rent", type: "money" }]);
  const result = resultFromRecords(context, records, { source: "rental_operational_records", basis: "operational", missingData: [...emptySourceMissing(source.snapshot), ...missingData], columns });
  return { ...result, coverage: [baseCoverage(context, source, result.rows.length)] };
}

function currentTenantRows(context: ReportingEngineContext, snapshot: RentOpsSnapshot): unknown[] {
  const asOf = asOfDate(context);
  const units = new Map(snapshot.units.map(unit => [unit.id, unit]));
  return snapshot.tenancies
    .filter(tenancy => scopeMatches(context, tenancy.propertyId, tenancy.unitId, tenancy.primaryPersonId, tenancy.id))
    .filter(tenancy => isOccupiedTenancyOn(tenancy, asOf as never))
    .map(tenancy => {
      const unit = units.get(tenancy.unitId);
      return {
        tenancyId: tenancy.id,
        propertyId: tenancy.propertyId,
        propertyName: propertyName(snapshot, tenancy.propertyId),
        unitId: tenancy.unitId,
        unitNumber: unit?.unitNumber ?? null,
        tenantId: tenancy.primaryPersonId,
        tenantName: nameOf(snapshot, tenancy.primaryPersonId),
        status: tenancy.status,
        actualMoveInOn: tenancy.actualMoveInOn ?? null,
        occupancyConfirmedOn: tenancy.occupancyConfirmedOn ?? null,
        occupancyEvidence: tenancy.actualMoveInOn ? tenancy.actualMoveInKnowledge ?? "unknown" : tenancy.occupancyConfirmationKnowledge ?? "unknown",
      };
    });
}

function insuranceRows(context: ReportingEngineContext, snapshot: RentOpsSnapshot): { rows: unknown[]; missingData: ReportMissingData[] } {
  const asOf = asOfDate(context);
  const rows = currentTenantRows(context, snapshot).map(value => {
    const row = value as { tenantId: string; tenancyId: string; propertyId: string; unitId: string; tenantName: string | null };
    const person = snapshot.people.find(item => item.id === row.tenantId);
    const expiresOn = person?.renterInsuranceExpiresOn ?? null;
    return { ...row, insuranceExpiresOn: expiresOn, insuranceStatus: expiresOn === null ? "unknown" : expiresOn < asOf ? "expired" : "recorded_through_date", insuranceEvidence: expiresOn === null ? "no_expiry_record" : "person_expiry_field_only" };
  });
  return {
    rows,
    missingData: [{ code: "insurance_policy_history_unavailable", state: "partial", message: "R-ops stores a person expiry field only; complete policy history, effective start, carrier, and coverage limits are unavailable." }],
  };
}

function vehicleRows(context: ReportingEngineContext, snapshot: RentOpsSnapshot): { rows: unknown[]; missingData: ReportMissingData[] } {
  const currentByApplication = new Map(snapshot.tenancies.filter(tenancy => tenancy.applicationId).map(tenancy => [tenancy.applicationId!, tenancy]));
  const rows: unknown[] = [];
  for (const application of snapshot.applications) {
    if (!application.vehicles?.length) continue;
    const tenancy = application.convertedTenancyId ? snapshot.tenancies.find(item => item.id === application.convertedTenancyId) : currentByApplication.get(application.id);
    if (tenancy && !scopeMatches(context, tenancy.propertyId, tenancy.unitId, tenancy.primaryPersonId, tenancy.id)) continue;
    application.vehicles.forEach((vehicle, index) => rows.push({
      applicationId: application.id,
      tenancyId: tenancy?.id ?? null,
      propertyId: tenancy?.propertyId ?? application.propertyId ?? null,
      unitId: tenancy?.unitId ?? application.unitId ?? null,
      tenantId: tenancy?.primaryPersonId ?? null,
      tenantName: nameOf(snapshot, tenancy?.primaryPersonId),
      vehicleIndex: index,
      makeModel: vehicle.makeModel ?? null,
      plateState: vehicle.plateState ?? null,
      plateLastFour: vehicle.plateLastFour ?? null,
      recordStatus: tenancy ? "linked_to_tenancy" : "application_record_only",
    }));
  }
  return { rows, missingData: [{ code: "current_vehicle_status_unavailable", state: "partial", message: "Vehicle facts are stored on applications; R-ops does not prove a complete current tenant vehicle history or active status." }] };
}

export function createRentalExtendedReportingEngine(read: RentalSnapshotReadPort): ReportingEngine {
  return {
    key: "rental.operational-expanded",
    reportIds: [...RENTAL_EXTENDED_REPORT_IDS],
    ready: true,
    async run(context): Promise<ReportingEngineResult> {
      const reportId = context.definition.id as RentalExtendedReportId;
      const filters = rentalFilters(context);
      const source = await read.readSnapshot({ context, filters });
      const snapshot = source.snapshot;
      if (reportId === "current-tenants") return reportRows(context, source, reportId, currentTenantRows(context, snapshot));
      if (reportId === "rent-paid") {
        const rows = deriveCollectedIncome(snapshot, filters).filter(row => scopeMatches(context, row.propertyId, row.unitId, row.personId, row.tenancyId));
        return reportRows(context, source, reportId, rows);
      }
      if (reportId === "renters-insurance") {
        const result = insuranceRows(context, snapshot);
        return reportRows(context, source, reportId, result.rows, result.missingData);
      }
      if (reportId === "tenant-vehicles") {
        const result = vehicleRows(context, snapshot);
        return reportRows(context, source, reportId, result.rows, result.missingData);
      }
      if (reportId === "unit-listings") {
        const rows = snapshot.units.filter(unit => scopeMatches(context, unit.propertyId, unit.id)).map(unit => ({
          propertyId: unit.propertyId,
          propertyName: propertyName(snapshot, unit.propertyId),
          unitId: unit.id,
          unitNumber: unit.unitNumber,
          unitType: unit.unitType ?? null,
          readiness: unit.readiness,
          listing: unit.listing,
          listingEvidence: unit.listingKnowledge ?? "unknown",
          marketRentCents: unit.marketRentCents ?? null,
        }));
        return reportRows(context, source, reportId, rows);
      }
      throw new ReportingError("report_unavailable", `Rental report ${context.definition.id} is not supported by this adapter`, 409);
    },
  };
}

export const LEASING_UNATTRIBUTED = "Unattributed";

function daysBetween(from: string, through: string): number {
  return Math.round((Date.parse(`${through.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

/**
 * Leasing activity by the person who handled each application. Attribution is
 * the earliest non-system actor recorded on the application's activity
 * history; an application with no such event is reported as unattributed and
 * named in missing data, never assigned to a guessed agent.
 */
export function createRentalLeasingAgentEngine(read: RentalSnapshotReadPort): ReportingEngine {
  return {
    key: "rental.leasing-agent",
    reportIds: ["leasing-agent"],
    ready: true,
    async run(context): Promise<ReportingEngineResult> {
      const source = await read.readSnapshot({ context, filters: rentalFilters(context) });
      const snapshot = source.snapshot;
      const bounds = periodBounds(context);
      const scope = context.request.scope;
      const inScope = (propertyId?: string | null) => !scope.propertyIds.length || (typeof propertyId === "string" && scope.propertyIds.includes(propertyId as typeof scope.propertyIds[number]));
      const tenancies = new Map(snapshot.tenancies.map(tenancy => [tenancy.id, tenancy]));
      const actorsByApplication = new Map<string, { actor: string; occurredAt: string }>();
      for (const event of snapshot.activityEvents) {
        if (!event.applicationId || event.type === "system" || event.actorKnowledge === "unknown") continue;
        const actor = event.actor?.trim();
        if (!actor || /^(system|import|rm_import|automation)$/i.test(actor)) continue;
        const current = actorsByApplication.get(event.applicationId);
        if (!current || event.occurredAt < current.occurredAt) actorsByApplication.set(event.applicationId, { actor, occurredAt: event.occurredAt });
      }
      const groups = new Map<string, { received: number; approved: number; declined: number; withdrawn: number; converted: number; open: number; conversionDays: number[] }>();
      let unattributed = 0;
      for (const application of snapshot.applications) {
        const received = application.submittedOn ?? application.createdAt.slice(0, 10);
        if ((bounds.from && received < bounds.from) || (bounds.through && received > bounds.through)) continue;
        const tenancy = application.convertedTenancyId ? tenancies.get(application.convertedTenancyId) : undefined;
        if (!inScope(application.propertyId ?? tenancy?.propertyId)) continue;
        const actor = actorsByApplication.get(application.id)?.actor ?? LEASING_UNATTRIBUTED;
        if (actor === LEASING_UNATTRIBUTED) unattributed += 1;
        const group = groups.get(actor) ?? { received: 0, approved: 0, declined: 0, withdrawn: 0, converted: 0, open: 0, conversionDays: [] };
        group.received += 1;
        if (application.status === "approved") group.approved += 1;
        else if (application.status === "declined") group.declined += 1;
        else if (application.status === "withdrawn") group.withdrawn += 1;
        else if (application.status === "converted" || application.convertedTenancyId) {
          group.converted += 1;
          const moveIn = tenancy?.actualMoveInOn;
          if (moveIn) group.conversionDays.push(Math.max(0, daysBetween(received, moveIn)));
        } else group.open += 1;
        groups.set(actor, group);
      }
      const rows = Array.from(groups.entries()).map(([agent, group]) => {
        const sorted = [...group.conversionDays].sort((left, right) => left - right);
        const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2) : null;
        return { agent, received: group.received, open: group.open, approved: group.approved, declined: group.declined, withdrawn: group.withdrawn, converted: group.converted, conversionPercent: group.received ? (Math.round((group.converted / group.received) * 1000) / 10).toFixed(1) : null, medianDaysToMoveIn: median };
      }).filter(row => rowMatchesSearch(row, context.request.filters.search));
      const missingData: ReportMissingData[] = [...emptySourceMissing(snapshot)];
      if (unattributed) missingData.push({ code: "leasing_agent_unattributed", state: "partial", message: `${unattributed} application${unattributed === 1 ? " has" : "s have"} no recorded handling agent.`, count: unattributed });
      const columns = reportColumns([
        { id: "agent", label: "Agent", type: "text" }, { id: "received", label: "Applications", type: "integer" }, { id: "open", label: "Open", type: "integer" },
        { id: "approved", label: "Approved", type: "integer" }, { id: "declined", label: "Declined", type: "integer" }, { id: "withdrawn", label: "Withdrawn", type: "integer" },
        { id: "converted", label: "Moved in", type: "integer" }, { id: "conversionPercent", label: "Conversion", type: "percent" }, { id: "medianDaysToMoveIn", label: "Median days to move-in", type: "decimal" },
      ]);
      const result = resultFromRecords(context, rows, { source: "rental_applications_and_activity", basis: "operational", missingData, columns, rowId: (_record, _index, values) => `leasing-agent:${String(values.agent)}` });
      return { ...result, coverage: [baseCoverage(context, source, result.rows.length)] };
    },
  };
}
