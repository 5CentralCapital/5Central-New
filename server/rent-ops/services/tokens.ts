import { createHash, randomBytes } from "node:crypto";
import type { RentOpsApplicationRecord, RentOpsRepository } from "../../../shared/rent-ops-contracts";

export const DEFAULT_RESUME_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function createResumeToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashResumeToken(token) };
}

export function hashResumeToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isResumeTokenShapeValid(token: string): boolean {
  return /^[A-Za-z0-9_-]{40,100}$/.test(token);
}

export async function resolveResumeToken(
  repository: RentOpsRepository,
  token: string,
  now = new Date(),
): Promise<RentOpsApplicationRecord | undefined> {
  if (!isResumeTokenShapeValid(token)) return undefined;
  const application = await repository.getApplicationByResumeTokenHash(hashResumeToken(token));
  if (!application || !application.resumeTokenExpiresAt) return undefined;
  if (new Date(application.resumeTokenExpiresAt).getTime() <= now.getTime()) return undefined;
  return application;
}
