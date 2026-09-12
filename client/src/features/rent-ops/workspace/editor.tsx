import { useEffect, useRef, useState, type FormEvent } from "react";
import { X, AlertCircle, Loader2 } from "lucide-react";
import { postRentOpsMutation } from "../api";
import { handleRentOpsMutationError } from "../ui";
import { depositAmounts } from "../../tenant-portal/deposit-view";
import { mutationPayload, type FormValues, type QuickAction } from "../form-payload";
import type { AdminSnapshot } from "../types";
import { relationshipErrors, actionFields, scopedFields, editorTitle, confirmedChargeDefinition, ACTION_LABELS } from "./editor-model";
import "./editor.css";

export function WorkspaceEditor({ action, snapshot, initialValues = {}, onClose, onSaved, onConflict }: { action: QuickAction; snapshot: AdminSnapshot; initialValues?: FormValues; onClose: () => void; onSaved: (message: string) => void; onConflict?: () => void }) {
  const baseFields = actionFields(action, snapshot, initialValues);
  const deposit = action === "save-security-deposit" ? snapshot.snapshot.securityDeposits.find((item) => item.id === initialValues.id) : undefined;
  const depositView = deposit ? depositAmounts(deposit) : undefined;
  const [values, setValues] = useState<FormValues>(() => ({ ...Object.fromEntries(baseFields.map((field) => [field.name, field.type === "checkbox" ? undefined : ""])), ...initialValues }));
  const [saving, setSaving] = useState(false);
  const [changedFields, setChangedFields] = useState<Set<string>>(() => new Set());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const fields = scopedFields(action, snapshot, initialValues, values);
  const dialog = useRef<HTMLElement>(null);
  const submitting = useRef(false);
  const [discard, setDiscard] = useState(false);
  const dirty = baseFields.some(field => String(values[field.name] ?? "") !== String(initialValues[field.name] ?? ""));
  function close() { if (submitting.current) return; if (dirty) setDiscard(true); else onClose(); }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    return () => previous?.focus();
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (submitting.current) return; submitting.current = true; setSaving(true); setError(undefined);
    try {
      const invalid = relationshipErrors(snapshot, values, initialValues);
      setFieldErrors(invalid);
      if (Object.keys(invalid).length) throw new Error("Review the selected relationships before saving.");
      if (action === "save-recurring-schedule" || action === "convert-application") confirmedChargeDefinition(snapshot, values.chargeDefinitionId, values.category);
      if (action === "save-recurring-schedule") {
        const scopeType = String(values.scopeType ?? "");
        const scopeId = String(values.scopeId ?? "");
        const propertyId = String(values.propertyId ?? "");
        const unitId = String(values.unitId ?? "");
        const tenancyId = String(values.tenancyId ?? "");
        const personId = String(values.personId ?? "");
        if (scopeType === "property" && (scopeId !== propertyId || unitId || tenancyId || personId)) throw new Error("Property scope requires only the selected property.");
        if (scopeType === "unit" && (!unitId || tenancyId || personId)) throw new Error("Unit scope requires one exact unit and no tenant fields.");
        if (scopeType === "tenant" && (!unitId || !tenancyId || !personId)) throw new Error("Tenant scope requires an exact resident, tenancy, unit, and property.");
      }
      const result = await postRentOpsMutation({ action, payload: mutationPayload(action, values, initialValues, changedFields) });
      if (!result.ok) throw new Error(result.message ?? "The record was not saved.");
      onSaved(result.message ?? `${ACTION_LABELS[action]} completed.`); onClose();
    }
    catch (cause) { handleRentOpsMutationError(cause, onConflict, setError); }
    finally { submitting.current = false; setSaving(false); }
  }
  return (
    <div className="rm-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section ref={dialog} onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); close(); }
        if (event.key === "Tab") {
          const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []);
          const first = items[0], last = items[items.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }} className="rm-dialog" role="dialog" aria-modal="true" aria-labelledby="rm-dialog-title">
        <header><div><h2 id="rm-dialog-title">{editorTitle(action, initialValues)}</h2></div><button className="icon-button" onClick={close} aria-label="Close"><X /></button></header>
        <form onSubmit={submit}>
          {depositView && <p>Current amount held: {depositView.held}.{depositView.sourceBalance !== undefined && <> Source balance: {depositView.sourceBalance}.</>} Leave unknown held amounts blank until confirmed.</p>}
          <fieldset disabled={saving} className="rm-dialog-fields"><legend>Record details</legend><div className="rm-dialog-grid">
            {fields.map((field) => <label key={field.name} className={field.type === "textarea" ? "wide" : ""}>{field.label}{field.required && <sup> *</sup>}{field.type === "select" ? <select required={field.required} value={String(values[field.name] ?? "")} onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}><option value="">Select…</option>{field.options?.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : field.type === "textarea" ? <textarea required={field.required} value={String(values[field.name] ?? "")} onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))} /> : field.type === "checkbox" ? <select required={field.required} value={typeof values[field.name] === "boolean" ? String(values[field.name]) : ""} onChange={(event) => { const selected = event.target.value; setChangedFields(current => new Set([...Array.from(current), field.name])); setValues(current => ({ ...current, [field.name]: selected === "" ? undefined : selected === "true" })); }}><option value="" disabled={typeof initialValues[field.name] === "boolean"}>Unknown / not specified</option><option value="true">Yes</option><option value="false">No</option></select> : <input required={field.required} type={field.type ?? "text"} step={field.type === "number" ? "0.01" : undefined} value={String(values[field.name] ?? "")} onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))} />}{fieldErrors[field.name] && <span className="rm-dialog-field-error" role="alert">{fieldErrors[field.name]}</span>}</label>)}
          </div>
          </fieldset>
          {discard && <div role="alert" className="rm-dialog-discard"><p>Discard your unsaved changes?</p><button type="button" onClick={() => setDiscard(false)}>Keep editing</button><button type="button" disabled={saving} onClick={onClose}>Discard changes</button></div>}
          {error && <p role="alert" className="rm-dialog-error"><AlertCircle />{error}</p>}
          <footer className="rm-dialog-footer"><button type="button" className="secondary" onClick={close}>Cancel</button><button className="primary" disabled={saving}>{saving && <Loader2 className="spin" />}{saving ? "Saving…" : "Save"}</button></footer>
        </form>
      </section>
    </div>
  );
}

