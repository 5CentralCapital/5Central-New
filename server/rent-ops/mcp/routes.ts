import { storage } from "../../storage";
import type { Express, RequestHandler } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { RentOpsService } from '../services/service';
import type { RentOpsRepository } from '../../../shared/rent-ops-contracts';
import { createRentOpsMcpServer, type McpOperationalOptions } from './tools';
import { oauthConfigFromEnv, READ_SCOPE, WRITE_SCOPE, validateIssuer, verifyOAuthToken, type McpPrincipal } from './oauth';
import { mcpJsonBodyParser } from '../../request-body-parsers';
import { mcpOptionsForClient } from '../../intake/mcp';

export async function registerRentOpsMcpRoutes(app: Express, repository: RentOpsRepository, env: NodeJS.ProcessEnv = process.env, options: McpOperationalOptions = {}): Promise<void> {
  const config = oauthConfigFromEnv(env);
  if (!config) return;
  if (new URL(config.resource).pathname !== '/mcp') throw new Error('RENT_OPS_MCP_RESOURCE must use /mcp');
  await validateIssuer(config);
  const metadataUrl = `${new URL(config.resource).origin}/.well-known/oauth-protected-resource`;
  const challenge = `Bearer resource_metadata="${metadataUrl}", scope="${READ_SCOPE}"`;
  app.get(['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'], (_req,res) => res.json({ resource:config.resource,authorization_servers:[config.issuer],scopes_supported:[READ_SCOPE,WRITE_SCOPE],bearer_methods_supported:['header'] }));
  const authenticate: RequestHandler = async (req,res,next) => {
    res.set('Cache-Control','no-store');
    // Reject cross-origin browser calls. ChatGPT makes authenticated server-side requests.
    const origin = req.get('origin');
    if (origin && origin !== new URL(config.resource).origin) { res.status(403).json({error:'invalid_origin'}); return; }
    const match = /^Bearer ([^\s]+)$/.exec(req.get('authorization') ?? '');
    try {
      const principal = await verifyOAuthToken(match?.[1] ?? '',config);
      const admin = await storage.getUserByEmail(env.RENT_OPS_ADMIN_EMAIL!.trim().toLowerCase());
      if (!admin || admin.role !== 'admin') throw new Error('invalid_token');
      res.locals.mcpPrincipal = principal;
      res.locals.mcpCompanyActorId = admin.id;
    }
    catch { res.set('WWW-Authenticate',challenge).status(401).json({error:'invalid_token'}); return; }
    next();
  };
  // The large upload parser runs only for a verified caller.
  app.post('/mcp', authenticate, mcpJsonBodyParser, async (req,res) => {
    const principal = res.locals.mcpPrincipal as McpPrincipal;
    const companyActorId = res.locals.mcpCompanyActorId as string;
    // This deployment explicitly maps its allowlisted OAuth subjects to the
    // configured administrator. Company records and private presets therefore
    // keep the same owner in the browser and Codex.
    // One /mcp endpoint serves ChatGPT, Claude Code and Codex: MRA ingestion is
    // attested only for the allowlisted Codex OAuth client of the verified token.
    const server = createRentOpsMcpServer(new RentOpsService(repository),principal,config.resource,{ ...mcpOptionsForClient(principal, config, options), companyActorId });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator:undefined,enableJsonResponse:true });
    res.on('close',() => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req,res,req.body); }
    catch { if (!res.headersSent) res.status(500).json({error:'temporarily_unavailable'}); }
  });
  app.all('/mcp',(_req,res) => res.status(405).set('Allow','POST').end());
}
