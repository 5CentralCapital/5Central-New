import { Router, type Express, type RequestHandler } from "express";
import { z } from "zod";
import type { RentOpsQueryExecutor } from "../repositories/postgres";
import { BillingError, RecurringBillingService } from "./service";
import { PostgresBillingStore } from "./postgres";

export interface RentOpsBillingRouteOptions {
  executor?: RentOpsQueryExecutor;
  /** Inject the existing requireRentOpsAdmin middleware: session and CSRF. */
  requireAdmin: RequestHandler;
  /** Isolated test/demo seam; production supplies its dedicated executor. */
  service?: RecurringBillingService;
}

const postSchema = z.object({ month: z.string(), previewToken: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export function registerRentOpsBillingRoutes(app: Express, options: RentOpsBillingRouteOptions, mountPath = "/api/rent-ops/billing"): Router {
  if (!options.service && !options.executor) throw new Error("Rent Operations billing requires its dedicated database executor");
  const service = options.service ?? new RecurringBillingService(new PostgresBillingStore(options.executor!));
  const router = Router();
  router.use(options.requireAdmin);
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.get("/preview", async (req, res) => {
    try {
      if (typeof req.query.month !== "string" || Object.keys(req.query).some((key) => key !== "month")) throw new BillingError("invalid_input", 400);
      res.json(await service.preview(req.query.month));
    } catch (error) {
      res.status(error instanceof BillingError ? error.status : 503).json({ code: error instanceof BillingError ? error.code : "billing_unavailable" });
    }
  });
  router.post("/post", async (req, res) => {
    try {
      const parsed = postSchema.safeParse(req.body);
      if (!parsed.success) throw new BillingError("invalid_input", 400);
      const actorSubject = req.rentOpsAdminUser?.id;
      if (!actorSubject) { res.status(401).json({ code: "not_authorized" }); return; }
      res.json(await service.post({ ...parsed.data, actorSubject }));
    } catch (error) {
      res.status(error instanceof BillingError ? error.status : 503).json({ code: error instanceof BillingError ? error.code : "billing_unavailable" });
    }
  });
  app.use(mountPath, router);
  return router;
}
