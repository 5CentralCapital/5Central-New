import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleAlert, FileSearch, RefreshCw } from "lucide-react";
import type { MraPacketReadModel } from "@shared/intake";
import { EntityLink, RecordLink } from "../rent-ops/workspace/entity-link";
import { intakeApi } from "./api";
import type { IntakeResultsProps } from "./types";
import { formatKnownSubtotal, sumCentsTexts } from "../workspaces/format";
import "./intake.css";

function amount(value: string, currency: string): string {
  try {
    const cents = BigInt(value);
    const negative = cents < BigInt(0);
    const absolute = (negative ? -cents : cents).toString().padStart(3, "0");
    return `${negative ? "-" : ""}${currency} ${absolute.slice(0, -2)}.${absolute.slice(-2)}`;
  } catch { return `${currency} —`; }
}

function dateLabel(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date);
}

function label(value: string | null | undefined): string { return value ? value.replace(/_/g, " ").replace(/\b\w/g, letter => letter.toUpperCase()) : "—"; }

interface CategoryTotal {
  readonly category: string;
  readonly currency: string;
  readonly count: number;
  readonly summary: ReturnType<typeof sumCentsTexts>;
}

function categoryTotals(lines: MraPacketReadModel["lines"]): readonly CategoryTotal[] {
  const groups = new Map<string, { category: string; currency: string; amounts: Array<string | null>; count: number }>();
  for (const line of lines) {
    const key = `${line.category}\u0000${line.currency}`;
    const group = groups.get(key) ?? { category: line.category, currency: line.currency, amounts: [], count: 0 };
    group.amounts.push(line.amountCents);
    group.count += 1;
    groups.set(key, group);
  }
  return Array.from(groups.values())
    .map(group => ({ category: group.category, currency: group.currency, count: group.count, summary: sumCentsTexts(group.amounts) }))
    .sort((left, right) => `${left.category}\u0000${left.currency}`.localeCompare(`${right.category}\u0000${right.currency}`));
}

function packetPeriod(packet: MraPacketReadModel): { readonly from: string; readonly through: string } {
  const dates = packet.lines.map(line => line.postedOn).sort();
  return { from: dates[0] ?? packet.updatedAt.slice(0, 10), through: dates.at(-1) ?? packet.updatedAt.slice(0, 10) };
}

/** Link a mapped line to the local record it affects. */
function LineTarget({ line }: { readonly line: MraPacketReadModel["lines"][number] }) {
  const mapping = line.mapping;
  if (!mapping || mapping.outcome !== "exact") return null;
  if (mapping.personId) return <EntityLink personId={mapping.personId} tab="ledger" className="intake-link">Tenant ledger</EntityLink>;
  if (mapping.localTargetKind === "unit_account" && mapping.localTargetId) return <RecordLink kind="unit" recordId={mapping.localTargetId} className="intake-link">Unit</RecordLink>;
  const propertyId = mapping.propertyId ?? (mapping.localTargetKind === "property_account" ? mapping.localTargetId : undefined);
  if (propertyId) return <RecordLink kind="property" recordId={propertyId} className="intake-link">Property</RecordLink>;
  return null;
}

function ErrorBox({ error, retry }: { readonly error: unknown; readonly retry: () => void }) {
  return <div className="intake-message is-error" role="alert"><CircleAlert size={16} /><span>{error instanceof Error ? error.message : "MRA results could not be loaded."}</span><button type="button" onClick={retry}>Try again</button></div>;
}

function PacketSummary({ packet, selected, onSelect }: { readonly packet: MraPacketReadModel; readonly selected: boolean; readonly onSelect: () => void }) {
  const lineCount = packet.lines.length;
  const heldCount = packet.reconciliation?.heldLineCount ?? packet.lines.filter(line => line.outcome?.startsWith("held_")).length;
  const period = packetPeriod(packet);
  return <button type="button" className={`intake-packet-row${selected ? " is-selected" : ""}`} aria-pressed={selected} onClick={onSelect}>
    <span><strong>{packet.source.fileName}</strong><small>{dateLabel(period.from)} – {dateLabel(period.through)}</small></span>
    <span><em className={`intake-state is-${packet.state}`}>{label(packet.state)}</em><small>{lineCount} line{lineCount === 1 ? "" : "s"}{heldCount ? ` · ${heldCount} held` : ""}</small></span>
  </button>;
}

/** Browser read model only. It has no upload, mapping, preview, or apply actions. */
export function MraResults({ organizationId, organizationName, legalEntityId, propertyId, api = intakeApi, initialPacketId }: IntakeResultsProps) {
  const [packets, setPackets] = useState<readonly MraPacketReadModel[]>([]);
  const [selectedId, setSelectedId] = useState(initialPacketId ?? "");
  const [selected, setSelected] = useState<MraPacketReadModel | undefined>();
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<unknown>();
  const [detailError, setDetailError] = useState<unknown>();

  const reload = useCallback(async () => {
    setLoading(true); setError(undefined);
    try {
      const page = await api.listPackets(organizationId, { legalEntityId, propertyId });
      setPackets(page.items);
      setSelectedId(current => current && page.items.some(packet => String(packet.id) === current) ? current : String(page.items[0]?.id ?? ""));
    } catch (nextError) { setError(nextError); }
    finally { setLoading(false); }
  }, [api, legalEntityId, organizationId, propertyId]);

  const loadDetail = useCallback(async (packetId: string) => {
    if (!packetId) { setSelected(undefined); return; }
    setDetailLoading(true); setDetailError(undefined);
    try { setSelected(await api.getPacket(organizationId, packetId)); }
    catch (nextError) { setDetailError(nextError); setSelected(undefined); }
    finally { setDetailLoading(false); }
  }, [api, organizationId]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { void loadDetail(selectedId); }, [loadDetail, selectedId]);
  const warnings = useMemo(() => selected?.candidateWarnings ?? [], [selected]);
  const selectedPeriod = selected ? packetPeriod(selected) : undefined;
  const selectedCategoryTotals = useMemo(() => selected ? categoryTotals(selected.lines) : [], [selected]);

  return <div className="intake-workspace" data-testid="intake-results">
    <header className="intake-toolbar"><div><h1>MRA Results</h1>{organizationName && <p>{organizationName}</p>}</div><button type="button" className="intake-button" data-testid="intake-refresh" onClick={() => void reload()} disabled={loading}><RefreshCw size={14} />{loading ? "Refreshing…" : "Refresh"}</button></header>
    {error ? <ErrorBox error={error} retry={() => void reload()} /> : null}
    <div className="intake-layout"><aside className="intake-sidebar"><div className="intake-sidebar-heading"><strong>Packets</strong><span>{packets.length}</span></div>{loading && !packets.length ? <div className="intake-empty">Loading results…</div> : packets.map(packet => <PacketSummary key={String(packet.id)} packet={packet} selected={String(packet.id) === selectedId} onSelect={() => setSelectedId(String(packet.id))} />)}{!loading && !packets.length && <div className="intake-empty"><FileSearch size={20} aria-hidden="true" /><h3>No MRA Results</h3><span>Owner packets appear here after they are staged.</span><button type="button" className="intake-button" onClick={() => void reload()}>Refresh</button></div>}</aside>
      <main className="intake-main">{detailError ? <ErrorBox error={detailError} retry={() => void loadDetail(selectedId)} /> : null}{detailLoading ? <div className="intake-empty">Loading packet details…</div> : !selected ? <div className="intake-empty"><FileSearch size={24} aria-hidden="true" /><h3>Select a Packet</h3><span>Choose a packet to see its lines and control totals.</span></div> : <>
        <header className="intake-detail-header"><div><h2>{selected.source.fileName}</h2><p>{dateLabel(selectedPeriod!.from)} – {dateLabel(selectedPeriod!.through)} · {label(selected.state)}</p></div><span className={`intake-state is-${selected.state}`}>{label(selected.state)}</span></header>
        {warnings.length > 0 && <div className="intake-warning" role="status">{warnings.length} parser note{warnings.length === 1 ? "" : "s"}: {warnings[0]}</div>}
        {selected.reconciliation && <div className="intake-metrics"><div><span>Source lines</span><strong>{selected.reconciliation.sourceLineCount}</strong></div><div><span>Matched</span><strong>{selected.reconciliation.matchedLineCount}</strong></div><div><span>Held</span><strong>{selected.reconciliation.heldLineCount}</strong></div><div><span>Applied</span><strong>{selected.reconciliation.appliedLineCount}</strong></div></div>}
        {selected.reconciliation && selected.reconciliation.totals.length > 0 && <div className="intake-card"><div className="intake-card-heading"><h3>Control totals</h3><span>{selected.reconciliation.accounts.length} account{selected.reconciliation.accounts.length === 1 ? "" : "s"}</span></div><div className="intake-table-wrap"><table className="intake-table"><thead><tr><th>Currency</th><th>Input</th><th>Matched</th><th>Held</th><th>Duplicate</th><th>Overlap</th><th>Applied</th></tr></thead><tbody>{selected.reconciliation.totals.map(total => <tr key={total.currency}><td>{total.currency}</td><td className="amount">{amount(total.inputCents, total.currency)}</td><td className="amount">{amount(total.matchedCents, total.currency)}</td><td className="amount">{amount(total.heldCents, total.currency)}</td><td className="amount">{amount(total.duplicateCents, total.currency)}</td><td className="amount">{amount(total.overlapCents, total.currency)}</td><td className="amount">{amount(total.appliedCents, total.currency)}</td></tr>)}</tbody></table></div></div>}
        <div className="intake-card"><div className="intake-card-heading"><h3>Normalized activity</h3><span>{selected.lines.length} line{selected.lines.length === 1 ? "" : "s"}</span></div><div className="intake-table-wrap"><table className="intake-table"><thead><tr><th>Account</th><th>Posted</th><th>Amount</th><th>Category</th><th>Payer</th><th>Outcome</th><th>Evidence</th></tr></thead><tbody>{selected.lines.map(line => <tr data-testid="intake-line-row" key={line.sourceLineKey}><td><strong>{line.sourceAccountName ?? line.sourceAccountId}</strong><small>{line.tenantDisplayName ?? line.description ?? "—"}</small><LineTarget line={line} /></td><td>{dateLabel(line.postedOn)}</td><td className="amount">{amount(line.amountCents, line.currency)}</td><td>{label(line.category)}</td><td>{label(line.payer)}</td><td><span className={`intake-state is-${line.outcome ?? "pending"}`}>{label(line.outcome ?? "pending")}</span>{line.outcomeReason && <small>{line.outcomeReason}</small>}</td><td>{line.evidence.map(evidence => <small key={`${evidence.page ?? ""}:${evidence.row ?? ""}:${evidence.sourcePath ?? ""}`}>{evidence.page ? `Page ${evidence.page}` : evidence.row ? `Row ${evidence.row}` : evidence.sourcePath ?? "Source"}</small>)}</td></tr>)}</tbody><tfoot aria-label="Normalized activity totals by category">{selectedCategoryTotals.map(total => <tr key={`${total.category}:${total.currency}`}><th scope="row" colSpan={2}>{label(total.category)} total · {total.currency}</th><td className="amount">{formatKnownSubtotal(total.summary.total, total.summary.complete, total.currency)}</td><td colSpan={4}>{total.count} line{total.count === 1 ? "" : "s"}</td></tr>)}</tfoot></table></div></div>
      </>}</main>
    </div>
  </div>;
}

export default MraResults;
