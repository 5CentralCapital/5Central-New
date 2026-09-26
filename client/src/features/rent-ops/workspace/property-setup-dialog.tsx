import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { CompanyContext } from "@shared/company/context";
import { commandEnvelopeSchema, operationIdSchema, operationReceiptSchema } from "@shared/company";
import { propertySetupPayloadSchema } from "@shared/company/property-contracts";
import { rentOpsAuthClient } from "../auth";

interface PropertySetupDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSaved: (message: string) => void;
  readonly organizationId?: string;
}

interface PropertySetupValues {
  readonly organizationId: string;
  readonly legalEntityId: string;
  readonly name: string;
  readonly slug: string;
  readonly line1: string;
  readonly line2: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  readonly propertyType: "multifamily" | "single_family" | "other";
  readonly operatingContact: string;
  readonly associationType: "legal" | "planned";
  readonly effectiveFrom: string;
  readonly assignmentStartOn: string;
  readonly notes: string;
}

function initialValues(context?: CompanyContext, preferredOrganizationId?: string): PropertySetupValues {
  const organization = context?.organizations.find(item => item.id === preferredOrganizationId) ?? context?.organizations[0];
  const entity = organization?.entities[0];
  return {
    organizationId: organization?.id ?? "",
    legalEntityId: entity?.id ?? "",
    name: "",
    slug: "",
    line1: "",
    line2: "",
    city: "",
    state: "",
    postalCode: "",
    propertyType: "multifamily",
    operatingContact: "",
    associationType: "legal",
    effectiveFrom: "",
    assignmentStartOn: "",
    notes: "",
  };
}

export function PropertySetupDialog({ open, onClose, onSaved, organizationId }: PropertySetupDialogProps) {
  const [context, setContext] = useState<CompanyContext>();
  const [values, setValues] = useState<PropertySetupValues>(() => initialValues());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const organizations = context?.organizations ?? [];
  const organization = useMemo(() => organizations.find(item => item.id === values.organizationId) ?? organizations[0], [organizations, values.organizationId]);
  const entities = organization?.entities ?? [];

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(undefined);
    void rentOpsAuthClient.request("/api/company/context", { headers: { Accept: "application/json" } })
      .then(async response => {
        if (!response.ok) throw new Error("Company records could not be loaded.");
        const next = await response.json() as CompanyContext;
        if (!active) return;
        setContext(next);
        const defaults = initialValues(next, organizationId);
        setValues(current => ({ ...defaults, ...current, organizationId: current.organizationId || defaults.organizationId, legalEntityId: current.legalEntityId || defaults.legalEntityId }));
      })
      .catch(nextError => { if (active) setError(nextError instanceof Error ? nextError.message : "Company records could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, organizationId]);

  if (!open) return null;

  const update = <K extends keyof PropertySetupValues>(key: K, value: PropertySetupValues[K]) => setValues(current => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const operationId = operationIdSchema.parse(globalThis.crypto.randomUUID());
    const parsed = propertySetupPayloadSchema.safeParse({
      name: values.name,
      slug: values.slug,
      address: { line1: values.line1, line2: values.line2 || null, city: values.city, state: values.state, postalCode: values.postalCode },
      propertyType: values.propertyType,
      operatingContact: values.operatingContact || null,
      associationType: values.associationType,
      ...(values.associationType === "legal" ? { effectiveFrom: values.effectiveFrom } : { assignmentStartOn: values.assignmentStartOn, notes: values.notes || null }),
    });
    if (!parsed.success || !values.organizationId || !values.legalEntityId) {
      setError(parsed.success ? "Choose a legal entity before saving." : (parsed.error.issues[0]?.message ?? "Enter the required property details."));
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const envelope = commandEnvelopeSchema(propertySetupPayloadSchema).parse({
        operationId,
        idempotencyKey: `property-setup:${operationId}`,
        scope: { organizationId: values.organizationId, legalEntityId: values.legalEntityId },
        payload: parsed.data,
      });
      const response = await rentOpsAuthClient.request(`/api/company/${encodeURIComponent(values.organizationId)}/property-commands/property.setup`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(typeof body?.message === "string" ? body.message : "Property could not be saved.");
      operationReceiptSchema.parse(body);
      onSaved(values.associationType === "legal" ? "Property and legal-entity mapping saved. No units were created." : "Planned property association saved. No legal mapping or rental units were created.");
      setValues(initialValues(context, organizationId));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Property could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return <div className="rm-dialog-backdrop"><section className="rm-dialog" role="dialog" aria-modal="true" aria-labelledby="property-setup-title">
    <header className="rm-dialog-header"><div><span className="rm-eyebrow">Property setup</span><h2 id="property-setup-title">Add property</h2></div><button type="button" className="rm-button rm-button--icon" aria-label="Close" onClick={onClose} disabled={saving}>×</button></header>
    {loading ? <div className="rm-empty">Loading company context…</div> : <form onSubmit={(event) => void submit(event)}>
      {error && <div className="rm-error" role="alert">{error}</div>}
      <fieldset disabled={saving}>
        <div className="rm-form-grid">
          <label>Name<input autoFocus value={values.name} onChange={event => update("name", event.currentTarget.value)} /></label>
          <label>Slug<input value={values.slug} onChange={event => update("slug", event.currentTarget.value)} placeholder="mallory-flip" /></label>
          <label>Legal entity<select value={values.legalEntityId} onChange={event => update("legalEntityId", event.currentTarget.value)}><option value="">Choose entity</option>{entities.map(entity => <option key={entity.id} value={entity.id}>{entity.name}</option>)}</select></label>
          <label>Association<select value={values.associationType} onChange={event => update("associationType", event.currentTarget.value as PropertySetupValues["associationType"])}><option value="legal">Acquired / legal mapping</option><option value="planned">Planned property</option></select></label>
          {values.associationType === "legal"
            ? <label>Legal-entity mapping starts<input type="date" value={values.effectiveFrom} onChange={event => update("effectiveFrom", event.currentTarget.value)} /></label>
            : <label>Planning assignment starts<input type="date" value={values.assignmentStartOn} onChange={event => update("assignmentStartOn", event.currentTarget.value)} /></label>}
          {values.associationType === "planned" && <label>Planning notes<input value={values.notes} onChange={event => update("notes", event.currentTarget.value)} placeholder="Closing date remains unknown" /></label>}
          <label>Property type<select value={values.propertyType} onChange={event => update("propertyType", event.currentTarget.value as PropertySetupValues["propertyType"])}><option value="multifamily">Multifamily</option><option value="single_family">Single family</option><option value="other">Other</option></select></label>
          <label>Operating contact<input value={values.operatingContact} onChange={event => update("operatingContact", event.currentTarget.value)} /></label>
          <label>Address<input value={values.line1} onChange={event => update("line1", event.currentTarget.value)} /></label>
          <label>Address line 2<input value={values.line2} onChange={event => update("line2", event.currentTarget.value)} /></label>
          <label>City<input value={values.city} onChange={event => update("city", event.currentTarget.value)} /></label>
          <label>State<input maxLength={2} value={values.state} onChange={event => update("state", event.currentTarget.value)} /></label>
          <label>Postal code<input value={values.postalCode} onChange={event => update("postalCode", event.currentTarget.value)} /></label>
        </div>
      </fieldset>
      <p className="rm-dialog-help">Legal setup creates a dated entity mapping. Planned setup creates only a scoped planning association; it does not claim acquisition or create rental units.</p>
      <footer className="rm-dialog-footer"><button type="button" className="rm-button" onClick={onClose} disabled={saving}>Cancel</button><button type="submit" className="rm-button rm-button-primary" disabled={saving}>{saving ? "Saving…" : "Save property"}</button></footer>
    </form>}
  </section></div>;
}
