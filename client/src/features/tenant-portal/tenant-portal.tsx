import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Building2, Check, CreditCard, FileDown, Loader2, LockKeyhole, LogOut, RefreshCw } from "lucide-react";
import type { TenantHome } from "@shared/tenant-portal-contracts";
import { TenantApiError, TenantPortalClient, trustedCheckoutUrl, type TenantPayments, type TenantSessionAccount } from "./api";
import { centsFromAmount, consumeActivationLink, type ActivationLink } from "./link";
import { noPaymentDueMessage, paymentReviewMessage } from "./payment-view";
import { depositAmounts } from "./deposit-view";
import { ResidentTransactions, TransactionTable } from "./transactions";
import { filterTransactions, emptyTransactionFilters } from "./transactions-view";
import "./tenant-portal.css";
const LeaseViewer=lazy(()=>import("./lease-viewer").then(module=>({default:module.LeaseViewer})));

function money(cents: number | null | undefined): string {
  return typeof cents === "number" && Number.isSafeInteger(cents)
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
    : "Unavailable";
}

function date(value: string | null | undefined): string {
  if (!value) return "Not available";
  const parsed = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "Not available";
}

function label(value: string): string { return value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase()); }
function errorText(error: unknown): string { return error instanceof TenantApiError ? error.message : "We could not connect. Please try again."; }

function SignIn({ client, link, onSignIn, onDiscardLink }: { client: TenantPortalClient; link: ActivationLink; onSignIn: (account: TenantSessionAccount) => void; onDiscardLink: () => void }) {
  const [mode, setMode] = useState<"login" | "recovery">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(link.invalid ? "This link is invalid. Contact management for a new secure link." : "");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(""); setMessage("");
    if (link.token && password !== confirm) { setError("The passwords do not match."); return; }
    setBusy(true);
    try {
      if (mode === "recovery" && !link.token) {
        const result = await client.recovery(email.trim());
        setMessage(result.message);
      } else {
        onSignIn(link.token ? await client.activate(link.token, password) : await client.login(email.trim(), password));
      }
    } catch (caught) { setError(errorText(caught)); }
    finally { setBusy(false); setPassword(""); setConfirm(""); }
  }

  return <div className="tp-welcome">
    <div className="tp-welcome-copy"><Building2 aria-hidden="true" /><h1>Your home,<br />in one place.</h1></div>
    <section className="tp-card tp-login" aria-labelledby="tp-login-title">
      <LockKeyhole aria-hidden="true" className="tp-lock" />
      <h2 id="tp-login-title">{link.token ? "Set your password" : mode === "recovery" ? "Reset your password" : "Welcome home"}</h2>
      <form onSubmit={submit}>
        {!link.token && <label>Email<input type="email" name="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={240} disabled={busy} /></label>}
        {(link.token || mode === "login") && <label>{link.token ? "New password" : "Password"}<input type="password" name="password" autoComplete={link.token ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={link.token ? "At least 12 characters" : undefined} minLength={link.token ? 12 : undefined} maxLength={128} required disabled={busy} /></label>}
        {link.token && <label>Confirm password<input type="password" name="confirm-password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} minLength={12} maxLength={128} required disabled={busy} /></label>}
        {error && <p className="tp-error" role="alert">{error}</p>}
        {message && <p className="tp-notice" role="status">{message}</p>}
        <button className="tp-primary" disabled={busy}>{busy ? <Loader2 className="tp-spin" /> : <ArrowRight />}{link.token ? "Save password and sign in" : mode === "recovery" ? "Send reset link" : "Sign in"}</button>
      </form>
      <button className="tp-text-button" disabled={busy} onClick={() => { onDiscardLink(); setMode(mode === "login" && !link.token ? "recovery" : "login"); setPassword(""); setConfirm(""); setMessage(""); setError(""); }}>{mode === "recovery" || link.token ? "Back to sign in" : "Forgot your password?"}</button>
    </section>
  </div>;
}

function PaymentPanel({ client, payments, tenancyId, onError }: { client: TenantPortalClient; payments: TenantPayments | null; tenancyId: string; onError: (error: unknown) => void }) {
  const account = payments?.accounts.find((item) => item.tenancyId === tenancyId);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef<{ amountCents: number; requestId: string }>();
  useEffect(() => { setAmount(account ? (Math.min(99_999_999, Math.max(0, account.payableCents)) / 100).toFixed(2) : ""); }, [account?.payableCents, tenancyId]);
  async function checkout(event: FormEvent) {
    event.preventDefault();
    const amountCents = centsFromAmount(amount);
    if (!account || !amountCents || amountCents < 50 || amountCents > Math.min(account.payableCents, 99_999_999)) {
      onError(new TenantApiError(400, "Enter at least $0.50 and no more than the available balance or $999,999.99.")); return;
    }
    setBusy(true);
    try {
      if (!request.current || request.current.amountCents !== amountCents) request.current = { amountCents, requestId: crypto.randomUUID() };
      const result = await client.request<{ id: string; checkoutUrl: string }>("/api/tenant/payments/checkout", { tenancyId, ...request.current });
      window.location.assign(trustedCheckoutUrl(result.checkoutUrl));
    } catch (error) { onError(error); setBusy(false); }
  }
  const noPaymentMessage = noPaymentDueMessage(account);
  const reviewMessage = paymentReviewMessage(account);
  const enabled = payments?.available && account?.available && account.payableCents >= 50;
  return <section className="tp-card" aria-labelledby="tp-pay-title"><div className="tp-section-heading"><CreditCard aria-hidden="true" /><h2 id="tp-pay-title">Make a payment</h2></div>
    {!payments ? <p>Payment availability could not be loaded.</p> : reviewMessage ? <p>Payable balance: Unverified</p> : !payments.available ? <p>Online payments unavailable.</p> : noPaymentMessage ? <p>{noPaymentMessage}</p> : !account?.available ? <p>Online payments unavailable.</p> : account.payableCents < 50 ? <p>{account.pendingCents > 0 ? "Payment in progress." : account.payableCents > 0 ? "Minimum online payment: $0.50." : "No payment due."}</p> : <form onSubmit={checkout}><label>Payment amount<input type="number" inputMode="decimal" min="0.50" max={(Math.min(account.payableCents, 99_999_999) / 100).toFixed(2)} step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} required disabled={busy} /></label><button className="tp-primary" disabled={!enabled || busy}>{busy ? <Loader2 className="tp-spin" /> : <CreditCard />}Continue to payment</button></form>}
    {!!account?.pendingCents && <p className="tp-notice">{money(account.pendingCents)} in progress</p>}
    {!!payments?.payments.length && <div className="tp-payment-history"><h3>Recent online payments</h3>{payments.payments.slice(0, 8).map((payment) => <div key={payment.id}><span>{date(payment.createdAt)}<small>{label(payment.status)}</small></span><strong>{money(payment.amountCents)}</strong></div>)}</div>}
  </section>;
}

function PasswordPanel({ client, onError, onChanged }: { client: TenantPortalClient; onError: (error: unknown) => void; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    if (values.get("newPassword") !== values.get("confirmPassword")) { onError(new TenantApiError(400, "The new passwords do not match.")); return; }
    setBusy(true);
    try {
      await client.changePassword(String(values.get("currentPassword") ?? ""), String(values.get("newPassword") ?? ""));
      form.reset(); setOpen(false); onChanged();
    } catch (error) { onError(error); } finally { setBusy(false); }
  }
  return <section className="tp-card"><div className="tp-section-heading"><LockKeyhole aria-hidden="true" /><h2>Account security</h2></div>{!open ? <button className="tp-secondary" onClick={() => setOpen(true)}>Change password</button> : <form onSubmit={submit}><label>Current password<input type="password" name="currentPassword" autoComplete="current-password" required maxLength={128} disabled={busy} /></label><label>New password<input type="password" name="newPassword" placeholder="At least 12 characters" autoComplete="new-password" minLength={12} maxLength={128} required disabled={busy} /></label><label>Confirm new password<input type="password" name="confirmPassword" autoComplete="new-password" minLength={12} maxLength={128} required disabled={busy} /></label><div className="tp-actions"><button className="tp-primary" disabled={busy}>{busy ? <Loader2 className="tp-spin" /> : <Check />}Save password</button><button type="button" className="tp-secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</button></div></form>}</section>;
}

export default function TenantPortal() {
  // Capture during initial render, ahead of effects and session calls.
  const [link, setLink] = useState(() => consumeActivationLink(window.location, window.history));
  const [client] = useState(() => new TenantPortalClient());
  const [account, setAccount] = useState<TenantSessionAccount | null>(null);
  const [viewLease,setViewLease]=useState<{id:string;fileName:string}>();
  const [page, setPage] = useState<"home" | "transactions">("home");
  const [home, setHome] = useState<TenantHome | null>(null);
  const [payments, setPayments] = useState<TenantPayments | null>(null);
  const [loading, setLoading] = useState(!link.token);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const mounted = useRef(true);
  const generation = useRef(0);
  function handleError(caught: unknown) {
    if (caught instanceof TenantApiError && caught.status === 401) { generation.current++; client.clear(); setAccount(null); setViewLease(undefined); setHome(null); setPayments(null); }
    setError(errorText(caught));
  }
  async function refresh() {
    const current = ++generation.current;
    setRefreshing(true); setError("");
    try {
      const [nextHome, nextPayments] = await Promise.allSettled([
        client.request<TenantHome>("/api/tenant/home"), client.request<TenantPayments>("/api/tenant/payments"),
      ]);
      if (!mounted.current || current !== generation.current) return;
      if (nextHome.status === "rejected") throw nextHome.reason;
      if (nextPayments.status === "rejected" && nextPayments.reason instanceof TenantApiError && nextPayments.reason.status === 401) throw nextPayments.reason;
      setHome(nextHome.value); setPayments(nextPayments.status === "fulfilled" ? nextPayments.value : null);
    } catch (caught) { if (mounted.current && current === generation.current) handleError(caught); }
    finally { if (mounted.current && current === generation.current) setRefreshing(false); }
  }
  useEffect(() => {
    mounted.current = true;
    const oldTitle = document.title;
    document.title = "Tenant Portal | 5Central Capital";
    const paymentReturn = new URLSearchParams(window.location.search).get("payment");
    if (paymentReturn === "return" || paymentReturn === "returned") setMessage("Payment confirmation pending.");
    if (paymentReturn === "cancelled") setMessage("Checkout closed.");
    const restoreGeneration = generation.current;
    if (!link.token) client.restore().then((restored) => { if (mounted.current && generation.current === restoreGeneration) setAccount(restored); }).catch((caught) => { if (mounted.current && generation.current === restoreGeneration) handleError(caught); }).finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; generation.current++; client.clear(); document.title = oldTitle; };
  }, [client]);
  useEffect(() => {
    function acceptLink() {
      if (!window.location.hash) return;
      const next = consumeActivationLink(window.location, window.history);
      generation.current++; client.clear(); setAccount(null); setViewLease(undefined); setHome(null); setPayments(null);
      setLink(next); setLoading(false); setError(""); setMessage("");
    }
    window.addEventListener("hashchange", acceptLink);
    return () => window.removeEventListener("hashchange", acceptLink);
  }, [client]);
  useEffect(() => { if (account) void refresh(); }, [account?.id]);
  async function logout() {
    setError("");
    try { await client.logout(); generation.current++; setHome(null); setPayments(null); setViewLease(undefined); setAccount(null); setPage("home"); setMessage(""); }
    catch (caught) { handleError(caught); }
  }
  return <div className="tp-root"><header className="tp-header"><a href="/tenant" aria-label="5Central tenant portal" className="tp-brand"><span>5C</span><strong>5Central Capital</strong><em>Tenant portal</em></a>{account && <button className="tp-secondary" onClick={logout}><LogOut />Sign out</button>}</header><main className="tp-main">
    {error && <p className="tp-error" role="alert">{error}</p>}
    {message && <p className="tp-notice" role="status">{message}</p>}
    {loading ? <div className="tp-loading" role="status"><Loader2 className="tp-spin" />Opening your account…</div> : !account ? <SignIn key={link.token ?? (link.invalid ? "invalid" : "login")} client={client} link={link} onDiscardLink={() => setLink({ invalid: false })} onSignIn={(next) => { setLink({ invalid: false }); setError(""); setAccount(next); }} /> : !home ? <div className="tp-loading">{refreshing ? <><Loader2 className="tp-spin" />Loading your home…</> : <button className="tp-secondary" onClick={refresh}><RefreshCw />Try again</button>}</div> : <>
      <nav className="tp-nav" aria-label="Resident navigation"><button aria-current={page === "home" ? "page" : undefined} onClick={() => setPage("home")}>Home</button><button aria-current={page === "transactions" ? "page" : undefined} onClick={() => setPage("transactions")}>Transactions</button></nav>
      {page === "transactions" ? <ResidentTransactions home={home} /> : <>
      <div className="tp-greeting"><h1>Hello, {home.resident.firstName || "resident"}.</h1><button className="tp-secondary" onClick={refresh} disabled={refreshing}><RefreshCw className={refreshing ? "tp-spin" : ""} />Refresh</button></div>
      <div className="tp-property">{home.tenancy.propertyName} · Unit {home.tenancy.unitNumber}</div>
      <div className="tp-overview"><section className="tp-balance"><span>Account balance</span><strong>{home.balance.complete ? money(home.balance.amountCents) : "Unverified"}</strong><span>{date(home.balance.asOfDate)}{home.balance.complete && (home.balance.amountCents ?? 0) < 0 ? " · Account credit" : ""}</span></section><PaymentPanel client={client} payments={payments} tenancyId={home.tenancy.id} onError={handleError} /></div>
      <section className="tp-card tp-ledger"><div className="tp-page-heading"><h2>Recent activity</h2><button className="tp-text-button" onClick={() => setPage("transactions")}>All transactions<ArrowRight /></button></div>{!home.ledger.length ? <p>No transactions available.</p> : <TransactionTable rows={filterTransactions(home.ledger, emptyTransactionFilters).slice(0, 5)} compact />}</section>
      {viewLease && <Suspense fallback={<p role="status">Opening lease viewer…</p>}><LeaseViewer key={viewLease.id} {...viewLease} onClose={()=>setViewLease(undefined)} onError={handleError} /></Suspense>}
      <div className="tp-detail-grid"><section className="tp-card"><h2>Your lease</h2>{home.leases.length ? home.leases.map((lease) => <div className="tp-lease" key={lease.id}><strong>{label(lease.status)}</strong><dl><div><dt>Starts</dt><dd>{date(lease.startDate)}</dd></div><div><dt>Ends</dt><dd>{lease.monthToMonth === true ? "Month to month" : date(lease.endDate)}</dd></div></dl></div>) : <p>Lease unavailable.</p>}{home.leaseFiles.length ? <div className="tp-lease-files"><h3>Lease documents</h3>{home.leaseFiles.map((file) => <button type="button" className="tp-secondary" key={file.id} onClick={()=>setViewLease(file)}><FileDown aria-hidden="true" />View {file.fileName}{file.priorUnitLabel ? ` — Prior unit ${file.priorUnitLabel}` : ""}</button>)}</div> : <p>Lease document unavailable.</p>}{!!home.deposits.length && <><h3>Deposits</h3>{home.deposits.map((deposit) => { const amounts = depositAmounts(deposit); return <div className="tp-deposit" key={deposit.id}><span>{label(deposit.type)}<small>{label(deposit.status)}</small></span><span className="tp-money"><strong>{amounts.held}</strong><small>Amount held</small>{amounts.sourceBalance !== undefined && <small>Source balance {amounts.sourceBalance}</small>}</span></div>; })}</>}</section><PasswordPanel client={client} onError={handleError} onChanged={() => { setMessage("Password updated. Other sessions signed out."); }} /></div>
      </>}
    </>}
  </main></div>;
}
