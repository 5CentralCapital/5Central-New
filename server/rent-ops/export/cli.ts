import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectRentManagerExport } from "./collector";
import { createLocalRentManagerTransport } from "./adapter";
import { createRentManagerDocumentBinaryFetcher } from "./binary-fetcher";
import type { DocumentBinaryFetcher, ExportResult, RentManagerTransport } from "./types";

export interface RentManagerExportCliArgs {
  archiveRoot: string;
  runId: string;
  modulePath?: string;
  pageSize?: number;
  resume: boolean;
  fetchDocumentBinaries: boolean;
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function assertSafeRunId(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") throw new Error("invalid run ID");
  return value;
}

function assertAbsoluteOutsideWorkingTree(path: string, cwd: string): string {
  if (!isAbsolute(path) || path.split(/[\\/]+/).includes("..")) throw new Error("archive root must be absolute and without traversal");
  const root = resolve(path);
  const workingTree = resolve(cwd);
  const rel = relative(workingTree, root);
  if (!rel || (!rel.startsWith(`..${requirePathSeparator()}`) && rel !== ".." && !isAbsolute(rel))) throw new Error("archive root must be outside the working tree");
  return root;
}

function requirePathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

export function parseRentManagerExportCliArgs(argv: readonly string[], cwd = process.cwd()): RentManagerExportCliArgs {
  const runId = assertSafeRunId(optionValue(argv, "--run-id") ?? randomUUID());
  const archiveArgument = optionValue(argv, "--archive-root");
  if (!archiveArgument) throw new Error("--archive-root is required; no live export runs by default");
  const archiveRoot = assertAbsoluteOutsideWorkingTree(archiveArgument, cwd);
  const pageSizeValue = optionValue(argv, "--page-size");
  const pageSize = pageSizeValue === undefined ? undefined : Number(pageSizeValue);
  if (pageSize !== undefined && (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000)) throw new Error("page size must be an integer from 1 through 1000");
  const modulePath = optionValue(argv, "--module");
  if (modulePath !== undefined && (!isAbsolute(modulePath) || modulePath.split(/[\\/]+/).includes(".."))) throw new Error("RM client module path must be absolute and without traversal");
  // Keep cwd in the signature so callers can validate an alternate worktree
  // without changing process state (useful for deterministic CLI tests).
  void cwd;
  return { archiveRoot, runId, ...(modulePath ? { modulePath } : {}), ...(pageSize === undefined ? {} : { pageSize }), resume: !argv.includes("--no-resume"), fetchDocumentBinaries: !argv.includes("--no-document-binaries") };
}

export interface RentManagerExportCliDependencies {
  createTransport?: (modulePath?: string) => Promise<RentManagerTransport>;
  createBinaryFetcher?: (transport: RentManagerTransport) => DocumentBinaryFetcher;
}

export async function runRentManagerExportCli(
  argv: readonly string[],
  dependencies: RentManagerExportCliDependencies = {},
): Promise<ExportResult> {
  const args = parseRentManagerExportCliArgs(argv);
  const createTransport = dependencies.createTransport ?? ((modulePath?: string) => createLocalRentManagerTransport(modulePath ? { modulePath } : {}));
  const transport = await createTransport(args.modulePath);
  const binaryFetcher = args.fetchDocumentBinaries
    ? (dependencies.createBinaryFetcher?.(transport) ?? createRentManagerDocumentBinaryFetcher({ transport }))
    : undefined;
  return collectRentManagerExport({ transport, archiveRoot: args.archiveRoot, runId: args.runId, resume: args.resume, ...(args.pageSize === undefined ? {} : { pageSize: args.pageSize }), ...(binaryFetcher ? { binaryFetcher } : {}) });
}

export function redactedCliSummary(result: ExportResult): Record<string, unknown> {
  return {
    runId: result.manifest.runId,
    complete: result.manifest.complete,
    archiveRoot: result.archive?.root,
    counts: result.manifest.counts,
    collections: result.manifest.collections.map((collection) => ({ name: collection.name, status: collection.status, received: collection.received, expected: collection.expected })),
    exceptionCount: result.manifest.exceptions.length,
  };
}

async function main(): Promise<void> {
  if (process.argv.length <= 2 || process.argv.includes("--help")) {
    process.stdout.write("Usage: rm-export --archive-root /absolute/restricted/path [--module /absolute/rm-client.js] [--run-id id] [--page-size n] [--no-resume] [--no-document-binaries]\n");
    return;
  }
  try {
    const result = await runRentManagerExportCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(redactedCliSummary(result))}\n`);
    if (!result.manifest.complete) process.exitCode = 2;
  } catch (error) {
    const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "rm_export_cli_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
