# Supplement signature verification

Both migration and supplement CLIs accept these explicit options:

```
--trusted-supplement-public-key /absolute/separate-trust/public.pem
--signed-supplement-receipt /absolute/separate-trust/receipt.json
```

The public key must be an independently configured Ed25519 public key in PEM format. No private key is loaded, generated, or used by these commands. Both options are required together. Without them, existing missing-verifier rejection remains in effect for derivative archives. Base archives do not require a supplement receipt.

Keep both files outside the source archive, derivative archive, and supplement package directory. Paths must be absolute and contain no symlinks. Files must be ordinary files without hardlinks or group/other write access. Public keys are limited to 8 KiB and receipts to 16 KiB. The importer trusts the explicitly configured public key; selecting that key is an operator responsibility independent of the supplied package.

A receipt has exactly `version`, `receiptId`, `tuple`, and `signature`. Version is `rm-supplement-signed-receipt/v1`. `receiptId` is a non-secret identifier using letters, digits, colons, underscores or hyphens (maximum 128 characters). `tuple` contains exactly:

- `sourceRunId`
- `parentEnvelopeSha256`
- `parentManifestSha256`
- `supplementSha256`
- `attestationSha256`
- `rowSetSha256`
- `derivativeEnvelopeSha256`
- `derivativeManifestSha256`

Hashes are lowercase 64-character SHA-256 strings. `sourceRunId` follows the same identifier rules as `receiptId`. The signature is canonical base64 of the 64-byte Ed25519 signature over UTF-8 `canonicalJson({ version, receiptId, tuple })`, using the repository's `server/rent-ops/export/hash.ts` canonical serializer. JSON property order on disk does not establish trust. Every tuple field is compared with the independently recomputed import tuple.

The receipt issuer must independently audit the actual source pages, binary checksums, coverage, relationships, and supplement rows before signing the exact tuple. A checksum-only self-attestation or a JSON `verified` flag is not accepted. This implementation supplies verification wiring only: it does not configure an issuer, issue a real receipt, approve a semantic crosswalk, or make an unverified supplement importable. Existing provenance, coverage, and mapping guards still apply.
