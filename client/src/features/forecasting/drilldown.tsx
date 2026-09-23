import React from "react";
import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import type { ForecastContribution, ForecastExplainResponse, ForecastRunSource } from "@shared/forecasting/contracts";
import { forecastApi } from "./api";
import { dateLabel, money, periodLabel } from "./format";
import { EmptyState, Notice } from "./ui";

/** Plain-language summary of an input record for the side sheet. */
export function inputSummary(value: unknown): readonly [string, string][] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const rows: [string, string][] = [];
  const labels: Record<string, string> = {
    amountCents: "Amount", currentRentCents: "Current rent", marketRentCents: "Market rent", subsidyCents: "Housing assistance", principalCents: "Principal",
    annualRateBps: "Rate", frequency: "Frequency", firstOn: "First date", endOn: "End date", completionOn: "Completion", costStartOn: "Cost start",
    remainingCostCents: "Remaining cost", leaseEndOn: "Lease end", status: "Status", maturityOn: "Maturity", closeOn: "Closing", priceCents: "Price",
    reason: "Reason", author: "Set by", setOn: "Set on", state: "State", source: "Source", asOf: "As of", paymentLagDays: "Payment lag (days)", note: "Note",
  };
  for (const [key, label] of Object.entries(labels)) {
    const raw = record[key];
    if (raw === undefined || raw === null || raw === "") continue;
    let text = String(raw);
    if (key.endsWith("Cents")) text = money(String(raw));
    else if (key.endsWith("Bps")) text = `${(Number(raw) / 100).toFixed(2)}%`;
    else if (/On$|asOf/.test(key)) text = dateLabel(String(raw), "long");
    rows.push([label, text]);
  }
  return rows.slice(0, 8);
}

/** Side sheet: the dated events and assumption inputs behind one figure. */
export function DrilldownSheet({ organizationId, source, line, period, currency, onClose }: {
  organizationId: string; source: ForecastRunSource; line: string; period: string; currency: string; onClose: () => void;
}) {
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);
  const [pages, setPages] = useState<ForecastContribution[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [more, setMore] = useState<{ loading: boolean; error?: unknown }>({ loading: false });
  const sourceKey = "snapshotId" in source ? source.snapshotId : `${source.scenarioId}:${source.assumptionVersion ?? "current"}`;
  const query = useQuery({
    queryKey: ["forecasting", "explain", organizationId, sourceKey, line, period],
    queryFn: ({ signal }) => forecastApi.explain(organizationId, source, line, period, undefined, signal),
    retry: false, staleTime: 60_000,
  });
  useEffect(() => { setPages([]); setCursor(undefined); }, [line, period, sourceKey]);
  useEffect(() => { if (query.data) setCursor(query.data.nextCursor ?? undefined); }, [query.data]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", listener);
    return () => { window.removeEventListener("keydown", listener); previous?.focus?.(); };
  }, [onClose]);
  const loadMore = async () => {
    if (!cursor) return;
    setMore({ loading: true });
    try {
      const next: ForecastExplainResponse = await forecastApi.explain(organizationId, source, line, period, cursor);
      setPages(current => [...current, ...next.contributions]);
      setCursor(next.nextCursor ?? undefined);
      setMore({ loading: false });
    } catch (error) { setMore({ loading: false, error }); }
  };
  const data = query.data;
  const rows = data ? [...data.contributions, ...pages] : [];
  return <aside ref={panel} className="fc-sheet" role="dialog" aria-modal="false" aria-labelledby={titleId} tabIndex={-1}>
    <header className="fc-sheet-header">
      <div>
        <p className="fc-overline">{periodLabel(period)}</p>
        <h2 id={titleId}>{data?.label ?? "Loading…"}</h2>
      </div>
      <button type="button" className="rm-button rm-button--icon rm-button--ghost" aria-label="Close details" onClick={onClose}><X size={17} /></button>
    </header>
    {query.error ? <Notice error={query.error} onRetry={() => void query.refetch()} /> : !data ? <p className="fc-muted" role="status">Loading events…</p> : <>
      <dl className="fc-sheet-total">
        {data.openingCents !== null && <div><dt>Opening balance</dt><dd>{money(data.openingCents, currency)}</dd></div>}
        <div><dt>{data.openingCents !== null ? "Closing balance" : "Total"}</dt><dd className="fc-strong">{money(data.totalCents, currency)}</dd></div>
        <div><dt>Events</dt><dd>{data.contributionCount}</dd></div>
      </dl>
      {data.components.length > 0 && <section className="fc-sheet-section" aria-label="Statement lines">
        <h3>Statement lines</h3>
        <table className="rm-table fc-table fc-table--compact"><tbody>
          {data.components.map(component => <tr key={component.key}><th scope="row">{component.label}</th><td className="fc-num">{money(component.cents, currency)}</td></tr>)}
        </tbody></table>
      </section>}
      <section className="fc-sheet-section" aria-label="Contributing events">
        <h3>Contributing events</h3>
        {rows.length === 0 ? <EmptyState title="No events" message="Nothing moved this figure in the period." /> :
          <table className="rm-table fc-table fc-table--compact">
            <thead><tr><th scope="col">Date</th><th scope="col">Event</th><th scope="col" className="fc-num">Amount</th></tr></thead>
            <tbody>{rows.map(row => <tr key={row.eventId}>
              <td>{dateLabel(row.date)}</td>
              <td><span>{row.label}</span>{row.modeled && <span className="rm-status rm-status--warning fc-tag">Modeled</span>}</td>
              <td className={`fc-num${row.amountCents.startsWith("-") ? " fc-num--negative" : ""}`}>{money(row.amountCents, currency)}</td>
            </tr>)}</tbody>
          </table>}
        <Notice error={more.error} />
        {cursor && <button type="button" className="rm-button rm-button--small" onClick={() => void loadMore()} disabled={more.loading}>{more.loading ? "Loading…" : `Show more (${data.contributionCount - rows.length} left)`}</button>}
      </section>
      {data.inputs.length > 0 && <section className="fc-sheet-section" aria-label="Inputs">
        <h3>Inputs</h3>
        <ul className="fc-inputs">
          {data.inputs.map(input => <li key={input.ref}>
            <strong>{input.label}</strong>
            <dl>{inputSummary(input.value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          </li>)}
        </ul>
      </section>}
    </>}
  </aside>;
}
