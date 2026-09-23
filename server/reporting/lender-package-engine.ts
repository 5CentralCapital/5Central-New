import type { ReportSourceCoverage, ReportingEngineContext, ReportingEngineResult } from "../../shared/reporting";
import { ReportingError } from "./errors";
import { reportColumns, resultFromRecords, sourceCoverage } from "./source-engine-utils";
import type { ReportingEngine } from "./registry";

export interface LenderPackageReadResult {
  readonly sections: readonly {
    readonly section: string;
    readonly title: string;
    readonly reportId: string;
    readonly runId: string;
    readonly rowCount: number;
    readonly state: "ready" | "partial" | "unavailable";
    readonly reason?: string | null;
  }[];
  readonly coverage: {
    readonly state: ReportSourceCoverage["state"];
    readonly evidence: ReportSourceCoverage["evidence"];
    readonly watermark?: string | null;
    readonly reason?: string | null;
  };
}

export interface LenderPackageReadPort {
  read(input: { readonly context: ReportingEngineContext }): Promise<LenderPackageReadResult>;
}

export function createLenderManagementPackageEngine(read: LenderPackageReadPort): ReportingEngine {
  return {
    key: "combined.lender-package",
    reportIds: ["lender-management-package"],
    ready: true,
    async run(context): Promise<ReportingEngineResult> {
      const source = await read.read({ context });
      if (source.coverage.state === "unavailable") throw new ReportingError("report_unavailable", source.coverage.reason ?? "No saved report runs match this package period and entity scope.", 409, { dependency: "frozen_report_runs" });
      const rows = source.sections.map(section => ({ section: section.section, title: section.title, reportId: section.reportId, sourceRunId: section.runId || null, rowCount: section.rowCount, state: section.state, reason: section.reason ?? null }));
      const missing = source.sections.filter(section => section.state !== "ready").map(section => ({ code: "lender_package_section_unavailable", state: "partial" as const, message: section.reason ?? `The ${section.title} section is incomplete.`, scope: section.reportId }));
      const result = resultFromRecords(context, rows, { source: "frozen_report_package_sections", basis: "mixed", missingData: missing, rowId: (_record, _index, values) => `lender-package:${String(values.section)}`, columns: reportColumns([{ id: "section", label: "Section", type: "text" }, { id: "title", label: "Report", type: "text" }, { id: "rowCount", label: "Rows", type: "integer" }, { id: "state", label: "State", type: "status" }, { id: "reason", label: "Reason", type: "text" }]) });
      return { ...result, coverage: [sourceCoverage(context, { source: "frozen_report_package_sections", state: source.coverage.state, evidence: source.coverage.evidence, basis: "mixed", watermark: source.coverage.watermark ?? null, rowCount: result.rows.length, reason: source.coverage.reason ?? "Package sections are references to immutable report runs and required templates." })] };
    },
  };
}

export function createUnavailableLenderPackageEngine(reason = "No book-report and template reader is registered."): ReportingEngine {
  return { key: "combined.lender-package", reportIds: ["lender-management-package"], ready: false, reason, async run() { throw new ReportingError("report_unavailable", reason, 409, { dependency: "required_templates" }); } };
}
