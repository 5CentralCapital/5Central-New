import type { QuickBooksConnectionScope } from "../../shared/accounting/quickbooks";
import { financialSourceScopeSchema, type FinancialSourceScope } from "../../shared/accounting";
import type { QboReceivableDocument } from "../../shared/accounting/receivables";
import type { ReceivableIdentity } from "../integrations/quickbooks/normalize-receivables";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { AccountingError } from "./errors";
import { versionCompare } from "./mirror-store";

/*
 * Persistence for the QuickBooks receivables mirror (migration 050).
 *
 * The document row is the current provider revision; effects and
 * applications are written once per revision (append-only). A revision older
 * than the one already mirrored is ignored, so out-of-order webhook, CDC and
 * replay deliveries converge on QuickBooks' latest SyncToken.
 */

export type ReceivableApplyOutcome = "applied" | "unchanged" | "stale";

interface CurrentRow {
  readonly object_version: string;
  readonly mirror_state: "current" | "unsupported";
}

function scopeOf(scope: QuickBooksConnectionScope): FinancialSourceScope {
  return financialSourceScopeSchema.parse({ provider: "qbo", ...scope });
}

function scopeParts(scope: FinancialSourceScope): unknown[] {
  return [scope.organizationId, scope.legalEntityId, scope.environment, scope.realmId];
}

export class PostgresQboReceivablesStore {
  constructor(private readonly executor: RentOpsQueryExecutor) {}

  forExecutor(executor: RentOpsQueryExecutor): PostgresQboReceivablesStore {
    return new PostgresQboReceivablesStore(executor);
  }

  private async current(scope: FinancialSourceScope, objectType: string, objectId: string): Promise<CurrentRow | null> {
    const result = await this.executor.query<CurrentRow>(
      `SELECT object_version, mirror_state FROM accounting_qbo_receivable_documents
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND object_id=$6
        FOR UPDATE`,
      [...scopeParts(scope), objectType, objectId],
    );
    return result.rows[0] ?? null;
  }

  /** Mirror one fully understood revision. Must run inside the caller's transaction. */
  async applyDocument(scopeInput: QuickBooksConnectionScope, document: QboReceivableDocument, sourceObjectId: string): Promise<ReceivableApplyOutcome> {
    const scope = scopeOf(scopeInput);
    const existing = await this.current(scope, document.objectType, document.objectId);
    if (existing && versionCompare(existing.object_version, document.version) > 0) return "stale";
    const parts = scopeParts(scope);
    for (const effect of document.effects) {
      await this.executor.query(
        `INSERT INTO accounting_qbo_receivable_effects
          (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, object_version, effect_id, line_number,
           customer_object_id, effect_kind, amount_cents, account_object_id, item_object_id, class_object_id, department_object_id, service_date, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::bigint,$13,$14,$15,$16,$17,$18)
         ON CONFLICT DO NOTHING`,
        [...parts, document.objectType, document.objectId, document.version, effect.effectId, effect.lineNumber, effect.customerObjectId, effect.kind,
          effect.amountCents, effect.accountObjectId, effect.itemObjectId, effect.classObjectId, effect.departmentObjectId, effect.serviceDate, effect.description],
      );
    }
    for (const application of document.applications) {
      if (document.objectType !== "Payment") throw new AccountingError("accounting_validation", "Only a QuickBooks Payment records receivable applications");
      await this.executor.query(
        `INSERT INTO accounting_qbo_receivable_applications
          (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, object_version, application_id, target_type, target_id, amount_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::bigint)
         ON CONFLICT DO NOTHING`,
        [...parts, document.objectType, document.objectId, document.version, application.applicationId, application.targetType, application.targetId, application.amountCents],
      );
    }
    const values = [
      ...parts, document.objectType, document.objectId, document.version, sourceObjectId, document.customerObjectId, document.docNumber,
      document.txnDate, document.dueDate, document.currency, document.totalCents, document.openBalanceCents, document.postingState,
      document.emailStatus, document.allowOnlineCard, document.allowOnlineAch, document.allowIpn, document.billEmailPresent, document.providerUpdatedAt,
    ];
    if (!existing) {
      const inserted = await this.executor.query(
        `INSERT INTO accounting_qbo_receivable_documents
          (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, object_version, source_object_id, mirror_state,
           customer_object_id, doc_number, txn_date, due_date, currency, total_cents, open_balance_cents, posting_state,
           email_status, allow_online_card, allow_online_ach, allow_ipn, bill_email_present, unsupported_reason, provider_updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'current',$9,$10,$11,$12,$13,$14::bigint,$15::bigint,$16,$17,$18,$19,$20,$21,NULL,$22)
         ON CONFLICT DO NOTHING RETURNING object_id`,
        values,
      );
      // A concurrent writer inserted first: re-run under its row lock.
      if (inserted.rows.length === 0) return this.applyDocument(scopeInput, document, sourceObjectId);
      return "applied";
    }
    if (existing.object_version === document.version) {
      // A supported replay is a no-op. An earlier attempt may have retired
      // this exact provider revision as unsupported (for example, before the
      // prerequisite Account revision arrived); the same revision can then be
      // recovered without appending duplicate effects. Source-object ingest
      // has already enforced same-token body immutability.
      if (existing.mirror_state === "unsupported") {
        await this.executor.query(
          `UPDATE accounting_qbo_receivable_documents SET
             source_object_id=$8, mirror_state='current', customer_object_id=$9, doc_number=$10, txn_date=$11, due_date=$12,
             currency=$13, total_cents=$14::bigint, open_balance_cents=$15::bigint, posting_state=$16, email_status=$17, allow_online_card=$18,
             allow_online_ach=$19, allow_ipn=$20, bill_email_present=$21, unsupported_reason=NULL, provider_updated_at=$22, mirrored_at=now()
           WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND object_id=$6
             AND object_version=$7 AND mirror_state='unsupported'`,
          values,
        );
        return "applied";
      }
      // Same revision seen again (overlap, replay, webhook after CDC): refresh nothing.
      return "unchanged";
    }
    await this.executor.query(
      `UPDATE accounting_qbo_receivable_documents SET
         object_version=$7, source_object_id=$8, mirror_state='current', customer_object_id=$9, doc_number=$10, txn_date=$11, due_date=$12,
         currency=$13, total_cents=$14::bigint, open_balance_cents=$15::bigint, posting_state=$16, email_status=$17, allow_online_card=$18,
         allow_online_ach=$19, allow_ipn=$20, bill_email_present=$21, unsupported_reason=NULL, provider_updated_at=$22, mirrored_at=now()
       WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND object_id=$6`,
      values,
    );
    return "applied";
  }

  /**
   * A newer revision could not be understood. An already mirrored document
   * stops counting (its effects belong to an older revision) and says why.
   * Returns false when nothing was mirrored for this document yet.
   */
  async retireUnsupported(scopeInput: QuickBooksConnectionScope, identity: ReceivableIdentity, sourceObjectId: string, reason: string): Promise<boolean> {
    const scope = scopeOf(scopeInput);
    const existing = await this.current(scope, identity.objectType, identity.objectId);
    if (!existing || versionCompare(existing.object_version, identity.version) > 0) return false;
    await this.executor.query(
      `UPDATE accounting_qbo_receivable_documents SET object_version=$7, source_object_id=$8, mirror_state='unsupported', unsupported_reason=$9, provider_updated_at=$10, mirrored_at=now()
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND object_id=$6`,
      [...scopeParts(scope), identity.objectType, identity.objectId, identity.version, sourceObjectId, reason.slice(0, 500), identity.providerUpdatedAt],
    );
    return true;
  }

  /**
   * A document that no longer affects any customer (its A/R lines or its
   * customer were removed). The new revision is recorded with no effects, so
   * the earlier ones stop counting. Nothing is created for a document that
   * was never receivable.
   */
  async retireNotReceivable(scopeInput: QuickBooksConnectionScope, identity: ReceivableIdentity, sourceObjectId: string): Promise<boolean> {
    const scope = scopeOf(scopeInput);
    const existing = await this.current(scope, identity.objectType, identity.objectId);
    if (!existing || versionCompare(existing.object_version, identity.version) >= 0) return false;
    await this.executor.query(
      `UPDATE accounting_qbo_receivable_documents SET object_version=$7, source_object_id=$8, mirror_state='current', total_cents=0, open_balance_cents=NULL,
              unsupported_reason=NULL, provider_updated_at=$9, mirrored_at=now()
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND object_id=$6`,
      [...scopeParts(scope), identity.objectType, identity.objectId, identity.version, sourceObjectId, identity.providerUpdatedAt],
    );
    return true;
  }

  /** AccountType for live mirrored Account revisions, keyed by Account Id. */
  async accountTypes(scopeInput: QuickBooksConnectionScope, accountIds: readonly string[]): Promise<Map<string, string>> {
    const scope = scopeOf(scopeInput);
    if (accountIds.length === 0) return new Map();
    const result = await this.executor.query<{ object_id: string; account_type: string | null }>(
      `SELECT DISTINCT ON (object_id) object_id, provider_body->>'AccountType' AS account_type
         FROM accounting_qbo_source_objects
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type='Account'
          AND object_id = ANY($5::text[]) AND deleted_at IS NULL
        ORDER BY object_id, provider_updated_at DESC NULLS LAST, received_at DESC`,
      [...scopeParts(scope), Array.from(accountIds)],
    );
    return new Map(result.rows.filter(row => typeof row.account_type === "string").map(row => [String(row.object_id), String(row.account_type)]));
  }

  /** Receivable documents mirrored and live for a type; used for full-replay deletion inference. */
  async listDocumentIds(scopeInput: QuickBooksConnectionScope, objectType: string, objectId?: string): Promise<readonly string[]> {
    const scope = scopeOf(scopeInput);
    const result = await this.executor.query<{ object_id: string }>(
      `SELECT d.object_id FROM accounting_qbo_receivable_documents d
         JOIN accounting_qbo_source_objects s ON s.id = d.source_object_id AND s.deleted_at IS NULL
        WHERE d.organization_id=$1 AND d.legal_entity_id=$2 AND d.environment=$3 AND d.realm_id=$4 AND d.object_type=$5
          AND ($6::text IS NULL OR d.object_id = $6)`,
      [...scopeParts(scope), objectType, objectId ?? null],
    );
    return result.rows.map(row => String(row.object_id));
  }
}
