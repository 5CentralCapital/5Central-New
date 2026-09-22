import { randomUUID } from "node:crypto";
import type { QuickBooksCapability, QuickBooksConnectionScope } from "../../shared/accounting/quickbooks";
import { financialSourceScopeSchema } from "../../shared/accounting";
import { operationReceiptSchema } from "../../shared/company";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import type { QuickBooksOAuthClient } from "../integrations/quickbooks/oauth";
import { isQuickBooksIntegrationError } from "../integrations/quickbooks/errors";
import { companyCommandStore } from "../company/commands/store";
import { canonicalJsonSha256 } from "../company/commands/fingerprint";
import { PostgresQuickBooksCapabilityStore } from "./capabilities";
import { PostgresQuickBooksTokenRepository } from "./connection-store";
import type { QboTokenCipher } from "./token-crypto";
import { AccountingError } from "./errors";

export const QBO_DISCONNECT_COMMAND_KIND = "accounting.qbo.disconnect";

/** Every capability recorded for a connection scope is disabled on disconnect. */
const DISCONNECT_CAPABILITIES: readonly QuickBooksCapability[] = ["accounting.read", "accounting.create", "accounting.update", "payments", "money_movement", "projects.graphql"];

/**
 * OAuth error codes that mean the refresh token is no longer valid at Intuit,
 * for example because the user already disconnected the app from QuickBooks.
 * Client or request misconfiguration codes are intentionally excluded.
 */
const ALREADY_REVOKED_OAUTH_ERRORS = new Set(["invalid_grant", "invalid_token"]);

export interface QuickBooksDisconnectInput {
  readonly actorId: string;
  readonly channel: "web" | "codex_mcp";
  readonly scope: QuickBooksConnectionScope;
}

export interface QuickBooksDisconnectResult {
  readonly status: "disconnected";
  readonly scope: QuickBooksConnectionScope;
  /** `revoked`: Intuit accepted the revoke. `already_revoked`: Intuit reported
   * the grant was already invalid (for example disconnected inside QuickBooks). */
  readonly providerOutcome: "revoked" | "already_revoked";
  readonly intuitTid: string | null;
  readonly operationId: string;
  readonly disconnectedAt: string;
  readonly reconnectRequired: true;
}

export interface QuickBooksDisconnectDependencies {
  readonly executor: RentOpsQueryExecutor;
  readonly cipher: QboTokenCipher;
  readonly oauth: Pick<QuickBooksOAuthClient, "revokeToken">;
  readonly now?: () => Date;
}

function alreadyRevokedAtProvider(error: unknown): boolean {
  if (!isQuickBooksIntegrationError(error) || error.code !== "quickbooks_oauth") return false;
  if (error.status !== 400 && error.status !== 401) return false;
  const code = error.details.error;
  return typeof code === "string" && ALREADY_REVOKED_OAUTH_ERRORS.has(code);
}

async function writeAudit(executor: RentOpsQueryExecutor, input: QuickBooksDisconnectInput, operationId: string, state: "saved_in_rops" | "failed", message: string, code: string, recordedAt: string): Promise<void> {
  const idempotencyKey = `${QBO_DISCONNECT_COMMAND_KIND}:${operationId}`;
  const payloadSha256 = canonicalJsonSha256({ kind: QBO_DISCONNECT_COMMAND_KIND, scope: input.scope });
  await companyCommandStore.insertReceipt(executor, {
    operationId,
    organizationId: input.scope.organizationId,
    legalEntityId: input.scope.legalEntityId,
    actorId: input.actorId,
    channel: input.channel,
    commandKind: QBO_DISCONNECT_COMMAND_KIND,
    idempotencyKey,
    payloadSha256,
  });
  await companyCommandStore.completeReceipt(executor, input.scope.organizationId, operationId, operationReceiptSchema.parse({
    operationId,
    idempotencyKey,
    state,
    affectedRecordIds: [input.scope.legalEntityId],
    resultingRevisions: [],
    validationOutcomes: [{ code, severity: state === "failed" ? "error" : "info", message }],
    recordedAt,
  }));
}

/**
 * Revoke the latest refresh token at Intuit, then clear the local connection,
 * disable its capabilities, and write the audit receipt in one transaction.
 * Local state is cleared only after the provider accepts the revoke (or
 * reports that the grant is already invalid). An uncertain revoke keeps the
 * connection so the operator can retry; the failed attempt is audited.
 */
export async function disconnectQuickBooksConnection(deps: QuickBooksDisconnectDependencies, input: QuickBooksDisconnectInput): Promise<QuickBooksDisconnectResult> {
  const scope = financialSourceScopeSchema.parse({ provider: "qbo", ...input.scope });
  const connectionScope: QuickBooksConnectionScope = { organizationId: scope.organizationId, legalEntityId: scope.legalEntityId, environment: scope.environment, realmId: scope.realmId };
  const now = deps.now ?? (() => new Date());
  if (!deps.executor.transaction) throw new AccountingError("accounting_configuration", "QuickBooks disconnect requires an atomic company database transaction");
  const stored = await new PostgresQuickBooksTokenRepository(deps.executor, deps.cipher, now).load(connectionScope);
  if (!stored) throw new AccountingError("accounting_not_found", "No active QuickBooks connection exists for this legal entity and realm");
  const operationId = randomUUID();
  let providerOutcome: QuickBooksDisconnectResult["providerOutcome"];
  let intuitTid: string | null = null;
  try {
    const revoked = await deps.oauth.revokeToken(stored.refreshToken);
    providerOutcome = "revoked";
    intuitTid = revoked.intuitTid ?? null;
  } catch (error) {
    if (!alreadyRevokedAtProvider(error)) {
      const retryable = !isQuickBooksIntegrationError(error) || error.retryable || error.code === "quickbooks_timeout" || error.code === "quickbooks_transport";
      const trace = isQuickBooksIntegrationError(error) ? error.intuitTid : undefined;
      try {
        await deps.executor.transaction(transaction => writeAudit(transaction, { ...input, scope: connectionScope }, operationId, "failed", "Intuit did not confirm the QuickBooks token revoke. The connection was kept so disconnect can be retried.", "accounting.qbo.disconnect_unconfirmed", now().toISOString()), { readOnly: false });
      } catch {
        // The provider failure is the actionable result; audit loss must not
        // mask it or report a disconnect that did not happen.
      }
      throw new AccountingError("accounting_unavailable", "QuickBooks did not confirm the disconnect. The connection was kept; try again.", { reason: "qbo_disconnect_unconfirmed", retryable, ...(trace ? { intuitTid: trace } : {}) });
    }
    providerOutcome = "already_revoked";
    intuitTid = isQuickBooksIntegrationError(error) ? error.intuitTid ?? null : null;
  }
  const disconnectedAt = now().toISOString();
  await deps.executor.transaction(async transaction => {
    await new PostgresQuickBooksTokenRepository(transaction, deps.cipher, () => new Date(disconnectedAt)).revoke(connectionScope);
    const capabilities = new PostgresQuickBooksCapabilityStore(transaction);
    for (const capability of DISCONNECT_CAPABILITIES) {
      if (!(await capabilities.load(connectionScope, capability))) continue;
      await capabilities.record({ scope: connectionScope, capability, enabled: false, evidence: "unverified", evidenceVersion: `disconnect:${operationId}`, verifiedAt: disconnectedAt, providerTraceId: intuitTid });
    }
    await writeAudit(transaction, { ...input, scope: connectionScope }, operationId, "saved_in_rops",
      providerOutcome === "revoked"
        ? `QuickBooks ${connectionScope.environment} realm ${connectionScope.realmId} was revoked at Intuit and disconnected.`
        : `QuickBooks ${connectionScope.environment} realm ${connectionScope.realmId} was already disconnected at Intuit; local credentials were cleared.`,
      providerOutcome === "revoked" ? "accounting.qbo.disconnected" : "accounting.qbo.disconnected_provider_already_revoked",
      disconnectedAt);
  }, { readOnly: false });
  return { status: "disconnected", scope: connectionScope, providerOutcome, intuitTid, operationId, disconnectedAt, reconnectRequired: true };
}
