/** Never return arbitrary parser/provider messages: they may contain request data. */
export function publicRequestError(error: unknown): { status: number; message: string } {
  const candidate = error && typeof error === "object"
    ? Number((error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode)
    : Number.NaN;
  const status = Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500;
  return { status, message: status >= 500 ? "Internal Server Error" : "Invalid request" };
}
