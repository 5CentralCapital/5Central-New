import { hasOperationalEndOn, hasOccupancyConfirmationOn } from "../domain/tenancy-occupancy";
import { measureRentOps } from "../request-timing";
import { phoneMethodsSchema } from "../domain/phone-methods";
import { manualPaymentSchema, createChargeDefinitionSchema, patchChargeDefinitionSchema, type CreateChargeDefinitionInput, type PatchChargeDefinitionInput, type ManualPaymentInput } from "./operational-inputs";
import { postedReversalTargets } from "../domain/invariants";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import type {
  ApplicantSaveInput,
  ApplicantStartInput,
  Cents,
  RentOpsActivityEvent,
  RentOpsApplication,
  RentOpsApplicationCase,
  RentOpsApplicationRecord,
  ApplicantHouseholdMemberInput,
  RentOpsApplicationHouseholdMember,
  RentOpsApplicationRequirement,
  RentOpsDocument,
  RentOpsDocumentObjectBinding,
  RentOpsFilters,
  RentOpsHouseholdMembership,
  RentOpsImportRun,
  RentOpsLedgerTransaction,
  RentOpsChargeDefinition,
  RentOpsPaymentAllocation,
  RentOpsPerson,
  RentOpsProperty,
  RentOpsRecurringChargeSchedule,
  RentOpsRepository,
  RentOpsPatchEntityType,
  RentOpsRecordChange,
  RentOpsRecordPatchUpdate,
  RentOpsSecurityDeposit,
  RentOpsSnapshot,
  RentOpsWorkspaceCollection,
  RentOpsSubsidyContract,
  RentOpsTenancy,
  RentOpsUnit,
  RentOpsLeaseTerm,
  ApplicantPublicView,
  DashboardSummary,
} from "../../../shared/rent-ops-contracts";
import { deriveOperationalScheduleRegister, validateReportFilters, deriveApplicantPipeline, deriveCollectedIncome, deriveDashboardSummary, deriveDashboardWorkspace, deriveDepositLiability, deriveDelinquency, deriveFixedReport, deriveHap, deriveLeaseExpirations, deriveRentRoll, deriveScheduledIncome, deriveScheduledVsCollected, deriveTenantLedger, deriveTenantProfile, toApplicantPublicView } from "../domain/reports";
import { assertApplicationStatusTransition, assertCents, assertPositiveCents, assertPrivateStorageKey, buildReversal, documentReferenceViolations, effectiveSchedules, RentOpsInvariantError, validateAllocation, validateSnapshot } from "../domain/invariants";
import { addDays, addMonths, nowIsoDate, nowIsoTimestamp } from "../domain/dates";
import { isPublicApplicationInventory, serializePublicListings } from "../presentation/public";
export { isPublicApplicationInventory } from "../presentation/public";
import { createResumeToken, DEFAULT_RESUME_TOKEN_TTL_MS, resolveResumeToken } from "./tokens";
import { MagicLinkDeliveryError } from "./notifier";
import { assertExactVersion, exactVersion, hasExactVersion, type ContentAddressedObjectStore, type SourceBinaryBinding, type StorageByteStream, type StorageReadAdapter, type StorageVersionOptions, type VerifiedObjectOpen } from "../storage";

export interface ApplicationConversionFacts {
  billingFrequency: "monthly";
  propertyId: string;
  unitId: string;
  plannedMoveInOn: string;
  leaseStatus: RentOpsLeaseTerm["status"];
  contractStartOn: string;
  contractEndOn?: string;
  monthToMonth: boolean;
  baseRentCents: Cents;
  chargeDefinitionId: string;
  category: NonNullable<RentOpsRecurringChargeSchedule["category"]>;
  scheduleDescription: string;
  primaryFinanciallyResponsible: boolean;
  members: Array<{
    applicationMemberId: string;
    role: NonNullable<RentOpsHouseholdMembership["role"]>;
    isFinanciallyResponsible: boolean;
    relationship?: string;
  }>;
}

export interface RecurringScheduleSuccessorInput {
  billingFrequency?: "monthly";
  /** Target-only id supplied for retry-safe creation. */
  id: string;
  expectedRevision: number;
  action: "replace" | "end";
  /** Manual boundary at which the replacement or terminal tombstone begins. */
  effectiveFrom: string;
  /** Required only for replacements. End tombstones never carry money. */
  amountCents?: Cents;
}

export interface VerifiedDocumentUploadInput {
  type: RentOpsDocument["type"];
  fileName: string;
  mimeType: string;
  bytes?: Uint8Array;
  stream?: StorageByteStream;
  sizeBytes?: number;
  checksumSha256?: string;
  requirementId?: string;
  documentId?: string;
}

export interface VerifiedDocumentArchiveInput extends VerifiedDocumentUploadInput {
  propertyId?: string;
  unitId?: string;
  personId?: string;
  tenancyId?: string;
  applicationId?: string;
  sourceBinaryBinding: {
    bindingId?: string;
    sourceSystem?: string;
    sourceCollection?: string;
    sourceIdHash?: string;
    importRunId?: string;
  };
}

export interface RentOpsDocumentServiceOptions {
  /** Read-only runtime/admin seam used for exact-version downloads/checks. */
  documentStorage?: StorageReadAdapter;
  documentStore?: StorageReadAdapter;
  /** Separate identity/seam for applicant uploads and verified object writes. */
  documentUploadStorage?: ContentAddressedObjectStore;
  documentUploadStore?: ContentAddressedObjectStore;
  /** Test/dev-only fallback when a synthetic repository has no SQL binding table. */
  allowEphemeralDocumentBindings?: boolean;
  /** A durable/manual-review sink; verified objects are never auto-deleted. */
  onDocumentOrphaned?: (input: { binding: RentOpsDocumentObjectBinding; reason: "database_binding_failed" }) => Promise<void> | void;
  /** Internal transaction facade hook so synthetic binding state survives a transaction. */
  ephemeralDocumentBindings?: Map<string, RentOpsDocumentObjectBinding>;
}

const MAX_DOCUMENT_NAME = 240;
const MAX_DOCUMENT_MIME = 120;
// Source filenames may contain ordinary punctuation; paths/control characters remain forbidden.
const SAFE_DOCUMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()',&\-]{0,239}$/;
const SAFE_DOCUMENT_MIMES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
]);

export interface RentOpsAdminPatchContext {
  /** Authenticated server-side admin subject; never accepted from JSON. */
  actorSubject: string;
  /** Server clock value; never accepted from JSON. */
  occurredAt: string;
}

const PATCH_FIELDS: Record<RentOpsPatchEntityType, ReadonlySet<string>> = {
  charge_definition: new Set(["displayName", "active"]),
  property: new Set(["name", "slug", "address", "propertyType", "state", "operatingContact"]),
  unit: new Set(["propertyId", "unitNumber", "unitType", "bedrooms", "bathrooms", "squareFeet", "marketRentCents", "defaultDepositCents", "readiness", "listing", "amenities", "accessNotes"]),
  person: new Set(["firstName", "lastName", "email", "phone", "phoneMethods", "renterInsuranceExpiresOn", "archived"]),
  household_membership: new Set(["tenancyId", "applicationId", "accountPersonId", "personId", "role", "relationship", "isFinanciallyResponsible"]),
  tenancy: new Set(["propertyId", "unitId", "primaryPersonId", "status", "plannedMoveInOn", "actualMoveInOn", "noticeOn", "expectedMoveOutOn", "actualMoveOutOn", "applicationId", "endedAt"]),
  lease_term: new Set(["tenancyId", "status", "contractStartOn", "contractEndOn", "monthToMonth", "signedOn", "executedDocumentId", "renewalOfId"]),
  security_deposit: new Set(["propertyId", "unitId", "tenancyId", "personId", "type", "amountHeldCents", "receivedOn", "dispositionStatus", "disposedOn", "dispositionNotes"]),
  // HAP contract rows do not yet carry manual knowledge columns for their
  // amounts, dates, agency, or links.  Status is the only safe v7 edit.
  subsidy_contract: new Set(["status"]),
  application: new Set(["status", "email", "firstName", "lastName", "phone", "propertyId", "unitId", "submittedOn", "certificationAcceptedOn", "rentalHistory", "employment", "householdSummary", "preferences", "voucher", "pets", "vehicles", "emergencyContact", "profileAnswers"]),
  document: new Set(["propertyId", "unitId", "personId", "tenancyId", "applicationId", "type", "state", "fileName", "mimeType"]),
  activity: new Set(["propertyId", "unitId", "personId", "tenancyId", "applicationId", "type", "summary", "detail"]),
};

const PATCH_KNOWLEDGE: Record<RentOpsPatchEntityType, Readonly<Record<string, string>>> = {
  charge_definition: {displayName: "displayNameKnowledge", active: "activeKnowledge"},
  property: { name: "nameKnowledge", address: "addressKnowledge", propertyType: "propertyTypeKnowledge", state: "stateKnowledge", operatingContact: "operatingContactKnowledge" },
  unit: { propertyId: "propertyLinkKnowledge", unitNumber: "unitNumberKnowledge", unitType: "unitTypeKnowledge", readiness: "readinessKnowledge", listing: "listingKnowledge" },
  person: { firstName: "firstNameKnowledge", lastName: "lastNameKnowledge", email: "emailKnowledge", phone: "phoneKnowledge", archived: "archivedKnowledge" },
  household_membership: { role: "roleKnowledge", relationship: "relationshipKnowledge", isFinanciallyResponsible: "responsibilityKnowledge" },
  tenancy: { propertyId: "propertyLinkKnowledge", unitId: "unitLinkKnowledge", primaryPersonId: "primaryPersonLinkKnowledge", status: "statusKnowledge", plannedMoveInOn: "plannedMoveInKnowledge", actualMoveInOn: "actualMoveInKnowledge", noticeOn: "noticeKnowledge", expectedMoveOutOn: "expectedMoveOutKnowledge", actualMoveOutOn: "actualMoveOutKnowledge", endedAt: "endedAtKnowledge" },
  lease_term: { tenancyId: "tenancyLinkKnowledge", status: "statusKnowledge", contractStartOn: "contractStartKnowledge", contractEndOn: "contractEndKnowledge", signedOn: "signedOnKnowledge", monthToMonth: "monthToMonthKnowledge" },
  security_deposit: { propertyId: "propertyLinkKnowledge", unitId: "unitLinkKnowledge", personId: "personLinkKnowledge", type: "typeKnowledge", receivedOn: "receivedOnKnowledge", dispositionStatus: "dispositionStatusKnowledge" },
  subsidy_contract: { status: "statusKnowledge" },
  application: { status: "statusKnowledge", email: "emailKnowledge", firstName: "firstNameKnowledge", lastName: "lastNameKnowledge", phone: "phoneKnowledge", propertyId: "propertyLinkKnowledge", unitId: "unitLinkKnowledge", submittedOn: "submittedOnKnowledge", certificationAcceptedOn: "certificationAcceptedOnKnowledge" },
  document: { type: "typeKnowledge", state: "stateKnowledge" },
  activity: { type: "typeKnowledge", summary: "summaryKnowledge", propertyId: "propertyLinkKnowledge", unitId: "unitLinkKnowledge", personId: "personLinkKnowledge", tenancyId: "tenancyLinkKnowledge", applicationId: "applicationLinkKnowledge" },
};

/** New native records use the same explicit-field knowledge map as manual PATCH. */
function manualCreationKnowledge<T extends RentOpsTenancy | RentOpsLeaseTerm | RentOpsProperty | RentOpsUnit | RentOpsPerson>(type: "tenancy" | "lease_term" | "property" | "unit" | "person", value: T): T {
  if (value.source) return value;
  const knowledge: Record<string, string> = {};
  const fields = value as unknown as Record<string, unknown>;
  if (fields.createdAt !== undefined && fields.createdAt !== null) knowledge.createdAtKnowledge = "manual";
  for (const [field, marker] of Object.entries(PATCH_KNOWLEDGE[type])) {
    if (fields[field] !== undefined && fields[field] !== null) knowledge[marker] = "manual";
  }
  return { ...value, ...knowledge };
}

const PATCH_COLLECTIONS: Record<RentOpsPatchEntityType, keyof RentOpsSnapshot> = {
  charge_definition: "chargeDefinitions",
  property: "properties",
  unit: "units",
  person: "people",
  household_membership: "householdMemberships",
  tenancy: "tenancies",
  lease_term: "leaseTerms",
  security_deposit: "securityDeposits",
  subsidy_contract: "subsidyContracts",
  application: "applications",
  document: "documents",
  activity: "activityEvents",
};

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) return left.length === (right as unknown[]).length && left.every((value, index) => jsonEqual(value, (right as unknown[])[index]));
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord).sort();
  const otherKeys = Object.keys(rightRecord).sort();
  return keys.length === otherKeys.length && keys.every((key, index) => key === otherKeys[index] && jsonEqual(leftRecord[key], rightRecord[key]));
}

function assertTargetId(value: string, label: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9:_-]{1,160}$/.test(value)) throw new RentOpsInvariantError(`${label} is invalid`);
}

function assertIsoDate(value: string, label: string): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RentOpsInvariantError(`${label} is invalid`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new RentOpsInvariantError(`${label} is invalid`);
}

function assertAdminPatchContext(context: RentOpsAdminPatchContext): void {
  if (!context.actorSubject?.trim()) throw new RentOpsInvariantError("Authenticated admin subject is required");
  const occurredAt = new Date(context.occurredAt);
  if (!context.occurredAt || !Number.isFinite(occurredAt.getTime()) || occurredAt.toISOString() !== context.occurredAt) throw new RentOpsInvariantError("Server mutation time is invalid");
}

function mergePatchValue(current: unknown, incoming: unknown): unknown {
  if (incoming && typeof incoming === "object" && !Array.isArray(incoming) && current && typeof current === "object" && !Array.isArray(current)) {
    return { ...(current as Record<string, unknown>), ...(incoming as Record<string, unknown>) };
  }
  return incoming;
}

function assertPatchValueSafe(value: unknown, seen = new Set<object>()): void {
  if (Array.isArray(value)) {
    for (const item of value) assertPatchValueSafe(item, seen);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new RentOpsInvariantError("Patch contains a cyclic value");
  seen.add(value);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/source|provenance|knowledge|storage|checksum|hash|token|actor|occurred|record.?revision/i.test(key)) throw new RentOpsInvariantError("Patch contains a provenance or server-controlled field");
    assertPatchValueSafe(child, seen);
  }
  seen.delete(value);
}

function snakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function patchRow(snapshot: RentOpsSnapshot, entityType: RentOpsPatchEntityType, targetId: string): Record<string, unknown> | undefined {
  const collection = snapshot[PATCH_COLLECTIONS[entityType]] as unknown as Array<Record<string, unknown>>;
  return collection.find((candidate) => candidate.id === targetId);
}

function assertDocumentName(fileName: string): string {
  if (typeof fileName !== "string" || fileName.length < 1 || fileName.length > MAX_DOCUMENT_NAME || !SAFE_DOCUMENT_NAME.test(fileName) || fileName.includes("..")) throw new RentOpsInvariantError("Document filename is invalid");
  return fileName;
}

function assertDocumentMime(mimeType: string): string {
  if (typeof mimeType !== "string" || mimeType.length < 1 || mimeType.length > MAX_DOCUMENT_MIME || mimeType !== mimeType.trim() || mimeType.includes("\r") || mimeType.includes("\n") || !SAFE_DOCUMENT_MIMES.has(mimeType.toLowerCase())) throw new RentOpsInvariantError("Document content type is invalid");
  return mimeType.toLowerCase();
}

const IMPORTED_DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function hasDocumentMagic(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === "application/octet-stream") return true;
  const value = Buffer.from(bytes);
  if (mimeType === IMPORTED_DOCX_MIME) return value.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (mimeType === "application/pdf") return value.subarray(0, 5).toString("ascii") === "%PDF-";
  if (mimeType === "image/jpeg") return value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff;
  if (mimeType === "image/png") return value.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/webp") return value.length >= 12 && value.subarray(0, 4).toString("ascii") === "RIFF" && value.subarray(8, 12).toString("ascii") === "WEBP";
  if (mimeType === "text/plain") return !value.includes(0);
  return false;
}

function assertDocumentBytes(bytes: Uint8Array, mimeType: string): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) throw new RentOpsInvariantError("Document upload is empty");
  if (bytes.byteLength > 50 * 1024 * 1024) throw new RentOpsInvariantError("Document upload is too large");
  if (!hasDocumentMagic(bytes, mimeType)) throw new RentOpsInvariantError("Document content does not match its declared content type");
  return bytes;
}

function validatedDocumentStream(source: StorageByteStream, mimeType: string): Readable {
  let sizeBytes = 0;
  let prefix = Buffer.alloc(0);
  const validator = new Transform({
    transform(raw: Buffer | string, _encoding, callback) {
      const chunk = Buffer.from(raw);
      sizeBytes += chunk.byteLength;
      if (sizeBytes > 50 * 1024 * 1024) { callback(new RentOpsInvariantError("Document upload is too large")); return; }
      if (prefix.byteLength < 16) prefix = Buffer.concat([prefix, chunk.subarray(0, 16 - prefix.byteLength)]);
      callback(null, chunk);
    },
    flush(callback) {
      if (sizeBytes < 1) { callback(new RentOpsInvariantError("Document upload is empty")); return; }
      if (!hasDocumentMagic(prefix, mimeType)) { callback(new RentOpsInvariantError("Document content does not match its declared content type")); return; }
      callback();
    },
  });
  return Readable.from(source as AsyncIterable<Uint8Array> | Readable).pipe(validator);
}

function bindingFromStorage(documentId: string, result: { backend: string; logicalKey: string; checksumSha256: string; sizeBytes: number; immutableGeneration?: string; immutableVersion?: string; verifiedAt?: string }): RentOpsDocumentObjectBinding {
  const version = exactVersion(result);
  if (!hasExactVersion(version) || !result.verifiedAt || !Number.isFinite(Date.parse(result.verifiedAt))) throw new RentOpsInvariantError("Verified document object binding is incomplete");
  return {
    documentId,
    bindingKind: "applicant",
    backend: result.backend,
    logicalKey: result.logicalKey,
    checksumSha256: result.checksumSha256,
    sizeBytes: result.sizeBytes,
    immutableGeneration: version.immutableGeneration,
    immutableVersion: version.immutableVersion,
    verifiedAt: result.verifiedAt,
  };
}

function documentStorageKey(binding: RentOpsDocumentObjectBinding): string {
  // The domain document row accepts only a private relative key.  Keep the
  // canonical content-addressed `sha256:` key solely in the server binding.
  return `documents/${binding.checksumSha256}`;
}

function isWritableDocumentStorage(value: StorageReadAdapter | undefined): value is ContentAddressedObjectStore {
  return Boolean(value && typeof (value as Partial<ContentAddressedObjectStore>).putIfAbsent === "function");
}

async function verifyStoredObject(storage: StorageReadAdapter, result: { backend: string; logicalKey: string; checksumSha256: string; sizeBytes: number; immutableGeneration?: string; immutableVersion?: string; verifiedAt?: string }): Promise<RentOpsDocumentObjectBinding> {
    const binding = bindingFromStorage("pending", result);
    const version: StorageVersionOptions = { immutableGeneration: binding.immutableGeneration, immutableVersion: binding.immutableVersion };
    const stat = await storage.stat(binding.logicalKey, version);
    if (!stat) throw new RentOpsInvariantError("Verified document object is missing");
    if (stat.backend !== binding.backend || stat.logicalKey !== binding.logicalKey || stat.checksumSha256 !== binding.checksumSha256 || stat.sizeBytes !== binding.sizeBytes) throw new RentOpsInvariantError("Verified document object changed");
    assertExactVersion(stat, version, true);
    const verified = await storage.verify(binding.logicalKey, { expectedChecksumSha256: binding.checksumSha256, expectedSizeBytes: binding.sizeBytes, ...version });
    if (verified.backend !== binding.backend || verified.logicalKey !== binding.logicalKey || verified.verificationState !== "verified" || verified.checksumSha256 !== binding.checksumSha256 || verified.sizeBytes !== binding.sizeBytes) throw new RentOpsInvariantError("Verified document object could not be verified");
    assertExactVersion(verified, version, true);
    return { ...binding, verifiedAt: verified.verifiedAt ?? binding.verifiedAt };
  }

async function prepareVerifiedDocument(storage: ContentAddressedObjectStore, nowClock: () => Date, input: VerifiedDocumentUploadInput | VerifiedDocumentArchiveInput, refs: { applicationId?: string; propertyId?: string; unitId?: string; personId?: string; tenancyId?: string }, sourceBinaryBinding?: VerifiedDocumentArchiveInput["sourceBinaryBinding"]): Promise<{ document: RentOpsDocument; binding: RentOpsDocumentObjectBinding }> {
    const mimeType = sourceBinaryBinding && (input.mimeType === "application/octet-stream" || input.mimeType === IMPORTED_DOCX_MIME) ? input.mimeType : assertDocumentMime(input.mimeType);
    const fileName = assertDocumentName(input.fileName);
    if (input.bytes === undefined && input.stream === undefined) throw new RentOpsInvariantError("Document upload body is missing");
    if (input.bytes !== undefined && input.stream !== undefined) throw new RentOpsInvariantError("Document upload body is ambiguous");
    const bytes = input.bytes === undefined ? undefined : assertDocumentBytes(input.bytes, mimeType);
    if (sourceBinaryBinding && (!sourceBinaryBinding.bindingId || !sourceBinaryBinding.importRunId || !sourceBinaryBinding.sourceSystem || !sourceBinaryBinding.sourceCollection)) throw new RentOpsInvariantError("Imported document binding requires an exact source binary, import run, system, and collection");
    const storageBinding: SourceBinaryBinding | undefined = sourceBinaryBinding ? {
      bindingId: sourceBinaryBinding.bindingId,
      sourceSystem: sourceBinaryBinding.sourceSystem,
      sourceCollection: sourceBinaryBinding.sourceCollection,
      sourceIdHash: sourceBinaryBinding.sourceIdHash as SourceBinaryBinding["sourceIdHash"],
      importRunId: sourceBinaryBinding.importRunId,
    } : undefined;
    const stored = await storage.putIfAbsent({
      ...(bytes ? { bytes, expectedSizeBytes: bytes.byteLength } : { stream: validatedDocumentStream(input.stream!, mimeType), ...(input.sizeBytes !== undefined ? { expectedSizeBytes: input.sizeBytes } : {}) }),
      expectedChecksumSha256: input.checksumSha256,
      sourceBinaryBinding: storageBinding,
    });
    if (stored.verificationState !== "verified") throw new RentOpsInvariantError("Verified document object could not be verified");
    if (input.checksumSha256 && stored.checksumSha256 !== input.checksumSha256.toLowerCase() || input.sizeBytes !== undefined && stored.sizeBytes !== input.sizeBytes) throw new RentOpsInvariantError("Verified document object differs from the source binary");
    if (stored.backend !== storage.backend || stored.logicalKey !== `sha256:${stored.checksumSha256}`) throw new RentOpsInvariantError("Verified document object identity is invalid");
    const binding = await verifyStoredObject(storage, stored);
    const documentId = input.documentId ?? `document:verified:${randomUUID()}`;
    const now = nowClock().toISOString();
    const objectBinding: RentOpsDocumentObjectBinding = {
      ...binding,
      documentId,
      bindingKind: sourceBinaryBinding ? "import" : "applicant",
      ...(sourceBinaryBinding?.bindingId ? { sourceBinaryId: sourceBinaryBinding.bindingId } : {}),
      ...(sourceBinaryBinding?.importRunId ? { importRunId: sourceBinaryBinding.importRunId } : {}),
      ...(sourceBinaryBinding?.sourceSystem ? { sourceSystem: sourceBinaryBinding.sourceSystem } : {}),
      ...(sourceBinaryBinding?.sourceCollection ? { sourceCollection: sourceBinaryBinding.sourceCollection } : {}),
    };
    const document: RentOpsDocument = {
      id: documentId,
      applicationId: refs.applicationId,
      propertyId: refs.propertyId,
      unitId: refs.unitId,
      personId: refs.personId,
      tenancyId: refs.tenancyId,
      type: input.type,
      typeKnowledge: "source",
      state: "verified",
      stateKnowledge: "source",
      fileName,
      mimeType,
      sizeBytes: binding.sizeBytes,
      checksumSha256: binding.checksumSha256,
      storageKey: documentStorageKey(objectBinding),
      uploadedAt: now,
      verifiedAt: binding.verifiedAt,
      availability: "verified",
      storageKeyKnowledge: "source",
    };
    return { document, binding: objectBinding };
  }

/** Import preparation only: no repository reads, transactions, or persistence. */
export async function prepareVerifiedImportedDocument(storage: ContentAddressedObjectStore, input: VerifiedDocumentArchiveInput, now: () => Date = () => new Date()): Promise<{ document: RentOpsDocument; binding: RentOpsDocumentObjectBinding }> {
  if (!input.documentId || !input.checksumSha256 || !Number.isSafeInteger(input.sizeBytes)) throw new RentOpsInvariantError("Imported document requires exact identity, checksum and size");
  return prepareVerifiedDocument(storage, now, input, input, input.sourceBinaryBinding);
}

export class RentOpsService {
  private readonly documentStorage?: StorageReadAdapter;
  private readonly documentUploadStorage?: ContentAddressedObjectStore;
  private readonly allowEphemeralDocumentBindings: boolean;
  private readonly onDocumentOrphaned?: RentOpsDocumentServiceOptions["onDocumentOrphaned"];
  private readonly ephemeralDocumentBindings: Map<string, RentOpsDocumentObjectBinding>;

  constructor(
    readonly repository: RentOpsRepository,
    readonly now: () => Date = () => new Date(),
    readonly resumeTokenTtlMs = DEFAULT_RESUME_TOKEN_TTL_MS,
    readonly resumeTokenNotifier?: (input: { applicationId: string; email: string; token: string; expiresAt: string }) => Promise<void>,
    readonly exposeResumeToken = false,
    documentOptions: RentOpsDocumentServiceOptions = {},
  ) {
    this.documentStorage = documentOptions.documentStorage ?? documentOptions.documentStore;
    const configuredUploadStorage = documentOptions.documentUploadStorage ?? documentOptions.documentUploadStore;
    // Keep the legacy one-store constructor useful for synthetic/dev callers,
    // but never silently grant a production runtime identity write access.
    this.documentUploadStorage = configuredUploadStorage
      ?? (process.env.NODE_ENV !== "production" && isWritableDocumentStorage(this.documentStorage) ? this.documentStorage : undefined);
    this.allowEphemeralDocumentBindings = documentOptions.allowEphemeralDocumentBindings ?? process.env.NODE_ENV !== "production";
    this.onDocumentOrphaned = documentOptions.onDocumentOrphaned;
    this.ephemeralDocumentBindings = documentOptions.ephemeralDocumentBindings ?? new Map<string, RentOpsDocumentObjectBinding>();
  }

  async snapshot(): Promise<RentOpsSnapshot> { return this.repository.getSnapshot(); }
  async operationalSnapshot(): Promise<RentOpsSnapshot> {
    return this.repository.getOperationalSnapshot ? this.repository.getOperationalSnapshot() : this.snapshot();
  }
  async reportSnapshot(): Promise<RentOpsSnapshot> {
    return this.repository.getReportSnapshot ? this.repository.getReportSnapshot() : this.operationalSnapshot();
  }
  async getOperationalScheduleRegister(filters: RentOpsFilters = {}) {
    // Tenancy, person source status and complete lineage must be read together.
    // The operational repository omits large document/activity histories.
    const snapshot = this.repository.getScheduleSnapshot ? await this.repository.getScheduleSnapshot() : await this.operationalSnapshot();
    return measureRentOps("derive", () => deriveOperationalScheduleRegister(snapshot, filters));
  }
  async workspaceCollection<K extends RentOpsWorkspaceCollection>(name: K): Promise<RentOpsSnapshot[K]> {
    return this.repository.getWorkspaceCollection
      ? this.repository.getWorkspaceCollection(name)
      : (await this.operationalSnapshot())[name];
  }
  async workspaceSnapshot(): Promise<RentOpsSnapshot> {
    return this.repository.getWorkspaceSnapshot ? this.repository.getWorkspaceSnapshot() : this.snapshot();
  }

  async chargeDefinitions(): Promise<RentOpsChargeDefinition[]> {
    return this.repository.getChargeDefinitions
      ? this.repository.getChargeDefinitions()
      : (await this.snapshot()).chargeDefinitions;
  }

  /**
   * Read one immutable v9 historical case through the repository boundary.
   * The route owns the positive serializer; this service method deliberately
   * does not expose the wider projection or merge it into native applications.
   */
  async applicationHistoryCase(id: string): Promise<RentOpsApplicationCase | undefined> {
    return this.repository.getApplicationHistoryCaseById(id);
  }

  /** Compatibility spelling for callers that mirror the repository method. */
  async getApplicationHistoryCaseById(id: string): Promise<RentOpsApplicationCase | undefined> {
    return this.applicationHistoryCase(id);
  }

  async dashboard(filters: RentOpsFilters = {}): Promise<DashboardSummary> {
    validateReportFilters("dashboard", filters);
    const snapshot = await this.reportSnapshot();
    return measureRentOps("derive", () => deriveDashboardSummary(snapshot, filters));
  }

  async workspaceDashboard(filters: RentOpsFilters = {}) {
    validateReportFilters("dashboard", filters);
    const snapshot = await this.reportSnapshot();
    return measureRentOps("derive", () => deriveDashboardWorkspace(snapshot, filters));
  }

  async report(name: Parameters<typeof deriveFixedReport>[1], filters: RentOpsFilters = {}): Promise<unknown[]> {
    const snapshot = await this.reportSnapshot();
    return measureRentOps("derive", () => deriveFixedReport(snapshot, name, filters));
  }

  async tenantProfileContext(personId: string, filters: RentOpsFilters = {}) {
    const snapshot = await this.operationalSnapshot();
    return { profile: measureRentOps("derive", () => deriveTenantProfile(snapshot, personId, filters)), completeSchedules: snapshot.recurringSchedules };
  }

  async tenantProfile(personId: string, filters: RentOpsFilters = {}) {
    const snapshot = await this.operationalSnapshot();
    return measureRentOps("derive", () => deriveTenantProfile(snapshot, personId, filters));
  }

  private async recordAdminChange(summary: string, refs: { propertyId?: string; unitId?: string; personId?: string; tenancyId?: string; applicationId?: string } = {}): Promise<void> {
    await this.repository.saveActivity({ id: `audit:${randomUUID()}`, ...refs, type: "system", occurredAt: this.now().toISOString(), actor: "admin", summary });
  }

  private withRepository(repository: RentOpsRepository): RentOpsService {
    return new RentOpsService(repository, this.now, this.resumeTokenTtlMs, this.resumeTokenNotifier, this.exposeResumeToken, {
      documentStorage: this.documentStorage,
      documentUploadStorage: this.documentUploadStorage,
      allowEphemeralDocumentBindings: this.allowEphemeralDocumentBindings,
      onDocumentOrphaned: this.onDocumentOrphaned,
      ephemeralDocumentBindings: this.ephemeralDocumentBindings,
    });
  }

  async startApplication(input: ApplicantStartInput): Promise<{ application: ApplicantPublicView; resumeToken?: string; expiresAt: string; accepted: boolean }> {
    if (!this.resumeTokenNotifier && !this.exposeResumeToken) throw new RentOpsInvariantError("Magic-link delivery is not configured; application start is disabled");
    const now = this.now();
    const { token, hash } = createResumeToken();
    const expiresAt = new Date(now.getTime() + this.resumeTokenTtlMs).toISOString();
    const application: RentOpsApplicationRecord = {
      id: `application:${randomUUID()}`,
      sourceType: "public_portal",
      status: "draft",
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      rentalHistory: { currentAddress: input.currentAddress },
      resumeTokenHash: hash,
      resumeTokenExpiresAt: expiresAt,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await this.repository.saveApplication(application);
    if (this.resumeTokenNotifier) {
      try {
        await this.resumeTokenNotifier({ applicationId: application.id, email: application.email, token, expiresAt });
      } catch (error) {
        const deliveryError = error instanceof MagicLinkDeliveryError
          ? error
          : new MagicLinkDeliveryError(`Magic-link delivery failure: ${error instanceof Error ? error.message : "provider error"}`, { cause: error });
        // A failed delivery must not leave a live but unreachable draft/token.
        try {
          await this.repository.saveApplication({ ...application, status: "withdrawn", resumeTokenHash: undefined, resumeTokenExpiresAt: undefined, updatedAt: this.now().toISOString() });
        } catch (revocationError) {
          // Preserve a generic provider-facing failure even if the cleanup
          // write also fails; diagnostics remain on the server side only.
          throw new MagicLinkDeliveryError("Magic-link delivery failed", { cause: revocationError });
        }
        throw deliveryError;
      }
    }
    const snapshot = await this.snapshot();
    return { application: toApplicantPublicView(snapshot, application), resumeToken: this.exposeResumeToken ? token : undefined, expiresAt, accepted: true };
  }

  private async applicationForToken(token: string): Promise<RentOpsApplicationRecord> {
    const application = await resolveResumeToken(this.repository, token, this.now());
    if (!application) throw new RentOpsInvariantError("Application resume token invalid or expired");
    return application;
  }

  private assertPublicEditable(application: RentOpsApplicationRecord): void {
    if (application.status !== "draft" && application.status !== "missing_information") {
      throw new RentOpsInvariantError("Application is no longer editable");
    }
  }

  /** Resolve the bearer token before a route begins consuming upload bytes. */
  async authorizePublicDocumentUpload(token: string): Promise<void> {
    const application = await this.applicationForToken(token);
    this.assertPublicEditable(application);
  }

  async publicApplication(token: string): Promise<ApplicantPublicView> {
    const application = await this.applicationForToken(token);
    return toApplicantPublicView(await this.snapshot(), application);
  }

  async savePublicApplication(token: string, input: ApplicantSaveInput): Promise<ApplicantPublicView> {
    const application = await this.applicationForToken(token);
    this.assertPublicEditable(application);
    if (input.propertyId !== undefined || input.unitId !== undefined || application.propertyId !== undefined || application.unitId !== undefined) {
      const snapshot = await this.snapshot();
      const selectedPropertyId = input.propertyId ?? application.propertyId;
      const selectedUnitId = input.unitId ?? application.unitId;
      if (selectedPropertyId !== undefined || selectedUnitId !== undefined) {
        if (!isPublicApplicationInventory(snapshot, selectedPropertyId, selectedUnitId, nowIsoDate(this.now()))) {
          // Deliberately omit the requested IDs and all source details. The
          // public caller only learns that the inventory is unavailable.
          throw new RentOpsInvariantError("Selected application unit is unavailable");
        }
      }
    }
    const updated: RentOpsApplicationRecord = { ...application, ...input, updatedAt: this.now().toISOString() };
    await this.repository.saveApplication(updated);
    return toApplicantPublicView(await this.snapshot(), updated);
  }

  async publicApplicationOptions(): Promise<Array<{ id: string; name: string; slug: string; units: Array<{ id: string; unitNumber: string; unitType?: string; bedrooms?: number; bathrooms?: number; marketRentCents?: Cents }> }>> {
    const snapshot = this.repository.getPublicInventory ? await this.repository.getPublicInventory() : await this.snapshot();
    const asOf = nowIsoDate(this.now());
    return snapshot.properties.filter((property) => isPublicApplicationInventory(property, undefined, snapshot.tenancies, asOf)).map((property) => ({
      id: property.id,
      name: property.name,
      slug: property.slug,
      units: snapshot.units.filter((unit) => isPublicApplicationInventory(property, unit, snapshot.tenancies, asOf)).map((unit) => ({ id: unit.id, unitNumber: unit.unitNumber, unitType: unit.unitType, bedrooms: unit.bedrooms, bathrooms: unit.bathrooms, marketRentCents: unit.marketRentCents })),
    }));
  }

  async publicApplicationListings() {
    const inventory = this.repository.getPublicInventory ? await this.repository.getPublicInventory() : await this.snapshot();
    const asOf = nowIsoDate(this.now());
    return serializePublicListings(inventory.properties
      .filter(property => isPublicApplicationInventory(property, undefined, inventory.tenancies, asOf))
      .map(property => ({ ...property, trustedNative: !property.source,
        units: inventory.units.filter(unit => isPublicApplicationInventory(property, unit, inventory.tenancies, asOf))
          .map(unit => ({ ...unit, trustedNative: !unit.source })),
      })));
  }

  async submitPublicApplication(token: string): Promise<ApplicantPublicView> {
    const application = await this.applicationForToken(token);
    if (application.status === "submitted" || application.status === "under_review" || application.status === "approved" || application.status === "converted") return toApplicantPublicView(await this.snapshot(), application);
    if (application.status !== "draft" && application.status !== "missing_information") throw new RentOpsInvariantError("Application cannot be submitted from its current state");
    if (!application.certificationAcceptedOn) throw new RentOpsInvariantError("Applicant certification is required before submission");
    const snapshot = await this.snapshot();
    const unresolvedRequirements = await this.unresolvedApplicationRequirements(snapshot, application.id);
    if (unresolvedRequirements.length) throw new RentOpsInvariantError("Verified upload required for every configured application document requirement");
    const updated: RentOpsApplicationRecord = { ...application, status: "submitted", submittedOn: application.submittedOn ?? nowIsoDate(this.now()), updatedAt: this.now().toISOString() };
    await this.repository.saveApplication(updated);
    return toApplicantPublicView(await this.snapshot(), updated);
  }

  async certifyPublicApplication(token: string): Promise<ApplicantPublicView> {
    const application = await this.applicationForToken(token);
    this.assertPublicEditable(application);
    const updated: RentOpsApplicationRecord = { ...application, certificationAcceptedOn: nowIsoDate(this.now()), updatedAt: this.now().toISOString() };
    await this.repository.saveApplication(updated);
    return toApplicantPublicView(await this.snapshot(), updated);
  }

  async savePublicHouseholdMember(token: string, input: ApplicantHouseholdMemberInput): Promise<ApplicantPublicView> {
    const application = await this.applicationForToken(token);
    this.assertPublicEditable(application);
    const member: RentOpsApplicationHouseholdMember = { id: `application-member:${application.id}:${input.id ?? randomUUID()}`,
      applicationId: application.id, firstName: input.firstName, lastName: input.lastName, relationship: input.relationship, email: input.email, phone: input.phone, isMinor: input.isMinor };
    await this.repository.saveApplicationHouseholdMember(member);
    return toApplicantPublicView(await this.snapshot(), application);
  }

  async savePublicDocumentMetadata(_token: string, _input: { [key: string]: unknown }): Promise<ApplicantPublicView> {
    // Metadata is not evidence of a received document. Keep this legacy
    // endpoint side-effect free even after the verified binary path exists.
    throw new RentOpsInvariantError("Verified upload required; metadata-only document registration is unavailable");
  }

  private requireDocumentStorage(): StorageReadAdapter {
    if (!this.documentStorage) throw new RentOpsInvariantError("Verified upload required; private document storage is unavailable");
    return this.documentStorage;
  }

  private requireDocumentUploadStorage(): ContentAddressedObjectStore {
    if (!this.documentUploadStorage) throw new RentOpsInvariantError("Verified upload required; dedicated upload storage is unavailable");
    return this.documentUploadStorage;
  }


  private async persistVerifiedDocument(document: RentOpsDocument, binding: RentOpsDocumentObjectBinding, requirement?: RentOpsApplicationRequirement, adminActor?: string): Promise<RentOpsDocument> {
    const canBind = typeof this.repository.saveDocumentObjectBinding === "function";
    if (!canBind && !this.allowEphemeralDocumentBindings) throw new RentOpsInvariantError("Verified document storage binding is unavailable");
    try {
      await this.repository.transaction(async (repository) => {
        if (adminActor) {
          const currentSnapshot = await repository.getSnapshot();
          const current = currentSnapshot.tenancies.find(t => t.id === document.tenancyId);
          if (!current || current.primaryPersonId !== document.personId || current.propertyId !== document.propertyId || current.unitId !== document.unitId || !currentSnapshot.units.some(u => u.id === current.unitId && u.propertyId === current.propertyId) || !currentSnapshot.people.some(p => p.id === current.primaryPersonId)) throw new RentOpsInvariantError("Tenancy scope changed during upload");
        }
        await repository.saveDocument(document);
        if (repository.saveDocumentObjectBinding) await repository.saveDocumentObjectBinding(binding);
        if (requirement) {
          await repository.saveApplicationRequirement({ ...requirement, status: "received", documentId: document.id, resolvedOn: nowIsoDate(this.now()) });
        }
        await repository.saveActivity({ id: `activity:document:${document.id}:verified`, applicationId: document.applicationId, propertyId: document.propertyId, unitId: document.unitId, personId: document.personId, tenancyId: document.tenancyId, type: "system", occurredAt: this.now().toISOString(), actor: adminActor ?? "system", summary: adminActor ? "Manager uploaded a verified lease PDF; signature status is not asserted" : "Verified document uploaded and bound to immutable storage object" });
      }, document.applicationId ? { lockApplicationId: document.applicationId } : adminActor ? { lockRecord: { entityType: "tenancy", targetId: document.tenancyId! } } : undefined);
    } catch (error) {
      // The verified object remains in storage for inventory/manual review.
      // Never attempt a compensating delete in this layer.
      try { await this.onDocumentOrphaned?.({ binding, reason: "database_binding_failed" }); } catch { /* preserve the database error */ }
      throw error;
    }
    if (!canBind) this.ephemeralDocumentBindings.set(document.id, binding);
    return document;
  }

  private async buildVerifiedDocument(input: VerifiedDocumentUploadInput | VerifiedDocumentArchiveInput, refs: { applicationId?: string; propertyId?: string; unitId?: string; personId?: string; tenancyId?: string }, sourceBinaryBinding?: VerifiedDocumentArchiveInput["sourceBinaryBinding"]): Promise<{ document: RentOpsDocument; binding: RentOpsDocumentObjectBinding }> {
    return prepareVerifiedDocument(this.requireDocumentUploadStorage(), this.now, input, refs, sourceBinaryBinding);
  }

  /** Store, verify, and bind an applicant's raw bearer-scoped upload. */
  async savePublicVerifiedDocument(token: string, input: VerifiedDocumentUploadInput): Promise<ApplicantPublicView> {
    const application = await this.applicationForToken(token);
    this.assertPublicEditable(application);
    if (input.documentId) throw new RentOpsInvariantError("Applicant document IDs are server-generated");
    const snapshot = await this.snapshot();
    let requirement: RentOpsApplicationRequirement | undefined;
    if (input.requirementId) {
      requirement = snapshot.applicationRequirements.find((candidate) => candidate.id === input.requirementId && candidate.applicationId === application.id);
      if (!requirement) throw new RentOpsInvariantError("Application requirement is not available");
      if (requirement.status === "waived" || requirement.status === "received" || requirement.documentId) throw new RentOpsInvariantError("Application requirement is already resolved");
    } else {
      const candidates = snapshot.applicationRequirements.filter((candidate) => candidate.applicationId === application.id && candidate.status !== "waived" && !candidate.documentId);
      if (candidates.length === 1) requirement = candidates[0];
      if (candidates.length > 1) throw new RentOpsInvariantError("An exact application requirement is required for this upload");
    }
    const { document, binding } = await this.buildVerifiedDocument(input, { applicationId: application.id });
    await this.persistVerifiedDocument(document, binding, requirement);
    return toApplicantPublicView(await this.snapshot(), (await this.repository.getApplicationById(application.id)) ?? application);
  }

  /** Manager asserts lease classification, never source provenance or signature status. */
  async saveManagerLeaseFile(tenancyId: string, input: Pick<VerifiedDocumentUploadInput, "fileName" | "mimeType" | "bytes" | "stream" | "sizeBytes">, actorSubject: string): Promise<RentOpsDocument> {
    if (!actorSubject.trim() || input.mimeType !== "application/pdf") throw new RentOpsInvariantError("Manager lease upload must be a PDF");
    const snapshot = await this.snapshot();
    const tenancy = snapshot.tenancies.find(t => t.id === tenancyId);
    if (!tenancy || !snapshot.people.some(p => p.id === tenancy.primaryPersonId) || !snapshot.units.some(u => u.id === tenancy.unitId && u.propertyId === tenancy.propertyId) || !snapshot.properties.some(p => p.id === tenancy.propertyId)) throw new RentOpsInvariantError("Tenancy not found");
    const { document, binding } = await this.buildVerifiedDocument({ ...input, type: "lease" }, { tenancyId: tenancy.id, personId: tenancy.primaryPersonId, propertyId: tenancy.propertyId, unitId: tenancy.unitId });
    document.typeKnowledge = "manual";
    document.stateKnowledge = "manual";
    binding.bindingKind = "admin";
    return this.persistVerifiedDocument(document, binding, undefined, actorSubject);
  }

  /** Import seam: transfer the verified RM/archive bytes before DB binding. */
  async archiveVerifiedDocument(input: VerifiedDocumentArchiveInput): Promise<RentOpsDocument> {
    const { document, binding } = await this.buildVerifiedDocument(input, input, input.sourceBinaryBinding);
    return this.persistVerifiedDocument(document, binding);
  }

  async transferVerifiedDocument(input: VerifiedDocumentArchiveInput): Promise<RentOpsDocument> {
    return this.archiveVerifiedDocument(input);
  }

  private async documentBinding(documentId: string): Promise<RentOpsDocumentObjectBinding | undefined> {
    if (this.repository.getDocumentObjectBinding) return this.repository.getDocumentObjectBinding(documentId);
    return this.ephemeralDocumentBindings.get(documentId);
  }

  private async rehashVerifiedStream(opened: VerifiedObjectOpen, binding: RentOpsDocumentObjectBinding): Promise<void> {
    const hash = createHash("sha256");
    let sizeBytes = 0;
    for await (const raw of opened.stream) {
      if (!(raw instanceof Uint8Array) && typeof raw !== "string") throw new RentOpsInvariantError("Verified document stream is invalid");
      const chunk = Buffer.from(raw as Uint8Array | string);
      sizeBytes += chunk.byteLength;
      if (sizeBytes > binding.sizeBytes) throw new RentOpsInvariantError("Verified document object changed");
      hash.update(chunk);
    }
    if (sizeBytes !== binding.sizeBytes || hash.digest("hex") !== binding.checksumSha256) throw new RentOpsInvariantError("Verified document object changed");
  }

  private async isResolvedApplicationDocument(document: RentOpsDocument): Promise<boolean> {
    if (document.state !== "verified" || document.availability !== "verified" || document.storageKeyKnowledge !== "source" || !document.storageKey || !document.checksumSha256 || !document.sizeBytes || !document.verifiedAt) return false;
    const binding = await this.documentBinding(document.id);
    if (!binding || binding.documentId !== document.id || document.storageKey !== documentStorageKey(binding) || binding.checksumSha256 !== document.checksumSha256 || binding.sizeBytes !== document.sizeBytes || !hasExactVersion(binding)) return false;
    const storage = this.documentStorage;
    if (!storage) return false;
    const version: StorageVersionOptions = { immutableGeneration: binding.immutableGeneration, immutableVersion: binding.immutableVersion };
    try {
      const opened = await storage.openVerified(binding.logicalKey, { expectedChecksumSha256: binding.checksumSha256, expectedSizeBytes: binding.sizeBytes, ...version });
      assertExactVersion(opened.verification, version, true);
      if (opened.verification.verificationState !== "verified" || opened.verification.checksumSha256 !== binding.checksumSha256 || opened.verification.sizeBytes !== binding.sizeBytes) return false;
      await this.rehashVerifiedStream(opened, binding);
      return true;
    } catch {
      return false;
    }
  }

  /** Open an authenticated admin download only after exact binding checks. */
  async openVerifiedDocument(documentId: string): Promise<{ document: RentOpsDocument; stream: import("node:stream").Readable }> {
    const document = (await this.snapshot()).documents.find((candidate) => candidate.id === documentId);
    if (!document) throw new RentOpsInvariantError("Document not found");
    if (document.state !== "verified" || document.availability !== "verified" || document.storageKeyKnowledge !== "source" || !document.storageKey || !document.checksumSha256 || !document.sizeBytes || !document.verifiedAt) throw new RentOpsInvariantError("Verified document download is unavailable");
    const binding = await this.documentBinding(document.id);
    if (!binding || document.storageKey !== documentStorageKey(binding) || binding.checksumSha256 !== document.checksumSha256 || binding.sizeBytes !== document.sizeBytes) throw new RentOpsInvariantError("Verified document binding is unavailable");
    const storage = this.requireDocumentStorage();
    const version: StorageVersionOptions = { immutableGeneration: binding.immutableGeneration, immutableVersion: binding.immutableVersion };
    if (!hasExactVersion(version)) throw new RentOpsInvariantError("Verified document binding version is missing");
    const stat = await storage.stat(binding.logicalKey, version);
    if (!stat || stat.checksumSha256 !== binding.checksumSha256 || stat.sizeBytes !== binding.sizeBytes) throw new RentOpsInvariantError("Verified document object changed");
    assertExactVersion(stat, version, true);
    const verified = await storage.verify(binding.logicalKey, { expectedChecksumSha256: binding.checksumSha256, expectedSizeBytes: binding.sizeBytes, ...version });
    assertExactVersion(verified, version, true);
    const opened = await storage.openVerified(binding.logicalKey, { expectedChecksumSha256: binding.checksumSha256, expectedSizeBytes: binding.sizeBytes, ...version });
    assertExactVersion(opened.verification, version, true);
    if (opened.verification.checksumSha256 !== binding.checksumSha256 || opened.verification.sizeBytes !== binding.sizeBytes) throw new RentOpsInvariantError("Verified document object changed");
    return { document, stream: opened.stream };
  }

  private async unresolvedApplicationRequirements(snapshot: RentOpsSnapshot, applicationId: string): Promise<RentOpsApplicationRequirement[]> {
    const documents = snapshot.documents.filter((document) => document.applicationId === applicationId);
    const unresolved: RentOpsApplicationRequirement[] = [];
    for (const requirement of snapshot.applicationRequirements) {
      if (requirement.applicationId !== applicationId || requirement.status === "waived") continue;
      if (requirement.status !== "received") { unresolved.push(requirement); continue; }
      // A received label without an exact document binding is still
      // unresolved.  Certification and requirement state are not evidence
      // that a file was uploaded or verified.
      if (!requirement.documentId) { unresolved.push(requirement); continue; }
      const document = documents.find((candidate) => candidate.id === requirement.documentId);
      if (!document || !(await this.isResolvedApplicationDocument(document))) unresolved.push(requirement);
    }
    return unresolved;
  }

  async updateApplicationStatus(applicationId: string, status: RentOpsApplication["status"], note?: string): Promise<RentOpsApplicationRecord> {
    const operation = (repository: RentOpsRepository) => this.withRepository(repository).updateApplicationStatusRecord(applicationId, status, note);
    return this.repository.transaction(operation, { lockApplicationId: applicationId });
  }

  private async updateApplicationStatusRecord(applicationId: string, status: RentOpsApplication["status"], note?: string): Promise<RentOpsApplicationRecord> {
    const application = await this.repository.getApplicationById(applicationId);
    if (!application) throw new RentOpsInvariantError("Application not found");
    assertApplicationStatusTransition(application.status, status);
    if (status === "converted" && !application.convertedTenancyId) throw new RentOpsInvariantError("Use the conversion action to mark an application converted");
    const updated = { ...application, status, updatedAt: this.now().toISOString() };
    await this.repository.saveApplication(updated);
    if (note) await this.repository.saveActivity({ id: `activity:${randomUUID()}`, applicationId, type: "system", occurredAt: this.now().toISOString(), actor: "admin", summary: note });
    await this.recordAdminChange(`Application status changed to ${status}${note ? `: ${note}` : ""}`, { applicationId });
    return updated;
  }

  async saveApplicationRequirement(applicationId: string, input: Omit<RentOpsApplicationRequirement, "id" | "applicationId"> & { id?: string }): Promise<RentOpsApplicationRequirement> {
    return this.repository.transaction((repository) => this.withRepository(repository).saveApplicationRequirementRecord(applicationId, input), { lockApplicationId: applicationId });
  }

  private async saveApplicationRequirementRecord(applicationId: string, input: Omit<RentOpsApplicationRequirement, "id" | "applicationId"> & { id?: string }): Promise<RentOpsApplicationRequirement> {
    const application = await this.repository.getApplicationById(applicationId);
    if (!application) throw new RentOpsInvariantError("Application not found");
    const requirement = { ...input, id: input.id ?? `requirement:${randomUUID()}`, applicationId };
    const saved = await this.repository.saveApplicationRequirement(requirement);
    const current = await this.repository.getApplicationById(applicationId);
    if (current && (saved.status === "requested" || saved.status === "rejected") && current.status === "submitted") await this.repository.saveApplication({ ...current, status: "missing_information", updatedAt: this.now().toISOString() });
    await this.recordAdminChange(`Application requirement ${saved.key} marked ${saved.status}`, { applicationId });
    return saved;
  }

  async convertApplication(applicationId: string, facts?: ApplicationConversionFacts, context?: RentOpsAdminPatchContext): Promise<{ application: RentOpsApplicationRecord; tenancy: RentOpsTenancy }> {
    if (!facts) throw new RentOpsInvariantError("Explicit admin-approved conversion facts are required");
    if (!context) throw new RentOpsInvariantError("Authenticated admin context is required");
    if (facts.billingFrequency !== "monthly") throw new RentOpsInvariantError("Explicit monthly billing frequency required");
    assertAdminPatchContext(context);
    return this.repository.transaction((repository) => this.withRepository(repository).convertApplicationRecords(applicationId, facts, context), { lockApplicationId: applicationId });
  }

  private async convertApplicationRecords(applicationId: string, facts: ApplicationConversionFacts, context: RentOpsAdminPatchContext): Promise<{ application: RentOpsApplicationRecord; tenancy: RentOpsTenancy }> {
    const application = await this.repository.getApplicationById(applicationId);
    if (!application) throw new RentOpsInvariantError("Application not found");
    const snapshot = await this.snapshot();
    assertPositiveCents(facts.baseRentCents, "Approved base rent");
    if (facts.category !== "base_rent" || !facts.scheduleDescription.trim()) throw new RentOpsInvariantError("Conversion requires an explicit base-rent definition, category, and description");
    const approvedDefinition = snapshot.chargeDefinitions.find((candidate) => candidate.id === facts.chargeDefinitionId);
    if (!approvedDefinition || approvedDefinition.category !== facts.category
      || (approvedDefinition.categoryKnowledge !== "source" && approvedDefinition.categoryKnowledge !== "manual")
      || approvedDefinition.active !== true
      || (approvedDefinition.activeKnowledge !== "source" && approvedDefinition.activeKnowledge !== "manual")) {
      throw new RentOpsInvariantError("Conversion charge definition is unavailable or does not match base rent");
    }
    const applicationMembers = snapshot.applicationHouseholdMembers.filter((candidate) => candidate.applicationId === application.id);
    const expectedMemberIds = new Set(["primary", ...applicationMembers.map((member) => member.id)]);
    const suppliedMemberIds = facts.members.map((member) => member.applicationMemberId);
    if (new Set(suppliedMemberIds).size !== suppliedMemberIds.length || suppliedMemberIds.length !== expectedMemberIds.size || suppliedMemberIds.some((id) => !expectedMemberIds.has(id))) {
      throw new RentOpsInvariantError("Conversion must include exactly every application member ID");
    }
    const primaryFact = facts.members.find((member) => member.applicationMemberId === "primary");
    if (!primaryFact || primaryFact.role !== "primary" || primaryFact.isFinanciallyResponsible !== facts.primaryFinanciallyResponsible) throw new RentOpsInvariantError("Conversion requires an explicit primary role and responsibility");
    if (facts.plannedMoveInOn <= nowIsoDate(this.now())) throw new RentOpsInvariantError("Application conversion requires a future planned move-in date");

    if (application.convertedTenancyId) {
      const existing = snapshot.tenancies.find((tenancy) => tenancy.id === application.convertedTenancyId);
      if (!existing) throw new RentOpsInvariantError("Converted application tenancy is missing");
      const term = snapshot.leaseTerms.find((candidate) => candidate.id === `lease-term:application:${application.id}`);
      const schedule = snapshot.recurringSchedules.find((candidate) => candidate.id === `schedule:application:${application.id}:base-rent`);
      const memberships = snapshot.householdMemberships.filter((candidate) => candidate.tenancyId === existing.id);
      const sameTenancy = existing.propertyId === facts.propertyId
        && existing.unitId === facts.unitId
        && existing.status === "future"
        && existing.plannedMoveInOn === facts.plannedMoveInOn
        && existing.actualMoveInOn === undefined;
      const sameTerm = Boolean(term && term.status === facts.leaseStatus && term.contractStartOn === facts.contractStartOn && term.contractEndOn === facts.contractEndOn && term.monthToMonth === facts.monthToMonth);
      const sameSchedule = Boolean(schedule
        && schedule.scopeType === "tenant"
        && schedule.scopeId === existing.primaryPersonId
        && schedule.chargeDefinitionId === facts.chargeDefinitionId
        && schedule.category === facts.category
        && schedule.description === facts.scheduleDescription.trim()
        && schedule.amountCents === facts.baseRentCents
        && schedule.effectiveFrom === facts.contractStartOn
        && schedule.effectiveTo === facts.contractEndOn
        && schedule.active === true
        && schedule.scopeTypeKnowledge === "manual"
        && schedule.scopeLinkKnowledge === "manual"
        && schedule.chargeDefinitionLinkKnowledge === "manual"
        && schedule.categoryKnowledge === "manual"
        && schedule.amountKnowledge === "known"
        && schedule.effectiveFromKnowledge === "manual"
        && schedule.activeKnowledge === "manual"
        && schedule.lineageRootId === schedule.id
        && schedule.lineageRootOrigin === "manual"
        && schedule.versionOrigin === "manual"
        && schedule.versionAction === "root");
      const expectedMemberships = new Map<string, { role: string; responsible: boolean; relationship?: string }>([["primary", { role: primaryFact.role, responsible: primaryFact.isFinanciallyResponsible, relationship: primaryFact.relationship }]]);
      for (const fact of facts.members.filter((member) => member.applicationMemberId !== "primary")) expectedMemberships.set(fact.applicationMemberId, { role: fact.role, responsible: fact.isFinanciallyResponsible, relationship: fact.relationship });
      const sameMemberships = memberships.length === expectedMemberships.size && Array.from(expectedMemberships.entries()).every(([memberId, expected]) => {
        const personId = memberId === "primary" ? `person:application:${application.id}` : `person:application-member:${memberId}`;
        const current = memberships.find((membership) => membership.personId === personId);
        return Boolean(current && current.role === expected.role && current.isFinanciallyResponsible === expected.responsible && current.relationship === expected.relationship);
      });
      if (!sameTenancy || !sameTerm || !sameSchedule || !sameMemberships) throw new RentOpsInvariantError("Converted application retry does not match the same approved facts");
      return { application, tenancy: existing };
    }

    if (application.status !== "approved") throw new RentOpsInvariantError("Only manually approved applications can convert");
    if (!application.propertyId || !application.unitId || application.propertyId !== facts.propertyId || application.unitId !== facts.unitId) throw new RentOpsInvariantError("Approved conversion property and unit must match the application exactly");
    const property = snapshot.properties.find((candidate) => candidate.id === facts.propertyId && candidate.state === "active");
    const unit = snapshot.units.find((candidate) => candidate.id === facts.unitId && candidate.propertyId === facts.propertyId);
    if (!property || !unit) throw new RentOpsInvariantError("Application property or unit is unavailable");
    if (unit.readiness !== "ready" || unit.listing !== "listed") throw new RentOpsInvariantError("Application conversion requires inventory that is ready and listed");
    if ((await this.unresolvedApplicationRequirements(snapshot, application.id)).length) throw new RentOpsInvariantError("Application still has unresolved information requirements");
    const conflictingFuture = snapshot.tenancies.find((candidate) => candidate.unitId === unit.id && candidate.status === "future");
    if (conflictingFuture) throw new RentOpsInvariantError("Unit already has a future tenancy");
    const conflictingCurrent = snapshot.tenancies.find((candidate) => candidate.unitId === unit.id && !hasOperationalEndOn(candidate, nowIsoDate(this.now())) && (candidate.status === "current" || candidate.status === "notice") && (!candidate.expectedMoveOutOn || candidate.expectedMoveOutOn >= facts.plannedMoveInOn));
    if (conflictingCurrent) throw new RentOpsInvariantError("Unit is not available by the requested planned move-in date");

    const personId = `person:application:${application.id}`;
    let person = snapshot.people.find((candidate) => candidate.id === personId);
    if (!person) person = await this.repository.savePerson({ id: personId, firstName: application.firstName, lastName: application.lastName, email: application.email, phone: application.phone, firstNameKnowledge: "manual", lastNameKnowledge: "manual", emailKnowledge: application.email ? "manual" : "unknown", phoneKnowledge: application.phone ? "manual" : "unknown", archived: false, archivedKnowledge: "manual" });
    const tenancy: RentOpsTenancy = { id: `tenancy:application:${application.id}`, propertyId: facts.propertyId, unitId: facts.unitId, primaryPersonId: person.id, status: "future", plannedMoveInOn: facts.plannedMoveInOn, applicationId: application.id, createdAt: this.now().toISOString(), propertyLinkKnowledge: "manual", unitLinkKnowledge: "manual", primaryPersonLinkKnowledge: "manual", statusKnowledge: "manual", plannedMoveInKnowledge: "manual", createdAtKnowledge: "manual" };
    await this.repository.saveTenancy(tenancy);
    await this.repository.saveHouseholdMembership({ id: `household:application:${application.id}:primary`, tenancyId: tenancy.id, personId: person.id, role: primaryFact.role, isFinanciallyResponsible: primaryFact.isFinanciallyResponsible, relationship: primaryFact.relationship, roleKnowledge: "manual", responsibilityKnowledge: "manual", relationshipKnowledge: primaryFact.relationship ? "manual" : "unknown" });
    for (const fact of facts.members.filter((member) => member.applicationMemberId !== "primary")) {
      const member = applicationMembers.find((candidate) => candidate.id === fact.applicationMemberId);
      if (!member) throw new RentOpsInvariantError("Conversion member ID is not an exact application member");
      const memberPerson = await this.repository.savePerson({ id: `person:application-member:${member.id}`, firstName: member.firstName, lastName: member.lastName, email: member.email, phone: member.phone, firstNameKnowledge: "manual", lastNameKnowledge: "manual", emailKnowledge: member.email ? "manual" : "unknown", phoneKnowledge: member.phone ? "manual" : "unknown", archived: false, archivedKnowledge: "manual" });
      await this.repository.saveHouseholdMembership({ id: `household:application-member:${member.id}`, tenancyId: tenancy.id, personId: memberPerson.id, role: fact.role, relationship: fact.relationship, isFinanciallyResponsible: fact.isFinanciallyResponsible, roleKnowledge: "manual", responsibilityKnowledge: "manual", relationshipKnowledge: fact.relationship ? "manual" : "unknown" });
    }
    const term: RentOpsLeaseTerm = { id: `lease-term:application:${application.id}`, tenancyId: tenancy.id, status: facts.leaseStatus, contractStartOn: facts.contractStartOn, contractEndOn: facts.contractEndOn, monthToMonth: facts.monthToMonth, createdAt: this.now().toISOString(), tenancyLinkKnowledge: "manual", statusKnowledge: "manual", contractStartKnowledge: "manual", contractEndKnowledge: facts.contractEndOn ? "manual" : "unknown", monthToMonthKnowledge: "manual", createdAtKnowledge: "manual" };
    await this.repository.saveLeaseTerm(term);
    const scheduleId = `schedule:application:${application.id}:base-rent`;
    await this.saveRecurringScheduleRecords({ id: scheduleId, billingFrequency: facts.billingFrequency, scopeType: "tenant", scopeId: person.id, scopeTypeKnowledge: "manual", scopeLinkKnowledge: "manual", chargeDefinitionId: facts.chargeDefinitionId, chargeDefinitionLinkKnowledge: "manual", tenancyId: tenancy.id, personId: person.id, propertyId: facts.propertyId, unitId: facts.unitId, category: facts.category, categoryKnowledge: "manual", description: facts.scheduleDescription, descriptionKnowledge: "manual", amountCents: facts.baseRentCents, amountKnowledge: "known", effectiveFrom: facts.contractStartOn, effectiveFromKnowledge: "manual", effectiveTo: facts.contractEndOn, active: true, activeKnowledge: "manual", sourceConfidence: "confirmed", lineageRootId: scheduleId, lineageRootOrigin: "manual", versionOrigin: "manual", versionAction: "root" }, context);
    await this.repository.saveActivity({ id: `activity:application:${application.id}:converted`, applicationId, tenancyId: tenancy.id, personId: person.id, propertyId: facts.propertyId, unitId: facts.unitId, type: "system", occurredAt: this.now().toISOString(), actor: "admin", summary: "Application converted to future tenancy from explicit approved facts" });
    if (!this.repository.applyRecordPatch || !this.repository.saveRecordChange) throw new RentOpsInvariantError("Application conversion persistence is unavailable");
    const revision = application.recordRevision ?? 1;
    const updated: RentOpsApplicationRecord = { ...application, status: "converted", statusKnowledge: "manual", convertedTenancyId: tenancy.id, updatedAt: this.now().toISOString(), updatedAtKnowledge: "manual", recordRevision: revision + 1 };
    // Update the existing row: an UPSERT would attempt to establish its immutable
    // imported source pair again under the runtime role before conflict handling.
    await this.repository.applyRecordPatch({ entityType: "application", targetId: application.id, expectedRevision: revision, nextRevision: revision + 1, values: { status: updated.status, status_knowledge: "manual", converted_tenancy_id: tenancy.id, updated_at: updated.updatedAt, updated_at_knowledge: "manual" } });
    await this.repository.saveRecordChange({ id: `record-change:${randomUUID()}`, entityType: "application", targetId: application.id, revision: revision + 1, origin: "admin", actorSubject: context.actorSubject, occurredAt: context.occurredAt, changedFields: ["status"] });
    return { application: updated, tenancy };
  }

  async patchRecord(entityType: RentOpsPatchEntityType | "recurring_schedule", targetId: string, expectedRevision: number, patch: Record<string, unknown>, context: RentOpsAdminPatchContext): Promise<unknown> {
    if (entityType === "person" && patch.phoneMethods !== undefined) {
      const parsed = phoneMethodsSchema.safeParse(patch.phoneMethods);
      if (!parsed.success) throw new RentOpsInvariantError("Invalid phone methods");
      patch = {...patch,phoneMethods:parsed.data};
    }
    if (entityType === "recurring_schedule") throw new RentOpsInvariantError("versioned_schedule_required");
    if (entityType === "activity") throw new RentOpsInvariantError("activity_append_only");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new RentOpsInvariantError("Record revision is required");
    return this.repository.transaction(
      (repository) => this.withRepository(repository).patchRecordLocked(entityType, targetId, expectedRevision, patch, context),
      {
        lockRecord: { entityType, targetId },
        lockTenancySiblings: entityType === "tenancy",
        lockTenancyUnitIds: entityType === "tenancy" && typeof patch.unitId === "string" ? [patch.unitId] : [],
        lockLeaseSiblings: entityType === "lease_term",
        lockLeaseTenancyIds: entityType === "lease_term" && typeof patch.tenancyId === "string" ? [patch.tenancyId] : [],
      },
    );
  }

  async patchApplicationStatus(applicationId: string, expectedRevision: number, status: RentOpsApplication["status"], note: string | undefined, context: RentOpsAdminPatchContext): Promise<RentOpsApplicationRecord> {
    return this.repository.transaction(async (repository) => {
      const service = this.withRepository(repository);
      const updated = await service.patchRecordLocked("application", applicationId, expectedRevision, { status }, context) as RentOpsApplicationRecord;
      if (note?.trim()) {
        await repository.saveActivity({ id: `activity:application-status:${randomUUID()}`, applicationId, type: "system", occurredAt: context.occurredAt, actor: "admin", summary: note.trim() });
      }
      return updated;
    }, { lockRecord: { entityType: "application", targetId: applicationId } });
  }

  private async patchRecordLocked(entityType: RentOpsPatchEntityType, targetId: string, expectedRevision: number, patch: Record<string, unknown>, context: RentOpsAdminPatchContext): Promise<unknown> {
    if (!this.repository.applyRecordPatch || !this.repository.saveRecordChange) throw new RentOpsInvariantError("Record patch persistence is unavailable");
    const snapshot = await this.snapshot();
    const existing = patchRow(snapshot, entityType, targetId);
    if (!existing) throw new RentOpsInvariantError("Rent Operations record not found");
    const currentRevision = typeof existing.recordRevision === "number" ? existing.recordRevision : 1;
    if (currentRevision !== expectedRevision) throw new RentOpsInvariantError("Rent Operations record revision is stale");
    const next = { ...existing } as Record<string, unknown>;
    const changedFields: string[] = [];
    const knowledgeFields = new Map<string, string>();
    for (const [field, incoming] of Object.entries(patch)) {
      if (incoming === undefined) continue;
      if (!PATCH_FIELDS[entityType]?.has(field) || /source|provenance|knowledge|storage|checksum|hash|token|version|revision/i.test(field)) throw new RentOpsInvariantError("Patch contains a field outside the positive allowlist");
      assertPatchValueSafe(incoming);
      const merged = mergePatchValue(existing[field], incoming);
      const confirmationKnowledge = PATCH_KNOWLEDGE[entityType][field];
      const confirmsUnknownFact = entityType === "tenancy" && field === "status" && incoming !== null
        && confirmationKnowledge && !["source", "manual", "confirmed"].includes(String(existing[confirmationKnowledge] ?? ""));
      if (jsonEqual(existing[field], merged) && !confirmsUnknownFact) continue;
      next[field] = merged;
      changedFields.push(field);
      const knowledgeField = PATCH_KNOWLEDGE[entityType][field];
      if (knowledgeField) {
        // A submitted value is operator knowledge; an explicit null is an
        // intentional clearing of the fact and must remain visibly unknown.
        const knowledge = incoming === null ? "unknown" : "manual";
        next[knowledgeField] = knowledge;
        knowledgeFields.set(knowledgeField, knowledge);
      }
    }
    if (changedFields.length === 0) return existing;
    this.validateAdminPatch(entityType, existing, next, snapshot);
    const values: Record<string, unknown> = {};
    for (const field of changedFields) {
      if (field === "address" && next.address && typeof next.address === "object" && !Array.isArray(next.address)) {
        for (const [addressField, value] of Object.entries(next.address as Record<string, unknown>)) values[`address_${snakeCase(addressField).replace(/^_/, "")}`] = value;
      } else {
        // The property status column retains its historical SQL name; all
        // other patch fields use the contract's snake_case spelling.
        const column = entityType === "property" && field === "state" ? "state_status" : snakeCase(field);
        values[column] = next[field];
      }
    }
    for (const [field, knowledge] of Array.from(knowledgeFields.entries())) values[snakeCase(field)] = knowledge;
    await this.repository.applyRecordPatch({ entityType, targetId, expectedRevision, nextRevision: currentRevision + 1, values });
    await this.repository.saveRecordChange({ id: `record-change:${randomUUID()}`, entityType, targetId, revision: currentRevision + 1, origin: "admin", actorSubject: context.actorSubject, occurredAt: context.occurredAt, changedFields: [...changedFields].sort() });
    next.recordRevision = currentRevision + 1;
    return next;
  }

  private validateAdminPatch(entityType: RentOpsPatchEntityType, existing: Record<string, unknown>, next: Record<string, unknown>, snapshot: RentOpsSnapshot): void {
    if (entityType === "charge_definition" && !patchChargeDefinitionSchema.safeParse({...(next.displayName !== existing.displayName ? {displayName: next.displayName} : {}), ...(next.active !== existing.active ? {active: next.active} : {})}).success) throw new RentOpsInvariantError("Invalid charge definition patch");
    const collection = PATCH_COLLECTIONS[entityType];
    const currentRows = snapshot[collection] as unknown as Array<Record<string, unknown>>;
    const candidate = {
      ...snapshot,
      [collection]: currentRows.map((row) => row.id === existing.id ? next : row),
    } as RentOpsSnapshot;
    const violationKey = (violation: { code: string; entityId?: string; message: string }): string => `${violation.code}|${violation.entityId ?? ""}|${violation.message}`;
    const baselineViolations = new Set(validateSnapshot(snapshot).map(violationKey));
    const introducedViolations = validateSnapshot(candidate).filter((violation) => !baselineViolations.has(violationKey(violation)));
    if (introducedViolations.length > 0) throw new RentOpsInvariantError("Patch would violate Rent Operations relationship or sibling invariants", introducedViolations);
    if (entityType === "application" && existing.status !== next.status && typeof existing.status === "string" && typeof next.status === "string") assertApplicationStatusTransition(existing.status as RentOpsApplication["status"], next.status as RentOpsApplication["status"]);
    if (entityType === "application" && (existing.propertyId !== next.propertyId || existing.unitId !== next.unitId)) {
      if (existing.status === "converted" || existing.convertedTenancyId) throw new RentOpsInvariantError("Converted application assignment cannot change");
      const property = snapshot.properties.find((row) => row.id === next.propertyId);
      const unit = snapshot.units.find((row) => row.id === next.unitId);
      if (!property || !unit || unit.propertyId !== property.id) throw new RentOpsInvariantError("Application assignment requires an exact property and unit pair");
    }
    if (entityType === "tenancy") {
      const tenancy = next as unknown as RentOpsTenancy;
      const unit = snapshot.units.find((candidate) => candidate.id === tenancy.unitId);
      if (!snapshot.properties.some((candidate) => candidate.id === tenancy.propertyId) || !unit || unit.propertyId !== tenancy.propertyId || !snapshot.people.some((candidate) => candidate.id === tenancy.primaryPersonId)) throw new RentOpsInvariantError("Tenancy property, unit, or primary resident is invalid");
      if ((tenancy.status === "current" || tenancy.status === "notice") && !tenancy.actualMoveInOn && !hasOccupancyConfirmationOn(tenancy, nowIsoDate(this.now()))) throw new RentOpsInvariantError("Current and notice tenancies require an actual move-in date or dated occupancy confirmation");
      if (tenancy.status === "future" && !tenancy.plannedMoveInOn) throw new RentOpsInvariantError("Future tenancies require a planned move-in date");
      if (tenancy.actualMoveInOn && tenancy.actualMoveOutOn && tenancy.actualMoveOutOn < tenancy.actualMoveInOn) throw new RentOpsInvariantError("Actual move-out cannot predate move-in");
    }
    if (entityType === "lease_term") {
      const term = next as unknown as RentOpsLeaseTerm;
      if (!snapshot.tenancies.some((candidate) => candidate.id === term.tenancyId)) throw new RentOpsInvariantError("Lease term tenancy is invalid");
      if (term.contractEndOn && term.contractStartOn && term.contractEndOn < term.contractStartOn) throw new RentOpsInvariantError("Lease term end cannot predate its start");
    }
    if (entityType === "security_deposit") {
      const deposit = next as unknown as RentOpsSecurityDeposit;
      if (deposit.amountHeldCents === null) {
        if (deposit.source?.system !== "rent_manager" || !Number.isSafeInteger(deposit.sourceBalanceCents) || deposit.sourceBalanceCents! >= 0) throw new RentOpsInvariantError("Unknown held deposit requires signed source balance");
      } else assertPositiveCents(deposit.amountHeldCents, "Deposit amount");
      const property = snapshot.properties.find((candidate) => candidate.id === deposit.propertyId);
      const person = snapshot.people.find((candidate) => candidate.id === deposit.personId);
      const unit = deposit.unitId ? snapshot.units.find((candidate) => candidate.id === deposit.unitId) : undefined;
      const tenancy = deposit.tenancyId ? snapshot.tenancies.find((candidate) => candidate.id === deposit.tenancyId) : undefined;
      if (!property || !person || deposit.unitId && (!unit || unit.propertyId !== property.id)) throw new RentOpsInvariantError("Deposit property, optional unit, and person references are invalid");
      if (deposit.tenancyId && (!tenancy || tenancy.propertyId !== property.id || deposit.unitId && tenancy.unitId !== deposit.unitId || tenancy.primaryPersonId !== deposit.personId)) throw new RentOpsInvariantError("Deposit tenancy does not exactly match its property, unit, and person");
      if (deposit.disposedOn && deposit.receivedOn && deposit.disposedOn < deposit.receivedOn) throw new RentOpsInvariantError("Deposit disposition cannot predate receipt");
    }
    if (entityType === "subsidy_contract") {
      const contract = next as unknown as RentOpsSubsidyContract;
      assertCents(contract.agencyObligationCents, "Agency obligation"); assertCents(contract.tenantObligationCents, "Tenant obligation");
      if (contract.agencyObligationCents < 0 || contract.tenantObligationCents < 0 || contract.agencyObligationCents + contract.tenantObligationCents <= 0) throw new RentOpsInvariantError("Housing-assistance obligations must total more than zero");
      if (contract.effectiveTo && contract.effectiveTo < contract.effectiveFrom) throw new RentOpsInvariantError("Housing-assistance end cannot predate its start");
    }
    if (entityType === "document") {
      assertPrivateStorageKey(existing.storageKey as string | undefined);
      const violations = documentReferenceViolations(snapshot, next as unknown as RentOpsDocument);
      if (violations.length > 0) throw new RentOpsInvariantError("Document references are invalid", violations);
    }
  }

  async saveProperty(property: RentOpsProperty): Promise<RentOpsProperty> { if ((await this.snapshot()).properties.some((candidate) => candidate.id === property.id)) throw new RentOpsInvariantError("Property already exists; use PATCH for an existing record"); const saved = await this.repository.saveProperty(manualCreationKnowledge("property", property)); await this.recordAdminChange(`Property ${property.name} saved`, { propertyId: property.id }); return saved; }
  async saveUnit(unit: RentOpsUnit): Promise<RentOpsUnit> { if ((await this.snapshot()).units.some((candidate) => candidate.id === unit.id)) throw new RentOpsInvariantError("Unit already exists; use PATCH for an existing record"); const saved = await this.repository.saveUnit(manualCreationKnowledge("unit", unit)); await this.recordAdminChange(`Unit ${unit.unitNumber} saved`, { propertyId: unit.propertyId, unitId: unit.id }); return saved; }
  async savePerson(person: RentOpsPerson, context?: RentOpsAdminPatchContext): Promise<RentOpsPerson> {
    if(person.phoneMethods!==undefined) {
      const parsed=phoneMethodsSchema.safeParse(person.phoneMethods);
      if(!parsed.success) throw new RentOpsInvariantError("Invalid phone methods");
      person={...person,phoneMethods:parsed.data};
      if(!context) throw new RentOpsInvariantError("Authenticated admin context is required");
    }
    if(context) {
      assertAdminPatchContext(context);
      return this.repository.transaction(async repository=>{
        if(!repository.saveRecordChange) throw new RentOpsInvariantError("Person audit persistence is unavailable");
        if((await repository.getSnapshot()).people.some(candidate=>candidate.id===person.id)) throw new RentOpsInvariantError("Person already exists; use PATCH for an existing record");
        const saved=await repository.savePerson({...manualCreationKnowledge("person",person),recordRevision:1});
        const changedFields=Object.keys(person).filter(field=>PATCH_FIELDS.person.has(field)&&(person as unknown as Record<string,unknown>)[field]!==undefined).sort();
        await repository.saveRecordChange({id:`record-change:${randomUUID()}`,entityType:"person",targetId:saved.id,revision:1,origin:"admin",actorSubject:context.actorSubject,occurredAt:context.occurredAt,changedFields});
        return saved;
      });
    }
    if ((await this.snapshot()).people.some(candidate=>candidate.id===person.id)) throw new RentOpsInvariantError("Person already exists; use PATCH for an existing record");
    const saved=await this.repository.savePerson(manualCreationKnowledge("person",person));
    await this.recordAdminChange(`Person ${person.firstName} ${person.lastName} saved`,{personId:person.id});return saved;
  }
  async saveHouseholdMembership(membership: RentOpsHouseholdMembership): Promise<RentOpsHouseholdMembership> { if ((await this.snapshot()).householdMemberships.some((candidate) => candidate.id === membership.id)) throw new RentOpsInvariantError("Household membership already exists; use PATCH for an existing record"); const saved = await this.repository.saveHouseholdMembership(membership); await this.recordAdminChange(`Household membership ${membership.id} saved`, { tenancyId: membership.tenancyId, personId: membership.personId }); return saved; }
  async saveTenancy(tenancy: RentOpsTenancy): Promise<RentOpsTenancy> {
    const snapshot = await this.snapshot();
    if (snapshot.tenancies.some((candidate) => candidate.id === tenancy.id)) throw new RentOpsInvariantError("Tenancy already exists; use PATCH for an existing record");
    const unit = snapshot.units.find((candidate) => candidate.id === tenancy.unitId);
    if (!snapshot.properties.some((candidate) => candidate.id === tenancy.propertyId) || !unit || unit.propertyId !== tenancy.propertyId || !snapshot.people.some((candidate) => candidate.id === tenancy.primaryPersonId)) throw new RentOpsInvariantError("Tenancy property, unit, or primary resident is invalid");
    if ((tenancy.status === "current" || tenancy.status === "notice") && !tenancy.actualMoveInOn && !hasOccupancyConfirmationOn(tenancy, nowIsoDate(this.now()))) throw new RentOpsInvariantError("Current and notice tenancies require an actual move-in date or dated occupancy confirmation");
    if (tenancy.status === "future" && !tenancy.plannedMoveInOn) throw new RentOpsInvariantError("Future tenancies require a planned move-in date");
    if (tenancy.actualMoveInOn && tenancy.actualMoveOutOn && tenancy.actualMoveOutOn < tenancy.actualMoveInOn) throw new RentOpsInvariantError("Actual move-out cannot predate move-in");
    const peers = snapshot.tenancies.filter((candidate) => candidate.id !== tenancy.id && candidate.unitId === tenancy.unitId);
    if ((tenancy.status === "current" || tenancy.status === "notice") && peers.some((candidate) => !hasOperationalEndOn(candidate, nowIsoDate(this.now())) && (candidate.status === "current" || candidate.status === "notice"))) throw new RentOpsInvariantError("Unit already has a current or notice tenancy");
    if (tenancy.status === "future" && peers.some((candidate) => candidate.status === "future")) throw new RentOpsInvariantError("Unit already has a future tenancy");
    const saved = await this.repository.saveTenancy(manualCreationKnowledge("tenancy", tenancy));
    await this.recordAdminChange(`Tenancy ${tenancy.id} saved`, { propertyId: tenancy.propertyId, unitId: tenancy.unitId, personId: tenancy.primaryPersonId, tenancyId: tenancy.id });
    return saved;
  }

  async saveLeaseTerm(term: RentOpsLeaseTerm): Promise<RentOpsLeaseTerm> {
    const snapshot = await this.snapshot();
    if (snapshot.leaseTerms.some((candidate) => candidate.id === term.id)) throw new RentOpsInvariantError("Lease term already exists; use PATCH for an existing record");
    if (!snapshot.tenancies.some((candidate) => candidate.id === term.tenancyId)) throw new RentOpsInvariantError("Lease term tenancy is invalid");
    if (term.contractEndOn && term.contractEndOn < term.contractStartOn) throw new RentOpsInvariantError("Lease term end cannot predate its start");
    const candidate = { ...snapshot, leaseTerms: [...snapshot.leaseTerms.filter((existing) => existing.id !== term.id), term] };
    const violations = validateSnapshot(candidate).filter((violation) => violation.code === "overlapping_lease_terms");
    if (violations.length) throw new RentOpsInvariantError("Lease term overlaps an existing term", violations);
    const saved = await this.repository.saveLeaseTerm(manualCreationKnowledge("lease_term", term));
    await this.recordAdminChange(`Lease term ${term.id} saved`, { tenancyId: term.tenancyId });
    return saved;
  }

  async saveRecurringSchedule(schedule: RentOpsRecurringChargeSchedule, context?: RentOpsAdminPatchContext): Promise<RentOpsRecurringChargeSchedule> {
    if (!context) throw new RentOpsInvariantError("Authenticated admin context is required");
    assertAdminPatchContext(context);
    return this.repository.transaction(
      (repository) => this.withRepository(repository).saveRecurringScheduleRecords(schedule, context),
    );
  }

  private async saveRecurringScheduleRecords(schedule: RentOpsRecurringChargeSchedule, context: RentOpsAdminPatchContext): Promise<RentOpsRecurringChargeSchedule> {
    if (!this.repository.saveRecordChange) throw new RentOpsInvariantError("Recurring schedule audit persistence is unavailable");
    assertPositiveCents(schedule.amountCents, "Recurring schedule amount");
    if (schedule.billingFrequency !== "monthly") throw new RentOpsInvariantError("Explicit monthly billing frequency required");
    if (!schedule.effectiveFrom) throw new RentOpsInvariantError("A manual recurring schedule requires an explicit effective date");
    if (schedule.effectiveTo && schedule.effectiveTo < schedule.effectiveFrom) throw new RentOpsInvariantError("Recurring schedule end cannot predate its start");
    if (schedule.source || schedule.sourceArtifactSha256 || schedule.artifactObservationOn) throw new RentOpsInvariantError("Manual recurring schedules cannot claim imported source evidence");
    if (schedule.lineageRootId !== schedule.id || schedule.lineageRootOrigin !== "manual" || schedule.versionOrigin !== "manual" || schedule.versionAction !== "root" || schedule.supersedesId) {
      throw new RentOpsInvariantError("A new recurring schedule must be an explicit manual lineage root");
    }
    if (!schedule.scopeType || !schedule.scopeId || !schedule.propertyId) throw new RentOpsInvariantError("A manual recurring schedule requires an explicit scope and property");
    if (!schedule.chargeDefinitionId || schedule.chargeDefinitionKey) throw new RentOpsInvariantError("A manual recurring schedule requires one exact charge definition");
    if (!schedule.description?.trim()) throw new RentOpsInvariantError("Recurring schedule description is required");
    if (typeof schedule.active !== "boolean") throw new RentOpsInvariantError("A manual recurring schedule requires an explicit active state");
    const snapshot = await this.snapshot();
    if (snapshot.recurringSchedules.some((candidate) => candidate.id === schedule.id)) throw new RentOpsInvariantError("Recurring schedules are versioned; create a new id and effective date");
    if (!snapshot.properties.some((candidate) => candidate.id === schedule.propertyId)) throw new RentOpsInvariantError("Recurring schedule property is invalid");
    const chargeDefinition = snapshot.chargeDefinitions.find((candidate) => candidate.id === schedule.chargeDefinitionId);
    if (!chargeDefinition || chargeDefinition.category === null || schedule.category !== chargeDefinition.category
      || (chargeDefinition.categoryKnowledge !== "source" && chargeDefinition.categoryKnowledge !== "manual")) {
      throw new RentOpsInvariantError("Recurring schedule category must match an exact charge definition");
    }
    if (chargeDefinition.active !== true || (chargeDefinition.activeKnowledge !== "source" && chargeDefinition.activeKnowledge !== "manual")) {
      throw new RentOpsInvariantError("Recurring schedule charge definition is not confirmed active");
    }
    const tenancy = schedule.tenancyId ? snapshot.tenancies.find((candidate) => candidate.id === schedule.tenancyId) : undefined;
    const unit = schedule.unitId ? snapshot.units.find((candidate) => candidate.id === schedule.unitId) : undefined;
    const person = schedule.personId ? snapshot.people.find((candidate) => candidate.id === schedule.personId) : undefined;
    if (schedule.scopeType === "property") {
      if (schedule.scopeId !== schedule.propertyId || schedule.unitId || schedule.tenancyId || schedule.personId) throw new RentOpsInvariantError("Property recurring schedule scope must match the property exactly");
    } else if (schedule.scopeType === "unit") {
      if (!unit || unit.id !== schedule.scopeId || unit.propertyId !== schedule.propertyId || schedule.tenancyId || schedule.personId) throw new RentOpsInvariantError("Unit recurring schedule scope must match one exact unit");
    } else {
      if (!person || person.id !== schedule.scopeId || !tenancy || !unit) throw new RentOpsInvariantError("Tenant recurring schedule requires an exact person, tenancy, and unit");
      if (tenancy.primaryPersonId !== person.id || tenancy.propertyId !== schedule.propertyId || tenancy.unitId !== unit.id || unit.propertyId !== schedule.propertyId) {
        throw new RentOpsInvariantError("Recurring schedule tenancy, property, unit, and person must match");
      }
    }
    const normalized: RentOpsRecurringChargeSchedule = {
      ...schedule,
      recordRevision: 1,
      source: undefined,
      sourceArtifactSha256: null,
      artifactObservationOn: null,
      chargeDefinitionKey: null,
      scopeTypeKnowledge: "manual",
      scopeLinkKnowledge: "manual",
      chargeDefinitionKnowledge: "manual",
      chargeDefinitionLinkKnowledge: "manual",
      categoryKnowledge: "manual",
      description: schedule.description.trim(),
      descriptionKnowledge: "manual",
      amountKnowledge: "known",
      effectiveFromKnowledge: "manual",
      activeKnowledge: "manual",
      sourceConfidence: "confirmed",
    };
    const candidate = { ...snapshot, recurringSchedules: [...snapshot.recurringSchedules.filter((existing) => existing.id !== schedule.id), normalized] };
    const overlapKey = (violation: { code: string; entityId?: string; message: string }) => `${violation.code}|${violation.entityId ?? ""}|${violation.message}`;
    const existingOverlaps = new Set(validateSnapshot(snapshot).filter(violation => violation.code === "overlapping_base_rent_schedule").map(overlapKey));
    const violations = validateSnapshot(candidate).filter(violation => violation.code === "overlapping_base_rent_schedule" && !existingOverlaps.has(overlapKey(violation)));
    if (violations.length > 0) throw new RentOpsInvariantError("Recurring schedule change would overlap an effective base-rent schedule", violations);
    const saved = await this.repository.saveRecurringSchedule(normalized);
    const changedFields = [
      "active", "activeKnowledge", "amountCents", "amountKnowledge", "category", "categoryKnowledge",
      "billingFrequency", "chargeDefinitionId", "chargeDefinitionKnowledge", "chargeDefinitionLinkKnowledge", "description", "descriptionKnowledge",
      "effectiveFrom", "effectiveFromKnowledge", "effectiveTo", "lineageRootId", "lineageRootOrigin", "personId",
      "propertyId", "recordRevision", "scopeId", "scopeLinkKnowledge", "scopeType", "scopeTypeKnowledge",
      "sourceConfidence", "tenancyId", "unitId", "versionAction", "versionOrigin",
    ].sort();
    const change: RentOpsRecordChange = {
      id: `record-change:recurring:${createHash("sha256").update(normalized.id).digest("hex").slice(0, 32)}:1`,
      entityType: "recurring_schedule",
      targetId: normalized.id,
      revision: 1,
      origin: "admin",
      actorSubject: context.actorSubject,
      occurredAt: context.occurredAt,
      changedFields,
    };
    await this.repository.saveRecordChange(change);
    await this.recordAdminChange(`Recurring ${schedule.category} schedule ${schedule.id} saved`, { propertyId: schedule.propertyId, unitId: normalized.unitId ?? undefined, tenancyId: normalized.tenancyId ?? undefined });
    return saved;
  }

  async saveRecurringScheduleSuccessor(
    predecessorId: string,
    input: RecurringScheduleSuccessorInput,
    context: RentOpsAdminPatchContext,
  ): Promise<RentOpsRecurringChargeSchedule> {
    assertTargetId(predecessorId, "Recurring schedule predecessor id");
    assertTargetId(input.id, "Recurring schedule successor id");
    if (predecessorId === input.id) throw new RentOpsInvariantError("Recurring schedule successor requires a new id");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new RentOpsInvariantError("Record revision is required");
    if (input.action !== "replace" && input.action !== "end") throw new RentOpsInvariantError("Recurring schedule successor action is invalid");
    assertIsoDate(input.effectiveFrom, "Recurring schedule successor date");
    assertAdminPatchContext(context);
    if (input.action === "replace") assertPositiveCents(input.amountCents, "Replacement recurring schedule amount");
    else if (input.amountCents !== undefined) throw new RentOpsInvariantError("An end successor cannot carry an amount");

    const snapshot = await this.snapshot();
    const predecessor = snapshot.recurringSchedules.find((candidate) => candidate.id === predecessorId);
    if (!predecessor) throw new RentOpsInvariantError("Recurring schedule predecessor was not found");
    const predecessorRevision = predecessor.recordRevision ?? 1;
    if (predecessorRevision !== input.expectedRevision) throw new RentOpsInvariantError("Recurring schedule predecessor revision is stale");
    if (!predecessor.lineageRootId || !predecessor.lineageRootOrigin || predecessor.versionAction === "end") throw new RentOpsInvariantError("Recurring schedule predecessor is terminal or has unresolved lineage");
    if (predecessor.effectiveFrom && (input.effectiveFrom < predecessor.effectiveFrom || (input.effectiveFrom === predecessor.effectiveFrom && input.action !== "end"))) throw new RentOpsInvariantError("Recurring schedule successor date must be after its predecessor");
    if (!predecessor.effectiveFrom && predecessor.effectiveFromKnowledge !== "unknown_open_start") throw new RentOpsInvariantError("Recurring schedule predecessor start is unresolved");
    if (predecessor.lineageRootOrigin === "artifact" && (!predecessor.sourceArtifactSha256 || !predecessor.artifactObservationOn || input.effectiveFrom < predecessor.artifactObservationOn)) {
      throw new RentOpsInvariantError("Recurring schedule successor is outside its verified artifact boundary");
    }
    if (predecessor.lineageRootOrigin === "manual" && (predecessor.sourceArtifactSha256 || predecessor.artifactObservationOn)) throw new RentOpsInvariantError("Manual recurring schedule lineage has invalid artifact provenance");
    if (predecessor.effectiveTo && input.effectiveFrom > predecessor.effectiveTo) throw new RentOpsInvariantError("Recurring schedule successor cannot begin after the known schedule end");
    if (!predecessor.scopeType || !predecessor.scopeId || !predecessor.propertyId || !predecessor.chargeDefinitionId || predecessor.category === null) {
      throw new RentOpsInvariantError("Recurring schedule successor requires an exact existing scope and charge definition");
    }
    if ((predecessor.scopeTypeKnowledge !== "source" && predecessor.scopeTypeKnowledge !== "manual")
      || (predecessor.scopeLinkKnowledge !== "exact" && predecessor.scopeLinkKnowledge !== "manual")
      || (predecessor.chargeDefinitionLinkKnowledge !== "exact" && predecessor.chargeDefinitionLinkKnowledge !== "manual")) {
      throw new RentOpsInvariantError("Recurring schedule successor requires trusted scope and charge-definition links");
    }

    if (input.billingFrequency !== undefined && (input.billingFrequency !== "monthly" || input.action !== "replace")) throw new RentOpsInvariantError("Monthly billing confirmation requires replacement");
    const isEnd = input.action === "end";
    const successor: RentOpsRecurringChargeSchedule = {
      ...predecessor,
      billingFrequency: input.billingFrequency ?? predecessor.billingFrequency ?? null,
      id: input.id,
      recordRevision: predecessorRevision + 1,
      source: undefined,
      amountCents: isEnd ? null : input.amountCents!,
      amountKnowledge: isEnd ? "unknown" : "known",
      effectiveFrom: input.effectiveFrom,
      effectiveFromKnowledge: "manual",
      effectiveTo: isEnd ? input.effectiveFrom : predecessor.effectiveTo,
      active: isEnd ? false : predecessor.active,
      activeKnowledge: isEnd ? "manual" : predecessor.activeKnowledge,
      lineageRootId: predecessor.lineageRootId,
      lineageRootOrigin: predecessor.lineageRootOrigin,
      versionOrigin: "manual",
      supersedesId: predecessor.id,
      versionAction: input.action,
    };
    const changedFields = [
      ...(isEnd ? ["active", "activeKnowledge", "effectiveTo"] : []),
      ...(input.billingFrequency ? ["billingFrequency"] : []),
      "amountCents",
      "amountKnowledge",
      "effectiveFrom",
      "effectiveFromKnowledge",
      "recordRevision",
      "supersedesId",
      "versionAction",
      "versionOrigin",
    ].sort();
    const change: RentOpsRecordChange = {
      id: `record-change:recurring:${createHash("sha256").update(successor.id).digest("hex").slice(0, 32)}:${successor.recordRevision}`,
      entityType: "recurring_schedule",
      targetId: successor.id,
      revision: successor.recordRevision!,
      origin: "admin",
      actorSubject: context.actorSubject,
      occurredAt: context.occurredAt,
      changedFields,
    };
    return this.repository.saveRecurringScheduleSuccessor({ predecessorId, successor, expectedRevision: input.expectedRevision, change });
  }

  async createChargeDefinition(raw: CreateChargeDefinitionInput, context: RentOpsAdminPatchContext): Promise<RentOpsChargeDefinition> {
    const parsed = createChargeDefinitionSchema.safeParse(raw);
    if (!parsed.success || !context.actorSubject?.trim()) throw new RentOpsInvariantError("Invalid charge definition input");
    return this.repository.transaction(async repository => {
      if (!repository.saveChargeDefinition || !repository.saveRecordChange) throw new RentOpsInvariantError("Charge definition persistence unavailable");
      if ((await repository.getSnapshot()).chargeDefinitions.some(row => row.id === parsed.data.id)) throw new RentOpsInvariantError("Charge definition already exists");
      const saved = await repository.saveChargeDefinition({...parsed.data, displayNameKnowledge: "manual", categoryKnowledge: "manual", activeKnowledge: "manual", recordRevision: 1});
      await repository.saveRecordChange({id: `record-change:${randomUUID()}`, entityType: "charge_definition", targetId: saved.id, revision: 1, origin: "admin", actorSubject: context.actorSubject, occurredAt: context.occurredAt, changedFields: ["active", "category", "displayName"]});
      return saved;
    });
  }

  async patchChargeDefinition(id: string, expectedRevision: number, raw: PatchChargeDefinitionInput, context: RentOpsAdminPatchContext): Promise<RentOpsChargeDefinition> {
    const parsed = patchChargeDefinitionSchema.safeParse(raw);
    if (!parsed.success) throw new RentOpsInvariantError("Invalid charge definition patch");
    return this.patchRecord("charge_definition", id, expectedRevision, parsed.data, context) as Promise<RentOpsChargeDefinition>;
  }

  async recordManualPayment(raw: ManualPaymentInput, context: RentOpsAdminPatchContext): Promise<{ payment: RentOpsLedgerTransaction; allocations: RentOpsPaymentAllocation[]; replayed: boolean }> {
    const parsed = manualPaymentSchema.safeParse(raw);
    if (!parsed.success || !context.actorSubject?.trim()) throw new RentOpsInvariantError("Invalid manual payment input");
    const input = parsed.data;
    if (new Set(input.allocations.map(row => row.chargeTransactionId)).size !== input.allocations.length) throw new RentOpsInvariantError("Duplicate allocation target");
    const total = input.allocations.reduce((sum, row) => sum + row.amountCents, 0);
    if (!Number.isSafeInteger(total) || total > input.amountCents) throw new RentOpsInvariantError("Allocations exceed payment amount");
    const initial = (await this.snapshot()).tenancies.find(row => row.id === input.tenancyId);
    if (!initial?.primaryPersonId) throw new RentOpsInvariantError("Exact payment tenancy required");
    return this.repository.transaction(async repository => {
      const service = this.withRepository(repository);
      const snapshot = await repository.getSnapshot();
      const tenancy = snapshot.tenancies.find(row => row.id === input.tenancyId);
      const unit = snapshot.units.find(row => row.id === tenancy?.unitId);
      if (!tenancy || tenancy.primaryPersonId !== initial.primaryPersonId || !unit || unit.propertyId !== tenancy.propertyId || tenancy.status === "cancelled" || !snapshot.people.some(row => row.id === tenancy.primaryPersonId)) throw new RentOpsInvariantError("Exact payment tenancy required");
      if ((snapshot.modelVersion === 3 || tenancy.source) && [tenancy.propertyLinkKnowledge, tenancy.unitLinkKnowledge, tenancy.primaryPersonLinkKnowledge, unit.propertyLinkKnowledge].some(value => value !== "manual" && value !== "exact")) throw new RentOpsInvariantError("Payment tenancy links need review");
      const payment: RentOpsLedgerTransaction = { id: input.id, propertyId: tenancy.propertyId, unitId: unit.id, tenancyId: tenancy.id, personId: tenancy.primaryPersonId,
        kind: "payment", category: input.category, categoryKnowledge: "manual", amountCents: input.amountCents, amountKnowledge: "known", status: "posted", statusKnowledge: "manual",
        postedOn: input.postedOn, postedOnKnowledge: "manual", description: input.description, descriptionKnowledge: "manual", paymentMethod: input.paymentMethod, paymentMethodKnowledge: "manual",
        payer: "tenant", payerKnowledge: "manual", propertyLinkKnowledge: "manual", unitLinkKnowledge: "manual", tenancyLinkKnowledge: "manual", personLinkKnowledge: "manual", chargeDefinitionId: null, chargeDefinitionLinkKnowledge: "unknown", dueOn: null, dueOnKnowledge: "unknown" };
      const allocations: RentOpsPaymentAllocation[] = [...input.allocations].sort((a,b) => a.chargeTransactionId.localeCompare(b.chargeTransactionId)).map(row => ({
        id: `manual-allocation:${createHash("sha256").update(JSON.stringify([input.id, row.chargeTransactionId])).digest("hex")}`, kind: "allocation", paymentTransactionId: payment.id, chargeTransactionId: row.chargeTransactionId,
        amountCents: row.amountCents, amountKnowledge: "known", allocatedOn: input.postedOn, allocatedOnKnowledge: "manual", paymentLinkKnowledge: "manual", chargeLinkKnowledge: "manual" }));
      const existing = snapshot.ledgerTransactions.find(row => row.id === payment.id);
      if (existing) {
        const savedAllocations = snapshot.paymentAllocations.filter(row => row.paymentTransactionId === payment.id);
        const equal = (a: object, b: object) => Object.entries(b).every(([key,value]) => (a as Record<string,unknown>)[key] === value);
        if (existing.source || !equal(existing,payment) || savedAllocations.length !== allocations.length || allocations.some(row => !savedAllocations.some(saved => equal(saved,row)))) throw new RentOpsInvariantError("Manual payment id conflicts with an existing operation");
        return { payment: existing, allocations: savedAllocations, replayed: true };
      }
      for (const allocation of allocations) {
        const charge = snapshot.ledgerTransactions.find(row => row.id === allocation.chargeTransactionId);
        if (!charge || charge.tenancyId !== tenancy.id || charge.propertyId !== tenancy.propertyId || charge.unitId !== unit.id || charge.personId !== tenancy.primaryPersonId || !["base_rent", "recurring_fee", "one_time_fee", "other"].includes(charge.category ?? "") || charge.payer !== "tenant" || charge.amountKnowledge === "unknown") throw new RentOpsInvariantError("Allocation requires an exact non-deposit tenant charge");
        if ((snapshot.modelVersion === 3 || charge.source) && [charge.propertyLinkKnowledge, charge.unitLinkKnowledge, charge.tenancyLinkKnowledge, charge.personLinkKnowledge].some(value => value !== "manual" && value !== "exact")) throw new RentOpsInvariantError("Charge links need review");
        if (snapshot.paymentAllocations.some(row => row.chargeTransactionId === charge.id && (row.amountCents === null || row.amountKnowledge === "unknown"))) throw new RentOpsInvariantError("Charge allocation amount needs review");
      }
      await repository.saveLedgerTransaction(payment);
      for (const allocation of allocations) await service.savePaymentAllocationRecord(allocation);
      await repository.saveActivity({id: `activity:manual-payment:${createHash("sha256").update(payment.id).digest("hex")}`, tenancyId: tenancy.id, personId: tenancy.primaryPersonId, propertyId: tenancy.propertyId, unitId: unit.id, type: "system", actor: "admin", occurredAt: context.occurredAt, summary: `Manual payment recorded by ${context.actorSubject}`});
      return { payment, allocations, replayed: false };
    }, { lockAccountPersonId: initial.primaryPersonId, lockTransactionIds: input.allocations.map(row => row.chargeTransactionId) });
  }

  async saveLedgerTransaction(transaction: RentOpsLedgerTransaction): Promise<RentOpsLedgerTransaction> {
    if (Object.entries(transaction).some(([key, value]) => value != null && (key.startsWith("source") || key === "artifactObservationOn" || key === "reversalOfId" || key === "allocationMode" || key === "chargeDefinitionId"))) throw new RentOpsInvariantError("Manual ledger entries cannot override source or system provenance");
    const knowledge = {
      categoryKnowledge: "manual", statusKnowledge: "manual", amountKnowledge: "known", postedOnKnowledge: "manual", descriptionKnowledge: "manual",
      propertyLinkKnowledge: transaction.propertyId ? "manual" : "unknown", unitLinkKnowledge: transaction.unitId ? "manual" : "unknown",
      tenancyLinkKnowledge: transaction.tenancyId ? "manual" : "unknown", personLinkKnowledge: transaction.personId ? "manual" : "unknown",
      dueOnKnowledge: transaction.dueOn ? "manual" : "unknown", paymentMethodKnowledge: transaction.paymentMethod ? "manual" : "unknown",
      payerKnowledge: transaction.payer && transaction.payer !== "unknown" ? "manual" : "unknown", chargeDefinitionLinkKnowledge: "unknown",
    } as const;
    for (const [key, value] of Object.entries(knowledge)) if ((transaction as unknown as Record<string, unknown>)[key] != null && (transaction as unknown as Record<string, unknown>)[key] !== value) throw new RentOpsInvariantError("Manual ledger knowledge must match explicit facts");
    transaction = { ...transaction, ...knowledge };

    assertCents(transaction.amountCents, "Ledger amount");
    if (!transaction.propertyId || !transaction.kind || !transaction.category || !transaction.status || !transaction.postedOn || !transaction.description?.trim()) {
      throw new RentOpsInvariantError("A native ledger entry requires explicit property, kind, category, status, date, and description facts");
    }
    if (transaction.amountCents < 0) throw new RentOpsInvariantError("Ledger amount must be non-negative");
    if (transaction.kind === "reversal") throw new RentOpsInvariantError("Use the linked reversal action to reverse a ledger transaction");
    if (transaction.kind === "adjustment" && !transaction.adjustmentDirection) throw new RentOpsInvariantError("Adjustments require an explicit debit or credit direction");
    if (transaction.kind !== "adjustment" && transaction.adjustmentDirection) throw new RentOpsInvariantError("Only adjustments may include an adjustment direction");
    if (transaction.kind === "payment" && !transaction.paymentMethod) throw new RentOpsInvariantError("Payments require a payment method");
    const saved = await this.repository.saveLedgerTransaction(transaction);
    await this.recordAdminChange(`Ledger ${transaction.kind} ${transaction.id} posted`, { propertyId: transaction.propertyId, unitId: transaction.unitId ?? undefined, tenancyId: transaction.tenancyId ?? undefined, personId: transaction.personId ?? undefined });
    return saved;
  }

  async savePaymentAllocation(allocation: RentOpsPaymentAllocation): Promise<RentOpsPaymentAllocation> {
    const lockTransactionIds = [allocation.paymentTransactionId, allocation.chargeTransactionId].filter((id): id is string => Boolean(id));
    return this.repository.transaction((repository) => this.withRepository(repository).savePaymentAllocationRecord(allocation), { lockTransactionIds });
  }

  private async savePaymentAllocationRecord(allocation: RentOpsPaymentAllocation): Promise<RentOpsPaymentAllocation> {
    if (Object.entries(allocation).some(([key,value]) => value != null && (key.startsWith("source") || key === "artifactObservationOn" || key === "creditTransactionId" || (key === "kind" && value !== "allocation")))) throw new RentOpsInvariantError("Manual allocations cannot override source or system provenance");
    const knowledge = { paymentLinkKnowledge: "manual", chargeLinkKnowledge: "manual", amountKnowledge: "known", allocatedOnKnowledge: "manual" } as const;
    for (const [key,value] of Object.entries(knowledge)) if ((allocation as unknown as Record<string,unknown>)[key] != null && (allocation as unknown as Record<string,unknown>)[key] !== value) throw new RentOpsInvariantError("Manual allocation knowledge must match explicit facts");
    allocation = { ...allocation, ...knowledge, kind: "allocation" };

    const amountCents = allocation.amountCents;
    assertCents(amountCents, "Allocation amount");
    const snapshot = await this.snapshot();
    const payment = allocation.paymentTransactionId ? snapshot.ledgerTransactions.find((transaction) => transaction.id === allocation.paymentTransactionId) : undefined;
    const charge = allocation.chargeTransactionId ? snapshot.ledgerTransactions.find((transaction) => transaction.id === allocation.chargeTransactionId) : undefined;
    const violations = validateAllocation(allocation, payment, charge, snapshot.ledgerTransactions);
    if (violations.length > 0) throw new RentOpsInvariantError("Payment allocation failed validation", violations);
    const paymentTotal = snapshot.paymentAllocations.filter((candidate) => candidate.kind !== "transfer" && candidate.paymentTransactionId === allocation.paymentTransactionId && candidate.id !== allocation.id && typeof candidate.amountCents === "number").reduce((sum, candidate) => sum + (candidate.amountCents ?? 0), 0) + amountCents;
    const reversedTargets = postedReversalTargets(snapshot.ledgerTransactions);
    const chargeTotal = snapshot.paymentAllocations.filter((candidate) => candidate.kind !== "transfer" && !!(candidate.paymentTransactionId ?? candidate.creditTransactionId) && !reversedTargets.has((candidate.paymentTransactionId ?? candidate.creditTransactionId)!) && !!candidate.chargeTransactionId && !reversedTargets.has(candidate.chargeTransactionId) && candidate.chargeTransactionId === allocation.chargeTransactionId && candidate.id !== allocation.id && typeof candidate.amountCents === "number").reduce((sum, candidate) => sum + (candidate.amountCents ?? 0), 0) + amountCents;
    if (payment && typeof payment.amountCents === "number" && paymentTotal > payment.amountCents) throw new RentOpsInvariantError("Allocations exceed payment amount");
    if (charge && typeof charge.amountCents === "number" && chargeTotal > charge.amountCents) throw new RentOpsInvariantError("Allocations exceed charge amount");
    const saved = await this.repository.savePaymentAllocation(allocation);
    await this.recordAdminChange(`Payment allocation ${allocation.id} posted`, { tenancyId: payment?.tenancyId ?? undefined });
    return saved;
  }

  async reverseLedgerTransaction(originalId: string, input: Omit<RentOpsLedgerTransaction, "id" | "kind" | "reversalOfId" | "amountCents" | "category" | "propertyId" | "unitId" | "tenancyId" | "personId"> & { id?: string }): Promise<RentOpsLedgerTransaction> {
    return this.repository.transaction((repository) => this.withRepository(repository).reverseLedgerTransactionRecord(originalId, input), { lockTransactionIds: [originalId] });
  }

  private async reverseLedgerTransactionRecord(originalId: string, input: Omit<RentOpsLedgerTransaction, "id" | "kind" | "reversalOfId" | "amountCents" | "category" | "propertyId" | "unitId" | "tenancyId" | "personId"> & { id?: string }): Promise<RentOpsLedgerTransaction> {
    const snapshot = await this.snapshot();
    const original = snapshot.ledgerTransactions.find((transaction) => transaction.id === originalId);
    if (!original) throw new RentOpsInvariantError("Original ledger transaction not found");
    if (!original.kind || !original.category || !original.propertyId || original.amountCents === null || !original.postedOn || !original.description) throw new RentOpsInvariantError("Original ledger transaction has unresolved financial facts");
    const reversal = buildReversal(original, { ...input, id: input.id ?? `reversal:${randomUUID()}` });
    const existing = snapshot.ledgerTransactions.find((transaction) => transaction.kind === "reversal" && transaction.status === "posted" && transaction.reversalOfId === originalId);
    if (existing) {
      if (input.id === existing.id && JSON.stringify(existing) === JSON.stringify(reversal)) return existing;
      throw new RentOpsInvariantError("Ledger transaction has already been reversed");
    }
    const saved = await this.repository.saveLedgerTransaction(reversal);
    await this.recordAdminChange(`Ledger transaction ${originalId} reversed`, { propertyId: original.propertyId, unitId: original.unitId ?? undefined, tenancyId: original.tenancyId ?? undefined, personId: original.personId ?? undefined });
    return saved;
  }

  async saveSecurityDeposit(deposit: RentOpsSecurityDeposit): Promise<RentOpsSecurityDeposit> {
    assertPositiveCents(deposit.amountHeldCents, "Deposit amount");
    if (!deposit.propertyId || !deposit.personId) throw new RentOpsInvariantError("Deposit requires exact property and person references");
    const snapshot = await this.snapshot();
    if (snapshot.securityDeposits.some((candidate) => candidate.id === deposit.id)) throw new RentOpsInvariantError("Security deposit already exists; use PATCH for an existing record");
    const property = snapshot.properties.find((candidate) => candidate.id === deposit.propertyId);
    const person = snapshot.people.find((candidate) => candidate.id === deposit.personId);
    const unit = deposit.unitId ? snapshot.units.find((candidate) => candidate.id === deposit.unitId) : undefined;
    const tenancy = deposit.tenancyId ? snapshot.tenancies.find((candidate) => candidate.id === deposit.tenancyId) : undefined;
    if (!property || !person || deposit.unitId && (!unit || unit.propertyId !== property.id)) throw new RentOpsInvariantError("Deposit property, optional unit, and person references are invalid");
    if (deposit.tenancyId && (!tenancy || tenancy.propertyId !== property.id || deposit.unitId && tenancy.unitId !== deposit.unitId || tenancy.primaryPersonId !== deposit.personId)) throw new RentOpsInvariantError("Deposit tenancy does not exactly match its property, unit, and person");
    if (deposit.disposedOn && deposit.receivedOn && deposit.disposedOn < deposit.receivedOn) throw new RentOpsInvariantError("Deposit disposition cannot predate receipt");
    const normalized: RentOpsSecurityDeposit = { ...deposit, unitLinkKnowledge: deposit.unitId ? (deposit.source ? "exact" : "manual") : "unknown", receivedOnKnowledge: deposit.receivedOn ? (deposit.source ? "source" : "manual") : "unknown" };
    const saved = await this.repository.saveSecurityDeposit(normalized);
    await this.recordAdminChange(`Deposit ${deposit.id} saved`, { propertyId: deposit.propertyId, unitId: deposit.unitId, tenancyId: deposit.tenancyId, personId: deposit.personId });
    return saved;
  }

  async saveSubsidyContract(contract: RentOpsSubsidyContract): Promise<RentOpsSubsidyContract> {
    assertCents(contract.agencyObligationCents, "Agency obligation");
    assertCents(contract.tenantObligationCents, "Tenant obligation");
    if (contract.agencyObligationCents < 0 || contract.tenantObligationCents < 0) throw new RentOpsInvariantError("Housing-assistance obligations cannot be negative");
    if (contract.agencyObligationCents + contract.tenantObligationCents <= 0) throw new RentOpsInvariantError("Housing-assistance obligations must total more than zero");
    if (contract.effectiveTo && contract.effectiveTo < contract.effectiveFrom) throw new RentOpsInvariantError("Housing-assistance end cannot predate its start");
    const snapshot = await this.snapshot();
    if (snapshot.subsidyContracts.some((candidate) => candidate.id === contract.id)) throw new RentOpsInvariantError("Subsidy contract already exists; use PATCH for an existing record");
    const overlapping = snapshot.subsidyContracts.find((candidate) => candidate.id !== contract.id && candidate.tenancyId === contract.tenancyId && candidate.status !== "pending" && contract.status !== "pending" && candidate.effectiveFrom <= (contract.effectiveTo ?? "9999-12-31") && contract.effectiveFrom <= (candidate.effectiveTo ?? "9999-12-31"));
    if (overlapping) throw new RentOpsInvariantError("Housing-assistance contract overlaps an existing contract");
    const saved = await this.repository.saveSubsidyContract(contract);
    await this.recordAdminChange(`Housing-assistance contract ${contract.id} saved`, { propertyId: contract.propertyId, unitId: contract.unitId, tenancyId: contract.tenancyId });
    return saved;
  }
  async saveDocument(document: RentOpsDocument): Promise<RentOpsDocument> {
    assertPrivateStorageKey(document.storageKey);
    const violations = documentReferenceViolations(await this.snapshot(), document);
    if (violations.length > 0) throw new RentOpsInvariantError("Document references are invalid", violations);
    const saved = await this.repository.saveDocument(document);
    await this.recordAdminChange(`Document metadata ${document.id} saved`, { propertyId: document.propertyId, unitId: document.unitId, tenancyId: document.tenancyId, personId: document.personId, applicationId: document.applicationId });
    return saved;
  }
  async saveActivity(event: RentOpsActivityEvent): Promise<RentOpsActivityEvent> { if ((await this.snapshot()).activityEvents.some((candidate) => candidate.id === event.id)) throw new RentOpsInvariantError("Activity already exists; use PATCH for an existing record"); const saved = await this.repository.saveActivity(event); await this.recordAdminChange(`Activity ${event.id} recorded`, { propertyId: event.propertyId, unitId: event.unitId, tenancyId: event.tenancyId, personId: event.personId, applicationId: event.applicationId }); return saved; }
}
