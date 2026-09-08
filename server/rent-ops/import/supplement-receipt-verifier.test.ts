import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, realpath, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../export/hash";
import { configuredSupplementVerifier } from "./supplement-receipt-verifier";
import { parseRestrictedMigrationCliArgs } from "./restricted-migration-cli";
import { parseRestrictedSupplementCliArgs } from "./restricted-supplement-cli";
const tuple = { sourceRunId: "synthetic-run", parentEnvelopeSha256: "a".repeat(64), parentManifestSha256: "b".repeat(64), supplementSha256: "c".repeat(64), attestationSha256: "d".repeat(64), rowSetSha256: "e".repeat(64), derivativeEnvelopeSha256: "f".repeat(64), derivativeManifestSha256: "0".repeat(64) };

test("separate signed receipt validates exact tuple; tampering and selftrust fail closed", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "synthetic-supplement-signature-")));
  try {
    const archive = join(root, "archive"); await mkdir(archive);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const trustedPublicKeyPath = join(root, "public.pem"), signedReceiptPath = join(root, "receipt.json");
    await writeFile(trustedPublicKeyPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
    const signed = { version: "rm-supplement-signed-receipt/v1", receiptId: "synthetic-receipt", tuple };
    const receipt = { ...signed, signature: sign(null, Buffer.from(canonicalJson(signed)), privateKey).toString("base64") };
    const save = async (value: unknown) => writeFile(signedReceiptPath, JSON.stringify(value), { mode: 0o600 });
    await save(receipt);
    const config = { trustedPublicKeyPath, signedReceiptPath };
    const verifier = await configuredSupplementVerifier(config, [archive]);
    assert.deepEqual(await verifier!(tuple), { verified: true, receiptId: "synthetic-receipt" });
    assert.throws(() => verifier!({ ...tuple, sourceRunId: "other" }));
    for (const key of Object.keys(tuple).filter((k) => k !== "sourceRunId")) assert.throws(() => verifier!({ ...tuple, [key]: "1".repeat(64) }));
    assert.equal(await configuredSupplementVerifier({}, [archive]), undefined);
    await assert.rejects(configuredSupplementVerifier({ trustedPublicKeyPath }, [archive]));
    await assert.rejects(configuredSupplementVerifier(config, [root]));
    await save({ ...receipt, verified: true }); await assert.rejects(configuredSupplementVerifier(config, [archive]));
    await save({ ...receipt, receiptId: "tampered" }); await assert.rejects(configuredSupplementVerifier(config, [archive]));
    await save({ ...receipt, signature: Buffer.alloc(64).toString("base64") }); await assert.rejects(configuredSupplementVerifier(config, [archive]));
    await save(receipt);
    const link = join(root, "linked.pem"); await symlink(trustedPublicKeyPath, link);
    await assert.rejects(configuredSupplementVerifier({ ...config, trustedPublicKeyPath: link }, [archive]));
    await writeFile(signedReceiptPath, "x".repeat(17000)); await assert.rejects(configuredSupplementVerifier(config, [archive]));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("both CLIs parse explicit public trust and signed receipt paths", () => {
  const flags = ["--trusted-supplement-public-key=/trust/public.pem", "--signed-supplement-receipt", "/trust/receipt.json"];
  for (const parsed of [parseRestrictedMigrationCliArgs(["--archive-root", "/archive", ...flags]), parseRestrictedSupplementCliArgs(["--archive-root", "/archive", "--derivative-root", "/derivative", "--supplement-package", "/package/value.json", ...flags])]) {
    assert.equal(parsed.trustedPublicKeyPath, "/trust/public.pem"); assert.equal(parsed.signedReceiptPath, "/trust/receipt.json");
  }
});
