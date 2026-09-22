import assert from "node:assert/strict";
import test from "node:test";
import { createQuickBooksOAuthClient, QUICKBOOKS_REVOKE_ENDPOINT, QUICKBOOKS_TOKEN_ENDPOINT } from "./oauth";
import type { QuickBooksTransportRequest, QuickBooksTransportResponse } from "../../../shared/accounting/quickbooks";
import { QuickBooksIntegrationError } from "./errors";

const now = new Date("2026-09-21T12:00:00.000Z");

function response(status: number, body: unknown, headers: Record<string, string> = {}): QuickBooksTransportResponse {
  return { status, body: JSON.stringify(body), headers };
}

function config(transport: (request: QuickBooksTransportRequest) => Promise<QuickBooksTransportResponse>) {
  return {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://rops.example.test/qbo/callback",
    environment: "sandbox" as const,
    transport,
    now: () => now,
  };
}

test("OAuth code exchange, refresh rotation, and revoke use Intuit's documented endpoints", async () => {
  const calls: QuickBooksTransportRequest[] = [];
  const transport = async (request: QuickBooksTransportRequest): Promise<QuickBooksTransportResponse> => {
    calls.push(request);
    if (calls.length === 1) return response(200, { access_token: "access-1", refresh_token: "refresh-1", token_type: "bearer", expires_in: 3600, x_refresh_token_expires_in: 8_726_400, x_refresh_token_hard_expires_in: 2_592_000 });
    if (calls.length === 2) return response(200, { access_token: "access-2", refresh_token: "refresh-2", token_type: "bearer", expires_in: "3600", x_refresh_token_expires_in: "8726400" });
    return response(200, {});
  };
  const client = createQuickBooksOAuthClient(config(transport));
  const authorization = new URL(client.getAuthorizationUrl("state-123"));
  assert.equal(authorization.origin, "https://appcenter.intuit.com");
  assert.equal(authorization.searchParams.get("scope"), "com.intuit.quickbooks.accounting");
  assert.equal(authorization.searchParams.get("state"), "state-123");

  const exchanged = await client.exchangeAuthorizationCode("authorization-code");
  assert.equal(exchanged.accessToken, "access-1");
  assert.equal(exchanged.refreshToken, "refresh-1");
  assert.equal(exchanged.accessTokenExpiresAt, "2026-09-21T13:00:00.000Z");
  assert.equal(exchanged.refreshTokenHardExpiresAt, "2026-10-21T12:00:00.000Z");
  const refreshed = await client.refreshToken(exchanged.refreshToken, exchanged.refreshTokenExpiresAt, exchanged.refreshTokenHardExpiresAt);
  assert.equal(refreshed.accessToken, "access-2");
  assert.equal(refreshed.refreshToken, "refresh-2");
  assert.equal(refreshed.refreshTokenHardExpiresAt, exchanged.refreshTokenHardExpiresAt, "rotation without hard-expiry metadata preserves Intuit's prior hard expiry");
  const revoked = await client.revokeToken(refreshed.refreshToken);

  assert.equal(calls[0].url, QUICKBOOKS_TOKEN_ENDPOINT);
  assert.match(calls[0].headers.Authorization, /^Basic /);
  assert.equal(calls[0].headers["x-include-refresh-token-hard-expires-in"], "true");
  assert.match(calls[0].body ?? "", /grant_type=authorization_code/);
  assert.match(calls[0].body ?? "", /code=authorization-code/);
  assert.match(calls[1].body ?? "", /grant_type=refresh_token/);
  assert.match(calls[1].body ?? "", /refresh_token=refresh-1/);
  assert.equal(calls[1].headers["x-include-refresh-token-hard-expires-in"], "true");
  assert.equal(calls[2].url, QUICKBOOKS_REVOKE_ENDPOINT);
  assert.match(calls[2].body ?? "", /token=refresh-2/);
});

test("OAuth discovery uses the environment-specific well-known endpoint and captures Intuit trace metadata", async () => {
  let call: QuickBooksTransportRequest | undefined;
  const client = createQuickBooksOAuthClient(config(async request => {
    call = request;
    return response(200, {
      authorization_endpoint: "https://appcenter.intuit.com/connect/oauth2",
      token_endpoint: QUICKBOOKS_TOKEN_ENDPOINT,
      revocation_endpoint: QUICKBOOKS_REVOKE_ENDPOINT,
    }, { intuit_tid: "tid-discovery" });
  }));
  const discovery = await client.getDiscoveryDocument();
  assert.equal(call?.method, "GET");
  assert.equal(call?.url, "https://developer.api.intuit.com/.well-known/openid_sandbox_configuration");
  assert.equal(discovery.tokenEndpoint, QUICKBOOKS_TOKEN_ENDPOINT);
  assert.equal(discovery.intuitTid, "tid-discovery");
});

test("OAuth failures are safe and do not blindly retry", async () => {
  let calls = 0;
  const client = createQuickBooksOAuthClient(config(async () => {
    calls += 1;
    return response(400, { error: "invalid_grant", error_description: "authorization code rejected", secret: "do-not-log" }, { intuit_tid: "tid-1" });
  }));
  await assert.rejects(
    () => client.exchangeAuthorizationCode("authorization-code"),
    (error: unknown) => {
      assert.ok(error instanceof QuickBooksIntegrationError);
      assert.equal(error.code, "quickbooks_oauth");
      assert.equal(error.status, 400);
      assert.equal(error.intuitTid, "tid-1");
      assert.equal(error.retryable, false);
      assert.doesNotMatch(error.message, /do-not-log/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("non-accounting provider scopes stay disabled", () => {
  const client = createQuickBooksOAuthClient(config(async () => response(500, {})));
  assert.throws(() => client.getAuthorizationUrl("state", ["com.intuit.quickbooks.payment"]), /OAuth scopes are invalid/);
});
