import type { AuthenticatedPrincipal } from "../company/authorization";
import { legalEntityIdSchema, propertyReferenceIdSchema, type IsoDate } from "../../shared/company";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { PostgresRentOpsRepository } from "../rent-ops/repositories/postgres";
import { RentOpsService } from "../rent-ops/services/service";
import { ProjectReadService } from "../projects/service";
import { ProjectExecutionStore } from "../projects/execution-store";
import { InvestorReadService } from "../investors/service";
import type { InvestorDetail } from "../../shared/investors";
import type { TimeReadPort } from "../time/service";
import type { TimeConnectionScope, TimeCoverage, TimeEntry, TimeJobcode, TimeJobcodeMapping, TimeUser } from "../../shared/time";
import type { RentOpsSnapshot } from "../../shared/rent-ops-contracts";
import type { WorkOrderSummary } from "../../shared/work-orders";
import { WorkOrderReadService } from "../work-orders/service";
import { companyScopeSchema, isoDateSchema, type CompanyScope } from "../../shared/company";
import type { ReportingEngineContext } from "../../shared/reporting";
import type { ReportingEngine } from "./registry";
import { ReportingError } from "./errors";
import { periodBounds } from "./source-engine-utils";
import type { RentalSnapshotReadPort } from "./rental-expanded-engine";
import type { ProjectReportingReadPort, ProjectReportingReadResult } from "./project-engine";
import type { InvestorReportingReadPort } from "./investor-engine";
import type { TimeReportingReadPort } from "./time-engine";
import type { WorkOrderReportingReadPort } from "./work-order-engine";
import { createReportingDomainEngines, type ReportingDomainEngineOptions } from "./domain-engines";
import { resolveDatedScopes, resolveRentalPropertyIds } from "./ports/scope";
import { createPostgresPmSettlementReadPort } from "./ports/pm-settlements";
import { createPropertyStatementReadPort } from "./ports/property-statement";
import { createFrozenRunLenderPackageReadPort } from "./ports/lender-package";

export interface CompanyDomainReportingAdapterOptions {
  readonly executor: RentOpsQueryExecutor;
  readonly principal: AuthenticatedPrincipal;
  readonly rentalService?: Pick<RentOpsService, "reportSnapshot">;
  readonly projectService?: ProjectReadService;
  readonly investorService?: InvestorReadService;
  /** Pass the request-scoped TimeReadPort from createTimeServices. */
  readonly timeRead?: TimeReadPort;
  readonly workOrderService?: Pick<WorkOrderReadService, "list">;
  /** Combined-financial and forecast ports have separate owners and are injected. */
  readonly domainPorts?: Pick<ReportingDomainEngineOptions, "combinedFinancial" | "forecast" | "lenderPackage" | "settlements" | "propertyStatement">;
}

/** Bounded company reads for one report run. */
const MAX_COMPANY_RECORDS = 20_000;

function periodAsOf(context: ReportingEngineContext): IsoDate | undefined {
  const value = periodBounds(context).through;
  return value ? isoDateSchema.parse(value) : undefined;
}

function sourceCoverageState(coverages: readonly Pick<TimeCoverage, "status">[]): "unavailable" | "partial" | "complete" {
  if (!coverages.length || coverages.some(item => item.status === "unavailable")) return "unavailable";
  return coverages.some(item => item.status === "partial") ? "partial" : "complete";
}

export function scopedSnapshot(snapshot: RentOpsSnapshot, propertyIds: ReadonlySet<string>): RentOpsSnapshot {
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
  const applicationIds = new Set(applications.map(application => application.id));
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
    applicationHouseholdMembers: snapshot.applicationHouseholdMembers.filter(item => applicationIds.has(item.applicationId)),
    applicationRequirements: snapshot.applicationRequirements.filter(item => applicationIds.has(item.applicationId)),
    documents: snapshot.documents.filter(item => keepRelationship(item.propertyId, item.unitId, item.tenancyId)),
    activityEvents: snapshot.activityEvents.filter(item => keepRelationship(item.propertyId, item.unitId, item.tenancyId) || (typeof item.applicationId === "string" && applicationIds.has(item.applicationId))),
  };
}

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

export function createCompanyRentalSnapshotPort(options: Pick<CompanyDomainReportingAdapterOptions, "executor" | "principal" | "rentalService">): RentalSnapshotReadPort {
  const service = options.rentalService ?? new RentOpsService(new PostgresRentOpsRepository(options.executor, true));
  return {
    async readSnapshot({ context }) {
      const propertyIds = await resolveRentalPropertyIds(options, context);
      const snapshot = await service.reportSnapshot();
      const filtered = scopedSnapshot(snapshot, new Set(propertyIds));
      return { snapshot: filtered, coverage: { state: "partial" as const, evidence: "reproducible_snapshot" as const, watermark: null, reason: "Rental records are read in one transaction; historical completeness is not independently watermarked." } };
    },
  };
}

function createProjectPort(options: CompanyDomainReportingAdapterOptions): ProjectReportingReadPort {
  const service = options.projectService ?? new ProjectReadService(options.executor);
  const execution = new ProjectExecutionStore(options.executor);
  return {
    async read({ context }): Promise<ProjectReportingReadResult> {
      const summaries = new Map<string, { id: string; legalEntityId: string; propertyId: string }>();
      const scopes = await resolveDatedScopes(options, context);
      for (const scope of scopes) {
        let cursor: string | undefined;
        do {
          const page = await service.list(options.principal, { scope, asOf: periodAsOf(context), limit: 100, ...(cursor ? { cursor } : {}) });
          for (const item of page.items) summaries.set(String(item.id), { id: String(item.id), legalEntityId: String(item.legalEntityId), propertyId: String(item.propertyId) });
          cursor = page.nextCursor ?? undefined;
          if (summaries.size > MAX_COMPANY_RECORDS) throw new ReportingError("report_unavailable", "Too many projects match; narrow the scope.", 409);
        } while (cursor);
      }
      const asOf = periodAsOf(context);
      const details = await Promise.all(Array.from(summaries.values()).map(item => service.get(options.principal, { scope: companyScopeSchema.parse({ organizationId: context.request.scope.organizationId, legalEntityId: legalEntityIdSchema.parse(item.legalEntityId), propertyId: propertyReferenceIdSchema.parse(item.propertyId) }), projectId: item.id, asOf })));
      // Approved and closed commitments come from project execution. The
      // project detail read above already authorized each project scope.
      const commitments: NonNullable<ProjectReportingReadResult["commitments"]>[number][] = [];
      if (context.definition.id === "contractor-exposure") {
        for (const project of details) {
          const snapshot = await execution.read({ scope: companyScopeSchema.parse({ organizationId: project.organizationId, legalEntityId: project.legalEntityId, propertyId: project.propertyId }), projectId: String(project.id), ...(asOf ? { asOf } : {}) });
          const vendors = new Map(snapshot.vendors.map(vendor => [String(vendor.id), vendor.name]));
          for (const commitment of snapshot.commitments) commitments.push({ id: String(commitment.id), projectId: String(commitment.projectId), vendorId: commitment.vendorId ? String(commitment.vendorId) : null, vendorName: commitment.vendorId ? vendors.get(String(commitment.vendorId)) ?? null : null, committedCents: commitment.committedCents, status: commitment.status, currency: commitment.currency, committedOn: commitment.createdAt.slice(0, 10) });
        }
      }
      return { projects: details, ...(context.definition.id === "contractor-exposure" ? { commitments } : {}), coverage: { state: "partial" as const, evidence: "reproducible_snapshot" as const, watermark: null, reason: "Project records are transaction-bound; posted-actual coverage is retained per project. Commitment dates are the dates commitments were recorded." } };
    },
  };
}

function createInvestorPort(options: CompanyDomainReportingAdapterOptions): InvestorReportingReadPort {
  const service = options.investorService ?? new InvestorReadService(options.executor);
  return {
    async read({ context, investorIds }) {
      const requestedAccounts = new Set<string>([...investorIds.map(String), ...context.request.scope.ownerIds.map(String)]);
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
    async hasConnection(organizationId) {
      const result = await options.executor.query<{ found: boolean }>(`SELECT EXISTS (SELECT 1 FROM time_connections WHERE organization_id=$1 AND revoked_at IS NULL) AS found`, [organizationId]);
      return result.rows[0]?.found === true;
    },
    async read({ context }) {
      const entries: TimeEntry[] = [];
      const coverages: TimeCoverage[] = [];
      const users: TimeUser[] = [];
      const jobcodes: TimeJobcode[] = [];
      const jobcodeMappings: TimeJobcodeMapping[] = [];
      const scopes = await resolveDatedScopes(options, context);
      const entities = Array.from(new Set(scopes.map(scope => scope.legalEntityId).filter((value): value is NonNullable<typeof value> => Boolean(value))));
      const bounds = periodBounds(context);
      for (const legalEntityId of entities) {
        const connections = await read.listConnections(options.principal, { organizationId: context.request.scope.organizationId, legalEntityId });
        for (const connection of connections.filter(item => item.status === "active")) {
          const scope = connection.scope as TimeConnectionScope;
          const [scopeUsers, scopeJobcodes, scopeMappings] = await Promise.all([read.listUsers(options.principal, scope), read.listJobcodes(options.principal, scope), read.listJobcodeMappings(options.principal, scope)]);
          users.push(...scopeUsers); jobcodes.push(...scopeJobcodes); jobcodeMappings.push(...scopeMappings);
          for (const companyScope of scopes.filter(item => item.legalEntityId === scope.legalEntityId)) {
            let cursor: string | undefined;
            do {
              const page = await read.listEntries(options.principal, { scope: { organizationId: companyScope.organizationId, legalEntityId: companyScope.legalEntityId!, ...(companyScope.propertyId ? { propertyId: companyScope.propertyId } : {}) }, environment: scope.environment, providerCompanyId: scope.providerCompanyId, from: bounds.from ? isoDateSchema.parse(bounds.from) : undefined, through: bounds.through ? isoDateSchema.parse(bounds.through) : undefined, limit: 500, ...(cursor ? { cursor } : {}) });
              entries.push(...page.items); coverages.push(...page.coverage); cursor = page.nextCursor ?? undefined;
              if (entries.length > MAX_COMPANY_RECORDS) throw new ReportingError("report_unavailable", "Too many time entries match; choose a shorter period.", 409);
            } while (cursor);
          }
        }
      }
      const allCoverage: Pick<TimeCoverage, "status" | "watermark">[] = coverages.length ? coverages : [{ status: "unavailable", watermark: null }];
      return { entries, users, jobcodes, jobcodeMappings, coverage: { state: sourceCoverageState(allCoverage), evidence: "live_provider_readback" as const, watermark: allCoverage.map(item => item.watermark).filter(Boolean).sort().at(-1) ?? null, reason: allCoverage.some(item => item.status !== "complete") ? "At least one QuickBooks Time stream is partial or unavailable." : null } };
    },
  };
}

function createWorkOrderPort(options: CompanyDomainReportingAdapterOptions): WorkOrderReportingReadPort {
  const service = options.workOrderService ?? new WorkOrderReadService(options.executor);
  return {
    async read({ context, statuses, priorities, categories }) {
      const scopes = await resolveDatedScopes(options, context);
      const items = new Map<string, WorkOrderSummary>();
      for (const scope of scopes) {
        let cursor: string | undefined;
        do {
          const page = await service.list(options.principal, {
            scope, openOnly: false, limit: 100,
            ...(statuses.length ? { statuses: statuses as never } : {}), ...(priorities.length ? { priorities: priorities as never } : {}), ...(categories.length ? { categories: categories as never } : {}),
            ...(cursor ? { cursor } : {}),
          });
          for (const item of page.items) items.set(String(item.id), item);
          cursor = page.nextCursor ?? undefined;
          if (items.size > MAX_COMPANY_RECORDS) throw new ReportingError("report_unavailable", "Too many work orders match; narrow the scope or period.", 409);
        } while (cursor);
      }
      return { workOrders: Array.from(items.values()), coverage: { state: "complete" as const, evidence: "reproducible_snapshot" as const, watermark: null, reason: null } };
    },
  };
}

/**
 * Compose domain reports with the same database and scope rules used by the
 * company features. Every port resolves the request to dated entity/property
 * scopes and the principal's grants before reading.
 */
export function createCompanyDomainReportingEngines(options: CompanyDomainReportingAdapterOptions): readonly ReportingEngine[] {
  const rental = createCompanyRentalSnapshotPort(options);
  const projects = createProjectPort(options);
  const settlements = options.domainPorts?.settlements ?? createPostgresPmSettlementReadPort(options);
  const domain: ReportingDomainEngineOptions = {
    rental,
    projects,
    investors: createInvestorPort(options),
    tasks: projects,
    time: createTimePort(options),
    workOrders: createWorkOrderPort(options),
    settlements,
    propertyStatement: options.domainPorts?.propertyStatement ?? createPropertyStatementReadPort({ rental, settlements, financial: options.domainPorts?.combinedFinancial }),
    lenderPackage: options.domainPorts?.lenderPackage ?? createFrozenRunLenderPackageReadPort(options),
    combinedFinancial: options.domainPorts?.combinedFinancial,
    forecast: options.domainPorts?.forecast,
  };
  return createReportingDomainEngines(domain);
}
