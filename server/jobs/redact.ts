/**
 * Job errors are stored and shown to operators. They must never carry OAuth
 * tokens, secrets, connection strings or provider response bodies, so every
 * message is scrubbed and bounded before it reaches company_jobs.
 */
const MAX_MESSAGE = 500;
const CODE_PATTERN = /^[a-z][a-z0-9_.:-]{0,119}$/;

const SCRUBBERS: readonly [RegExp, string][] = [
  [/\b(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?|https?):\/\/[^\s"'<>]+/gi, "[redacted-url]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic [redacted]"],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, "[redacted-jwt]"],
  [/\b((?:access|refresh|id)[_-]?token|client[_-]?secret|secret|password|passwd|authorization|api[_-]?key|verifier[_-]?token|code)\b(\s*["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, "$1$2[redacted]"],
  [/[A-Za-z0-9+/_-]{40,}={0,2}/g, "[redacted]"],
  [/[\u0000-\u001f\u007f]+/g, " "],
];

export function redactJobText(value: string): string {
  let text = value;
  for (const [pattern, replacement] of SCRUBBERS) text = text.replace(pattern, replacement);
  text = text.replace(/\s{2,}/g, " ").trim();
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;
}

export interface RedactedJobError {
  readonly code: string;
  readonly message: string;
}

/** Derive a stable code and a scrubbed, bounded message from any thrown value. */
export function redactJobError(error: unknown): RedactedJobError {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const rawCode = typeof record.code === "string" ? record.code : typeof record.name === "string" ? record.name : "job_failed";
  const normalizedCode = rawCode.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_").replace(/^[^a-z]+/, "");
  const code = CODE_PATTERN.test(normalizedCode) ? normalizedCode : "job_failed";
  const rawMessage = error instanceof Error ? error.message : typeof error === "string" ? error : "Job failed";
  const message = redactJobText(rawMessage) || "Job failed";
  return { code, message };
}
