import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { rentOpsAuthClient } from "./auth";

export function useRentOpsAuth() {
  return useSyncExternalStore(
    (listener) => rentOpsAuthClient.subscribe(listener),
    () => rentOpsAuthClient.getSnapshot(),
    () => rentOpsAuthClient.getSnapshot(),
  );
}

export function RentOpsAuthLoading() {
  return <main className="ro-auth-shell"><section className="ro-auth-card" aria-live="polite"><Loader2 className="spin" /><p>Signing in…</p></section></main>;
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
      setError(cause instanceof Error ? cause.message : "5Central Ops sign-in was not accepted.");
    } finally {
      setSubmitting(false);
    }
  }

  return <main className="ro-auth-shell">
    <section className="ro-auth-card" aria-labelledby="rent-ops-login-title">
      <span className="ro-auth-wordmark" aria-label="5Central Ops"><span aria-hidden="true">5</span>Central Ops</span>
      <div className="ro-auth-heading">
        <h1 id="rent-ops-login-title">Sign in</h1>
        <p className="ro-auth-intro">For 5Central managers.</p>
      </div>
      {error && <div className="ro-error" role="alert"><AlertCircle aria-hidden="true" /><span>{error}</span></div>}
      {googleEnabled && <>
        <a className="ro-auth-submit" href="/api/rent-ops/auth/oauth/start">Continue with Google</a>
        <div className="ro-auth-divider" role="separator"><span>or use email</span></div>
      </>}
      <form onSubmit={submit}>
        <label htmlFor="rent-ops-email">Email</label>
        <input id="rent-ops-email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={submitting} />
        <label htmlFor="rent-ops-password">Password</label>
        <input id="rent-ops-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={submitting} />
        <button className={`ro-auth-submit${googleEnabled ? " is-secondary" : ""}`} type="submit" disabled={submitting}>{submitting ? "Signing in…" : googleEnabled ? "Sign in with email" : "Sign in"}</button>
      </form>
      <a className="ro-auth-note" href="/">← Back to 5central.capital</a>
    </section>
  </main>;
}
