import express, { type RequestHandler } from "express";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { User } from "../../shared/schema";
import { registerCompanyRoutes } from "../company/routes";
import { createCompanyServices } from "../company/services";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { seedRentalDemo } from "../company/testing/seed-rental-demo";
import { createRentOpsMcpServer } from "../rent-ops/mcp/tools";
import { READ_SCOPE, WRITE_SCOPE } from "../rent-ops/mcp/oauth";
import { RentOpsService } from "../rent-ops/services/service";
import { createSyntheticRentOpsRepository } from "../rent-ops/fixtures/synthetic";
import { createInMemoryObjectStore } from "../rent-ops/storage";

/**
 * Test-only harness: a synthetic company database behind the real company
 * routes (browser) and the real MCP server (Codex), sharing one set of
 * services and an in-memory verified object store. Never used by production.
 */
export async function createLaneTestApp() {
  if (process.env.NODE_ENV === "production") throw new Error("Synthetic test app is unavailable in production");
  const fixture = await createSyntheticCompanyDatabase();
  await seedRentalDemo({ executor: fixture.executor, actorId: SYNTHETIC_COMPANY.actorId, actorRole: "owner" });
  const runtime = await createSyntheticRuntimeExecutor(fixture.db);
  const storage = createInMemoryObjectStore();
  const services = createCompanyServices(runtime, { accounting: { environment: {} }, time: { env: {} }, documentStorage: storage });
  const requireAdmin: RequestHandler = (req, _res, next) => {
    const actor = req.get("x-test-actor") ?? SYNTHETIC_COMPANY.actorId;
    req.rentOpsAdminUser = { id: actor, role: "admin", email: `${actor}@example.test` } as User;
    next();
  };
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  registerCompanyRoutes(app, { ...services, requireAdmin });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const server = createRentOpsMcpServer(new RentOpsService(createSyntheticRentOpsRepository()), { subject: "verified-admin-subject", scopes: [READ_SCOPE, WRITE_SCOPE] },
    "https://example.test/mcp", { company: services, companyActorId: SYNTHETIC_COMPANY.actorId });
  const client = new Client({ name: "lane-c-review-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  const tool = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
    return (result.structuredContent as { data: unknown }).data;
  };
  const toolError = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const result = await client.callTool({ name, arguments: args });
    if (!result.isError) throw new Error(`${name} unexpectedly succeeded`);
    return JSON.stringify(result.content);
  };
  return {
    fixture, db: fixture.db, runtime, storage, services, origin, base: `${origin}/api/company/${SYNTHETIC_COMPANY.organizationId}`, client, tool, toolError,
    async close() {
      await client.close(); await server.close();
      await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
      await fixture.close();
    },
  };
}
