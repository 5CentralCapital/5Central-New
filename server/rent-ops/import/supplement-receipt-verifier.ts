import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { canonicalJson } from "../export/hash";
import type { RestrictedSupplementExternalVerifier, RestrictedSupplementExternalVerificationInput } from "./restricted-supplement-archive";

export interface SupplementVerifierConfig { trustedPublicKeyPath?: string; signedReceiptPath?: string }
const tupleKeys = ["sourceRunId", "parentEnvelopeSha256", "parentManifestSha256", "supplementSha256", "attestationSha256", "rowSetSha256", "derivativeEnvelopeSha256", "derivativeManifestSha256"] as const;
function fail(): never { throw new Error("supplement_signed_receipt_invalid"); }
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) fail();
}
function tuple(value: unknown): RestrictedSupplementExternalVerificationInput {
  exact(value, tupleKeys);
  if (typeof value.sourceRunId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(value.sourceRunId)) fail();
  for (const key of tupleKeys.slice(1)) if (typeof value[key] !== "string" || !/^[a-f0-9]{64}$/.test(value[key] as string)) fail();
  return value as unknown as RestrictedSupplementExternalVerificationInput;
}
async function noLinks(path: string): Promise<string> {
  if (!isAbsolute(path)) fail();
  const normalized = resolve(path);
  let current = normalized;
  while (true) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) fail();
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (await realpath(normalized) !== normalized) fail();
  return normalized;
}
async function readBounded(path: string, maximum: number, forbiddenRoots: readonly string[]): Promise<Buffer> {
  const normalized = await noLinks(path);
  for (const root of forbiddenRoots) {
    // Root may not yet exist (new derivative output); resolve its lexical path.
    const rel = relative(resolve(root), normalized);
    if (!rel || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) fail();
  }
  const handle = await open(normalized, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum || (before.mode & 0o022) !== 0) fail();
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await handle.stat();
    const named = await lstat(normalized);
    if (size !== before.size || size > maximum || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || named.ino !== before.ino || named.dev !== before.dev || named.isSymbolicLink()) fail();
    await noLinks(normalized);
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}
/** Verifies a separately issued signature. This module never signs or creates trust. */
export async function configuredSupplementVerifier(config: SupplementVerifierConfig, forbiddenRoots: readonly string[]): Promise<RestrictedSupplementExternalVerifier | undefined> {
  if (!config.trustedPublicKeyPath && !config.signedReceiptPath) return undefined;
  if (!config.trustedPublicKeyPath || !config.signedReceiptPath) fail();
  try {
    const keyBytes = await readBounded(config.trustedPublicKeyPath, 8192, forbiddenRoots);
    const key = createPublicKey(keyBytes);
    if (key.asymmetricKeyType !== "ed25519" || keyBytes.toString().includes("PRIVATE KEY")) fail();
    const bytes = await readBounded(config.signedReceiptPath, 16384, forbiddenRoots);
    const receipt: unknown = JSON.parse(bytes.toString("utf8"));
    exact(receipt, ["version", "receiptId", "tuple", "signature"]);
    if (receipt.version !== "rm-supplement-signed-receipt/v1" || typeof receipt.receiptId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(receipt.receiptId) || typeof receipt.signature !== "string") fail();
    const verifiedTuple = tuple(receipt.tuple);
    const signature = Buffer.from(receipt.signature, "base64");
    if (signature.length !== 64 || signature.toString("base64") !== receipt.signature) fail();
    const signed = { version: receipt.version, receiptId: receipt.receiptId, tuple: verifiedTuple };
    if (!verify(null, Buffer.from(canonicalJson(signed)), key, signature)) fail();
    const expected = canonicalJson(verifiedTuple);
    const receiptId = receipt.receiptId;
    return (input) => {
      const projected = Object.fromEntries(tupleKeys.map((key) => [key, input[key]]));
      if (canonicalJson(tuple(projected)) !== expected) fail();
      return { verified: true, receiptId };
    };
  } catch { return fail(); }
}
