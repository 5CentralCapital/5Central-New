import { randomUUID } from "node:crypto";
import type { QuickBooksConnectionScope, QuickBooksOAuthTokenSet, QuickBooksStoredToken } from "../../shared/accounting/quickbooks";
import type { FinancialSourceReadPort, FinancialSourceAllocationPort, FinancialProviderPaymentContextPort, FinancialProviderCostContextPort } from "../../shared/accounting";
import { legalEntityIdSchema, organizationIdSchema } from "../../shared/company";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { createQuickBooksAccountingClient, type QuickBooksAccountingClient } from "../integrations/quickbooks/accounting";
import { createQuickBooksOAuthClient, type QuickBooksOAuthClient } from "../integrations/quickbooks/oauth";
import { createQuickBooksReportsClient, type QuickBooksReportsClient } from "../integrations/quickbooks/reports";
import { createQuickBooksFetchTransport, type QuickBooksFetchTransportOptions } from "../integrations/quickbooks/transport";
import { createQuickBooksTokenManager, type QuickBooksTokenManager } from "../integrations/quickbooks/token-manager";
import { createQuickBooksCapabilityGate, PostgresQuickBooksCapabilityStore, type QuickBooksCapabilityGate, type QuickBooksCapabilityStore } from "./capabilities";
import { disconnectQuickBooksConnection, type QuickBooksDisconnectInput, type QuickBooksDisconnectResult } from "./disconnect";
import { createQuickBooksOAuthConnectionService, PostgresQuickBooksOAuthStateStore, type QuickBooksOAuthConnectionService } from "./oauth-state";
import { createQboAccountingMirrorStore, type QboAccountingMirrorStore } from "./mirror-store";
import type { AccountingPurposeMappingPort } from "./purpose";
import { createQboProviderSync, type QboProviderSync } from "./provider-sync";
import { PostgresQuickBooksPendingBindingStore, companyInfoHash, type QuickBooksPendingBindingPreview, type QuickBooksRealmBindingProof } from "./binding";
import { PostgresQuickBooksRefreshLease, newQuickBooksRefreshLeaseOwner, type QuickBooksRefreshLease } from "./refresh-lease";
import { createConfiguredQboTokenCipher, type QboTokenCipher } from "./token-crypto";
import { createQuickBooksTokenRepository, PostgresQuickBooksTokenRepository } from "./connection-store";
import { AccountingError } from "./errors";
import { isQuickBooksIntegrationError } from "../integrations/quickbooks/errors";
import { authorizeCompanyRead, loadAuthenticatedPrincipal } from "../company/authorization";

const ACCOUNTING_MUTATION_ROLES = ["owner", "admin", "finance"] as const;

export interface AccountingQboConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly environment: "sandbox" | "production";
  readonly transport?: QuickBooksFetchTransportOptions;
  /**
   * Resolve OAuth endpoints from Intuit's discovery document. Defaults on for
   * the real fetch transport and off when a fetch implementation is injected
   * (tests, recorders), unless set explicitly. `QBO_OAUTH_DISCOVERY=off`
   * disables it for a deployment.
   */
  readonly discovery?: boolean;
  readonly now?: () => Date;
  readonly tokenCipher?: QboTokenCipher;
  readonly refreshLease?: QuickBooksRefreshLease;
  readonly refreshLeaseOwnerId?: string;
  readonly refreshLeaseTtlMs?: number;
  /** Server-side entity/company identity proof before a realm is persisted. */
  readonly verifyRealmBinding?: (input: { readonly actorId: string; readonly organizationId: string; readonly legalEntityId: string; readonly environment: "sandbox" | "production"; readonly realmId: string; readonly expectedRealmId: string | null; readonly token: QuickBooksOAuthTokenSet }) => Promise<QuickBooksRealmBindingProof | void>;
}

export interface AccountingServicesOptions {
  readonly qbo?: Partial<AccountingQboConfig>;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface ConfiguredAccountingQboServices {
  readonly status: "configured";
  readonly environment: "sandbox" | "production";
  readonly oauth: QuickBooksOAuthClient;
  readonly tokenManager: QuickBooksTokenManager;
  readonly tokenRepository: PostgresQuickBooksTokenRepository;
  readonly capabilityGate: QuickBooksCapabilityGate;
  /** Evidence store behind the gate. Enabling requires live provider read-back. */
  readonly capabilityStore: QuickBooksCapabilityStore;
  readonly oauthConnection: QuickBooksOAuthConnectionService;
  /** Revoke at Intuit, then clear the local connection, disable its
   * capabilities, and audit. Shared by HTTP and MCP adapters. */
  disconnect(input: QuickBooksDisconnectInput): Promise<QuickBooksDisconnectResult>;
  previewPendingBinding(input: {
    readonly executor: RentOpsQueryExecutor;
    readonly pendingId: string;
    readonly actorId: string;
    readonly sessionBindingHash: string | null;
    readonly organizationId: string;
    readonly legalEntityId: string;
  }): Promise<QuickBooksPendingBindingPreview | null>;
  createAccountingClient(scope: QuickBooksConnectionScope): QuickBooksAccountingClient;
  createReportsClient(scope: QuickBooksConnectionScope): QuickBooksReportsClient;
  createProviderSync(scope: QuickBooksConnectionScope): QboProviderSync;
}

export interface UnconfiguredAccountingQboServices {
  readonly status: "unconfigured";
  readonly reason: "missing_configuration" | "invalid_configuration";
}

export interface AccountingServices {
  readonly financialSourceReadPort: FinancialSourceReadPort;
  readonly financialSourceAllocationPort: FinancialSourceAllocationPort;
  readonly financialProviderPaymentContextPort: FinancialProviderPaymentContextPort;
  readonly financialProviderCostContextPort: FinancialProviderCostContextPort;
  readonly purposeMappings: AccountingPurposeMappingPort;
  readonly mirror: QboAccountingMirrorStore;
  readonly qbo: ConfiguredAccountingQboServices | UnconfiguredAccountingQboServices;
}

interface PersistRealmBindingInput {
  readonly actorId: string;
  readonly pendingId: string;
  readonly scope: QuickBooksConnectionScope;
  readonly proof: QuickBooksRealmBindingProof;
}

/** Persist the CompanyInfo proof and its local identity fence on an existing
 * transaction. The caller owns the transaction boundary so token persistence,
 * confirmation audit, and pending-handoff consumption can commit together. */
async function persistRealmBindingInTransaction(transaction: RentOpsQueryExecutor, input: PersistRealmBindingInput): Promise<void> {
  const sourceScope = `qbo:${input.scope.environment}:${input.scope.realmId}`;
  const currentResult = await transaction.query<{ realm_id: unknown; provider_company_id: unknown; company_info_hash: unknown }>(
    `SELECT realm_id, provider_company_id, company_info_hash
       FROM accounting_qbo_realm_bindings
      WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3`,
    [input.scope.organizationId, input.scope.legalEntityId, input.scope.environment],
  );
  const current = currentResult.rows[0];
  if (!current) {
    await transaction.query(
      `INSERT INTO accounting_qbo_realm_bindings
        (organization_id, legal_entity_id, environment, realm_id,
         provider_company_id, provider_company_name, provider_legal_name,
         home_currency, evidence_version, company_info_hash, confirmed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT DO NOTHING`,
      [input.scope.organizationId, input.scope.legalEntityId, input.scope.environment, input.scope.realmId,
        input.proof.providerCompanyId, input.proof.providerCompanyName, input.proof.providerLegalName,
        input.proof.homeCurrency, input.proof.evidenceVersion, input.proof.companyInfoHash, input.actorId],
    );
    const bindingResult = await transaction.query<{
      realm_id: unknown;
      provider_company_id: unknown;
      company_info_hash: unknown;
    }>(
      `SELECT realm_id, provider_company_id, company_info_hash
         FROM accounting_qbo_realm_bindings
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3
        `,
      [input.scope.organizationId, input.scope.legalEntityId, input.scope.environment],
    );
    const binding = bindingResult.rows[0];
    if (!binding
      || String(binding.realm_id) !== input.scope.realmId
      || String(binding.provider_company_id) !== input.proof.providerCompanyId
      || String(binding.company_info_hash) !== input.proof.companyInfoHash) {
      throw new AccountingError("accounting_conflict", "QuickBooks CompanyInfo binding was claimed by another legal entity or realm");
    }
    const realmResult = await transaction.query<{ legal_entity_id: unknown; provider_company_id: unknown }>(
      `SELECT legal_entity_id, provider_company_id
         FROM accounting_qbo_realm_bindings
        WHERE organization_id=$1 AND environment=$2 AND realm_id=$3::varchar
        `,
      [input.scope.organizationId, input.scope.environment, input.scope.realmId],
    );
    const realm = realmResult.rows[0];
    if (!realm
      || String(realm.legal_entity_id) !== input.scope.legalEntityId
      || String(realm.provider_company_id) !== input.proof.providerCompanyId) {
      throw new AccountingError("accounting_conflict", "QuickBooks realm identity is already bound to another legal entity");
    }
  } else if (String(current.realm_id) !== input.scope.realmId || String(current.provider_company_id) !== input.proof.providerCompanyId) {
    // A reconnect may return updated CompanyInfo display metadata. The stable
    // identity fence is the realm plus CompanyInfo.Id; the immutable realm row
    // keeps its original evidence while each confirmation records fresh proof.
    throw new AccountingError("accounting_conflict", "QuickBooks CompanyInfo binding changed while reconnecting");
  }
  await transaction.query(
    `INSERT INTO company_external_identities
     (id, organization_id, legal_entity_id, provider, source_scope, record_kind, external_id, local_kind, local_id)
     VALUES ($1,$2,$3,'qbo',$4,'CompanyInfo',$5,'legal_entity',$6)
     ON CONFLICT (organization_id, provider, source_scope, record_kind, external_id) DO NOTHING`,
    [randomUUID(), input.scope.organizationId, input.scope.legalEntityId, sourceScope, input.proof.providerCompanyId, input.scope.legalEntityId],
  );
  const persisted = await transaction.query<{ external_id: unknown; local_id: unknown }>(
    `SELECT external_id, local_id FROM company_external_identities
      WHERE organization_id=$1 AND provider='qbo' AND source_scope=$2 AND record_kind='CompanyInfo' AND external_id=$3`,
    [input.scope.organizationId, sourceScope, input.proof.providerCompanyId],
  );
  const identity = persisted.rows[0];
  if (!identity || String(identity.local_id) !== input.scope.legalEntityId || String(identity.external_id) !== input.proof.providerCompanyId) {
    throw new AccountingError("accounting_conflict", "QuickBooks CompanyInfo binding was claimed by another legal entity");
  }
  await transaction.query(
    `INSERT INTO accounting_qbo_binding_confirmations
      (confirmation_id, pending_id, organization_id, legal_entity_id, environment, realm_id, provider_company_id, company_info_hash, confirmed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (pending_id) DO NOTHING`,
    [randomUUID(), input.pendingId, input.scope.organizationId, input.scope.legalEntityId, input.scope.environment, input.scope.realmId, input.proof.providerCompanyId, input.proof.companyInfoHash, input.actorId],
  );
}

function environmentConfig(options: AccountingServicesOptions): AccountingQboConfig | null {
  const env = options.environment ?? process.env;
  const supplied = options.qbo ?? {};
  const clientId = supplied.clientId ?? env.QBO_CLIENT_ID;
  const clientSecret = supplied.clientSecret ?? env.QBO_CLIENT_SECRET;
  const redirectUri = supplied.redirectUri ?? env.QBO_REDIRECT_URI;
  const environment = supplied.environment ?? (env.QBO_ENVIRONMENT === "production" ? "production" : env.QBO_ENVIRONMENT === "sandbox" ? "sandbox" : undefined);
  if (!clientId || !clientSecret || !redirectUri || !environment) return null;
  const discovery = supplied.discovery ?? (env.QBO_OAUTH_DISCOVERY !== "off" && !supplied.transport?.fetchImpl);
  return { clientId, clientSecret, redirectUri, environment, transport: supplied.transport, discovery, now: supplied.now, tokenCipher: supplied.tokenCipher, refreshLease: supplied.refreshLease, refreshLeaseOwnerId: supplied.refreshLeaseOwnerId, refreshLeaseTtlMs: supplied.refreshLeaseTtlMs, verifyRealmBinding: supplied.verifyRealmBinding };
}

/**
 * Assemble accounting services without requiring QBO configuration at app
 * startup. Every QBO client created here is capability-gated per connection.
 */
export function createAccountingServices(executor: RentOpsQueryExecutor, options: AccountingServicesOptions = {}): AccountingServices {
  const mirror = createQboAccountingMirrorStore(executor);
  const purposeMappings = mirror.purposeMappings;
  const config = environmentConfig(options);
  if (!config) return { financialSourceReadPort: mirror, financialSourceAllocationPort: mirror, financialProviderPaymentContextPort: mirror, financialProviderCostContextPort: mirror, purposeMappings, mirror, qbo: { status: "unconfigured", reason: "missing_configuration" } };
  try {
    const cipher = config.tokenCipher ?? createConfiguredQboTokenCipher(options.environment ?? process.env);
    const tokenRepository = createQuickBooksTokenRepository(executor, cipher);
    const pendingBindingStore = new PostgresQuickBooksPendingBindingStore(executor, cipher);
    const lease = config.refreshLease ?? new PostgresQuickBooksRefreshLease(executor, config.now);
    const leaseOwner = config.refreshLeaseOwnerId ?? newQuickBooksRefreshLeaseOwner();
    const transport = createQuickBooksFetchTransport(config.transport);
    const oauth = createQuickBooksOAuthClient({ clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri, environment: config.environment, transport, now: config.now, discovery: { enabled: config.discovery === true } });
    const defaultLeaseTtlMs = Math.min(600_000, Math.max(180_000, (config.transport?.timeoutMs ?? 15_000) * 2 + 10_000));
    const tokenManager = createQuickBooksTokenManager({ oauth, repository: tokenRepository, now: config.now, refreshLease: lease, refreshLeaseOwnerId: leaseOwner, refreshLeaseTtlMs: config.refreshLeaseTtlMs ?? defaultLeaseTtlMs });
    const capabilityStore = new PostgresQuickBooksCapabilityStore(executor);
    const capabilityGate = createQuickBooksCapabilityGate(capabilityStore);
    const verifyRealmBinding = config.verifyRealmBinding ?? (async (input: { readonly actorId: string; readonly organizationId: string; readonly legalEntityId: string; readonly environment: "sandbox" | "production"; readonly realmId: string; readonly expectedRealmId: string | null; readonly token: QuickBooksOAuthTokenSet }): Promise<QuickBooksRealmBindingProof> => {
      const verifier = createQuickBooksAccountingClient({
        scope: { organizationId: input.organizationId, legalEntityId: input.legalEntityId, environment: input.environment, realmId: input.realmId },
        getAccessToken: async () => input.token.accessToken,
        transport,
      });
      const result = await verifier.read("CompanyInfo", input.realmId);
      const providerId = result.entity.Id;
      if ((typeof providerId !== "string" && typeof providerId !== "number") || String(providerId).trim().length === 0) throw new AccountingError("accounting_conflict", "QuickBooks CompanyInfo.Id identity could not be verified");
      if (input.expectedRealmId !== null && input.expectedRealmId !== input.realmId) throw new AccountingError("accounting_conflict", "QuickBooks realm does not match the existing legal-entity binding");
      const sourceScope = `qbo:${input.environment}:${input.realmId}`;
      const existing = await executor.query<{ source_scope: unknown; external_id: unknown; local_id: unknown }>(
        `SELECT source_scope, external_id, local_id
           FROM company_external_identities
          WHERE organization_id=$1 AND provider='qbo'
            AND record_kind='CompanyInfo' AND local_kind='legal_entity'
          ORDER BY created_at DESC`,
        [input.organizationId],
      );
      const sameRealm = existing.rows.find(row => row.source_scope === sourceScope);
      if (sameRealm && String(sameRealm.local_id) !== input.legalEntityId) throw new AccountingError("accounting_conflict", "Persisted QuickBooks CompanyInfo identity is bound to another legal entity");
      if (sameRealm && String(sameRealm.external_id) !== String(providerId)) throw new AccountingError("accounting_conflict", "Persisted QuickBooks CompanyInfo identity does not match this realm");
      const otherRealm = existing.rows.find(row => typeof row.source_scope === "string" && row.source_scope.startsWith(`qbo:${input.environment}:`) && row.source_scope !== sourceScope && String(row.local_id) === input.legalEntityId);
      if (otherRealm) throw new AccountingError("accounting_conflict", "This legal entity is already bound to a different QuickBooks company");
      const providerBody = result.entity;
      const metadata = providerBody.MetaData && typeof providerBody.MetaData === "object" && !Array.isArray(providerBody.MetaData) ? providerBody.MetaData as Record<string, unknown> : {};
      const homeCurrencyValue = providerBody.HomeCurrency && typeof providerBody.HomeCurrency === "object" && !Array.isArray(providerBody.HomeCurrency)
        ? (providerBody.HomeCurrency as Record<string, unknown>).value
        : providerBody.HomeCurrency ?? (providerBody.CurrencyRef && typeof providerBody.CurrencyRef === "object" && !Array.isArray(providerBody.CurrencyRef) ? (providerBody.CurrencyRef as Record<string, unknown>).value : undefined);
      return {
        providerCompanyId: String(providerId),
        providerCompanyName: typeof providerBody.CompanyName === "string" ? providerBody.CompanyName : null,
        providerLegalName: typeof providerBody.LegalName === "string" ? providerBody.LegalName : null,
        homeCurrency: typeof homeCurrencyValue === "string" && /^[A-Za-z]{3}$/.test(homeCurrencyValue) ? homeCurrencyValue.toUpperCase() : null,
        evidenceVersion: typeof metadata.LastUpdatedTime === "string" ? metadata.LastUpdatedTime : String(providerId),
        companyInfoHash: companyInfoHash(providerBody),
        existingBinding: Boolean(sameRealm),
      };
    });
    const oauthConnection = createQuickBooksOAuthConnectionService({
      oauth,
      stateStore: new PostgresQuickBooksOAuthStateStore(executor),
      tokenManager,
      pendingBindingStore,
      verifyRealmBinding,
      persistRealmBinding: async input => {
        if (!executor.transaction) throw new AccountingError("accounting_configuration", "QuickBooks realm binding requires an atomic company database transaction");
        await executor.transaction(transaction => persistRealmBindingInTransaction(transaction, input), { readOnly: false });
      },
      confirmPendingBinding: async input => {
        if (!executor.transaction) throw new AccountingError("accounting_configuration", "QuickBooks binding confirmation requires an atomic company database transaction");
        if (!input.organizationId || !input.legalEntityId) throw new AccountingError("accounting_validation", "QuickBooks binding confirmation must name the current company and legal entity");
        const organizationId = organizationIdSchema.parse(input.organizationId);
        const legalEntityId = legalEntityIdSchema.parse(input.legalEntityId);
        const authorizeFreshMutation = async (transaction: RentOpsQueryExecutor): Promise<void> => {
          const principal = await loadAuthenticatedPrincipal(transaction, { actorId: input.actorId, organizationId, role: "admin" });
          authorizeCompanyRead(principal, { organizationId, legalEntityId }, ACCOUNTING_MUTATION_ROLES);
        };
        let saved: QuickBooksStoredToken | undefined;
        const pending = await pendingBindingStore.confirm(
          input.pendingId,
          input.actorId,
          input.sessionBindingHash,
          { organizationId, legalEntityId },
          async (handoff, transaction) => {
            // The HTTP adapter also checks the grant, but this is the command's
            // authoritative fresh-grant check inside the commit transaction.
            await authorizeFreshMutation(transaction);
            await persistRealmBindingInTransaction(transaction, { actorId: input.actorId, pendingId: handoff.pendingId, scope: handoff.scope, proof: handoff.proof });
            // The regular token manager is intentionally bound to the pool;
            // use a transaction-local repository so binding, token save, audit,
            // and handoff consumption commit or roll back together.
            const transactionRepository = new PostgresQuickBooksTokenRepository(transaction, cipher, config.now);
            saved = await transactionRepository.saveNewConnection(handoff.scope, handoff.token);
          },
        );
        const committed = saved as QuickBooksStoredToken | undefined;
        if (!pending && !committed) {
          // A lost browser response after commit is a safe replay. The audit
          // row and the active connection together prove that this same actor
          // and session already completed the confirmation; no token rewrite
          // is attempted.
          const replay = await executor.transaction(async transaction => {
            await authorizeFreshMutation(transaction);
            const audit = await transaction.query<{ environment: unknown; realm_id: unknown }>(
              `SELECT confirmation.environment, confirmation.realm_id
                 FROM accounting_qbo_binding_confirmations confirmation
                 JOIN accounting_qbo_pending_bindings pending ON pending.pending_id=confirmation.pending_id
                WHERE confirmation.pending_id=$1 AND confirmation.confirmed_by=$2
                  AND pending.actor_id=$2 AND (pending.session_binding_hash IS NOT DISTINCT FROM $3)
                  AND confirmation.organization_id=$4 AND confirmation.legal_entity_id=$5`,
              [input.pendingId, input.actorId, input.sessionBindingHash, organizationId, legalEntityId],
            );
            const auditRow = audit.rows[0];
            if (!auditRow) return null;
            const scope = {
              organizationId,
              legalEntityId,
              environment: auditRow.environment === "production" ? "production" as const : "sandbox" as const,
              realmId: String(auditRow.realm_id),
            } satisfies QuickBooksConnectionScope;
            const metadata = await new PostgresQuickBooksTokenRepository(transaction, cipher, config.now).readMetadata(scope);
            if (!metadata) return null;
            return {
              status: "connected" as const,
              scope,
              connection: {
                accessTokenExpiresAt: metadata.accessTokenExpiresAt,
                ...(metadata.refreshTokenExpiresAt ? { refreshTokenExpiresAt: metadata.refreshTokenExpiresAt } : {}),
                ...(metadata.intuitTid ? { intuitTid: metadata.intuitTid } : {}),
                version: metadata.version,
              },
            };
          }, { readOnly: true });
          if (replay) return replay;
        }
        if (!pending || !committed) throw new AccountingError("accounting_conflict", "QuickBooks binding confirmation could not be completed");
        return {
          status: "connected" as const,
          scope: pending.scope,
          connection: {
            accessTokenExpiresAt: committed.accessTokenExpiresAt,
            ...(committed.refreshTokenExpiresAt ? { refreshTokenExpiresAt: committed.refreshTokenExpiresAt } : {}),
            ...(committed.intuitTid ? { intuitTid: committed.intuitTid } : {}),
            ...(committed.version === undefined ? {} : { version: committed.version }),
          },
        };
      },
    });
    const createClient = (scope: QuickBooksConnectionScope): QuickBooksAccountingClient => {
      const client = createQuickBooksAccountingClient({ scope, getAccessToken: () => capabilityGate.requireEnabled(scope, "accounting.read").then(() => tokenManager.getAccessToken(scope)), transport });
      return {
        read: (...args) => client.read(...args),
        query: (...args) => client.query(...args),
        create: (...args) => capabilityGate.requireEnabled(scope, "accounting.create").then(() => client.create(...args)),
        update: (...args) => capabilityGate.requireEnabled(scope, "accounting.update").then(() => client.update(...args)),
      } as QuickBooksAccountingClient;
    };
    const createProvider = (scope: QuickBooksConnectionScope): QboProviderSync => createQboProviderSync({
      executor,
      scope,
      mirror,
      capabilityStore,
      client: createQuickBooksAccountingClient({ scope, getAccessToken: () => tokenManager.getAccessToken(scope), transport }),
    });
    const createReports = (scope: QuickBooksConnectionScope): QuickBooksReportsClient => {
      const client = createQuickBooksReportsClient({ scope, getAccessToken: () => capabilityGate.requireEnabled(scope, "accounting.read").then(() => tokenManager.getAccessToken(scope)), transport });
      return client;
    };
    const previewPendingBinding = async (input: {
      readonly executor: RentOpsQueryExecutor;
      readonly pendingId: string;
      readonly actorId: string;
      readonly sessionBindingHash: string | null;
      readonly organizationId: string;
      readonly legalEntityId: string;
    }): Promise<QuickBooksPendingBindingPreview | null> => new PostgresQuickBooksPendingBindingStore(input.executor, cipher).preview(input.pendingId, input.actorId, input.sessionBindingHash, { organizationId: input.organizationId, legalEntityId: input.legalEntityId });
    return { financialSourceReadPort: mirror, financialSourceAllocationPort: mirror, financialProviderPaymentContextPort: mirror, financialProviderCostContextPort: mirror, purposeMappings, mirror, qbo: { status: "configured", environment: config.environment, oauth, tokenManager, tokenRepository, capabilityGate, capabilityStore, oauthConnection, disconnect: input => disconnectQuickBooksConnection({ executor, cipher, oauth, now: config.now, refreshLease: lease }, input), previewPendingBinding, createAccountingClient: createClient, createReportsClient: createReports, createProviderSync: createProvider } };
  } catch (error) {
    if ((error instanceof AccountingError && error.code === "accounting_configuration") || (isQuickBooksIntegrationError(error) && error.code === "quickbooks_configuration")) return { financialSourceReadPort: mirror, financialSourceAllocationPort: mirror, financialProviderPaymentContextPort: mirror, financialProviderCostContextPort: mirror, purposeMappings, mirror, qbo: { status: "unconfigured", reason: "invalid_configuration" } };
    throw error;
  }
}

export * from "./capabilities";
export * from "./binding";
export * from "./connection-store";
export * from "./errors";
export * from "./mirror-store";
export * from "./purpose";
export * from "./oauth-state";
export * from "./refresh-lease";
export * from "./sync";
export * from "./token-crypto";
export * from "./http";
export * from "./mcp";
export * from "./provider-sync";
export * from "./disconnect";
