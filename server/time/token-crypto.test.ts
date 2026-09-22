import assert from "node:assert/strict";
import test from "node:test";
import { AccountingError } from "../accounting/errors";
import { createTimeTokenCipher, createConfiguredTimeTokenCipher } from "./token-crypto";

const scope = { organizationId: "10000000-0000-4000-8000-000000000001", legalEntityId: "20000000-0000-4000-8000-000000000001", environment: "production" as const, providerCompanyId: "company-1" };

test("Time token encryption is authenticated to the company connection scope and never stores plaintext", () => {
  const cipher = createTimeTokenCipher(Buffer.alloc(32, 7));
  const encrypted = cipher.encrypt("access-secret", scope);
  assert.notEqual(encrypted.ciphertext.toString("utf8"), "access-secret");
  assert.equal(cipher.decrypt(encrypted, scope), "access-secret");
  assert.throws(() => cipher.decrypt(encrypted, { ...scope, environment: "sandbox" }), (error: unknown) => error instanceof AccountingError && error.code === "accounting_configuration");
});

test("Time token key configuration fails closed for missing or malformed keys", () => {
  assert.throws(() => createConfiguredTimeTokenCipher({} as NodeJS.ProcessEnv), (error: unknown) => error instanceof AccountingError && error.code === "accounting_configuration");
  assert.throws(() => createTimeTokenCipher(Buffer.alloc(16)), (error: unknown) => error instanceof AccountingError && error.code === "accounting_configuration");
  const configured = createConfiguredTimeTokenCipher({ QBO_TIME_TOKEN_ENCRYPTION_KEY: `hex:${Buffer.alloc(32, 4).toString("hex")}` } as NodeJS.ProcessEnv);
  const encrypted = configured.encrypt("refresh-secret", scope);
  assert.equal(configured.decrypt(encrypted, scope), "refresh-secret");
});

test("malformed encrypted values return a safe configuration error without token details", () => {
  const cipher = createTimeTokenCipher(Buffer.alloc(32, 9));
  assert.throws(() => cipher.decrypt({ ciphertext: Buffer.from("bad"), iv: Buffer.alloc(3), authTag: Buffer.alloc(2) }, scope), (error: unknown) => error instanceof AccountingError && error.code === "accounting_configuration" && !/bad/.test(error.message));
});
