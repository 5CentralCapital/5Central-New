import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { AlertCircle, Loader2, LockKeyhole } from "lucide-react";
import { rentOpsAuthClient } from "./auth";

export function useRentOpsAuth() {
  return useSyncExternalStore(
    (listener) => rentOpsAuthClient.subscribe(listener),
    () => rentOpsAuthClient.getSnapshot(),
    () => rentOpsAuthClient.getSnapshot(),
  );
}

export function RentOpsAuthLoading() {
  return <main className="ro-auth-shell"><section className="ro-auth-card" aria-live="polite"><Loader2 className="spin" /><p>Checking your Rent Operations session…</p></section></main>;
}

export function RentOpsAdminLogin({ message }: { message?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>(message);
  const [submitting, setSubmitting] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    if (new URLSearchParams(window.location.search).get("login") === "failed") setError("Google sign-in was not accepted. Please try again.");
    fetch("/api/rent-ops/auth/oauth/config", { credentials: "include" }).then(r => r.ok ? r.json() : {}).then(value => { if (active) setGoogleEnabled(typeof value === "object" && value !== null && "enabled" in value && value.enabled === true); }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (message) setError(message);
  }, [message]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await rentOpsAuthClient.login(email.trim(), password);
      setPassword("");
    } catch (cause) {
      setPassword("");
      setError(cause instanceof Error ? cause.message : "Rent Operations sign-in was not accepted.");
    } finally {
      setSubmitting(false);
    }
  }

  return <main className="ro-auth-shell">
    <section className="ro-auth-card" aria-labelledby="rent-ops-login-title">
      <div className="ro-auth-icon"><LockKeyhole aria-hidden="true" /></div>
      <span className="eyebrow">Private workspace</span>
      <h1 id="rent-ops-login-title">Rent Operations</h1>
      <p className="ro-auth-intro">Sign in with the dedicated administrator account to view and update operational records.</p>
      {error && <div className="ro-error" role="alert"><AlertCircle aria-hidden="true" /><span>{error}</span></div>}
      {googleEnabled && <a className="primary ro-auth-submit" href="/api/rent-ops/auth/oauth/start">Continue with Google</a>}
      <form onSubmit={submit}>
        <label htmlFor="rent-ops-email">Email</label>
        <input id="rent-ops-email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={submitting} />
        <label htmlFor="rent-ops-password">Password</label>
        <input id="rent-ops-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={submitting} />
        <button className="primary ro-auth-submit" type="submit" disabled={submitting}>{submitting ? "Signing in…" : "Sign in"}</button>
      </form>
      <p className="ro-auth-note">This sign-in is separate from the public site and investor access.</p>
    </section>
  </main>;
}
