import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, CircleAlert, ClipboardCheck, LoaderCircle, RefreshCw, X } from "lucide-react";
import {
  REVIEW_ACCOUNTING_ROUTES,
  REVIEW_CAUSE_FAMILIES,
  REVIEW_MATERIALITIES,
  type ReviewCaseCommandKind,
  type ReviewCaseDetail,
  type ReviewCaseState,
  type ReviewCaseSummary,
  type ReviewCauseFamily,
  type ReviewMateriality,
} from "@shared/review-cases";
import { EntityLink, RecordLink } from "../rent-ops/workspace/entity-link";
import { PendingEnvelopes } from "../work-orders/pending";
import { parseMoneyInput } from "../projects/money";
import { ReviewCaseApiError, reviewCaseEnvelope, reviewCasesApi, type ReviewCaseCommandEnvelope, type ReviewCasesApi } from "./api";
import { CompanyGate, entityForProperty, useCompanyContext } from "./company-context";
import {
  COMMAND_LABELS,
  ageLabel,
  eventLabel,
  evidenceKindLabel,
  familyLabel,
  formatImpact,
  groupQueue,
  impactTotal,
  materialityClass,
  materialityLabel,
  primaryCommand,
  recordLabel,
  recordLinkTarget,
  stateClass,
  stateLabel,
} from "./model";
import "./review-cases.css";

export interface ReviewQueueWorkspaceProps {
  readonly organizationId?: string;
  readonly propertyId?: string | null;
  /** Test seam; defaults to the browser API. */
  readonly api?: ReviewCasesApi;
}

type View = "active" | "blocked" | "verified" | "all";
const VIEW_LABELS: Record<View, string> = { active: "Active", blocked: "Blocked", verified: "Verified", all: "All" };
const VIEW_STATES: Record<View, readonly ReviewCaseState[] | undefined> = {
  active: undefined, blocked: ["blocked"], verified: ["verified"], all: ["open", "researching", "proposed", "applied", "blocked", "verified"],
};

type DialogState =
  | { kind: "text"; command: "review_case.start_research" | "review_case.block" | "review_case.reopen" | "review_case.note" }
  | { kind: "evidence" }
  | { kind: "propose" }
  | { kind: "confirm"; command: "review_case.apply" | "review_case.verify" };

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function Notice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return <div className="rc-alert" role="alert"><CircleAlert size={16} aria-hidden="true" /><span>{errorText(error, "Something went wrong.")}</span>{onRetry && <button type="button" className="rm-button rm-button--small" onClick={onRetry}>{error instanceof ReviewCaseApiError && error.conflict ? "Reload" : "Try Again"}</button>}</div>;
}

function Dialog({ title, subtitle, onClose, onSubmit, saving, submitLabel, children }: {
  title: string; subtitle?: string; onClose: () => void; onSubmit: (event: FormEvent) => void; saving: boolean; submitLabel: string; children: ReactNode;
}) {
  const titleId = `rc-dialog-${useId().replace(/:/g, "")}`;
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("[data-autofocus], input, select, textarea")?.focus();
    return () => previous?.focus?.();
  }, []);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape" && !saving) onClose(); };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onClose, saving]);
  return <div className="rm-dialog-backdrop rc-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <section ref={panel} className="rm-dialog rc-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={saving}>
      <div className="rm-dialog-header rc-dialog-header">
        <div><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <button type="button" className="rm-button rm-button--icon rm-button--ghost" aria-label="Close" onClick={onClose} disabled={saving}><X size={17} /></button>
      </div>
      <form id={`${titleId}-form`} className="rm-dialog-body rc-dialog-body" onSubmit={onSubmit} noValidate>
        <fieldset className="rc-fieldset" disabled={saving}>{children}</fieldset>
      </form>
      <div className="rm-dialog-footer rc-dialog-footer">
        <button type="button" className="rm-button" onClick={onClose} disabled={saving}>Cancel</button>
        <button type="submit" form={`${titleId}-form`} className="rm-button rm-button-primary" disabled={saving}>{saving ? <><LoaderCircle size={15} className="rc-spin" />Saving…</> : submitLabel}</button>
      </div>
    </section>
  </div>;
}

function Field({ label, children, wide = false, help }: { label: string; children: ReactNode; wide?: boolean; help?: string }) {
  return <label className={`rm-field${wide ? " rm-field--wide" : ""}`}><span className="rm-field-label">{label}</span>{children}{help && <span className="rm-field-help">{help}</span>}</label>;
}

type Save = (kind: ReviewCaseCommandKind, payload: Record<string, unknown>, expectedRevision?: number) => Promise<void>;

const TEXT_DIALOGS: Record<"review_case.start_research" | "review_case.block" | "review_case.reopen" | "review_case.note", { title: string; label: string; field: string; required: boolean; submit: string }> = {
  "review_case.start_research": { title: "Start Research", label: "Note (optional)", field: "note", required: false, submit: "Start Research" },
  "review_case.block": { title: "Mark Blocked", label: "Missing fact", field: "missingFact", required: true, submit: "Mark Blocked" },
  "review_case.reopen": { title: "Reopen Case", label: "Reason", field: "reason", required: true, submit: "Reopen" },
  "review_case.note": { title: "Add Note", label: "Note", field: "note", required: true, submit: "Add Note" },
};

function TextDialog({ detail, command, onClose, onSaved, save }: { detail: ReviewCaseDetail; command: keyof typeof TEXT_DIALOGS; onClose: () => void; onSaved: () => void; save: Save }) {
  const spec = TEXT_DIALOGS[command];
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (spec.required && !text.trim()) { setError(new Error(command === "review_case.block" ? "Name the fact this case is waiting on." : "Enter a reason.")); return; }
    setSaving(true); setError(undefined);
    try {
      const revisioned = command !== "review_case.note";
      await save(command, { caseId: detail.id, ...(text.trim() ? { [spec.field]: text.trim() } : {}) }, revisioned ? detail.recordRevision : undefined);
      onSaved();
    } catch (saveError) { setError(saveError); } finally { setSaving(false); }
  };
  return <Dialog title={spec.title} subtitle={detail.shortLabel} onClose={onClose} onSubmit={submit} saving={saving} submitLabel={spec.submit}>
    <Notice error={error} />
    <Field label={spec.label} wide help={command === "review_case.block" ? "For example: executed lease for unit 2A, or the May bank statement." : undefined}>
      <textarea data-autofocus rows={3} maxLength={command === "review_case.block" ? 500 : 4000} value={text} onChange={event => setText(event.currentTarget.value)} />
    </Field>
  </Dialog>;
}

function EvidenceDialog({ detail, onClose, onSaved, save }: { detail: ReviewCaseDetail; onClose: () => void; onSaved: () => void; save: Save }) {
  const [kind, setKind] = useState<"document" | "source_record" | "email" | "observation" | "note">("email");
  const [reference, setReference] = useState("");
  const [summary, setSummary] = useState("");
  const [observedOn, setObservedOn] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!reference.trim() || !summary.trim()) { setError(new Error("Enter where the evidence is and what it shows.")); return; }
    if (kind === "document" && !documentId.trim()) { setError(new Error("Enter the company document ID.")); return; }
    setSaving(true); setError(undefined);
    try {
      await save("review_case.add_evidence", { caseId: detail.id, evidence: {
        kind, reference: reference.trim(), summary: summary.trim(), ...(observedOn ? { observedOn } : {}), ...(kind === "document" ? { documentId: documentId.trim() } : {}),
      } });
      onSaved();
    } catch (saveError) { setError(saveError); } finally { setSaving(false); }
  };
  return <Dialog title="Add Evidence" subtitle={detail.shortLabel} onClose={onClose} onSubmit={submit} saving={saving} submitLabel="Add Evidence">
    <Notice error={error} />
    <div className="rm-form-grid">
      <Field label="Type">
        <select data-autofocus value={kind} onChange={event => setKind(event.currentTarget.value as typeof kind)}>
          <option value="email">Email</option><option value="document">Company document</option><option value="source_record">Source record</option><option value="observation">Observation</option><option value="note">Note</option>
        </select>
      </Field>
      <Field label="Dated"><input type="date" value={observedOn} onChange={event => setObservedOn(event.currentTarget.value)} /></Field>
      {kind === "document" && <Field label="Document ID" wide><input value={documentId} maxLength={240} onChange={event => setDocumentId(event.currentTarget.value)} /></Field>}
      <Field label="Where it is" wide><input value={reference} maxLength={400} onChange={event => setReference(event.currentTarget.value)} placeholder="PM email, Sep 20" /></Field>
      <Field label="What it shows" wide><textarea rows={3} maxLength={1000} value={summary} onChange={event => setSummary(event.currentTarget.value)} /></Field>
    </div>
  </Dialog>;
}

function ProposeDialog({ detail, onClose, onSaved, save }: { detail: ReviewCaseDetail; onClose: () => void; onSaved: () => void; save: Save }) {
  const defaultKind = detail.resolution === "connection" ? "connection" : detail.resolution === "financial" ? "financial" : "operational";
  const [kind, setKind] = useState<"operational" | "financial" | "connection">(defaultKind);
  const [summary, setSummary] = useState("");
  const [route, setRoute] = useState<(typeof REVIEW_ACCOUNTING_ROUTES)[number]>("accounting.journal_entry");
  const [amount, setAmount] = useState("");
  const [action, setAction] = useState("");
  const [operation, setOperation] = useState("");
  const [evidenceDocumentId, setEvidenceDocumentId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!summary.trim()) { setError(new Error("Describe the fix.")); return; }
    let correction: Record<string, unknown>;
    try {
      if (kind === "financial") {
        correction = { kind, summary: summary.trim(), route, amountCents: amount.trim() ? parseMoneyInput(amount, "Amount").cents : null };
      } else if (kind === "connection") {
        if (!action.trim()) throw new Error("Describe the connection or software change.");
        correction = { kind, summary: summary.trim(), action: action.trim() };
      } else {
        if (!evidenceDocumentId.trim()) throw new Error("Enter the verified company document that supports this fix.");
        let parsed: unknown;
        try { parsed = JSON.parse(operation); } catch { throw new Error("The guarded operation must be valid JSON."); }
        correction = { kind, summary: summary.trim(), operation: parsed, evidenceDocumentId: evidenceDocumentId.trim() };
      }
    } catch (parseError) { setError(parseError); return; }
    setSaving(true); setError(undefined);
    try { await save("review_case.propose", { caseId: detail.id, correction }, detail.recordRevision); onSaved(); }
    catch (saveError) { setError(saveError); } finally { setSaving(false); }
  };
  return <Dialog title="Propose Fix" subtitle={detail.shortLabel} onClose={onClose} onSubmit={submit} saving={saving} submitLabel="Propose Fix">
    <Notice error={error} />
    <fieldset className="rc-choice-group">
      <legend className="rm-field-label">Kind of fix</legend>
      <div className="rc-choices">
        {(["operational", "financial", "connection"] as const).map(value => <label key={value} className={`rc-choice${kind === value ? " is-selected" : ""}`}>
          <input type="radio" name="rc-kind" value={value} checked={kind === value} onChange={() => setKind(value)} />
          <span>{value === "operational" ? "Record correction" : value === "financial" ? "Accounting entry" : "Connection"}</span>
        </label>)}
      </div>
    </fieldset>
    <div className="rm-form-grid">
      <Field label="Fix" wide><textarea data-autofocus rows={2} maxLength={1000} value={summary} onChange={event => setSummary(event.currentTarget.value)} /></Field>
      {kind === "financial" && <>
        <Field label="Accounting workflow">
          <select value={route} onChange={event => setRoute(event.currentTarget.value as typeof route)}>
            <option value="accounting.journal_entry">Journal entry</option><option value="accounting.receipt_allocation">Receipt allocation</option>
            <option value="accounting.qbo_correction">QuickBooks correction</option><option value="accounting.pm_settlement">PM settlement</option>
          </select>
        </Field>
        <Field label="Amount" help="Leave blank if unknown"><input inputMode="decimal" value={amount} onChange={event => setAmount(event.currentTarget.value)} /></Field>
        <p className="rc-dialog-note rm-field--wide">Accounting entries are posted in Accounting. Applying this case routes the fix there; nothing is posted here.</p>
      </>}
      {kind === "connection" && <Field label="Change needed" wide><textarea rows={2} maxLength={1000} value={action} onChange={event => setAction(event.currentTarget.value)} /></Field>}
      {kind === "operational" && <>
        <Field label="Evidence document ID" wide><input value={evidenceDocumentId} maxLength={240} onChange={event => setEvidenceDocumentId(event.currentTarget.value)} /></Field>
        <Field label="Guarded operation" wide help="Checked with a dry run when proposed. Nothing changes until applied.">
          <textarea className="rc-code" rows={6} spellCheck={false} value={operation} onChange={event => setOperation(event.currentTarget.value)} />
        </Field>
      </>}
    </div>
  </Dialog>;
}

function ConfirmDialog({ detail, command, onClose, onSaved, save }: { detail: ReviewCaseDetail; command: "review_case.apply" | "review_case.verify"; onClose: () => void; onSaved: (message?: string) => void; save: Save }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const input = detail.proposedCorrection?.input;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true); setError(undefined);
    try { await save(command, { caseId: detail.id }, detail.recordRevision); onSaved(); }
    catch (saveError) { setError(saveError); } finally { setSaving(false); }
  };
  const body = command === "review_case.verify"
    ? "Detection runs again against saved records. The case is verified only if the cause is gone."
    : input?.kind === "financial" ? "This routes the fix to Accounting. The case stays proposed until the accounting fix is verified."
      : `This applies the checked fix${detail.proposedCorrection?.preview ? ` to ${detail.proposedCorrection.preview.changes.length} record${detail.proposedCorrection.preview.changes.length === 1 ? "" : "s"}` : ""}. If the records changed since it was proposed, nothing is applied.`;
  return <Dialog title={command === "review_case.verify" ? "Verify Case" : input?.kind === "financial" ? "Route to Accounting" : "Apply Fix"} subtitle={detail.shortLabel} onClose={onClose} onSubmit={submit} saving={saving} submitLabel={command === "review_case.verify" ? "Verify" : input?.kind === "financial" ? "Route" : "Apply Fix"}>
    <Notice error={error} />
    <p className="rc-dialog-note">{body}</p>
  </Dialog>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="rc-fact"><dt>{label}</dt><dd>{children}</dd></div>;
}

function AffectedRecord({ record }: { record: ReviewCaseDetail["affectedRecords"][number] }) {
  const target = recordLinkTarget(record);
  const label = recordLabel(record);
  if (target.kind === "tenant") return <EntityLink personId={target.id} className="rc-link">{label}</EntityLink>;
  if (target.kind === "unit" || target.kind === "property") return <RecordLink kind={target.kind} recordId={target.id} className="rc-link">{label}</RecordLink>;
  return <span>{label}</span>;
}

function Detail({ detail, onDialog, onBack }: { detail: ReviewCaseDetail; onDialog: (state: DialogState) => void; onBack: () => void }) {
  const headingId = `rc-title-${detail.id}`;
  const primary = primaryCommand(detail.state, detail.allowedCommands);
  const proposal = detail.proposedCorrection;
  const open = (command: ReviewCaseCommandKind) => {
    if (command === "review_case.add_evidence") onDialog({ kind: "evidence" });
    else if (command === "review_case.propose") onDialog({ kind: "propose" });
    else if (command === "review_case.apply" || command === "review_case.verify") onDialog({ kind: "confirm", command });
    else if (command !== "review_case.detect") onDialog({ kind: "text", command });
  };
  const secondary = detail.allowedCommands.filter(command => command !== primary && command !== "review_case.detect");
  const history = [...detail.history].reverse();
  const [showAllRecords, setShowAllRecords] = useState(false);
  const records = showAllRecords ? detail.affectedRecords : detail.affectedRecords.slice(0, 12);
  return <article className="rc-detail" aria-labelledby={headingId}>
    <button type="button" className="rm-button rm-button--ghost rc-back" onClick={onBack}><ChevronLeft size={16} />Review queue</button>
    <header className="rc-detail-header">
      <div className="rc-detail-heading">
        <span className="rc-overline">{familyLabel(detail.causeFamily)}</span>
        <h2 id={headingId}>{detail.shortLabel}</h2>
        <div className="rc-badges"><span className={stateClass(detail.state)}>{stateLabel(detail.state)}</span><span className={materialityClass(detail.materiality)}>{materialityLabel(detail.materiality)}</span></div>
        {detail.scopeLabel && <p className="rc-scope">{detail.scopeLabel}</p>}
      </div>
      <div className="rc-actions" role="group" aria-label="Case actions">
        {primary && <button type="button" className="rm-button rm-button-primary" onClick={() => open(primary)}>{proposal?.input.kind === "financial" && primary === "review_case.apply" ? "Route to Accounting" : COMMAND_LABELS[primary]}</button>}
        {secondary.map(command => <button key={command} type="button" className="rm-button" onClick={() => open(command)}>{COMMAND_LABELS[command]}</button>)}
      </div>
    </header>
    <section className="rc-section" aria-label="Summary">
      <dl className="rc-facts">
        <Fact label="Impact"><span className={detail.impactCents === null ? "rc-unknown" : "rc-amount"}>{formatImpact(detail.impactCents, detail.impactCurrency)}</span></Fact>
        <Fact label="Affected">{detail.affectedCount} record{detail.affectedCount === 1 ? "" : "s"}</Fact>
        <Fact label="Open for">{ageLabel(detail.firstDetectedAt)}</Fact>
        <Fact label="Next step">{detail.nextAction}</Fact>
        {detail.blockedOn && <Fact label="Waiting on">{detail.blockedOn}</Fact>}
        {detail.reopenedCount > 0 && <Fact label="Reopened">{detail.reopenedCount} time{detail.reopenedCount === 1 ? "" : "s"}</Fact>}
      </dl>
    </section>
    <section className="rc-section" aria-labelledby={`${headingId}-fix`}>
      <h3 id={`${headingId}-fix`}>Proposed fix</h3>
      {proposal ? <div className="rc-proposal">
        <p>{proposal.input.summary}</p>
        <span className="rc-muted">{proposal.input.kind === "financial" ? `Accounting entry${proposal.input.amountCents ? ` · ${formatImpact(proposal.input.amountCents, proposal.input.currency)}` : " · amount unknown"}` : proposal.input.kind === "connection" ? `Connection · ${proposal.input.action}` : `Record correction · ${proposal.preview?.changes.length ?? 0} record${proposal.preview?.changes.length === 1 ? "" : "s"} checked by dry run`}</span>
        {proposal.routing && <span className="rm-status rm-status--warning">Routed to Accounting</span>}
      </div> : <p className="rc-muted rc-empty-line">No fix proposed yet.</p>}
    </section>
    <section className="rc-section" aria-labelledby={`${headingId}-resolve`}>
      <h3 id={`${headingId}-resolve`}>Resolve</h3>
      <p className="rc-guidance">{detail.researchGuidance}</p>
      <p className="rc-guidance"><strong>Verified when:</strong> {detail.requiredVerification}</p>
    </section>
    <section className="rc-section" aria-labelledby={`${headingId}-evidence`}>
      <div className="rc-section-heading"><h3 id={`${headingId}-evidence`}>Evidence</h3><span className="rc-muted">{detail.evidence.length}</span></div>
      {detail.evidence.length ? <ul className="rc-evidence">{detail.evidence.map(item => <li key={item.id}>
        <span className="rc-evidence-kind">{evidenceKindLabel(item)}</span>
        <div><strong>{item.origin === "detector" ? item.summary : item.reference}</strong>{item.origin !== "detector" && <p>{item.summary}</p>}<small>{[item.observedOn, item.count !== null && item.origin === "detector" ? `${item.count} record${item.count === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ")}</small></div>
      </li>)}</ul> : <p className="rc-muted rc-empty-line">No evidence yet.</p>}
    </section>
    <section className="rc-section" aria-labelledby={`${headingId}-records`}>
      <div className="rc-section-heading"><h3 id={`${headingId}-records`}>Affected records</h3><span className="rc-muted">{detail.affectedCount}</span></div>
      <ul className="rc-records">{records.map(record => <li key={`${record.kind}:${record.id}`}><AffectedRecord record={record} /></li>)}</ul>
      {detail.affectedRecords.length > 12 && <button type="button" className="rm-button rm-button--small rm-button--ghost" onClick={() => setShowAllRecords(value => !value)}>{showAllRecords ? "Show Fewer" : `Show All ${detail.affectedRecords.length}`}</button>}
      {detail.affectedRecordsTruncated && <p className="rc-muted rc-empty-line">Showing the first {detail.affectedRecords.length} of {detail.affectedCount}.</p>}
    </section>
    <section className="rc-section" aria-labelledby={`${headingId}-history`}>
      <div className="rc-section-heading"><h3 id={`${headingId}-history`}>History</h3></div>
      <ol className="rc-timeline">
        {history.map(event => <li key={event.id} className={`rc-event rc-event--${event.kind}`}>
          <span className="rc-event-dot" aria-hidden="true" />
          <div className="rc-event-body">
            <span className="rc-event-summary">{eventLabel(event.kind, event.toState, event.detail)}</span>
            {typeof event.detail.note === "string" && <p className="rc-event-note">{event.detail.note}</p>}
            {typeof event.detail.reason === "string" && event.kind === "reopened" && <p className="rc-event-note">{event.detail.reason}</p>}
            {typeof event.detail.missingFact === "string" && <p className="rc-event-note">Waiting on: {event.detail.missingFact}</p>}
            <span className="rc-event-meta">{new Date(event.occurredAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })} · {event.actorId}</span>
          </div>
        </li>)}
      </ol>
    </section>
    <details className="rc-technical">
      <summary>Record details</summary>
      <dl className="rc-facts">
        <Fact label="Case ID"><code>{detail.id}</code></Fact>
        <Fact label="Source fingerprint"><code>{detail.sourceFingerprint.slice(0, 16)}…</code></Fact>
        <Fact label="Scope key"><code>{detail.scopeKey}</code></Fact>
        <Fact label="Revision">{detail.recordRevision}</Fact>
      </dl>
    </details>
  </article>;
}

function QueueRow({ item, active, onSelect }: { item: ReviewCaseSummary; active: boolean; onSelect: () => void }) {
  return <button type="button" className={`rm-record-list-item rc-row${active ? " active" : ""}`} aria-current={active ? "true" : undefined} onClick={onSelect}>
    <span className="rc-row-top"><strong className="rm-record-list-item-title">{item.shortLabel}</strong><span className={item.impactCents === null ? "rc-row-impact rc-unknown" : "rc-row-impact"}>{formatImpact(item.impactCents, item.impactCurrency)}</span></span>
    <span className="rm-record-list-item-meta">{item.scopeLabel ?? "All properties"}</span>
    <span className="rc-row-foot"><span className={stateClass(item.state)}>{stateLabel(item.state)}</span><small>{item.affectedCount} record{item.affectedCount === 1 ? "" : "s"} · {ageLabel(item.firstDetectedAt)}</small></span>
  </button>;
}

function ReviewQueue({ organizationId, legalEntityId, propertyId, api }: { organizationId: string; legalEntityId?: string; propertyId?: string; api: ReviewCasesApi }) {
  const client = useQueryClient();
  const [view, setView] = useState<View>("active");
  const [materiality, setMateriality] = useState<ReviewMateriality | "">("");
  const [family, setFamily] = useState<ReviewCauseFamily | "">("");
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [actionError, setActionError] = useState<unknown>();
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const pending = useRef(new PendingEnvelopes<ReviewCaseCommandEnvelope>());
  const filters = useMemo(() => ({
    ...(legalEntityId ? { legalEntityId, ...(propertyId ? { propertyId } : {}) } : {}),
    ...(VIEW_STATES[view] ? { states: VIEW_STATES[view] } : {}),
    ...(materiality ? { materialities: [materiality] } : {}),
    ...(family ? { families: [family] } : {}),
  }), [family, legalEntityId, materiality, propertyId, view]);
  const list = useQuery({
    queryKey: ["review-cases", "list", organizationId, filters],
    queryFn: ({ signal }) => api.list(organizationId, filters, signal),
    staleTime: 10_000, retry: false, placeholderData: previous => previous,
  });
  const items = list.data?.items ?? [];
  const groups = useMemo(() => groupQueue(items, list.data?.groups), [items, list.data?.groups]);
  useEffect(() => {
    if (!selectedId && !list.isPlaceholderData && items[0] && window.matchMedia?.("(min-width: 901px)").matches) setSelectedId(items[0].id);
  }, [items, list.isPlaceholderData, selectedId]);
  const detail = useQuery({
    queryKey: ["review-cases", "detail", organizationId, selectedId],
    queryFn: ({ signal }) => api.get(organizationId, selectedId!, signal, items.find(item => item.id === selectedId)),
    enabled: Boolean(selectedId), retry: false,
  });
  const refresh = useCallback(async () => {
    await client.invalidateQueries({ queryKey: ["review-cases", "list", organizationId] });
    if (selectedId) await client.invalidateQueries({ queryKey: ["review-cases", "detail", organizationId, selectedId] });
  }, [client, organizationId, selectedId]);
  const save: Save = useCallback(async (kind, payload, expectedRevision) => {
    const key = PendingEnvelopes.key(kind, payload, expectedRevision);
    // Address the case at its own entity/property so scoped users stay within their grant.
    const caseId = typeof payload.caseId === "string" ? payload.caseId : undefined;
    const target = caseId ? (detail.data?.id === caseId ? detail.data : items.find(item => item.id === caseId)) : undefined;
    const envelope = pending.current.envelopeFor(key, () => reviewCaseEnvelope(organizationId, payload, expectedRevision, target));
    try {
      const receipt = await api.command(organizationId, kind, envelope);
      pending.current.settle(key);
      const warning = receipt.validationOutcomes.find(outcome => outcome.severity === "warning");
      setNotice(warning?.message);
    } catch (error) {
      if (!(error instanceof ReviewCaseApiError && error.uncertain)) pending.current.settle(key);
      if (error instanceof ReviewCaseApiError && error.conflict) void refresh();
      throw error;
    }
  }, [api, detail.data, items, organizationId, refresh]);
  const checkAgain = async () => {
    setChecking(true); setActionError(undefined); setNotice(undefined);
    try { await save("review_case.detect", {}); await refresh(); }
    catch (error) { setActionError(error); } finally { setChecking(false); }
  };
  const closeDialog = useCallback(() => setDialog(null), []);
  const afterSave = useCallback(() => { setDialog(null); void refresh(); }, [refresh]);
  const current = detail.data && detail.data.id === selectedId ? detail.data : undefined;
  const total = list.data?.totals;
  const impact = impactTotal(items);
  return <div className="rc-workspace">
    <header className="rc-page-header">
      <div>
        <h1>Review queue</h1>
        <p className="rc-subtitle" aria-live="polite">{list.isLoading ? "Loading…" : total ? `${total.caseCount} case${total.caseCount === 1 ? "" : "s"} · ${total.affectedCount} affected record${total.affectedCount === 1 ? "" : "s"}${items.length ? ` · impact ${impact.label}` : ""}` : ""}</p>
      </div>
      <button type="button" className="rm-button" onClick={() => void checkAgain()} disabled={checking}>{checking ? <LoaderCircle size={15} className="rc-spin" /> : <RefreshCw size={15} />}Check Again</button>
    </header>
    <div className="rc-filters">
      <div className="rc-chips" role="group" aria-label="State">
        {(Object.keys(VIEW_LABELS) as View[]).map(item => <button key={item} type="button" aria-pressed={view === item} className={`rc-chip${view === item ? " is-selected" : ""}`} onClick={() => { setView(item); setSelectedId(undefined); }}>{VIEW_LABELS[item]}</button>)}
      </div>
      <div className="rc-filter-row">
        <label className="rc-select"><span className="rc-sr-only">Materiality</span>
          <select aria-label="Materiality" value={materiality} onChange={event => setMateriality(event.currentTarget.value as ReviewMateriality | "")}>
            <option value="">All materiality</option>{REVIEW_MATERIALITIES.map(value => <option key={value} value={value}>{materialityLabel(value)}</option>)}
          </select>
        </label>
        <label className="rc-select"><span className="rc-sr-only">Cause</span>
          <select aria-label="Cause" value={family} onChange={event => setFamily(event.currentTarget.value as ReviewCauseFamily | "")}>
            <option value="">All causes</option>{REVIEW_CAUSE_FAMILIES.map(value => <option key={value} value={value}>{familyLabel(value)}</option>)}
          </select>
        </label>
      </div>
    </div>
    <Notice error={actionError} />
    {notice && <div className="rc-notice" role="status"><span>{notice}</span><button type="button" className="rm-button rm-button--small rm-button--ghost" aria-label="Dismiss" onClick={() => setNotice(undefined)}><X size={14} /></button></div>}
    <div className={`rm-record-layout rc-layout${selectedId ? " is-detail" : ""}`}>
      <section className="rm-record-list rc-list" aria-label="Review cases">
        {list.error ? <Notice error={list.error} onRetry={() => void list.refetch()} />
          : list.isLoading ? <div className="rc-state" role="status"><LoaderCircle size={16} className="rc-spin" /><p>Loading cases…</p></div>
          : !items.length ? <div className="rc-state"><ClipboardCheck size={28} aria-hidden="true" /><h3>{view === "active" ? "Nothing to Review" : "No Cases"}</h3><p>{view === "active" ? "No open causes were detected in this scope." : "Nothing matches these filters."}</p>{view === "active" && <button type="button" className="rm-button" onClick={() => void checkAgain()} disabled={checking}>Check Again</button>}</div>
          : <div className="rc-groups">{groups.map(group => <div key={group.key} className="rc-group">
            <div className="rc-group-heading"><span className={materialityClass(group.materiality)}>{materialityLabel(group.materiality)}</span><strong>{familyLabel(group.family)}</strong><small>{group.caseCount} case{group.caseCount === 1 ? "" : "s"} · {group.affectedCount} record{group.affectedCount === 1 ? "" : "s"}</small></div>
            {group.items.map(item => <QueueRow key={item.id} item={item} active={item.id === selectedId} onSelect={() => setSelectedId(item.id)} />)}
          </div>)}{list.data?.nextCursor && <p className="rc-muted rc-more">Showing the first {items.length}. Narrow the filters to see more.</p>}</div>}
      </section>
      <div className="rm-record-detail rc-detail-pane">
        {!selectedId ? <div className="rc-state rc-detail-empty"><ClipboardCheck size={28} aria-hidden="true" /><h3>Select a Case</h3><p>Open a case to see its impact, evidence and fix.</p></div>
          : detail.error ? <Notice error={detail.error} onRetry={() => void detail.refetch()} />
          : !current ? <div className="rc-state" role="status"><LoaderCircle size={16} className="rc-spin" /><p>Loading case…</p></div>
          : <Detail key={current.id} detail={current} onDialog={setDialog} onBack={() => setSelectedId(undefined)} />}
      </div>
    </div>
    {dialog?.kind === "text" && current && <TextDialog detail={current} command={dialog.command} onClose={closeDialog} onSaved={afterSave} save={save} />}
    {dialog?.kind === "evidence" && current && <EvidenceDialog detail={current} onClose={closeDialog} onSaved={afterSave} save={save} />}
    {dialog?.kind === "propose" && current && <ProposeDialog detail={current} onClose={closeDialog} onSaved={afterSave} save={save} />}
    {dialog?.kind === "confirm" && current && <ConfirmDialog detail={current} command={dialog.command} onClose={closeDialog} onSaved={afterSave} save={save} />}
  </div>;
}

/**
 * Single action queue for evidence-backed review cases. Without an
 * organization it resolves the signed-in manager's company; a property filter
 * resolves its legal entity from the same authorized context.
 */
export function ReviewQueueWorkspace({ organizationId, propertyId, api = reviewCasesApi }: ReviewQueueWorkspaceProps) {
  const context = useCompanyContext();
  const organization = context.data?.organizations.find(item => item.id === organizationId);
  if (organizationId && (!propertyId || organization)) {
    const legalEntityId = entityForProperty(organization, propertyId);
    return <ReviewQueue key={`${organizationId}:${propertyId ?? ""}`} organizationId={organizationId} legalEntityId={legalEntityId} propertyId={legalEntityId ? propertyId ?? undefined : undefined} api={api} />;
  }
  return <CompanyGate organizationId={organizationId} loadingLabel="Loading review cases…">
    {selected => {
      const legalEntityId = entityForProperty(selected, propertyId);
      return <ReviewQueue key={`${selected.id}:${propertyId ?? ""}`} organizationId={selected.id} legalEntityId={legalEntityId} propertyId={legalEntityId ? propertyId ?? undefined : undefined} api={api} />;
    }}
  </CompanyGate>;
}

export default ReviewQueueWorkspace;
