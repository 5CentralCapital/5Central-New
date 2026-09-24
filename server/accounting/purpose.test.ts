import assert from "node:assert/strict";
import test from "node:test";
import { newOperationId } from "../../shared/company";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import { createSyntheticCompanyDatabase, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { createAccountingServices } from "./index";
import { registerAccountingMcpTools } from "./mcp";
import { createQboAccountingMirrorStore } from "./mirror-store";
import { executeAccountingPurposeCommand } from "./purpose";

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

test("capitalized-cost purpose command proves the exact current Other Current Asset revision and replays idempotently", async () => {
  const synthetic = await createSyntheticCompanyDatabase();
  try {
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
    assert.equal(await mirror.purposeMappings.readPurposeMapping({ scope, providerAccountId: "132", postedOn: "2026-09-08" }), null);
  } finally {
    await synthetic.close();
  }
});

test("capitalized-cost purpose command rejects a stale Account revision and non-Other Current Asset account", async () => {
  const synthetic = await createSyntheticCompanyDatabase();
  try {
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

test("Codex MCP exposes the same scoped capitalized-cost command and mapping read", async () => {
  const synthetic = await createSyntheticCompanyDatabase();
  try {
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
