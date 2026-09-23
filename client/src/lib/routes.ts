// Which self-contained surface a path belongs to. Matches wouter's route
// matching for "/ops", "/tenant", "/apply" and "/apply/:propertySlug":
// case-insensitive with an optional trailing slash.
export type AppSurface = "manager" | "tenant" | "applicant" | "site";

export function appSurfaceForPath(pathname: string): AppSurface {
  if (/^\/ops\/?$/i.test(pathname)) return "manager";
  if (/^\/tenant\/?$/i.test(pathname)) return "tenant";
  if (/^\/apply(?:\/[^/]+)?\/?$/i.test(pathname)) return "applicant";
  return "site";
}

/** The property slug from "/apply/:propertySlug", or "" (also for a malformed escape). */
export function applyPropertySlug(pathname: string): string {
  const segment = /^\/apply\/([^/]+)\/?$/i.exec(pathname)?.[1] ?? "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}
