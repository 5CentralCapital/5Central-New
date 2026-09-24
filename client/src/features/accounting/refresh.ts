export type AccountingRefreshJobState = "queued" | "running" | "retry" | "succeeded" | "dead" | "cancelled";
export type AccountingRefreshOutcome = "succeeded" | "failed" | "timed_out";

const DEFAULT_REFRESH_POLL_INTERVAL_MS = 1_000;
const DEFAULT_REFRESH_POLL_TIMEOUT_MS = 30_000;

/**
 * Native report pages are immutable run snapshots. Their pagination cursors
 * belong to a specific run, so a mirror refresh must leave them alone until
 * the user explicitly runs a new report.
 */
export function shouldInvalidateAccountingQuery(queryKey: readonly unknown[]): boolean {
  return queryKey[1] !== "general-ledger" && queryKey[1] !== "general-ledger-page";
}

/** Wait for the durable sync job, but keep the page responsive and bounded. */
export async function waitForAccountingRefresh(
  getJob: () => Promise<{ readonly state: AccountingRefreshJobState }>,
  options: { readonly intervalMs?: number; readonly timeoutMs?: number; readonly sleep?: (milliseconds: number) => Promise<void> } = {},
): Promise<AccountingRefreshOutcome> {
  const intervalMs = Math.max(1, options.intervalMs ?? DEFAULT_REFRESH_POLL_INTERVAL_MS);
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_REFRESH_POLL_TIMEOUT_MS);
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  let elapsed = 0;
  while (true) {
    const result = await getJob();
    if (result.state === "succeeded") return "succeeded";
    if (result.state === "dead" || result.state === "cancelled") return "failed";
    if (elapsed >= timeoutMs) return "timed_out";
    const delay = Math.min(intervalMs, timeoutMs - elapsed);
    await sleep(delay);
    elapsed += delay;
  }
}
