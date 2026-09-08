/** Pre-launch delivery restriction: missing configuration denies every recipient. */
export const EMAIL_RECIPIENT_SETTING = "RENT_OPS_EMAIL_ALLOWED_RECIPIENTS";
const normalize = (value: unknown): string => {
  if (typeof value !== "string" || /[\r\n\x00-\x1f\x7f]/.test(value)) throw new Error("email_recipient_invalid");
  const email = value.trim().toLowerCase();
  if (email.length > 240 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(email) || email.includes("..")) throw new Error("email_recipient_invalid");
  return email;
};
export function createEmailRecipientPolicy(configured: unknown): (recipient: unknown) => string {
  let allowed = new Set<string>();
  if (configured !== undefined) {
    if (typeof configured !== "string" || !configured.trim() || configured.length > 4096) throw new Error("email_recipient_allowlist_invalid");
    try { allowed = new Set(configured.split(",").map(normalize)); }
    catch { throw new Error("email_recipient_allowlist_invalid"); }
  }
  return recipient => {
    const email = normalize(recipient);
    if (!allowed.has(email)) throw new Error("email_recipient_not_allowed");
    return email;
  };
}
