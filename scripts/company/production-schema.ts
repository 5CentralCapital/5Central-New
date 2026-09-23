/**
 * Reviewed production schema operator (5Central Ops).
 *
 * The only supported way to bring a live database to the build's migration
 * version and runtime grants. Production startup never migrates, and
 * `db:push` / `db:migrate` stay blocked.
 *
 * Connection strings are read from environment variables by NAME and are
 * never printed. Use the database OWNER (migration) identity, not the
 * restricted runtime identity.
 *
 *   npm run company:production-schema -- describe        --url-env RENT_OPS_MIGRATION_DATABASE_URL
 *   npm run company:production-schema -- inspect         --url-env RENT_OPS_MIGRATION_DATABASE_URL --through 48
 *   npm run company:production-schema -- compare-backup  --url-env RENT_OPS_MIGRATION_DATABASE_URL --backup-url-env RENT_OPS_BACKUP_DATABASE_URL
 *   npm run company:production-schema -- apply           --url-env ... --through 48 --confirm <planSha256> --apply-reviewed
 *   npm run company:production-schema -- grants-plan     --url-env ... --runtime-role R --importer-role I --auditor-role A --backup <ref> --review <ref> --authorization <ref>
 *   npm run company:production-schema -- grants-apply    ...same... --confirm <grantSha256> --apply-reviewed
 *   npm run company:production-schema -- grants-verify   ...same...
 *
 * `apply` and `grants-apply` refuse to run without the digest printed by the
 * matching read-only command and the explicit --apply-reviewed flag.
 */
import { pathToFileURL } from "node:url";
import {
  ProductionSchemaError,
  applyRuntimeGrants,
  applySchemaMigration,
  compareBackup,
  describeSession,
  inspectSchema,
  planRuntimeGrants,
  verifyRuntimeGrants,
  type SchemaSession,
} from "../../server/company/operations/production-schema";
import { RENT_OPS_SCHEMA_VERSION } from "../../server/rent-ops/persistence";

const COMMANDS = ["describe", "inspect", "compare-backup", "apply", "grants-plan", "grants-apply", "grants-verify"] as const;
type Command = typeof COMMANDS[number];
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;

export interface ParsedArgs {
  readonly command: Command;
  readonly flags: Readonly<Record<string, string | true>>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (!command || !(COMMANDS as readonly string[]).includes(command)) {
    throw new ProductionSchemaError("cli_usage", `Command must be one of: ${COMMANDS.join(", ")}`);
  }
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith("--")) throw new ProductionSchemaError("cli_usage", `Unexpected argument: ${token}`);
    const name = token.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) flags[name] = true;
    else {
      flags[name] = next;
      index += 1;
    }
  }
  const allowed = new Set(["url-env", "backup-url-env", "through", "confirm", "apply-reviewed", "runtime-role", "importer-role", "auditor-role", "backup", "review", "authorization", "database"]);
  const unknown = Object.keys(flags).filter(name => !allowed.has(name));
  if (unknown.length) throw new ProductionSchemaError("cli_usage", `Unknown option(s): ${unknown.map(name => `--${name}`).join(" ")}`);
  return { command: command as Command, flags };
}

function stringFlag(flags: ParsedArgs["flags"], name: string, fallback?: string): string {
  const value = flags[name];
  if (typeof value === "string") return value;
  if (fallback !== undefined) return fallback;
  throw new ProductionSchemaError("cli_usage", `--${name} is required`);
}

function throughFlag(flags: ParsedArgs["flags"]): number {
  const raw = stringFlag(flags, "through", String(RENT_OPS_SCHEMA_VERSION));
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new ProductionSchemaError("cli_usage", "--through must be an integer");
  return value;
}

function connectionString(envName: string, env: NodeJS.ProcessEnv): string {
  if (!ENV_NAME.test(envName)) throw new ProductionSchemaError("cli_usage", "Connection variable name is invalid");
  const value = env[envName];
  if (!value) throw new ProductionSchemaError("connection_missing", `${envName} is not set in this shell`);
  let url: URL;
  try { url = new URL(value); } catch { throw new ProductionSchemaError("connection_invalid", `${envName} is not a URL`); }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new ProductionSchemaError("connection_invalid", `${envName} is not a PostgreSQL URL`);
  return value;
}

export interface SessionHandle {
  readonly session: SchemaSession;
  close(): Promise<void>;
}

/** One dedicated connection (transactions need a single session). */
export async function openSession(url: string): Promise<SessionHandle> {
  const [{ Pool, neonConfig }, { default: ws }] = await Promise.all([import("@neondatabase/serverless"), import("ws")]);
  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: url, max: 1 });
  let client: Awaited<ReturnType<typeof pool.connect>>;
  try {
    client = await pool.connect();
  } catch {
    await pool.end().catch(() => undefined);
    // Driver errors can echo the host or user; keep the boundary generic.
    throw new ProductionSchemaError("connection_failed", "Could not connect to the database (check the variable and network)");
  }
  return {
    session: { query: async (text, values) => ({ rows: (await client.query(text, values as unknown[] | undefined)).rows }) },
    async close() {
      client.release();
      await pool.end();
    },
  };
}

type Output = Record<string, unknown>;

export async function runCommand(parsed: ParsedArgs, env: NodeJS.ProcessEnv = process.env, open: (url: string) => Promise<SessionHandle> = openSession): Promise<Output> {
  const { command, flags } = parsed;
  const urlEnv = stringFlag(flags, "url-env", "RENT_OPS_MIGRATION_DATABASE_URL");
  const primary = await open(connectionString(urlEnv, env));
  try {
    const session = primary.session;
    switch (command) {
      case "describe":
        return { command, connection: urlEnv, ...(await describeSession(session)) };
      case "inspect": {
        const plan = await inspectSchema(session, throughFlag(flags));
        return {
          command,
          connection: urlEnv,
          installedThrough: plan.installedThrough,
          throughVersion: plan.throughVersion,
          pending: plan.pending,
          planSha256: plan.planSha256,
          next: plan.pending.length
            ? `Back up, then: npm run company:production-schema -- apply --url-env ${urlEnv} --through ${plan.throughVersion} --confirm ${plan.planSha256} --apply-reviewed`
            : "Nothing to apply.",
        };
      }
      case "compare-backup": {
        const backupEnv = stringFlag(flags, "backup-url-env");
        if (backupEnv === urlEnv) throw new ProductionSchemaError("cli_usage", "--backup-url-env must name a different variable");
        const backupUrl = connectionString(backupEnv, env);
        if (backupUrl === env[urlEnv]) throw new ProductionSchemaError("backup_same_database", "The backup variable points at the same database");
        const backup = await open(backupUrl);
        try {
          return { command, source: urlEnv, backup: backupEnv, ...(await compareBackup(session, backup.session)) };
        } finally {
          await backup.close();
        }
      }
      case "apply": {
        if (flags["apply-reviewed"] !== true) throw new ProductionSchemaError("cli_usage", "apply requires --apply-reviewed");
        const result = await applySchemaMigration(session, { throughVersion: throughFlag(flags), confirmPlanSha256: stringFlag(flags, "confirm") });
        return { command, connection: urlEnv, ...result };
      }
      case "grants-plan":
      case "grants-apply":
      case "grants-verify": {
        const describe = await describeSession(session);
        const databaseName = stringFlag(flags, "database", String(describe.database ?? ""));
        const plan = planRuntimeGrants(
          { runtimeRole: stringFlag(flags, "runtime-role"), importerRole: stringFlag(flags, "importer-role"), auditorRole: stringFlag(flags, "auditor-role") },
          { backup: stringFlag(flags, "backup"), review: stringFlag(flags, "review"), authorization: stringFlag(flags, "authorization") },
          databaseName,
        );
        if (command === "grants-plan") {
          return { command, connection: urlEnv, database: databaseName, grantSha256: plan.grantSha256, statementCount: plan.statements.length, sql: plan.sql };
        }
        if (command === "grants-verify") {
          const mismatches = await verifyRuntimeGrants(session, plan);
          return { command, connection: urlEnv, database: databaseName, verified: mismatches.length === 0, mismatchCount: mismatches.length, mismatches: mismatches.slice(0, 50) };
        }
        if (flags["apply-reviewed"] !== true) throw new ProductionSchemaError("cli_usage", "grants-apply requires --apply-reviewed");
        const result = await applyRuntimeGrants(session, plan, stringFlag(flags, "confirm"));
        return { command, connection: urlEnv, database: databaseName, grantSha256: plan.grantSha256, ...result };
      }
    }
  } finally {
    await primary.close();
  }
}

async function main(): Promise<void> {
  try {
    const output = await runCommand(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(output, null, 2));
  } catch (error) {
    if (error instanceof ProductionSchemaError) {
      console.error(JSON.stringify({ ok: false, code: error.code, message: error.message, details: error.details }, null, 2));
    } else {
      // Database errors may include SQL text but never the connection string.
      const message = error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/gi, "<redacted-url>") : "unexpected failure";
      console.error(JSON.stringify({ ok: false, code: "unexpected", message }, null, 2));
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
