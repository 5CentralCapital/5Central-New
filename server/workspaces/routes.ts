import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { isoDateSchema, organizationIdSchema, propertyReferenceIdSchema } from "../../shared/company";
import { PEOPLE_ROLES } from "../../shared/workspaces/contracts";
import type { RentOpsSnapshot } from "../../shared/rent-ops-contracts";
import { companyReadHandler, companyWebActor } from "../company/http";
import { nowIsoDate } from "../rent-ops/domain/dates";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { RentOpsService } from "../rent-ops/services/service";
import { readAsPrincipal, authorizedPropertyMappings } from "./access";
import { assemblePropertyFinancials, readCompanyPropertyRows } from "./property-financials";
import { computePropertyPerformance, readCompanyPerformanceRows } from "./property-performance";
import { readCompanySettings, readCostLibrary, readEntityDirectory, readPeopleDirectory, readPropertyDocuments } from "./company-directory";
import { readDashboardCompany } from "./dashboard";
import { monthBounds } from "./period";

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected YYYY-MM");
/** A repeated query parameter (`?property=a&property=b`) as a bounded list of strings. */
const repeated = (item: z.ZodType<string>) => z.union([item, z.array(item).max(100)]).optional()
  .transform((value): string[] | undefined => value === undefined ? undefined : Array.isArray(value) ? value : [value]);
const periodQuery = { month: monthSchema.optional(), asOf: isoDateSchema.optional(), company: organizationIdSchema.optional() };
const pageQuery = { search: z.string().trim().max(120).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().min(1).max(512).optional() };

export interface WorkspaceRouteOptions {
  readonly executor: RentOpsQueryExecutor;
  readonly requireAdmin: RequestHandler;
  /** Report snapshot reader; defaults to the rental repository on the same database. */
  readonly readRentalSnapshot?: () => Promise<RentOpsSnapshot>;
  readonly today?: () => string;
}

/**
 * Read endpoints for manager workspace pages. Rental figures require the
 * manager session (as every rental report does); company figures additionally
 * require an active company grant, reloaded inside a read-only snapshot.
 */
export function registerWorkspaceRoutes(app: Express, options: WorkspaceRouteOptions): void {
  const { executor, requireAdmin } = options;
  let service: RentOpsService | undefined;
  const readRentalSnapshot = options.readRentalSnapshot ?? (() => (service ??= new RentOpsService(new PostgresRentOpsRepository(executor))).reportSnapshot());
  const today = options.today ?? (() => nowIsoDate());
  const principalInput = (actorId: string, organizationId: string) => ({ actorId, organizationId, role: "admin" as const });
  const period = (query: { month?: string; asOf?: string }) => {
    const asOf = query.asOf ?? today();
    const month = query.month ?? asOf.slice(0, 7);
    monthBounds(month);
    return { asOf, month };
  };

  app.get("/api/workspaces/properties/:propertyId/financials", requireAdmin, companyReadHandler(async (req, res) => {
    const propertyId = propertyReferenceIdSchema.parse(req.params.propertyId);
    const query = z.object(periodQuery).strict().parse(req.query);
    const actorId = companyWebActor(req);
    const { asOf, month } = period(query);
    const snapshot = await readRentalSnapshot();
    if (!snapshot.properties.some(property => property.id === propertyId)) { res.status(404).json({ code: "workspace_not_found", message: "Property not found." }); return; }
    const { from, to } = monthBounds(month);
    const company = query.company ? await readAsPrincipal(executor, principalInput(actorId, query.company), async context => {
      const mapping = (await authorizedPropertyMappings(context, to < asOf ? to : asOf)).get(propertyId);
      return mapping
        ? { organizationId: query.company!, rows: await readCompanyPropertyRows(context, mapping, from, to) }
        : { organizationId: query.company!, unavailableReason: "This property is not assigned to a company entity you can read for this period." };
    }) : null;
    res.json(assemblePropertyFinancials({ snapshot, propertyId, month, asOf, company }));
  }));

  app.get("/api/workspaces/property-performance", requireAdmin, companyReadHandler(async (req, res) => {
    const query = z.object({ ...periodQuery, scope: z.enum(["active", "all"]).default("active"), property: repeated(propertyReferenceIdSchema) }).strict().parse(req.query);
    const actorId = companyWebActor(req);
    const { asOf, month } = period(query);
    const company = query.company ? await readAsPrincipal(executor, principalInput(actorId, query.company), context => readCompanyPerformanceRows(context, asOf)) : undefined;
    res.json(computePropertyPerformance(await readRentalSnapshot(), { month, asOf, propertyScope: query.scope, propertyIds: query.property }, company));
  }));

  const companyRoute = <Q extends z.ZodRawShape>(path: string, shape: Q, read: (context: Parameters<Parameters<typeof readAsPrincipal>[2]>[0], query: z.infer<z.ZodObject<Q>>, asOf: string) => Promise<unknown>) => {
    app.get(`/api/company/:organizationId/workspaces/${path}`, requireAdmin, companyReadHandler(async (req, res) => {
      const organizationId = organizationIdSchema.parse(req.params.organizationId);
      const query = z.object(shape).strict().parse(req.query) as z.infer<z.ZodObject<Q>>;
      const asOf = (query as { asOf?: string }).asOf ?? today();
      res.json(await readAsPrincipal(executor, principalInput(companyWebActor(req), organizationId), context => read(context, query, asOf)));
    }));
  };
  companyRoute("entities", { asOf: isoDateSchema.optional() }, (context, _query, asOf) => readEntityDirectory(context, asOf));
  companyRoute("people", { ...pageQuery, role: z.enum(PEOPLE_ROLES).optional(), asOf: isoDateSchema.optional() },
    (context, query, asOf) => readPeopleDirectory(context, { search: query.search, role: query.role, limit: query.limit, cursor: query.cursor, asOf }));
  companyRoute("settings", {}, context => readCompanySettings(context));
  companyRoute("property-documents", { asOf: isoDateSchema.optional(), property: repeated(propertyReferenceIdSchema) },
    (context, query, asOf) => readPropertyDocuments(context, { asOf, propertyIds: query.property }));
  companyRoute("cost-library", { ...pageQuery, asOf: isoDateSchema.optional() },
    (context, query, asOf) => readCostLibrary(context, { search: query.search, limit: query.limit, cursor: query.cursor, asOf }));
  companyRoute("dashboard", { asOf: isoDateSchema.optional() }, (context, _query, asOf) => readDashboardCompany(context, asOf));
}
