import {EntityLink} from "./workspace/entity-link";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AlertCircle, Download, FileCheck2, FileText, Loader2, Users, X } from "lucide-react";

import { downloadRentOpsDocument, loadRentOpsApplication } from "./api";
import {
  applicationCaseDisplayName,
  applicationCaseFact,
  applicationCaseSectionState,
  applicationHistorySectionState,
  applicationDocumentDownloadable,
  restoreApplicationCaseFocus,
} from "./application-case-detail-model";
import type {
  AdminApplicationDetailView,
  AdminApplicationHistoryCaseView,
  AdminApplicationView,
  AdminDocumentView,
} from "./types";
import "./application-case-detail.css";

interface ApplicationCaseDetailProps {
  applicationId: string;
  tenantPersonId?:string;
  summary?: AdminApplicationView;
  onClose: () => void;
}

type DetailLoadState = "loading" | "ready" | "error";

function title(value: unknown): string {
  return String(value ?? "Unknown").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function moneyFact(value: unknown, knowledge?: string): string {
  const fact = applicationCaseFact(value, knowledge);
  if (fact === "Unknown" || fact === "Needs review") return fact;
  const cents = Number(value);
  return Number.isFinite(cents)
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
    : "Unknown";
}

function dateFact(value: unknown, knowledge?: string): string {
  const fact = applicationCaseFact(value, knowledge);
  if (fact === "Unknown" || fact === "Needs review") return fact;
  return fact;
}

function Fact({ label, value, knowledge, className = "" }: { label: string; value: unknown; knowledge?: string; className?: string }) {
  return <div className={`ro-case-fact ${className}`}><dt>{label}</dt><dd>{applicationCaseFact(value, knowledge)}</dd></div>;
}

function MoneyFact({ label, value, knowledge }: { label: string; value: unknown; knowledge?: string }) {
  return <div className="ro-case-fact"><dt>{label}</dt><dd>{moneyFact(value, knowledge)}</dd></div>;
}

function DateFact({ label, value, knowledge }: { label: string; value: unknown; knowledge?: string }) {
  return <div className="ro-case-fact"><dt>{label}</dt><dd>{dateFact(value, knowledge)}</dd></div>;
}

function SectionHeading({ id, title: sectionTitle }: { id: string; title: string }) {
  return <header className="ro-case-section-heading"><div><h3 id={id}>{sectionTitle}</h3></div></header>;
}

function EmptySection({ message }: { message: string }) {
  return <div className="ro-case-empty"><FileText aria-hidden="true" /><p>{message}</p></div>;
}

function OverviewSection({ application }: { application: AdminApplicationDetailView }) {
  const preferences = application.preferences;
  const householdSummary = application.householdSummary;
  const employment = application.employment;
  const voucher = application.voucher;
  const rentalHistory = application.rentalHistory;
  const emergencyContact = application.emergencyContact;
  return <section className="ro-case-section" aria-labelledby="application-case-overview">
    <SectionHeading id="application-case-overview" title="Overview" />
    <dl className="ro-case-facts">
      <Fact label="Email" value={application.email} knowledge={application.emailKnowledge} />
      <Fact label="Phone" value={application.phone} knowledge={application.phoneKnowledge} />
      <DateFact label="Submitted" value={application.submittedOn} knowledge={application.submittedOnKnowledge} />
      <DateFact label="Certification accepted" value={application.certificationAcceptedOn} knowledge={application.certificationAcceptedOnKnowledge} />
      <DateFact label="Desired move-in" value={preferences?.desiredMoveInOn} />
      <Fact label="Lease length" value={preferences?.desiredLeaseMonths === undefined ? undefined : `${preferences.desiredLeaseMonths} months`} />
      <MoneyFact label="Maximum rent" value={preferences?.maxRentCents} />
      <Fact label="Bedrooms requested" value={preferences?.bedrooms} />
      <Fact label="Adults" value={householdSummary?.adults} />
      <Fact label="Children" value={householdSummary?.children} />
      <Fact label="Total occupants" value={householdSummary?.totalOccupants} />
      <Fact label="Voucher reported" value={voucher?.hasVoucher} />
      <Fact label="Housing agency" value={voucher?.agencyName} />
      <MoneyFact label="Tenant portion" value={voucher?.tenantPortionCents} />
    </dl>

    <div className="ro-case-subsection">
      <h4>Employment</h4>
      <dl className="ro-case-facts">
        <Fact label="Employer" value={employment?.employerName} />
        <Fact label="Job title" value={employment?.jobTitle} />
        <MoneyFact label="Monthly income" value={employment?.monthlyIncomeCents} />
        <DateFact label="Employment started" value={employment?.employmentStartOn} />
      </dl>
    </div>

    <div className="ro-case-subsection">
      <h4>Rental history</h4>
      <dl className="ro-case-facts">
        <Fact label="Current address" value={rentalHistory?.currentAddress} />
        <Fact label="Prior address" value={rentalHistory?.priorAddress} />
        <Fact label="Prior landlord" value={rentalHistory?.landlordName} />
        <Fact label="Reason for moving" value={rentalHistory?.reasonForMoving} />
      </dl>
    </div>

    <div className="ro-case-subsection">
      <h4>Other reported items</h4>
      <dl className="ro-case-facts">
        <Fact label="Pets reported" value={application.pets === undefined ? undefined : application.pets.length} />
        <Fact label="Vehicles reported" value={application.vehicles === undefined ? undefined : application.vehicles.length} />
        <Fact label="Emergency contact" value={emergencyContact?.name} />
        <Fact label="Emergency relationship" value={emergencyContact?.relationship} />
        <Fact label="Emergency phone" value={emergencyContact?.phone} />
      </dl>
    </div>
  </section>;
}

function HouseholdSection({ application }: { application: AdminApplicationDetailView }) {
  const summary = application.householdSummary;
  const members = application.householdMembers;
  return <section className="ro-case-section" aria-labelledby="application-case-household">
    <SectionHeading id="application-case-household" title="Household" />
    <dl className="ro-case-facts ro-case-facts-compact">
      <Fact label="Adults" value={summary?.adults} />
      <Fact label="Children" value={summary?.children} />
      <Fact label="Total occupants" value={summary?.totalOccupants} />
    </dl>
    {!members.length ? <EmptySection message="No household members recorded. Needs review if additional occupants are expected." /> : <div className="ro-case-member-list">
      {members.map((member, index) => <article className="ro-case-member" key={member.id ?? `${member.firstName ?? "member"}-${index}`}>
        <Users aria-hidden="true" />
        <div><strong>{[member.firstName, member.lastName].filter(Boolean).join(" ") || "Unknown household member"}</strong><span>{applicationCaseFact(member.relationship)} · {applicationCaseFact(member.isMinor)}</span><small>{applicationCaseFact(member.email)} · {applicationCaseFact(member.phone)}</small></div>
      </article>)}
    </div>}
  </section>;
}

function RequirementsSection({ application }: { application: AdminApplicationDetailView }) {
  return <section className="ro-case-section" aria-labelledby="application-case-requirements">
    <SectionHeading id="application-case-requirements" title="Requirements" />
    {!application.requirements.length ? <EmptySection message="No application requirements recorded." /> : <div className="ro-case-requirement-list">
      {application.requirements.map((requirement, index) => <article className="ro-case-requirement" key={requirement.id ?? `${requirement.label ?? "requirement"}-${index}`}>
        <div><strong>{applicationCaseFact(requirement.label)}</strong><span>{title(applicationCaseFact(requirement.status))}</span></div>
        <dl className="ro-case-facts ro-case-facts-compact">
          <DateFact label="Requested" value={requirement.requestedOn} />
          <DateFact label="Resolved" value={requirement.resolvedOn} />
          <Fact label="Document" value={requirement.documentId ? "Attached" : "Not attached"} />
        </dl>
      </article>)}
    </div>}
  </section>;
}

function DocumentsSection({ application }: { application: AdminApplicationDetailView }) {
  const [downloadingDocumentId, setDownloadingDocumentId] = useState<string>();
  const [downloadError, setDownloadError] = useState<string>();

  async function handleDownload(document: AdminDocumentView): Promise<void> {
    if (!applicationDocumentDownloadable(document) || !document.id) return;
    setDownloadError(undefined);
    setDownloadingDocumentId(document.id);
    try {
      const blob = await downloadRentOpsDocument(document.id);
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement("a");
      link.href = url;
      link.download = document.fileName || "document";
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setDownloadError(cause instanceof Error ? cause.message : "Secure document download is unavailable.");
    } finally {
      setDownloadingDocumentId(undefined);
    }
  }

  return <section className="ro-case-section" aria-labelledby="application-case-documents">
    <SectionHeading id="application-case-documents" title="Documents" />
    {downloadError && <p className="ro-case-inline-error" role="alert"><AlertCircle aria-hidden="true" />{downloadError}</p>}
    {!application.documents.length ? <EmptySection message="No application documents recorded." /> : <div className="ro-case-document-list">
      {application.documents.map((document, index) => {
        const canDownload = applicationDocumentDownloadable(document);
        const documentName = document.fileName || "Unknown document";
        const unavailableMessage = document.availability === "metadata" ? "Metadata only — file unavailable." : "Secure file unavailable.";
        return <article className="ro-case-document" key={document.id ?? `${documentName}-${index}`}>
          <FileCheck2 aria-hidden="true" />
          <div className="ro-case-document-body"><strong>{documentName}</strong><span>{title(applicationCaseFact(document.type))} · {title(applicationCaseFact(document.state))}</span><small>{canDownload ? "Verified secure document" : unavailableMessage}</small><small>{document.uploadedAt ? `Uploaded ${document.uploadedAt}` : "Upload date unknown"}{document.verifiedAt ? ` · Verified ${document.verifiedAt}` : ""}</small></div>
          {canDownload ? <button type="button" className="secondary ro-case-download" disabled={downloadingDocumentId === document.id} onClick={() => { void handleDownload(document); }} aria-label={`Download ${documentName}`}><Download aria-hidden="true" />{downloadingDocumentId === document.id ? "Preparing" : "Download"}</button> : <span className="ro-case-not-downloadable">Not downloadable</span>}
        </article>;
      })}
    </div>}
  </section>;
}

function HistoryOverviewSection({ history }: { history: AdminApplicationHistoryCaseView }) {
  const subject = history.application ?? history.prospect;
  const state = applicationHistorySectionState(history, "overview");
  return <section className="ro-case-section ro-history-section" aria-labelledby="application-history-overview">
    <SectionHeading id="application-history-overview" title="Historical overview" />
    {state === "unknown" || !subject ? <EmptySection message="No historical applicant or prospect profile was resolved for this target." /> : <dl className="ro-case-facts">
      <Fact label="Historical application ID" value={history.application?.id} />
      <Fact label="First name" value={subject.firstName} />
      <Fact label="Last name" value={subject.lastName} />
      <Fact label="Email" value={subject.email} />
      <Fact label="Phone" value={subject.phone} />
      <Fact label="Status" value={subject.status} knowledge={subject.statusKnowledge} />
      <DateFact label="Submitted" value={subject.submittedOn} knowledge={subject.submittedOnKnowledge} />
      <DateFact label="Created" value={subject.createdOn} knowledge={subject.createdOnKnowledge} />
      <DateFact label="Updated" value={subject.updatedOn} knowledge={subject.updatedOnKnowledge} />
    </dl>}
  </section>;
}

function HistoryInterestsSection({ history }: { history: AdminApplicationHistoryCaseView }) {
  const state = applicationHistorySectionState(history, "interests");
  return <section className="ro-case-section ro-history-section" aria-labelledby="application-history-interests">
    <SectionHeading id="application-history-interests" title="Interests" />
    {state === "empty" && <EmptySection message="No historical interests were recorded." />}
    {state === "unknown" && <EmptySection message="No linked historical interests are available; some source occurrences could not be resolved." />}
    {state === "full" && <div className="ro-case-requirement-list">
      {history.interests.map((interest, index) => <article className="ro-case-requirement" key={`historical-interest-${index}`}>
        <div><strong>{interest.preference ? title(interest.preference) : `Interest ${index + 1}`}</strong><span>{applicationCaseFact(interest.status, interest.statusKnowledge)}</span></div>
        <dl className="ro-case-facts ro-case-facts-compact">
          <Fact label="Property target" value={interest.propertyId} />
          <Fact label="Unit target" value={interest.unitId} />
          <DateFact label="Interested on" value={interest.interestedOn} knowledge={interest.interestedOnKnowledge} />
          <MoneyFact label="Rent" value={interest.rentCents} knowledge={interest.rentKnowledge} />
          <Fact label="Bedrooms" value={interest.bedrooms} knowledge={interest.bedroomsKnowledge} />
          <Fact label="Order / rank" value={[interest.sourceOrder, interest.sourceRank].filter((value) => value !== undefined).join(" / ")} />
        </dl>
      </article>)}
    </div>}
  </section>;
}

function HistoryParticipantsSection({ history }: { history: AdminApplicationHistoryCaseView }) {
  const state = applicationHistorySectionState(history, "participants");
  return <section className="ro-case-section ro-history-section" aria-labelledby="application-history-participants">
    <SectionHeading id="application-history-participants" title="Participants" />
    {state !== "full" ? <EmptySection message={state === "unknown" ? "Historical participant links need review." : "No historical participants were recorded."} /> : <div className="ro-case-member-list">
      {history.participants.map((participant, index) => <article className="ro-case-member" key={`historical-participant-${index}`}>
        <Users aria-hidden="true" />
        <div><strong>Participant {index + 1}</strong><span>{applicationCaseFact(participant.role, participant.roleKnowledge)} · {applicationCaseFact(participant.relationship, participant.relationshipKnowledge)}</span><small>{applicationCaseFact(participant.isMinor, participant.minorKnowledge)} minor · {applicationCaseFact(participant.isFinanciallyResponsible, participant.financialResponsibilityKnowledge)} financially responsible</small></div>
      </article>)}
    </div>}
  </section>;
}

function HistoryRequirementsSection({ history }: { history: AdminApplicationHistoryCaseView }) {
  const state = applicationHistorySectionState(history, "requirements");
  return <section className="ro-case-section ro-history-section" aria-labelledby="application-history-requirements">
    <SectionHeading id="application-history-requirements" title="Requirements" />
    {state !== "full" ? <EmptySection message={state === "unknown" ? "Historical requirement links need review." : "No historical requirements were recorded."} /> : <div className="ro-case-requirement-list">
      {history.requirements.map((requirement, index) => <article className="ro-case-requirement" key={`historical-requirement-${index}`}>
        <div><strong>{applicationCaseFact(requirement.label)}</strong><span>{title(applicationCaseFact(requirement.status, requirement.statusKnowledge))}</span></div>
        <dl className="ro-case-facts ro-case-facts-compact">
          <DateFact label="Requested" value={requirement.requestedOn} knowledge={requirement.requestedOnKnowledge} />
          <DateFact label="Resolved" value={requirement.resolvedOn} knowledge={requirement.resolvedOnKnowledge} />
          <Fact label="Document metadata" value={requirement.hasDocument === true ? "Linked" : requirement.hasDocument === false ? "Not linked" : undefined} />
        </dl>
      </article>)}
    </div>}
  </section>;
}

function HistoryAnswersSection({ history }: { history: AdminApplicationHistoryCaseView }) {
  const state = applicationHistorySectionState(history, "answers");
  return <section className="ro-case-section ro-history-section" aria-labelledby="application-history-answers">
    <SectionHeading id="application-history-answers" title="Answers" />
    {state === "empty" && <EmptySection message="No historical answer occurrences were recorded." />}
    {state === "restricted" && !history.answers.length && <EmptySection message="Historical answers exist, but their values are restricted or unmapped." />}
    {state === "full" && <div className="ro-case-answer-list">
      {history.answers.map((answer, index) => <article className="ro-case-fact ro-history-answer" key={`historical-answer-${index}`}>
        <strong>Answer {index + 1}</strong>
        <span>{title(answer.valueType)} · {title(answer.valueKnowledge)}</span>
        <small>{answer.fieldLinkKnowledge ? `Field link: ${title(answer.fieldLinkKnowledge)}` : "Field link: Unknown"}</small>
        <small>{answer.valueKnowledge === "restricted" ? "Value withheld" : answer.valueKnowledge === "unknown" || answer.valueKnowledge === "ambiguous" ? "Value unavailable" : "Value not displayed"}</small>
      </article>)}
    </div>}
  </section>;
}

function HistoryDocumentsSection({ history }: { history: AdminApplicationHistoryCaseView }) {
  const state = applicationHistorySectionState(history, "documents");
  return <section className="ro-case-section ro-history-section" aria-labelledby="application-history-documents">
    <SectionHeading id="application-history-documents" title="Documents" />
    {state === "empty" && <EmptySection message="No historical documents were recorded." />}
    {state === "restricted" && !history.documents.length && <EmptySection message="Historical document records are restricted to metadata and are not downloadable." />}
    {(state === "full" || state === "restricted") && history.documents.length > 0 && <div className="ro-case-document-list">
      {history.documents.map((document, index) => <article className="ro-case-document" key={`historical-document-${index}`}>
        <FileText aria-hidden="true" />
        <div className="ro-case-document-body"><strong>{document.fileName || "Historical document"}</strong><span>{title(applicationCaseFact(document.type, document.typeKnowledge))} · {title(applicationCaseFact(document.state, document.stateKnowledge))}</span><small>{document.availability === "metadata" ? "Metadata only — file unavailable." : "File unavailable."}</small><small>{document.mimeType || "Type unknown"}{document.metadataSizeBytes === undefined ? "" : ` · ${document.metadataSizeBytes} bytes`}</small></div>
        <span className="ro-case-not-downloadable">Not downloadable</span>
      </article>)}
    </div>}
  </section>;
}

function HistoryActivitySection({ history }: { history: AdminApplicationHistoryCaseView }) {
  const state = applicationHistorySectionState(history, "activities");
  return <section className="ro-case-section ro-history-section" aria-labelledby="application-history-activity">
    <SectionHeading id="application-history-activity" title="Activity" />
    {state !== "full" ? <EmptySection message={state === "unknown" ? "Some historical activity could not be linked to this case." : "No historical activity was recorded."} /> : <div className="ro-case-history-activity-list">
      {history.activities.map((activity, index) => <article className="ro-case-member" key={`historical-activity-${index}`}>
        <FileText aria-hidden="true" />
        <div><strong>{title(applicationCaseFact(activity.type))}</strong><span>{activity.occurredAt ? new Date(activity.occurredAt).toLocaleString() : applicationCaseFact(undefined, activity.occurredAtKnowledge)}</span><small>{applicationCaseFact(activity.summary, activity.summaryKnowledge)}</small></div>
      </article>)}
    </div>}
  </section>;
}

function HistoryUnknownRestrictedSection({ history }: { history: AdminApplicationHistoryCaseView }) {
  const summary = history.unknownRestricted;
  return <section className="ro-case-section ro-history-section" aria-labelledby="application-history-unknown">
    <SectionHeading id="application-history-unknown" title="Unknown / restricted" />
    <dl className="ro-case-facts">
      <Fact label="Restricted answers" value={summary.restrictedAnswerCount} />
      <Fact label="Unmapped answers" value={summary.unmappedAnswerCount} />
      <Fact label="Applications missing answers" value={summary.missingAnswerApplications} />
      <Fact label="Metadata-only documents" value={summary.metadataOnlyDocumentCount} />
      <Fact label="Unavailable documents" value={summary.unavailableDocumentCount} />
      <Fact label="Unlinked activity" value={summary.unlinkedActivityCount} />
      <Fact label="Unlinked interests" value={summary.unlinkedInterestCount} />
      <Fact label="Case blockers" value={history.blockers.length} />
    </dl>
    {history.blockers.length > 0 && <div className="ro-case-history-blockers">{history.blockers.map((blocker, index) => <p key={`historical-blocker-${index}`} className="ro-case-inline-warning"><AlertCircle aria-hidden="true" />{title(blocker.code)} · {blocker.occurrenceCount} occurrence{blocker.occurrenceCount === 1 ? "" : "s"} ({blocker.reason.replaceAll("_", " ")}).</p>)}</div>}
  </section>;
}

function HistoricalCaseSections({ history }: { history: AdminApplicationHistoryCaseView }) {
  return <div className="ro-history-case">

    <HistoryOverviewSection history={history} />
    <HistoryInterestsSection history={history} />
    <HistoryParticipantsSection history={history} />
    <HistoryRequirementsSection history={history} />
    <HistoryAnswersSection history={history} />
    <HistoryDocumentsSection history={history} />
    <HistoryActivitySection history={history} />
    <HistoryUnknownRestrictedSection history={history} />
  </div>;
}

export function ApplicationCaseDetail({ applicationId, summary, onClose, tenantPersonId }: ApplicationCaseDetailProps) {
  const [detail, setDetail] = useState<AdminApplicationDetailView>();
  const [loadState, setLoadState] = useState<DetailLoadState>("loading");
  const [loadError, setLoadError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocusRef.current = typeof document === "undefined" ? null : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    return () => restoreApplicationCaseFocus(previousFocusRef.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadState("loading");
    setLoadError(undefined);
    setDetail(undefined);
    void loadRentOpsApplication(applicationId).then((result) => {
      if (cancelled) return;
      setDetail(result);
      setLoadState("ready");
    }).catch((cause) => {
      if (cancelled) return;
      setLoadError(cause instanceof Error ? cause.message : "Application detail could not be loaded.");
      setLoadState("error");
    });
    return () => { cancelled = true; };
  }, [applicationId, retry]);

  useEffect(() => {
    function closeOnEscape(event: globalThis.KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? []);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const displayName = applicationCaseDisplayName(detail ?? { firstName: summary?.firstName, lastName: summary?.lastName });
  const status = detail?.status ?? summary?.status;
  return <div className="ro-case-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="ro-case-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="application-case-title" onKeyDown={handleDialogKeyDown}>
      <header className="ro-case-header">
        <div><h2 id="application-case-title"><EntityLink personId={tenantPersonId}>{displayName}</EntityLink></h2></div>
        <div className="ro-case-header-actions"><span className={`ro-case-status ${status ?? "unknown"}`}>{title(applicationCaseFact(status, detail?.statusKnowledge ?? summary?.statusKnowledge))}</span><button type="button" className="ro-icon-button" ref={closeButtonRef} onClick={onClose} aria-label="Close application details"><X aria-hidden="true" /></button></div>
      </header>

      {loadState === "loading" && <div className="ro-case-state" role="status"><Loader2 className="spin" aria-hidden="true" /><h3>Loading application detail</h3><p>Fetching the current case record…</p></div>}
      {loadState === "error" && <div className="ro-case-state ro-case-state-error" role="alert"><AlertCircle aria-hidden="true" /><h3>Application detail unavailable</h3><p>{loadError ?? "The current case record could not be loaded."}</p><div className="ro-case-state-actions"><button type="button" className="primary" onClick={() => setRetry((value) => value + 1)}>Try again</button><button type="button" className="secondary" onClick={onClose}>Close</button></div></div>}
      {loadState === "ready" && detail && <div className="ro-case-content">

        <OverviewSection application={detail} />
        <HouseholdSection application={detail} />
        <RequirementsSection application={detail} />
        <DocumentsSection application={detail} />
        {detail.history && <HistoricalCaseSections history={detail.history} />}
        {applicationCaseSectionState(detail, "overview") === "unknown" && <p className="ro-case-inline-warning"><AlertCircle aria-hidden="true" />Overview facts need review.</p>}
      </div>}
    </section>
  </div>;
}

export default ApplicationCaseDetail;
