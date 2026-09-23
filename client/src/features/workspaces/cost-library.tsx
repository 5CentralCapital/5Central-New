import { useEffect, useState, type ReactNode } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { workspacesApi } from "./api";
import { formatCentsText, formatIsoDate, humanize } from "./format";
import { CompanyGate, ErrorState, Loading, StatePanel } from "./page";

/** Projects › Cost library: unit rates from active templates and completed projects' scope lines. */
export function CostLibrary({ identity, organizationId, asOfDate, onOrganization, onOpenProject }: {
  identity: string; organizationId?: string; asOfDate: string; onOrganization: (organizationId: string) => void; onOpenProject: (organizationId: string, projectId: string) => void;
}) {
  return <CompanyGate identity={identity} organizationId={organizationId} onOrganization={onOrganization} loadingLabel="Loading the cost library…">
    {(organization, selector) => <Library identity={identity} organizationId={organization.id} asOfDate={asOfDate} selector={selector} onOpenProject={projectId => onOpenProject(organization.id, projectId)} />}
  </CompanyGate>;
}

function useDebounced(value: string, delay = 250): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const timer = window.setTimeout(() => setDebounced(value), delay); return () => window.clearTimeout(timer); }, [value, delay]);
  return debounced;
}

function Library({ identity, organizationId, asOfDate, selector, onOpenProject }: { identity: string; organizationId: string; asOfDate: string; selector: ReactNode; onOpenProject: (projectId: string) => void }) {
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim());
  const library = useInfiniteQuery({
    queryKey: ["rent-ops-workspace", "cost-library", identity, organizationId, query, asOfDate],
    queryFn: ({ pageParam, signal }) => workspacesApi.costLibrary(organizationId, { search: query || undefined, cursor: pageParam, asOf: asOfDate }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
    staleTime: 60_000, retry: false,
  });
  const items = library.data?.pages.flatMap(page => page.items) ?? [];
  return <div className="ws-page">
    <div className="ws-toolbar">
      {selector}
      <label className="ws-search"><Search size={14} aria-hidden="true" /><input aria-label="Search cost library" placeholder="Search items, categories or sources" value={search} onChange={event => setSearch(event.currentTarget.value)} /></label>
    </div>
    {library.error ? <ErrorState error={library.error} onRetry={() => void library.refetch()} /> : !library.data ? <Loading label="Loading the cost library…" />
      : !items.length ? <StatePanel title={query ? "No matching items" : "No unit costs yet"} message={query ? "Try a different item, category or source." : "Scope lines from project templates and completed projects appear here."} />
      : <>
        <table className="ws-table">
          <thead><tr><th scope="col">Item</th><th scope="col">Category</th><th scope="col" className="number">Rate</th><th scope="col">Unit</th><th scope="col">Source</th><th scope="col">Type</th></tr></thead>
          <tbody>{items.map(item => <tr key={`${item.source}:${item.sourceId}:${item.description}:${item.rateCents}`}>
            <td>{item.description}</td>
            <td>{item.category ? humanize(item.category) : "—"}</td>
            <td className="number">{formatCentsText(item.rateCents, item.currency)}</td>
            <td>{item.unitLabel ?? "—"}</td>
            <td>{item.source === "template" ? `Template · ${item.sourceName}` : <><button type="button" className="ws-link" onClick={() => onOpenProject(item.sourceId)}>{item.sourceName}</button>{item.propertyName ? ` · ${item.propertyName}` : ""}{item.updatedOn ? ` · ${formatIsoDate(item.updatedOn)}` : ""}</>}</td>
            <td>{humanize(item.projectType)}</td>
          </tr>)}</tbody>
        </table>
        {library.hasNextPage && <button type="button" className="rm-button" disabled={library.isFetchingNextPage} onClick={() => void library.fetchNextPage()}>{library.isFetchingNextPage ? "Loading…" : "Show more"}</button>}
      </>}
  </div>;
}
