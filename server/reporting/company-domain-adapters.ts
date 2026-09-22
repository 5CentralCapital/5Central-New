import type { AuthenticatedPrincipal } from "../company/authorization";
import { authorizeCompanyRead } from "../company/authorization";
import { legalEntityIdSchema, propertyReferenceIdSchema, type IsoDate } from "../../shared/company";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { PostgresRentOpsRepository } from "../rent-ops/repositories/postgres";
import { RentOpsService } from "../rent-ops/services/service";
import { ProjectReadService } from "../projects/service";
import { InvestorReadService } from "../investors/service";
import type { InvestorDetail } from "../../shared/investors";
import type { TimeReadPort } from "../time/service";
import type { TimeConnectionScope, TimeCoverage } from "../../shared/time";
import type { RentOpsSnapshot } from "../../shared/rent-ops-contracts";
import { companyScopeSchema, isoDateSchema, type CompanyScope } from "../../shared/company";
import type { ReportingEngineContext } from "../../shared/reporting";
import type { ReportingEngine } from "./registry";
import { ReportingError } from "./errors";
import { periodBounds } from "./source-engine-utils";
import { createRentalExtendedReportingEngine, type RentalSnapshotReadPort } from "./rental-expanded-engine";
import { createProjectReportingEngine, type ProjectReportingReadPort } from "./project-engine";
import { createInvestorReportingEngine, type InvestorReportingReadPort } from "./investor-engine";
import { createTaskReportingEngine } from "./task-engine";
import { createTimeReportingEngine, type TimeReportingReadPort } from "./time-engine";
import { createReportingDomainEngines, type ReportingDomainEngineOptions } from "./domain-engines";

export interface CompanyDomainReportingAdapterOptions {
  readonly executor: RentOpsQueryExecutor;
  readonly principal: AuthenticatedPrincipal;
  readonly rentalService?: RentOpsService;
  readonly projectService?: ProjectReadService;
  readonly investorService?: InvestorReadService;
  /** Pass the request-scoped TimeReadPort from createTimeServices. */
  readonly timeRead?: TimeReadPort;
  /** Combined, forecast, and lender ports are intentionally injected because
   * their source mappings/scenario revisions have separate owners. */
  readonly domainPorts?: Omit<ReportingDomainEngineOptions, "rental" | "projects" | "investors" | "tasks" | "time">;
}

function periodAsOf(context: ReportingEngineContext): IsoDate | undefined {
  const value = periodBounds(context).through;
  return value ? isoDateSchema.parse(value) : undefined;
}

function sourceCoverageState(coverages: readonly Pick<TimeCoverage, "status">[]): "unavailable" | "partial" | "complete" {
  if (!coverages.length || coverages.some(item => item.status === "unavailable")) return "unavailable";
  return coverages.some(item => item.status === "partial") ? "partial" : "complete";
}

function scopedSnapshot(snapshot: RentOpsSnapshot, propertyIds: ReadonlySet<string>): RentOpsSnapshot {
  const properties = snapshot.properties.filter(property => propertyIds.has(property.id));
  const units = snapshot.units.filter(unit => propertyIds.has(unit.propertyId));
  const unitIds = new Set(units.map(unit => unit.id));
  const tenancies = snapshot.tenancies.filter(tenancy => propertyIds.has(tenancy.propertyId) && unitIds.has(tenancy.unitId));
  const tenancyIds = new Set(tenancies.map(tenancy => tenancy.id));
  const personIds = new Set(tenancies.map(tenancy => tenancy.primaryPersonId));
  const applications = snapshot.applications.filter(application =>
    (typeof application.propertyId === "string" && propertyIds.has(application.propertyId))
    || (typeof application.unitId === "string" && unitIds.has(application.unitId))
    || (typeof application.convertedTenancyId === "string" && tenancyIds.has(application.convertedTenancyId))
  );
  for (const application of applications) if (application.convertedTenancyId) {
    const tenancy = tenancies.find(item => item.id === application.convertedTenancyId);
    if (tenancy) personIds.add(tenancy.primaryPersonId);
  }
  // A null relationship is unknown, never an organization-wide relationship.
  // Keeping it here would turn an empty or partially mapped scope into a leak
  // of orphaned records from another property.
  const keepProperty = (propertyId: string | null | undefined): boolean => typeof propertyId === "string" && propertyIds.has(propertyId);
  const keepUnit = (unitId: string | null | undefined): boolean => typeof unitId === "string" && unitIds.has(unitId);
  const keepTenancy = (tenancyId: string | null | undefined): boolean => typeof tenancyId === "string" && tenancyIds.has(tenancyId);
  const keepRelationship = (propertyId: string | null | undefined, unitId?: string | null, tenancyId?: string | null): boolean => keepProperty(propertyId) || keepUnit(unitId) || keepTenancy(tenancyId);
  const retainedTransactionIds = new Set(snapshot.ledgerTransactions.filter(item => keepRelationship(item.propertyId, item.unitId, item.tenancyId)).map(item => item.id));
  return {
    ...snapshot,
    properties,
    units,
    tenancies,
    people: snapshot.people.filter(person => personIds.has(person.id)),
    householdMemberships: snapshot.householdMemberships.filter(item => keepTenancy(item.tenancyId) && personIds.has(item.personId)),
    leaseTerms: snapshot.leaseTerms.filter(item => tenancyIds.has(item.tenancyId)),
    recurringSchedules: snapshot.recurringSchedules.filter(item => keepRelationship(item.propertyId, item.unitId, item.tenancyId) && (!item.personId || personIds.has(item.personId))),
    ledgerTransactions: snapshot.ledgerTransactions.filter(item => keepRelationship(item.propertyId, item.unitId, item.tenancyId) && (!item.personId || personIds.has(item.personId))),
    paymentAllocations: snapshot.paymentAllocations.filter(item => (item.sourcePropertyId !== null && item.sourcePropertyId !== undefined && keepProperty(item.sourcePropertyId)) || (item.paymentTransactionId !== null && retainedTransactionIds.has(item.paymentTransactionId)) || (item.chargeTransactionId !== null && retainedTransactionIds.has(item.chargeTransactionId))),
    securityDeposits: snapshot.securityDeposits.filter(item => keepProperty(item.propertyId) && (item.unitId === undefined || keepUnit(item.unitId)) && (item.tenancyId === undefined || keepTenancy(item.tenancyId)) && personIds.has(item.personId)),
    subsidyContracts: snapshot.subsidyContracts.filter(item => propertyIds.has(item.propertyId) && unitIds.has(item.unitId) && tenancyIds.has(item.tenancyId)),
    subsidyTenants: snapshot.subsidyTenants.filter(item => keepRelationship(item.propertyId, undefined, item.tenancyId) || (item.personId !== undefined && item.personId !== null && personIds.has(item.personId))),
    subsidyContractMembers: snapshot.subsidyContractMembers?.filter(item => keepRelationship(item.propertyId, undefined, item.tenancyId) || (item.personId !== undefined && item.personId !== null && personIds.has(item.personId))),
    subsidyPayments: snapshot.subsidyPayments.filter(item => keepRelationship(item.propertyId, item.unitId, item.tenancyId)),
    applications,
    applicationHouseholdMembers: snapshot.applicationHouseholdMembers.filter(item => applications.some(application => application.id === item.applicationId)),
    applicationRequirements: snapshot.applicationRequirements.filter(item => applications.some(application => application.id === item.applicationId)),
    documents: snapshot.documents.filter(item => keepRelationship(item.propertyId, item.unitId, item.tenancyId)),
    activityEvents: snapshot.activityEvents.filter(item => keepRelationship(item.propertyId, item.unitId, item.tenancyId)),
  };
}

const REPORT_READ_ROLES = ["owner", "admin", "finance", "operations_pm", "project_manager", "read_only_reviewer"] as const;

function mergeInvestorDetails(details: readonly InvestorDetail[]): InvestorDetail {
  const first = details[0]!;
  const unique = <T extends { readonly id: unknown }>(items: readonly T[]): T[] => Array.from(new Map(items.map(item => [String(item.id), item])).values());
  return {
    ...first,
    instruments: unique(details.flatMap(item => item.instruments)),
    contracts: unique(details.flatMap(item => item.contracts)),
    contractVersions: unique(details.flatMap(item => item.contractVersions)),
    debt: unique(details.flatMap(item => item.debt)),
    partyMappings: unique(details.flatMap(item => item.partyMappings)),
    remittanceInstructions: unique(details.flatMap(item => item.remittanceInstructions)),
    obligations: unique(details.flatMap(item => item.obligations)),
    payments: unique(details.flatMap(item => item.payments)),
    activity: unique(details.flatMap(item => item.activity)),
  };
}

async function resolveRentalPropertyIds(options: CompanyDomainReportingAdapterOptions, context: ReportingEngineContext): Promise<readonly string[]> {
  const bounds = periodBounds(context);
  if (!bounds.from || !bounds.through) throw new ReportingError("report_validation", "A bounded reporting period is required for rental scope resolution.", 400);
  const requestedProperties = context.request.scope.propertyIds.map(String);
  const result = await options.executor.query<{ property_id: string; legal_entity_id: string; covers_period: boolean }>(
    `SELECT property_id,legal_entity_id,
      effective_from <= $2::date AND (effective_until IS NULL OR effective_until > $3::date) AS covers_period
     FROM company_property_entity_periods
     WHERE organization_id=$1 AND effective_from <= $3::date
       AND (effective_until IS NULL OR effective_until > $2::date)
       AND (cardinality($4::uuid[])=0 OR legal_entity_id=ANY($4::uuid[]))
       AND (cardinality($5::varchar[])=0 OR property_id=ANY($5::varchar[]))`,
    [context.request.scope.organizationId, bounds.from, bounds.through, context.request.scope.legalEntityIds, requestedProperties],
  );
  if (result.rows.some(row => !row.covers_period)) throw new ReportingError("report_unavailable", "A property changed legal entities during the requested rental period.", 409, { dependency: "effective_property_entity_mapping" });
  const propertyIds = Array.from(new Set(result.rows.map(row => row.property_id)));
  for (const row of result.rows) {
    authorizeCompanyRead(options.principal, {
      organizationId: context.request.scope.organizationId,
      legalEntityId: legalEntityIdSchema.parse(row.legal_entity_id),
      propertyId: propertyReferenceIdSchema.parse(row.property_id),
    }, REPORT_READ_ROLES);
  }
  if (requestedProperties.some(propertyId => !propertyIds.includes(propertyId))) throw new ReportingError("report_forbidden", "A selected property is outside the company reporting period.", 403);
  return propertyIds;
}

/** Resolve every downstream company read to a dated entity/property pair. A
 * missing mapping produces an empty scope and never means "read everything". */
async function resolveDatedScopes(options: CompanyDomainReportingAdapterOptions, context: ReportingEngineContext): Promise<readonly CompanyScope[]> {
  const bounds = periodBounds(context);
  if (!bounds.from || !bounds.through) throw new ReportingError("report_validation", "A bounded reporting period is required for company source resolution.", 400);
  const requestedProperties = context.request.scope.propertyIds.map(String);
  const requestedEntities = context.request.scope.legalEntityIds.map(String);
  if (!requestedProperties.length && requestedEntities.length) {
    return requestedEntities.map(legalEntityId => {
      const parsedEntity = legalEntityIdSchema.parse(legalEntityId);
      authorizeCompanyRead(options.principal, { organizationId: context.request.scope.organizationId, legalEntityId: parsedEntity }, REPORT_READ_ROLES);
      return companyScopeSchema.parse({ organizationId: context.request.scope.organizationId, legalEntityId: parsedEntity });
    });
  }
  if (!requestedProperties.length && !requestedEntities.length) {
    authorizeCompanyRead(options.principal, { organizationId: context.request.scope.organizationId }, REPORT_READ_ROLES);
    return [companyScopeSchema.parse({ organizationId: context.request.scope.organizationId })];
  }
  const result = await options.executor.query<{ property_id: string; legal_entity_id: string; covers_period: boolean }>(
    `SELECT property_id,legal_entity_id,
      effective_from <= $2::date AND (effective_until IS NULL OR effective_until > $3::date) AS covers_period
     FROM company_property_entity_periods
     WHERE organization_id=$1 AND effective_from <= $3::date
       AND (effective_until IS NULL OR effective_until > $2::date)
       AND (cardinality($4::uuid[])=0 OR legal_entity_id=ANY($4::uuid[]))
       AND (cardinality($5::varchar[])=0 OR property_id=ANY($5::varchar[]))`,
    [context.request.scope.organizationId, bounds.from, bounds.through, context.request.scope.legalEntityIds, context.request.scope.propertyIds],
  );
  if (result.rows.some(row => !row.covers_period)) throw new ReportingError("report_unavailable", "A selected company property changed legal entities during the requested period.", 409, { dependency: "effective_property_entity_mapping" });
  const pairs = new Map<string, CompanyScope>();
  for (const row of result.rows) {
    const legalEntityId = legalEntityIdSchema.parse(row.legal_entity_id);
    const propertyId = propertyReferenceIdSchema.parse(row.property_id);
    authorizeCompanyRead(options.principal, { organizationId: context.request.scope.organizationId, legalEntityId, propertyId }, REPORT_READ_ROLES);
    pairs.set(`${legalEntityId}:${propertyId}`, companyScopeSchema.parse({ organizationId: context.request.scope.organizationId, legalEntityId, propertyId }));
  }
  if (context.request.scope.propertyIds.some(propertyId => !Array.from(pairs.values()).some(scope => scope.propertyId === propertyId))) {
    throw new ReportingError("report_forbidden", "A selected property is outside the company reporting period.", 403);
  }
  if (pairs.size) return Array.from(pairs.values());
  // A property-specific scope with no dated mapping remains empty. It never
  // falls back to the organization or entity scope.
  return [];
}

function createRentalPort(options: CompanyDomainReportingAdapterOptions): RentalSnapshotReadPort {
  const service = options.rentalService ?? new RentOpsService(new PostgresRentOpsRepository(options.executor, true));
  return {
    async readSnapshot({ context }): Promise<{ snapshot: RentOpsSnapshot; coverage: { state: "partial"; evidence: "reproducible_snapshot"; watermark: null; reason: string } }> {
      const propertyIds = await resolveRentalPropertyIds(options, context);
      const snapshot = await service.reportSnapshot();
      const filtered = scopedSnapshot(snapshot, new Set(propertyIds));
      return { snapshot: filtered, coverage: { state: "partial", evidence: "reproducible_snapshot", watermark: null, reason: "R-ops report snapshot is transaction-bound but does not expose an independent historical watermark." } };
    },
  };
}

function createProjectPort(options: CompanyDomainReportingAdapterOptions): ProjectReportingReadPort {
  const service = options.projectService ?? new ProjectReadService(options.executor);
  return {
    async read({ context }) {
      const summaries = new Map<string, { id: string; legalEntityId: string; propertyId: string }>();
      const scopes = await resolveDatedScopes(options, context);
      for (const scope of scopes) {
        let cursor: string | undefined;
        do {
          const page = await service.list(options.principal, { scope, asOf: periodAsOf(context), limit: 100, ...(cursor ? { cursor } : {}) });
          for (const item of page.items) summaries.set(String(item.id), { id: String(item.id), legalEntityId: String(item.legalEntityId), propertyId: String(item.propertyId) });
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
      }
      const details = await Promise.all(Array.from(summaries.values()).map(item => service.get(options.principal, { scope: companyScopeSchema.parse({ organizationId: context.request.scope.organizationId, legalEntityId: legalEntityIdSchema.parse(item.legalEntityId), propertyId: propertyReferenceIdSchema.parse(item.propertyId) }), projectId: item.id, asOf: periodAsOf(context) })));
      return { projects: details, coverage: { state: "partial" as const, evidence: "reproducible_snapshot" as const, watermark: null, reason: "Project records are transaction-bound; posted actual coverage is retained per project." } };
    },
  };
}

function createInvestorPort(options: CompanyDomainReportingAdapterOptions): InvestorReportingReadPort {
  const service = options.investorService ?? new InvestorReadService(options.executor);
  return {
    async read({ context }) {
      const requestedAccounts = new Set<string>([...context.request.scope.investorIds.map(String), ...context.request.scope.ownerIds.map(String)]);
      const accountIds = new Set<string>();
      const scopes = await resolveDatedScopes(options, context);
      const accountScopes = new Map<string, CompanyScope[]>();
      for (const scope of scopes) {
        let cursor: string | undefined;
        do {
          const page = await service.list(options.principal, { scope, limit: 100, ...(cursor ? { cursor } : {}) });
          for (const item of page.items) if (!requestedAccounts.size || requestedAccounts.has(String(item.id))) { const id = String(item.id); accountIds.add(id); const scoped = accountScopes.get(id) ?? []; scoped.push(scope); accountScopes.set(id, scoped); }
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
      }
      const details = await Promise.all(Array.from(accountIds).map(async accountId => {
        const scopesForAccount = accountScopes.get(accountId) ?? [];
        const scopedDetails = await Promise.all(scopesForAccount.map(scope => service.get(options.principal, { scope, accountId })));
        return mergeInvestorDetails(scopedDetails);
      }));
      return { accounts: details, coverage: { state: "partial" as const, evidence: "reproducible_snapshot" as const, watermark: null, reason: "Investor obligations and payment source validity are read from the transaction-bound company ledger." } };
    },
  };
}

function createTimePort(options: CompanyDomainReportingAdapterOptions): TimeReportingReadPort | undefined {
  const read = options.timeRead;
  if (!read) return undefined;
  return {
    async read({ context }) {
      const entries: import("../../shared/time").TimeEntry[] = [];
      const coverages: TimeCoverage[] = [];
      const scopes = await resolveDatedScopes(options, context);
      const entities = Array.from(new Set(scopes.map(scope => scope.legalEntityId).filter((value): value is NonNullable<typeof value> => Boolean(value))));
      for (const legalEntityId of entities) {
        const connections = await read.listConnections(options.principal, { organizationId: context.request.scope.organizationId, legalEntityId });
        for (const connection of connections.filter(item => item.status === "active")) {
          const scope = connection.scope as TimeConnectionScope;
          for (const companyScope of scopes.filter(item => item.legalEntityId === scope.legalEntityId)) {
            let cursor: string | undefined;
            do {
              const bounds = periodBounds(context);
              const page = await read.listEntries(options.principal, { scope: { organizationId: companyScope.organizationId, legalEntityId: companyScope.legalEntityId!, ...(companyScope.propertyId ? { propertyId: companyScope.propertyId } : {}) }, environment: scope.environment, providerCompanyId: scope.providerCompanyId, from: bounds.from ? isoDateSchema.parse(bounds.from) : undefined, through: bounds.through ? isoDateSchema.parse(bounds.through) : undefined, limit: 500, ...(cursor ? { cursor } : {}) });
              entries.push(...page.items); coverages.push(...page.coverage); cursor = page.nextCursor ?? undefined;
            } while (cursor);
          }
        }
      }
      const allCoverage: Pick<TimeCoverage, "status" | "watermark">[] = coverages.length ? coverages : [{ status: "unavailable", watermark: null }];
      return { entries, coverage: { state: sourceCoverageState(allCoverage), evidence: "live_provider_readback" as const, watermark: allCoverage.map(item => item.watermark).filter(Boolean).sort().at(-1) ?? null, reason: allCoverage.some(item => item.status !== "complete") ? "At least one QuickBooks Time stream is partial or unavailable." : null } };
    },
  };
}

export function createCompanyDomainReportingEngines(options: CompanyDomainReportingAdapterOptions): readonly ReportingEngine[] {
  const projects = options.projectService || options.executor ? createProjectPort(options) : undefined;
  const investors = options.investorService || options.executor ? createInvestorPort(options) : undefined;
  const time = createTimePort(options);
  const domain: ReportingDomainEngineOptions = {
    ...options.domainPorts,
    rental: createRentalPort(options),
    projects,
    investors,
    tasks: projects,
    time,
  };
  return createReportingDomainEngines(domain);
}
