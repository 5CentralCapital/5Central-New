import assert from "node:assert/strict";
import test from "node:test";
import { newOperationId } from "../../shared/company";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import { createSyntheticCompanyDatabase, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { createAccountingServices } from "./index";
import { registerAccountingMcpTools } from "./mcp";
import { createQboAccountingMirrorStore } from "./mirror-store";
import { executeAccountingPurposeCommand } from "./purpose";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";

const scope = {
  provider: "qbo" as const,
  organizationId: SYNTHETIC_COMPANY.organizationId,
  legalEntityId: SYNTHETIC_COMPANY.entityId,
  environment: "sandbox" as const,
  realmId: "123456",
};

function envelope(payload: Record<string, unknown>, operationId = newOperationId()) {
  return {
    operationId,
    idempotencyKey: `qbo-purpose-test:${operationId}`,
    scope: { organizationId: scope.organizationId, legalEntityId: scope.legalEntityId },
    payload,
  };
}

async function principalFor(executor: Parameters<typeof loadAuthenticatedPrincipal>[0]) {
  return loadAuthenticatedPrincipal(executor, { actorId: SYNTHETIC_COMPANY.actorId, organizationId: SYNTHETIC_COMPANY.organizationId, role: "admin" });
}

async function attestQboScope(executor: RentOpsQueryExecutor) {
  await executor.query(
    `INSERT INTO accounting_qbo_connections
      (organization_id, legal_entity_id, environment, realm_id,
       encrypted_access_token, access_token_iv, access_token_auth_tag,
       encrypted_refresh_token, refresh_token_iv, refresh_token_auth_tag,
       access_token_expires_at, status)
     VALUES ($1,$2,'sandbox','123456','access','iv','tag','refresh','iv','tag',now() + interval '1 hour','active')`,
    [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId],
  );
  await executor.query(
    `INSERT INTO accounting_qbo_realm_bindings
      (organization_id, legal_entity_id, environment, realm_id, provider_company_id,
       evidence_version, company_info_hash, confirmed_by)
     VALUES ($1,$2,'sandbox','123456','synthetic-company','v1',$3,'synthetic-admin')`,
    [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId, "f".repeat(64)],
  );
  await executor.query(
    `INSERT INTO accounting_qbo_capabilities
      (organization_id, legal_entity_id, environment, realm_id, capability,
       enabled, evidence, evidence_version, verified_at)
     VALUES ($1,$2,'sandbox','123456','accounting.read',true,'live_provider_readback','v1',now())`,
    [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId],
  );
}

test("capitalized-cost purpose command proves the exact current Other Current Asset revision and replays idempotently", async () => {
  const synthetic = await createSyntheticCompanyDatabase();
  try {
    await attestQboScope(synthetic.executor);
    const mirror = createQboAccountingMirrorStore(synthetic.executor);
    await mirror.ingestSourceObject({
      scope,
      objectType: "Account",
      objectId: "132",
      version: "7",
      providerUpdatedAt: "2026-09-23T19:30:49Z",
      providerBody: { Id: "132", SyncToken: "7", Name: "Capital account", AccountType: "Other Current Asset", AccountSubType: "OtherCurrentAssets", MetaData: { LastUpdatedTime: "2026-09-23T19:30:49Z" } },
      receivedAt: "2026-09-24T00:00:00Z",
    });
    const input = envelope({ providerAccountId: "132", accountSourceVersion: "7", environment: "sandbox", realmId: "123456", effectiveFrom: "2026-01-01", effectiveTo: null, reviewEvidence: "Synthetic reviewed account schedule" });
    const options = { principal: await principalFor(synthetic.executor), resolvePrincipal: (executor: typeof synthetic.executor) => principalFor(executor), transport: attestTransport("web") };
    const receipt = await executeAccountingPurposeCommand(synthetic.executor, "accounting.qbo_purpose.map_capitalized_cost", input, options, mirror.purposeMappings);
    assert.equal(receipt.state, "saved_in_rops");
    assert.equal(receipt.affectedRecordIds.length, 1);
    assert.deepEqual(await executeAccountingPurposeCommand(synthetic.executor, "accounting.qbo_purpose.map_capitalized_cost", input, options, mirror.purposeMappings), receipt);
    const mappings = await mirror.purposeMappings.listPurposeMappings(scope, "132");
    assert.equal(mappings.length, 1);
    assert.equal(mappings[0]?.purpose, "capitalized_cost");
    assert.equal(mappings[0]?.accountSourceVersion, "7");
    assert.equal((await mirror.purposeMappings.readPurposeMapping({ scope, providerAccountId: "132", postedOn: "2026-09-08" }))?.purpose, "capitalized_cost");

    await mirror.ingestSourceObject({
      scope,
      objectType: "Account",
      objectId: "132",
      version: "8",
      providerUpdatedAt: "2026-09-24T19:30:49Z",
      providerBody: { Id: "132", SyncToken: "8", Name: "Capital account", AccountType: "Other Current Asset", AccountSubType: "OtherCurrentAssets", MetaData: { LastUpdatedTime: "2026-09-24T19:30:49Z" } },
      receivedAt: "2026-09-24T20:00:00Z",
    });
    // A replay can arrive later with a newer numeric SyncToken but an older
    // provider timestamp. Revision order, rather than receipt/update time,
    // must identify the current Account proof.
    await mirror.ingestSourceObject({
      scope,
      objectType: "Account",
      objectId: "132",
      version: "10",
      providerUpdatedAt: "2026-09-24T18:00:00Z",
      providerBody: { Id: "132", SyncToken: "10", Name: "Capital account", AccountType: "Other Current Asset", AccountSubType: "OtherCurrentAssets", MetaData: { LastUpdatedTime: "2026-09-24T18:00:00Z" } },
      receivedAt: "2026-09-25T00:00:00Z",
    });
    assert.equal((await mirror.purposeMappings.readPurposeMapping({ scope, providerAccountId: "132", postedOn: "2026-09-08" }))?.accountSourceVersion, "7");
    assert.equal(await mirror.purposeMappings.readPurposeMapping({ scope, providerAccountId: "132", postedOn: "2026-09-24" }), null);
    assert.equal((await mirror.purposeMappings.readCurrentAccount(scope, "132"))?.accountSourceVersion, "10");
    const previous = mappings[0]!;
    const reattest = await executeAccountingPurposeCommand(
      synthetic.executor,
      "accounting.qbo_purpose.reattest_capitalized_cost",
      envelope({ mappingId: previous.id, expectedRecordRevision: previous.recordRevision, providerAccountId: "132", accountSourceVersion: "10", environment: "sandbox", realmId: "123456", effectiveFrom: "2026-09-24", reviewEvidence: "Synthetic re-attestation after Account revision" }),
      options,
      mirror.purposeMappings,
    );
    assert.equal(reattest.affectedRecordIds.length, 2);
    const history = await mirror.purposeMappings.listPurposeMappings(scope, "132");
    assert.equal(history.length, 2);
    assert.equal(history.find(item => item.id === previous.id)?.effectiveTo, "2026-09-24");
    assert.equal(history.find(item => item.id !== previous.id)?.accountSourceVersion, "10");
    assert.equal((await mirror.purposeMappings.readPurposeMapping({ scope, providerAccountId: "132", postedOn: "2026-09-24" }))?.accountSourceVersion, "10");
    await assert.rejects(
      executeAccountingPurposeCommand(
        synthetic.executor,
        "accounting.qbo_purpose.reattest_capitalized_cost",
        envelope({ mappingId: previous.id, expectedRecordRevision: previous.recordRevision, providerAccountId: "132", accountSourceVersion: "10", environment: "sandbox", realmId: "123456", effectiveFrom: "2026-10-01", reviewEvidence: "Stale re-attestation" }),
        options,
        mirror.purposeMappings,
      ),
      (error: unknown) => (error as { code?: string }).code === "accounting_conflict",
    );
  } finally {
    await synthetic.close();
  }
});

test("capitalized-cost purpose command rejects a stale Account revision and non-Other Current Asset account", async () => {
  const synthetic = await createSyntheticCompanyDatabase();
  try {
    await attestQboScope(synthetic.executor);
    const mirror = createQboAccountingMirrorStore(synthetic.executor);
    await mirror.ingestSourceObject({ scope, objectType: "Account", objectId: "241", version: "3", providerUpdatedAt: "2026-09-23T19:30:49Z", providerBody: { Id: "241", SyncToken: "3", AccountType: "Other Current Asset", AccountSubType: "OtherCurrentAssets" }, receivedAt: "2026-09-24T00:00:00Z" });
    const options = { principal: await principalFor(synthetic.executor), resolvePrincipal: (executor: typeof synthetic.executor) => principalFor(executor), transport: attestTransport("web") };
    await assert.rejects(
      executeAccountingPurposeCommand(synthetic.executor, "accounting.qbo_purpose.map_capitalized_cost", envelope({ providerAccountId: "241", accountSourceVersion: "2", environment: "sandbox", realmId: "123456", effectiveFrom: "2026-01-01", reviewEvidence: "Synthetic stale review" }), options, mirror.purposeMappings),
      (error: unknown) => (error as { code?: string }).code === "accounting_conflict",
    );
    await mirror.ingestSourceObject({ scope, objectType: "Account", objectId: "bank-1", version: "0", providerUpdatedAt: "2026-09-23T19:30:49Z", providerBody: { Id: "bank-1", SyncToken: "0", AccountType: "Bank" }, receivedAt: "2026-09-24T00:00:00Z" });
    await assert.rejects(
      executeAccountingPurposeCommand(synthetic.executor, "accounting.qbo_purpose.map_capitalized_cost", envelope({ providerAccountId: "bank-1", accountSourceVersion: "0", environment: "sandbox", realmId: "123456", effectiveFrom: "2026-01-01", reviewEvidence: "Synthetic invalid account" }), options, mirror.purposeMappings),
      (error: unknown) => (error as { code?: string }).code === "accounting_validation",
    );
  } finally {
    await synthetic.close();
  }
});

test("same-day capitalized-cost re-attestation preserves prior evidence and restores existing cost coverage", async () => {
  const synthetic = await createSyntheticCompanyDatabase();
  try {
    await attestQboScope(synthetic.executor);
    const mirror = createQboAccountingMirrorStore(synthetic.executor);
    await mirror.ingestSourceObject({
      scope,
      objectType: "Account",
      objectId: "133",
      version: "1",
      providerUpdatedAt: "2026-09-24T08:00:00Z",
      providerBody: { Id: "133", SyncToken: "1", Name: "Same-day capital account", AccountType: "Other Current Asset", AccountSubType: "OtherCurrentAssets" },
      receivedAt: "2026-09-24T08:01:00Z",
    });
    const options = { principal: await principalFor(synthetic.executor), resolvePrincipal: (executor: typeof synthetic.executor) => principalFor(executor), transport: attestTransport("web") };
    await executeAccountingPurposeCommand(
      synthetic.executor,
      "accounting.qbo_purpose.map_capitalized_cost",
      envelope({ providerAccountId: "133", accountSourceVersion: "1", environment: "sandbox", realmId: "123456", effectiveFrom: "2026-09-24", reviewEvidence: "Synthetic same-day review" }),
      options,
      mirror.purposeMappings,
    );
    const previous = (await mirror.purposeMappings.listPurposeMappings(scope, "133"))[0]!;
    const source = { ...scope, objectType: "JournalEntry", objectId: "same-day-cost", lineId: "1", version: "0" };
    const object = await mirror.ingestSourceObject({ scope, objectType: "JournalEntry", objectId: source.objectId, version: "0", providerUpdatedAt: "2026-09-24T09:00:00Z", providerBody: { Id: source.objectId, SyncToken: "0" } });
    const transaction = await mirror.ingestTransaction({ scope, sourceObjectId: object.id, objectType: "JournalEntry", objectId: source.objectId, version: "0", transactionDate: "2026-09-24", postingState: "posted", currency: "USD", watermark: "2026-09-24T09:00:00Z", updatedAt: "2026-09-24T09:00:00Z" });
    await mirror.ingestTransactionLine({ transactionId: transaction.id, sourceObjectId: object.id, source, lineNumber: 1, transactionType: "JournalEntry", direction: "debit", flow: "outgoing", lineRole: "expense", amountCents: "1200", currency: "USD", postingState: "posted", postedOn: "2026-09-24", settlementState: "unknown", settledOn: null, settledAmountCents: null, accountObjectId: "133", counterpartyObjectId: null, description: "Synthetic same-day cost", watermark: "2026-09-24T09:00:00Z", updatedAt: "2026-09-24T09:00:00Z" });
    const lineQuery = { scope, objectType: source.objectType, objectId: source.objectId, lineId: source.lineId };
    assert.equal((await mirror.readCostContext(lineQuery))?.eligible, true);

    await mirror.ingestSourceObject({
      scope,
      objectType: "Account",
      objectId: "133",
      version: "2",
      providerUpdatedAt: "2026-09-24T12:00:00Z",
      providerBody: { Id: "133", SyncToken: "2", Name: "Same-day capital account", AccountType: "Other Current Asset", AccountSubType: "OtherCurrentAssets" },
      receivedAt: "2026-09-24T12:01:00Z",
    });
    assert.equal((await mirror.readCostContext(lineQuery))?.eligible, false, "changed Account pauses cost eligibility before review");
    await executeAccountingPurposeCommand(
      synthetic.executor,
      "accounting.qbo_purpose.reattest_capitalized_cost",
      envelope({ mappingId: previous.id, expectedRecordRevision: previous.recordRevision, providerAccountId: "133", accountSourceVersion: "2", environment: "sandbox", realmId: "123456", effectiveFrom: "2026-09-24", reviewEvidence: "Synthetic same-day re-attestation" }),
      options,
      mirror.purposeMappings,
    );
    const history = await mirror.purposeMappings.listPurposeMappings(scope, "133");
    assert.equal(history.length, 2);
    assert.equal(history.find(item => item.id === previous.id)?.effectiveTo, "2026-09-24");
    assert.equal(history.find(item => item.id !== previous.id)?.accountSourceVersion, "2");
    assert.equal((await mirror.purposeMappings.readPurposeMapping({ scope, providerAccountId: "133", postedOn: "2026-09-24" }))?.accountSourceVersion, "2");
    assert.equal((await mirror.readCostContext(lineQuery))?.eligible, true, "same-day review restores existing posted costs");
    assert.equal((await mirror.readCostContext(lineQuery))?.amountCents, "1200");
    const active = history.find(item => item.id !== previous.id)!;
    await assert.rejects(executeAccountingPurposeCommand(synthetic.executor, "accounting.qbo_purpose.reattest_capitalized_cost", envelope({ mappingId: active.id, expectedRecordRevision: active.recordRevision, providerAccountId: "133", accountSourceVersion: "2", environment: "sandbox", realmId: "123456", effectiveFrom: "2026-09-24", reviewEvidence: "Duplicate source revision" }), options, mirror.purposeMappings), (error: unknown) => (error as { code?: string }).code === "accounting_validation");
  } finally {
    await synthetic.close();
  }
});

test("Codex MCP exposes the same scoped capitalized-cost command and mapping read", async () => {
  const synthetic = await createSyntheticCompanyDatabase();
  try {
    await attestQboScope(synthetic.executor);
    const services = createAccountingServices(synthetic.executor, { environment: {} });
    await services.mirror.ingestSourceObject({
      scope,
      objectType: "Account",
      objectId: "132",
      version: "4",
      providerUpdatedAt: "2026-09-23T19:30:49Z",
      providerBody: { Id: "132", SyncToken: "4", Name: "Capital account", AccountType: "Other Current Asset", AccountSubType: "OtherCurrentAssets" },
      receivedAt: "2026-09-24T00:00:00Z",
    });
    const tools = new Map<string, (args: unknown) => Promise<unknown>>();
    registerAccountingMcpTools((name, _description, _schema, _write, handler) => { tools.set(name, handler); }, {
      executor: synthetic.executor,
      services,
      actorId: SYNTHETIC_COMPANY.actorId,
    });
    const operationId = newOperationId();
    const command = envelope({ providerAccountId: "132", accountSourceVersion: "4", environment: "sandbox", realmId: "123456", effectiveFrom: "2026-01-01", reviewEvidence: "Synthetic MCP review" }, operationId);
    const receipt = await tools.get("accounting_qbo_purpose_map_capitalized_cost")!({ command }) as { state: string; affectedRecordIds: readonly string[] };
    assert.equal(receipt.state, "saved_in_rops");
    assert.equal(receipt.affectedRecordIds.length, 1);
    const listed = await tools.get("list_accounting_purpose_mappings")!({ scope }) as readonly { providerAccountId: string; purpose: string }[];
    assert.deepEqual(listed.map(item => [item.providerAccountId, item.purpose]), [["132", "capitalized_cost"]]);
  } finally {
    await synthetic.close();
  }
});
