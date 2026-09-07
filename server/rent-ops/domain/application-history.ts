import type {
  ApplicationHistoryAnswerValue,
  ApplicationHistoryAnswerValueType,
  RentOpsApplicationAnswerOccurrence,
  RentOpsApplicationHistorySnapshot,
  RentOpsApplicationParticipant,
  RentOpsApplicationRequirementOccurrence,
  RentOpsProspect,
  SourceRef,
} from "../../../shared/rent-ops-contracts";
import { APPLICATION_HISTORY_ANSWER_VALUE_TYPES } from "../../../shared/rent-ops-contracts";

export interface ApplicationHistoryViolation {
  code: string;
  id?: string;
  message: string;
}

export class ApplicationHistoryInvariantError extends Error {
  readonly violations: ApplicationHistoryViolation[];

  constructor(message: string, violations: ApplicationHistoryViolation[] = []) {
    super(message);
    this.name = "ApplicationHistoryInvariantError";
    this.violations = violations;
  }
}

function completeSource(source: SourceRef | undefined): boolean {
  return Boolean(source?.system?.trim() && source?.entityType?.trim() && source?.sourceId?.trim());
}

function revisionValid(value: number | undefined): boolean {
  return Number.isSafeInteger(value) && (value ?? 0) >= 1;
}

function hasParent(value: { applicationId?: string | null; prospectId?: string | null }): boolean {
  return Boolean(value.applicationId || value.prospectId);
}

function checkLinkKnowledge(
  row: { id: string } & Record<string, unknown>,
  idField: string,
  knowledgeField: string,
  label: string,
  violations: ApplicationHistoryViolation[],
): void {
  const targetId = typeof row[idField] === "string" && row[idField] ? row[idField] as string : undefined;
  const knowledge = typeof row[knowledgeField] === "string" ? row[knowledgeField] as string : row[knowledgeField] === null ? null : undefined;
  if (targetId && knowledge !== "exact" && knowledge !== "manual") {
    violations.push({ code: `${label}_link_knowledge_invalid`, id: row.id, message: `${label} resolved target link must be exact or manual` });
  }
  if (!targetId && (knowledge === "exact" || knowledge === "manual")) {
    violations.push({ code: `${label}_link_target_missing`, id: row.id, message: `${label} exact or manual link must identify a target` });
  }
}

function valueTypeValid(value: string): value is ApplicationHistoryAnswerValueType {
  return (APPLICATION_HISTORY_ANSWER_VALUE_TYPES as readonly string[]).includes(value);
}

function safeAnswerValue(value: unknown, valueType: ApplicationHistoryAnswerValueType): boolean {
  if (Array.isArray(value)) return valueType === "multi_choice" && value.every((entry) => typeof entry === "string");
  if (valueType === "text" || valueType === "choice" || valueType === "date") return typeof value === "string";
  if (valueType === "integer" || valueType === "money") return typeof value === "number" && Number.isSafeInteger(value);
  if (valueType === "decimal") return typeof value === "number" && Number.isFinite(value);
  if (valueType === "boolean") return typeof value === "boolean";
  return false;
}

function checkSourceAndRevision<T extends { id: string; source: SourceRef; recordRevision: number }>(
  rows: readonly T[],
  label: string,
  violations: ApplicationHistoryViolation[],
): void {
  const ids = new Set<string>();
  const sourceIdentities = new Set<string>();
  for (const row of rows) {
    if (!row.id.trim() || ids.has(row.id)) violations.push({ code: `${label}_identity_invalid`, id: row.id, message: `${label} IDs must be unique and nonempty` });
    ids.add(row.id);
    if (!completeSource(row.source)) violations.push({ code: `${label}_source_incomplete`, id: row.id, message: `${label} source identity must include system, entityType, and sourceId` });
    const sourceIdentity = `${row.source?.system ?? ""}\u0000${row.source?.sourceId ?? ""}`;
    if (sourceIdentities.has(sourceIdentity)) violations.push({ code: `${label}_source_duplicate`, id: row.id, message: `${label} source identity must be unique` });
    sourceIdentities.add(sourceIdentity);
    if (!revisionValid(row.recordRevision)) violations.push({ code: `${label}_revision_invalid`, id: row.id, message: `${label} revision must be positive` });
  }
}

function checkParent(
  row: { id: string; applicationId?: string | null; prospectId?: string | null },
  applications: ReadonlySet<string>,
  prospects: ReadonlySet<string>,
  label: string,
  violations: ApplicationHistoryViolation[],
): void {
  if (!hasParent(row)) {
    // A source occurrence can be retained without a resolved parent.  It is
    // deliberately excluded from an individual case and counted in the
    // unknown/restricted aggregate; name/contact fan-out is never a fallback.
    return;
  }
  if (row.applicationId && !applications.has(row.applicationId)) violations.push({ code: `${label}_application_parent_unknown`, id: row.id, message: `${label} application parent is not present` });
  if (row.prospectId && !prospects.has(row.prospectId)) violations.push({ code: `${label}_prospect_parent_unknown`, id: row.id, message: `${label} prospect parent is not present` });
}

function checkParticipant(
  row: RentOpsApplicationParticipant,
  applications: ReadonlySet<string>,
  prospects: ReadonlySet<string>,
  violations: ApplicationHistoryViolation[],
): void {
  checkParent(row, applications, prospects, "participant", violations);
  if (row.personId && row.personLinkKnowledge === undefined) violations.push({ code: "participant_person_knowledge_missing", id: row.id, message: "An exact participant person link must carry link knowledge" });
}

function checkRequirement(
  row: RentOpsApplicationRequirementOccurrence,
  applications: ReadonlySet<string>,
  prospects: ReadonlySet<string>,
  violations: ApplicationHistoryViolation[],
): void {
  checkParent(row, applications, prospects, "requirement", violations);
  if (row.status === undefined) violations.push({ code: "requirement_status_undefined", id: row.id, message: "Requirement status must be null when unknown, never omitted" });
}

function checkAnswer(
  row: RentOpsApplicationAnswerOccurrence,
  applications: ReadonlySet<string>,
  prospects: ReadonlySet<string>,
  violations: ApplicationHistoryViolation[],
): void {
  checkParent(row, applications, prospects, "answer", violations);
  if (!valueTypeValid(row.valueType)) violations.push({ code: "answer_value_type_invalid", id: row.id, message: "Answer value type is not allowlisted" });
  const hasValue = row.value !== undefined && row.value !== null;
  if (row.valueKnowledge === "restricted" || row.valueKnowledge === "unknown" || row.valueKnowledge === "ambiguous") {
    if (hasValue) violations.push({ code: "answer_restricted_value_present", id: row.id, message: "Restricted or unknown answer occurrences cannot carry a value" });
  } else if (hasValue && !safeAnswerValue(row.value as ApplicationHistoryAnswerValue, row.valueType)) {
    violations.push({ code: "answer_value_shape_invalid", id: row.id, message: "Answer value does not match its allowlisted type" });
  }
}

/** Validate v9 source fidelity before a repository write. */
export function validateApplicationHistory(snapshot: RentOpsApplicationHistorySnapshot): ApplicationHistoryViolation[] {
  const violations: ApplicationHistoryViolation[] = [];
  checkSourceAndRevision(snapshot.prospects, "prospect", violations);
  checkSourceAndRevision(snapshot.applications, "application", violations);
  checkSourceAndRevision(snapshot.interests, "interest", violations);
  checkSourceAndRevision(snapshot.participants, "participant", violations);
  checkSourceAndRevision(snapshot.requirements, "requirement", violations);
  checkSourceAndRevision(snapshot.templates, "template", violations);
  checkSourceAndRevision(snapshot.templateSections, "template_section", violations);
  checkSourceAndRevision(snapshot.templateFields, "template_field", violations);
  checkSourceAndRevision(snapshot.answers, "answer", violations);
  checkSourceAndRevision(snapshot.documents, "document", violations);
  checkSourceAndRevision(snapshot.activities, "activity", violations);

  const prospects = new Set(snapshot.prospects.map((row) => row.id));
  const applications = new Set(snapshot.applications.map((row) => row.id));
  const documentIds = new Set(snapshot.documents.map((row) => row.id));
  for (const row of snapshot.prospects) {
    checkLinkKnowledge(row as typeof row & Record<string, unknown>, "personId", "personLinkKnowledge", "prospect_person", violations);
    checkLinkKnowledge(row as typeof row & Record<string, unknown>, "contactId", "contactLinkKnowledge", "prospect_contact", violations);
  }
  for (const row of snapshot.applications) {
    checkLinkKnowledge(row as typeof row & Record<string, unknown>, "prospectId", "prospectLinkKnowledge", "application_prospect", violations);
    checkLinkKnowledge(row as typeof row & Record<string, unknown>, "personId", "personLinkKnowledge", "application_person", violations);
  }
  for (const row of snapshot.interests) checkParent(row, applications, prospects, "interest", violations);
  for (const row of snapshot.participants) checkParticipant(row, applications, prospects, violations);
  for (const row of snapshot.requirements) {
    checkRequirement(row, applications, prospects, violations);
    if (row.documentId && !documentIds.has(row.documentId)) violations.push({ code: "requirement_document_unknown", id: row.id, message: "Requirement document link is not present" });
  }
  for (const row of snapshot.answers) checkAnswer(row, applications, prospects, violations);
  for (const row of snapshot.documents) checkParent(row, applications, prospects, "document", violations);
  for (const row of snapshot.activities) checkParent(row, applications, prospects, "activity", violations);
  for (const row of snapshot.interests) {
    checkLinkKnowledge(row as typeof row & Record<string, unknown>, "applicationId", "applicationLinkKnowledge", "interest_application", violations);
    checkLinkKnowledge(row as typeof row & Record<string, unknown>, "prospectId", "prospectLinkKnowledge", "interest_prospect", violations);
    checkLinkKnowledge(row as typeof row & Record<string, unknown>, "propertyId", "propertyLinkKnowledge", "interest_property", violations);
    checkLinkKnowledge(row as typeof row & Record<string, unknown>, "unitId", "unitLinkKnowledge", "interest_unit", violations);
  }
  for (const row of snapshot.participants) {
    checkLinkKnowledge(row as typeof row & Record<string, unknown>, "applicationId", "applicationLinkKnowledge", "participant_application", violations);
    checkLinkKnowledge(row as typeof row & Record<string, unknown>, "prospectId", "prospectLinkKnowledge", "participant_prospect", violations);
    checkLinkKnowledge(row as typeof row & Record<string, unknown>, "personId", "personLinkKnowledge", "participant_person", violations);
  }
  for (const row of snapshot.requirements) {
    checkLinkKnowledge(row as typeof row & Record<string, unknown>, "applicationId", "applicationLinkKnowledge", "requirement_application", violations);
    checkLinkKnowledge(row as typeof row & Record<string, unknown>, "prospectId", "prospectLinkKnowledge", "requirement_prospect", violations);
    checkLinkKnowledge(row as typeof row & Record<string, unknown>, "documentId", "documentLinkKnowledge", "requirement_document", violations);
  }
  for (const row of snapshot.templateSections) {
    checkLinkKnowledge(row as typeof row & Record<string, unknown>, "templateId", "templateLinkKnowledge", "template_section_template", violations);
  }
  for (const row of snapshot.templateFields) {
    checkLinkKnowledge(row as typeof row & Record<string, unknown>, "templateId", "templateLinkKnowledge", "template_field_template", violations);
    checkLinkKnowledge(row as typeof row & Record<string, unknown>, "sectionId", "sectionLinkKnowledge", "template_field_section", violations);
  }
  for (const row of snapshot.answers) {
    checkLinkKnowledge(row as typeof row & Record<string, unknown>, "applicationId", "applicationLinkKnowledge", "answer_application", violations);
    checkLinkKnowledge(row as typeof row & Record<string, unknown>, "prospectId", "prospectLinkKnowledge", "answer_prospect", violations);
    checkLinkKnowledge(row as typeof row & Record<string, unknown>, "fieldId", "fieldLinkKnowledge", "answer_field", violations);
  }
  for (const row of snapshot.documents) {
    checkLinkKnowledge(row as typeof row & Record<string, unknown>, "applicationId", "applicationLinkKnowledge", "document_application", violations);
    checkLinkKnowledge(row as typeof row & Record<string, unknown>, "prospectId", "prospectLinkKnowledge", "document_prospect", violations);
  }
  for (const row of snapshot.activities) {
    checkLinkKnowledge(row as typeof row & Record<string, unknown>, "applicationId", "applicationLinkKnowledge", "activity_application", violations);
    checkLinkKnowledge(row as typeof row & Record<string, unknown>, "prospectId", "prospectLinkKnowledge", "activity_prospect", violations);
  }

  const blockerKeys = new Set<string>();
  for (const blocker of snapshot.blockers) {
    const key = `${blocker.code}:${blocker.applicationId ?? ""}:${blocker.prospectId ?? ""}`;
    if (blockerKeys.has(key)) violations.push({ code: "history_blocker_duplicate", message: "Application history blockers must be unique" });
    blockerKeys.add(key);
    if (!Number.isSafeInteger(blocker.occurrenceCount) || blocker.occurrenceCount < 0) violations.push({ code: "history_blocker_count_invalid", message: "Application history blocker count is invalid" });
  }
  return violations;
}

export function assertValidApplicationHistory(snapshot: RentOpsApplicationHistorySnapshot): void {
  const violations = validateApplicationHistory(snapshot);
  if (violations.length > 0) throw new ApplicationHistoryInvariantError("Application history projection is invalid", violations);
}
