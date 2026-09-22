import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  financialSourceScopeSchema,
  financialSourceScopeKey,
  type FinancialSourceScope,
} from "../../shared/accounting";
import { AccountingError } from "./errors";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KEY_ENVIRONMENT_VARIABLE = "QBO_TOKEN_ENCRYPTION_KEY";

export interface EncryptedQboSecret {
  readonly ciphertext: string;
  readonly iv: string;
  readonly authTag: string;
}

export interface QboTokenCipher {
  encrypt(scope: FinancialSourceScope, secret: string): EncryptedQboSecret;
  decrypt(scope: FinancialSourceScope, encrypted: EncryptedQboSecret): string;
}

function configurationFailure(message: string): AccountingError {
  return new AccountingError("accounting_configuration", message);
}

function decodeConfiguredKey(value: string): Buffer {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw configurationFailure("QBO token encryption key is empty");
  let key: Buffer;
  if (trimmed.startsWith("base64:")) {
    key = Buffer.from(trimmed.slice("base64:".length), "base64");
  } else if (trimmed.startsWith("hex:")) {
    key = Buffer.from(trimmed.slice("hex:".length), "hex");
  } else {
    // Base64 is the deployment format. Raw strings are rejected to prevent a
    // short passphrase from silently becoming a weak AES key.
    key = Buffer.from(trimmed, "base64");
  }
  if (key.length !== KEY_BYTES) throw configurationFailure("QBO token encryption key must decode to 32 bytes");
  return key;
}

/** Fail closed when a production secret is missing or malformed. */
export function loadQboTokenEncryptionKey(environment: NodeJS.ProcessEnv = process.env): Buffer {
  const value = environment[KEY_ENVIRONMENT_VARIABLE];
  if (!value) throw configurationFailure(`Missing ${KEY_ENVIRONMENT_VARIABLE}`);
  return decodeConfiguredKey(value);
}

export function createQboTokenCipher(key: Uint8Array | string): QboTokenCipher {
  const keyBytes = typeof key === "string" ? decodeConfiguredKey(key) : Buffer.from(key);
  if (keyBytes.length !== KEY_BYTES) throw configurationFailure("QBO token encryption key must be 32 bytes");
  const immutableKey = Buffer.from(keyBytes);

  function associatedData(scope: FinancialSourceScope): Buffer {
    const parsed = financialSourceScopeSchema.parse(scope);
    return createHash("sha256").update(`qbo-token-scope:${financialSourceScopeKey(parsed)}`, "utf8").digest();
  }

  return {
    encrypt(scope, secret) {
      if (typeof secret !== "string" || secret.length === 0 || secret.length > 16_384) {
        throw new AccountingError("accounting_validation", "QBO credential is invalid");
      }
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, immutableKey, iv);
      cipher.setAAD(associatedData(scope));
      const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
      return {
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
      };
    },
    decrypt(scope, encrypted) {
      if (!encrypted || typeof encrypted.ciphertext !== "string" || typeof encrypted.iv !== "string" || typeof encrypted.authTag !== "string") {
        throw new AccountingError("accounting_unavailable", "Stored QBO credential is malformed");
      }
      try {
        const iv = Buffer.from(encrypted.iv, "base64");
        const authTag = Buffer.from(encrypted.authTag, "base64");
        if (iv.length !== IV_BYTES || authTag.length !== TAG_BYTES) throw new Error("invalid encrypted QBO credential");
        const decipher = createDecipheriv(ALGORITHM, immutableKey, iv);
        decipher.setAAD(associatedData(scope));
        decipher.setAuthTag(authTag);
        const plain = Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "base64")), decipher.final()]).toString("utf8");
        if (plain.length === 0) throw new Error("empty decrypted QBO credential");
        return plain;
      } catch {
        throw new AccountingError("accounting_unavailable", "Stored QBO credential could not be decrypted");
      }
    },
  };
}

export function createConfiguredQboTokenCipher(environment: NodeJS.ProcessEnv = process.env): QboTokenCipher {
  return createQboTokenCipher(loadQboTokenEncryptionKey(environment));
}

export const QBO_TOKEN_ENCRYPTION_KEY_ENV = KEY_ENVIRONMENT_VARIABLE;

