import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { isoDateSchema, organizationIdSchema, propertyReferenceIdSchema } from "../../shared/company";
import { PEOPLE_ROLES } from "../../shared/workspaces/contracts";
import { companyReadHandler, companyWebActor } from "../company/http";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { createWorkspaceReadPort, WorkspaceNotFoundError, type WorkspaceReadPort, type WorkspaceReadPortOptions } from "./port";

export const workspaceMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected YYYY-MM");
/** A repeated query parameter (`?property=a&property=b`) as a bounded list of strings. */
const repeated = (item: z.ZodType<string>) => z.union([item, z.array(item).max(100)]).optional()
  .transform((value): string[] | undefined => value === undefined ? undefined : Array.isArray(value) ? value : [value]);
const periodQuery = { month: workspaceMonthSchema.optional(), asOf: isoDateSchema.optional(), company: organizationIdSchema.optional() };
const pageQuery = { search: z.string().trim().max(120).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().min(1).max(512).optional() };

export interface WorkspaceRouteOptions extends WorkspaceReadPortOptions {
  readonly executor: RentOpsQueryExecutor;
  readonly requireAdmin: RequestHandler;
  readonly port?: WorkspaceReadPort;
}

/**
 * Read endpoints for manager workspace pages. Rental figures require the
 * manager session (as every rental report does); company figures additionally
 * require an active company grant, reloaded inside a read-only snapshot.
 */
export function registerWorkspaceRoutes(app: Express, options: WorkspaceRouteOptions): void {
  const { requireAdmin } = options;
  const port = options.port ?? createWorkspaceReadPort(options.executor, options);
  const notFound = (handler: Parameters<typeof companyReadHandler>[0]) => companyReadHandler(async (req, res) => {
    try { await handler(req, res); }
    catch (error) {
      if (error instanceof WorkspaceNotFoundError) { res.status(404).json({ code: "workspace_not_found", message: error.message }); return; }
      throw error;
    }
  });

  app.get("/api/workspaces/properties/:propertyId/financials", requireAdmin, notFound(async (req, res) => {
    const propertyId = propertyReferenceIdSchema.parse(req.params.propertyId);
    const query = z.object(periodQuery).strict().parse(req.query);
    res.json(await port.propertyFinancials(companyWebActor(req), { propertyId, month: query.month, asOf: query.asOf, organizationId: query.company }));
  }));

  app.get("/api/workspaces/property-performance", requireAdmin, companyReadHandler(async (req, res) => {
    const query = z.object({ ...periodQuery, scope: z.enum(["active", "all"]).default("active"), property: repeated(propertyReferenceIdSchema) }).strict().parse(req.query);
    res.json(await port.propertyPerformance(companyWebActor(req), { month: query.month, asOf: query.asOf, organizationId: query.company, propertyScope: query.scope, propertyIds: query.property }));
  }));

  const companyRoute = <Q extends z.ZodRawShape>(path: string, shape: Q, read: (actorId: string, organizationId: string, query: z.infer<z.ZodObject<Q>>) => Promise<unknown>) => {
    app.get(`/api/company/:organizationId/workspaces/${path}`, requireAdmin, companyReadHandler(async (req, res) => {
      const organizationId = organizationIdSchema.parse(req.params.organizationId);
      const query = z.object(shape).strict().parse(req.query) as z.infer<z.ZodObject<Q>>;
      res.json(await read(companyWebActor(req), organizationId, query));
    }));
  };
  companyRoute("entities", { asOf: isoDateSchema.optional() }, (actorId, organizationId, query) => port.entities(actorId, organizationId, query.asOf));
  companyRoute("people", { ...pageQuery, role: z.enum(PEOPLE_ROLES).optional(), asOf: isoDateSchema.optional() },
    (actorId, organizationId, query) => port.people(actorId, organizationId, { search: query.search, role: query.role, limit: query.limit, cursor: query.cursor, asOf: query.asOf }));
  companyRoute("settings", {}, (actorId, organizationId) => port.settings(actorId, organizationId));
  companyRoute("property-documents", { asOf: isoDateSchema.optional(), property: repeated(propertyReferenceIdSchema) },
    (actorId, organizationId, query) => port.propertyDocuments(actorId, organizationId, { asOf: query.asOf, propertyIds: query.property }));
  companyRoute("cost-library", { ...pageQuery, asOf: isoDateSchema.optional() },
    (actorId, organizationId, query) => port.costLibrary(actorId, organizationId, { search: query.search, limit: query.limit, cursor: query.cursor, asOf: query.asOf }));
  companyRoute("dashboard", { asOf: isoDateSchema.optional() }, (actorId, organizationId, query) => port.dashboard(actorId, organizationId, query.asOf));
}
