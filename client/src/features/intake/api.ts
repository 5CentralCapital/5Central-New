import { intakePageSchema, mraPacketReadModelSchema } from "@shared/intake";
import type { IntakeApi } from "./types";
import { rentOpsAuthClient } from "../rent-ops/auth";

type JsonRecord = Record<string, unknown>;

export class IntakeApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "IntakeApiError";
  }
}

function isRecord(value: unknown): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }

async function requestJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await rentOpsAuthClient.request(path, { signal, headers: { Accept: "application/json" } }).catch(error => {
    if (signal?.aborted) throw error;
    throw new IntakeApiError("MRA results could not be loaded. Try again.", 0, "company_connection_unavailable");
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const root = isRecord(payload) ? payload : {};
    const data = isRecord(root.data) ? root.data : root;
    throw new IntakeApiError(typeof data.message === "string" ? data.message : `MRA results returned ${response.status}.`, response.status, typeof data.code === "string" ? data.code : undefined);
  }
  return payload;
}

function companyPath(organizationId: string): string { return `/api/company/${encodeURIComponent(organizationId)}/intake/packets`; }

function createApi(): IntakeApi {
  return {
    async listPackets(organizationId, scope = {}, cursor, signal) {
      const params = new URLSearchParams();
      if (scope.legalEntityId) params.set("legalEntityId", scope.legalEntityId);
      if (scope.propertyId) params.set("propertyId", scope.propertyId);
      if (cursor) params.set("cursor", cursor);
      return intakePageSchema.parse(await requestJson(`${companyPath(organizationId)}${params.toString() ? `?${params}` : ""}`, signal));
    },
    async getPacket(organizationId, packetId, signal) {
      return mraPacketReadModelSchema.parse(await requestJson(`${companyPath(organizationId)}/${encodeURIComponent(packetId)}`, signal));
    },
  };
}

export const intakeApi: IntakeApi = createApi();
export function createIntakeApi(): IntakeApi { return createApi(); }
