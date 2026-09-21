import type { Express, RequestHandler } from 'express';
import { z } from 'zod';
import { organizationIdSchema, legalEntityIdSchema, propertyReferenceIdSchema, commandEnvelopeSchema, isoDateSchema } from '../../shared/company';
import { PROJECT_COMMAND_KINDS, projectCommandPayloadSchemas, projectIdSchema, projectStatusSchema } from '../../shared/projects/contracts';
import type { ProjectCommandKind, ProjectListQuery, ProjectReadContext } from '../../shared/projects/contracts';
import type { RentOpsQueryExecutor } from '../rent-ops/repositories/postgres';
import { loadAuthenticatedPrincipal, attestTransport, type AuthenticatedPrincipal, type TransportAttestation } from './authorization';
import { readCompanyContext } from './context';
import { ForbiddenCommandError } from './commands/errors';
import { companyReadHandler, companyWebActor } from './http';

export interface CompanyProjectPort {
  list(principal: AuthenticatedPrincipal, query: ProjectListQuery): Promise<unknown>;
  get(principal: AuthenticatedPrincipal, query: ProjectReadContext & { projectId: string }): Promise<unknown>;
  execute(kind: ProjectCommandKind, envelope: unknown, access: {
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
}): void {
  const { executor, requireAdmin, projects } = options;
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
