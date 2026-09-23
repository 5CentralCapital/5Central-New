import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { commandEnvelopeSchema, organizationIdSchema, recordReferenceIdSchema, type CommandEnvelope, type OperationReceipt } from "../../shared/company";
import {
  JOB_COMMAND_KINDS,
  JOB_MCP_TOOL_NAMES,
  JOB_STATES,
  jobCommandPayloadSchemas,
  jobListQuerySchema,
  jobTopicSchema,
  requeueJobPayloadSchema,
  cancelJobPayloadSchema,
  type JobCommandKind,
  type JobDetail,
  type JobListQuery,
  type JobListResponse,
} from "../../shared/accounting/operations";
import {
  attestTransport,
  authorizeCompanyRead,
  loadAuthenticatedPrincipal,
  type AuthenticatedPrincipal,
  type CommandAuthorizationPolicy,
  type TransportAttestation,
} from "../company/authorization";
import { ConflictCommandError, ForbiddenCommandError, ValidationCommandError } from "../company/commands/errors";
import { runCompanyCommand, type CommandHandlerContext, type CommandHandlerResult } from "../company/commands/runner";
import { companyReadHandler, companyWebActor } from "../company/http";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { PostgresJobQueue } from "./queue";

/*
 * Operator surface for durable jobs: organization owners and admins can list
 * and inspect their organization's jobs, requeue dead jobs and cancel work
 * that is not running. Web and Codex call the same port.
 */

const OPERATOR_ROLES = ["owner", "admin"] as const;

export const JOB_COMMAND_POLICIES: Readonly<Record<JobCommandKind, CommandAuthorizationPolicy>> = Object.freeze({
  "job.requeue": { commandKind: "job.requeue", allowedRoles: OPERATOR_ROLES, requiredScope: "organization" },
  "job.cancel": { commandKind: "job.cancel", allowedRoles: OPERATOR_ROLES, requiredScope: "organization" },
});

export interface JobCommandAccess {
  readonly principal: AuthenticatedPrincipal;
  readonly resolvePrincipal: (executor: RentOpsQueryExecutor) => Promise<AuthenticatedPrincipal>;
  readonly transport: TransportAttestation;
}

export interface JobsPort {
  list(principal: AuthenticatedPrincipal, query: JobListQuery): Promise<JobListResponse>;
  get(principal: AuthenticatedPrincipal, input: { readonly organizationId: string; readonly jobId: string }): Promise<JobDetail>;
  execute(kind: JobCommandKind, envelope: unknown, access: JobCommandAccess): Promise<OperationReceipt>;
}

type Context = CommandHandlerContext<Record<string, unknown>>;

function receipt(jobId: string, message: string): CommandHandlerResult {
  return { state: "saved_in_rops", affectedRecordIds: [recordReferenceIdSchema.parse(jobId)], resultingRevisions: [], validationOutcomes: [{ code: "job.updated", severity: "info", message }] };
}

async function handleRequeue(context: Context): Promise<CommandHandlerResult> {
  const payload = requeueJobPayloadSchema.parse(context.envelope.payload);
  const queue = new PostgresJobQueue(context.executor);
  const job = await queue.get(payload.jobId, context.envelope.scope.organizationId);
  if (!job) throw new ValidationCommandError("Job was not found in this company", { reason: "job_not_found" });
  if (job.state !== "dead") throw new ConflictCommandError("Only a failed (dead) job can be requeued", { reason: "job_not_dead", state: job.state });
  const updated = await queue.requeue(job.id, context.envelope.scope.organizationId, payload.additionalAttempts);
  if (!updated) throw new ConflictCommandError("The job changed while it was being requeued", { reason: "job_state_changed" });
  return receipt(updated.id, "Job requeued for the background worker.");
}

async function handleCancel(context: Context): Promise<CommandHandlerResult> {
  const payload = cancelJobPayloadSchema.parse(context.envelope.payload);
  const queue = new PostgresJobQueue(context.executor);
  const job = await queue.get(payload.jobId, context.envelope.scope.organizationId);
  if (!job) throw new ValidationCommandError("Job was not found in this company", { reason: "job_not_found" });
  if (job.state === "running") throw new ConflictCommandError("A running job cannot be cancelled; wait for its attempt to finish", { reason: "job_running" });
  if (job.state === "succeeded" || job.state === "cancelled") throw new ConflictCommandError("The job has already finished", { reason: "job_finished", state: job.state });
  const updated = await queue.cancel(job.id, context.envelope.scope.organizationId);
  if (!updated) throw new ConflictCommandError("The job changed while it was being cancelled", { reason: "job_state_changed" });
  return receipt(updated.id, "Job cancelled.");
}

const handlers: Record<JobCommandKind, (context: Context) => Promise<CommandHandlerResult>> = { "job.requeue": handleRequeue, "job.cancel": handleCancel };

export async function executeJobCommand(executor: RentOpsQueryExecutor, kind: JobCommandKind, rawEnvelope: unknown, access: JobCommandAccess): Promise<OperationReceipt> {
  const handler = handlers[kind];
  if (!handler) throw new ValidationCommandError("Unknown job command", { reason: "unknown_job_command" });
  const parsed = commandEnvelopeSchema(jobCommandPayloadSchemas[kind]).safeParse(rawEnvelope);
  if (!parsed.success) throw new ValidationCommandError("Job command failed validation", { reason: "invalid_job_command" });
  return runCompanyCommand(executor, {
    envelope: parsed.data as unknown as CommandEnvelope<Record<string, unknown>>,
    principal: access.principal, resolvePrincipal: access.resolvePrincipal, transport: access.transport,
    policy: JOB_COMMAND_POLICIES[kind], handler,
  });
}

export function createJobsPort(executor: RentOpsQueryExecutor): JobsPort {
  async function read<T>(principal: AuthenticatedPrincipal, organizationId: string, work: (queue: PostgresJobQueue) => Promise<T>): Promise<T> {
    if (!executor.transaction) throw new ValidationCommandError("Job reads require transaction support", { reason: "transaction_required" });
    return executor.transaction(async transaction => {
      const fresh = await loadAuthenticatedPrincipal(transaction, { actorId: principal.actorId, organizationId: principal.organizationId, role: principal.role });
      authorizeCompanyRead(fresh, { organizationId: organizationIdSchema.parse(organizationId) }, OPERATOR_ROLES);
      return work(new PostgresJobQueue(transaction));
    }, { readOnly: true });
  }
  return {
    list: (principal, query) => read(principal, query.organizationId, queue => queue.list(query)),
    get: (principal, input) => read(principal, input.organizationId, async queue => {
      const detail = await queue.detail(z.string().uuid().parse(input.jobId), input.organizationId);
      if (!detail) throw new ValidationCommandError("Job was not found in this company", { reason: "job_not_found" });
      return detail;
    }),
    execute: (kind, envelope, access) => executeJobCommand(executor, kind, envelope, access),
  };
}

const csv = <T extends readonly [string, ...string[]]>(values: T) => z.string().trim().min(1).max(200)
  .transform(value => value.split(",").map(item => item.trim()).filter(Boolean)).pipe(z.array(z.enum(values)).min(1).max(values.length));

export function registerJobRoutes(app: Express, options: { readonly executor: RentOpsQueryExecutor; readonly requireAdmin: RequestHandler; readonly jobs: JobsPort }): void {
  const { executor, requireAdmin, jobs } = options;
  const web = attestTransport("web");
  const principalFor = (actorId: string, organizationId: string, connection: RentOpsQueryExecutor = executor) => loadAuthenticatedPrincipal(connection, { actorId, organizationId, role: "admin" });
  app.get("/api/company/:organizationId/jobs", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const query = z.object({
      state: csv(JOB_STATES).optional(),
      topic: z.string().trim().min(1).max(400).transform(value => value.split(",").map(item => item.trim()).filter(Boolean)).pipe(z.array(jobTopicSchema).min(1).max(20)).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().min(1).max(512).optional(),
    }).strict().parse(request.query);
    const principal = await principalFor(companyWebActor(request), organizationId);
    response.json(await jobs.list(principal, jobListQuerySchema.parse({ organizationId, limit: query.limit, ...(query.cursor ? { cursor: query.cursor } : {}), ...(query.state ? { states: query.state } : {}), ...(query.topic ? { topics: query.topic } : {}) })));
  }));
  app.get("/api/company/:organizationId/jobs/:jobId", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const principal = await principalFor(companyWebActor(request), organizationId);
    response.json(await jobs.get(principal, { organizationId, jobId: String(request.params.jobId) }));
  }));
  app.post("/api/company/:organizationId/job-commands/:commandKind", requireAdmin, companyReadHandler(async (request, response) => {
    const organizationId = organizationIdSchema.parse(request.params.organizationId);
    const kind = z.enum(JOB_COMMAND_KINDS).parse(request.params.commandKind);
    const envelope = commandEnvelopeSchema(jobCommandPayloadSchemas[kind]).parse(request.body);
    if (envelope.scope.organizationId !== organizationId) throw new ForbiddenCommandError("Job company does not match this request.");
    const actorId = companyWebActor(request);
    const resolvePrincipal = (transaction: RentOpsQueryExecutor) => principalFor(actorId, organizationId, transaction);
    response.json(await jobs.execute(kind, envelope, { principal: await resolvePrincipal(executor), resolvePrincipal, transport: web }));
  }));
}

export type JobToolRegistrar = (name: string, description: string, schema: z.ZodRawShape, write: boolean, handler: (args: any) => Promise<unknown>) => void;

export function registerJobMcpTools(register: JobToolRegistrar, options: { readonly executor: RentOpsQueryExecutor; readonly jobs: JobsPort; readonly actorId: string }): void {
  const { executor, jobs, actorId } = options;
  const transport = attestTransport("codex_mcp");
  const principalFor = (organizationId: string, connection: RentOpsQueryExecutor = executor) => loadAuthenticatedPrincipal(connection, { actorId, organizationId, role: "admin" });
  register("list_jobs", "List this organization's background jobs (QuickBooks sync, webhook fetches, writes) newest first, with state counts. Owners and admins only. Follow nextCursor to continue.", { query: jobListQuerySchema }, false,
    async ({ query }) => jobs.list(await principalFor(query.organizationId), query));
  register("get_job", "Read one background job with its attempts, last redacted error, checkpoint and result. Owners and admins only.", { organizationId: organizationIdSchema, jobId: z.string().uuid() }, false,
    async ({ organizationId, jobId }) => jobs.get(await principalFor(organizationId), { organizationId, jobId }));
  const descriptions: Readonly<Record<JobCommandKind, string>> = {
    "job.requeue": "Requeue a dead (failed) job with additional attempts after fixing its cause.",
    "job.cancel": "Cancel a queued, retrying or dead job. Running jobs cannot be cancelled.",
  };
  for (const kind of JOB_COMMAND_KINDS) {
    register(JOB_MCP_TOOL_NAMES[kind], `${descriptions[kind]} Organization scope only; owners and admins. Supply a stable operationId/idempotencyKey.`,
      { command: commandEnvelopeSchema(jobCommandPayloadSchemas[kind]) }, true,
      async ({ command }) => {
        const organizationId = organizationIdSchema.parse(command.scope.organizationId);
        return jobs.execute(kind, command, { principal: await principalFor(organizationId), transport, resolvePrincipal: connection => principalFor(organizationId, connection) });
      });
  }
}
