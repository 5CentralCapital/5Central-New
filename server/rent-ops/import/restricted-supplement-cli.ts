import { pathToFileURL } from "node:url";
import {
  applyRestrictedSupplementPackage,
  type RestrictedSupplementDerivativeResult,
  type RestrictedSupplementExternalVerifier,
  RestrictedSupplementDerivativeArchiveError,
} from "./restricted-supplement-archive";

const SAFE_REASON = /^[A-Za-z0-9_.:-]{1,160}$/;
const SHA256 = /^[a-f0-9]{64}$/i;

export interface RestrictedSupplementCliArgs {
  archiveRoot: string;
  derivativeRoot: string;
  supplementPackagePath: string;
}

export interface RestrictedSupplementCliOutput {
  ok: true;
  status: "written" | "no_op";
  countsAdded: Record<string, number>;
  exceptionsRemoved: number;
  parentEnvelopeSha256: string;
  parentManifestSha256: string;
  derivativeEnvelopeSha256: string;
  derivativeManifestSha256: string;
  supplementSha256: string;
  provenanceSha256: string;
  derivativeRootHash: string;
}

/** The CLI never invents authority. Production callers must inject a verifier
 * backed by a separate signature/operator-record store; no secret is read by
 * this module and the standalone process remains fail-closed. */
export interface RestrictedSupplementCliRuntime {
  externalVerifier: RestrictedSupplementExternalVerifier;
}

function safeReason(value: unknown): string {
  const text = String(value ?? "");
  return SAFE_REASON.test(text) ? text : "redacted_reason";
}

function safeHash(value: unknown): string {
  const text = String(value ?? "");
  return SHA256.test(text) ? text.toLowerCase() : "redacted_hash";
}

function argumentValue(argv: readonly string[], index: number, flag: string): { value: string; nextIndex: number } {
  const argument = argv[index];
  if (argument?.startsWith(`${flag}=`)) {
    const value = argument.slice(flag.length + 1);
    if (!value) throw new Error(`${flag}_requires_value`);
    return { value, nextIndex: index };
  }
  if (argument === flag) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag}_requires_value`);
    return { value, nextIndex: index + 1 };
  }
  throw new Error("unsupported_argument");
}

export function parseRestrictedSupplementCliArgs(argv: readonly string[]): RestrictedSupplementCliArgs {
  let archiveRoot: string | undefined;
  let derivativeRoot: string | undefined;
  let supplementPackagePath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") throw new Error("restricted_supplement_cli_usage");
    if (argument === "--archive-root" || argument.startsWith("--archive-root=")) {
      const parsed = argumentValue(argv, index, "--archive-root"); archiveRoot = parsed.value; index = parsed.nextIndex; continue;
    }
    if (argument === "--derivative-root" || argument.startsWith("--derivative-root=") || argument === "--output-root" || argument.startsWith("--output-root=")) {
      const flag = argument.startsWith("--output-root") ? "--output-root" : "--derivative-root";
      const parsed = argumentValue(argv, index, flag); derivativeRoot = parsed.value; index = parsed.nextIndex; continue;
    }
    if (argument === "--supplement-package" || argument.startsWith("--supplement-package=") || argument === "--supplement" || argument.startsWith("--supplement=")) {
      const flag = argument.startsWith("--supplement=") || argument === "--supplement" ? "--supplement" : "--supplement-package";
      const parsed = argumentValue(argv, index, flag); supplementPackagePath = parsed.value; index = parsed.nextIndex; continue;
    }
    throw new Error("unsupported_argument");
  }
  if (!archiveRoot) throw new Error("archive_root_required");
  if (!derivativeRoot) throw new Error("derivative_root_required");
  if (!supplementPackagePath) throw new Error("supplement_package_required");
  return { archiveRoot, derivativeRoot, supplementPackagePath };
}

export function formatRestrictedSupplementOutput(result: RestrictedSupplementDerivativeResult): RestrictedSupplementCliOutput {
  return {
    ok: true,
    status: result.status,
    countsAdded: Object.fromEntries(Object.entries(result.report.countsAdded).map(([key, value]) => [safeReason(key), Number.isSafeInteger(value) && value >= 0 ? value : 0])),
    exceptionsRemoved: Number.isSafeInteger(result.report.exceptionsRemoved) && result.report.exceptionsRemoved >= 0 ? result.report.exceptionsRemoved : 0,
    parentEnvelopeSha256: safeHash(result.provenance.parentEnvelopeSha256),
    parentManifestSha256: safeHash(result.provenance.parentManifestSha256),
    derivativeEnvelopeSha256: safeHash(result.provenance.derivativeEnvelopeSha256),
    derivativeManifestSha256: safeHash(result.provenance.derivativeManifestSha256),
    supplementSha256: safeHash(result.provenance.supplementSha256),
    provenanceSha256: safeHash(result.provenanceSha256),
    derivativeRootHash: safeHash(result.derivativeRootHash),
  };
}

export function formatRestrictedSupplementError(error: unknown): string {
  const reasons = error instanceof RestrictedSupplementDerivativeArchiveError
    ? error.reasons.map(safeReason)
    : ["restricted_supplement_failed"];
  return JSON.stringify({ ok: false, blockedReasons: reasons }, null, 2);
}

export async function runRestrictedSupplementCli(args: RestrictedSupplementCliArgs, runtime?: RestrictedSupplementCliRuntime): Promise<RestrictedSupplementCliOutput> {
  const result = await applyRestrictedSupplementPackage({ ...args, ...(runtime?.externalVerifier ? { externalVerifier: runtime.externalVerifier } : {}) });
  return formatRestrictedSupplementOutput(result);
}

async function main(): Promise<void> {
  try {
    const args = parseRestrictedSupplementCliArgs(process.argv.slice(2));
    const result = await runRestrictedSupplementCli(args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${formatRestrictedSupplementError(error)}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) void main();
