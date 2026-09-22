import { RentOpsApiError } from "./api";

export const RENT_OPS_CONFLICT_NOTICE = "The record changed while you were editing. The workspace was refreshed; reopen the edit.";

export function sparseEditValue(value: unknown, original: unknown, hasOriginal: boolean, editing: boolean, explicitlyChanged = false): unknown {
  if (!editing) return value;
  if (explicitlyChanged) return value === "" ? null : value;
  // An unchecked checkbox is the form default, not an operator edit, when an
  // imported row has no value for that fact.
  if ((!hasOriginal || original === null || original === undefined || original === "") && (value === false || value === "" || value === undefined || value === null)) return undefined;
  if (String(value ?? "") === String(original ?? "")) return undefined;
  return value === "" ? null : value;
}

/** Shared by the dialog and the browser-flow test seam so a stale mutation
 * always closes the stale form before loading a fresh snapshot. */
export function refreshRentOpsAfterConflict(actions: {
  closeEditor: () => void;
  clearEditor: () => void;
  showNotice: (message: string) => void;
  reload: () => void | Promise<void>;
}): void {
  actions.closeEditor();
  actions.clearEditor();
  actions.showNotice(RENT_OPS_CONFLICT_NOTICE);
  void actions.reload();
}

/** Keep the mutation error branch executable without coupling browser tests to
 * a DOM implementation. Conflict handling is deliberately a refresh path,
 * while ordinary API errors remain visible in the dialog. */
export function handleRentOpsMutationError(
  cause: unknown,
  onConflict: (() => void) | undefined,
  setError: (message: string) => void,
): void {
  if (cause instanceof RentOpsApiError && (cause.code === "conflict" || cause.code === "versioned_schedule_required") && onConflict) {
    onConflict();
    return;
  }
  setError(cause instanceof Error ? cause.message : "The record could not be saved.");
}

/** Creation controls have explicit section semantics; report views are not create forms. */
export function sectionCreateAction(section: string): { action: import("./types").RentOpsMutation["action"]; label: string } | undefined {
  const actions: Record<string, { action: import("./types").RentOpsMutation["action"]; label: string }> = {
    properties: { action: "save-property", label: "Add property" },
    tenants: { action: "save-person", label: "Add resident" },
    leases: { action: "save-lease-term", label: "Add lease" },
    income: { action: "post-ledger-transaction", label: "Add transaction" },
  };
  return actions[section];
}

/** Suppress the aggregate when source uncertainty could change its meaning. */
export function scheduledRentNeedsReview(rows: import("./types").ScheduledIncomeRow[]): boolean {
  return rows.some(row => (row.category === "base_rent" || row.category == null || row.unclassified === true)
    && (row.known !== true || row.uncertain === true || row.temporalUncertainty === true || row.unclassified === true || row.amountCents == null));
}

export function balanceMetric(value: number | null, complete?: boolean): { amountCents: number | null; tone?: "warn" | "good" } {
  if (complete === false || value === null) return { amountCents: null };
  return { amountCents: value, tone: value ? "warn" : "good" };
}
