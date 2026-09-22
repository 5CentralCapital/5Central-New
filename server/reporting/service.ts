import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  reportConsolidationPolicySchema,
  reportDefinitionVersionSchema,
  reportDrilldownRequestSchema,
  reportDrilldownSchema,
  reportExportJobSchema,
  reportExportRequestSchema,
  reportFilterValuesSchema,
  reportMissingDataSchema,
  reportPageRequestSchema,
  reportPageSchema,
  reportPackageItemSchema,
  reportPackageRunSchema,
  reportPackageSchema,
  reportPeriodSchema,
  reportPresetRevisionSchema,
  reportPresetSchema,
  reportResultSchema,
  reportRowSchema,
  reportRunRecordSchema,
  reportRunSummarySchema,
  reportRunRequestSchema,
  reportScopeSchema,
  reportSortSchema,
  reportSourceCoverageSchema,
  reportTotalSchema,
  reportingBasisSchema,
  reportingCategorySchema,
  reportingDefinitionSchema,
  type ReportDefinition,
  type ReportDrilldown,
  type ReportDrilldownRequest,
  type ReportEntry,
  type ReportExportJob,
  type ReportExportRequest,
  type ReportFilterValues,
  type ReportPackage,
  type ReportPackageItem,
  type ReportPackageRun,
  type ReportPage,
  type ReportPreset,
  type ReportPresetRevision,
  type ReportRunRecord,
  type ReportRunSummary,
  type ReportRunRequest,
  type ReportRow,
  type ReportSort,
  type ReportingEngineContext,
  type ReportingEngineResult,
  type ReportingPrincipalScope,
} from "../../shared/reporting";
import { getReportingDefinitions } from "../../shared/reporting";
import { authorizeCompanyRead, type AuthenticatedPrincipal } from "../company/authorization";
import { ReportingError } from "./errors";
import { createReportingRegistry, type ReportingRegistry } from "./registry";
import { createInMemoryReportingStore, type ReportingStore } from "./store";
import { compareValues, decodeCursor, encodeCursor, isoNow, newReportingId, sha256, stableJson } from "./utils";
import { exportReportCsv, exportReportHtml, exportReportJson } from "./export";

const REPORT_READ_ROLES = ["owner", "admin", "finance", "operations_pm", "project_manager", "read_only_reviewer"] as const;
const reportIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,119}$/);

export interface ReportingAccess {
  readonly principal: AuthenticatedPrincipal;
  readonly authorize?: (principal: AuthenticatedPrincipal, scope: ReportingPrincipalScope, definition: ReportDefinition) => void | Promise<void>;
  /** Root-facing integrations reload grants in a read-only transaction before every operation. */
  readonly refreshPrincipal?: () => Promise<AuthenticatedPrincipal>;
  /** Resolves an authorized property to its current legal entity mapping. */
  readonly resolvePropertyLegalEntity?: (propertyId: string, period?: ReportRunRequest["period"]) => Promise<string | null>;
}

export interface ReportingServiceOptions {
  readonly registry?: ReportingRegistry;
  readonly store?: ReportingStore;
  readonly now?: () => Date;
  readonly runTtlMs?: number;
  readonly exportTtlMs?: number;
  readonly maxRows?: number;
  readonly authorize?: ReportingAccess["authorize"];
}

export interface ReportRunResponse {
  readonly run: ReportRunRecord;
  readonly page: ReportPage;
}

export interface PublicReportRunResponse {
  readonly run: ReportRunSummary;
  readonly page: ReportPage;
}

export function publicReportRunResponse(response: ReportRunResponse): PublicReportRunResponse {
  const { rows, drilldowns, ...metadata } = response.run;
  return { run: reportRunSummarySchema.parse({ ...metadata, rowCount: rows.length, drilldownCount: drilldowns.length }), page: response.page };
}

export interface ReportPresetInput {
  readonly id?: string;
  readonly name: string;
  readonly description?: string | null;
  readonly visibility?: "private" | "shared";
  readonly reportId: string;
  readonly definitionVersion?: string;
  readonly scope: ReportRunRequest["scope"];
  readonly filters: ReportFilterValues;
  readonly period: ReportRunRequest["period"];
  readonly basis: ReportRunRequest["basis"];
  readonly currency: ReportRunRequest["currency"];
  readonly consolidation?: ReportRunRequest["consolidation"];
  readonly forecast?: ReportRunRequest["forecast"];
  readonly columns?: readonly string[];
  readonly sort?: readonly ReportSort[];
  readonly expectedRevision?: number;
}

export interface ReportPackageInput {
  readonly id?: string;
  readonly name: string;
  readonly description?: string | null;
  readonly visibility?: "private" | "shared";
  readonly items: readonly (Omit<ReportPackageItem, "id"> & { readonly id?: string; readonly title?: string })[];
  readonly expectedRevision?: number;
}

function actorOf(principal: AuthenticatedPrincipal): string { return principal.actorId; }

function scopeForAuth(scope: ReportRunRequest["scope"], legalEntityId?: string, propertyId?: string): ReportingPrincipalScope {
  return {
    organizationId: scope.organizationId,
    ...(legalEntityId ? { legalEntityId: legalEntityId as ReportingPrincipalScope["legalEntityId"] } : {}),
    ...(propertyId ? { propertyId: propertyId as ReportingPrincipalScope["propertyId"] } : {}),
  };
}

function filterPropertyIds(request: ReportRunRequest): string[] {
  const values: string[] = [];
  for (const name of ["propertyId", "propertyIds"] as const) {
    const value = request.filters[name];
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) values.push(...value.filter((item): item is string => typeof item === "string"));
  }
  return Array.from(new Set(values));
}

function assertUnique<T extends { rowId: string }>(rows: readonly T[]): void {
  if (new Set(rows.map(row => row.rowId)).size !== rows.length) throw new ReportingError("report_validation", "Report engine returned duplicate row IDs", 400, { reason: "duplicate_row_id" });
}

function sortRows(rows: readonly ReportRow[], sort: readonly ReportSort[]): ReportRow[] {
  const output = [...rows];
  output.sort((left, right) => {
    for (const field of sort) {
      const comparison = compareValues(left.values[field.field], right.values[field.field]);
      if (comparison !== 0) return field.direction === "desc" ? -comparison : comparison;
    }
    return left.rowId.localeCompare(right.rowId);
  });
  return output;
}

function sortFields(sort: readonly ReportSort[] | undefined): string[] {
  return sort?.map(item => item.field) ?? [];
}

function defaultSort(definition: ReportDefinition): ReportSort[] {
  const first = definition.columns.find(column => column.sortable)?.id;
  return first ? [{ field: first, direction: "asc" }] : [{ field: "rowId", direction: "asc" }];
}

function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }

function canonicalFilters(definition: ReportDefinition, input: ReportFilterValues): ReportFilterValues {
  const parsed = reportFilterValuesSchema.parse(input);
  const names = new Set(definition.filters.map(filter => filter.name));
  const unknown = Object.keys(parsed).filter(name => !names.has(name));
  if (unknown.length) throw new ReportingError("report_validation", "Report filters contain unsupported fields", 400, { reportId: definition.id, fields: unknown });
  const result: Record<string, unknown> = {};
  for (const definitionFilter of definition.filters) {
    const value = parsed[definitionFilter.name];
    if (value === undefined && definitionFilter.default !== undefined) result[definitionFilter.name] = definitionFilter.default;
    else if (value !== undefined && !(value === "" || (Array.isArray(value) && value.length === 0))) result[definitionFilter.name] = value;
    else if (definitionFilter.required) throw new ReportingError("report_validation", `Report filter ${definitionFilter.name} is required`, 400, { reportId: definition.id, field: definitionFilter.name });
  }
  for (const filter of definition.filters) {
    const value = result[filter.name];
    if (value === undefined) continue;
    const values = filter.multiple ? (Array.isArray(value) ? value : (() => { throw new ReportingError("report_validation", `Report filter ${filter.name} requires multiple values`, 400); })()) : value;
    if (filter.kind === "multi_select" && !Array.isArray(values)) throw new ReportingError("report_validation", `Report filter ${filter.name} requires an array`, 400);
    if (filter.kind === "reference" && filter.multiple && !Array.isArray(values)) throw new ReportingError("report_validation", `Report reference ${filter.name} requires an array`, 400);
    if (filter.kind !== "reference" && filter.kind !== "multi_select" && Array.isArray(values)) throw new ReportingError("report_validation", `Report filter ${filter.name} cannot be an array`, 400);
    if ((filter.kind === "reference" || filter.kind === "multi_select") && (Array.isArray(values) ? values : [values]).some(item => typeof item !== "string" || item.length === 0)) throw new ReportingError("report_validation", `Report filter ${filter.name} contains an invalid reference or option`, 400);
    if (filter.options) {
      const allowed = new Set(filter.options.map(option => option.value));
      for (const item of (Array.isArray(values) ? values : [values])) if (typeof item !== "string" || !allowed.has(item)) throw new ReportingError("report_validation", `Report filter ${filter.name} contains an unsupported option`, 400, { field: filter.name, value: item });
    }
    if (filter.kind === "date" && typeof value === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ReportingError("report_validation", `Report filter ${filter.name} requires a calendar date`, 400);
    if (filter.kind === "month" && typeof value === "string" && !/^\d{4}-\d{2}$/.test(value)) throw new ReportingError("report_validation", `Report filter ${filter.name} requires a calendar month`, 400);
    if (filter.kind === "currency" && typeof value === "string" && !/^[A-Z]{3}$/.test(value)) throw new ReportingError("report_validation", `Report filter ${filter.name} requires an ISO currency`, 400);
  }
  return reportFilterValuesSchema.parse(result);
}

function filterPeriodConsistency(request: ReportRunRequest, definition: ReportDefinition): void {
  if (definition.period !== "custom" && request.period.mode !== definition.period) throw new ReportingError("report_validation", `Report ${definition.id} requires a ${definition.period} period`, 400, { expected: definition.period, received: request.period.mode });
  const period = request.period;
  if (period.mode === "custom" && period.fromDate && period.toDate && period.toDate < period.fromDate) throw new ReportingError("report_validation", "Report period ends before it starts", 400);
  if (definition.actuality !== "actual" && !request.forecast) throw new ReportingError("report_validation", "Forecast reports require a scenario, input version, and model version", 400, { reportId: definition.id });
  if (definition.actuality === "actual" && request.forecast) throw new ReportingError("report_validation", "An actual report cannot include forecast inputs", 400, { reportId: definition.id });
  if (definition.category === "financial" && !request.scope.legalEntityIds.length) throw new ReportingError("report_validation", "Financial reports require explicit legal entity IDs", 400, { reportId: definition.id });
  if (definition.category === "financial" && !["cash", "accrual", "mixed"].includes(request.basis)) throw new ReportingError("report_validation", "Financial reports require cash, accrual, or explicitly mixed basis", 400);
}

function readPage(run: ReportRunRecord, offset: number, limit: number, rows = run.rows, totalRows = run.rows.length): ReportPage {
  const pageRows = rows.slice(0, limit);
  const nextOffset = offset + pageRows.length < totalRows ? offset + pageRows.length : null;
  return reportPageSchema.parse({ runId: run.id, snapshotId: run.snapshotId, rows: pageRows, rowCount: pageRows.length, totalRows, nextCursor: nextOffset === null ? null : encodeCursor({ runId: run.id, offset: nextOffset, sort: sha256(run.sort) }), columns: run.columns, totals: run.totals, coverage: run.coverage, missingData: run.missingData });
}

function isExpired(value: string | null, now: string): boolean { return value !== null && value <= now; }

function sameRunRequest(run: ReportRunRecord, request: ReportRunRequest): boolean {
  const requestedColumns = request.columns?.length ? [...request.columns].sort() : run.columns.map(column => column.id).sort();
  const storedColumns = run.columns.map(column => column.id).sort();
  return stableJson({ reportId: run.reportId, definitionVersion: run.definitionVersion, scope: run.scope, filters: run.filters, period: run.period, basis: run.basis, currency: run.currency, consolidation: run.consolidation, forecast: run.forecast, columns: storedColumns, sort: run.sort }) === stableJson({ reportId: request.reportId, definitionVersion: request.definitionVersion, scope: request.scope, filters: request.filters, period: request.period, basis: request.basis, currency: request.currency, consolidation: request.consolidation ?? null, forecast: request.forecast ?? null, columns: requestedColumns, sort: request.sort ?? [] });
}

export class ReportingService {
  readonly registry: ReportingRegistry;
  readonly store: ReportingStore;
  private readonly now: () => Date;
  private readonly runTtlMs: number;
  private readonly exportTtlMs: number;
  private readonly maxRows: number;
  private readonly authorize?: ReportingAccess["authorize"];

  constructor(options: ReportingServiceOptions = {}) {
    this.registry = options.registry ?? createReportingRegistry();
    this.store = options.store ?? createInMemoryReportingStore();
    this.now = options.now ?? (() => new Date());
    this.runTtlMs = options.runTtlMs ?? 7 * 24 * 60 * 60 * 1_000;
    this.exportTtlMs = options.exportTtlMs ?? 24 * 60 * 60 * 1_000;
    this.maxRows = options.maxRows ?? 100_000;
    this.authorize = options.authorize;
  }

  catalog(_access?: ReportingAccess): readonly ReportEntry[] { return this.registry.listEntries(); }

  private async freshAccess(access: ReportingAccess): Promise<ReportingAccess> {
    if (!access.refreshPrincipal) return access;
    return { ...access, principal: await access.refreshPrincipal() };
  }

  private permissionFingerprint(principal: AuthenticatedPrincipal): string { return sha256({ organizationId: principal.organizationId, actorId: principal.actorId, role: principal.role, scopes: principal.authorizedScopes, capabilities: principal.capabilities }); }

  private assertCompanyRead(principal: AuthenticatedPrincipal, scope: ReportingPrincipalScope): void {
    try {
      authorizeCompanyRead(principal, scope, REPORT_READ_ROLES);
    } catch (error) {
      if (error instanceof ReportingError) throw error;
      throw new ReportingError("report_forbidden", error instanceof Error ? error.message : "The requested company scope is not authorized", 403);
    }
  }

  private async authorizeRequest(access: ReportingAccess, request: ReportRunRequest, definition: ReportDefinition): Promise<void> {
    if (access.principal.organizationId !== request.scope.organizationId) throw new ReportingError("report_forbidden", "Report organization is outside the authenticated scope");
    const customAuthorize = access.authorize ?? this.authorize;
    if (customAuthorize) {
      try { await customAuthorize(access.principal, scopeForAuth(request.scope), definition); }
      catch (error) {
        if (error instanceof ReportingError) throw error;
        throw new ReportingError("report_forbidden", error instanceof Error ? error.message : "The requested report scope is not authorized", 403);
      }
      return;
    }
    if (!REPORT_READ_ROLES.includes(access.principal.role as (typeof REPORT_READ_ROLES)[number])) throw new ReportingError("report_forbidden", "The authenticated role cannot read reports");
    const entityIds = request.scope.legalEntityIds;
    const requestedProperties = Array.from(new Set([...request.scope.propertyIds, ...filterPropertyIds(request)]));
    const filterProperties = filterPropertyIds(request);
    if (request.scope.propertyIds.length && filterProperties.some(propertyId => !request.scope.propertyIds.includes(propertyId as typeof request.scope.propertyIds[number]))) {
      throw new ReportingError("report_forbidden", "A property filter is outside the selected report scope", 403);
    }
    if (entityIds.length) {
      if (requestedProperties.length) {
        if (!access.resolvePropertyLegalEntity) throw new ReportingError("report_forbidden", "Property-scoped company reports require a verified property-to-entity mapping");
        for (const propertyId of requestedProperties) {
          const mappedEntity = await access.resolvePropertyLegalEntity(propertyId, request.period);
          if (!mappedEntity || !entityIds.includes(mappedEntity as typeof entityIds[number])) throw new ReportingError("report_forbidden", "A requested property is not mapped to one of the selected legal entities", 403, { propertyId });
          this.assertCompanyRead(access.principal, scopeForAuth(request.scope, mappedEntity, propertyId));
        }
      } else {
        for (const legalEntityId of entityIds) this.assertCompanyRead(access.principal, scopeForAuth(request.scope, legalEntityId));
      }
    } else {
      if (requestedProperties.length) {
        if (!access.resolvePropertyLegalEntity) throw new ReportingError("report_forbidden", "Property-scoped company reports require a verified property-to-entity mapping");
        for (const propertyId of requestedProperties) {
          const mappedEntity = await access.resolvePropertyLegalEntity(propertyId, request.period);
          if (!mappedEntity) throw new ReportingError("report_forbidden", "A requested property is not mapped to one legal entity for the selected period", 403, { propertyId });
          this.assertCompanyRead(access.principal, scopeForAuth(request.scope, mappedEntity, propertyId));
        }
      } else {
        this.assertCompanyRead(access.principal, scopeForAuth(request.scope));
      }
    }
  }

  private normalizeRequest(input: ReportRunRequest): { request: ReportRunRequest; definition: ReportDefinition } {
    const request = reportRunRequestSchema.parse(input);
    const definition = this.registry.getDefinition(request.reportId, request.definitionVersion);
    filterPeriodConsistency(request, definition);
    const filters = canonicalFilters(definition, request.filters);
    const basis = request.basis;
    const filterBasis = stringValue(filters.basis);
    if (filterBasis && filterBasis !== basis) throw new ReportingError("report_validation", "Report basis filter and request basis differ", 400, { filterBasis, basis });
    const filterCurrency = stringValue(filters.currency);
    if (filterCurrency && filterCurrency !== request.currency) throw new ReportingError("report_validation", "Report currency filter and request currency differ", 400, { filterCurrency, currency: request.currency });
    return { request: { ...request, filters, scope: reportScopeSchema.parse(request.scope), sort: request.sort ?? defaultSort(definition), requestId: request.requestId ?? `report-${randomUUID()}` }, definition };
  }

  async run(access: ReportingAccess, input: ReportRunRequest): Promise<ReportRunResponse> {
    access = await this.freshAccess(access);
    const { request, definition } = this.normalizeRequest(input);
    await this.authorizeRequest(access, request, definition);
    if (this.store.readRunByRequest && request.requestId) {
      const existing = await this.store.readRunByRequest(request.scope.organizationId, actorOf(access.principal), request.requestId);
      if (existing) {
        if (existing.permissionFingerprint !== this.permissionFingerprint(access.principal)) throw new ReportingError("report_forbidden", "Report run permissions have changed", 403, { requestId: request.requestId });
        if (!sameRunRequest(existing, request)) throw new ReportingError("report_conflict", "Request ID is already bound to a different report request", 409, { requestId: request.requestId });
        return { run: existing, page: readPage(existing, 0, 100) };
      }
    }
    const engine = this.registry.getEngine(request.reportId, request.definitionVersion);
    const runId = newReportingId();
    const snapshotId = newReportingId();
    const now = isoNow(this.now);
    const context: ReportingEngineContext = { runId, snapshotId, request, definition, now: now as ReportingEngineContext["now"] };
    let result: ReportingEngineResult;
    try { result = await engine.run(context); } catch (error) {
      if (error instanceof ReportingError) throw error;
      throw new ReportingError("report_unavailable", "The report source could not produce a verified result", 409, { reportId: definition.id });
    }
    const parsedResult = reportResultSchema.parse({ columns: result.columns, rows: result.rows, totals: result.totals ?? [], coverage: result.coverage, missingData: result.missingData ?? [], drilldowns: result.drilldowns ?? [] });
    if (parsedResult.rows.length > this.maxRows) throw new ReportingError("report_unavailable", "The report exceeds the bounded result size; use a narrower scope or period", 409, { maxRows: this.maxRows });
    assertUnique(parsedResult.rows);
    if (request.columns?.length) {
      const availableColumns = new Set(parsedResult.columns.map(column => column.id));
      const unknownColumns = request.columns.filter(column => !availableColumns.has(column));
      if (unknownColumns.length) throw new ReportingError("report_validation", "Report columns contain unsupported fields", 400, { reportId: definition.id, columns: unknownColumns });
    }
    const availableSortFields = new Set(["rowId", ...parsedResult.columns.map(column => column.id)]);
    const unknownSortFields = sortFields(request.sort).filter(field => !availableSortFields.has(field));
    if (unknownSortFields.length) throw new ReportingError("report_validation", "Report sort contains unsupported fields", 400, { reportId: definition.id, fields: unknownSortFields });
    const selectedColumns = request.columns?.length ? parsedResult.columns.filter(column => request.columns!.includes(column.id)) : parsedResult.columns;
    const sort = request.sort ?? [];
    const sortedRows = sortRows(parsedResult.rows, sort);
    const run = reportRunRecordSchema.parse({ id: runId, snapshotId, organizationId: request.scope.organizationId, actorId: actorOf(access.principal), permissionFingerprint: this.permissionFingerprint(access.principal), serviceVersion: "reporting.v1", reportId: definition.id, definitionVersion: definition.version, state: "ready", requestId: request.requestId!, scope: request.scope, filters: request.filters, period: request.period, basis: request.basis, currency: request.currency, consolidation: request.consolidation ?? null, forecast: request.forecast ?? null, columns: [...selectedColumns], sort: [...sort], rows: sortedRows, totals: parsedResult.totals, coverage: parsedResult.coverage, missingData: parsedResult.missingData, drilldowns: parsedResult.drilldowns ?? [], generatedAt: now, expiresAt: new Date(this.now().getTime() + this.runTtlMs).toISOString() });
    await this.store.saveRun(run);
    return { run, page: readPage(run, 0, 100) };
  }

  private async readAuthorizedRun(access: ReportingAccess, runId: string): Promise<ReportRunRecord> {
    const run = await this.store.readRun(access.principal.organizationId, runId);
    if (!run) throw new ReportingError("report_not_found", "Report run was not found", 404, { runId });
    const now = isoNow(this.now);
    if (isExpired(run.expiresAt, now)) throw new ReportingError("report_expired", "Report run has expired", 410, { runId });
    if (run.permissionFingerprint !== this.permissionFingerprint(access.principal)) throw new ReportingError("report_forbidden", "Report run permissions have changed", 403, { runId });
    const definition = this.registry.getDefinition(run.reportId, run.definitionVersion);
    const request = reportRunRequestSchema.parse({ reportId: run.reportId, definitionVersion: run.definitionVersion, scope: run.scope, filters: run.filters, period: run.period, basis: run.basis, currency: run.currency, consolidation: run.consolidation, forecast: run.forecast, columns: run.columns.map(column => column.id), sort: run.sort, requestId: run.requestId });
    await this.authorizeRequest(access, request, definition);
    return run;
  }

  private async readAuthorizedRunMetadata(access: ReportingAccess, runId: string): Promise<ReportRunRecord> {
    const run = await (this.store.readRunMetadata ? this.store.readRunMetadata(access.principal.organizationId, runId) : this.store.readRun(access.principal.organizationId, runId));
    if (!run) throw new ReportingError("report_not_found", "Report run was not found", 404, { runId });
    const now = isoNow(this.now);
    if (isExpired(run.expiresAt, now)) throw new ReportingError("report_expired", "Report run has expired", 410, { runId });
    if (run.permissionFingerprint !== this.permissionFingerprint(access.principal)) throw new ReportingError("report_forbidden", "Report run permissions have changed", 403, { runId });
    const definition = this.registry.getDefinition(run.reportId, run.definitionVersion);
    const request = reportRunRequestSchema.parse({ reportId: run.reportId, definitionVersion: run.definitionVersion, scope: run.scope, filters: run.filters, period: run.period, basis: run.basis, currency: run.currency, consolidation: run.consolidation, forecast: run.forecast, columns: run.columns.map(column => column.id), sort: run.sort, requestId: run.requestId });
    await this.authorizeRequest(access, request, definition);
    return run;
  }

  async page(access: ReportingAccess, input: unknown): Promise<ReportPage> {
    access = await this.freshAccess(access);
    const request = reportPageRequestSchema.parse(input);
    const run = await this.readAuthorizedRunMetadata(access, request.runId);
    const cursor = decodeCursor<{ runId: string; offset: number; sort: string }>(request.cursor);
    const offset = cursor?.runId === run.id && cursor.sort === sha256(run.sort) && Number.isInteger(cursor.offset) && cursor.offset >= 0 ? cursor.offset : request.cursor ? (() => { throw new ReportingError("report_validation", "Report page cursor is invalid", 400); })() : 0;
    if (this.store.readRunRows) {
      const fragment = await this.store.readRunRows(access.principal.organizationId, run.id, offset, request.limit);
      return readPage(run, offset, request.limit, fragment.rows as ReportRunRecord["rows"], fragment.totalRows);
    }
    const fullRun = run.rows.length ? run : await this.readAuthorizedRun(access, request.runId);
    return readPage(fullRun, offset, request.limit, fullRun.rows.slice(offset, offset + request.limit), fullRun.rows.length);
  }

  async drilldown(access: ReportingAccess, input: ReportDrilldownRequest): Promise<ReportDrilldown> {
    access = await this.freshAccess(access);
    const request = reportDrilldownRequestSchema.parse(input);
    const run = await this.readAuthorizedRunMetadata(access, request.runId);
    const stored = this.store.readRunDrilldown
      ? await this.store.readRunDrilldown(access.principal.organizationId, run.id, request.rowId)
      : run.drilldowns.find(item => item.rowId === request.rowId);
    if (!stored) return reportDrilldownSchema.parse({ rowId: request.rowId, items: [], nextCursor: null, coverage: run.coverage, missingData: [{ code: "drilldown_unavailable", state: "unavailable", message: "This report engine did not provide a durable drilldown for the selected row." }] });
    const cursor = decodeCursor<{ runId: string; rowId: string; offset: number }>(request.cursor);
    const offset = cursor?.runId === run.id && cursor.rowId === request.rowId && Number.isInteger(cursor.offset) ? cursor.offset : 0;
    const items = stored.items.slice(offset, offset + request.limit);
    const nextCursor = offset + items.length < stored.items.length ? encodeCursor({ runId: run.id, rowId: request.rowId, offset: offset + items.length }) : null;
    return reportDrilldownSchema.parse({ ...stored, items, nextCursor });
  }

  async createExport(access: ReportingAccess, input: ReportExportRequest): Promise<ReportExportJob> {
    access = await this.freshAccess(access);
    const request = reportExportRequestSchema.parse(input);
    const run = await this.readAuthorizedRun(access, request.runId);
    const definition = this.registry.getDefinition(run.reportId, run.definitionVersion);
    if (!definition.supportedExports.includes(request.format)) throw new ReportingError("report_export", `Report ${definition.title} does not support ${request.format} exports`, 400);
    const content = request.format === "csv" ? exportReportCsv(run) : request.format === "json" ? exportReportJson(run) : exportReportHtml(run);
    const extension = request.format === "html" ? "html" : request.format;
    const fileName = request.fileName ?? `${run.reportId}-${run.generatedAt.slice(0, 10)}.${extension}`;
    const now = isoNow(this.now);
    const job = reportExportJobSchema.parse({ id: newReportingId(), runId: run.id, organizationId: run.organizationId, actorId: access.principal.actorId, permissionFingerprint: this.permissionFingerprint(access.principal), state: "ready", format: request.format, fileName, contentType: request.format === "csv" ? "text/csv; charset=utf-8" : request.format === "json" ? "application/json; charset=utf-8" : "text/html; charset=utf-8", content, errorCode: null, createdAt: now, readyAt: now, expiresAt: new Date(this.now().getTime() + this.exportTtlMs).toISOString() });
    await this.store.saveExport(job);
    return job;
  }

  async getExport(access: ReportingAccess, jobId: string): Promise<ReportExportJob> {
    access = await this.freshAccess(access);
    const job = await this.store.readExport(access.principal.organizationId, jobId);
    if (!job) throw new ReportingError("report_not_found", "Report export was not found", 404, { jobId });
    if (job.permissionFingerprint !== this.permissionFingerprint(access.principal)) throw new ReportingError("report_forbidden", "Report export permissions have changed", 403, { jobId });
    if (isExpired(job.expiresAt, isoNow(this.now))) throw new ReportingError("report_expired", "Report export has expired", 410, { jobId });
    return job;
  }

  private presetRevision(input: ReportPresetInput, definition: ReportDefinition, revision: number, actorId: string, createdAt: string): ReportPresetRevision {
    const request = this.normalizeRequest({ reportId: definition.id, definitionVersion: input.definitionVersion ?? definition.version, scope: input.scope, filters: input.filters, period: input.period, basis: input.basis, currency: input.currency, consolidation: input.consolidation ?? null, forecast: input.forecast ?? null, columns: input.columns ? [...input.columns] : undefined, sort: input.sort ? [...input.sort] : undefined });
    return reportPresetRevisionSchema.parse({ revision, reportId: request.request.reportId, definitionVersion: request.request.definitionVersion, scope: request.request.scope, filters: request.request.filters, period: request.request.period, basis: request.request.basis, currency: request.request.currency, consolidation: request.request.consolidation ?? null, forecast: request.request.forecast ?? null, columns: request.request.columns ?? [], sort: request.request.sort ?? [], createdBy: actorId, createdAt });
  }

  async savePreset(access: ReportingAccess, input: ReportPresetInput): Promise<ReportPreset> {
    access = await this.freshAccess(access);
    const id = input.id ?? newReportingId();
    const current = input.id ? await this.store.readPreset(access.principal.organizationId, id) : null;
    if (current && current.ownerActorId !== access.principal.actorId) throw new ReportingError("report_forbidden", "Preset belongs to another actor");
    if (current && input.expectedRevision === undefined) throw new ReportingError("report_conflict", "Preset updates require the current revision", 409, { actualRevision: current.revision });
    if (current && input.expectedRevision !== undefined && current.revision !== input.expectedRevision) throw new ReportingError("report_conflict", "Preset changed; reload before saving", 409, { expectedRevision: input.expectedRevision, actualRevision: current.revision });
    const revision = (current?.revision ?? 0) + 1;
    const now = isoNow(this.now);
    const definition = this.registry.getDefinition(input.reportId, input.definitionVersion ?? "1");
    const currentRevision = this.presetRevision(input, definition, revision, access.principal.actorId, now);
    await this.authorizeRequest(access, this.normalizeRequest({ reportId: definition.id, definitionVersion: definition.version, scope: input.scope, filters: input.filters, period: input.period, basis: input.basis, currency: input.currency, consolidation: input.consolidation ?? null, forecast: input.forecast ?? null, columns: input.columns ? [...input.columns] : undefined, sort: input.sort ? [...input.sort] : undefined }).request, definition);
    const preset = reportPresetSchema.parse({ id, organizationId: access.principal.organizationId, ownerActorId: current?.ownerActorId ?? access.principal.actorId, visibility: input.visibility ?? current?.visibility ?? "private", name: input.name, description: input.description ?? current?.description ?? null, reportId: definition.id, definitionVersion: definition.version, revision, current: currentRevision, createdAt: current?.createdAt ?? now, updatedAt: now });
    try { await this.store.savePreset(preset); } catch (error) { if (error instanceof Error && error.message.includes("revision_conflict")) throw new ReportingError("report_conflict", "Preset changed; reload before saving", 409); throw error; }
    return preset;
  }

  private storedPresetRequest(preset: ReportPreset): { readonly request: ReportRunRequest; readonly definition: ReportDefinition } {
    const current = reportPresetRevisionSchema.parse(preset.current);
    return this.normalizeRequest({ reportId: current.reportId, definitionVersion: current.definitionVersion, scope: current.scope, filters: current.filters, period: current.period, basis: current.basis, currency: current.currency, consolidation: current.consolidation, forecast: current.forecast, columns: current.columns, sort: current.sort });
  }

  private async authorizeStoredPreset(access: ReportingAccess, preset: ReportPreset): Promise<void> {
    const { request, definition } = this.storedPresetRequest(preset);
    await this.authorizeRequest(access, request, definition);
  }

  private storedPackageItemRequest(item: ReportPackageItem): { readonly request: ReportRunRequest; readonly definition: ReportDefinition } {
    return this.normalizeRequest({ reportId: item.reportId, definitionVersion: item.definitionVersion, scope: item.scope, filters: item.filters, period: item.period, basis: item.basis, currency: item.currency, consolidation: item.consolidation, forecast: item.forecast, columns: item.columns, sort: item.sort });
  }

  private async authorizeStoredPackage(access: ReportingAccess, pkg: ReportPackage): Promise<void> {
    for (const item of pkg.items) {
      const { request, definition } = this.storedPackageItemRequest(item);
      await this.authorizeRequest(access, request, definition);
    }
  }

  private async filterAuthorizedPresets(access: ReportingAccess, presets: readonly ReportPreset[]): Promise<readonly ReportPreset[]> {
    const authorized = await Promise.all(presets.map(async (preset) => {
      try {
        await this.authorizeStoredPreset(access, preset);
        return preset;
      } catch (error) {
        // A list must not disclose a shared preset whose contained scope was
        // revoked. Stale definitions and malformed revisions are likewise
        // omitted until an owner repairs the preset.
        if (error instanceof ReportingError && ["report_forbidden", "report_unavailable", "report_validation"].includes(error.code)) return null;
        throw error;
      }
    }));
    return authorized.filter((preset): preset is ReportPreset => preset !== null);
  }

  private async filterAuthorizedPackages(access: ReportingAccess, packages: readonly ReportPackage[]): Promise<readonly ReportPackage[]> {
    const authorized = await Promise.all(packages.map(async (pkg) => {
      try {
        await this.authorizeStoredPackage(access, pkg);
        return pkg;
      } catch (error) {
        if (error instanceof ReportingError && ["report_forbidden", "report_unavailable", "report_validation"].includes(error.code)) return null;
        throw error;
      }
    }));
    return authorized.filter((pkg): pkg is ReportPackage => pkg !== null);
  }

  async listPresets(access: ReportingAccess): Promise<readonly ReportPreset[]> {
    access = await this.freshAccess(access);
    const presets = await this.store.listPresets(access.principal.organizationId, access.principal.actorId);
    return this.filterAuthorizedPresets(access, presets);
  }

  async getPreset(access: ReportingAccess, id: string): Promise<ReportPreset> {
    access = await this.freshAccess(access);
    const preset = await this.store.readPreset(access.principal.organizationId, id);
    if (!preset) throw new ReportingError("report_not_found", "Report preset was not found", 404, { id });
    if (preset.visibility === "private" && preset.ownerActorId !== access.principal.actorId) throw new ReportingError("report_forbidden", "Private preset belongs to another actor");
    await this.authorizeStoredPreset(access, preset);
    return preset;
  }

  async savePackage(access: ReportingAccess, input: ReportPackageInput): Promise<ReportPackage> {
    access = await this.freshAccess(access);
    const id = input.id ?? newReportingId();
    const current = input.id ? await this.store.readPackage(access.principal.organizationId, id) : null;
    if (current && current.ownerActorId !== access.principal.actorId) throw new ReportingError("report_forbidden", "Package belongs to another actor");
    if (current && input.expectedRevision === undefined) throw new ReportingError("report_conflict", "Package updates require the current revision", 409, { actualRevision: current.revision });
    if (current && input.expectedRevision !== undefined && current.revision !== input.expectedRevision) throw new ReportingError("report_conflict", "Package changed; reload before saving", 409);
    const items: ReportPackageItem[] = await Promise.all(input.items.map(async (item, index) => {
      const definition = this.registry.getDefinition(item.reportId, item.definitionVersion);
      const normalized = this.normalizeRequest({ reportId: definition.id, definitionVersion: definition.version, scope: item.scope, filters: item.filters, period: item.period, basis: item.basis, currency: item.currency, consolidation: item.consolidation, forecast: item.forecast, columns: item.columns, sort: item.sort });
      await this.authorizeRequest(access, normalized.request, definition);
      return reportPackageItemSchema.parse({ id: item.id ?? `${definition.id}-${index + 1}`, title: item.title ?? definition.title, reportId: definition.id, definitionVersion: definition.version, scope: normalized.request.scope, filters: normalized.request.filters, period: normalized.request.period, basis: normalized.request.basis, currency: normalized.request.currency, consolidation: normalized.request.consolidation ?? null, forecast: normalized.request.forecast ?? null, columns: normalized.request.columns ?? [], sort: normalized.request.sort ?? [] });
    }));
    if (new Set(items.map(item => item.id)).size !== items.length) throw new ReportingError("report_validation", "Package item IDs must be unique");
    const now = isoNow(this.now);
    const pkg = reportPackageSchema.parse({ id, organizationId: access.principal.organizationId, ownerActorId: current?.ownerActorId ?? access.principal.actorId, visibility: input.visibility ?? current?.visibility ?? "private", name: input.name, description: input.description ?? current?.description ?? null, revision: (current?.revision ?? 0) + 1, items, createdAt: current?.createdAt ?? now, updatedAt: now });
    try { await this.store.savePackage(pkg); } catch (error) { if (error instanceof Error && error.message.includes("revision_conflict")) throw new ReportingError("report_conflict", "Package changed; reload before saving", 409); throw error; }
    return pkg;
  }

  async listPackages(access: ReportingAccess): Promise<readonly ReportPackage[]> {
    access = await this.freshAccess(access);
    const packages = await this.store.listPackages(access.principal.organizationId, access.principal.actorId);
    return this.filterAuthorizedPackages(access, packages);
  }

  async getPackage(access: ReportingAccess, id: string): Promise<ReportPackage> {
    access = await this.freshAccess(access);
    const pkg = await this.store.readPackage(access.principal.organizationId, id);
    if (!pkg) throw new ReportingError("report_not_found", "Report package was not found", 404, { id });
    if (pkg.visibility === "private" && pkg.ownerActorId !== access.principal.actorId) throw new ReportingError("report_forbidden", "Private package belongs to another actor");
    await this.authorizeStoredPackage(access, pkg);
    return pkg;
  }

  async runPackage(access: ReportingAccess, packageId: string): Promise<ReportPackageRun> {
    access = await this.freshAccess(access);
    const pkg = await this.getPackage(access, packageId);
    const results: ReportPackageRun["itemRuns"] = [];
    let failed = false;
    for (const item of pkg.items) {
      try {
        const result = await this.run(access, { reportId: item.reportId, definitionVersion: item.definitionVersion, scope: item.scope, filters: item.filters, period: item.period, basis: item.basis, currency: item.currency, consolidation: item.consolidation, forecast: item.forecast, columns: item.columns, sort: item.sort });
        results.push({ itemId: item.id, runId: result.run.id, state: result.run.state, errorCode: null });
      } catch (error) {
        failed = true;
        results.push({ itemId: item.id, runId: null, state: "failed", errorCode: error instanceof ReportingError ? error.code : "report_unavailable" });
      }
    }
    const now = isoNow(this.now);
    const run = reportPackageRunSchema.parse({ id: newReportingId(), packageId: pkg.id, organizationId: pkg.organizationId, actorId: access.principal.actorId, permissionFingerprint: this.permissionFingerprint(access.principal), state: failed ? "failed" : "ready", itemRuns: results, createdAt: now, readyAt: now, expiresAt: new Date(this.now().getTime() + this.runTtlMs).toISOString() });
    await this.store.savePackageRun(run);
    return run;
  }

  async getPackageRun(access: ReportingAccess, id: string): Promise<ReportPackageRun> {
    access = await this.freshAccess(access);
    const run = await this.store.readPackageRun(access.principal.organizationId, id);
    if (!run) throw new ReportingError("report_not_found", "Report package run was not found", 404, { id });
    if (isExpired(run.expiresAt, isoNow(this.now))) throw new ReportingError("report_expired", "Report package run has expired", 410, { id });
    if (run.permissionFingerprint !== this.permissionFingerprint(access.principal)) throw new ReportingError("report_forbidden", "Report package run permissions have changed", 403);
    // Re-read and re-authorize every frozen constituent before exposing the
    // durable package result. A later grant revocation must apply to package
    // reads even when the package run itself was created earlier.
    await this.getPackage(access, run.packageId);
    for (const item of run.itemRuns) if (item.runId) await this.readAuthorizedRunMetadata(access, item.runId);
    return run;
  }
}

export function createReportingServices(options: ReportingServiceOptions = {}): ReportingService { return new ReportingService(options); }

/** Root integrations may expose this narrow request-bound port without
 * coupling company routes or MCP registration to the concrete service. */
export type ReportingPort = Pick<ReportingService, "catalog" | "run" | "page" | "drilldown" | "createExport" | "getExport" | "savePreset" | "listPresets" | "getPreset" | "savePackage" | "listPackages" | "getPackage" | "runPackage" | "getPackageRun">;
