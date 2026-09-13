import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { AdminSnapshot, TenantView } from "../types";
import type { TenantLedgerRow } from "./tenant-model";
import { tenantLedgerExportCsv } from "./tenant-ledger-export-model";
import "./report-export.css";

export function TenantLedgerExportDialog({ rows, tenant, snapshot, initialFrom, initialThrough, search, onClose }: {
  rows: TenantLedgerRow[]; tenant: TenantView; snapshot: AdminSnapshot; initialFrom: string; initialThrough: string; search: string; onClose: () => void;
}) {
  const [propertyIds, setPropertyIds] = useState<string[]>([]);
  const [from, setFrom] = useState(initialFrom);
  const [through, setThrough] = useState(initialThrough);
  const [keepSearch, setKeepSearch] = useState(true);
  const properties = snapshot.snapshot.properties.filter(property => property.id && rows.some(row => row.transaction.propertyId === property.id));
  function download() {
    const name = [tenant.person.firstName, tenant.person.lastName].filter(Boolean).join(" ") || "Tenant";
    const propertyLabel = propertyIds.length ? propertyIds.map(id => properties.find(property => property.id === id)?.name ?? id).join(" · ") : "All properties for this tenant";
    const url = URL.createObjectURL(new Blob([tenantLedgerExportCsv(rows, name, propertyLabel, from, through, keepSearch ? search : "", propertyIds)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "5central-tenant-transactions.csv"; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); onClose();
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="rm-export-dialog"><DialogTitle>Export tenant transactions</DialogTitle><DialogDescription>Choose properties and an inclusive date range. Leave dates blank for all history. Running balances remain the full account balances.</DialogDescription>
    <form onSubmit={event => { event.preventDefault(); download(); }}><fieldset><legend>Properties</legend><label className="rm-export-check"><input type="checkbox" checked={!propertyIds.length} onChange={() => setPropertyIds([])} />All properties for this tenant</label><div className="rm-export-properties">{properties.map(property => <label className="rm-export-check" key={property.id}><input type="checkbox" checked={propertyIds.includes(property.id!)} onChange={event => setPropertyIds(event.target.checked ? [...propertyIds, property.id!] : propertyIds.filter(id => id !== property.id))} />{property.name ?? property.id}</label>)}</div></fieldset>
    <fieldset className="rm-export-dates"><legend>Report dates</legend><label>From<input type="date" value={from} max={through || undefined} onChange={event => setFrom(event.target.value)} /></label><label>Through (inclusive)<input type="date" value={through} min={from || undefined} onChange={event => setThrough(event.target.value)} /></label></fieldset>
    {search && <label className="rm-export-check"><input type="checkbox" checked={keepSearch} onChange={event => setKeepSearch(event.target.checked)} />Keep search: {search}</label>}
    <div className="rm-export-actions"><button className="rm-button" type="button" onClick={onClose}>Cancel</button><button className="rm-button rm-export-submit" disabled={!!from && !!through && from > through}>Download CSV</button></div></form>
  </DialogContent></Dialog>;
}
