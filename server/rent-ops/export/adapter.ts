import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { RentManagerRequest, RentManagerResponse, RentManagerTransport } from "./types";

/** Canonical local RM client checked into the shared plugin workspace. */
export function defaultLocalRentManagerClientPath(): string {
  const relativeClient = ["AI", "Plugins", "PLUGINS", "rent-manager", "servers", "rm-client.js"];
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let index = 0; index < 10; index += 1) {
    const candidate = resolve(directory, ...relativeClient);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  // Return the portable candidate from the module's ancestor tree so the
  // dynamic import fails closed without embedding a user's home directory.
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../../AI/Plugins/PLUGINS/rent-manager/servers/rm-client.js");
}

export const DEFAULT_LOCAL_RM_CLIENT_PATH = defaultLocalRentManagerClientPath();

export interface RentManagerApiGetResult {
  data?: unknown;
  totalResults?: number | null;
}

export type RentManagerApiGet = (path: string, query?: Record<string, unknown>) => Promise<RentManagerApiGetResult | unknown>;

export class RentManagerAdapterError extends Error {
  readonly code = "rm_adapter_unavailable";

  constructor() {
    super("Rent Manager read adapter is unavailable");
    this.name = "RentManagerAdapterError";
  }
}

function queryForApiGet(query: RentManagerRequest["query"]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined));
}

/** Adapt the canonical client's GET-only `apiGet` without exposing its token. */
export function createRentManagerApiGetAdapter(apiGet: RentManagerApiGet): RentManagerTransport {
  return {
    async request(request: RentManagerRequest): Promise<RentManagerResponse> {
      if (String(request.method).toUpperCase() !== "GET") throw new RentManagerAdapterError();
      const result = await apiGet(request.path, queryForApiGet(request.query));
      if (result && typeof result === "object" && ("data" in result || "totalResults" in result)) {
        const typed = result as RentManagerApiGetResult;
        const headers = typed.totalResults == null ? undefined : { "x-total-results": String(typed.totalResults) };
        // The canonical client intentionally returns `data: null` for an HTTP
        // no-content response. Preserve that distinction so the collector can
        // accept a verified empty page without accepting arbitrary malformed
        // 200 responses as empty collections.
        return { status: typed.data == null ? 204 : 200, ...(headers ? { headers } : {}), body: typed.data };
      }
      return { status: 200, body: result };
    },
  };
}

/**
 * Dynamically load the canonical local RM client. No authentication happens
 * until the returned transport is used, so tests can inject a fake apiGet.
 */
export async function createLocalRentManagerTransport(options: { modulePath?: string } = {}): Promise<RentManagerTransport> {
  const modulePath = options.modulePath ?? process.env.RENT_MANAGER_CLIENT_PATH ?? DEFAULT_LOCAL_RM_CLIENT_PATH;
  try {
    const module = await import(pathToFileURL(modulePath).href) as { apiGet?: RentManagerApiGet };
    if (typeof module.apiGet !== "function") throw new Error("missing apiGet");
    return createRentManagerApiGetAdapter(module.apiGet);
  } catch {
    throw new RentManagerAdapterError();
  }
}
