import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createSyntheticCompanyDatabase, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { loadAuthenticatedPrincipal } from "../company/authorization";
import { createQboAccountingMirrorStore } from "../accounting/mirror-store";
import { createQboProviderSync } from "../accounting/provider-sync";
import { PostgresQuickBooksCapabilityStore } from "../accounting/capabilities";
import type { QuickBooksAccountingClient } from "../integrations/quickbooks/accounting";
import { searchCostSourceLines } from "./source-lines";

test("project picker includes signed journal refunds only when requested and excludes retired balances", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    const scope = { organizationId: SYNTHETIC_COMPANY.organizationId, legalEntityId: SYNTHETIC_COMPANY.entityId, environment: "sandbox" as const, realmId: "123456" };
    const updated = "2026-09-21T14:00:00Z";
    const entries = [{
      Id: "100", SyncToken: "0", TxnDate: "2026-09-20", CurrencyRef: { value: "USD" }, MetaData: { LastUpdatedTime: updated },
      Line: ["Debit", "Credit"].map((postingType, index) => ({ Id: String(index + 1), Amount: "25.00", Description: "Synthetic cost correction", JournalEntryLineDetail: { PostingType: postingType, AccountRef: { value: `inventory-${index + 1}` } } })),
    }];
    const client = {
      read: async () => ({ entity: { Id: "1", CompanyName: "Synthetic QBO" }, raw: {}, status: 200 }),
      query: async (query: string) => ({ entities: /FROM JournalEntry\b/.test(query) && query.includes("STARTPOSITION 1") ? entries : [], raw: { QueryResponse: {} }, status: 200 }),
    } as unknown as QuickBooksAccountingClient;
    const mirror = createQboAccountingMirrorStore(fixture.executor);
    const sync = createQboProviderSync({ executor: fixture.executor, client, scope, mirror, capabilityStore: new PostgresQuickBooksCapabilityStore(fixture.executor), now: () => new Date("2026-09-21T15:00:00Z") });
    await sync.bootstrapRead();
    await sync.catchUp();
    const principal = await loadAuthenticatedPrincipal(fixture.executor, { organizationId: scope.organizationId, actorId: SYNTHETIC_COMPANY.actorId, role: "admin" });
    const query = { organizationId: scope.organizationId, legalEntityId: scope.legalEntityId };
    const ordinary = await searchCostSourceLines(fixture.executor, principal, query);
    assert.deepEqual(ordinary.items.map(item => item.direction), ["debit"]);
    const projects = await searchCostSourceLines(fixture.executor, principal, { ...query, includeRefunds: true });
    assert.deepEqual(projects.items.map(item => item.direction).sort(), ["credit", "debit"]);
    assert.ok(projects.items.every(item => item.availableCents === "2500"), "reservations use positive source capacity while the project applies the sign");
    await fixture.executor.query("UPDATE accounting_qbo_source_line_balances SET is_current=false, allocation_blocked=true WHERE object_id='100' AND line_id='2'");
    const current = await searchCostSourceLines(fixture.executor, principal, { ...query, includeRefunds: true });
    assert.deepEqual(current.items.map(item => item.source.objectId), ["100"]);
  } finally { await fixture.close(); }
});

test("project picker derives one verified QBO realm and never mixes environments", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    const { organizationId, entityId, propertyId, actorId } = SYNTHETIC_COMPANY;
    const projectId = randomUUID();
    const now = "2026-09-24T12:00:00Z";
    await fixture.executor.query(
      `INSERT INTO company_projects
        (id, organization_id, legal_entity_id, property_id, name, project_type, status, currency, start_on)
       VALUES ($1,$2,$3,$4,'Synthetic scoped project','flip','planning','USD','2026-09-01')`,
      [projectId, organizationId, entityId, propertyId],
    );
    await fixture.executor.query(
      `INSERT INTO accounting_qbo_realm_bindings
        (organization_id, legal_entity_id, environment, realm_id, provider_company_id, evidence_version, company_info_hash, confirmed_by)
       VALUES ($1,$2,'sandbox','900201','synthetic-sandbox','synthetic-1',$3,'synthetic-test'),
              ($1,$2,'production','900202','synthetic-production','synthetic-1',$3,'synthetic-test')`,
      [organizationId, entityId, "a".repeat(64)],
    );
    await fixture.executor.query(
      `INSERT INTO company_external_identities
        (id, organization_id, legal_entity_id, provider, source_scope, record_kind, external_id, local_kind, local_id)
       VALUES ($1,$2,$3,'qbo','qbo:production:900202','Project','project-scope-42','project',$4)`,
      [randomUUID(), organizationId, entityId, projectId],
    );

    const insertLine = async (environment: "sandbox" | "production", realmId: string, objectId: string, lineId: string, direction: "debit" | "credit") => {
      const sourceObjectId = randomUUID();
      const transactionId = randomUUID();
      await fixture.executor.query(
        `INSERT INTO accounting_qbo_source_objects
          (id, organization_id, legal_entity_id, environment, realm_id, object_type, object_id, object_version, body_hash, provider_body, provider_updated_at)
         VALUES ($1,$2,$3,$4,$5,'JournalEntry',$6,'1',$7,'{}'::jsonb,$8)`,
        [sourceObjectId, organizationId, entityId, environment, realmId, objectId, "b".repeat(64), now],
      );
      await fixture.executor.query(
        `INSERT INTO accounting_qbo_transactions
          (id, organization_id, legal_entity_id, environment, realm_id, source_object_id, object_type, object_id, object_version, transaction_date, posting_state, currency, watermark, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'JournalEntry',$7,'1','2026-09-20','posted','USD',$8,$9)`,
        [transactionId, organizationId, entityId, environment, realmId, sourceObjectId, objectId, now, now],
      );
      await fixture.executor.query(
        `INSERT INTO accounting_qbo_source_line_balances
          (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, line_id, amount_cents, currency, direction, flow, line_role, transaction_type, latest_version, posting_state, posted_on, settlement_state, watermark, updated_at)
         VALUES ($1,$2,$3,$4,'JournalEntry',$5,$6,2500,'USD',$7,$8,'expense','JournalEntry','1','posted','2026-09-20','unknown',$9,$10)`,
        [organizationId, entityId, environment, realmId, objectId, lineId, direction, direction === "credit" ? "incoming" : "outgoing", now, now],
      );
      await fixture.executor.query(
        `INSERT INTO accounting_qbo_transaction_lines
          (id, organization_id, legal_entity_id, environment, realm_id, transaction_id, source_object_id, object_type, object_id, line_number, source_line_id, source_version, transaction_type, direction, flow, line_role, amount_cents, currency, posting_state, posted_on, settlement_state, description, watermark, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'JournalEntry',$8,1,$9,'1','JournalEntry',$10,$11,'expense',2500,'USD','posted','2026-09-20','unknown',$12,$13,$14)`,
        [randomUUID(), organizationId, entityId, environment, realmId, transactionId, sourceObjectId, objectId, lineId, direction, direction === "credit" ? "incoming" : "outgoing", `${environment} ${direction}`, now, now],
      );
    };
    await insertLine("sandbox", "900201", "sandbox-cost", "1", "debit");
    await insertLine("production", "900202", "production-cost", "1", "debit");
    await insertLine("production", "900202", "production-refund", "1", "credit");

    const principal = await loadAuthenticatedPrincipal(fixture.executor, { organizationId, actorId, role: "admin" });
    const query = { organizationId, legalEntityId: entityId, projectId, purpose: "cost" as const };
    const ordinary = await searchCostSourceLines(fixture.executor, principal, query);
    assert.deepEqual(ordinary.items.map(item => item.source.objectId), ["production-cost"]);
    const withRefunds = await searchCostSourceLines(fixture.executor, principal, { ...query, includeRefunds: true });
    assert.deepEqual(withRefunds.items.map(item => item.source.objectId), ["production-refund", "production-cost"]);
    assert.ok(withRefunds.items.every(item => item.source.environment === "production" && item.source.realmId === "900202"));
    await assert.rejects(
      searchCostSourceLines(fixture.executor, principal, { ...query, environment: "sandbox", realmId: "900201" }),
      /not linked to this project/,
    );
    await fixture.executor.query(
      `INSERT INTO company_external_identities
        (id, organization_id, legal_entity_id, provider, source_scope, record_kind, external_id, local_kind, local_id)
       VALUES ($1,$2,$3,'qbo','qbo:sandbox:900201','Project','project-scope-43','project',$4)`,
      [randomUUID(), organizationId, entityId, projectId],
    );
    await assert.rejects(
      searchCostSourceLines(fixture.executor, principal, query),
      /Select a QuickBooks environment and realm/,
    );
  } finally { await fixture.close(); }
});
