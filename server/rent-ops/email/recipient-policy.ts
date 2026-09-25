/**
 * Delivery restriction. Missing configuration denies every recipient; a
 * comma-separated list allows only those mailboxes; `*` on its own allows any
 * single, well-formed mailbox (live operation: every tenant and applicant).
 * Header injection and multiple recipients are rejected in every mode.
 */
export const EMAIL_RECIPIENT_SETTING = "RENT_OPS_EMAIL_ALLOWED_RECIPIENTS";
export const normalizeEmailRecipient = (value: unknown): string => {
  if (typeof value !== "string" || /[\r\n\x00-\x1f\x7f]/.test(value)) throw new Error("email_recipient_invalid");
  const email = value.trim().toLowerCase();
  if (email.length > 240 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(email) || email.includes("..")) throw new Error("email_recipient_invalid");
  return email;
};
export const ANY_RECIPIENT = "*";
export function createEmailRecipientPolicy(configured: unknown): (recipient: unknown) => string {
  let allowed = new Set<string>();
  let anyRecipient = false;
  if (configured !== undefined) {
    if (typeof configured !== "string" || !configured.trim() || configured.length > 4096) throw new Error("email_recipient_allowlist_invalid");
    if (configured.trim() === ANY_RECIPIENT) anyRecipient = true;
    else {
      try { allowed = new Set(configured.split(",").map(normalizeEmailRecipient)); }
      catch { throw new Error("email_recipient_allowlist_invalid"); }
    }
  }
  return recipient => {
    const email = normalizeEmailRecipient(recipient);
    if (!anyRecipient && !allowed.has(email)) throw new Error("email_recipient_not_allowed");
    return email;
  };
}
