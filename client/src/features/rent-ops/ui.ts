import { RentOpsApiError } from "./api";

export const RENT_OPS_CONFLICT_NOTICE = "The record changed while you were editing. The workspace was refreshed; reopen the edit.";

export function sparseEditValue(value: unknown, original: unknown, hasOriginal: boolean, editing: boolean): unknown {
  if (!editing) return value;
  // An unchecked checkbox is the form default, not an operator edit, when an
  // imported row has no value for that fact.
  if (!hasOriginal && (value === false || value === "" || value === undefined)) return undefined;
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
