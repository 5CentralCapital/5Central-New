import type { OperationReceipt } from "../../shared/company";
import type { ForecastAssumptions } from "../../shared/forecasting/assumptions";
import type {
  ForecastCommandKind,
  ForecastCompareQuery,
  ForecastCompareResponse,
  ForecastExplainQuery,
  ForecastExplainResponse,
  ForecastScenarioDetail,
  ForecastScenarioListQuery,
  ForecastScenarioListResponse,
} from "../../shared/forecasting/contracts";
import { loadAuthenticatedPrincipal, type AuthenticatedPrincipal } from "../company/authorization";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { executeForecastCommand, type ForecastCommandExecutionOptions } from "./commands";
import { ForecastReadService, operatingToday, type ForecastPreview, type ForecastRuntime, type ForecastSnapshotView } from "./service";
import { createForecastSourceReader, type ForecastSourceReader } from "./sources";

export interface ForecastingPort {
  list(principal: AuthenticatedPrincipal, query: ForecastScenarioListQuery): Promise<ForecastScenarioListResponse>;
  get(principal: AuthenticatedPrincipal, input: { scope: unknown; scenarioId: string }): Promise<ForecastScenarioDetail>;
  getVersion(principal: AuthenticatedPrincipal, input: { scope: unknown; scenarioId: string; version: number }): Promise<ForecastAssumptions>;
  preview(principal: AuthenticatedPrincipal, input: { scope: unknown; scenarioId: string; assumptionVersion?: number; assumptions?: unknown }): Promise<ForecastPreview>;
  snapshot(principal: AuthenticatedPrincipal, input: { scope: unknown; snapshotId: string }): Promise<ForecastSnapshotView>;
  explain(principal: AuthenticatedPrincipal, query: ForecastExplainQuery): Promise<ForecastExplainResponse>;
  compare(principal: AuthenticatedPrincipal, query: ForecastCompareQuery): Promise<ForecastCompareResponse>;
  execute(kind: ForecastCommandKind, envelope: unknown, access: ForecastCommandExecutionOptions): Promise<OperationReceipt>;
  /** Runs work against the read service inside one read-only snapshot with freshly loaded grants. */
  withReadService<T>(principal: AuthenticatedPrincipal, work: (service: ForecastReadService, fresh: AuthenticatedPrincipal) => Promise<T>): Promise<T>;
}

export interface ForecastingPortOptions {
  /** Opening-position reader; defaults to the company database sources. */
  readonly sources?: (executor: RentOpsQueryExecutor) => ForecastSourceReader;
  /** Operating date provider; tests pin it for reproducible snapshots. */
  readonly today?: () => string;
}

/** One read/command implementation shared by the browser, HTTP API and MCP tools. */
export function createForecastingPort(executor: RentOpsQueryExecutor, options: ForecastingPortOptions = {}): ForecastingPort {
  const runtime: ForecastRuntime = { sources: options.sources ?? createForecastSourceReader, today: options.today ?? (() => operatingToday()) };
  async function read<T>(principal: AuthenticatedPrincipal, work: (service: ForecastReadService, fresh: AuthenticatedPrincipal) => Promise<T>): Promise<T> {
    if (!executor.transaction) throw new Error("Forecast reads require transaction support");
    return executor.transaction(async transaction => {
      // Reload grants inside the snapshot so a revoked grant cannot keep reading.
      const fresh = await loadAuthenticatedPrincipal(transaction, { actorId: principal.actorId, organizationId: principal.organizationId, role: principal.role });
      return work(new ForecastReadService(transaction, runtime), fresh);
    }, { readOnly: true });
  }
  return {
    list: (principal, query) => read(principal, (service, fresh) => service.list(fresh, query)),
    get: (principal, input) => read(principal, (service, fresh) => service.get(fresh, input)),
    getVersion: (principal, input) => read(principal, (service, fresh) => service.getAssumptionVersion(fresh, input)),
    preview: (principal, input) => read(principal, (service, fresh) => service.preview(fresh, input)),
    snapshot: (principal, input) => read(principal, (service, fresh) => service.snapshot(fresh, input)),
    explain: (principal, query) => read(principal, (service, fresh) => service.explain(fresh, query)),
    compare: (principal, query) => read(principal, (service, fresh) => service.compare(fresh, query)),
    execute: (kind, envelope, access) => executeForecastCommand(executor, runtime, kind, envelope, access),
    withReadService: read,
  };
}
