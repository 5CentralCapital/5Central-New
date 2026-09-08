import { storage } from "../../storage";
import type { Express } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { RentOpsService } from '../services/service';
import type { RentOpsRepository } from '../../../shared/rent-ops-contracts';
import { createRentOpsMcpServer } from './tools';
import { oauthConfigFromEnv, READ_SCOPE, WRITE_SCOPE, validateIssuer, verifyOAuthToken } from './oauth';

export async function registerRentOpsMcpRoutes(app: Express, repository: RentOpsRepository, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = oauthConfigFromEnv(env);
  if (!config) return;
  if (new URL(config.resource).pathname !== '/mcp') throw new Error('RENT_OPS_MCP_RESOURCE must use /mcp');
  await validateIssuer(config);
  const metadataUrl = `${new URL(config.resource).origin}/.well-known/oauth-protected-resource`;
  const challenge = `Bearer resource_metadata="${metadataUrl}", scope="${READ_SCOPE}"`;
  app.get(['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'], (_req,res) => res.json({ resource:config.resource,authorization_servers:[config.issuer],scopes_supported:[READ_SCOPE,WRITE_SCOPE],bearer_methods_supported:['header'] }));
  app.post('/mcp', async (req,res) => {
    res.set('Cache-Control','no-store');
    // Reject cross-origin browser calls. ChatGPT makes authenticated server-side requests.
    const origin = req.get('origin');
    if (origin && origin !== new URL(config.resource).origin) { res.status(403).json({error:'invalid_origin'}); return; }
    const match = /^Bearer ([^\s]+)$/.exec(req.get('authorization') ?? '');
    let principal;
    try {
      principal = await verifyOAuthToken(match?.[1] ?? '',config);
      {
        const admin = await storage.getUserByEmail(env.RENT_OPS_ADMIN_EMAIL!.trim().toLowerCase());
        if (!admin || admin.role !== 'admin') throw new Error('invalid_token');
      }
    }
    catch { res.set('WWW-Authenticate',challenge).status(401).json({error:'invalid_token'}); return; }
    const server = createRentOpsMcpServer(new RentOpsService(repository),principal,config.resource);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator:undefined,enableJsonResponse:true });
    res.on('close',() => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req,res,req.body); }
    catch { if (!res.headersSent) res.status(500).json({error:'temporarily_unavailable'}); }
  });
  app.all('/mcp',(_req,res) => res.status(405).set('Allow','POST').end());
}
