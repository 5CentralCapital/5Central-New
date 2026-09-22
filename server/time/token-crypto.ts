import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { TimeConnectionScope } from "../../shared/time";
import { timeConnectionScopeSchema } from "../../shared/time";
import { AccountingError } from "../accounting/errors";

export interface TimeEncryptedValue { readonly ciphertext: Buffer; readonly iv: Buffer; readonly authTag: Buffer; }
export interface TimeTokenCipher { encrypt(value: string, scope: TimeConnectionScope): TimeEncryptedValue; decrypt(value: TimeEncryptedValue, scope: TimeConnectionScope): string; }
function aad(scope: TimeConnectionScope): Buffer { const parsed = timeConnectionScopeSchema.parse(scope); return Buffer.from([parsed.organizationId, parsed.legalEntityId, parsed.environment, parsed.providerCompanyId].join("\u0000"), "utf8"); }
function keyFrom(value: string): Buffer {
  const text = value.trim();
  if (!text) throw new AccountingError("accounting_configuration", "QuickBooks Time token encryption key is empty");
  const decoded = text.startsWith("hex:") ? Buffer.from(text.slice(4), "hex") : text.startsWith("base64:") ? Buffer.from(text.slice(7), "base64") : /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, "hex") : Buffer.from(text, "base64");
  if (decoded.length !== 32) throw new AccountingError("accounting_configuration", "QuickBooks Time token encryption key must be 32 bytes");
  return decoded;
}
export function createTimeTokenCipher(key: Buffer | string): TimeTokenCipher {
  const encryptionKey = Buffer.isBuffer(key) ? Buffer.from(key) : keyFrom(key); if (encryptionKey.length !== 32) throw new AccountingError("accounting_configuration", "QuickBooks Time token encryption key must be 32 bytes");
  return {
    encrypt(value, scope) { if (typeof value !== "string" || value.length === 0 || value.length > 16_384) throw new AccountingError("accounting_validation", "QuickBooks Time token is invalid"); const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv); cipher.setAAD(aad(scope)); const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return { ciphertext, iv, authTag: cipher.getAuthTag() }; },
    decrypt(value, scope) { try { if (!value || !Buffer.isBuffer(value.ciphertext) || !Buffer.isBuffer(value.iv) || !Buffer.isBuffer(value.authTag) || value.iv.length !== 12 || value.authTag.length !== 16) throw new Error("malformed encrypted token"); const decipher = createDecipheriv("aes-256-gcm", encryptionKey, value.iv); decipher.setAAD(aad(scope)); decipher.setAuthTag(value.authTag); const plain = Buffer.concat([decipher.update(value.ciphertext), decipher.final()]).toString("utf8"); if (!plain) throw new Error("empty token"); return plain; } catch { throw new AccountingError("accounting_configuration", "QuickBooks Time token could not be decrypted"); } },
  };
}
export function createConfiguredTimeTokenCipher(env: NodeJS.ProcessEnv = process.env): TimeTokenCipher {
  const key = env.QBO_TIME_TOKEN_ENCRYPTION_KEY; if (!key) throw new AccountingError("accounting_configuration", "QBO_TIME_TOKEN_ENCRYPTION_KEY is not configured"); return createTimeTokenCipher(key);
}
