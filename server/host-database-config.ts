/** Replit may replace DATABASE_URL when publishing its managed database. */
export function resolveHostDatabaseUrl(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  // An explicitly configured override must be validated, never silently ignored.
  return env.RENT_OPS_HOST_DATABASE_URL !== undefined ? env.RENT_OPS_HOST_DATABASE_URL : env.DATABASE_URL;
}
