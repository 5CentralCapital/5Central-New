import type { TenantAccessDelivery } from "./delivery";
type GmailDelivery = Omit<TenantAccessDelivery, "purpose"> & { purpose: TenantAccessDelivery["purpose"] | "application_resume" };

const mailbox = (value: string) => /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value) && value.length <= 240;
/** Direct documented Gmail API transport. No browser cookies or new OAuth grants. */
export function createGmailTenantNotifier(env: Record<string,string|undefined>, fetchImpl: typeof fetch = fetch, getAccessToken?: () => Promise<string>, managedProxy = false): (input: GmailDelivery) => Promise<void> {
  const from = env.RENT_OPS_GMAIL_FROM ?? "";
  const clientId = env.RENT_OPS_GMAIL_CLIENT_ID ?? "";
  const clientSecret = env.RENT_OPS_GMAIL_CLIENT_SECRET ?? "";
  const refreshToken = env.RENT_OPS_GMAIL_REFRESH_TOKEN ?? "";
  const app = new URL(env.RENT_OPS_PUBLIC_APP_URL ?? "");
  if (!mailbox(from) || (!getAccessToken && (!clientId || !clientSecret || !refreshToken)) || app.protocol !== "https:" || app.username || app.password) throw new Error("Gmail tenant delivery configuration is incomplete");
  return async input => {
    if (!mailbox(input.email) || !/^[A-Za-z0-9_-]{1,160}$/.test(input.issuanceId) || !/^[A-Za-z0-9_-]{43}$/.test(input.token)) throw new Error("Invalid tenant delivery request");
    const accessToken = getAccessToken ? await getAccessToken() : await (async () => {
      const authorization = await fetchImpl("https://oauth2.googleapis.com/token",{method:"POST",signal:AbortSignal.timeout(10_000),headers:{"Content-Type":"application/x-www-form-urlencoded"},
        body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,refresh_token:refreshToken,grant_type:"refresh_token"})});
      if (!authorization.ok) throw new Error("Gmail authorization unavailable");
      const credentials = await authorization.json() as {access_token?:unknown};
      return credentials.access_token;
    })();
    if (typeof accessToken !== "string" || !accessToken) throw new Error("Gmail authorization unavailable");
    const subject = input.purpose === "application_resume" ? "Continue your 5Central rental application" : input.purpose === "invitation" ? "Set up your 5Central tenant account" : "Reset your 5Central tenant password";
    const linkPath = input.purpose === "application_resume" ? "/apply#resume=" : "/tenant#activate=";
    const usage = input.purpose === "application_resume" ? "Use it to continue your application." : "It can be used once. Your current password remains unchanged until you use it.";
    const text = `${subject}\n\n${app.origin}${linkPath}${input.token}\n\nThis link expires at ${new Date(input.expiresAt).toUTCString()} . ${usage}\n\nIf you did not request this, you can ignore this email.\n\n5Central Capital`;
    const mime = [`From: 5Central Capital <${from}>`,`To: <${input.email}>`,`Subject: ${subject}`,`Message-ID: <tenant-${input.issuanceId}@${from.split("@")[1]}>`,
      "MIME-Version: 1.0","Content-Type: text/plain; charset=UTF-8","Content-Transfer-Encoding: base64","",Buffer.from(text).toString("base64").match(/.{1,76}/g)!.join("\r\n")].join("\r\n");
    // Do not automatically retry an uncertain send: Gmail has no send idempotency
    // guarantee. Caller invalidates this token and offers a fresh issuance.
    const sent = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/messages/send",{method:"POST",signal:AbortSignal.timeout(10_000),
      headers:{...(!managedProxy ? {Authorization:`Bearer ${accessToken}`} : {}),"Content-Type":"application/json"},body:JSON.stringify({raw:Buffer.from(mime).toString("base64url")})});
    if (!sent.ok) throw new Error("Gmail did not accept the message");
    const result = await sent.json() as {id?:unknown};
    if (typeof result.id !== "string" || !result.id) throw new Error("Gmail acceptance could not be confirmed");
  };
}
