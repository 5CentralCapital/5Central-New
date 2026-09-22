import type { QuickBooksCapability, QuickBooksConnectionScope } from "../../shared/accounting/quickbooks";
import {
  financialSourceEnvironmentSchema,
  financialSourceScopeSchema,
  type FinancialEvidenceState,
} from "../../shared/accounting";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { AccountingError } from "./errors";

export interface QuickBooksCapabilityEvidence {
  readonly scope: QuickBooksConnectionScope;
  readonly capability: QuickBooksCapability;
  readonly enabled: boolean;
  readonly evidence: FinancialEvidenceState;
  readonly evidenceVersion: string;
  readonly verifiedAt: string;
  readonly providerTraceId: string | null;
}

export interface QuickBooksCapabilityStore {
  load(scope: QuickBooksConnectionScope, capability: QuickBooksCapability): Promise<QuickBooksCapabilityEvidence | null>;
  record(evidence: QuickBooksCapabilityEvidence): Promise<void>;
}

interface CapabilityRow {
  organization_id: unknown;
  legal_entity_id: unknown;
  environment: unknown;
  realm_id: unknown;
  capability: unknown;
  enabled: unknown;
  evidence: unknown;
  evidence_version: unknown;
  verified_at: unknown;
  provider_trace_id: unknown;
}

function text(value: unknown, field: string, max = 255): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new AccountingError("accounting_unavailable", `Stored capability ${field} is invalid`);
  return value;
}

function timestampText(value: unknown, field: string): string {
  if (value instanceof Date) return value.toISOString();
  return text(value, field, 80);
}

function parsedScope(scope: QuickBooksConnectionScope) {
  return financialSourceScopeSchema.parse({ provider: "qbo", ...scope });
}

function parseEvidence(row: CapabilityRow): QuickBooksCapabilityEvidence {
  const environment = financialSourceEnvironmentSchema.parse(row.environment);
  const capability = text(row.capability, "name", 120) as QuickBooksCapability;
  const evidence = text(row.evidence, "evidence", 40) as FinancialEvidenceState;
  if (!(["unverified", "synthetic", "live_provider_readback"] as readonly string[]).includes(evidence)) throw new AccountingError("accounting_unavailable", "Stored capability evidence is invalid");
  return {
    scope: {
      organizationId: text(row.organization_id, "organization", 160),
      legalEntityId: text(row.legal_entity_id, "legal entity", 160),
      environment,
      realmId: text(row.realm_id, "realm", 32),
    },
    capability,
    enabled: row.enabled === true || row.enabled === "true",
    evidence,
    evidenceVersion: text(row.evidence_version, "evidence version", 120),
    verifiedAt: timestampText(row.verified_at, "verified at"),
    providerTraceId: row.provider_trace_id === null || row.provider_trace_id === undefined ? null : text(row.provider_trace_id, "provider trace", 255),
  };
}

const columns = "organization_id, legal_entity_id, environment, realm_id, capability, enabled, evidence, evidence_version, verified_at, provider_trace_id";

export class PostgresQuickBooksCapabilityStore implements QuickBooksCapabilityStore {
  constructor(private readonly executor: RentOpsQueryExecutor) {}

  async load(scope: QuickBooksConnectionScope, capability: QuickBooksCapability): Promise<QuickBooksCapabilityEvidence | null> {
    const parsed = parsedScope(scope);
    const result = await this.executor.query<CapabilityRow>(
      `SELECT ${columns} FROM accounting_qbo_capabilities
       WHERE organization_id = $1 AND legal_entity_id = $2 AND environment = $3 AND realm_id = $4 AND capability = $5`,
      [parsed.organizationId, parsed.legalEntityId, parsed.environment, parsed.realmId, capability],
    );
    return result.rows[0] ? parseEvidence(result.rows[0]) : null;
  }

  async record(evidence: QuickBooksCapabilityEvidence): Promise<void> {
    const parsed = parsedScope(evidence.scope);
    if (!["accounting.read", "accounting.create", "accounting.update", "payments", "money_movement", "projects.graphql"].includes(evidence.capability)) {
      throw new AccountingError("accounting_validation", "Unsupported QuickBooks capability");
    }
    if (evidence.enabled && evidence.evidence !== "live_provider_readback") {
      throw new AccountingError("accounting_validation", "A capability cannot be enabled without live provider read-back evidence");
    }
    await this.executor.query(
      `INSERT INTO accounting_qbo_capabilities
        (organization_id, legal_entity_id, environment, realm_id, capability, enabled, evidence, evidence_version, verified_at, provider_trace_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (organization_id, legal_entity_id, environment, realm_id, capability)
       DO UPDATE SET enabled = EXCLUDED.enabled, evidence = EXCLUDED.evidence,
         evidence_version = EXCLUDED.evidence_version, verified_at = EXCLUDED.verified_at,
         provider_trace_id = EXCLUDED.provider_trace_id`,
      [parsed.organizationId, parsed.legalEntityId, parsed.environment, parsed.realmId, evidence.capability, evidence.enabled, evidence.evidence, evidence.evidenceVersion, evidence.verifiedAt, evidence.providerTraceId],
    );
  }
}

export interface QuickBooksCapabilityGate {
  isEnabled(scope: QuickBooksConnectionScope, capability: QuickBooksCapability): Promise<boolean>;
  requireEnabled(scope: QuickBooksConnectionScope, capability: QuickBooksCapability): Promise<QuickBooksCapabilityEvidence>;
}

export function createQuickBooksCapabilityGate(store: QuickBooksCapabilityStore): QuickBooksCapabilityGate {
  return {
    async isEnabled(scope, capability) {
      const evidence = await store.load(scope, capability);
      return Boolean(evidence?.enabled && evidence.evidence === "live_provider_readback");
    },
    async requireEnabled(scope, capability) {
      const evidence = await store.load(scope, capability);
      if (!evidence?.enabled || evidence.evidence !== "live_provider_readback") {
        throw new AccountingError("accounting_capability_disabled", "QuickBooks capability is not verified for this connection", { capability });
      }
      return evidence;
    },
  };
}
