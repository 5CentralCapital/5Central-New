import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SYNTHETIC_COMPANY } from "../../company/testing/synthetic-database";
import { createLaneTestApp } from "../../review-cases/test-app";
import { oauthConfigFromEnv, tokenClientId, verifyOAuthToken, READ_SCOPE, WRITE_SCOPE, type OAuthConfig } from "./oauth";
import { mcpOptionsForClient } from "../../intake/mcp";

const config: OAuthConfig = { issuer: "https://auth.example.test", resource: "https://app.example.test/mcp", introspectionEndpoint: "https://auth.example.test/introspect", introspectionClientId: "test", introspectionClientSecret: "test", adminSubjects: ["admin"], mode: "introspection" };
const valid = { active: true, iss: config.issuer, aud: config.resource, exp: Date.now() / 1000 + 60, sub: "admin", scope: `${READ_SCOPE} ${WRITE_SCOPE}` };
const MRA_WRITE_TOOLS = ["stage_mra_packet", "map_mra_packet", "preview_mra_packet", "apply_mra_packet"];

test("the verified token names its OAuth client from client_id or azp, never from a tool argument", async () => {
  assert.equal(tokenClientId({ client_id: "codex-app" }), "codex-app");
  assert.equal(tokenClientId({ azp: "claude-code-app" }), "claude-code-app");
  assert.equal(tokenClientId({ client_id: "has space" }), undefined);
  assert.equal(tokenClientId({}), undefined);
  const withClient = await verifyOAuthToken("token", config, async () => new Response(JSON.stringify({ ...valid, client_id: "codex-app" })));
  assert.equal(withClient.clientId, "codex-app");
  const without = await verifyOAuthToken("token", config, async () => new Response(JSON.stringify(valid)));
  assert.equal(without.clientId, undefined);
});

test("RENT_OPS_MCP_MRA_CLIENT_IDS is the only MRA client allowlist and defaults to none", () => {
  const env = { RENT_OPS_MCP_ENABLED: "true", RENT_OPS_ADMIN_EMAIL: "a@example.test", RENT_OPS_OAUTH_ISSUER: "https://auth.example.test", RENT_OPS_MCP_RESOURCE: "https://app.example.test/mcp", RENT_OPS_OAUTH_ADMIN_SUBJECTS: "admin" };
  assert.deepEqual(oauthConfigFromEnv(env)?.mraClientIds, []);
  assert.deepEqual(oauthConfigFromEnv({ ...env, RENT_OPS_MCP_MRA_CLIENT_IDS: " codex-app , other " })?.mraClientIds, ["codex-app", "other"]);
  const options = { company: { intake: {} } } as never;
  assert.equal(mcpOptionsForClient({ subject: "admin", scopes: [] }, { mraClientIds: ["codex-app"] }, options), options, "no client identity: unchanged, not attested");
  assert.equal(mcpOptionsForClient({ subject: "admin", scopes: [], clientId: "claude-code-app" }, { mraClientIds: ["codex-app"] }, options), options);
  assert.notEqual(mcpOptionsForClient({ subject: "admin", scopes: [], clientId: "codex-app" }, { mraClientIds: ["codex-app"] }, options), options);
});

for (const denied of [{ label: "Claude Code", mcpClientId: "claude-code-app" }, { label: "a token without a client", mcpClientId: undefined }]) {
  test(`MRA mutation tools are not offered to ${denied.label}; packet reads stay available`, async () => {
    const app = await createLaneTestApp({ mcpClientId: denied.mcpClientId, mraClientIds: ["codex-app"] });
    try {
      const names = (await app.client.listTools()).tools.map(item => item.name);
      for (const name of MRA_WRITE_TOOLS) assert.ok(!names.includes(name), `${name} is not registered`);
      for (const name of ["list_mra_packets", "get_mra_packet"]) assert.ok(names.includes(name), `${name} is registered`);
      const operationId = randomUUID();
      const scope = { organizationId: SYNTHETIC_COMPANY.organizationId, legalEntityId: SYNTHETIC_COMPANY.entityId };
      const refused = await app.client.callTool({ name: "stage_mra_packet", arguments: { command: { operationId, idempotencyKey: `x:${operationId}`, scope, payload: { action: "stage", fileName: "p.json", declaredContentType: "application/json" } }, contentBase64: Buffer.from("{}").toString("base64") } });
      assert.equal(refused.isError, true);
      assert.equal(Number((await app.db.query<{ count: string | number }>("SELECT count(*) AS count FROM company_intake_packets")).rows[0]!.count), 0);
      const list = await app.tool("list_mra_packets", { query: { scope: { organizationId: SYNTHETIC_COMPANY.organizationId } } });
      assert.deepEqual(list.items, []);
    } finally { await app.close(); }
  });
}

test("the allowlisted Codex client gets the MRA mutation tools", async () => {
  const app = await createLaneTestApp({ mcpClientId: "codex-app", mraClientIds: ["codex-app"] });
  try {
    const names = (await app.client.listTools()).tools.map(item => item.name);
    for (const name of MRA_WRITE_TOOLS) assert.ok(names.includes(name), `${name} is registered`);
  } finally { await app.close(); }
});
