import { usdCurrencyFormatter } from '../../../lib/rent-ops-formatters';
import type { AdminSnapshot, AdminLedgerTransactionView } from "../types";
import type { FormValues, QuickAction } from "../form-payload";
function title(value: unknown): string {
  if (value === "amountHeldCents") return "Amount held";
  if (value === "sourceBalanceCents") return "Source balance";
  return String(value ?? "—").replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function money(cents: unknown): string {
  if (cents == null || cents === "") return "Needs review";
  const amount = typeof cents === "number" ? cents : Number(cents);
  if (!Number.isFinite(amount)) return "Needs review";
  return usdCurrencyFormatter.format(amount / 100);
}

type Field = { name: string; label: string; type?: "text" | "date" | "datetime-local" | "number" | "select" | "textarea" | "checkbox"; required?: boolean; options?: Array<[string, string]>; locked?: boolean };

export function baseOptions(snapshot: AdminSnapshot) {
  return {
    properties: snapshot.snapshot.properties.map((item) => [item.id, item.name ?? "Needs review"] as [string, string]),
    units: snapshot.snapshot.units.map((item) => [item.id, `${snapshot.snapshot.properties.find((p) => p.id === item.propertyId)?.name ?? "Needs review"} · ${item.unitNumber ?? "Needs review"}`] as [string, string]),
    people: snapshot.snapshot.people.map((item) => [item.id, `${item.firstName ?? "Needs review"} ${item.lastName ?? "Needs review"}`] as [string, string]),
    tenancies: snapshot.snapshot.tenancies.map((item) => [item.id, `${snapshot.snapshot.properties.find(p => p.id === item.propertyId)?.name ?? "Needs review"} · Unit ${snapshot.snapshot.units.find(unit => unit.id === item.unitId)?.unitNumber ?? "Needs review"} · ${snapshot.snapshot.people.filter(p => p.id === item.primaryPersonId).map(p => [p.firstName, p.lastName].filter(Boolean).join(" ")).join("") || "Tenant needs review"} · ${title(item.status)}`] as [string, string]),
    payments: snapshot.snapshot.ledgerTransactions.filter((item) => item.kind === "payment").map((item) => [item.id, `${item.postedOn ?? "Needs review"} · ${money(item.amountCents)} · ${item.description ?? "Needs review"}`] as [string, string]),
    charges: snapshot.snapshot.ledgerTransactions.filter((item) => item.kind === "charge").map((item) => [item.id, `${item.postedOn ?? "Needs review"} · ${money(item.amountCents)} · ${item.description ?? "Needs review"}`] as [string, string]),
    ledger: snapshot.snapshot.ledgerTransactions.filter((item) => item.status === "posted").map((item) => [item.id, `${title(item.kind)} · ${item.postedOn ?? "Needs review"} · ${money(item.amountCents)}`] as [string, string]),
  };
}

function rawActionFields(action: QuickAction, snapshot: AdminSnapshot, initialValues: FormValues = {}): Field[] {
  const options = baseOptions(snapshot);
  const property: Field = { name: "propertyId", label: "Property", type: "select", required: true, options: options.properties };
  const unit: Field = { name: "unitId", label: "Unit", type: "select", options: options.units };
  const tenancy: Field = { name: "tenancyId", label: "Tenancy", type: "select", options: options.tenancies };
  const person: Field = { name: "personId", label: "Resident", type: "select", options: options.people };
  const dollars: Field = { name: "amountDollars", label: "Amount", type: "number", required: true };
  const confirmedDefinitions = snapshot.chargeDefinitions.filter((definition) => definition.id && definition.category && definition.active === true && (definition.activeKnowledge === "source" || definition.activeKnowledge === "manual") && (definition.categoryKnowledge === "source" || definition.categoryKnowledge === "manual"));
  const definitionOptions: Array<[string, string]> = confirmedDefinitions.map((definition) => [definition.id!, `${definition.displayName ?? "Needs review"} · ${title(definition.category)}`]);
  const categoryOptions: Array<[string, string]> = Array.from(new Set(confirmedDefinitions.map((definition) => definition.category).filter((category): category is string => Boolean(category)))).map((category) => [category, title(category)]);
  const conversionDefinitionOptions: Array<[string, string]> = confirmedDefinitions.filter((definition) => definition.category === "base_rent").map((definition) => [definition.id!, `${definition.displayName ?? "Needs review"} · Base rent`]);
  const scopeOptions: Array<[string, string]> = [
    ...options.properties.map(([id, label]) => [id, `Property · ${label}`] as [string, string]),
    ...options.units.map(([id, label]) => [id, `Unit · ${label}`] as [string, string]),
    ...options.people.map(([id, label]) => [id, `Resident · ${label}`] as [string, string]),
  ];
  switch (action) {
    case "save-property": return [{ name: "name", label: "Property name", required: true }, { name: "slug", label: "Short URL name", required: true }, { name: "address1", label: "Street address", required: true }, { name: "city", label: "City", required: true }, { name: "stateCode", label: "State", required: true }, { name: "postalCode", label: "ZIP", required: true }, { name: "propertyType", label: "Property type", type: "select", required: true, options: [["multifamily", "Multifamily"], ["single_family", "Single family"], ["other", "Other"]] }, { name: "propertyState", label: "Property state", type: "select", required: true, options: [["active", "Active"], ["archived", "Archived"]] }, { name: "operatingContact", label: "Operating contact" }];
    case "save-unit": return [property, { name: "unitNumber", label: "Unit", required: true }, { name: "unitType", label: "Unit type" }, { name: "squareFeet", label: "Square feet", type: "number" }, { name: "defaultDepositDollars", label: "Default deposit", type: "number" }, { name: "amenitiesText", label: "Amenities (one per line)", type: "textarea" }, { name: "accessNotes", label: "Access notes", type: "textarea" }, { name: "bedrooms", label: "Bedrooms", type: "number" }, { name: "bathrooms", label: "Bathrooms", type: "number" }, { name: "marketRentDollars", label: "Market rent", type: "number" }, { name: "readiness", label: "Readiness", type: "select", required: true, options: [["ready", "Ready"], ["not_ready", "Not ready"], ["off_market", "Off market"]] }, { name: "listing", label: "Listing", type: "select", required: true, options: [["listed", "Listed"], ["unlisted", "Unlisted"], ["off_market", "Off market"]] }];
    case "save-person": return [{ name: "firstName", label: "First name", required: true }, { name: "lastName", label: "Last name", required: true }, { name: "email", label: "Email" }, { name: "phone", label: "Phone" }, { name: "renterInsuranceExpiresOn", label: "Insurance expires", type: "date" }, { name: "archived", label: "Archived", type: "checkbox" }];
    case "save-household-membership": return [{ ...tenancy, required: true }, { ...person, required: true }, { name: "role", label: "Household role", type: "select", required: true, options: [["primary", "Primary"], ["co_applicant", "Co-applicant"], ["occupant", "Occupant"], ["minor", "Minor"], ["emergency_contact", "Emergency contact"], ["other_contact", "Other contact"]] }, { name: "relationship", label: "Relationship" }, { name: "isFinanciallyResponsible", label: "Financially responsible", type: "checkbox", required: true }];
    case "save-tenancy": return [property, { ...unit, required: true }, { name: "primaryPersonId", label: "Primary resident", type: "select", required: true, options: options.people }, { name: "status", label: "Status", type: "select", required: true, options: ["future", "current", "notice", "past", "cancelled"].map((value) => [value, title(value)] as [string, string]) }, { name: "plannedMoveInOn", label: "Planned move-in", type: "date" }, { name: "actualMoveInOn", label: "Actual move-in", type: "date" }, { name: "noticeOn", label: "Notice date", type: "date" }, { name: "expectedMoveOutOn", label: "Expected move-out", type: "date" }, { name: "actualMoveOutOn", label: "Actual move-out", type: "date" }];
    case "save-lease-term": return [{ ...tenancy, required: true }, { name: "status", label: "Lease status", type: "select", required: true, options: ["draft", "executed", "expired", "month_to_month", "cancelled"].map((value) => [value, title(value)] as [string, string]) }, { name: "contractStartOn", label: "Contract start", type: "date", required: true }, { name: "contractEndOn", label: "Contract end", type: "date" }, { name: "signedOn", label: "Signed date", type: "date" }, { name: "monthToMonth", label: "Month to month", type: "checkbox", required: true }];
    case "save-recurring-schedule": return [property, { name: "unitId", label: "Unit (when applicable)", type: "select", options: options.units }, { name: "tenancyId", label: "Tenancy (when applicable)", type: "select", options: options.tenancies }, { name: "personId", label: "Resident (when applicable)", type: "select", options: options.people }, { name: "scopeType", label: "Recurring scope", type: "select", required: true, options: [["tenant", "Tenant"], ["unit", "Unit"], ["property", "Property"]] }, { name: "scopeId", label: "Selected scope", type: "select", required: true, options: scopeOptions }, { name: "chargeDefinitionId", label: "Charge", type: "select", required: true, options: definitionOptions }, { name: "category", label: "Charge category", type: "select", required: true, options: categoryOptions }, { name: "description", label: "Description", required: true }, dollars, { name: "billingFrequency", label: "Frequency", type: "select", required: true, options: [["monthly", "Monthly"]] }, { name: "effectiveFrom", label: "Start date", type: "date", required: true }, { name: "effectiveTo", label: "End date", type: "date" }, { name: "active", label: "Schedule status", type: "select", required: true, options: [["true", "Active"], ["false", "Inactive"]] }];
    case "replace-recurring-schedule": return [{ name: "billingFrequency", label: "Confirm billing frequency (optional)", type: "select", options: [["monthly", "Monthly — confirmed"]] }, { name: "effectiveFrom", label: "Replacement effective date", type: "date", required: true }, { name: "amountDollars", label: "Replacement amount", type: "number", required: true }];
    case "end-recurring-schedule": return [{ name: "effectiveFrom", label: "End effective date", type: "date", required: true }];
    case "post-ledger-transaction": return [property, unit, tenancy, person, { name: "kind", label: "Entry type", type: "select", required: true, options: [["charge", "Charge"], ["credit", "Credit"]] }, { name: "category", label: "Category", type: "select", required: true, options: [["base_rent", "Base rent"], ["recurring_fee", "Recurring fee"], ["subsidy", "Housing assistance"], ["security_deposit", "Security deposit"], ["other", "Other"]] }, dollars, { name: "status", label: "Entry status", type: "select", required: true, options: [["posted", "Posted"], ["pending", "Pending"], ["voided", "Voided"]] }, { name: "postedOn", label: "Posted date", type: "date", required: true }, { name: "dueOn", label: "Due date", type: "date" }, { name: "payer", label: "Payer", type: "select", options: [["tenant", "Tenant"], ["agency", "Agency"], ["owner", "Owner"], ["unknown", "Unknown"]] }, { name: "paymentMethod", label: "Payment method", type: "select", options: ["ach", "zelle", "check", "cash", "money_order", "card", "other"].map((value) => [value, title(value)] as [string, string]) }, { name: "description", label: "Description", required: true }];
    case "save-payment-allocation": return [{ name: "paymentTransactionId", label: "Payment", type: "select", required: true, options: options.payments }, { name: "chargeTransactionId", label: "Charge", type: "select", required: true, options: options.charges }, dollars, { name: "allocatedOn", label: "Allocation date", type: "date", required: true }];
    case "reverse-ledger-transaction": return [{ name: "originalId", label: "Entry to reverse", type: "select", required: true, options: options.ledger }, { name: "postedOn", label: "Reversal date", type: "date", required: true }, { name: "status", label: "Reversal status", type: "select", required: true, options: [["posted", "Posted"], ["voided", "Voided"], ["pending", "Pending"]] }, { name: "description", label: "Reason", type: "textarea", required: true }];
    case "save-security-deposit": return [property, unit, tenancy, { ...person, required: true }, { name: "type", label: "Deposit type", type: "select", required: true, options: [["security", "Security"], ["refundable_pet", "Refundable pet"], ["other_refundable", "Other refundable"]] }, { ...dollars, label: "Amount held" }, { name: "receivedOn", label: "Received date", type: "date" }, { name: "receivedOnKnowledge", label: "Receipt-date knowledge", type: "select", options: [["source", "Known source date"], ["unknown", "Unknown"]] }, { name: "dispositionStatus", label: "Disposition", type: "select", required: true, options: [["held", "Held"], ["partially_disposed", "Partially disposed"], ["disposed", "Disposed"], ["returned", "Returned"]] }, { name: "disposedOn", label: "Disposition date", type: "date" }, { name: "dispositionNotes", label: "Disposition notes", type: "textarea" }];
    case "save-subsidy-contract": return [property, { ...unit, required: true }, { ...tenancy, required: true }, { name: "agencyName", label: "Housing agency", required: true }, { name: "contractNumber", label: "Contract number" }, { name: "effectiveFrom", label: "Effective from", type: "date", required: true }, { name: "effectiveTo", label: "End date", type: "date" }, { name: "agencyDollars", label: "Agency portion", type: "number", required: true }, { name: "tenantDollars", label: "Tenant portion", type: "number", required: true }, { name: "status", label: "Contract status", type: "select", required: true, options: [["active", "Active"], ["ended", "Ended"], ["pending", "Pending"], ["exception", "Exception"]] }];
    case "convert-application": {
      const applicationId = typeof initialValues.applicationId === "string" ? initialValues.applicationId : "";
      const memberIds = snapshot.snapshot.applicationHouseholdMembers.filter((member) => member.applicationId === applicationId).map((member) => member.id);
      const roleOptions = ["primary", "co_applicant", "occupant", "minor", "emergency_contact", "other_contact"].map((value) => [value, title(value)] as [string, string]);
      const fields: Field[] = [property, { ...unit, required: true }, { name: "chargeDefinitionId", label: "Confirmed base-rent definition", type: "select", required: true, options: conversionDefinitionOptions }, { name: "category", label: "Charge category", type: "select", required: true, options: [["base_rent", "Base rent"]] }, { name: "scheduleDescription", label: "Recurring schedule description", required: true }, { name: "billingFrequency", label: "Frequency", type: "select", required: true, options: [["monthly", "Monthly"]] }, { name: "plannedMoveInOn", label: "Planned move-in", type: "date", required: true }, { name: "leaseStatus", label: "Lease status", type: "select", required: true, options: [["draft", "Draft"], ["executed", "Executed"], ["expired", "Expired"], ["month_to_month", "Month to month"], ["cancelled", "Cancelled"]] }, { name: "contractStartOn", label: "Contract start", type: "date", required: true }, { name: "contractEndOn", label: "Contract end", type: "date" }, { name: "monthToMonth", label: "Month to month", type: "select", required: true, options: [["true", "Yes"], ["false", "No"]] }, { name: "baseRentDollars", label: "Contractual base rent", type: "number", required: true }, { name: "primaryFinanciallyResponsible", label: "Primary financially responsible", type: "select", required: true, options: [["true", "Yes"], ["false", "No"]] }, { name: "memberRole:primary", label: "Primary role", type: "select", required: true, options: roleOptions }, { name: "memberFinanciallyResponsible:primary", label: "Primary member responsibility", type: "select", required: true, options: [["true", "Yes"], ["false", "No"]] }, { name: "memberRelationship:primary", label: "Primary relationship" }];
      for (const memberId of memberIds) fields.push({ name: `memberRole:${memberId}`, label: `Member ${memberIds.indexOf(memberId) + 1} role`, type: "select", required: true, options: roleOptions }, { name: `memberFinanciallyResponsible:${memberId}`, label: `Member ${memberIds.indexOf(memberId) + 1} responsibility`, type: "select", required: true, options: [["true", "Yes"], ["false", "No"]] }, { name: `memberRelationship:${memberId}`, label: `Member ${memberIds.indexOf(memberId) + 1} relationship` });
      return fields;
    }
    case "save-activity": return [property, unit, tenancy, person, { name: "type", label: "Activity type", type: "select", required: true, options: ["note", "call", "email", "text", "promise_to_pay", "hold", "notice"].map((value) => [value, title(value)] as [string, string]) }, { name: "occurredAt", label: "When it occurred", type: "datetime-local", required: true }, { name: "actor", label: "Actor", required: true }, { name: "summary", label: "Summary", required: true }, { name: "detail", label: "Details", type: "textarea" }];
    default: return [];
  }
}

export function actionFields(action: QuickAction, snapshot: AdminSnapshot, initialValues: FormValues = {}): Field[] {
  const fields = rawActionFields(action, snapshot, initialValues);
  const editing = typeof initialValues.revision === "number" && Number.isSafeInteger(initialValues.revision) && initialValues.revision > 0;
  // Existing imported rows can legitimately have unknown/null facts.  Sparse
  // PATCH forms never require the operator to fabricate omitted facts.
  if (!editing) return fields;
  const editableFields = action === "save-subsidy-contract" ? fields.filter((field) => field.name === "status") : fields;
  return editableFields.map((field) => ({ ...field, required: false }));
}

export const ACTION_LABELS: Partial<Record<QuickAction, string>> = {
  "save-property": "Save property",
  "save-unit": "Save unit",
  "save-person": "Save resident",
  "save-household-membership": "Save household member",
  "save-tenancy": "Save tenancy",
  "save-lease-term": "Save lease term",
  "save-recurring-schedule": "Add recurring charge",
  "replace-recurring-schedule": "Replace recurring charge",
  "end-recurring-schedule": "End recurring charge",
  "post-ledger-transaction": "Post charge or credit",
  "save-payment-allocation": "Allocate payment",
  "reverse-ledger-transaction": "Reverse ledger entry",
  "save-security-deposit": "Update deposit liability",
  "save-subsidy-contract": "Update HAP contract",
  "save-activity": "Add note or activity",
  "convert-application": "Convert application",
};

export function confirmedChargeDefinition(snapshot: AdminSnapshot, id: unknown, category: unknown) {
  const definitionId = typeof id === "string" ? id.trim() : "";
  const selectedCategory = typeof category === "string" ? category.trim() : "";
  const definition = snapshot.chargeDefinitions.find((candidate) => candidate.id === definitionId);
  if (!definition || !definition.category || definition.category !== selectedCategory || definition.active !== true || (definition.activeKnowledge !== "source" && definition.activeKnowledge !== "manual") || (definition.categoryKnowledge !== "source" && definition.categoryKnowledge !== "manual")) {
    throw new Error("Select an active, confirmed charge definition whose category matches the selected category.");
  }
  return definition;
}


/** Resolve only known parent links; an unknown relationship never matches by default. */
export function transactionMatchesContext(snapshot: AdminSnapshot, transaction: AdminLedgerTransactionView, values: FormValues): boolean {
  const data = snapshot.snapshot;
  const tenancy = data.tenancies.find(t => t.id === transaction.tenancyId);
  const unitId = transaction.unitId || tenancy?.unitId;
  const propertyId = transaction.propertyId || tenancy?.propertyId || data.units.find(u => u.id === unitId)?.propertyId;
  if (values.propertyId && propertyId !== values.propertyId) return false;
  if (values.unitId && unitId !== values.unitId) return false;
  if (values.tenancyId && transaction.tenancyId !== values.tenancyId) return false;
  if (values.personId) {
    if (transaction.personId) return transaction.personId === values.personId;
    if (!tenancy || (tenancy.primaryPersonId !== values.personId && !data.householdMemberships.some(m => m.tenancyId === tenancy.id && m.personId === values.personId))) return false;
  }
  return true;
}

function transactionChoices(snapshot: AdminSnapshot, field: string, values: FormValues) {
  const payment = field === "chargeTransactionId" ? snapshot.snapshot.ledgerTransactions.find(t => t.id === values.paymentTransactionId) : undefined;
  const paymentContext: FormValues = payment ? { propertyId: payment.propertyId, unitId: payment.unitId, tenancyId: payment.tenancyId, personId: payment.personId } : {};
  return snapshot.snapshot.ledgerTransactions.filter(t => transactionMatchesContext(snapshot, t, values) && transactionMatchesContext(snapshot, t, paymentContext));
}

/** Narrow available choices without changing any selected relationship. */
export function scopedFields(action: QuickAction, snapshot: AdminSnapshot, initial: FormValues, values: FormValues) {
  const data = snapshot.snapshot;
  const units = data.units.filter(u => !values.propertyId || u.propertyId === values.propertyId);
  const tenancies = data.tenancies.filter(t => (!values.propertyId || t.propertyId === values.propertyId) && (!values.unitId || t.unitId === values.unitId) && (!values.personId || t.primaryPersonId === values.personId || data.householdMemberships.some(m => m.tenancyId === t.id && m.personId === values.personId)));
  const people = data.people.filter(p => (!values.tenancyId && !values.unitId && !values.propertyId) || tenancies.some(t => (!values.tenancyId || t.id === values.tenancyId) && (t.primaryPersonId === p.id || data.householdMemberships.some(m => m.tenancyId === t.id && m.personId === p.id))));
  const contextualCharge = (action === "save-recurring-schedule" || action === "post-ledger-transaction") && Boolean(initial.personId);
  const hidden = contextualCharge ? new Set(action === "save-recurring-schedule" ? ["scopeType", "scopeId", "category", "active"] : ["kind", "status", "payer", "paymentMethod"]) : new Set<string>();
  return actionFields(action, snapshot, initial).filter(field => !hidden.has(field.name)).map(original => {
    const field = { ...original, locked: contextualCharge && ["propertyId", "unitId", "tenancyId", "personId"].includes(original.name) && Boolean(initial[original.name]) };
    if (contextualCharge && ["propertyId", "unitId", "tenancyId", "personId"].includes(field.name)) field.required = true;
    let allowed: Set<string | undefined> | undefined;
    if (field.name === "unitId") allowed = new Set(units.map(u => u.id));
    if (field.name === "tenancyId") allowed = new Set(tenancies.map(t => t.id));
    // Choosing a new household member or primary tenant must include unattached people.
    if (field.name === "personId" && action !== "save-household-membership") allowed = new Set(people.map(p => p.id));
    if (field.name === "scopeId") allowed = new Set(values.scopeType === "property" ? [String(values.propertyId || "")] : values.scopeType === "unit" ? units.map(u => u.id) : values.scopeType === "tenant" ? people.map(p => p.id) : []);
    const transactionField = ["paymentTransactionId", "chargeTransactionId", "originalId"].includes(field.name);
    if (transactionField) allowed = new Set(transactionChoices(snapshot, field.name, values).map(t => t.id));
    if (!field.options) return field;
    const current = String(values[field.name] ?? "");
    const options = field.options.filter(([id]) => !allowed || allowed.has(id) || id === current);
    if (current && !options.some(([id]) => id === current)) options.push([current, "Existing selection · needs review"]);
    return { ...field, options: transactionField ? options.map(([id, label]): [string, string] => [id, allowed?.has(id) ? label : `${label} · outside selected context`]) : options };
  });
}

export function editorTitle(action: QuickAction, initial: FormValues) {
  const noun = ({ "save-person": "Tenant", "save-property": "Property", "save-unit": "Unit" } as Partial<Record<QuickAction, string>>)[action];
  if (action === "post-ledger-transaction" && initial.kind === "charge") return "Add one-time charge";
  return noun ? `${initial.id ? "Edit" : "Add"} ${noun}` : ACTION_LABELS[action] ?? "Edit record";
}

export function relationshipErrors(snapshot: AdminSnapshot, values: FormValues, initial: FormValues): Record<string, string> {
  const errors: Record<string, string> = {};
  const changed = ["propertyId", "unitId", "tenancyId", "personId"].some(key => String(values[key] ?? "") !== String(initial[key] ?? ""));
  for (const field of ["paymentTransactionId", "chargeTransactionId", "originalId"]) {
    if (!values[field]) continue;
    const transactionChanged = values[field] !== initial[field] || values.paymentTransactionId !== initial.paymentTransactionId;
    if ((changed || transactionChanged || !initial.revision) && !transactionChoices(snapshot, field, values).some(t => t.id === values[field])) errors[field] = "Choose an entry for the selected property and tenant context.";
  }
  if (!changed && initial.revision) return errors;
  if (values.tenancyId && !snapshot.snapshot.tenancies.some(t => t.id === values.tenancyId)) errors.tenancyId = "Choose a valid tenancy.";
  if (values.tenancyId && values.personId && !snapshot.snapshot.tenancies.some(t => t.id === values.tenancyId && (t.primaryPersonId === values.personId || snapshot.snapshot.householdMemberships.some(m => m.tenancyId === t.id && m.personId === values.personId)))) errors.tenancyId = "Choose a tenancy for this resident.";
  const unit = snapshot.snapshot.units.find(u => u.id === values.unitId);
  const tenancy = snapshot.snapshot.tenancies.find(t => t.id === values.tenancyId);
  if (unit && values.propertyId && unit.propertyId !== values.propertyId) errors.unitId = "Choose a unit in the selected property.";
  if (tenancy && ((values.unitId && tenancy.unitId !== values.unitId) || (values.propertyId && tenancy.propertyId !== values.propertyId))) errors.tenancyId = "Choose a tenancy for the selected property and unit.";
  return errors;
}

/** A compact label for the immutable charge account, without repeated parent labels. */
export function chargeAccountLabel(snapshot: AdminSnapshot, initial: FormValues): string {
  const property = snapshot.snapshot.properties.find(item => item.id === initial.propertyId);
  const unit = snapshot.snapshot.units.find(item => item.id === initial.unitId);
  const person = snapshot.snapshot.people.find(item => item.id === initial.personId);
  return [
    initial.propertyId ? property?.name || "Property needs review" : undefined,
    initial.unitId ? unit?.unitNumber ? `Unit ${unit.unitNumber}` : "Unit needs review" : undefined,
    initial.personId ? [person?.firstName, person?.lastName].filter(Boolean).join(" ") || "Resident needs review" : undefined,
  ].filter(Boolean).join(" · ");
}
