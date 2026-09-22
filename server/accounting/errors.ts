export type AccountingErrorCode =
  | "accounting_configuration"
  | "accounting_validation"
  | "accounting_not_found"
  | "accounting_conflict"
  | "accounting_unavailable"
  | "accounting_capability_disabled"
  | "accounting_checkpoint_conflict"
  | "accounting_allocation_exceeded";

export class AccountingError extends Error {
  readonly code: AccountingErrorCode;
  readonly details: Readonly<Record<string, string | number | boolean | undefined>>;

  constructor(code: AccountingErrorCode, message: string, details: Readonly<Record<string, string | number | boolean | undefined>> = {}) {
    super(message);
    this.name = "AccountingError";
    this.code = code;
    this.details = details;
  }
}

