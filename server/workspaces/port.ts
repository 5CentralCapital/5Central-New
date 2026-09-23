import type { RentOpsSnapshot } from "../../shared/rent-ops-contracts";
import type {
  CompanySettings, CostLibrary, DashboardCompany, EntityDirectory, PeopleDirectory, PropertyDocuments, PropertyFinancials, PropertyPerformance,
} from "../../shared/workspaces/contracts";
import { nowIsoDate } from "../rent-ops/domain/dates";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { RentOpsService } from "../rent-ops/services/service";
import { authorizedPropertyMappings, readAsPrincipal, type WorkspaceReadContext } from "./access";
import { readCompanySettings, readCostLibrary, readEntityDirectory, readPeopleDirectory, readPropertyDocuments } from "./company-directory";
import { readDashboardCompany } from "./dashboard";
import { monthBounds } from "./period";
import { assemblePropertyFinancials, readCompanyPropertyRows } from "./property-financials";
import { computePropertyPerformance, readCompanyPerformanceRows } from "./property-performance";

export class WorkspaceNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = "WorkspaceNotFoundError"; }
}

export interface WorkspacePeriodInput { readonly month?: string; readonly asOf?: string }

/**
 * One read service for the manager workspace pages. The browser routes and the
 * Codex tools both call it, so both see the same figures and the same grants.
 */
export interface WorkspaceReadPort {
  propertyFinancials(actorId: string, input: WorkspacePeriodInput & { propertyId: string; organizationId?: string }): Promise<PropertyFinancials>;
  propertyPerformance(actorId: string, input: WorkspacePeriodInput & { organizationId?: string; propertyScope: "active" | "all"; propertyIds?: readonly string[] }): Promise<PropertyPerformance>;
  entities(actorId: string, organizationId: string, asOf?: string): Promise<EntityDirectory>;
  people(actorId: string, organizationId: string, input: { search?: string; role?: string; limit: number; cursor?: string; asOf?: string }): Promise<PeopleDirectory>;
  settings(actorId: string, organizationId: string): Promise<CompanySettings>;
  propertyDocuments(actorId: string, organizationId: string, input: { asOf?: string; propertyIds?: readonly string[] }): Promise<PropertyDocuments>;
  costLibrary(actorId: string, organizationId: string, input: { search?: string; limit: number; cursor?: string; asOf?: string }): Promise<CostLibrary>;
  dashboard(actorId: string, organizationId: string, asOf?: string): Promise<DashboardCompany>;
}

export interface WorkspaceReadPortOptions {
  /** Report snapshot reader; defaults to the rental repository on the same database. */
  readonly readRentalSnapshot?: () => Promise<RentOpsSnapshot>;
  readonly today?: () => string;
}

export function createWorkspaceReadPort(executor: RentOpsQueryExecutor, options: WorkspaceReadPortOptions = {}): WorkspaceReadPort {
  let service: RentOpsService | undefined;
  const readRentalSnapshot = options.readRentalSnapshot ?? (() => (service ??= new RentOpsService(new PostgresRentOpsRepository(executor))).reportSnapshot());
  const today = options.today ?? (() => nowIsoDate());
  const period = (input: WorkspacePeriodInput) => {
    const asOf = input.asOf ?? today();
    const month = input.month ?? asOf.slice(0, 7);
    return { asOf, month, ...monthBounds(month) };
  };
  const asCompany = <T>(actorId: string, organizationId: string, work: (context: WorkspaceReadContext) => Promise<T>) =>
    readAsPrincipal(executor, { actorId, organizationId, role: "admin" }, work);
  return {
    async propertyFinancials(actorId, input) {
      const { asOf, month, from, to } = period(input);
      const snapshot = await readRentalSnapshot();
      if (!snapshot.properties.some(property => property.id === input.propertyId)) throw new WorkspaceNotFoundError("Property not found.");
      const company = input.organizationId ? await asCompany(actorId, input.organizationId, async context => {
        const mapping = (await authorizedPropertyMappings(context, to < asOf ? to : asOf)).get(input.propertyId);
        return mapping
          ? { organizationId: input.organizationId!, rows: await readCompanyPropertyRows(context, mapping, from, to) }
          : { organizationId: input.organizationId!, unavailableReason: "This property is not assigned to a company entity you can read for this period." };
      }) : null;
      return assemblePropertyFinancials({ snapshot, propertyId: input.propertyId, month, asOf, company });
    },
    async propertyPerformance(actorId, input) {
      const { asOf, month } = period(input);
      const company = input.organizationId ? await asCompany(actorId, input.organizationId, context => readCompanyPerformanceRows(context, asOf)) : undefined;
      return computePropertyPerformance(await readRentalSnapshot(), { month, asOf, propertyScope: input.propertyScope, propertyIds: input.propertyIds }, company);
    },
    entities: (actorId, organizationId, asOf) => asCompany(actorId, organizationId, context => readEntityDirectory(context, asOf ?? today())),
    people: (actorId, organizationId, input) => asCompany(actorId, organizationId, context => readPeopleDirectory(context, { ...input, asOf: input.asOf ?? today() })),
    settings: (actorId, organizationId) => asCompany(actorId, organizationId, context => readCompanySettings(context)),
    propertyDocuments: (actorId, organizationId, input) => asCompany(actorId, organizationId, context => readPropertyDocuments(context, { asOf: input.asOf ?? today(), propertyIds: input.propertyIds })),
    costLibrary: (actorId, organizationId, input) => asCompany(actorId, organizationId, context => readCostLibrary(context, { ...input, asOf: input.asOf ?? today() })),
    dashboard: (actorId, organizationId, asOf) => asCompany(actorId, organizationId, context => readDashboardCompany(context, asOf ?? today())),
  };
}
