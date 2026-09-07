/**
 * Stable, deliberately boring errors for the private document store.
 *
 * The implementation never attaches the original filesystem error as a
 * `cause`: Node's filesystem messages commonly contain absolute paths and
 * sometimes the caller's filename. Callers can safely expose `code` and
 * `retryable` without accidentally disclosing those values.
 */

export const STORAGE_ERROR_CODES = [
  "storage_input_invalid",
  "storage_invalid_root",
  "storage_root_missing",
  "storage_root_permissions",
  "storage_root_inside_repository",
  "storage_roots_overlap",
  "storage_root_symlink",
  "storage_directory_invalid",
  "storage_directory_permissions",
  "storage_path_invalid",
  "storage_logical_key_invalid",
  "storage_checksum_invalid",
  "storage_version_invalid",
  "storage_version_missing",
  "storage_version_mismatch",
  "storage_size_invalid",
  "storage_empty",
  "storage_too_large",
  "storage_source_not_found",
  "storage_source_symlink",
  "storage_source_nonregular",
  "storage_source_hardlink",
  "storage_source_permissions",
  "storage_source_changed",
  "storage_destination_not_found",
  "storage_destination_symlink",
  "storage_destination_nonregular",
  "storage_destination_hardlink",
  "storage_destination_permissions",
  "storage_checksum_mismatch",
  "storage_size_mismatch",
  "storage_collision",
  "storage_integrity_mismatch",
  "storage_post_publish_verification_failed",
  "storage_object_not_found",
  "storage_atomic_publish_failed",
  "storage_interrupted",
  "storage_io_failed",
  "storage_permission_denied",
  "storage_busy",
  "storage_privilege_probe_failed",
  "storage_inventory_invalid",
  "storage_import_source_root_required",
  "storage_import_source_root_mismatch",
] as const;

export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[number];

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly retryable: boolean;

  constructor(code: StorageErrorCode, options: { retryable?: boolean } = {}) {
    // Keep the message equal to the safe code. Do not include an OS error.
    super(code);
    this.name = "StorageError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export function isStorageError(error: unknown): error is StorageError {
  return error instanceof StorageError;
}

/** A JSON-safe error shape suitable for a request or audit response. */
export interface RedactedStorageError {
  code: StorageErrorCode | "storage_io_failed";
  retryable: boolean;
}

export function redactedStorageError(error: unknown): RedactedStorageError {
  if (isStorageError(error)) return { code: error.code, retryable: error.retryable };
  return { code: "storage_io_failed", retryable: false };
}

type SystemError = NodeJS.ErrnoException & { code?: string };

/**
 * Translate an OS error into a context-specific, path-free public error.
 * `fallback` must be stable and must never contain caller input.
 */
export function mapStorageSystemError(
  error: unknown,
  fallback: StorageErrorCode = "storage_io_failed",
  options: { notFound?: StorageErrorCode; symlink?: StorageErrorCode; nonregular?: StorageErrorCode } = {},
): StorageError {
  const code = (error as SystemError | undefined)?.code;
  if (code === "ENOENT") return new StorageError(options.notFound ?? fallback);
  if (code === "ELOOP") return new StorageError(options.symlink ?? fallback);
  if (code === "EISDIR" || code === "ENOTDIR") return new StorageError(options.nonregular ?? fallback);
  if (code === "EACCES" || code === "EPERM") return new StorageError("storage_permission_denied");
  if (code === "EAGAIN" || code === "EBUSY") return new StorageError("storage_busy", { retryable: true });
  if (code === "ENOSPC" || code === "EDQUOT") return new StorageError("storage_io_failed", { retryable: true });
  return new StorageError(fallback);
}

export function storageError(code: StorageErrorCode, retryable = false): StorageError {
  return new StorageError(code, { retryable });
}
