export type ReportingErrorCode = "report_validation" | "report_forbidden" | "report_not_found" | "report_unavailable" | "report_expired" | "report_conflict" | "report_export";

export class ReportingError extends Error {
  readonly status: number;
  readonly code: ReportingErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: ReportingErrorCode, message: string, status = code === "report_forbidden" ? 403 : code === "report_not_found" ? 404 : code === "report_expired" ? 410 : code === "report_conflict" ? 409 : code === "report_unavailable" ? 409 : 400, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ReportingError";
    this.code = code;
    this.status = status;
    this.details = Object.freeze({ ...details });
  }
}

export function isReportingError(error: unknown): error is ReportingError {
  return error instanceof ReportingError;
}

