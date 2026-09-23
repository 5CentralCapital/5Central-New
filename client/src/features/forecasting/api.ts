import { z } from "zod";
import { operationIdSchema, operationReceiptSchema, type OperationReceipt } from "@shared/company";
import {
  forecastCompareResponseSchema,
  forecastExplainResponseSchema,
  forecastScenarioDetailSchema,
  forecastScenarioListResponseSchema,
  forecastSnapshotMetaSchema,
  type ForecastCommandKind,
  type ForecastCompareResponse,
  type ForecastExplainResponse,
  type ForecastRunSource,
  type ForecastScenarioDetail,
  type ForecastScenarioListResponse,
  type ForecastSnapshotMeta,
} from "@shared/forecasting/contracts";
import type { ForecastResultView } from "@shared/forecasting/result";
import { rentOpsAuthClient } from "../rent-ops/auth";

export class ForecastApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "ForecastApiError";
  }
  get conflict(): boolean { return this.status === 409; }
  /** Network loss: the save may or may not have committed; retry the same envelope. */
  get uncertain(): boolean { return this.status === 0; }
}

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);

async function requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await rentOpsAuthClient.request(path, { ...init, headers: { Accept: "application/json", ...(init.headers ?? {}) } }).catch(error => {
    if (init.signal?.aborted) throw error;
    throw new ForecastApiError(init.method === "POST" ? "The request could not be confirmed. Try again; repeating a save is safe." : "Forecasts could not be loaded. Try again.", 0, "company_connection_unavailable");
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.message === "string" && payload.message.length <= 400 ? payload.message : undefined;
    const code = isRecord(payload) && typeof payload.code === "string" ? payload.code : undefined;
    if (response.status === 409) throw new ForecastApiError(message ?? "This scenario changed since you opened it. Reload it, then try again.", 409, code);
    throw new ForecastApiError(message ?? `Forecasting returned ${response.status}.`, response.status, code);
  }
  return payload;
}

function companyPath(organizationId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(organizationId)) throw new ForecastApiError("Company is unavailable.", 400, "company_validation");
  return `/api/company/${encodeURIComponent(organizationId)}`;
}

/** Response shells are checked; the result body is the server's typed contract. */
const resultViewSchema = z.object({ modelVersion: z.string(), weeks: z.array(z.unknown()), months: z.array(z.unknown()), opening: z.object({}).passthrough(), summary: z.object({}).passthrough() }).passthrough();
const previewSchema = z.object({ scenarioId: z.string(), assumptionVersion: z.number().nullable(), draft: z.boolean(), modelVersion: z.string(), sourceFingerprint: z.string(), resultSha256: z.string(), result: resultViewSchema }).strict();
const snapshotViewSchema = z.object({ snapshot: forecastSnapshotMetaSchema, result: resultViewSchema }).strict();

export interface ForecastRunView {
  readonly kind: "snapshot" | "preview";
  readonly snapshot: ForecastSnapshotMeta | null;
  readonly assumptionVersion: number | null;
  readonly draft: boolean;
  readonly resultSha256: string;
  readonly result: ForecastResultView;
}

export interface ForecastCommandEnvelope {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly scope: { organizationId: string };
  readonly expectedRevision?: number;
  readonly payload: Record<string, unknown>;
}

export function forecastEnvelope(organizationId: string, payload: Record<string, unknown>, expectedRevision?: number): ForecastCommandEnvelope {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (!randomUUID) throw new ForecastApiError("Secure action IDs are unavailable in this browser.", 0, "forecast_security_unavailable");
  const operationId = operationIdSchema.parse(randomUUID.call(globalThis.crypto));
  return { operationId, idempotencyKey: `forecast:${operationId}`, scope: { organizationId }, ...(expectedRevision === undefined ? {} : { expectedRevision }), payload };
}

export const forecastApi = {
  async list(organizationId: string, signal?: AbortSignal): Promise<ForecastScenarioListResponse> {
    return forecastScenarioListResponseSchema.parse(await requestJson(`${companyPath(organizationId)}/forecast-scenarios?limit=100`, { signal }));
  },
  async get(organizationId: string, scenarioId: string, signal?: AbortSignal): Promise<ForecastScenarioDetail> {
    return forecastScenarioDetailSchema.parse(await requestJson(`${companyPath(organizationId)}/forecast-scenarios/${encodeURIComponent(scenarioId)}`, { signal }));
  },
  async version(organizationId: string, scenarioId: string, version: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const value = await requestJson(`${companyPath(organizationId)}/forecast-scenarios/${encodeURIComponent(scenarioId)}/versions/${version}`, { signal });
    if (!isRecord(value)) throw new ForecastApiError("Assumptions could not be read.", 0);
    return value;
  },
  async snapshot(organizationId: string, snapshotId: string, signal?: AbortSignal): Promise<ForecastRunView> {
    const value = snapshotViewSchema.parse(await requestJson(`${companyPath(organizationId)}/forecast-snapshots/${encodeURIComponent(snapshotId)}`, { signal }));
    return { kind: "snapshot", snapshot: value.snapshot, assumptionVersion: value.snapshot.assumptionVersion, draft: false, resultSha256: value.snapshot.resultSha256, result: value.result as unknown as ForecastResultView };
  },
  async preview(organizationId: string, scenarioId: string, body: { assumptionVersion?: number; assumptions?: Record<string, unknown> }, signal?: AbortSignal): Promise<ForecastRunView> {
    const value = previewSchema.parse(await requestJson(`${companyPath(organizationId)}/forecast-scenarios/${encodeURIComponent(scenarioId)}/preview`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
    }));
    return { kind: "preview", snapshot: null, assumptionVersion: value.assumptionVersion, draft: value.draft, resultSha256: value.resultSha256, result: value.result as unknown as ForecastResultView };
  },
  async explain(organizationId: string, source: ForecastRunSource, line: string, period: string, cursor?: string, signal?: AbortSignal): Promise<ForecastExplainResponse> {
    const params = new URLSearchParams({ line, period, limit: "200" });
    if ("snapshotId" in source) params.set("snapshotId", source.snapshotId);
    else { params.set("scenarioId", source.scenarioId); if (source.assumptionVersion) params.set("assumptionVersion", String(source.assumptionVersion)); }
    if (cursor) params.set("cursor", cursor);
    return forecastExplainResponseSchema.parse(await requestJson(`${companyPath(organizationId)}/forecast-explain?${params}`, { signal }));
  },
  async compare(organizationId: string, snapshotA: string, snapshotB: string, signal?: AbortSignal): Promise<ForecastCompareResponse> {
    const params = new URLSearchParams({ a: snapshotA, b: snapshotB, limit: "25" });
    return forecastCompareResponseSchema.parse(await requestJson(`${companyPath(organizationId)}/forecast-compare?${params}`, { signal }));
  },
  async command(organizationId: string, kind: ForecastCommandKind, envelope: ForecastCommandEnvelope): Promise<OperationReceipt> {
    const value = await requestJson(`${companyPath(organizationId)}/forecast-commands/${encodeURIComponent(kind)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(envelope),
    });
    const parsed = operationReceiptSchema.safeParse(value);
    if (!parsed.success) throw new ForecastApiError("The save could not be confirmed. Try again; repeating a save is safe.", 0, "company_unknown_outcome");
    return parsed.data;
  },
};
