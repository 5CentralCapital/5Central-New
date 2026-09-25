/**
 * Verified document relocation operator: Replit-managed GCS -> private S3.
 *
 * Run order (see docs/company/document-relocation.md):
 *
 *   npm run company:document-relocation -- inventory
 *   npm run company:document-relocation -- copy     --manifest <file> --run-id <id> [--limit N] [--concurrency 4]   # inside Replit
 *   npm run company:document-relocation -- plan     --manifest <file> --run-id <id> --authorization <ref>
 *   npm run company:document-relocation -- apply    --manifest <file> --run-id <id> --authorization <ref> --confirm <planSha256> --apply-reviewed [--rehash]
 *   npm run company:document-relocation -- readback [--sample N] [--target-env-prefix RENT_OPS_OBJECT_STORE]
 *
 * Environment (names only; values are never printed):
 *   --url-env (default RENT_OPS_MIGRATION_DATABASE_URL)  database owner URL; copy/plan/inventory only read.
 *   Source (copy): RENT_OPS_RELOCATION_SOURCE_BUCKET / RENT_OPS_RELOCATION_SOURCE_PREFIX, or the Replit
 *     app's own RENT_OPS_OBJECT_STORE_BUCKET / _PREFIX when RENT_OPS_OBJECT_STORE_BACKEND=replit-managed-gcs.
 *   Target: <prefix>_ENDPOINT, _REGION, _BUCKET, _PREFIX; writer <prefix>_IMPORTER_IDENTITY/_TOKEN (copy);
 *     reader <prefix>_RUNTIME_IDENTITY/_TOKEN (copy, apply, readback). Default prefix RENT_OPS_RELOCATION_TARGET
 *     so the Replit app's own RENT_OPS_OBJECT_STORE_* values are never reused by mistake.
 */
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  DocumentRelocationError,
  RELOCATION_MANIFEST_FORMAT,
  RELOCATION_TARGET_BACKEND,
  REPLIT_MANAGED_GCS_BACKEND,
  applyRelocation,
  copyObjects,
  inventoryBindings,
  planRelocation,
  readEffectiveBindings,
  readbackRelocation,
  validateManifest,
  type ManifestTarget,
  type RelocationManifest,
  type SourceObjectReader,
  type TargetObjectReader,
  type TargetObjectWriter,
} from "../../server/rent-ops/storage/document-relocation";
import { S3CompatiblePrivateVersionedObjectStoreClient } from "../../server/rent-ops/storage/object-store";
import { openSession, type SessionHandle } from "./production-schema";

const COMMANDS = ["inventory", "copy", "plan", "apply", "readback"] as const;
type Command = typeof COMMANDS[number];
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const FLAGS = new Set(["url-env", "manifest", "run-id", "authorization", "from-backend", "limit", "concurrency", "confirm", "apply-reviewed", "allow-partial", "rehash", "sample", "target-env-prefix"]);

export interface ParsedArgs {
  readonly command: Command;
  readonly flags: Readonly<Record<string, string | true>>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (!command || !(COMMANDS as readonly string[]).includes(command)) throw new DocumentRelocationError("cli_usage", `Command must be one of: ${COMMANDS.join(", ")}`);
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith("--")) throw new DocumentRelocationError("cli_usage", `Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!FLAGS.has(name)) throw new DocumentRelocationError("cli_usage", `Unknown option: --${name}`);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) flags[name] = true;
    else { flags[name] = next; index += 1; }
  }
  return { command: command as Command, flags };
}

function stringFlag(flags: ParsedArgs["flags"], name: string, fallback?: string): string {
  const value = flags[name];
  if (typeof value === "string") return value;
  // A flag given without a value is a typo, not a request for the default.
  if (value === true) throw new DocumentRelocationError("cli_usage", `--${name} needs a value`);
  if (fallback !== undefined) return fallback;
  throw new DocumentRelocationError("cli_usage", `--${name} is required`);
}

function integerFlag(flags: ParsedArgs["flags"], name: string, min: number, max: number): number | undefined {
  if (flags[name] === undefined) return undefined;
  const value = Number(stringFlag(flags, name));
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new DocumentRelocationError("cli_usage", `--${name} must be an integer from ${min} to ${max}`);
  return value;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string {
  if (!ENV_NAME.test(name)) throw new DocumentRelocationError("cli_usage", "Environment variable name is invalid");
  const value = env[name]?.trim();
  if (!value) throw new DocumentRelocationError("environment_missing", `${name} is not set in this shell`);
  return value;
}

function databaseUrl(env: NodeJS.ProcessEnv, name: string): string {
  const value = envValue(env, name);
  let url: URL;
  try { url = new URL(value); } catch { throw new DocumentRelocationError("connection_invalid", `${name} is not a URL`); }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new DocumentRelocationError("connection_invalid", `${name} is not a PostgreSQL URL`);
  return value;
}

export interface TargetConfig {
  readonly location: ManifestTarget;
  readonly endpoint: string;
  readonly region: string;
}

export function targetConfig(env: NodeJS.ProcessEnv, prefix: string): TargetConfig {
  const endpoint = envValue(env, `${prefix}_ENDPOINT`);
  let host: string;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") throw new Error("https");
    host = url.host;
  } catch {
    throw new DocumentRelocationError("target_invalid", `${prefix}_ENDPOINT must be an https URL`);
  }
  return { endpoint, region: envValue(env, `${prefix}_REGION`), location: { endpointHost: host, bucket: envValue(env, `${prefix}_BUCKET`), prefix: envValue(env, `${prefix}_PREFIX`) } };
}

function s3Client(env: NodeJS.ProcessEnv, prefix: string, target: TargetConfig, role: "IMPORTER" | "RUNTIME"): S3CompatiblePrivateVersionedObjectStoreClient {
  return new S3CompatiblePrivateVersionedObjectStoreClient({
    endpoint: target.endpoint,
    region: target.region,
    bucket: target.location.bucket,
    prefix: target.location.prefix,
    accessKeyId: envValue(env, `${prefix}_${role}_IDENTITY`),
    secretAccessKey: envValue(env, `${prefix}_${role}_TOKEN`),
  });
}

async function replitSource(env: NodeJS.ProcessEnv): Promise<SourceObjectReader> {
  const useApp = !env.RENT_OPS_RELOCATION_SOURCE_BUCKET && env.RENT_OPS_OBJECT_STORE_BACKEND === REPLIT_MANAGED_GCS_BACKEND;
  const bucketId = envValue(env, useApp ? "RENT_OPS_OBJECT_STORE_BUCKET" : "RENT_OPS_RELOCATION_SOURCE_BUCKET");
  const prefix = envValue(env, useApp ? "RENT_OPS_OBJECT_STORE_PREFIX" : "RENT_OPS_RELOCATION_SOURCE_PREFIX");
  if (!/^replit-objstore-[a-f0-9-]{36}$/.test(bucketId)) throw new DocumentRelocationError("source_invalid", "The source bucket is not a Replit object storage bucket id");
  const [{ Client }, { ReplitManagedGcsClient }] = await Promise.all([import("@replit/object-storage"), import("../../server/rent-ops/storage/replit-managed-gcs")]);
  const client = new Client({ bucketId }) as unknown as { getBucket(): Promise<import("../../server/rent-ops/storage/replit-managed-gcs").ManagedBucket> };
  let bucket: import("../../server/rent-ops/storage/replit-managed-gcs").ManagedBucket;
  try {
    bucket = await client.getBucket();
  } catch {
    throw new DocumentRelocationError("source_unavailable", "Replit object storage is not reachable from this shell (run copy inside the Replit workspace)");
  }
  if (bucket.name !== bucketId) throw new DocumentRelocationError("source_invalid", "The Replit bucket name does not match");
  return new ReplitManagedGcsClient(bucket, prefix);
}

function readManifest(path: string): RelocationManifest {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { throw new DocumentRelocationError("manifest_unreadable", "The manifest file could not be read as JSON"); }
  return validateManifest(parsed);
}

function writeManifest(path: string, manifest: RelocationManifest): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function sameTarget(a: ManifestTarget, b: ManifestTarget): boolean {
  return a.endpointHost === b.endpointHost && a.bucket === b.bucket && a.prefix === b.prefix;
}

export interface Dependencies {
  readonly open: (url: string) => Promise<SessionHandle>;
  readonly source: (env: NodeJS.ProcessEnv) => Promise<SourceObjectReader>;
  readonly writer: (env: NodeJS.ProcessEnv, prefix: string, target: TargetConfig) => TargetObjectWriter;
  readonly reader: (env: NodeJS.ProcessEnv, prefix: string, target: TargetConfig) => TargetObjectReader;
  readonly log: (line: string) => void;
}

const defaults: Dependencies = {
  open: openSession,
  source: replitSource,
  writer: (env, prefix, target) => s3Client(env, prefix, target, "IMPORTER"),
  reader: (env, prefix, target) => s3Client(env, prefix, target, "RUNTIME"),
  log: line => console.error(line),
};

export async function runCommand(parsed: ParsedArgs, env: NodeJS.ProcessEnv = process.env, deps: Dependencies = defaults): Promise<Record<string, unknown>> {
  const { command, flags } = parsed;
  const urlEnv = stringFlag(flags, "url-env", "RENT_OPS_MIGRATION_DATABASE_URL");
  const targetPrefix = stringFlag(flags, "target-env-prefix", "RENT_OPS_RELOCATION_TARGET");
  if (!ENV_NAME.test(targetPrefix)) throw new DocumentRelocationError("cli_usage", "--target-env-prefix is invalid");
  const fromBackend = stringFlag(flags, "from-backend", REPLIT_MANAGED_GCS_BACKEND);
  const handle = await deps.open(databaseUrl(env, urlEnv));
  try {
    const session = handle.session;
    switch (command) {
      case "inventory": {
        const inventory = inventoryBindings(await readEffectiveBindings(session));
        return { command, connection: urlEnv, ...inventory };
      }
      case "copy": {
        const manifestPath = stringFlag(flags, "manifest");
        const runId = stringFlag(flags, "run-id");
        const target = targetConfig(env, targetPrefix);
        if (envValue(env, `${targetPrefix}_IMPORTER_IDENTITY`) === envValue(env, `${targetPrefix}_RUNTIME_IDENTITY`)) {
          throw new DocumentRelocationError("target_invalid", "The writer and reader identities must differ");
        }
        let previous: RelocationManifest | undefined;
        if (existsSync(manifestPath)) {
          previous = readManifest(manifestPath);
          if (previous.runId !== runId || previous.fromBackend !== fromBackend || !sameTarget(previous.target, target.location)) {
            throw new DocumentRelocationError("manifest_mismatch", "The existing manifest belongs to another run, source or target; choose a new file");
          }
        }
        const bindings = await readEffectiveBindings(session);
        const source = await deps.source(env);
        const writer = deps.writer(env, targetPrefix, target);
        const reader = deps.reader(env, targetPrefix, target);
        let latest: RelocationManifest = previous ?? { format: RELOCATION_MANIFEST_FORMAT, runId, fromBackend, toBackend: RELOCATION_TARGET_BACKEND, target: target.location, objects: [] };
        const accumulated = new Map(latest.objects.map(object => [`${object.logicalKey}|${object.fromImmutableGeneration}|${object.fromImmutableVersion}`, object]));
        let sinceSave = 0;
        const result = await copyObjects({
          bindings,
          fromBackend,
          source,
          writer,
          reader,
          previous: latest.objects,
          concurrency: integerFlag(flags, "concurrency", 1, 8),
          limit: integerFlag(flags, "limit", 1, 1_000_000),
          onCopied: (object, done, total) => {
            accumulated.set(`${object.logicalKey}|${object.fromImmutableGeneration}|${object.fromImmutableVersion}`, object);
            sinceSave += 1;
            if (sinceSave >= 25) {
              latest = { ...latest, objects: Array.from(accumulated.values()) };
              writeManifest(manifestPath, latest);
              sinceSave = 0;
            }
            if (done % 50 === 0 || done === total) deps.log(`copied ${done}/${total}`);
          },
        });
        latest = { ...latest, objects: result.objects };
        writeManifest(manifestPath, latest);
        return {
          command,
          manifest: manifestPath,
          runId,
          fromBackend,
          target: target.location,
          objectsInManifest: result.objects.length,
          copiedThisRun: result.copiedThisRun,
          skippedAlreadyCopied: result.skippedAlreadyCopied,
          remaining: result.remaining,
          failureCount: result.failures.length,
          failures: result.failures.slice(0, 50),
          next: result.remaining || result.failures.length
            ? "Re-run the same copy command to retry; it resumes from the manifest."
            : `npm run company:document-relocation -- plan --manifest ${manifestPath} --run-id ${runId} --authorization <ref>`,
        };
      }
      case "plan":
      case "apply": {
        const manifestPath = stringFlag(flags, "manifest");
        const manifest = readManifest(manifestPath);
        const options = { runId: stringFlag(flags, "run-id"), authorization: stringFlag(flags, "authorization"), fromBackend };
        if (command === "plan") {
          const plan = planRelocation(await readEffectiveBindings(session), manifest, options);
          return {
            command,
            connection: urlEnv,
            runId: plan.runId,
            fromBackend: plan.fromBackend,
            toBackend: plan.toBackend,
            target: manifest.target,
            documentsToRelocate: plan.rows.length,
            objects: plan.objects,
            bytes: plan.bytes,
            alreadyOnTarget: plan.alreadyOnTarget,
            missingCount: plan.missingDocumentIds.length,
            missingDocumentIds: plan.missingDocumentIds.slice(0, 20),
            planSha256: plan.planSha256,
            next: plan.missingDocumentIds.length
              ? "Some documents have no copied object: re-run copy (or pass --allow-partial to apply deliberately)."
              : `npm run company:document-relocation -- apply --manifest ${manifestPath} --run-id ${plan.runId} --authorization ${plan.authorization} --confirm ${plan.planSha256} --apply-reviewed`,
          };
        }
        if (flags["apply-reviewed"] !== true) throw new DocumentRelocationError("cli_usage", "apply requires --apply-reviewed");
        const target = targetConfig(env, targetPrefix);
        if (!sameTarget(manifest.target, target.location)) throw new DocumentRelocationError("target_mismatch", "The target environment differs from the manifest's target");
        const result = await applyRelocation(session, manifest, {
          ...options,
          confirmPlanSha256: stringFlag(flags, "confirm"),
          allowPartial: flags["allow-partial"] === true,
          rehash: flags.rehash === true,
          reader: deps.reader(env, targetPrefix, target),
        });
        return { command, connection: urlEnv, ...result };
      }
      case "readback": {
        const target = targetConfig(env, targetPrefix);
        const result = await readbackRelocation(session, deps.reader(env, targetPrefix, target), { sample: integerFlag(flags, "sample", 1, 1_000_000) });
        return { command, connection: urlEnv, target: target.location, ...result.inventory, verifiedObjects: result.verified, failureCount: result.failures.length, failures: result.failures.slice(0, 50) };
      }
    }
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  try {
    const output = await runCommand(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(output, null, 2));
    if (typeof output.failureCount === "number" && output.failureCount > 0) process.exitCode = 1;
  } catch (error) {
    if (error instanceof DocumentRelocationError) {
      console.error(JSON.stringify({ ok: false, code: error.code, message: error.message, details: error.details }, null, 2));
    } else {
      const code = error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string" ? (error as { code: string }).code : "unexpected";
      const message = error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/gi, "<redacted-url>").replace(/AKIA[0-9A-Z]{16}/g, "<redacted-key>") : "unexpected failure";
      console.error(JSON.stringify({ ok: false, code, message }, null, 2));
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
