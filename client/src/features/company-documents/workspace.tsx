import { useCallback, useEffect, useState } from "react";
import { CircleAlert, Download, FileText, Pencil, RefreshCw, Upload, X } from "lucide-react";
import { COMPANY_DOCUMENT_KINDS, type CompanyDocument, type CompanyDocumentKind } from "@shared/company-documents";
import { companyDocumentsApi, documentScope } from "./api";
import type { CompanyDocumentLinkOption, CompanyDocumentsWorkspaceProps } from "./types";
import "./company-documents.css";

function label(value: string): string { return value.replace(/_/g, " ").replace(/\b\w/g, letter => letter.toUpperCase()); }
function dateLabel(value: string | null): string { if (!value) return "—"; const date = new Date(`${value.slice(0, 10)}T00:00:00Z`); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(date); }
function linkKey(link: Pick<CompanyDocumentLinkOption, "kind" | "id" | "versionId">): string { return `${link.kind}:${link.id}:${link.versionId ?? ""}`; }

function Message({ error, onRetry }: { readonly error: unknown; readonly onRetry?: () => void }) { if (!error) return null; return <div className="company-documents-message is-error" role="alert"><CircleAlert size={16} /><span>{error instanceof Error ? error.message : "Company documents could not be loaded."}</span>{onRetry && <button type="button" onClick={onRetry}>Try again</button>}</div>; }

function LinkPicker({ options, value, onChange }: { readonly options: readonly CompanyDocumentLinkOption[]; readonly value: string; readonly onChange: (value: string) => void }) {
  if (!options.length) return <p className="company-documents-note">No records to link in this scope.</p>;
  return <label className="company-documents-field"><span>Link to a company record</span><select data-testid="company-document-link" value={value} onChange={event => onChange(event.currentTarget.value)}><option value="">No additional link</option>{options.map(option => <option key={linkKey(option)} value={linkKey(option)}>{option.label}</option>)}</select></label>;
}

export function CompanyDocumentsWorkspace({ organizationId, organizationName, legalEntityId, propertyId, projectId, investorContractId, investorContractVersionId, linkOptions = [], api = companyDocumentsApi }: CompanyDocumentsWorkspaceProps) {
  const [documents, setDocuments] = useState<readonly CompanyDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [saveError, setSaveError] = useState<unknown>();
  const [kind, setKind] = useState<CompanyDocumentKind>("contract");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [documentDate, setDocumentDate] = useState("");
  const [tags, setTags] = useState("");
  const [link, setLink] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<CompanyDocument | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editTags, setEditTags] = useState("");

  const reload = useCallback(async () => {
    setLoading(true); setError(undefined);
    try { const page = await api.list(organizationId, { legalEntityId, propertyId, projectId, investorContractId }); setDocuments(page.items); }
    catch (nextError) { setError(nextError); }
    finally { setLoading(false); }
  }, [api, investorContractId, legalEntityId, organizationId, projectId, propertyId]);
  useEffect(() => { void reload(); }, [reload]);
  const selectedLink = linkOptions.find(option => linkKey(option) === link);

  async function upload() {
    if (!file || !title.trim()) { setSaveError(new Error("Choose a file and enter a title.")); return; }
    setSaving(true); setSaveError(undefined);
    try {
      await api.upload(organizationId, { kind, title: title.trim(), description: description.trim() || null, documentDate: documentDate || null, tags: tags.split(",").map(value => value.trim()).filter(Boolean), links: selectedLink ? [selectedLink] : [], context: { legalEntityId, propertyId, projectId, investorContractId, investorContractVersionId }, file });
      setTitle(""); setDescription(""); setDocumentDate(""); setTags(""); setLink(""); setFile(null); const input = document.querySelector<HTMLInputElement>("[data-testid='company-document-file']"); if (input) input.value = ""; await reload();
    } catch (nextError) { setSaveError(nextError); }
    finally { setSaving(false); }
  }

  function beginEdit(document: CompanyDocument) { setEditing(document); setEditTitle(document.title); setEditDescription(document.description ?? ""); setEditTags(document.tags.join(", ")); setSaveError(undefined); }
  async function saveEdit() {
    if (!editing || !editTitle.trim()) { setSaveError(new Error("Enter a document title.")); return; }
    setSaving(true); setSaveError(undefined);
    try { await api.updateMetadata(organizationId, { documentId: String(editing.id), scope: documentScope(editing), expectedRevision: editing.recordRevision, title: editTitle.trim(), description: editDescription.trim() || null, tags: editTags.split(",").map(value => value.trim()).filter(Boolean) }); setEditing(null); await reload(); }
    catch (nextError) { setSaveError(nextError); }
    finally { setSaving(false); }
  }

  async function archive(document: CompanyDocument) {
    if (!window.confirm(`Archive “${document.title}”? The verified file is kept.`)) return;
    setSaveError(undefined);
    try { await api.archive(organizationId, document); setEditing(null); await reload(); }
    catch (nextError) { setSaveError(nextError); }
  }

  async function download(document: CompanyDocument) {
    setSaveError(undefined);
    try { const blob = await api.download(organizationId, String(document.id), undefined, documentScope(document)); const url = URL.createObjectURL(blob); const anchor = window.document.createElement("a"); anchor.href = url; anchor.download = document.source.fileName; anchor.click(); URL.revokeObjectURL(url); }
    catch (nextError) { setSaveError(nextError); }
  }

  return <div className="company-documents-workspace" data-testid="company-documents"><header className="company-documents-toolbar"><div><h1>Documents</h1>{organizationName && <p>{organizationName}</p>}</div><button type="button" className="company-documents-button" onClick={() => void reload()} disabled={loading}><RefreshCw size={14} />{loading ? "Refreshing…" : "Refresh"}</button></header>
    <Message error={error} onRetry={() => void reload()} /><Message error={saveError} />
    <div className="company-documents-layout"><section className="company-documents-card"><div className="company-documents-card-heading"><h2>Upload</h2></div><div className="company-documents-form"><label className="company-documents-field"><span>Title</span><input data-testid="company-document-title" value={title} onChange={event => setTitle(event.currentTarget.value)} placeholder="Operating agreement or invoice" /></label><label className="company-documents-field"><span>Type</span><select data-testid="company-document-kind" value={kind} onChange={event => setKind(event.currentTarget.value as CompanyDocumentKind)}>{COMPANY_DOCUMENT_KINDS.map(value => <option key={value} value={value}>{label(value)}</option>)}</select></label><label className="company-documents-field"><span>Description</span><textarea value={description} onChange={event => setDescription(event.currentTarget.value)} rows={3} placeholder="Optional context" /></label><label className="company-documents-field"><span>Document date</span><input type="date" value={documentDate} onChange={event => setDocumentDate(event.currentTarget.value)} /></label><label className="company-documents-field"><span>Tags</span><input value={tags} onChange={event => setTags(event.currentTarget.value)} placeholder="loan, 2026" /></label><LinkPicker options={linkOptions} value={link} onChange={setLink} /><label className="company-documents-field"><span>File</span><input data-testid="company-document-file" type="file" onChange={event => setFile(event.currentTarget.files?.[0] ?? null)} /></label><button type="button" className="company-documents-button is-primary" data-testid="company-document-upload" onClick={() => void upload()} disabled={saving}>{saving ? "Saving…" : <><Upload size={14} />Upload</>}</button></div></section>
      <section className="company-documents-card"><div className="company-documents-card-heading"><h2>Files</h2><span>{documents.length}</span></div>{!loading && !documents.length ? <div className="company-documents-empty"><FileText size={22} aria-hidden="true" /><h3>No Documents</h3><span>Upload a contract, loan, insurance or project file.</span></div> : <div className="company-documents-list">{documents.map(document => <article className="company-documents-row" key={String(document.id)}><div><strong>{document.title}</strong><small>{label(document.kind)} · {document.source.fileName} · {dateLabel(document.documentDate)}</small>{document.description && <p>{document.description}</p>}</div><div className="company-documents-row-actions"><button type="button" aria-label={`Download ${document.title}`} onClick={() => void download(document)}><Download size={14} /></button><button type="button" aria-label={`Edit ${document.title}`} onClick={() => beginEdit(document)}><Pencil size={14} /></button></div></article>)}</div>}</section></div>
    {editing && <div className="company-documents-dialog-backdrop"><section className="company-documents-dialog" role="dialog" aria-modal="true" aria-labelledby="company-document-edit-title"><header><div><span className="company-documents-eyebrow">Document details</span><h2 id="company-document-edit-title">Edit metadata</h2></div><button type="button" aria-label="Close" onClick={() => setEditing(null)}><X size={16} /></button></header><div className="company-documents-form"><label className="company-documents-field"><span>Title</span><input value={editTitle} onChange={event => setEditTitle(event.currentTarget.value)} /></label><label className="company-documents-field"><span>Description</span><textarea value={editDescription} onChange={event => setEditDescription(event.currentTarget.value)} rows={3} /></label><label className="company-documents-field"><span>Tags</span><input value={editTags} onChange={event => setEditTags(event.currentTarget.value)} /></label><dl className="company-documents-source"><div><dt>File</dt><dd>{editing.source.fileName}</dd></div><div><dt>SHA-256</dt><dd><code>{editing.source.checksumSha256}</code></dd></div></dl><div className="company-documents-dialog-actions"><button type="button" className="company-documents-button" onClick={() => void archive(editing)} disabled={saving}>Archive</button><button type="button" className="company-documents-button" onClick={() => setEditing(null)} disabled={saving}>Cancel</button><button type="button" className="company-documents-button is-primary" data-testid="company-document-save" onClick={() => void saveEdit()} disabled={saving}>{saving ? "Saving…" : "Save changes"}</button></div></div></section></div>}
  </div>;
}

export default CompanyDocumentsWorkspace;
