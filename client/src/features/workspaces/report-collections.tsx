import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { ReportPackageRun } from "@shared/reporting";
import { reportingApi } from "../reporting/api";
import { formatIsoDate, humanize } from "./format";
import { CompanyGate, ErrorState, Loading, StatePanel } from "./page";
import { packageRunSummary } from "./models";

interface Props { identity: string; organizationId?: string; onOrganization: (organizationId: string) => void; onOpenReport: (organizationId: string, reportId: string) => void; onOpenLibrary: () => void }

/** Reporting › Saved reports: saved report setups, opening their report. */
export function SavedReports(props: Props) {
  return <CompanyGate identity={props.identity} organizationId={props.organizationId} onOrganization={props.onOrganization} loadingLabel="Loading saved reports…">
    {(organization, selector) => <Presets {...props} organizationId={organization.id} selector={selector} />}
  </CompanyGate>;
}

function Presets({ identity, organizationId, selector, onOpenReport, onOpenLibrary }: Props & { organizationId: string; selector: ReactNode }) {
  const presets = useQuery({ queryKey: ["company-reporting", "presets", identity, organizationId], queryFn: ({ signal }) => reportingApi.listPresets(organizationId, signal), staleTime: 15_000, retry: false });
  const catalog = useQuery({ queryKey: ["company-reporting", "catalog", identity, organizationId], queryFn: ({ signal }) => reportingApi.catalog(organizationId, signal), staleTime: 30_000, retry: false });
  if (presets.error) return <ErrorState error={presets.error} onRetry={() => void presets.refetch()} />;
  if (!presets.data) return <Loading label="Loading saved reports…" />;
  const titles = new Map((catalog.data ?? []).map(entry => [entry.id, entry.title]));
  return <div className="ws-page">
    {selector && <div className="ws-toolbar">{selector}</div>}
    {!presets.data.length ? <StatePanel title="No saved reports" message="Run a report and save its setup to find it here." action={{ label: "Open report library", onClick: onOpenLibrary }} />
      : <table className="ws-table">
        <thead><tr><th scope="col">Name</th><th scope="col">Report</th><th scope="col">Shared</th><th scope="col">Updated</th></tr></thead>
        <tbody>{presets.data.map(preset => <tr key={preset.id}>
          <td><button type="button" className="ws-link" onClick={() => onOpenReport(organizationId, preset.reportId)}>{preset.name}</button>{preset.description && <div className="ws-note">{preset.description}</div>}</td>
          <td>{titles.get(preset.reportId) ?? humanize(preset.reportId)}</td>
          <td>{preset.visibility === "private" ? "Only me" : humanize(preset.visibility)}</td>
          <td>{formatIsoDate(preset.updatedAt)}</td>
        </tr>)}</tbody>
      </table>}
  </div>;
}

/** Reporting › Packages: saved report packages with explicit runs and their item states. */
export function ReportPackages(props: Props) {
  return <CompanyGate identity={props.identity} organizationId={props.organizationId} onOrganization={props.onOrganization} loadingLabel="Loading packages…">
    {(organization, selector) => <Packages {...props} organizationId={organization.id} selector={selector} />}
  </CompanyGate>;
}

function Packages({ identity, organizationId, selector, onOpenLibrary }: Props & { organizationId: string; selector: ReactNode }) {
  const [runs, setRuns] = useState<Record<string, ReportPackageRun>>({});
  const packages = useQuery({ queryKey: ["company-reporting", "packages", identity, organizationId], queryFn: ({ signal }) => reportingApi.listPackages(organizationId, signal), staleTime: 15_000, retry: false });
  const run = useMutation({
    mutationFn: (packageId: string) => reportingApi.runPackage(organizationId, packageId),
    onSuccess: (result, packageId) => setRuns(current => ({ ...current, [packageId]: result })),
  });
  if (packages.error) return <ErrorState error={packages.error} onRetry={() => void packages.refetch()} />;
  if (!packages.data) return <Loading label="Loading packages…" />;
  return <div className="ws-page">
    {selector && <div className="ws-toolbar">{selector}</div>}
    {run.error && <p className="ws-note" role="alert">{run.error instanceof Error ? run.error.message : "The package could not be run."}</p>}
    {!packages.data.length ? <StatePanel title="No report packages" message="Save several report setups as a package to run them together." action={{ label: "Open report library", onClick: onOpenLibrary }} />
      : <table className="ws-table">
        <thead><tr><th scope="col">Package</th><th scope="col" className="number">Reports</th><th scope="col">Last run here</th><th scope="col"><span className="ws-sr-only">Actions</span></th></tr></thead>
        <tbody>{packages.data.map(pkg => <tr key={pkg.id}>
          <td>{pkg.name}{pkg.description && <div className="ws-note">{pkg.description}</div>}</td>
          <td className="number">{pkg.items.length}</td>
          <td role="status">{runs[pkg.id] ? packageRunSummary(runs[pkg.id]) : "—"}</td>
          <td><button type="button" className="rm-button rm-button--small" disabled={run.isPending && run.variables === pkg.id} onClick={() => run.mutate(pkg.id)}>{run.isPending && run.variables === pkg.id ? "Running…" : "Run"}</button></td>
        </tr>)}</tbody>
      </table>}
  </div>;
}
