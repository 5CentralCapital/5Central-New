import type { ProjectCommandKind, ProjectExecutionCommandKind } from "@shared/projects";
import type { CompanyScope } from "@shared/company/scope";
import { createProjectCommandEnvelope } from "./api";
import type { ProjectCommandEnvelope } from "./types";

type PendingEnvelope = ProjectCommandEnvelope<unknown>;

export class PendingProjectCommandError extends Error {
  readonly pending = true as const;

  constructor() {
    super("A previous save has an unknown outcome. Retry that save before changing its values.");
    this.name = "PendingProjectCommandError";
  }
}

export interface PendingProjectCommand {
  readonly kind: ProjectCommandKind | ProjectExecutionCommandKind;
  readonly envelope: PendingEnvelope;
}

export type ProjectWriteCommandKind = ProjectCommandKind | ProjectExecutionCommandKind;

function commandFingerprint<TPayload>(
  kind: ProjectWriteCommandKind,
  scope: CompanyScope,
  payload: TPayload,
  expectedRevision?: number,
): string {
  return JSON.stringify({ kind, scope, expectedRevision: expectedRevision ?? null, payload });
}

/**
 * Keeps a command envelope stable while a request has an unknown outcome.
 * A retry of the same form values therefore carries the same operation and
 * idempotency key to the server.
 */
export class PendingProjectCommandStore {
  private pending?: { fingerprint: string; kind: ProjectWriteCommandKind; envelope: PendingEnvelope };

  getOrCreate<TPayload>(
    kind: ProjectWriteCommandKind,
    scope: CompanyScope,
    payload: TPayload,
    expectedRevision?: number,
  ): ProjectCommandEnvelope<TPayload> {
    const fingerprint = commandFingerprint(kind, scope, payload, expectedRevision);
    if (this.pending?.fingerprint === fingerprint) {
      return this.pending.envelope as ProjectCommandEnvelope<TPayload>;
    }
    if (this.pending) throw new PendingProjectCommandError();
    const envelope = createProjectCommandEnvelope(scope, payload, expectedRevision);
    this.pending = { fingerprint, kind, envelope: envelope as PendingEnvelope };
    return envelope;
  }

  getPending(): PendingProjectCommand | undefined {
    if (!this.pending) return undefined;
    return { kind: this.pending.kind, envelope: this.pending.envelope };
  }

  resolve(): void {
    this.pending = undefined;
  }

  clear(): void {
    this.pending = undefined;
  }

  clearForError(error: unknown): void {
    const status = typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
    if (status === 400 || status === 403 || status === 409) this.pending = undefined;
  }
}
