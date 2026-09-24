/** Never return arbitrary parser/provider messages: they may contain request data. */
export function publicRequestError(error: unknown): { status: number; message: string } {
  const candidate = error && typeof error === "object"
    ? Number((error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode)
    : Number.NaN;
  const status = Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500;
  return { status, message: status >= 500 ? "Internal Server Error" : "Invalid request" };
}

/** Fixed labels used by the production bootstrap; none contain request or provider data. */
export type StartupStage =
  | "configuration"
  | "development_schema"
  | "route_registration"
  | "runtime_database"
  | "runtime_schema"
  | "object_store"
  | "public_limiter"
  | "resume_notifier"
  | "tenant_portal"
  | "company_services"
  | "mcp_registration"
  | "tenant_routes"
  | "legacy_routes"
  | "static_assets"
  | "listener";

/**
 * A loggable startup/listen failure class: the error's class name plus its
 * stable code, or its message only when that is itself a snake_case code.
 * Free-text messages are dropped because they can carry connection strings.
 * A fixed stage can be included to identify which bootstrap dependency failed.
 */
export function startupFailureSummary(error: unknown, stage?: StartupStage): string {
  let summary: string;
  if (!(error instanceof Error)) summary = "unclassified";
  else {
    const name = /^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(error.constructor.name) ? error.constructor.name : "Error";
    const code = "code" in error ? String((error as { code?: unknown }).code) : "";
    const detail = /^[A-Za-z0-9_.:-]{1,80}$/.test(code) ? code : /^[a-z0-9_:,]{3,400}$/.test(error.message) ? error.message : "";
    summary = detail ? `${name}:${detail}` : name;
  }
  return stage ? `stage=${stage};${summary}` : summary;
}
