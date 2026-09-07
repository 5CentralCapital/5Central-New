import { requireCentsInput } from "./money";
import { sparseEditValue } from "./ui";
import type { RentOpsMutation } from "./types";

export type QuickAction = RentOpsMutation["action"];
export type FormValue = string | boolean | number | null | undefined;
export type FormValues = Record<string, FormValue>;

export const RENT_OPS_QUICK_ADD_ACTIONS: QuickAction[] = [
  "save-property", "save-unit", "save-person", "save-household-membership", "save-tenancy", "save-lease-term",
  "save-recurring-schedule", "post-ledger-transaction", "save-payment-allocation", "reverse-ledger-transaction",
  "save-security-deposit", "save-activity",
];

export function mutationPayload(action: QuickAction, values: FormValues, initialValues: FormValues = {}): Record<string, unknown> {
  const helperKeys = new Set(["amountDollars", "marketRentDollars", "agencyDollars", "tenantDollars", "address1", "city", "stateCode", "postalCode"]);
  const editing = typeof values.revision === "number" && Number.isSafeInteger(values.revision) && values.revision > 0;
  const changedValue = (key: string): FormValue => sparseEditValue(values[key], initialValues[key], Object.prototype.hasOwnProperty.call(initialValues, key), editing) as FormValue;
  const clean = Object.fromEntries(Object.keys(values).flatMap((key) => {
    if (helperKeys.has(key) || key === "id" || key === "revision" || key === "recordRevision") return [];
    const value = changedValue(key);
    return value === undefined || (!editing && value === "") ? [] : [[key, value]];
  }));
  const id = String(values.id || `manual:${action}:${crypto.randomUUID()}`);
  const cents = (name: string) => requireCentsInput(values[name], name.replace(/Dollars$/, "").replace(/^./, (letter) => letter.toUpperCase()));
  const optionalCents = (name: string): number | null | undefined => {
    const value = values[name];
    if (value === "" || value === undefined) return editing && changedValue(name) === null ? null : undefined;
    return cents(name);
  };
  const finish = (body: Record<string, unknown>): Record<string, unknown> => editing ? { ...body, revision: values.revision } : body;
  if (action === "convert-application") {
    const memberIds = ["primary", ...Object.keys(values).filter((key) => key.startsWith("memberRole:") && key !== "memberRole:primary").map((key) => key.slice("memberRole:".length))];
    const chargeDefinitionId = String(values.chargeDefinitionId ?? "").trim();
    const category = String(values.category ?? "").trim();
    const scheduleDescription = String(values.scheduleDescription ?? "").trim();
    if (!chargeDefinitionId) throw new Error("A confirmed charge definition is required.");
    if (!category) throw new Error("A charge category is required.");
    if (!scheduleDescription) throw new Error("A schedule description is required.");
    return {
      applicationId: values.applicationId,
      propertyId: values.propertyId,
      unitId: values.unitId,
      plannedMoveInOn: values.plannedMoveInOn,
      leaseStatus: values.leaseStatus,
      contractStartOn: values.contractStartOn,
      ...(values.contractEndOn ? { contractEndOn: values.contractEndOn } : {}),
      monthToMonth: values.monthToMonth === "true",
      baseRentCents: cents("baseRentDollars"),
      chargeDefinitionId,
      category,
      scheduleDescription,
      primaryFinanciallyResponsible: values.primaryFinanciallyResponsible === "true",
      members: memberIds.map((applicationMemberId) => ({
        applicationMemberId,
        role: values[`memberRole:${applicationMemberId}`],
        isFinanciallyResponsible: values[`memberFinanciallyResponsible:${applicationMemberId}`] === "true",
        ...(values[`memberRelationship:${applicationMemberId}`] ? { relationship: values[`memberRelationship:${applicationMemberId}`] } : {}),
      })),
    };
  }
  if (action === "save-property") {
    const address = Object.fromEntries([["line1", changedValue("address1")], ["city", changedValue("city")], ["state", changedValue("stateCode")], ["postalCode", changedValue("postalCode")]].filter((entry): entry is [string, FormValue] => entry[1] !== undefined));
    return finish({ id, ...(changedValue("name") !== undefined ? { name: changedValue("name") } : {}), ...(changedValue("slug") !== undefined ? { slug: changedValue("slug") } : {}), ...(Object.keys(address).length ? { address } : {}), ...(changedValue("propertyType") !== undefined ? { propertyType: changedValue("propertyType") } : {}), ...(changedValue("propertyState") !== undefined ? { state: changedValue("propertyState") } : {}), ...(changedValue("operatingContact") !== undefined ? { operatingContact: changedValue("operatingContact") } : {}) });
  }
  if (action === "save-unit") return finish({ ...clean, id, ...(values.bedrooms === "" ? (editing && changedValue("bedrooms") === null ? { bedrooms: null } : {}) : { bedrooms: Number(values.bedrooms) }), ...(values.bathrooms === "" ? (editing && changedValue("bathrooms") === null ? { bathrooms: null } : {}) : { bathrooms: Number(values.bathrooms) }), ...(optionalCents("marketRentDollars") !== undefined ? { marketRentCents: optionalCents("marketRentDollars") } : {}) });
  if (action === "save-person") return finish({ ...clean, id });
  if (action === "save-household-membership") return finish({ ...clean, id, ...(editing ? {} : { isFinanciallyResponsible: values.isFinanciallyResponsible === true }) });
  if (action === "save-tenancy") return finish({ ...clean, id });
  if (action === "save-lease-term") {
    const monthToMonth = changedValue("monthToMonth");
    return finish({ ...clean, id, ...(monthToMonth !== undefined ? { monthToMonth: monthToMonth === true } : {}) });
  }
  if (action === "save-recurring-schedule") {
    // Manual roots are intentionally rebuilt from a small positive allowlist.
    // In particular, stale form values can never leak source, artifact,
    // knowledge, lineage, or revision claims into the root request.
    const requiredValue = (name: string, label: string): string => {
      const value = String(values[name] ?? "").trim();
      if (!value) throw new Error(`${label} is required.`);
      return value;
    };
    const amountCents = requireCentsInput(values.amountDollars, "Amount");
    if (amountCents <= 0) throw new Error("Amount must be greater than zero.");
    const activeValue = values.active;
    if (activeValue !== "true" && activeValue !== "false" && activeValue !== true && activeValue !== false) {
      throw new Error("Schedule status is required.");
    }
    const body: Record<string, unknown> = {
      id,
      scopeType: requiredValue("scopeType", "Recurring scope"),
      scopeId: requiredValue("scopeId", "Scope"),
      propertyId: requiredValue("propertyId", "Property"),
      chargeDefinitionId: requiredValue("chargeDefinitionId", "Charge definition"),
      category: requiredValue("category", "Charge category"),
      description: requiredValue("description", "Description"),
      amountCents,
      effectiveFrom: requiredValue("effectiveFrom", "Effective start date"),
      active: activeValue === "true" || activeValue === true,
    };
    for (const key of ["tenancyId", "personId", "unitId", "effectiveTo"] as const) {
      const value = String(values[key] ?? "").trim();
      if (value) body[key] = value;
    }
    return body;
  }
  if (action === "replace-recurring-schedule" || action === "end-recurring-schedule") {
    const predecessorId = String(values.predecessorId ?? initialValues.predecessorId ?? "").trim();
    if (!predecessorId) throw new Error("A predecessor recurring schedule is required.");
    const expectedRevisionValue = values.expectedRevision ?? initialValues.expectedRevision;
    const expectedRevision = typeof expectedRevisionValue === "number" ? expectedRevisionValue : Number(String(expectedRevisionValue ?? ""));
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("The predecessor revision is required.");
    const effectiveFrom = String(values.effectiveFrom ?? "").trim();
    if (!effectiveFrom) throw new Error("The successor effective date is required.");
    const successorId = String(values.successorId ?? values.id ?? "").trim() || `manual:recurring-successor:${crypto.randomUUID()}`;
    const body: Record<string, unknown> = { predecessorId, id: successorId, expectedRevision, action: action === "replace-recurring-schedule" ? "replace" : "end", effectiveFrom };
    if (action === "replace-recurring-schedule") {
      const amountCents = requireCentsInput(values.amountDollars, "Replacement amount");
      if (amountCents <= 0) throw new Error("Replacement amount must be greater than zero.");
      body.amountCents = amountCents;
    }
    return body;
  }
  if (action === "post-ledger-transaction") return { ...clean, id, amountCents: cents("amountDollars") };
  if (action === "save-payment-allocation") return { ...clean, id, amountCents: cents("amountDollars") };
  if (action === "reverse-ledger-transaction") return { ...clean };
  if (action === "save-security-deposit") {
    const body: Record<string, unknown> = { ...clean, id, ...(optionalCents("amountDollars") !== undefined ? { amountHeldCents: optionalCents("amountDollars") } : {}) };
    delete body.receivedOn;
    delete body.receivedOnKnowledge;
    const receivedOn = changedValue("receivedOn");
    if (editing) {
      if (receivedOn !== undefined) body.receivedOn = receivedOn;
    } else if (values.receivedOnKnowledge === "unknown") body.receivedOnKnowledge = "unknown";
    else if (values.receivedOn) body.receivedOn = values.receivedOn;
    return finish(body);
  }
  if (action === "save-subsidy-contract") {
    // v7 permits only status edits for existing HAP rows.  Do not let the
    // hidden create-form values leak into the sparse PATCH body.
    if (editing) return finish({ id, ...(changedValue("status") !== undefined ? { status: changedValue("status") } : {}) });
    return finish({ ...clean, id, ...(optionalCents("agencyDollars") !== undefined ? { agencyObligationCents: optionalCents("agencyDollars") } : {}), ...(optionalCents("tenantDollars") !== undefined ? { tenantObligationCents: optionalCents("tenantDollars") } : {}) });
  }
  if (action === "save-activity") {
    const occurredAt = String(values.occurredAt ?? "");
    const parsedAt = new Date(occurredAt);
    if (!occurredAt || !Number.isFinite(parsedAt.getTime())) throw new Error("A valid activity time is required.");
    return finish({ ...clean, id, occurredAt: parsedAt.toISOString() });
  }
  return finish({ ...clean, id });
}
