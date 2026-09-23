import { createHash } from "node:crypto";
import type { QuickBooksApiResponse, QuickBooksJsonObject } from "../../../shared/accounting/quickbooks";
import { canonicalJsonSha256 } from "../../company/commands/fingerprint";
import { QuickBooksIntegrationError, isQuickBooksRequestNotSent } from "./errors";

/**
 * prepared → validated → started → confirmed | ambiguous | failed. `prepared`
 * and `validated` never reached the provider. `failed` is recorded only for a
 * definitive provider rejection (HTTP 4xx, e.g. a stale SyncToken); any
 * unknown outcome is `ambiguous` and is resolved by readback, never reposted.
 */
export type QuickBooksWriteJournalState = "prepared" | "validated" | "started" | "ambiguous" | "confirmed" | "failed";

export interface QuickBooksWriteJournalEntry {
  readonly operationKey: string;
  readonly requestHash: string;
  readonly state: QuickBooksWriteJournalState;
  readonly providerEntityId?: string;
  readonly providerVersion?: string;
  readonly intuitTid?: string;
}

export interface QuickBooksWriteJournal {
  load(operationKey: string): Promise<QuickBooksWriteJournalEntry | null>;
  save(entry: QuickBooksWriteJournalEntry): Promise<void>;
}

export interface QuickBooksReadbackResult {
  readonly exists: boolean;
  /**
   * A successful provider response is still provisional until an independent
   * GET proves that the persisted entity matches the requested payload. The
   * provider adapter or an application-specific readback may supply this
   * assertion; it is intentionally separate from `exists`.
   */
  readonly matchesRequest?: boolean;
  readonly providerEntity?: QuickBooksJsonObject;
  readonly providerEntityId?: string;
  readonly providerVersion?: string;
  readonly intuitTid?: string;
}

export interface QuickBooksWriteExecutionResult {
  readonly status: "confirmed" | "uncertain";
  readonly providerEntityId?: string;
  readonly providerVersion?: string;
  readonly intuitTid?: string;
}

export interface QuickBooksWriteReconciler {
  execute<TRequest extends QuickBooksJsonObject>(input: {
    readonly operationKey: string;
    readonly request: TRequest;
    /**
     * Identity bound to the operation key when it is wider than the fields
     * compared on readback (e.g. entity, operation, record Id and SyncToken).
     */
    readonly requestIdentity?: QuickBooksJsonObject;
    /**
     * Performs the provider write. It must forward `requestId` to the
     * Accounting client (`create(..., { requestId })` / `update(..., { requestId })`)
     * so that a reconciled retry of the same operation key is de-duplicated
     * by Intuit rather than creating a second provider object.
     */
    readonly write: (context: { readonly requestId: string }) => Promise<QuickBooksApiResponse>;
    readonly readback: () => Promise<QuickBooksReadbackResult>;
  }): Promise<QuickBooksWriteExecutionResult>;
}

function operationKey(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,255}$/.test(value)) throw new QuickBooksIntegrationError("quickbooks_validation", "QuickBooks operation key is invalid");
  return value;
}

/**
 * Intuit de-duplicates writes by `requestid` (at most 50 characters, unique
 * per realm). Operation keys are unique per connection scope in the write
 * journal, so a digest of the key is stable across retries and workers.
 */
export function quickBooksWriteRequestId(operationKeyValue: string): string {
  return `rops-${createHash("sha256").update(operationKey(operationKeyValue), "utf8").digest("hex").slice(0, 40)}`;
}

function providerId(response: QuickBooksApiResponse): string | undefined {
  const value = response.entity.Id ?? response.entity.id;
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function providerVersion(response: QuickBooksApiResponse): string | undefined {
  const value = response.entity.SyncToken ?? response.entity.syncToken;
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function scalarEqual(left: unknown, right: unknown): boolean {
  if (typeof left === "number" || typeof right === "number") return String(left) === String(right);
  return left === right;
}

/** Check the requested fields as a partial provider readback. Provider
 * responses may add server-owned fields, but may not change a requested leaf. */
function payloadMatches(request: QuickBooksJsonObject, provider: QuickBooksJsonObject): boolean {
  const visit = (expected: unknown, actual: unknown): boolean => {
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
      return Object.entries(expected as QuickBooksJsonObject).every(([key, value]) => visit(value, (actual as QuickBooksJsonObject)[key]));
    }
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual) || expected.length !== actual.length) return false;
      return expected.every((value, index) => visit(value, actual[index]));
    }
    return scalarEqual(expected, actual);
  };
  return visit(request, provider);
}

function readbackMatches(input: QuickBooksJsonObject, readback: QuickBooksReadbackResult): boolean {
  if (!readback.exists) return false;
  if (readback.matchesRequest !== undefined) return readback.matchesRequest;
  return readback.providerEntity !== undefined && payloadMatches(input, readback.providerEntity);
}

function unresolvedWriteError(cause?: unknown, intuitTid?: string): QuickBooksIntegrationError {
  return new QuickBooksIntegrationError("quickbooks_ambiguous_write", "QuickBooks write outcome is unresolved; reconcile before retrying", {
    ambiguous: true,
    retryable: false,
    intuitTid,
    cause,
  });
}

/** A provider HTTP 4xx answer to the write itself: the request was refused, not lost. */
function isDefinitiveRejection(error: unknown): error is QuickBooksIntegrationError {
  return error instanceof QuickBooksIntegrationError && !error.ambiguous && typeof error.status === "number" && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
}

async function saveAmbiguous(journal: QuickBooksWriteJournal, entry: QuickBooksWriteJournalEntry): Promise<void> {
  // A journal persistence failure is itself an unknown outcome. Never replace
  // it with `failed`, which would make a later worker replay a provider write.
  try { await journal.save({ ...entry, state: "ambiguous" }); } catch { /* caller receives the safe ambiguous result */ }
}

/**
 * Performs one provider write per operation key. Any ambiguous outcome is
 * reconciled by a deterministic provider read before a caller may decide on
 * a later retry; this helper never blindly replays the write.
 */
export function createQuickBooksWriteReconciler(journal: QuickBooksWriteJournal): QuickBooksWriteReconciler {
  return {
    async execute(input) {
      const key = operationKey(input.operationKey);
      const requestId = quickBooksWriteRequestId(key);
      const requestHash = canonicalJsonSha256(input.requestIdentity ?? input.request);
      const existing = await journal.load(key);
      if (existing && existing.requestHash !== requestHash) throw new QuickBooksIntegrationError("quickbooks_conflict", "QuickBooks operation key is bound to different input");
      if (existing?.state === "confirmed") return { status: "confirmed", ...(existing.providerEntityId ? { providerEntityId: existing.providerEntityId } : {}), ...(existing.providerVersion ? { providerVersion: existing.providerVersion } : {}), ...(existing.intuitTid ? { intuitTid: existing.intuitTid } : {}) };
      if (existing?.state === "started" || existing?.state === "ambiguous" || existing?.state === "failed") {
        let readback: QuickBooksReadbackResult;
        try { readback = await input.readback(); } catch (error) {
          await saveAmbiguous(journal, { ...existing, state: "ambiguous" });
          throw unresolvedWriteError(error, existing.intuitTid);
        }
        if (readbackMatches(input.request, readback)) {
          const confirmed: QuickBooksWriteJournalEntry = { operationKey: key, requestHash, state: "confirmed", ...(readback.providerEntityId ? { providerEntityId: readback.providerEntityId } : {}), ...(readback.providerVersion ? { providerVersion: readback.providerVersion } : {}), ...(readback.intuitTid ? { intuitTid: readback.intuitTid } : {}) };
          try { await journal.save(confirmed); } catch (error) { await saveAmbiguous(journal, { ...confirmed, state: "ambiguous" }); throw unresolvedWriteError(error, readback.intuitTid); }
          return { status: "confirmed", ...readback };
        }
        if (readback.exists) {
          await saveAmbiguous(journal, { ...existing, state: "ambiguous", ...(readback.intuitTid ? { intuitTid: readback.intuitTid } : {}) });
          throw new QuickBooksIntegrationError("quickbooks_conflict", "QuickBooks read-back found an entity that does not match the requested payload", { intuitTid: readback.intuitTid, details: { operationKey: key } });
        }
        // A prior attempt is safe to retry only after the independent readback
        // established that no matching provider object exists.
      }
      // `prepared`/`validated` entries never reached the provider; the first
      // provider attempt starts here.
      try { await journal.save({ operationKey: key, requestHash, state: "started" }); }
      catch (error) { throw new QuickBooksIntegrationError("quickbooks_token_store", "QuickBooks write journal could not be started", { cause: error }); }
      let responded = false;
      try {
        // A retry after a "not found" readback reuses the same requestid, so
        // an original write that Intuit did commit is returned, not duplicated.
        const response = await input.write({ requestId });
        responded = true;
        // Provider success is not enough: a separate read proves the request
        // was committed under the expected identity and fields.
        let readback: QuickBooksReadbackResult;
        try { readback = await input.readback(); } catch (error) {
          await saveAmbiguous(journal, { operationKey: key, requestHash, state: "ambiguous", ...(providerId(response) ? { providerEntityId: providerId(response) } : {}), ...(providerVersion(response) ? { providerVersion: providerVersion(response) } : {}), ...(response.intuitTid ? { intuitTid: response.intuitTid } : {}) });
          throw unresolvedWriteError(error, response.intuitTid);
        }
        if (!readbackMatches(input.request, readback)) {
          await saveAmbiguous(journal, { operationKey: key, requestHash, state: "ambiguous", ...(providerId(response) ? { providerEntityId: providerId(response) } : {}), ...(providerVersion(response) ? { providerVersion: providerVersion(response) } : {}), ...(response.intuitTid ? { intuitTid: response.intuitTid } : {}) });
          if (readback.exists) throw new QuickBooksIntegrationError("quickbooks_conflict", "QuickBooks write read-back did not match the requested payload", { intuitTid: readback.intuitTid ?? response.intuitTid });
          throw unresolvedWriteError(undefined, response.intuitTid);
        }
        const confirmed: QuickBooksWriteJournalEntry = { operationKey: key, requestHash, state: "confirmed", ...(readback.providerEntityId ?? providerId(response) ? { providerEntityId: readback.providerEntityId ?? providerId(response) } : {}), ...(readback.providerVersion ?? providerVersion(response) ? { providerVersion: readback.providerVersion ?? providerVersion(response) } : {}), ...(readback.intuitTid ?? response.intuitTid ? { intuitTid: readback.intuitTid ?? response.intuitTid } : {}) };
        try { await journal.save(confirmed); } catch (error) { await saveAmbiguous(journal, { ...confirmed, state: "ambiguous" }); throw unresolvedWriteError(error, confirmed.intuitTid); }
        return { status: "confirmed", ...(confirmed.providerEntityId ? { providerEntityId: confirmed.providerEntityId } : {}), ...(confirmed.providerVersion ? { providerVersion: confirmed.providerVersion } : {}), ...(confirmed.intuitTid ? { intuitTid: confirmed.intuitTid } : {}) };
      } catch (error) {
        if (!responded && isQuickBooksRequestNotSent(error)) {
          // The request never left this process (capability gate, 429
          // cooldown, token failure, validation). Return the journal to the
          // state it had before this attempt so the next attempt is not held
          // as a possibly recorded write. If that cannot be saved, it stays
          // "started" and is treated as unknown.
          const before: QuickBooksWriteJournalEntry = existing && (existing.state === "ambiguous" || existing.state === "failed") ? existing : { operationKey: key, requestHash, state: "validated" };
          try { await journal.save(before); } catch { /* fail closed */ }
          throw error;
        }
        const intuitTid = error instanceof QuickBooksIntegrationError ? error.intuitTid : undefined;
        if (isDefinitiveRejection(error)) {
          // Intuit answered and refused the request, so nothing was committed.
          try { await journal.save({ operationKey: key, requestHash, state: "failed", ...(intuitTid ? { intuitTid } : {}) }); }
          catch { await saveAmbiguous(journal, { operationKey: key, requestHash, state: "ambiguous", ...(intuitTid ? { intuitTid } : {}) }); }
          throw error;
        }
        await saveAmbiguous(journal, { operationKey: key, requestHash, state: "ambiguous", ...(intuitTid ? { intuitTid } : {}) });
        if (error instanceof QuickBooksIntegrationError && error.code === "quickbooks_conflict") throw error;
        // Any transport/provider exception leaves the side effect unknown. Do
        // not persist `failed` and do not replay under a fresh operation key.
        throw error instanceof QuickBooksIntegrationError && error.ambiguous ? error : unresolvedWriteError(error, intuitTid);
      }
    },
  };
}

export function createInMemoryQuickBooksWriteJournal(): QuickBooksWriteJournal {
  const entries = new Map<string, QuickBooksWriteJournalEntry>();
  return { load: async (key) => entries.get(key) ?? null, save: async (entry) => { entries.set(entry.operationKey, entry); } };
}
