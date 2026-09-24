import { createHash } from "node:crypto";

const SIGNUP_WINDOW_MS = 15 * 60 * 1000;
const SIGNUP_IP_LIMIT = 5;
const SIGNUP_EMAIL_LIMIT = 3;
const SIGNUP_MAX_ENTRIES = 10_000;

export interface InvestorSignupInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  company: string | null;
  investableCapital: string | null;
  accreditedStatus: "unknown" | "self_reported" | "not_accredited";
  source: "website";
}

function textField(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > maximumLength || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) return null;
  return text;
}

function optionalTextField(value: unknown, maximumLength: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  return textField(value, maximumLength);
}

function normalizeEmail(value: unknown): string | null {
  const email = textField(value, 240)?.toLowerCase();
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function normalizePhone(value: unknown): string | null {
  const phone = optionalTextField(value, 40);
  if (phone === null) return null;
  return /^[+()\-.\s\d]{7,40}$/.test(phone) ? phone : null;
}

function normalizeCapital(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const capital = typeof value === "number" && Number.isFinite(value) ? String(value) : textField(value, 18);
  if (!capital || !/^\d{1,12}(?:\.\d{1,2})?$/.test(capital)) return null;
  return capital;
}

/** Parse only the fields that the public investor form is allowed to submit. */
export function parseInvestorSignupInput(body: unknown): InvestorSignupInput | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  const firstName = textField(input.firstName, 80);
  const lastName = textField(input.lastName, 80);
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);
  const company = optionalTextField(input.company, 160);
  const investableCapital = normalizeCapital(input.investableCapital);
  const accreditedStatus = input.accreditedStatus === undefined || input.accreditedStatus === null || input.accreditedStatus === ""
    ? "unknown"
    : input.accreditedStatus;
  const hasCompany = input.company !== undefined && input.company !== null && input.company !== "";
  const hasInvestableCapital = input.investableCapital !== undefined && input.investableCapital !== null && input.investableCapital !== "";

  if (
    !firstName ||
    !lastName ||
    !email ||
    (phone === null && input.phone !== undefined && input.phone !== null && input.phone !== "") ||
    (hasCompany && company === null) ||
    (hasInvestableCapital && investableCapital === null) ||
    !["unknown", "self_reported", "not_accredited"].includes(accreditedStatus as string)
  ) {
    return null;
  }

  return {
    firstName,
    lastName,
    email,
    phone: phone ?? null,
    company: company ?? null,
    investableCapital: investableCapital ?? null,
    accreditedStatus: accreditedStatus as InvestorSignupInput["accreditedStatus"],
    source: "website",
  };
}

/**
 * Bounded process-local intake limiter. The deployment has one web instance;
 * invalid requests consume the IP bucket and valid requests consume both the
 * IP and normalized-email buckets.
 */
export function createInvestorSignupRateLimiter(now: () => number = Date.now) {
  const attempts = new Map<string, { count: number; expiresAt: number }>();

  return (ip: string, email?: string): number => {
    const currentTime = now();
    for (const [key, entry] of Array.from(attempts.entries())) {
      if (entry.expiresAt <= currentTime) attempts.delete(key);
    }

    const keys = [{ key: `ip:${ip}`, limit: SIGNUP_IP_LIMIT }];
    if (email) {
      const digest = createHash("sha256").update(email).digest("hex");
      keys.push({ key: `email:${digest}`, limit: SIGNUP_EMAIL_LIMIT });
    }

    const missing = keys.filter(({ key }) => !attempts.has(key)).length;
    if (attempts.size + missing > SIGNUP_MAX_ENTRIES) return Math.ceil(SIGNUP_WINDOW_MS / 1000);

    let retryAfter = 0;
    for (const { key, limit } of keys) {
      const entry = attempts.get(key) ?? { count: 0, expiresAt: currentTime + SIGNUP_WINDOW_MS };
      entry.count = Math.min(entry.count + 1, limit + 1);
      attempts.set(key, entry);
      if (entry.count > limit) retryAfter = Math.max(retryAfter, Math.ceil((entry.expiresAt - currentTime) / 1000));
    }
    return retryAfter;
  };
}
