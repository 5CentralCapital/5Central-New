/**
 * Keeps the envelope of a save whose outcome is unknown (for example, the
 * connection dropped after the server committed). Retrying the same change
 * reuses the same operation and idempotency IDs, so the server replays the
 * original receipt instead of saving twice.
 */
export class PendingEnvelopes<TEnvelope> {
  private readonly entries = new Map<string, TEnvelope>();

  static key(kind: string, payload: unknown, expectedRevision?: number): string {
    return JSON.stringify([kind, expectedRevision ?? null, payload]);
  }

  envelopeFor(key: string, create: () => TEnvelope): TEnvelope {
    const existing = this.entries.get(key);
    if (existing) return existing;
    const created = create();
    this.entries.set(key, created);
    return created;
  }

  /** Forget an envelope once the server gave a definite answer. */
  settle(key: string): void {
    this.entries.delete(key);
  }

  get size(): number { return this.entries.size; }
}
