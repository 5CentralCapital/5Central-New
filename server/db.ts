import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from "ws";
import * as schema from "@shared/schema";
import { resolveHostDatabaseUrl } from "./host-database-config";

neonConfig.webSocketConstructor = ws;

const hostDatabaseUrl = resolveHostDatabaseUrl();
if (!hostDatabaseUrl) {
  throw new Error(
    "A host database connection must be configured.",
  );
}

export const pool = new Pool({ connectionString: hostDatabaseUrl });
export const db = drizzle({ client: pool, schema });
