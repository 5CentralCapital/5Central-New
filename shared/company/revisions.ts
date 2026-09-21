import { z } from "zod";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };
export type Revision = Brand<number, "Revision">;

export const revisionSchema = z.number()
  .finite()
  .int("Revision must be an integer")
  .min(1, "Revision must be a positive integer")
  .max(Number.MAX_SAFE_INTEGER, "Revision must be a safe integer")
  .transform((value) => value as Revision);

export function parseRevision(value: unknown): Revision {
  return revisionSchema.parse(value);
}

export function nextRevision(value: Revision | number): Revision {
  const current = parseRevision(value);
  if (current >= Number.MAX_SAFE_INTEGER) throw new RangeError("Revision cannot be incremented safely");
  return parseRevision(current + 1);
}

export class RevisionConflictError extends Error {
  readonly code = "revision_conflict" as const;

  constructor(
    readonly expected: Revision,
    readonly actual: Revision,
  ) {
    super(`Revision conflict: expected ${expected}, current revision is ${actual}`);
    this.name = "RevisionConflictError";
  }
}

/**
 * Server-side optimistic concurrency guard. An omitted expected revision is
 * allowed for creates or explicitly non-versioned commands; edits pass one.
 */
export function assertExpectedRevision(actual: Revision | number, expected?: Revision | number): void {
  if (expected === undefined) return;
  const currentRevision = parseRevision(actual);
  const expectedRevision = parseRevision(expected);
  if (currentRevision !== expectedRevision) throw new RevisionConflictError(expectedRevision, currentRevision);
}
