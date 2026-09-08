import { useRef, useState, type FormEvent } from "react";
import { rentOpsAuthClient } from "./auth";

export function ManagerLeaseUpload({ tenancyId, onSaved, files }: { tenancyId: string; onSaved: () => void; files: Array<{ id?: string; fileName?: string; type?: string | null; availability?: string | null; tenancyId?: string }> }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    if (file.type !== "application/pdf" || !file.size || file.size > 50 * 1024 * 1024) { setMessage("Choose a PDF up to 50 MB."); return; }
    setBusy(true); setMessage("");
    try {
      const response = await rentOpsAuthClient.request(`/api/rent-ops/tenancies/${encodeURIComponent(tenancyId)}/lease-files`, { method: "POST", headers: { "Content-Type": "application/pdf", "x-document-name": file.name }, body: file });
      if (!response.ok) throw new Error("Lease PDF could not be uploaded. Check the file and try again.");
      setFile(undefined); if (inputRef.current) inputRef.current.value = ""; setMessage("Lease PDF uploaded and available to this tenancy’s primary tenant."); onSaved();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Lease PDF upload failed."); }
    finally { setBusy(false); }
  }
  return <div><ul>{files.filter(f => f.id && f.type === "lease" && f.availability === "verified" && f.tenancyId === tenancyId).map(f => <li key={f.id}><a href={`/api/rent-ops/documents/${encodeURIComponent(f.id!)}/download`}>{f.fileName ?? "Lease PDF"}</a></li>)}</ul><form className="ro-inline-actions ro-tab-actions" onSubmit={submit}>
    <label>Lease PDF<input ref={inputRef} aria-label="Lease PDF" type="file" accept="application/pdf,.pdf" disabled={busy} onChange={event => { setFile(event.target.files?.[0]); setMessage(""); }} /></label>
    <button className="primary" disabled={busy || !file}>{busy ? "Uploading…" : "Upload lease PDF"}</button>
    <p>Saved to this tenancy’s portal. Uploading does not verify signatures.</p>
    {message && <p role="status">{message}</p>}
  </form></div>;
}
