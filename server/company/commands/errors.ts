export type CompanyCommandErrorCode = "forbidden" | "conflict" | "validation";

export interface CompanyCommandErrorDetails {
  readonly [key: string]: unknown;
}

export class CompanyCommandError extends Error {
  readonly status: 400 | 403 | 409;
  readonly code: CompanyCommandErrorCode;
  readonly details: CompanyCommandErrorDetails;

  constructor(
    code: CompanyCommandErrorCode,
    message: string,
    status: 400 | 403 | 409,
    details: CompanyCommandErrorDetails = {},
  ) {
    super(message);
    this.name = "CompanyCommandError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ForbiddenCommandError extends CompanyCommandError {
  constructor(message = "Command is not authorized", details: CompanyCommandErrorDetails = {}) {
    super("forbidden", message, 403, details);
    this.name = "ForbiddenCommandError";
  }
}

export class ConflictCommandError extends CompanyCommandError {
  constructor(message = "Command conflicts with current state", details: CompanyCommandErrorDetails = {}) {
    super("conflict", message, 409, details);
    this.name = "ConflictCommandError";
  }
}

export class ValidationCommandError extends CompanyCommandError {
  constructor(message = "Command is invalid", details: CompanyCommandErrorDetails = {}) {
    super("validation", message, 400, details);
    this.name = "ValidationCommandError";
  }
}

export function isCompanyCommandError(error: unknown): error is CompanyCommandError {
  return error instanceof CompanyCommandError;
}
