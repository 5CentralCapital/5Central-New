import { randomUUID } from "node:crypto";
import {
  commandEnvelopeSchema,
  recordReferenceIdSchema,
  type CommandEnvelope,
  type OperationReceipt,
  type Revision,
} from "../../shared/company";
import {
  REVIEW_CASE_REVISIONED_COMMANDS,
  REVIEW_CASE_STATE_LABELS,
  canTransitionReviewCase,
  isResolvedReviewCaseState,
  reviewCaseCommandPayloadSchemas,
  reviewReason,
  type ReviewCaseCommandKind,
  type ReviewCaseState,
  type ReviewEvidence,
  type ReviewProposedCorrection,
} from "../../shared/review-cases";
import type { AuthenticatedPrincipal, CommandAuthorizationPolicy, TransportAttestation } from "../company/authorization";
import { runCompanyCommand, type CommandHandlerContext, type CommandHandlerResult } from "../company/commands/runner";
import { ConflictCommandError, ForbiddenCommandError, ValidationCommandError } from "../company/commands/errors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import type { StorageReadAdapter } from "../rent-ops/storage";
import { reviewCandidateKey } from "../rent-ops/domain/review-detector";
import { applyGuardedCorrection, assertCorrectionTargetInCase, loadEvidenceDocument, planGuardedCorrection } from "./apply";
import { detectCurrentCandidates, operatingDate, runReviewDetectionInTransaction } from "./detection";
import { loadReviewCaseForUpdate, recordReviewCaseEvent, saveReviewCase, type ReviewCaseChanges, type ReviewCaseRow } from "./store";

type AnyEnvelope = CommandEnvelope<Record<string, unknown>>;
type Context = CommandHandlerContext<Record<string, unknown>>;

export interface ReviewCaseCommandAccess {
  readonly principal: AuthenticatedPrincipal;
  readonly resolvePrincipal: (executor: RentOpsQueryExecutor) => Promise<AuthenticatedPrincipal>;
  readonly transport: TransportAttestation;
}

export interface ReviewCaseCommandOptions {
  /** Verified document storage for operational fixes; the guarded writer re-hashes evidence bytes. */
  readonly documentStorage?: StorageReadAdapter;
  readonly now?: () => Date;
}

export const REVIEW_CASE_WRITE_ROLES = ["owner", "admin", "finance", "operations_pm"] as const;
export const REVIEW_CASE_OPERATIONAL_APPLY_ROLES = ["owner", "admin", "operations_pm"] as const;
export const REVIEW_CASE_DETECT_ROLES = ["owner", "admin"] as const;

export const REVIEW_CASE_COMMAND_POLICIES: Readonly<Record<ReviewCaseCommandKind, CommandAuthorizationPolicy>> = Object.freeze({
  "review_case.detect": { commandKind: "review_case.detect", allowedRoles: REVIEW_CASE_DETECT_ROLES, requiredScope: "organization" },
  "review_case.start_research": { commandKind: "review_case.start_research", allowedRoles: REVIEW_CASE_WRITE_ROLES },
  "review_case.add_evidence": { commandKind: "review_case.add_evidence", allowedRoles: REVIEW_CASE_WRITE_ROLES },
  "review_case.propose": { commandKind: "review_case.propose", allowedRoles: REVIEW_CASE_WRITE_ROLES },
  "review_case.block": { commandKind: "review_case.block", allowedRoles: REVIEW_CASE_WRITE_ROLES },
  "review_case.apply": { commandKind: "review_case.apply", allowedRoles: REVIEW_CASE_WRITE_ROLES },
  "review_case.verify": { commandKind: "review_case.verify", allowedRoles: REVIEW_CASE_WRITE_ROLES },
  "review_case.reopen": { commandKind: "review_case.reopen", allowedRoles: REVIEW_CASE_WRITE_ROLES },
  "review_case.note": { commandKind: "review_case.note", allowedRoles: REVIEW_CASE_WRITE_ROLES },
});

function requireRevision(context: Context, current: Revision): void {
  const expected = context.envelope.expectedRevision;
  if (expected === undefined) throw new ValidationCommandError("Supply the review case revision you read before changing it", { reason: "review_case_revision_required" });
  if (expected !== current) {
    throw new ConflictCommandError("This case changed since it was read. Reload it before saving again.", { reason: "revision_conflict", expected, actual: current });
  }
}

function assertTransition(current: ReviewCaseRow, to: ReviewCaseState): void {
  if (!canTransitionReviewCase(current.state, to)) {
    throw new ValidationCommandError(`A ${REVIEW_CASE_STATE_LABELS[current.state].toLowerCase()} case cannot move to ${REVIEW_CASE_STATE_LABELS[to].toLowerCase()}`, {
      reason: "review_case_transition_not_allowed", from: current.state, to,
    });
  }
}

async function loadCase(context: Context, caseId: string): Promise<ReviewCaseRow> {
  const scope = context.envelope.scope;
  return loadReviewCaseForUpdate(context.executor, {
    organizationId: scope.organizationId, caseId, legalEntityId: scope.legalEntityId, propertyId: scope.propertyId,
  });
}

function saved(current: ReviewCaseRow, revision: Revision, message: string, extra: Partial<CommandHandlerResult> = {}): CommandHandlerResult {
  const others = (extra.affectedRecordIds ?? []).filter(id => id !== current.id);
  return {
    state: extra.state ?? "saved_in_rops",
    affectedRecordIds: [current.id, ...others].slice(0, 1_000),
    resultingRevisions: [{ recordId: recordReferenceIdSchema.parse(current.id), revision }],
    validationOutcomes: extra.validationOutcomes ?? [{ code: "review_case.saved", severity: "info", message }],
    ...(extra.outbox ? { outbox: extra.outbox } : {}),
  };
}

async function transition(context: Context, current: ReviewCaseRow, input: {
  to: ReviewCaseState; changes?: ReviewCaseChanges; kind: "transitioned" | "proposed" | "applied" | "verified" | "reopened"; detail?: Record<string, unknown>;
}): Promise<Revision> {
  const changes: ReviewCaseChanges = {
    state: input.to,
    ...(current.state === "blocked" && input.to !== "blocked" ? { blockedOn: null } : {}),
    ...(isResolvedReviewCaseState(input.to) !== isResolvedReviewCaseState(current.state) ? { resolvedAt: isResolvedReviewCaseState(input.to) ? "now" as const : null } : {}),
    ...input.changes,
  };
  const revision = await saveReviewCase(context.executor, current, changes);
  await recordReviewCaseEvent(context.executor, {
    organizationId: current.organizationId, caseId: current.id, revision, kind: input.kind, fromState: current.state, toState: input.to,
    actorId: context.principal.actorId, sourceFingerprint: current.sourceFingerprint, detail: input.detail,
  });
  return revision;
}

function now(options: ReviewCaseCommandOptions): Date { return options.now?.() ?? new Date(); }

function handlers(options: ReviewCaseCommandOptions): Record<ReviewCaseCommandKind, (context: Context) => Promise<CommandHandlerResult>> {
  return {
    async "review_case.detect"(context) {
      const payload = reviewCaseCommandPayloadSchemas["review_case.detect"].parse(context.envelope.payload);
      // Another date than the operating date is a read-only preview: nothing is opened, reopened or verified.
      const summary = await runReviewDetectionInTransaction(context.executor, context.envelope.scope.organizationId, { actorId: context.principal.actorId, asOf: payload.asOf, ...(options.now ? { now: options.now } : {}) });
      const outcomes: Array<NonNullable<CommandHandlerResult["validationOutcomes"]>[number]> = [summary.mode === "preview"
        ? { code: "review_case.detection.preview", severity: "info", message: `Preview as of ${summary.asOf}: ${summary.candidateCount} active causes; ${summary.opened} would open, ${summary.reopened} would reopen. Nothing was changed.` }
        : { code: "review_case.detection.completed", severity: "info", message: `Review detection as of ${summary.asOf}: ${summary.candidateCount} active causes, ${summary.opened} opened, ${summary.updated} updated, ${summary.reopened} reopened, ${summary.autoVerified} verified by readback.` }];
      if (!summary.complete) {
        outcomes.push({ code: "review_case.detection.incomplete", severity: "warning", message: `Detection incomplete: ${summary.incompleteReasons.join(" ") || "some records could not be read."} No case was verified.`.slice(0, 2_000) });
      }
      return {
        state: "saved_in_rops",
        affectedRecordIds: summary.changedCaseIds,
        resultingRevisions: [],
        validationOutcomes: outcomes,
      };
    },
    async "review_case.start_research"(context) {
      const payload = reviewCaseCommandPayloadSchemas["review_case.start_research"].parse(context.envelope.payload);
      const current = await loadCase(context, payload.caseId);
      requireRevision(context, current.recordRevision);
      assertTransition(current, "researching");
      const revision = await transition(context, current, { to: "researching", kind: "transitioned", detail: payload.note ? { note: payload.note } : {} });
      return saved(current, revision, "Research started.");
    },
    async "review_case.add_evidence"(context) {
      const payload = reviewCaseCommandPayloadSchemas["review_case.add_evidence"].parse(context.envelope.payload);
      const current = await loadCase(context, payload.caseId);
      if (context.envelope.expectedRevision !== undefined) requireRevision(context, current.recordRevision);
      if (isResolvedReviewCaseState(current.state)) throw new ValidationCommandError("Reopen the case before adding evidence", { reason: "review_case_resolved" });
      if (current.evidence.length >= 200) throw new ValidationCommandError("This case already holds the maximum evidence items", { reason: "review_case_evidence_limit" });
      let sha256 = payload.evidence.sha256 ?? null;
      if (payload.evidence.documentId) {
        const document = await loadEvidenceDocument(context.executor, current.organizationId, payload.evidence.documentId);
        if (sha256 && sha256 !== document.checksumSha256) throw new ValidationCommandError("The evidence checksum does not match the verified document", { reason: "review_evidence_checksum_mismatch" });
        sha256 = document.checksumSha256;
      }
      const item: ReviewEvidence = {
        id: randomUUID(), kind: payload.evidence.kind, origin: "manual", reference: payload.evidence.reference, summary: payload.evidence.summary,
        documentId: payload.evidence.documentId ?? null, sha256, observedOn: payload.evidence.observedOn ?? null, count: null,
        addedBy: context.principal.actorId, addedAt: now(options).toISOString() as ReviewEvidence["addedAt"],
      };
      const revision = await saveReviewCase(context.executor, current, { evidence: [...current.evidence, item] });
      await recordReviewCaseEvent(context.executor, {
        organizationId: current.organizationId, caseId: current.id, revision, kind: "note", fromState: current.state, toState: current.state,
        actorId: context.principal.actorId, sourceFingerprint: current.sourceFingerprint, detail: { evidenceAdded: item.id, evidenceKind: item.kind, reference: item.reference },
      });
      return saved(current, revision, "Evidence added.");
    },
    async "review_case.propose"(context) {
      const payload = reviewCaseCommandPayloadSchemas["review_case.propose"].parse(context.envelope.payload);
      const current = await loadCase(context, payload.caseId);
      requireRevision(context, current.recordRevision);
      assertTransition(current, "proposed");
      const reason = reviewReason(current.reasonCode);
      const correction = payload.correction;
      if (correction.kind === "operational" && reason.resolution === "connection") {
        throw new ValidationCommandError("This cause is a connection or software gap; propose a connection fix instead of a record change", { reason: "review_case_resolution_mismatch" });
      }
      let preview: ReviewProposedCorrection["preview"] = null;
      if (correction.kind === "operational") {
        await assertCorrectionTargetInCase({
          executor: context.executor, principal: context.principal, allowedRoles: REVIEW_CASE_WRITE_ROLES, reviewCase: current,
          operation: correction.operation, asOf: operatingDate(now(options)),
        });
        // Dry run through the guarded writer: every action runs inside a savepoint and rolls back.
        const plan = await planGuardedCorrection({
          executor: context.executor, storage: options.documentStorage, organizationId: current.organizationId, caseId: current.id,
          caseRevision: current.recordRevision, actorId: context.principal.actorId, operation: correction.operation,
          evidenceDocumentId: correction.evidenceDocumentId, occurredAt: now(options).toISOString(),
        });
        preview = {
          planToken: plan.token,
          changes: plan.changes.slice(0, 50).map(change => ({ targetId: change.targetId, beforeSha256: change.beforeSha256, afterSha256: change.afterSha256, before: change.before, after: change.after })),
          ledgerUnchanged: true,
        };
      }
      const proposal: ReviewProposedCorrection = {
        input: correction, preview, proposedBy: context.principal.actorId, proposedAt: now(options).toISOString() as ReviewProposedCorrection["proposedAt"], routing: null,
      };
      const revision = await transition(context, current, { to: "proposed", kind: "proposed", changes: { proposedCorrection: proposal }, detail: { correctionKind: correction.kind, summary: correction.summary, planToken: preview?.planToken ?? null } });
      return saved(current, revision, correction.kind === "operational" ? "Fix proposed and checked with a dry run. Nothing was changed." : "Fix proposed. Nothing was changed.");
    },
    async "review_case.block"(context) {
      const payload = reviewCaseCommandPayloadSchemas["review_case.block"].parse(context.envelope.payload);
      const current = await loadCase(context, payload.caseId);
      requireRevision(context, current.recordRevision);
      assertTransition(current, "blocked");
      const revision = await transition(context, current, { to: "blocked", kind: "transitioned", changes: { blockedOn: payload.missingFact }, detail: { missingFact: payload.missingFact } });
      return saved(current, revision, "Case blocked on a missing fact.");
    },
    async "review_case.apply"(context) {
      const payload = reviewCaseCommandPayloadSchemas["review_case.apply"].parse(context.envelope.payload);
      const current = await loadCase(context, payload.caseId);
      requireRevision(context, current.recordRevision);
      if (current.state !== "proposed" || !current.proposedCorrection) throw new ValidationCommandError("Only a case with a proposed fix can be applied", { reason: "review_case_transition_not_allowed", from: current.state, to: "applied" });
      const proposal = current.proposedCorrection;
      const input = proposal.input;
      if (input.kind === "connection") {
        throw new ValidationCommandError("Connection and software fixes are made outside this case. Fix the connection, then run detection to verify.", { reason: "review_case_apply_unsupported" });
      }
      if (input.kind === "financial") {
        // Financial corrections belong to the accounting workflow and its authority. Route; never apply here.
        if (proposal.routing) throw new ValidationCommandError("This financial fix is already routed to Accounting", { reason: "review_case_already_routed" });
        const routedAt = now(options).toISOString() as ReviewProposedCorrection["proposedAt"];
        const routing = { status: "routed_to_accounting" as const, reason: "Financial corrections are posted through the accounting workflow, not applied from a review case.", routedAt, routedBy: context.principal.actorId };
        const revision = await saveReviewCase(context.executor, current, { proposedCorrection: { ...proposal, routing } });
        await recordReviewCaseEvent(context.executor, {
          organizationId: current.organizationId, caseId: current.id, revision, kind: "note", fromState: current.state, toState: current.state,
          actorId: context.principal.actorId, sourceFingerprint: current.sourceFingerprint, detail: { routedToAccounting: true, route: input.route, reason: routing.reason },
        });
        return saved(current, revision, "", {
          state: "queued",
          validationOutcomes: [{ code: "review_case.apply.routed_to_accounting", severity: "warning", message: "Not applied: financial corrections are routed to Accounting. The case stays proposed until the accounting fix is verified." }],
          outbox: {
            eventKey: `review_case.financial_correction:${current.id}:${revision}`,
            topic: "review_case.financial_correction",
            payload: { organizationId: current.organizationId, caseId: current.id, reasonCode: current.reasonCode, route: input.route, amountCents: input.amountCents, currency: input.currency, summary: input.summary },
          },
        });
      }
      if (!(REVIEW_CASE_OPERATIONAL_APPLY_ROLES as readonly string[]).includes(context.principal.role)) {
        throw new ForbiddenCommandError("Your role cannot apply operational record fixes", { reason: "role", commandKind: "review_case.apply" });
      }
      if (!proposal.preview) throw new ValidationCommandError("Propose the fix again so it can be checked with a dry run", { reason: "review_case_preview_missing" });
      // Re-check against current records and grants: the proposer's access is not the applier's.
      await assertCorrectionTargetInCase({
        executor: context.executor, principal: context.principal, allowedRoles: REVIEW_CASE_OPERATIONAL_APPLY_ROLES, reviewCase: current,
        operation: input.operation, asOf: operatingDate(now(options)),
      });
      const plan = await applyGuardedCorrection({
        executor: context.executor, storage: options.documentStorage, organizationId: current.organizationId, caseId: current.id,
        caseRevision: current.recordRevision, actorId: context.principal.actorId, operation: input.operation,
        evidenceDocumentId: input.evidenceDocumentId, occurredAt: now(options).toISOString(),
        proposedBeforeHashes: proposal.preview.changes.map(change => change.beforeSha256),
      });
      const revision = await transition(context, current, {
        to: "applied", kind: "applied",
        detail: { planToken: plan.token, operationKind: input.operation.kind, targets: plan.changes.map(change => ({ targetId: change.targetId, beforeSha256: change.beforeSha256, afterSha256: change.afterSha256 })), ledgerUnchanged: plan.ledgerUnchanged },
      });
      return saved(current, revision, "Fix applied through the guarded writer. Verify to confirm the cause is gone.", {
        affectedRecordIds: [current.id, ...plan.changes.map(change => change.targetId)],
      });
    },
    async "review_case.verify"(context) {
      const payload = reviewCaseCommandPayloadSchemas["review_case.verify"].parse(context.envelope.payload);
      const current = await loadCase(context, payload.caseId);
      requireRevision(context, current.recordRevision);
      assertTransition(current, "verified");
      // Saved readback: rerun detection against the committed records in this transaction.
      const readback = await detectCurrentCandidates(context.executor, current.organizationId, operatingDate(now(options)));
      if (!readback.complete) {
        // A cause missing from an incomplete readback proves nothing.
        throw new ConflictCommandError(`Detection is incomplete, so the case cannot be verified yet. ${readback.incompleteReasons[0] ?? ""}`.trim().slice(0, 350), { reason: "review_case_readback_incomplete", incompleteReasons: readback.incompleteReasons.slice(0, 20) });
      }
      const key = reviewCandidateKey(current);
      if (readback.candidates.some(candidate => reviewCandidateKey(candidate) === key)) {
        throw new ValidationCommandError("The cause is still detected. The case stays applied until the readback is clean.", { reason: "review_case_cause_present" });
      }
      const revision = await transition(context, current, { to: "verified", kind: "verified", detail: { readback: "detector", asOf: readback.asOf } });
      return saved(current, revision, "Verified: the cause is no longer detected.");
    },
    async "review_case.reopen"(context) {
      const payload = reviewCaseCommandPayloadSchemas["review_case.reopen"].parse(context.envelope.payload);
      const current = await loadCase(context, payload.caseId);
      requireRevision(context, current.recordRevision);
      assertTransition(current, "open");
      const revision = await transition(context, current, { to: "open", kind: "reopened", changes: { reopenedCount: current.reopenedCount + 1 }, detail: { reason: payload.reason } });
      return saved(current, revision, "Case reopened.");
    },
    async "review_case.note"(context) {
      const payload = reviewCaseCommandPayloadSchemas["review_case.note"].parse(context.envelope.payload);
      const current = await loadCase(context, payload.caseId);
      if (context.envelope.expectedRevision !== undefined) requireRevision(context, current.recordRevision);
      const revision = await saveReviewCase(context.executor, current, {});
      await recordReviewCaseEvent(context.executor, {
        organizationId: current.organizationId, caseId: current.id, revision, kind: "note", fromState: current.state, toState: current.state,
        actorId: context.principal.actorId, sourceFingerprint: current.sourceFingerprint, detail: { note: payload.note },
      });
      return saved(current, revision, "Note added.");
    },
  };
}

/** The single mutation path for browser, Codex and scripts. */
export async function executeReviewCaseCommand(
  executor: RentOpsQueryExecutor,
  kind: ReviewCaseCommandKind,
  rawEnvelope: unknown,
  access: ReviewCaseCommandAccess,
  options: ReviewCaseCommandOptions = {},
): Promise<OperationReceipt> {
  const handler = handlers(options)[kind];
  if (!handler) throw new ValidationCommandError("Unknown review case command", { reason: "unknown_review_case_command" });
  let envelope: AnyEnvelope;
  try {
    envelope = commandEnvelopeSchema(reviewCaseCommandPayloadSchemas[kind]).parse(rawEnvelope) as unknown as AnyEnvelope;
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") {
      const issue = (error as unknown as { issues?: { path: (string | number)[]; message: string }[] }).issues?.[0];
      throw new ValidationCommandError(issue ? `Review case ${issue.path.join(".") || "command"}: ${issue.message}` : "Review case command failed validation", { reason: "invalid_review_case_command_payload" });
    }
    throw error;
  }
  if (REVIEW_CASE_REVISIONED_COMMANDS.includes(kind) && envelope.expectedRevision === undefined) {
    throw new ValidationCommandError("Supply the review case revision you read before changing it", { reason: "review_case_revision_required" });
  }
  return runCompanyCommand(executor, {
    envelope,
    principal: access.principal,
    resolvePrincipal: access.resolvePrincipal,
    transport: access.transport,
    policy: REVIEW_CASE_COMMAND_POLICIES[kind],
    handler: handler as (context: CommandHandlerContext<Record<string, unknown>>) => Promise<CommandHandlerResult>,
  });
}
