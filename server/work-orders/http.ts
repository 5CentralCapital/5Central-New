import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { commandEnvelopeSchema, companyScopeSchema, legalEntityIdSchema, organizationIdSchema, propertyReferenceIdSchema } from "../../shared/company";
import {
  WORK_ORDER_CATEGORIES,
  WORK_ORDER_COMMAND_KINDS,
  WORK_ORDER_PRIORITIES,
  WORK_ORDER_STATUSES,
  workOrderCommandPayloadSchemas,
  workOrderIdSchema,
  workOrderListQuerySchema,
} from "../../shared/work-orders";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import { companyReadHandler, companyWebActor } from "../company/http";
import { ForbiddenCommandError } from "../company/commands/errors";
import type { WorkOrderPort } from "./port";

const csv = <T extends readonly [string, ...string[]]>(values: T) => z.string().trim().min(1).max(400)
  .transform(value => value.split(",").map(item => item.trim()).filter(Boolean))
  .pipe(z.array(z.enum(values)).min(1).max(values.length));

const listQuery = z.object({
  legalEntityId: legalEntityIdSchema.optional(),
  propertyId: propertyReferenceIdSchema.optional(),
  unitId: z.string().min(1).max(160).optional(),
  status: csv(WORK_ORDER_STATUSES).optional(),
  priority: csv(WORK_ORDER_PRIORITIES).optional(),
  category: csv(WORK_ORDER_CATEGORIES).optional(),
  assignedTo: z.string().trim().min(1).max(200).optional(),
  search: z.string().trim().max(200).optional(),
  openOnly: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(512).optional(),
}).strict();

const scopeQuery = z.object({
  legalEntityId: legalEntityIdSchema.optional(),
  propertyId: propertyReferenceIdSchema.optional(),
}).strict();

/** Browser routes; they call the same port as the Codex tools. */
export function registerWorkOrderRoutes(app: Express, options: { executor: RentOpsQueryExecutor; requireAdmin: RequestHandler; workOrders: WorkOrderPort }): void {
  const web = attestTransport("web");
  const { executor, requireAdmin, workOrders } = options;
  const principalFor = (actorId: string, organizationId: string, connection: RentOpsQueryExecutor = executor) =>
    loadAuthenticatedPrincipal(connection, { actorId, organizationId, role: "admin" });

  app.get("/api/company/:organizationId/work-orders", requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const { legalEntityId, propertyId, status, priority, category, openOnly, ...rest } = listQuery.parse(req.query);
    const principal = await principalFor(companyWebActor(req), organizationId);
    res.json(await workOrders.list(principal, workOrderListQuerySchema.parse({
      ...rest,
      scope: { organizationId, legalEntityId, propertyId },
      ...(status ? { statuses: status } : {}),
      ...(priority ? { priorities: priority } : {}),
      ...(category ? { categories: category } : {}),
      ...(openOnly ? { openOnly: openOnly === "true" } : {}),
    })));
  }));
  app.get("/api/company/:organizationId/work-orders/tenant-options", requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const query = z.object({ legalEntityId: legalEntityIdSchema, propertyId: propertyReferenceIdSchema }).strict().parse(req.query);
    const principal = await principalFor(companyWebActor(req), organizationId);
    res.json(await workOrders.tenantOptions(principal, { scope: companyScopeSchema.parse({ organizationId, legalEntityId: query.legalEntityId }), propertyId: query.propertyId }));
  }));
  app.get("/api/company/:organizationId/work-orders/:workOrderId", requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const workOrderId = workOrderIdSchema.parse(req.params.workOrderId);
    const query = scopeQuery.parse(req.query);
    const principal = await principalFor(companyWebActor(req), organizationId);
    res.json(await workOrders.get(principal, { scope: companyScopeSchema.parse({ organizationId, ...query }), workOrderId }));
  }));
  app.post("/api/company/:organizationId/work-order-commands/:commandKind", requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const kind = z.enum(WORK_ORDER_COMMAND_KINDS).parse(req.params.commandKind);
    const envelope = commandEnvelopeSchema(workOrderCommandPayloadSchemas[kind]).parse(req.body);
    if (envelope.scope.organizationId !== organizationId) throw new ForbiddenCommandError("Work order company does not match this request.");
    const actorId = companyWebActor(req);
    const resolvePrincipal = (transaction: RentOpsQueryExecutor) => principalFor(actorId, organizationId, transaction);
    const principal = await resolvePrincipal(executor);
    res.json(await workOrders.execute(kind, envelope, { principal, resolvePrincipal, transport: web }));
  }));
}
