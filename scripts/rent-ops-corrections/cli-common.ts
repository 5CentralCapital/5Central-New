/** Shared guards for the owner-correction CLIs. No scenario defaults; private outputs only. */
import { open, mkdir, readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRentOpsRuntimeDatabase } from "../../server/rent-ops/runtime-database";
import { createPostgresRentOpsRepository } from "../../server/rent-ops/repositories/postgres";
import type { RentOpsRepository, RentOpsSnapshot } from "../../shared/rent-ops-contracts";

export class CliGuardError extends Error { constructor(readonly code: string) { super(code); } }
export function guard(value: unknown, code: string): asserts value { if (!value) throw new CliGuardError(code); }

export function parseArgs(argv: string[]) {
  const args = argv.slice();
  const option = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined; };
  const required = (name: string) => { const value = option(name); guard(value, `missing_${name}`); return value; };
  const flag = (name: string) => args.includes(`--${name}`);
  return { args, option, required, flag };
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** Real-data outputs never land inside the repository working tree. */
export async function privateOutputDirectory(path: string) {
  const out = resolve(path);
  const inside = relative(repositoryRoot, out);
  guard(inside.startsWith("..") || isAbsolute(inside), "output_directory_inside_repository");
  await mkdir(out, { recursive: true, mode: 0o700 });
  return out;
}

export async function durable(path: string, value: unknown) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n"); await file.sync(); } finally { await file.close(); }
}

export async function withLiveRepository<T>(databaseUrl: string, work: (repository: RentOpsRepository) => Promise<T>): Promise<T> {
  const db = await createRentOpsRuntimeDatabase({ env: { ...process.env, RENT_OPS_RUNTIME_DATABASE_URL: databaseUrl } });
  try { return await work(createPostgresRentOpsRepository(db)); } finally { await db.close(); }
}

export async function readJson<T>(path: string): Promise<{ bytes: Buffer; value: T }> {
  const bytes = await readFile(resolve(path));
  return { bytes, value: JSON.parse(bytes.toString("utf8")) as T };
}

export function reportFailure(error: unknown) {
  const code = error instanceof CliGuardError ? error.code : (error as { code?: unknown })?.code && typeof (error as { code?: unknown }).code === "string" && /^[a-z0-9_:.-]+$/i.test((error as { code: string }).code) ? (error as { code: string }).code : "failed_details_suppressed";
  const message = error instanceof Error && /^(Exact|Explicit|Charge|Account|Before-state|Reversal|Owner|Invalid|Verified|Each|Future|Related|Reconciliation)/.test(error.message) ? error.message : undefined;
  console.error(JSON.stringify({ ok: false, code, ...(message ? { message } : {}) }));
  process.exitCode = 1;
}

export type { RentOpsSnapshot };
