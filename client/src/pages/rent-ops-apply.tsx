import { useEffect, useMemo, useRef, useState } from "react";
import type { ApplicantHouseholdMemberInput, ApplicantPublicView, ApplicantStartInput } from "@/features/rent-ops-apply/types";
import {
  addApplicantHouseholdMember,
  certifyApplicantApplication,
  resumeApplicantApplication,
  loadApplicantPropertyOptions,
  saveApplicantApplication,
  startApplicantApplication,
  submitApplicantApplication,
  uploadApplicantDocument,
} from "@/features/rent-ops-apply/api";
import type { ApplicantDocumentUploadType, ApplicantPropertyOption } from "@/features/rent-ops-apply/api";
import {
  APPLY_STEPS,
  type ApplicationDraft,
  type ApplicationDraftPatch,
  type ApplyStep,
  centsFromDollars,
  dollarsFromCents,
  draftFromApplication,
  mergeApplicantHouseholdMember,
  mergeApplicationDraft,
  normalizeApplicantHouseholdMember,
  parseResumeToken,
  saveInputFromDraft,
  validateStart,
  validateStep,
} from "@/features/rent-ops-apply/flow";
import "@/features/rent-ops-apply/rent-ops-apply.css";

type PortalMode = "landing" | "start" | "resume" | "email-sent" | "resuming" | "application";

const initialStart: ApplicantStartInput = { email: "", firstName: "", lastName: "", phone: "", currentAddress: "" };
const emptyMember: ApplicantHouseholdMemberInput = { firstName: "", lastName: "", relationship: "", email: "", phone: "", isMinor: false };

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

function safeText(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  return value == null || value === "" ? "—" : String(value);
}

function updateDraftValue<T extends keyof ApplicationDraft>(draft: ApplicationDraft, key: T, value: ApplicationDraft[T]): ApplicationDraft {
  return { ...draft, [key]: value };
}

function Field({ label, name, value, onChange, type = "text", required = false, help, wide = false, min, max, step }: {
  label: string;
  name: string;
  value: string | number;
  onChange: (value: string) => void;
  type?: "text" | "email" | "tel" | "date" | "number" | "url";
  required?: boolean;
  help?: string;
  wide?: boolean;
  min?: string | number;
  max?: string | number;
  step?: string | number;
}) {
  return (
    <div className={`apply-field${wide ? " apply-field--wide" : ""}`}>
      <label htmlFor={name}>{label}{required ? " *" : ""}</label>
      <input className="apply-input" id={name} name={name} type={type} value={value} onChange={(event) => onChange(event.target.value)} required={required} min={min} max={max} step={step} />
      {help ? <p className="apply-help">{help}</p> : null}
    </div>
  );
}

function TextArea({ label, name, value, onChange, help, wide = false }: { label: string; name: string; value: string; onChange: (value: string) => void; help?: string; wide?: boolean }) {
  return (
    <div className={`apply-field${wide ? " apply-field--wide" : ""}`}>
      <label htmlFor={name}>{label}</label>
      <textarea className="apply-textarea" id={name} name={name} value={value} onChange={(event) => onChange(event.target.value)} />
      {help ? <p className="apply-help">{help}</p> : null}
    </div>
  );
}

function ApplyShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rent-ops-apply">
      <div className="apply-shell">
        <header className="apply-header">
          <div>
            <p className="apply-kicker">5Central Capital</p>
            <h1>Apply for a home, at your pace.</h1>
            <p>Save a few details at a time, come back through your secure resume link, and review everything before you submit.</p>
          </div>
          <span className="apply-mark">Residential application</span>
        </header>
        {children}
      </div>
    </div>
  );
}

export default function RentOpsApplyPage() {
  const [mode, setMode] = useState<PortalMode>("landing");
  const [startInput, setStartInput] = useState(initialStart);
  const [resumeInput, setResumeInput] = useState("");
  const [resumeToken, setResumeToken] = useState("");
  const [application, setApplication] = useState<ApplicantPublicView | null>(null);
  const [draft, setDraft] = useState<ApplicationDraft | null>(null);
  // Keep a synchronously updated copy of the latest controlled-form state.
  // Browser automation (and fast keyboard/pointer input) can dispatch several
  // input events before React commits the next render. Save handlers must send
  // those latest values rather than the closure from the previous render.
  const applicationRef = useRef<ApplicantPublicView | null>(null);
  const draftRef = useRef<ApplicationDraft | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [maxStepIndex, setMaxStepIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [member, setMember] = useState(emptyMember);
  const memberRef = useRef<ApplicantHouseholdMemberInput>(emptyMember);
  const pendingMutationRef = useRef<Promise<unknown> | null>(null);
  const [petType, setPetType] = useState("");
  const [petName, setPetName] = useState("");
  const [petWeight, setPetWeight] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [plateState, setPlateState] = useState("");
  const [plateLastFour, setPlateLastFour] = useState("");
  const [certify, setCertify] = useState(false);
  const [propertyOptions, setPropertyOptions] = useState<ApplicantPropertyOption[]>([]);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const currentStep: ApplyStep = APPLY_STEPS[stepIndex]?.key ?? "profile";
  const missingItems = useMemo(() => application?.requirements.filter((requirement) => requirement.status === "requested" || requirement.status === "rejected") ?? [], [application]);
  const applicationLocked = Boolean(application && ["submitted", "under_review", "approved", "declined", "withdrawn", "converted"].includes(application.status));

  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "referrer";
    meta.content = "no-referrer";
    document.head.appendChild(meta);
    let disposed = false;
    const consumeResumeLink = () => {
      // Resume credentials are accepted only from the fragment. Query-string
      // credentials are ignored and never become an API Authorization header.
      const linkToken = parseResumeToken(window.location.hash);
      if (!linkToken) return;
      // Erase the credential before any network request. The token lives only
      // in this tab's React state and is sent through the Authorization header.
      window.history.replaceState(null, "", window.location.pathname);
      setResumeToken(linkToken);
      setMode("resuming");
      setError(null);
      void resumeApplicantApplication(linkToken).then((next) => {
        if (disposed) return;
        applyRecord(next);
        setStepIndex(0);
        setMaxStepIndex(0);
        setMode("application");
      }).catch((reason: unknown) => {
        if (disposed) return;
        setError(reason instanceof Error ? reason.message : "That secure resume link is invalid or expired.");
        setMode("resume");
      });
    };
    consumeResumeLink();
    window.addEventListener("hashchange", consumeResumeLink);
    window.addEventListener("popstate", consumeResumeLink);
    return () => {
      disposed = true;
      window.removeEventListener("hashchange", consumeResumeLink);
      window.removeEventListener("popstate", consumeResumeLink);
      meta.remove();
    };
  }, []);

  useEffect(() => {
    void loadApplicantPropertyOptions().then((options) => {
      setPropertyOptions(options);
      const slug = decodeURIComponent(window.location.pathname.split("/")[2] ?? "");
      const linkedProperty = options.find((property) => property.slug === slug);
      if (linkedProperty) setDraft((current) => {
        if (!current) return current;
        const next = { ...current, propertyId: linkedProperty.id, unitId: linkedProperty.units.length === 1 ? linkedProperty.units[0].id : current.unitId };
        draftRef.current = next;
        return next;
      });
    }).catch((reason: unknown) => setOptionsError(reason instanceof Error ? reason.message : "Available homes could not be loaded."));
  }, []);

  useEffect(() => {
    if (!draft || draft.propertyId || propertyOptions.length === 0) return;
    const slug = decodeURIComponent(window.location.pathname.split("/")[2] ?? "");
    const linkedProperty = propertyOptions.find((property) => property.slug === slug);
    if (linkedProperty) {
      const next = { ...draft, propertyId: linkedProperty.id, unitId: linkedProperty.units.length === 1 ? linkedProperty.units[0].id : draft.unitId };
      draftRef.current = next;
      setDraft(next);
    }
  }, [draft, propertyOptions]);

  useEffect(() => {
    if (mode === "application") window.setTimeout(() => headingRef.current?.focus(), 0);
  }, [mode, stepIndex]);

  useEffect(() => {
    if (applicationLocked) {
      setStepIndex(APPLY_STEPS.length - 1);
      setMaxStepIndex(APPLY_STEPS.length - 1);
    }
  }, [applicationLocked]);

  function showError(reason: unknown): void {
    setError(reason instanceof Error ? reason.message : "We couldn't complete that update. Try again.");
    setNotice(null);
  }

  function applyRecord(next: ApplicantPublicView): void {
    const nextDraft = draftFromApplication(next);
    applicationRef.current = next;
    draftRef.current = nextDraft;
    setApplication(next);
    setDraft(nextDraft);
  }

  function updateMember(patch: Partial<ApplicantHouseholdMemberInput>): void {
    const next = mergeApplicantHouseholdMember(memberRef.current, patch);
    memberRef.current = next;
    setMember(next);
  }

  function resetMember(): void {
    memberRef.current = emptyMember;
    setMember(emptyMember);
  }

  function trackPendingMutation<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => {
      if (pendingMutationRef.current === tracked) pendingMutationRef.current = null;
    });
    pendingMutationRef.current = tracked;
    return tracked;
  }

  async function handleStart(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const validation = validateStart(startInput);
    if (validation) { setStartError(validation); return; }
    setBusy(true); setStartError(null); setError(null);
    try {
      const result = await startApplicantApplication({ email: startInput.email.trim(), firstName: startInput.firstName.trim(), lastName: startInput.lastName.trim(), phone: startInput.phone.trim(), currentAddress: startInput.currentAddress.trim() });
      if (result.demoResumeToken && result.application) {
        setResumeToken(result.demoResumeToken);
        window.history.replaceState(null, "", window.location.pathname);
        applyRecord(result.application);
        setStepIndex(0);
        setMaxStepIndex(0);
        setMode("application");
        setNotice("Your demo application is ready. The secure resume session stays in memory for this browser tab.");
      } else {
        setMode("email-sent");
        setNotice("If the address is eligible, a secure resume link will be sent there. The link expires and is the only way to return to this application.");
      }
    } catch (reason) { setStartError(reason instanceof Error ? reason.message : "We couldn't start the application. Try again."); }
    finally { setBusy(false); }
  }

  async function handleResume(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const token = parseResumeToken(resumeInput);
    if (!token) { setError("Paste the secure resume link from your email."); return; }
    setResumeInput("");
    setBusy(true); setError(null); setNotice(null); setMode("resuming");
    try {
      setResumeToken(token);
      const next = await resumeApplicantApplication(token);
      applyRecord(next); setStepIndex(0); setMaxStepIndex(0); setMode("application");
      window.history.replaceState(null, "", window.location.pathname);
    } catch (reason) { showError(reason); setMode("resume"); }
    finally { setBusy(false); }
  }

  async function saveCurrentStep(nextIndex: number): Promise<void> {
    // A household-member/document request may still be completing if the
    // applicant clicks the primary action immediately after adding it. Wait
    // for that mutation so the subsequent public snapshot cannot race it.
    const pendingMutation = pendingMutationRef.current;
    if (pendingMutation) {
      try { await pendingMutation; }
      catch (reason) { showError(reason); return; }
    }
    const currentApplication = applicationRef.current ?? application;
    const currentDraft = draftRef.current ?? draft;
    if (!currentApplication || !currentDraft || !resumeToken) { showError("This session is no longer available. Use your secure resume link again."); return; }
    const validation = validateStep(currentStep, currentDraft);
    if (validation) { setError(validation); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      const next = await trackPendingMutation(saveApplicantApplication(resumeToken, saveInputFromDraft(draftRef.current ?? currentDraft)));
      applyRecord(next); setStepIndex(nextIndex); setMaxStepIndex((current) => Math.max(current, nextIndex)); setNotice("Saved securely in this application.");
    } catch (reason) { showError(reason); }
    finally { setBusy(false); }
  }

  async function addMember(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalizedMember = normalizeApplicantHouseholdMember(memberRef.current);
    if (!normalizedMember.firstName || !normalizedMember.lastName) { setError("Enter the household member's first and last name."); return; }
    if (!(applicationRef.current ?? application) || !resumeToken) { showError("This session is no longer available. Use your secure resume link again."); return; }
    setBusy(true); setError(null);
    try {
      const next = await trackPendingMutation(addApplicantHouseholdMember(resumeToken, normalizedMember));
      applyRecord(next); resetMember(); setNotice("Household member added.");
    }
    catch (reason) { showError(reason); }
    finally { setBusy(false); }
  }

  function addPet(): void {
    const currentDraft = draftRef.current ?? draft;
    if (!currentDraft || !petType.trim()) { setError("Enter a pet type before adding it."); return; }
    const next = { ...currentDraft, pets: [...currentDraft.pets, { type: petType.trim(), name: petName.trim() || undefined, weightLb: petWeight ? Number(petWeight) : undefined }] };
    draftRef.current = next;
    setDraft(next);
    setPetType(""); setPetName(""); setPetWeight(""); setError(null);
  }

  function addVehicle(): void {
    const currentDraft = draftRef.current ?? draft;
    if (!currentDraft || !vehicle.trim()) { setError("Enter a vehicle make and model before adding it."); return; }
    const next = { ...currentDraft, vehicles: [...currentDraft.vehicles, { makeModel: vehicle.trim(), plateState: plateState.trim().toUpperCase() || undefined, plateLastFour: plateLastFour.trim() || undefined }] };
    draftRef.current = next;
    setDraft(next);
    setVehicle(""); setPlateState(""); setPlateLastFour(""); setError(null);
  }

  async function certifyAndSubmit(): Promise<void> {
    if (!application || !resumeToken) { showError("This session is no longer available. Use your secure resume link again."); return; }
    if (!certify && !application.certificationAcceptedOn) { setError("Read the certification and check the box before submitting."); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      let next = application;
      if (!next.certificationAcceptedOn) next = await certifyApplicantApplication(resumeToken);
      next = await submitApplicantApplication(resumeToken);
      applyRecord(next); setNotice("Your application has been submitted for manual review.");
    } catch (reason) { showError(reason); }
    finally { setBusy(false); }
  }

  async function uploadDocument(file: File, requirementId?: string, type?: ApplicantDocumentUploadType): Promise<void> {
    if (!resumeToken) { showError("This session is no longer available. Use your secure resume link again."); return; }
    if (!type) { showError("Choose a document type before uploading."); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      const next = await uploadApplicantDocument(resumeToken, file, { requirementId, type });
      applyRecord(next);
      setNotice("Document uploaded and verified securely.");
    } catch (reason) { showError(reason); }
    finally { setBusy(false); }
  }

  if (mode === "resuming") return <ApplyShell><div className="apply-card apply-card--main" aria-live="polite"><h2>Opening your application</h2><p className="apply-intro">Checking the secure resume link. This may take a moment.</p></div></ApplyShell>;

  if (mode === "landing" || mode === "start" || mode === "resume" || mode === "email-sent") {
    return (
      <ApplyShell>
        {error ? <div className="apply-alert" role="alert">{error}</div> : null}
        {mode === "email-sent" ? (
          <div className="apply-card apply-card--main" aria-live="polite">
            <h2>Check your email</h2>
            <p className="apply-intro">{notice ?? "A secure resume link will arrive if the application can be started."}</p>
            <div className="apply-actions"><button className="apply-button apply-button--secondary" type="button" onClick={() => { setMode("resume"); setNotice(null); }}>I have a resume link</button><button className="apply-button" type="button" onClick={() => { setMode("start"); setNotice(null); }}>Start again</button></div>
          </div>
        ) : mode === "start" ? (
          <div className="apply-card apply-card--main">
            <h2>Start a new application</h2>
            <p className="apply-intro">We’ll use this email only to send a secure link back to this application.</p>
            {startError ? <div className="apply-alert" role="alert">{startError}</div> : null}
            <form onSubmit={handleStart} noValidate>
              <div className="apply-grid">
                <Field label="First name" name="firstName" value={startInput.firstName} onChange={(value) => setStartInput({ ...startInput, firstName: value })} required />
                <Field label="Last name" name="lastName" value={startInput.lastName} onChange={(value) => setStartInput({ ...startInput, lastName: value })} required />
                <Field label="Email" name="email" type="email" value={startInput.email} onChange={(value) => setStartInput({ ...startInput, email: value })} required wide help="No application details are placed in the email subject or link." />
                <Field label="Phone" name="phone" type="tel" value={startInput.phone} onChange={(value) => setStartInput({ ...startInput, phone: value })} required />
                <Field label="Current address" name="currentAddress" value={startInput.currentAddress} onChange={(value) => setStartInput({ ...startInput, currentAddress: value })} required />
              </div>
              <div className="apply-actions"><button className="apply-button" type="submit" disabled={busy}>{busy ? "Starting…" : "Continue"}</button><button className="apply-button apply-button--secondary" type="button" onClick={() => { setMode("landing"); setStartError(null); }}>Back</button></div>
            </form>
          </div>
        ) : mode === "resume" ? (
          <div className="apply-card apply-card--main">
            <h2>Resume an application</h2>
            <p className="apply-intro">Paste the secure link from your email. It is not saved on this device; it is kept in memory only while this tab is open.</p>
            <form onSubmit={handleResume}>
              <Field label="Secure resume link" name="resumeLink" type="url" value={resumeInput} onChange={setResumeInput} required help="The link expires and is limited to one application." wide />
              <div className="apply-actions"><button className="apply-button" type="submit" disabled={busy}>{busy ? "Opening…" : "Resume application"}</button><button className="apply-button apply-button--secondary" type="button" onClick={() => { setMode("landing"); setError(null); }}>Back</button></div>
            </form>
          </div>
        ) : (
          <div className="apply-card apply-card--main">
            <h2>Choose how to begin</h2>
            <p className="apply-intro">You can save your progress and return through a secure, expiring link.</p>
            <div className="apply-choice-row">
              <button className="apply-choice" type="button" onClick={() => setMode("start")}><strong>New application</strong><span>Start with your name and email. No payment or application fee is collected here.</span></button>
              <button className="apply-choice" type="button" onClick={() => setMode("resume")}><strong>Resume application</strong><span>Use the secure link from your email. The link is private to your application.</span></button>
            </div>
            <p className="apply-privacy">This form asks only for rental, household, employment, voucher, pet, vehicle, and requested-document information. It does not ask for a full Social Security number, bank account, payment, screening decision, or electronic signature.</p>
          </div>
        )}
      </ApplyShell>
    );
  }

  if (!application || !draft) return <ApplyShell><div className="apply-card apply-card--main"><h2>Application unavailable</h2><p className="apply-intro">Use the secure resume link again to reopen this application.</p></div></ApplyShell>;

  const stepTitle = APPLY_STEPS[stepIndex].label;
  const update = (patch: ApplicationDraftPatch) => {
    const current = draftRef.current ?? draft;
    if (!current) return;
    const next = mergeApplicationDraft(current, patch);
    draftRef.current = next;
    setDraft(next);
  };
  const nextStep = () => void saveCurrentStep(Math.min(APPLY_STEPS.length - 1, stepIndex + 1));
  const previousStep = () => setStepIndex(Math.max(0, stepIndex - 1));

  return (
    <ApplyShell>
      <div className="apply-split">
        <section className="apply-card apply-card--main" aria-labelledby="application-step-title">
          {error ? <div className="apply-alert" role="alert">{error}</div> : null}
          {notice ? <div className="apply-notice" role="status">{notice}</div> : null}
          <nav className="apply-progress" aria-label="Application steps">
            {APPLY_STEPS.map((item, index) => <button key={item.key} type="button" aria-current={index === stepIndex ? "step" : undefined} disabled={applicationLocked || index > maxStepIndex} onClick={() => setStepIndex(index)}>{item.shortLabel}</button>)}
          </nav>
          <div className="apply-step-heading">
            <div><h2 id="application-step-title" tabIndex={-1} ref={headingRef}>{stepTitle}</h2><p>Saved fields can be updated until you submit.</p></div>
            <span className={`apply-status apply-status--${application.status}`}>{statusLabel(application.status)}</span>
          </div>
          {currentStep === "profile" ? <ProfileStep draft={draft} update={update} /> : null}
          {currentStep === "household" ? <HouseholdStep application={application} member={member} updateMember={updateMember} onAdd={addMember} busy={busy} /> : null}
          {currentStep === "preferences" ? <PreferencesStep draft={draft} update={update} options={propertyOptions} optionsError={optionsError} /> : null}
          {currentStep === "history-income" ? <HistoryIncomeStep draft={draft} update={update} /> : null}
          {currentStep === "voucher" ? <VoucherStep draft={draft} update={update} /> : null}
          {currentStep === "pets-vehicles" ? <PetsVehiclesStep draft={draft} update={update} petType={petType} setPetType={setPetType} petName={petName} setPetName={setPetName} petWeight={petWeight} setPetWeight={setPetWeight} vehicle={vehicle} setVehicle={setVehicle} plateState={plateState} setPlateState={setPlateState} plateLastFour={plateLastFour} setPlateLastFour={setPlateLastFour} onAddPet={addPet} onAddVehicle={addVehicle} /> : null}
          {currentStep === "documents" ? <DocumentsStep application={application} onUpload={uploadDocument} busy={busy} /> : null}
          {currentStep === "review" ? <ReviewStep application={application} draft={draft} missingItems={missingItems} certify={certify || Boolean(application.certificationAcceptedOn)} setCertify={setCertify} onSubmit={certifyAndSubmit} busy={busy} /> : null}
          <div className="apply-actions">
            {!applicationLocked && stepIndex > 0 ? <button className="apply-button apply-button--secondary" type="button" onClick={previousStep} disabled={busy}>Back</button> : null}
            {!applicationLocked && stepIndex < APPLY_STEPS.length - 1 ? <button className="apply-button" type="button" onClick={nextStep} disabled={busy}>{busy ? "Saving…" : "Save and continue"}</button> : null}
          </div>
          <p className="apply-footer">Submitting sends this application to the property team for manual review. Nothing on this page ranks, screens, approves, or declines an applicant.</p>
        </section>
        <aside className="apply-card apply-card--small apply-side-note" aria-label="Application privacy note">
          <h3>What to expect</h3>
          <p className="apply-intro">Your resume link is expiring and scoped to this application. The page keeps the active token in memory only.</p>
          {missingItems.length ? <><h3>Items requested</h3><div className="apply-list">{missingItems.map((item) => <div className="apply-list-item" key={item.id}><div><strong>{item.label}</strong><span>{statusLabel(item.status)}</span></div></div>)}</div></> : null}
        </aside>
      </div>
    </ApplyShell>
  );
}

function ProfileStep({ draft, update }: { draft: ApplicationDraft; update: (patch: ApplicationDraftPatch) => void }) {
  return <div className="apply-grid">
    <Field label="Phone" name="phone" type="tel" value={draft.phone} onChange={(phone) => update({ phone })} required wide />
    <Field label="Adults" name="adults" type="number" value={draft.householdSummary.adults} onChange={(value) => update({ householdSummary: { adults: Number(value) || 0 } })} min={1} max={20} required />
    <Field label="Children" name="children" type="number" value={draft.householdSummary.children} onChange={(value) => update({ householdSummary: { children: Number(value) || 0 } })} min={0} max={20} required />
    <Field label="Total occupants" name="totalOccupants" type="number" value={draft.householdSummary.totalOccupants} onChange={(value) => update({ householdSummary: { totalOccupants: Number(value) || 0 } })} min={1} max={40} required />
    <p className="apply-help apply-field--wide">Include everyone who would live in the home. Household members can be added on the next step.</p>
  </div>;
}

function HouseholdStep({ application, member, updateMember, onAdd, busy }: { application: ApplicantPublicView; member: ApplicantHouseholdMemberInput; updateMember: (patch: Partial<ApplicantHouseholdMemberInput>) => void; onAdd: (event: React.FormEvent<HTMLFormElement>) => void; busy: boolean }) {
  return <>
    <p className="apply-intro">Add adults, co-applicants, occupants, or minors who will be part of the household. Do not add a Social Security number or bank information.</p>
    {application.householdMembers?.length ? <div className="apply-list">{application.householdMembers.map((item) => <div className="apply-list-item" key={item.id}><div><strong>{item.firstName} {item.lastName}</strong><span>{item.relationship || (item.isMinor ? "Minor occupant" : "Household member")}</span></div></div>)}</div> : <div className="apply-empty">No additional household members added.</div>}
    <form className="apply-grid" onSubmit={onAdd}>
      <Field label="First name" name="memberFirstName" value={member.firstName} onChange={(firstName) => updateMember({ firstName })} required />
      <Field label="Last name" name="memberLastName" value={member.lastName} onChange={(lastName) => updateMember({ lastName })} required />
      <Field label="Relationship" name="relationship" value={member.relationship ?? ""} onChange={(relationship) => updateMember({ relationship })} />
      <Field label="Email (optional)" name="memberEmail" type="email" value={member.email ?? ""} onChange={(email) => updateMember({ email })} />
      <Field label="Phone (optional)" name="memberPhone" type="tel" value={member.phone ?? ""} onChange={(phone) => updateMember({ phone })} />
      <label className="apply-checkbox apply-field--wide"><input type="checkbox" checked={member.isMinor} onChange={(event) => updateMember({ isMinor: event.target.checked })} /><span>This household member is a minor.</span></label>
      <div className="apply-actions apply-field--wide"><button className="apply-button apply-button--quiet" type="submit" disabled={busy}>Add household member</button></div>
    </form>
  </>;
}

function PreferencesStep({ draft, update, options, optionsError }: { draft: ApplicationDraft; update: (patch: ApplicationDraftPatch) => void; options: ApplicantPropertyOption[]; optionsError: string | null }) {
  const units = options.find((property) => property.id === draft.propertyId)?.units ?? [];
  return <div className="apply-grid">
    <div className="apply-field"><label htmlFor="propertyId">Preferred property</label><select className="apply-select" id="propertyId" value={draft.propertyId} onChange={(event) => update({ propertyId: event.target.value, unitId: "" })}><option value="">No preference</option>{options.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}</select>{optionsError ? <p className="apply-help">{optionsError}</p> : null}</div>
    <div className="apply-field"><label htmlFor="unitId">Preferred available unit</label><select className="apply-select" id="unitId" value={draft.unitId} onChange={(event) => update({ unitId: event.target.value })} disabled={!draft.propertyId}><option value="">No preference</option>{units.map((unit) => <option key={unit.id} value={unit.id}>{unit.unitNumber} · {unit.bedrooms ?? "—"} bd / {unit.bathrooms ?? "—"} ba{unit.marketRentCents == null ? "" : ` · ${dollarsFromCents(unit.marketRentCents)}/mo`}</option>)}</select></div>
    <Field label="Desired move-in date" name="desiredMoveInOn" type="date" value={draft.preferences.desiredMoveInOn ?? ""} onChange={(desiredMoveInOn) => update({ preferences: { desiredMoveInOn } })} />
    <Field label="Lease length (months)" name="desiredLeaseMonths" type="number" value={draft.preferences.desiredLeaseMonths ?? ""} onChange={(value) => update({ preferences: { desiredLeaseMonths: value ? Number(value) : undefined } })} min={1} max={60} />
    <Field label="Maximum monthly rent" name="maxRentCents" type="number" value={draft.preferences.maxRentCents == null ? "" : dollarsFromCents(draft.preferences.maxRentCents)} onChange={(value) => update({ preferences: { maxRentCents: centsFromDollars(value) } })} min={0} step="0.01" />
    <Field label="Bedrooms needed" name="bedrooms" type="number" value={draft.preferences.bedrooms ?? ""} onChange={(value) => update({ preferences: { bedrooms: value ? Number(value) : undefined } })} min={0} max={20} />
  </div>;
}

function HistoryIncomeStep({ draft, update }: { draft: ApplicationDraft; update: (patch: ApplicationDraftPatch) => void }) {
  return <div className="apply-grid">
    <TextArea label="Current address" name="currentAddress" value={draft.rentalHistory.currentAddress ?? ""} onChange={(currentAddress) => update({ rentalHistory: { currentAddress } })} wide />
    <TextArea label="Prior address (optional)" name="priorAddress" value={draft.rentalHistory.priorAddress ?? ""} onChange={(priorAddress) => update({ rentalHistory: { priorAddress } })} />
    <Field label="Current landlord name (optional)" name="landlordName" value={draft.rentalHistory.landlordName ?? ""} onChange={(landlordName) => update({ rentalHistory: { landlordName } })} />
    <Field label="Landlord contact (optional)" name="landlordContact" value={draft.rentalHistory.landlordContact ?? ""} onChange={(landlordContact) => update({ rentalHistory: { landlordContact } })} />
    <TextArea label="Reason for moving (optional)" name="reasonForMoving" value={draft.rentalHistory.reasonForMoving ?? ""} onChange={(reasonForMoving) => update({ rentalHistory: { reasonForMoving } })} wide />
    <Field label="Employer name (optional)" name="employerName" value={draft.employment.employerName ?? ""} onChange={(employerName) => update({ employment: { employerName } })} />
    <Field label="Job title (optional)" name="jobTitle" value={draft.employment.jobTitle ?? ""} onChange={(jobTitle) => update({ employment: { jobTitle } })} />
    <Field label="Monthly income (optional)" name="monthlyIncomeCents" type="number" value={draft.employment.monthlyIncomeCents == null ? "" : dollarsFromCents(draft.employment.monthlyIncomeCents)} onChange={(value) => update({ employment: { monthlyIncomeCents: centsFromDollars(value) } })} min={0} step="0.01" />
    <Field label="Employment start date (optional)" name="employmentStartOn" type="date" value={draft.employment.employmentStartOn ?? ""} onChange={(employmentStartOn) => update({ employment: { employmentStartOn } })} />
    <Field label="Emergency contact name (optional)" name="emergencyName" value={draft.emergencyContact.name} onChange={(name) => update({ emergencyContact: { name } })} />
    <Field label="Emergency contact phone (optional)" name="emergencyPhone" type="tel" value={draft.emergencyContact.phone} onChange={(phone) => update({ emergencyContact: { phone } })} />
    <Field label="Relationship (optional)" name="emergencyRelationship" value={draft.emergencyContact.relationship ?? ""} onChange={(relationship) => update({ emergencyContact: { relationship } })} />
  </div>;
}

function VoucherStep({ draft, update }: { draft: ApplicationDraft; update: (patch: ApplicationDraftPatch) => void }) {
  return <div className="apply-grid">
    <label className="apply-checkbox apply-field--wide"><input type="checkbox" checked={draft.voucher.hasVoucher} onChange={(event) => update({ voucher: { hasVoucher: event.target.checked } })} /><span>I have a housing voucher or rental assistance.</span></label>
    {draft.voucher.hasVoucher ? <>
      <Field label="Agency name" name="agencyName" value={draft.voucher.agencyName ?? ""} onChange={(agencyName) => update({ voucher: { agencyName } })} required />
      <Field label="Case number (optional)" name="caseNumber" value={draft.voucher.caseNumber ?? ""} onChange={(caseNumber) => update({ voucher: { caseNumber } })} />
      <Field label="Estimated tenant portion (optional)" name="tenantPortionCents" type="number" value={draft.voucher.tenantPortionCents == null ? "" : dollarsFromCents(draft.voucher.tenantPortionCents)} onChange={(value) => update({ voucher: { tenantPortionCents: centsFromDollars(value) } })} min={0} step="0.01" />
    </> : <p className="apply-help apply-field--wide">You can update this answer later. Source of income is handled by the property team under its normal review process.</p>}
  </div>;
}

function PetsVehiclesStep({ draft, update, petType, setPetType, petName, setPetName, petWeight, setPetWeight, vehicle, setVehicle, plateState, setPlateState, plateLastFour, setPlateLastFour, onAddPet, onAddVehicle }: {
  draft: ApplicationDraft;
  update: (patch: ApplicationDraftPatch) => void;
  petType: string; setPetType: (value: string) => void;
  petName: string; setPetName: (value: string) => void;
  petWeight: string; setPetWeight: (value: string) => void;
  vehicle: string; setVehicle: (value: string) => void;
  plateState: string; setPlateState: (value: string) => void;
  plateLastFour: string; setPlateLastFour: (value: string) => void;
  onAddPet: () => void; onAddVehicle: () => void;
}) {
  return <div className="apply-grid">
    <div className="apply-field apply-field--wide"><span className="apply-legend">Pets</span>{draft.pets.length ? <div className="apply-list">{draft.pets.map((pet, index) => <div className="apply-list-item" key={`${pet.type}-${index}`}><div><strong>{pet.type}</strong><span>{safeText(pet.name)}{pet.weightLb ? ` · ${pet.weightLb} lb` : ""}</span></div><button className="apply-button apply-button--quiet" type="button" onClick={() => update({ pets: draft.pets.filter((_, itemIndex) => itemIndex !== index) })}>Remove</button></div>)}</div> : <div className="apply-empty">No pets added.</div>}</div>
    <Field label="Pet type" name="petType" value={petType} onChange={setPetType} />
    <Field label="Pet name (optional)" name="petName" value={petName} onChange={setPetName} />
    <Field label="Weight in pounds (optional)" name="petWeight" type="number" value={petWeight} onChange={setPetWeight} min={0} />
    <div className="apply-actions apply-field--wide"><button className="apply-button apply-button--quiet" type="button" onClick={onAddPet}>Add pet</button></div>
    <div className="apply-field apply-field--wide"><span className="apply-legend">Vehicles</span>{draft.vehicles.length ? <div className="apply-list">{draft.vehicles.map((item, index) => <div className="apply-list-item" key={`${item.makeModel}-${index}`}><div><strong>{item.makeModel}</strong><span>{safeText(item.plateState)} {item.plateLastFour ? `· plate ending ${item.plateLastFour}` : ""}</span></div><button className="apply-button apply-button--quiet" type="button" onClick={() => update({ vehicles: draft.vehicles.filter((_, itemIndex) => itemIndex !== index) })}>Remove</button></div>)}</div> : <div className="apply-empty">No vehicles added.</div>}</div>
    <Field label="Make and model" name="vehicle" value={vehicle} onChange={setVehicle} />
    <Field label="Plate state (optional)" name="plateState" value={plateState} onChange={setPlateState} />
    <Field label="Plate last four (optional)" name="plateLastFour" value={plateLastFour} onChange={setPlateLastFour} />
    <div className="apply-actions apply-field--wide"><button className="apply-button apply-button--quiet" type="button" onClick={onAddVehicle}>Add vehicle</button></div>
  </div>;
}

function DocumentsStep({ application, onUpload, busy }: { application: ApplicantPublicView; onUpload: (file: File, requirementId?: string, type?: ApplicantDocumentUploadType) => void; busy: boolean }) {
  const [requirementId, setRequirementId] = useState("");
  const [documentType, setDocumentType] = useState<ApplicantDocumentUploadType | "">("");
  const uploadableRequirements = application.requirements.filter((item) => item.status !== "waived" && !item.documentId);
  return <>
    <p className="apply-intro">Upload a requested document here when secure upload is enabled for this application. The file is checked and stored as a verified private object; a filename or metadata claim alone never satisfies a requirement.</p>
    {uploadableRequirements.length ? <div className="apply-field apply-field--wide"><label htmlFor="documentRequirement">Requirement</label><select className="apply-select" id="documentRequirement" value={requirementId} onChange={(event) => setRequirementId(event.target.value)}><option value="">Choose a requirement</option>{uploadableRequirements.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div> : null}
    <div className="apply-field apply-field--wide"><label htmlFor="documentType">Document type</label><select className="apply-select" id="documentType" value={documentType} onChange={(event) => setDocumentType(event.target.value as ApplicantDocumentUploadType)}><option value="">Choose a document type</option><option value="identity">Identity</option><option value="lease">Lease</option><option value="addendum">Addendum</option><option value="insurance">Insurance</option><option value="housing_assistance">Housing assistance</option><option value="application_attachment">Application attachment</option><option value="other">Other</option></select></div>
    <div className="apply-field apply-field--wide"><label htmlFor="documentUpload">Choose a file</label><input className="apply-input" id="documentUpload" name="documentUpload" type="file" accept="application/pdf,image/jpeg,image/png,image/webp,text/plain" disabled={busy || !documentType || (uploadableRequirements.length > 0 && !requirementId)} onChange={(event) => { const file = event.target.files?.[0]; if (file && documentType) onUpload(file, requirementId || undefined, documentType); event.currentTarget.value = ""; }} /><p className="apply-help">Do not upload a Social Security number, bank account, or other information the property team did not request. If this control is unavailable, the property team will provide another secure method.</p></div>
    {application.documents.length ? <div className="apply-list">{application.documents.map((document) => <div className="apply-list-item" key={document.id}><div><strong>{document.fileName}</strong><span>{safeText(document.type).replaceAll("_", " ")} · {safeText(document.state)}</span></div></div>)}</div> : <div className="apply-empty">No documents have been uploaded. The property team will tell you how to provide any required documents.</div>}
  </>;
}

function ReviewStep({ application, draft, missingItems, certify, setCertify, onSubmit, busy }: { application: ApplicantPublicView; draft: ApplicationDraft; missingItems: ApplicantPublicView["requirements"]; certify: boolean; setCertify: (value: boolean) => void; onSubmit: () => void; busy: boolean }) {
  const locked = ["submitted", "under_review", "approved", "declined", "withdrawn", "converted"].includes(application.status);
  return <>
    <p className="apply-intro">Review the information below. Certification is required before the first submission. You can return to earlier steps while the application is still editable.</p>
    <dl className="apply-summary"><div><dt>Name</dt><dd>{application.firstName} {application.lastName}</dd></div><div><dt>Email</dt><dd>{application.email}</dd></div><div><dt>Phone</dt><dd>{safeText(draft.phone)}</dd></div><div><dt>Household</dt><dd>{draft.householdSummary.adults} adults · {draft.householdSummary.children} children · {draft.householdSummary.totalOccupants} occupants</dd></div><div><dt>Move-in</dt><dd>{safeText(draft.preferences.desiredMoveInOn)}</dd></div><div><dt>Voucher</dt><dd>{draft.voucher.hasVoucher ? safeText(draft.voucher.agencyName) : "No voucher listed"}</dd></div><div><dt>Pets</dt><dd>{draft.pets.length ? draft.pets.map((pet) => pet.type).join(", ") : "None listed"}</dd></div><div><dt>Documents</dt><dd>{application.documents.length ? `${application.documents.length} document(s) received` : "No documents uploaded"}</dd></div></dl>
    {missingItems.length ? <div className="apply-alert" role="status"><strong>Items requested by the property team:</strong><ul>{missingItems.map((item) => <li key={item.id}>{item.label}</li>)}</ul></div> : null}
    {!locked ? <label className="apply-checkbox"><input type="checkbox" checked={certify} onChange={(event) => setCertify(event.target.checked)} /><span>I certify that the information I provided is complete and accurate to the best of my knowledge, and I understand the property team will manually review it.</span></label> : <div className="apply-notice">This application is already {statusLabel(application.status)}. No duplicate submission will be created.</div>}
    {!locked ? <div className="apply-actions"><button className="apply-button" type="button" onClick={onSubmit} disabled={busy}>{busy ? "Submitting…" : "Certify and submit"}</button></div> : null}
  </>;
}
