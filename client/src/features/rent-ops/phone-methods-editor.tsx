import { useState, type FormEvent } from "react";
import type { AdminPersonView } from "./types";
import { postRentOpsMutation, RentOpsApiError } from "./api";

type PhoneMethod = NonNullable<AdminPersonView["phoneMethods"]>[number];
export function PhoneMethodsEditor({ person, onSaved }: { person: AdminPersonView; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<PhoneMethod[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function change(index: number, patch: Partial<PhoneMethod>) { setRows(current => current.map((row, position) => position === index ? { ...row, ...patch } : row)); }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      if (rows.filter(row => row.isPrimary === true).length > 1) throw new Error("Choose at most one primary phone number.");
      await postRentOpsMutation({ action: "save-person", payload: { id: person.id, revision: person.recordRevision ?? 1, phoneMethods: rows } });
      setEditing(false); onSaved();
    } catch (cause) { if (cause instanceof RentOpsApiError && cause.code === "conflict") { setEditing(false); onSaved(); } setError(cause instanceof Error ? cause.message : "Phone numbers could not be saved."); }
    finally { setBusy(false); }
  }
  return <div className="ro-phone-editor">
    {!editing ? <button className="secondary" onClick={() => { setRows((person.phoneMethods ?? []).map(row => ({ ...row }))); setError(""); setEditing(true); }}>Edit phone numbers</button> : <form onSubmit={submit}><fieldset disabled={busy}><legend>Phone numbers</legend>{rows.map((row, index) => <div className="ro-form-grid" key={row.id ?? index}><label>Number<input required value={row.value ?? ""} maxLength={80} onChange={event => change(index, { value: event.target.value || undefined })} /></label><label>Type<input value={row.type ?? ""} maxLength={80} placeholder="Unknown" onChange={event => change(index, { type: event.target.value || undefined })} /></label>{(["isPrimary", "isTextReady"] as const).map(key => <label key={key}>{key === "isPrimary" ? "Primary number" : "Text enabled"}<select value={row[key] === undefined ? "" : String(row[key])} onChange={event => change(index, { [key]: event.target.value === "" ? undefined : event.target.value === "true" })}><option value="">Unknown</option><option value="true">Yes</option><option value="false">No</option></select></label>)}<button type="button" className="secondary" onClick={() => setRows(current => current.filter((_, position) => position !== index))}>Remove number</button></div>)}<div className="ro-actions"><button type="button" className="secondary" disabled={rows.length >= 20} onClick={() => setRows(current => [...current, {}])}>Add number</button><button className="primary">{busy ? "Saving…" : "Save phone numbers"}</button><button type="button" className="secondary" onClick={() => setEditing(false)}>Cancel</button></div></fieldset></form>}{error && <p role="alert">{error}</p>}
  </div>;
}
