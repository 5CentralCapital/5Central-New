/**
 * Short, specific display labels for values that are absent or uncertain.
 *
 * No generic review label is used: a label says what is actually missing or
 * uncertain. An unknown amount is "Unknown", never $0. Where a
 * review reason code is available, prefer reviewLabelForCodes in ./reasons.
 */
import { UNKNOWN_AMOUNT_LABEL, UNVERIFIED_LABEL } from "./reasons";

export { UNKNOWN_AMOUNT_LABEL, UNVERIFIED_LABEL };

/** An unknown count (for example a number of units or balances). */
export const UNKNOWN_COUNT_LABEL = "Unknown";
/** A date that is absent or unparseable. */
export const DATE_MISSING_LABEL = "Date missing";
/** A month or accounting period that is absent. */
export const PERIOD_MISSING_LABEL = "Period missing";
/** A status, state or occupancy that has not been verified. */
export const STATUS_UNVERIFIED_LABEL = "Status unverified";
/** A recurring schedule that has not been confirmed. */
export const UNCONFIRMED_LABEL = "Unconfirmed";
/** A charge definition whose active flag has not been set. */
export const STATUS_NOT_SET_LABEL = "Status not set";
/** Billing that is blocked; the accompanying reasons explain why. */
export const BLOCKED_LABEL = "Blocked";
/** A record scope (property, unit, tenancy) that could not be determined. */
export const SCOPE_MISSING_LABEL = "Scope missing";
export const PROPERTY_MISSING_LABEL = "Property missing";
export const UNIT_MISSING_LABEL = "Unit missing";
export const NAME_MISSING_LABEL = "Name missing";
export const APPLICANT_NAME_MISSING_LABEL = "Applicant name missing";
export const DESCRIPTION_MISSING_LABEL = "Description missing";
export const CHARGE_TYPE_MISSING_LABEL = "Charge type missing";
export const ADDRESS_MISSING_LABEL = "Address missing";

/** "<Subject> missing" in sentence case, for example missingLabel("Unit type") → "Unit type missing". */
export function missingLabel(subject: string): string {
  const trimmed = subject.trim();
  if (!trimmed) return UNVERIFIED_LABEL;
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)} missing`;
}
