import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
/** OAuth resource-server adapter. The established issuer owns PKCE, consent and revocation. */
export const READ_SCOPE = 'rent-ops:read';
export const WRITE_SCOPE = 'rent-ops:write';
export interface McpPrincipal { subject: string; scopes: string[] }
export interface OAuthConfig {
  issuer: string; resource: string; mode?: "jwt" | "introspection"; introspectionEndpoint?: string;
  introspectionClientId?: string; introspectionClientSecret?: string;
  adminSubjects: string[];
}
export function secureUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('OAuth requires canonical HTTPS URLs');
  return value;
}
export function oauthConfigFromEnv(env: NodeJS.ProcessEnv): OAuthConfig | undefined {
  if (env.RENT_OPS_MCP_ENABLED !== 'true') return undefined;
  const required = (key: string) => { const value = env[key]?.trim(); if (!value) throw new Error(`${key} is required`); return value; };
  required('RENT_OPS_ADMIN_EMAIL');
  const mode = env.RENT_OPS_OAUTH_TOKEN_MODE ?? "jwt";
  if (mode !== "jwt" && mode !== "introspection") throw new Error("Invalid OAuth token mode");
  const config: OAuthConfig = {
    mode,
    issuer: secureUrl(required('RENT_OPS_OAUTH_ISSUER')),
    resource: secureUrl(required('RENT_OPS_MCP_RESOURCE')),
    ...(mode === 'introspection' ? { introspectionEndpoint: secureUrl(required('RENT_OPS_OAUTH_INTROSPECTION_ENDPOINT')),
    introspectionClientId: required('RENT_OPS_OAUTH_INTROSPECTION_CLIENT_ID'),
    introspectionClientSecret: required('RENT_OPS_OAUTH_INTROSPECTION_CLIENT_SECRET') } : {}),
    adminSubjects: required('RENT_OPS_OAUTH_ADMIN_SUBJECTS').split(',').map(x => x.trim()).filter(Boolean),
  };
  if (!config.adminSubjects.length) throw new Error('OAuth requires explicit administrator subjects');
  return config;
}
export async function verifyOAuthToken(token: string, config: OAuthConfig, fetcher: typeof fetch = fetch): Promise<McpPrincipal> {
  if (!token || token.length > 8192 || /\s/.test(token)) throw new Error('invalid_token');
  if (config.mode === 'jwt') {
    const key = issuerKeys.get(config);
    if (!key) throw new Error('invalid_token');
    return verifyJwtToken(token, config, key);
  }
  if (!config.introspectionEndpoint || !config.introspectionClientId || !config.introspectionClientSecret) throw new Error('invalid_token');
  // No positive cache: revoked grants and disabled administrators stop on the next call.
  const response = await fetcher(config.introspectionEndpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${encodeURIComponent(config.introspectionClientId)}:${encodeURIComponent(config.introspectionClientSecret)}`).toString('base64')}` },
    body: new URLSearchParams({ token, token_type_hint: 'access_token' }),
  });
  if (!response.ok) throw new Error('invalid_token');
  const value = await response.json() as Record<string, unknown>;
  const audience = Array.isArray(value.aud) ? value.aud : [value.aud];
  const scopes = typeof value.scope === 'string' ? value.scope.split(' ').filter(Boolean) : [];
  if (value.active !== true || value.iss !== config.issuer || !audience.includes(config.resource)
    || typeof value.exp !== 'number' || value.exp <= Date.now() / 1000
    || (typeof value.nbf === 'number' && value.nbf > Date.now() / 1000)
    || typeof value.sub !== 'string' || !config.adminSubjects.includes(value.sub)
    || !scopes.includes(READ_SCOPE)) throw new Error('invalid_token');
  return { subject: value.sub, scopes };
}
export async function validateIssuer(config: OAuthConfig, fetcher: typeof fetch = fetch): Promise<void> {
  const issuer = new URL(config.issuer);
  const path = issuer.pathname.replace(/\/$/, '');
  const discovery = config.mode === "jwt" ? `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration` : `${issuer.origin}/.well-known/oauth-authorization-server${path}`;
  const response = await fetcher(discovery, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('OAuth issuer discovery unavailable');
  const metadata = await response.json() as Record<string, unknown>;
  if (metadata.issuer !== config.issuer || !Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes('S256')
    || (config.mode !== 'jwt' && metadata.introspection_endpoint !== config.introspectionEndpoint)) throw new Error('OAuth issuer metadata does not match the configured issuer, PKCE or token mode');
  for (const key of ['authorization_endpoint', 'token_endpoint']) secureUrl(String(metadata[key] ?? ''));
  if (config.mode === 'jwt') {
    const jwks = new URL(secureUrl(String(metadata.jwks_uri ?? '')));
    if (jwks.origin !== issuer.origin) throw new Error('OAuth JWKS must belong to the configured issuer');
    issuerKeys.set(config, createRemoteJWKSet(jwks, { timeoutDuration:5000, cooldownDuration:30000, cacheMaxAge:300000 }));
  }
}

const issuerKeys = new WeakMap<OAuthConfig, JWTVerifyGetKey>();
/** Auth0 custom API access tokens: exact issuer/audience and RS256 only. */
export async function verifyJwtToken(token: string, config: OAuthConfig, key: JWTVerifyGetKey): Promise<McpPrincipal> {
  if (!token || token.length > 8192 || /\s/.test(token)) throw new Error('invalid_token');
  const { payload } = await jwtVerify(token, key, { issuer:config.issuer, audience:config.resource, algorithms:['RS256'], requiredClaims:['exp','iat','sub'], maxTokenAge:900, clockTolerance:0 });
  const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];
  if (typeof payload.sub !== 'string' || !config.adminSubjects.includes(payload.sub) || !scopes.includes(READ_SCOPE)
    || typeof payload.exp !== 'number' || typeof payload.iat !== 'number' || payload.exp - payload.iat > 900) throw new Error('invalid_token');
  return { subject:payload.sub, scopes };
}
