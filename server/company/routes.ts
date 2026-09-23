import type { Express, Request, RequestHandler } from 'express';
import { z } from 'zod';
import { organizationIdSchema, legalEntityIdSchema, propertyReferenceIdSchema, commandEnvelopeSchema, isoDateSchema } from '../../shared/company';
import { PROJECT_COMMAND_KINDS, projectCommandPayloadSchemas, projectIdSchema, projectStatusSchema } from '../../shared/projects/contracts';
import type { ProjectCommandKind, ProjectListQuery, ProjectReadContext } from '../../shared/projects/contracts';
import { projectExecutionCommandKinds, projectExecutionCommandPayloadSchemas, type ProjectExecutionCommandKind } from '../../shared/projects';
import type { RentOpsQueryExecutor } from '../rent-ops/repositories/postgres';
import { loadAuthenticatedPrincipal, attestTransport, type AuthenticatedPrincipal, type TransportAttestation } from './authorization';
import { readCompanyContext } from './context';
import { ForbiddenCommandError } from './commands/errors';
import { companyReadHandler, companyWebActor } from './http';
import type { AccountingServices } from '../accounting';
import { registerAccountingHttpRoutes } from '../accounting/http';
import { registerInvestorRoutes, type InvestorPort } from '../investors';
import { registerTimeHttpRoutes } from '../time/http';
import type { TimeServices } from '../time/service';
import { registerReportingHttpRoutes, type ReportingPort } from '../reporting';
import { registerWorkOrderRoutes } from '../work-orders/http';
import type { WorkOrderPort } from '../work-orders/port';
// lane-b-accounting
import { registerJobRoutes, type JobsPort } from '../jobs/operator';
// lane-c-review
import { registerReviewCaseRoutes } from '../review-cases/http';
import type { ReviewCasePort } from '../review-cases/port';
import { registerIntakeRoutes } from '../intake/http';
import type { IntakePort } from '../intake/port';
import { registerCompanyDocumentRoutes } from '../company-documents/http';
import type { CompanyDocumentsPort } from '../company-documents/port';
// lane-d-forecast
import { registerForecastingRoutes } from '../forecasting/http';
import type { ForecastingPort } from '../forecasting/port';
import { registerProjectInsightRoutes } from '../projects/http'; // lane-f
import type { ProjectInsightsPort } from '../projects/insights'; // lane-f
// lane-e-nav: manager workspace read endpoints
import { registerWorkspaceRoutes } from '../workspaces/routes';
import { workspaceProjectFinanceFactory } from '../workspaces/port'; // lane-e-nav

export interface CompanyProjectPort {
  list(principal: AuthenticatedPrincipal, query: ProjectListQuery): Promise<unknown>;
  get(principal: AuthenticatedPrincipal, query: ProjectReadContext & { projectId: string }): Promise<unknown>;
  execute(kind: ProjectCommandKind, envelope: unknown, access: {
    principal: AuthenticatedPrincipal;
    resolvePrincipal: (executor: RentOpsQueryExecutor) => Promise<AuthenticatedPrincipal>;
    transport: TransportAttestation;
  }): Promise<unknown>;
  getExecution?(principal: AuthenticatedPrincipal, query: ProjectReadContext & { projectId: string }): Promise<unknown>;
  executeExecution?(kind: ProjectExecutionCommandKind, envelope: unknown, access: {
    principal: AuthenticatedPrincipal;
    resolvePrincipal: (executor: RentOpsQueryExecutor) => Promise<AuthenticatedPrincipal>;
    transport: TransportAttestation;
  }): Promise<unknown>;
}

const readQuery = z.object({
  legalEntityId: legalEntityIdSchema.optional(),
  propertyId: propertyReferenceIdSchema.optional(),
  asOf: isoDateSchema.optional(),
  status: projectStatusSchema.optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).optional(),
}).strict();

export function registerCompanyRoutes(app: Express, options: {
  executor: RentOpsQueryExecutor; requireAdmin: RequestHandler; projects: CompanyProjectPort;
  accounting?: AccountingServices;
  investors?: InvestorPort;
  time?: TimeServices;
  reporting?: ReportingPort;
  workOrders?: WorkOrderPort;
  jobs?: JobsPort; // lane-b-accounting
  /** Browser-session presence check used for OAuth callback redirects (production wiring only). */
  hasAdminSession?: (request: Request) => boolean;
  // lane-c-review
  reviewCases?: ReviewCasePort;
  intake?: IntakePort;
  documents?: CompanyDocumentsPort;
  forecasting?: ForecastingPort; // lane-d-forecast
  projectInsights?: ProjectInsightsPort; // lane-f
}): void {
  const { executor, requireAdmin, projects } = options;
  if (options.workOrders) registerWorkOrderRoutes(app, { executor, requireAdmin, workOrders: options.workOrders });
  if (options.jobs) registerJobRoutes(app, { executor, requireAdmin, jobs: options.jobs }); // lane-b-accounting
  // lane-c-review
  if (options.reviewCases) registerReviewCaseRoutes(app, { executor, requireAdmin, reviewCases: options.reviewCases });
  if (options.intake) registerIntakeRoutes(app, { executor, requireAdmin, intake: options.intake });
  if (options.documents) registerCompanyDocumentRoutes(app, { executor, requireAdmin, documents: options.documents });
  if (options.forecasting) registerForecastingRoutes(app, { executor, requireAdmin, forecasting: options.forecasting }); // lane-d-forecast
  if (options.projectInsights) registerProjectInsightRoutes(app, { executor, requireAdmin, insights: options.projectInsights }); // lane-f
  if (options.accounting) registerAccountingHttpRoutes(app, { executor, requireAdmin, services: options.accounting, ...(options.hasAdminSession ? { hasAdminSession: options.hasAdminSession } : {}) });
  if (options.investors) registerInvestorRoutes(app, { executor, requireAdmin, investors: options.investors });
  if (options.time) registerTimeHttpRoutes(app, { executor, requireAdmin, services: options.time });
  if (options.reporting) registerReportingHttpRoutes(app, {
    service: options.reporting, requireAdmin,
    resolveAccess: async (request, organizationId) => ({ principal: await loadAuthenticatedPrincipal(executor, {
      actorId: companyWebActor(request), organizationId, role: 'admin',
    }) }),
  });
  // lane-e-nav: manager workspace read endpoints
  registerWorkspaceRoutes(app, { executor, requireAdmin, projectFinanceFactory: workspaceProjectFinanceFactory(options.accounting) });
  const web = attestTransport('web');
  app.get('/api/company/context', requireAdmin, companyReadHandler(async (req, res) => {
    res.json(await readCompanyContext(executor, companyWebActor(req), 'admin'));
  }));
  app.get('/api/company/:organizationId/projects', requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const { legalEntityId, propertyId, ...query } = readQuery.parse(req.query);
    const principal = await loadAuthenticatedPrincipal(executor, { actorId: companyWebActor(req), organizationId, role: 'admin' });
    res.json(await projects.list(principal, { ...query, scope: { organizationId, legalEntityId, propertyId } }));
  }));
  app.get('/api/company/:organizationId/projects/:projectId', requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const projectId = projectIdSchema.parse(req.params.projectId);
    const query = readQuery.pick({ legalEntityId: true, propertyId: true, asOf: true }).parse(req.query);
    const principal = await loadAuthenticatedPrincipal(executor, { actorId: companyWebActor(req), organizationId, role: 'admin' });
    res.json(await projects.get(principal, { projectId, scope: { organizationId, legalEntityId: query.legalEntityId, propertyId: query.propertyId }, asOf: query.asOf }));
  }));
  if (projects.getExecution) app.get('/api/company/:organizationId/projects/:projectId/execution', requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const projectId = projectIdSchema.parse(req.params.projectId);
    const query = readQuery.pick({ legalEntityId: true, propertyId: true, asOf: true }).parse(req.query);
    const principal = await loadAuthenticatedPrincipal(executor, { actorId: companyWebActor(req), organizationId, role: 'admin' });
    res.json(await projects.getExecution!(principal, { projectId, scope: { organizationId, legalEntityId: query.legalEntityId, propertyId: query.propertyId }, asOf: query.asOf }));
  }));
  if (projects.executeExecution) app.post('/api/company/:organizationId/project-execution-commands/:commandKind', requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const kind = z.enum(projectExecutionCommandKinds).parse(req.params.commandKind);
    const envelope = commandEnvelopeSchema(projectExecutionCommandPayloadSchemas[kind]).parse(req.body);
    if (envelope.scope.organizationId !== organizationId) throw new ForbiddenCommandError('Project company does not match this request.');
    const actorId = companyWebActor(req);
    const resolvePrincipal = (transaction: RentOpsQueryExecutor) => loadAuthenticatedPrincipal(transaction, { actorId, organizationId, role: 'admin' });
    const principal = await resolvePrincipal(executor);
    res.json(await projects.executeExecution!(kind, envelope, { principal, resolvePrincipal, transport: web }));
  }));
  app.post('/api/company/:organizationId/project-commands/:commandKind', requireAdmin, companyReadHandler(async (req, res) => {
    const organizationId = organizationIdSchema.parse(req.params.organizationId);
    const kind = z.enum(PROJECT_COMMAND_KINDS).parse(req.params.commandKind);
    const envelope = commandEnvelopeSchema(projectCommandPayloadSchemas[kind]).parse(req.body);
    if (envelope.scope.organizationId !== organizationId) throw new ForbiddenCommandError('Project company does not match this request.');
    const actorId = companyWebActor(req);
    const resolvePrincipal = (transaction: RentOpsQueryExecutor) => loadAuthenticatedPrincipal(transaction, { actorId, organizationId, role: 'admin' });
    const principal = await resolvePrincipal(executor);
    res.json(await projects.execute(kind, envelope, { principal, resolvePrincipal, transport: web }));
  }));
}
