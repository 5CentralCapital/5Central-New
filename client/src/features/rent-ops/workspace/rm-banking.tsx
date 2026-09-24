import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { loadBanking } from "../api";
import { useRentOpsAuth } from "../auth-ui";
import { ListTotals } from "./list-totals";
import { formatLongDate, formatRelativeTime, formatTableDate, formatTimestamp } from "../../../lib/rent-ops-formatters";
import "./rm-banking.css";

/** Plaid placeholders such as "Connection 1" are not names; show the bank's name when there is one. */
export function bankConnectionLabel(name: string | null | undefined, index = 0, total = 1): string {
  const trimmed = (name ?? "").trim();
  if (trimmed && !/^connection\s*\d*$/i.test(trimmed)) return trimmed;
  return total > 1 ? `Bank connection ${index + 1}` : "Bank connection";
}

/** Largest current balance first; accounts without a known balance last. Ties keep the bank's order. */
export function sortAccountsByBalance<T extends { readonly currentCents: number | null }>(accounts: readonly T[]): T[] {
  return [...accounts].sort((a, b) => a.currentCents === null ? (b.currentCents === null ? 0 : 1) : b.currentCents === null ? -1 : b.currentCents - a.currentCents);
}

const money = (cents: number | null, currency: string | null) => cents === null || !currency ? "Unavailable" : new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
export function RmBanking() {
  const auth = useRentOpsAuth();
  const [selected, setSelected] = useState("all");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(0);
  const bank = useQuery({ queryKey: ["rent-ops-banking", auth.user?.id], queryFn: ({ signal }) => loadBanking(signal), enabled: auth.status === "authenticated" && !!auth.user?.id, staleTime: 300_000, gcTime: 300_000, retry: false, refetchOnWindowFocus: false });
  const data = bank.data;
  const connections = (data?.connections ?? []).map((connection, index, all) => ({ ...connection, label: bankConnectionLabel(connection.name, index, all.length), accounts: sortAccountsByBalance(connection.accounts) }));
  const accounts = connections.flatMap(connection => connection.accounts.map(account => ({ ...account, connection: connection.label })));
  const transactions = data?.connections.flatMap(connection => connection.transactions).filter(tx => (selected === "all" || tx.accountId === selected) && (status === "all" || tx.pending === (status === "pending"))).sort((a, b) => b.date.localeCompare(a.date)) ?? [];
  const pageCount = Math.max(1, Math.ceil(transactions.length / 50));
  const currentPage = Math.min(page, pageCount - 1);
  const pageTransactions = transactions.slice(currentPage * 50, (currentPage + 1) * 50);
  return <section className="rmb" aria-label="Banking"><div className="rmb-heading"><h3>Bank accounts</h3><button type="button" className="rmb-refresh" disabled={bank.isFetching} onClick={() => void bank.refetch()}>{bank.isFetching ? "Checking…" : "Refresh"}</button></div>
    {bank.isLoading ? <p role="status">Loading bank accounts…</p> : bank.isError ? <p role="alert">Banking could not be loaded. Try refreshing.</p> : data?.state === "unconfigured" ? <p>Banking is not connected to this workspace yet.</p> : <>
      {data && <p className="rmb-status">Read from Plaid {formatRelativeTime(data.fetchedAt) ?? "at an unknown time"}. Bank reads refresh at most every five minutes.</p>}
      {data?.state === "partial" && <p role="status">Some bank information is unavailable. Review the connection status below.</p>}
      {data?.state === "unavailable" && <p role="alert">The connected banks could not be read. Try refreshing in a few minutes.</p>}
      <div className="rmb-accounts">{connections.map(connection => <section className="rmb-connection" key={connection.id}><h4>{connection.label}</h4><p>{connection.transactionsLastSuccessfulUpdate ? `Bank transactions last updated ${formatTimestamp(connection.transactionsLastSuccessfulUpdate) ?? "at an unknown time"}.` : "Bank transaction update time unavailable."}</p>{connection.transactionsLastFailedUpdate && (!connection.transactionsLastSuccessfulUpdate || connection.transactionsLastFailedUpdate > connection.transactionsLastSuccessfulUpdate) && <p>A newer bank transaction update attempt failed.</p>}{connection.balancesState !== "ready" && <p>Live balances unavailable.</p>}{connection.transactionsState !== "ready" && <p>{connection.transactionsState === "partial" ? "Transaction list is incomplete." : "Transactions unavailable."}</p>}{connection.accounts.map(account => <article key={account.id}><h5>{account.name} {account.mask ? `••${account.mask}` : ""}</h5><span>{account.type} · {account.currency ?? "Currency unavailable"}</span><dl><div><dt>Current balance</dt><dd>{money(account.currentCents, account.currency)}</dd></div><div><dt>Available balance</dt><dd>{money(account.availableCents, account.currency)}</dd></div></dl></article>)}{connection.accounts.length === 0 && connection.balancesState === "ready" && <p>No accounts returned.</p>}</section>)}</div>
      <div className="rmb-heading"><h3>Recent transactions</h3><div className="rmb-filters"><label>Account <select value={selected} onChange={event => { setSelected(event.target.value); setPage(0); }}><option value="all">All accounts</option>{accounts.map(account => <option value={account.id} key={account.id}>{account.connection} · {account.name} {account.mask ? `••${account.mask}` : ""}</option>)}</select></label><label>Status <select value={status} onChange={event => { setStatus(event.target.value); setPage(0); }}><option value="all">All</option><option value="posted">Posted</option><option value="pending">Pending</option></select></label></div></div>
      <p>{data ? `${formatLongDate(data.fromDate) ?? data.fromDate} through ${formatLongDate(data.throughDate) ?? data.throughDate}. ` : ""}Incoming and outgoing follow the bank transaction amount. Pending entries may change.</p>
      <div className="rmb-table"><table><thead><tr><th>Date</th><th>Account</th><th>Description</th><th>Status</th><th className="rmb-number">Incoming</th><th className="rmb-number">Outgoing</th></tr></thead><tbody>{pageTransactions.map(tx => { const account = accounts.find(account => account.id === tx.accountId); return <tr key={tx.id}><td>{formatTableDate(tx.date) ?? tx.date}</td><td>{account?.name ?? "Account"} {account?.mask ? `••${account.mask}` : ""}</td><td>{tx.description}</td><td>{tx.pending ? "Pending" : "Posted"}</td><td className="rmb-number">{tx.amountCents === null ? "Unavailable" : tx.amountCents < 0 ? money(-tx.amountCents, tx.currency) : "—"}</td><td className="rmb-number">{tx.amountCents === null ? "Unavailable" : tx.amountCents >= 0 ? money(tx.amountCents, tx.currency) : "—"}</td></tr>; })}{transactions.length === 0 && <tr><td colSpan={6}>{data?.connections.some(connection => connection.transactionsState !== "ready") ? "No transactions available for these filters; bank coverage is incomplete." : "No transactions for these filters."}</td></tr>}</tbody></table></div>
      <ListTotals totalCount={transactions.length} visibleCount={pageTransactions.length} itemLabel="bank transaction" />
      {transactions.length > 0 && <nav className="rmb-pagination" aria-label="Transaction pages"><span>{currentPage * 50 + 1}–{Math.min((currentPage + 1) * 50, transactions.length)} of {transactions.length} transactions</span><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><button type="button" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>Next</button></nav>}
    </>}
  </section>;
}
