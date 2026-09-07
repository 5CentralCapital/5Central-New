import { useEffect, useRef, useState, type FormEvent } from "react";
import { Copy, Link, Loader2, RefreshCw, ShieldOff } from "lucide-react";
import type { TenantAccountSummary, TenantAccountsResponse, TenantActivationResponse } from "@shared/tenant-portal-contracts";
import { rentOpsAuthClient } from "../rent-ops/auth";
import { activationUrl } from "./link";
import "./tenant-portal.css";

const endpoint = "/api/rent-ops/tenant-accounts";

async function adminRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await rentOpsAuthClient.request(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    const fallback = response.status === 409 ? "An account already exists for this email or tenancy. Refresh and review the existing account." : response.status === 400 ? "The account details could not be verified. Check the resident, tenancy, and email." : "Tenant accounts are unavailable right now. Try again.";
    throw new Error(fallback);
  }
  return response.json();
}

export function TenantPortalAccountsPanel({ personId, personName, email }: { personId: string; personName: string; email?: string }) {
  const [data, setData] = useState<TenantAccountsResponse | null>(null);
  const [tenancyId, setTenancyId] = useState("");
  const [accountEmail, setAccountEmail] = useState(email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [link, setLink] = useState<{ url: string; expiresAt: string; email: string }>();
  const [pendingAction, setPendingAction] = useState<{ account: TenantAccountSummary; action: "revoke" | "reissue" }>();
  const mounted = useRef(true);
  const currentPerson = useRef(personId);
  currentPerson.current = personId;
  const eligible = data?.eligibleTenancies.filter((item) => item.personId === personId) ?? [];
  const accounts = data?.accounts.filter((item) => item.personId === personId) ?? [];
  async function refresh() {
    const person = personId;
    setBusy(true); setError("");
    try {
      const next = await adminRequest<TenantAccountsResponse>(endpoint);
      if (!mounted.current || currentPerson.current !== person) return;
      setData(next);
      const choices = next.eligibleTenancies.filter((item) => item.personId === person);
      setTenancyId((prior) => choices.some((item) => item.tenancyId === prior) ? prior : choices.length === 1 ? choices[0].tenancyId : "");
    } catch (caught) { if (mounted.current && currentPerson.current === person) setError(caught instanceof Error ? caught.message : "Could not load accounts."); }
    finally { if (mounted.current && currentPerson.current === person) setBusy(false); }
  }
  useEffect(() => {
    mounted.current = true;
    setData(null); setLink(undefined); setPendingAction(undefined); setNotice(""); setAccountEmail(email ?? ""); setTenancyId("");
    void refresh();
    return () => { mounted.current = false; };
  }, [personId]);

  async function provision(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice(""); setLink(undefined);
    const person = personId;
    try {
      const result = await adminRequest<TenantActivationResponse>(endpoint, { personId, tenancyId, email: accountEmail.trim() });
      if (!mounted.current || currentPerson.current !== person) return;
      setLink({ url: activationUrl(result.activationPath, window.location.origin), expiresAt: result.expiresAt, email: result.account.email });
      await refresh();
    } catch (caught) { if (mounted.current && currentPerson.current === person) setError(caught instanceof Error ? caught.message : "Could not create account."); }
    finally { if (mounted.current && currentPerson.current === person) setBusy(false); }
  }

  async function applyAction() {
    if (!pendingAction) return;
    const { account, action } = pendingAction;
    const person = personId;
    setBusy(true); setError(""); setNotice(""); setLink(undefined);
    try {
      const result = await adminRequest<TenantActivationResponse>(`${endpoint}/${encodeURIComponent(account.id)}/${action}`, {});
      if (!mounted.current || currentPerson.current !== person) return;
      if (action === "reissue") setLink({ url: activationUrl(result.activationPath, window.location.origin), expiresAt: result.expiresAt, email: account.email });
      else setNotice(`Portal access revoked for ${account.email}.`);
      setPendingAction(undefined);
      await refresh();
    } catch (caught) { if (mounted.current && currentPerson.current === person) setError(caught instanceof Error ? caught.message : "Could not update account."); }
    finally { if (mounted.current && currentPerson.current === person) setBusy(false); }
  }

  return <section className="tp-admin-accounts" aria-labelledby={`tp-accounts-${personId}`}><div className="tp-admin-heading"><h3 id={`tp-accounts-${personId}`}>Tenant portal account</h3><button type="button" className="tp-secondary" disabled={busy} onClick={refresh} aria-label="Refresh tenant accounts"><RefreshCw className={busy ? "tp-spin" : ""} /></button></div>
    {error && <p className="tp-error" role="alert">{error}</p>}{notice && <p className="tp-notice" role="status">{notice}</p>}
    {link && <div className="tp-admin-link"><p><strong>Secure link for {link.email}</strong><br />Created, not sent. Expires {new Date(link.expiresAt).toLocaleString()}.</p><label>Activation link<input type="text" value={link.url} readOnly onFocus={(event) => event.currentTarget.select()} /></label><div className="tp-actions"><button type="button" className="tp-primary" onClick={async () => { try { await navigator.clipboard.writeText(link.url); setNotice("Link copied. It has not been sent."); } catch { setError("Copy was unavailable. Select and copy the link above."); } }}><Copy />Copy link</button><button type="button" className="tp-secondary" onClick={() => setLink(undefined)}>Hide link</button></div></div>}
    {accounts.map((account) => { const selected = eligible.find((item) => item.tenancyId === account.tenancyId); return <div key={account.id} className="tp-admin-account"><div><strong>{account.email}</strong><span className="tp-admin-status">{account.status}</span><small>{selected ? `${selected.propertyName} · Unit ${selected.unitNumber}` : `Tenancy ${account.tenancyId}`}</small></div><div className="tp-actions"><button type="button" className="tp-secondary" disabled={busy} onClick={() => setPendingAction({ account, action: "reissue" })}><Link />New access link</button>{account.status !== "revoked" && <button type="button" className="tp-secondary tp-danger" disabled={busy} onClick={() => setPendingAction({ account, action: "revoke" })}><ShieldOff />Revoke</button>}</div></div>; })}
    {pendingAction && <div className="tp-confirm"><p>{pendingAction.action === "revoke" ? `Revoke ${pendingAction.account.email}'s portal access and end their active sessions?` : `Create a new access link for ${pendingAction.account.email}? Previous links and sessions will stop working.`}</p><div className="tp-actions"><button type="button" className="tp-primary" disabled={busy} onClick={applyAction}>{busy && <Loader2 className="tp-spin" />}{pendingAction.action === "revoke" ? "Revoke access" : "Create new link"}</button><button type="button" className="tp-secondary" disabled={busy} onClick={() => setPendingAction(undefined)}>Cancel</button></div></div>}
    {data && !eligible.length ? <p>No eligible tenancy is linked to {personName}. Confirm the resident and tenancy before creating portal access.</p> : <form onSubmit={provision}><label>Resident<input value={personName} readOnly /></label><label>Tenancy<select value={tenancyId} onChange={(event) => setTenancyId(event.target.value)} required disabled={busy}><option value="">Select the exact tenancy</option>{eligible.map((item) => <option key={item.tenancyId} value={item.tenancyId}>{item.propertyName} · Unit {item.unitNumber} · {item.status.replaceAll("_", " ")}</option>)}</select></label><label>Sign-in email<input type="email" autoComplete="off" value={accountEmail} onChange={(event) => setAccountEmail(event.target.value)} required maxLength={240} disabled={busy} /></label><button type="submit" className="tp-primary" disabled={busy || !data || !tenancyId || accounts.some((account) => account.tenancyId === tenancyId)}>{busy ? <Loader2 className="tp-spin" /> : <Link />}Create account and access link</button></form>}
  </section>;
}
