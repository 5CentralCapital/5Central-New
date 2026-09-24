import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { commandEnvelopeSchema, organizationIdSchema } from "../../shared/company";
import {
  FORECAST_COMMAND_KINDS,
  forecastCommandPayloadSchemas,
  forecastLineSchema,
  forecastPeriodSchema,
  forecastScenarioIdSchema,
  forecastScenarioStateSchema,
  forecastSnapshotIdSchema,
} from "../../shared/forecasting/contracts";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import { ForbiddenCommandError, ValidationCommandError } from "../company/commands/errors";
import { companyHttpError, companyReadHandler, companyWebActor } from "../company/http";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { forecastWorkbookBodyParser } from "../request-body-parsers";
import type { ForecastingPort } from "./port";
import { parseWorkbookCashflow } from "./workbook-import";

const listQuery = z.object({
  state: z.string().trim().min(1).max(60).transform(value => value.split(",").map(item => item.trim()).filter(Boolean)).pipe(z.array(forecastScenarioStateSchema).min(1).max(3)).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(512).optional(),
}).strict();

const explainQuery = z.object({
  snapshotId: forecastSnapshotIdSchema.optional(),
  scenarioId: forecastScenarioIdSchema.optional(),
  assumptionVersion: z.coerce.number().int().positive().optional(),
  line: forecastLineSchema,
  period: forecastPeriodSchema,
  limit: z.coerce.number().int().min(1).max(500).default(200),
  cursor: z.string().trim().min(1).max(64).optional(),
}).strict().refine(value => (value.snapshotId === undefined) !== (value.scenarioId === undefined), { message: "Choose a snapshot or a scenario", path: ["snapshotId"] });

const compareQuery = z.object({ a: forecastSnapshotIdSchema, b: forecastSnapshotIdSchema, limit: z.coerce.number().int().min(1).max(200).default(50) }).strict();
const previewBody = z.object({ assumptionVersion: z.number().int().positive().optional(), assumptions: z.record(z.string(), z.unknown()).optional() }).strict();
const workbookQuery = z.object({ fileName: z.string().trim().min(1).max(200) }).strict();

/** Browser routes; they call the same port as the MCP tools. */
export function registerForecastingRoutes(app: Express, options: { executor: RentOpsQueryExecutor; requireAdmin: RequestHandler; forecasting: ForecastingPort }): void {
  const web = attestTransport("web");
  const { executor, requireAdmin, forecasting } = options;
  const principalFor = (actorId: string, organizationId: string, connection: RentOpsQueryExecutor = executor) =>
    loadAuthenticatedPrincipal(connection, { actorId, organizationId, role: "admin" });
  const base = "/api/company/:organizationId";
  /** Keep the large raw parser behind both session and company-grant checks. */
  const authorizeWorkbookRead: RequestHandler = (req, res, next) => {
    void (async () => {
      const organizationId = organizationIdSchema.parse(req.params.organizationId);
      const principal = await principalFor(companyWebActor(req), organizationId);
      await forecasting.list(principal, { scope: { organizationId }, limit: 1 });
      next();
    })().catch(error => companyHttpError(error, res));
  };

  app.get(`${base}/forecast-scenarios`, requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const query = listQuery.parse(req.query);
    const principal = await principalFor(companyWebActor(req), organizationId);
    res.json(await forecasting.list(principal, { scope: { organizationId }, limit: query.limit, ...(query.state ? { states: query.state } : {}), ...(query.cursor ? { cursor: query.cursor } : {}) }));
  }));
  app.get(`${base}/forecast-scenarios/:scenarioId`, requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const scenarioId = forecastScenarioIdSchema.parse(req.params.scenarioId);
    z.object({}).strict().parse(req.query);
    const principal = await principalFor(companyWebActor(req), organizationId);
    res.json(await forecasting.get(principal, { scope: { organizationId }, scenarioId }));
  }));
  app.get(`${base}/forecast-scenarios/:scenarioId/versions/:version`, requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const scenarioId = forecastScenarioIdSchema.parse(req.params.scenarioId);
    const version = z.coerce.number().int().positive().parse(req.params.version);
    const principal = await principalFor(companyWebActor(req), organizationId);
    res.json(await forecasting.getVersion(principal, { scope: { organizationId }, scenarioId, version }));
  }));
  // A POST because a draft assumption document can be large; nothing is saved.
  app.post(`${base}/forecast-scenarios/:scenarioId/preview`, requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const scenarioId = forecastScenarioIdSchema.parse(req.params.scenarioId);
    const body = previewBody.parse(req.body ?? {});
    const principal = await principalFor(companyWebActor(req), organizationId);
    res.json(await forecasting.preview(principal, { scope: { organizationId }, scenarioId, ...body }));
  }));
  app.get(`${base}/forecast-snapshots/:snapshotId`, requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const snapshotId = forecastSnapshotIdSchema.parse(req.params.snapshotId);
    const principal = await principalFor(companyWebActor(req), organizationId);
    res.json(await forecasting.snapshot(principal, { scope: { organizationId }, snapshotId }));
  }));
  app.get(`${base}/forecast-explain`, requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const query = explainQuery.parse(req.query);
    const principal = await principalFor(companyWebActor(req), organizationId);
    const source = query.snapshotId ? { snapshotId: query.snapshotId } : { scenarioId: query.scenarioId!, ...(query.assumptionVersion ? { assumptionVersion: query.assumptionVersion } : {}) };
    res.json(await forecasting.explain(principal, { scope: { organizationId }, source, line: query.line, period: query.period, limit: query.limit, ...(query.cursor ? { cursor: query.cursor } : {}) }));
  }));
  app.get(`${base}/forecast-compare`, requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const query = compareQuery.parse(req.query);
    const principal = await principalFor(companyWebActor(req), organizationId);
    res.json(await forecasting.compare(principal, { scope: { organizationId }, snapshotA: query.a, snapshotB: query.b, limit: query.limit }));
  }));
  // Read-only workbook discovery: parse an uploaded Cashflow sheet into an assumption draft. Nothing is saved.
  app.post(`${base}/forecast-workbook-drafts`, requireAdmin, authorizeWorkbookRead, forecastWorkbookBodyParser, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const { fileName } = workbookQuery.parse(req.query);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new ValidationCommandError("Upload a workbook or CSV file", { reason: "forecast_workbook_missing" });
    res.json(await parseWorkbookCashflow(req.body, { fileName }));
  }));
  app.post(`${base}/forecast-commands/:commandKind`, requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const kind = z.enum(FORECAST_COMMAND_KINDS).parse(req.params.commandKind);
    const envelope = commandEnvelopeSchema(forecastCommandPayloadSchemas[kind]).parse(req.body);
    if (envelope.scope.organizationId !== organizationId) throw new ForbiddenCommandError("Forecast company does not match this request.");
    const actorId = companyWebActor(req);
    const resolvePrincipal = (transaction: RentOpsQueryExecutor) => principalFor(actorId, organizationId, transaction);
    const principal = await resolvePrincipal(executor);
    res.json(await forecasting.execute(kind, req.body, { principal, resolvePrincipal, transport: web }));
  }));
}
