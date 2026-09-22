import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt);
export const TENANT_PASSWORD_MIN_LENGTH = 12;
export const TENANT_PASSWORD_MAX_LENGTH = 128;

export function validTenantPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= TENANT_PASSWORD_MIN_LENGTH
    && value.length <= TENANT_PASSWORD_MAX_LENGTH && Buffer.byteLength(value, "utf8") <= 512;
}

export async function hashTenantPassword(password: string): Promise<string> {
  if (!validTenantPassword(password)) throw new Error("Password must contain 12 to 128 characters");
  const salt = randomBytes(32).toString("hex");
  const hash = await derive(password, salt, 64) as Buffer;
  return `scrypt.v1.${salt}.${hash.toString("hex")}`;
}

export async function verifyTenantPassword(password: unknown, stored: unknown): Promise<boolean> {
  if (typeof password !== "string" || password.length > 128 || Buffer.byteLength(password, "utf8") > 512) return false;
  const parts = typeof stored === "string" ? /^scrypt\.v1\.([a-f0-9]{64})\.([a-f0-9]{128})$/.exec(stored) : null;
  // Do the same expensive operation for a missing/malformed account hash.
  // Authentication never throws or returns stored hashes to the client.
  const salt = parts?.[1] ?? "0".repeat(64);
  const expected = Buffer.from(parts?.[2] ?? "0".repeat(128), "hex");
  const actual = await derive(password, salt, 64) as Buffer;
  return timingSafeEqual(actual, expected) && !!parts;
}
